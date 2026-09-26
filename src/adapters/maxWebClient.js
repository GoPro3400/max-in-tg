import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import sharp from 'sharp';
import { Direction, MessageType, normalizeText, stableId } from '../domain/messages.js';
import { logger } from '../logger.js';
import { listFilesByMtime, safeDisplayName, safeName, saveBuffer } from '../utils/fileHelpers.js';
import { findNewestCapture, consumeNewestCapture } from '../utils/networkCapture.js';
import { measureProcessTreeMemory } from '../utils/processMemory.js';

puppeteer.use(StealthPlugin());

// How long browser.close() may take before the Chromium process is killed.
// close() waits for a clean CDP shutdown, which a wedged or crashed browser
// never answers; without a bound, a planned recycle or a failure restart would
// sit inside the bridge's global lock for the whole protocol timeout (minutes).
const BROWSER_CLOSE_TIMEOUT_MS = 15000;

// Every ElementHandle pins its node — and through it the DOM that node belongs
// to — in the renderer until it is disposed, and the MAX page is never
// navigated. The handles this client used to drop on every chat switch (the
// chat-row list, the first bubble it waited for) kept one entire old chat view
// alive per switch: on a MAX-like test page, 146k DOM nodes after 400 switches
// against ~400 with them disposed. That — not MAX itself — was the bulk of the
// renderer growth behind the old 2-hourly restart.
const disposeHandles = async (...handles) => {
  await Promise.all(handles.flat().filter(Boolean).map((handle) => handle.dispose().catch(() => {})));
};

// Puppeteer enables the Network domain with no size limits, so Chromium keeps
// up to 200 MB of response bodies for the page — copying an image's body into
// that buffer when the image itself is garbage-collected — and only a
// navigation empties it. With the HTTP cache off (see start()) every chat
// switch re-downloads every picture, so the buffer filled to its cap and
// stayed there (+250 MB measured). Capped, response.buffer() still works for
// anything up to the per-resource limit.
const NETWORK_BUFFER_LIMITS = { maxTotalBufferSize: 64 * 1024 * 1024, maxResourceBufferSize: 20 * 1024 * 1024 };

const MAX_CAPTURE_MAP_SIZE = 100;
const capMap = (map, maxSize = MAX_CAPTURE_MAP_SIZE) => {
  if (map.size >= maxSize) {
    const oldest = map.keys().next().value;
    map.delete(oldest);
  }
};

// Fallback selector list for locating a document bubble's download link when
// innerSelectors.messageDocument doesn't match. Used identically by both
// scrapeMessageRows and findAndHoverMessage's in-page fingerprint
// reconstruction so a document bubble matched only via this fallback can
// still be re-found later (see Fix 6 in the reply-feature review — the two
// evaluate blocks had drifted out of sync).
const DOCUMENT_LINK_FALLBACK_SELECTOR = 'a[href][download], a[href*="/file"], a[href*="/download"], a[href*="blob:"], [class*="document"] a[href], [class*="attach"] a[href], [class*="file"] a[href]';

// What MAX draws in a bubble as pictures that are never the message's own
// media: an emoji in text is <span class="emoji"><img alt="😀">, an animoji a
// <span class="animoji" data-lexical-animoji-emoji="😀">, and an emoji-only
// message shows its emoji big in .emojis (reaction chips come from the
// messageReactions selector). Shared by scrapeMessageRows and
// findAndHoverMessage.
const BUBBLE_DECOR = {
  graphics: '.emoji, .animoji, [data-lexical-emoji], [data-lexical-animoji]',
  bigEmoji: '.emojis',
  // Kinds of message the bridge cannot carry over (MAX Web's bubble
  // templates): Telegram gets a note saying what it was.
  kinds: [
    ['.bubbleContent > .location', '📍 Геопозиция'],
    ['.bubbleContent > .attaches-fullWidth, .bubbleContent [class*="pollOption"]', '📊 Опрос'],
    ['.bubbleContent > .unknownAttachWarning', '⚠️ Сообщение нового вида (MAX Web его не показывает)']
  ]
};

// Runs in the MAX page before MAX's own scripts. MAX animates emoji
// ("animoji") by fetching a Lottie JSON with fetch(url, { mode: 'cors' }) and
// drawing it on a canvas — and a canvas does not say which emoji it shows,
// so reactions could not be read or picked. Handing the page an empty body for
// those files makes MAX keep the stand-in it shows while loading: a plain
// <img alt="👍">. Only what MAX uses the result for changes: the request
// itself still goes out (the network capture sees it), and sticker animations
// ("lottie=true" URLs, see findNetworkLottie) are left alone.
const STATIC_ANIMOJI_SCRIPT = `(() => {
  try {
    const nativeFetch = window.fetch;
    if (typeof nativeFetch !== 'function' || nativeFetch.__maxInTgStaticAnimoji) return;
    const isLottieJson = (text) => text.length > 1 && text.length < 5000000 && text.charCodeAt(0) === 123
      && text.includes('"layers"') && text.includes('"fr"');
    const staticFetch = function (input, init) {
      const result = nativeFetch.apply(window, arguments);
      try {
        const url = typeof input === 'string' ? input : String((input && input.url) || input || '');
        if (!init || init.mode !== 'cors' || /lottie=true|sticker/i.test(url)) return result;
        return result.then((response) => {
          if (!response || !response.ok) return response;
          return response.clone().text().then(
            (text) => (isLottieJson(text) ? new Response('', { status: 200, headers: { 'content-type': 'application/json' } }) : response),
            () => response
          );
        });
      } catch (error) {
        return result;
      }
    };
    staticFetch.__maxInTgStaticAnimoji = true;
    window.fetch = staticFetch;
  } catch (error) {
    // Never break the page over this.
  }
})();`;

// How long the reactions scraped by readMessages are reused by readReactions.
const REACTION_SCAN_MAX_AGE_MS = 5000;

// What MAX says someone is doing ("записывает аудио", "sending a file"…), as
// the Telegram chat action showing the same.
const TYPING_ACTIONS = [
  [/аудио|голосов|voice|audio/i, 'record_voice'],
  [/видеосообщ|video message/i, 'record_video_note'],
  [/видео|video/i, 'upload_video'],
  [/фото|photo/i, 'upload_photo'],
  [/файл|file/i, 'upload_document'],
  [/стикер|sticker/i, 'choose_sticker']
];
export const typingAction = (label) => TYPING_ACTIONS.find(([pattern]) => pattern.test(label || ''))?.[1] || 'typing';

// Files bigger than this are not downloaded from MAX: a bot may upload at most
// 50 MB to Telegram, so the bridge could only say it is too big — after the
// browser had written it all to disk and the bridge read it into memory.
const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024;
// How long a download clicked in MAX may take: a few seconds to start, then
// as long as it keeps growing, up to this.
const DOCUMENT_DOWNLOAD_START_MS = 5000;
const DOCUMENT_DOWNLOAD_MAX_MS = 120000;
// Sent in place of a voice message or video note that could not be fetched.
const VOICE_MISSING = '🎤 Голосовое сообщение — не удалось забрать из MAX, послушай его там.';
const VIDEO_NOTE_MISSING = '📹 Видеосообщение — не удалось забрать из MAX, посмотри его там.';

const reactionRowOf = (row) => ({
  rawId: row.rawId,
  legacyRawId: row.legacyRawId && row.legacyRawId !== row.rawId ? row.legacyRawId : null,
  outgoing: Boolean(row.outgoing),
  mediaToken: (/[?&]r=([^&]+)/.exec(row.mediaUrl || '') || [])[1] || null,
  reactions: (row.reactions || []).map(({ emoji, count, active }) => ({ emoji, count, active: Boolean(active) })),
  reactionsUnknown: Boolean(row.reactionsUnknown)
});

export class MaxWebClient {
  constructor(maxConfig, options = {}) {
    this.config = maxConfig;
    this.browser = null;
    this.page = null;
    this.activeChatId = null;
    this.activeChatTitle = null;
    // The chat whose network traffic media captures are attributed to (set
    // when a chat is being opened, before it is verified — see selectChat).
    this.captureChatId = null;
    this.selectors = maxConfig.selectors;
    this.diagnosticDir = options.diagnosticDir;
    this.diagnosticRetentionFiles = options.diagnosticRetentionFiles ?? 80;
    // Redact conversation text from diagnostic HTML dumps by default — they are
    // full page captures containing private messages (see sanitizeDiagnosticHtml).
    this.diagnosticRedactText = options.diagnosticRedactText ?? true;
    this.mediaDir = options.mediaDir || '/app/tmp/media';
    this.stickerUrls = new Map();
    this.voiceUrls = new Map();
    this.videoUrls = new Map();
    this.documentUrls = new Map();
    this.lastDiagnosticAt = 0;
    this.onDisconnect = options.onDisconnect || null;
  }

  async start() {
    fs.mkdirSync(this.config.userDataDir, { recursive: true });
    this.cleanupBrowserLocks();
    this.browser = await puppeteer.launch({
      headless: this.config.headless,
      userDataDir: this.config.userDataDir,
      protocolTimeout: this.config.protocolTimeoutMs,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      // Puppeteer would kill Chromium itself on SIGTERM/SIGINT, before the
      // bridge's shutdown lets an in-flight send finish (bridge.stop drains
      // maxLock first). index.js handles the signals and closes the browser.
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-notifications',
        // Software WebGL: without a GPU (Xvfb), Chromium disables WebGL by
        // default, so MAX's WebGL sticker canvas never paints. Force ANGLE →
        // SwiftShader so the canvas renders and frames can be captured.
        '--ignore-gpu-blocklist',
        '--enable-unsafe-swiftshader',
        '--use-gl=angle',
        '--use-angle=swiftshader',
        // Fixed CDP port so `puppeteer.connect()` can attach to this exact
        // running browser (see scripts/devtools-repl.js) instead of only
        // being reachable through this process. Chrome binds remote
        // debugging to 127.0.0.1 by default and this port is not published
        // in docker-compose, so it is reachable only from inside the
        // container's network namespace (e.g. via `docker exec`) — never
        // exposed to the host network or the internet. 0 leaves the port to
        // Puppeteer (any free one), so several browsers can run side by side
        // (the browser tests do).
        ...(this.config.remoteDebuggingPort === 0 ? [] : [`--remote-debugging-port=${this.config.remoteDebuggingPort || 9222}`])
      ]
    });
    // A close requested through stop() also fires 'disconnected'; only a
    // browser that vanishes on its own is worth an error.
    const browser = this.browser;
    browser.on('disconnected', () => {
      if (this.browser !== browser) {
        logger.debug('Closed Chrome browser disconnected');
        return;
      }
      logger.error('Chrome browser disconnected unexpectedly');
      this.onDisconnect?.();
    });

    this.page = await this.browser.newPage();
    // A crashed renderer ("Page crashed!") leaves a page object on which every
    // later call fails or hangs; isAlive() reports it so the bridge relaunches
    // the browser at once instead of after several failed polls.
    this.pageCrashed = false;
    const page = this.page;
    page.on('error', (error) => {
      if (this.page !== page) return;
      this.pageCrashed = true;
      logger.error({ err: error?.message || String(error) }, 'MAX page crashed');
    });
    // Before the first navigation, so it is in place for every load (reloads
    // included) — see STATIC_ANIMOJI_SCRIPT.
    if (this.config.staticAnimoji !== false) {
      await this.page.evaluateOnNewDocument(STATIC_ANIMOJI_SCRIPT).catch((error) => {
        logger.warn({ err: error?.message || String(error) }, 'Could not install the static-animoji script; reactions may be unreadable');
      });
    }
    await this.page.setViewport({ width: 1440, height: 980 });
    // MAX serves sticker assets (Lottie JSON) from the HTTP cache, so on repeat
    // displays no `response` fires and we cannot capture the animation. Disable
    // the page cache so every sticker is re-fetched over the network and our
    // interceptor reliably sees the Lottie.
    await this.page.setCacheEnabled(false);
    // Must go through Puppeteer's own session (a second CDP session would get a
    // second, uncapped buffer); it survives reloads.
    await this.page._client?.().send('Network.enable', NETWORK_BUFFER_LIMITS).catch((error) => {
      logger.warn({ err: error?.message || String(error) }, 'Could not cap the DevTools network buffer');
    });

    // Set download path for document downloads
    this.downloadDir = path.join(this.mediaDir, 'downloads');
    fs.mkdirSync(this.downloadDir, { recursive: true });
    const cdpSession = await this.page.createCDPSession();
    await cdpSession.send('Page.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: this.downloadDir
    });

    this.page.on('response', async (response) => {
      // H4: guard the entire handler body so any synchronous throw (e.g. CDP
      // session destroyed / page closed) becomes a debug log rather than an
      // unhandled rejection that terminates Node.
      try {
        const url = response.url();
        const ct = response.headers()['content-type'] || '';
        // H5: tag every capture with the chat that is active at capture time so
        // that a slow network response from chat A cannot be attributed to chat B.
        // captureChatId, not activeChatId: the chat being opened is only
        // marked active after its header is verified, while its stickers and
        // media start loading right after the click.
        const capturedChatId = this.captureChatId ?? this.activeChatId;

        const isStickerUrl = url.includes('/sticker') || url.includes('/emoji') ||
          url.includes('sticker') || url.includes('emoji') ||
          url.includes('.tgs') || url.includes('lottie');
        const isStickerMedia = ct.includes('image/webp') || ct.includes('image/png') ||
          ct.includes('image/gif') || ct.includes('application/json');
        if ((isStickerUrl || (isStickerMedia && (url.includes('oneme.ru') || url.includes('max.ru')))) &&
            !url.includes('/_app/immutable/') && !url.includes('/assets/') &&
            !url.includes('.js') && !url.includes('.css') && !url.includes('.html')) {
          try {
            const buffer = await response.buffer();
            if (buffer.length > 500) {
              const key = `${Date.now()}-${url.split('/').pop().split('?')[0]}`;
              capMap(this.stickerUrls);
              this.stickerUrls.set(key, { url, buffer, timestamp: Date.now(), contentType: ct, chatId: capturedChatId });
              logger.debug({ url, size: buffer.length, contentType: ct }, 'Captured sticker URL from network');
            }
          } catch (error) {
            logger.debug({ url, err: error.message }, 'Failed to capture sticker response buffer');
          }
        }

        if ((ct.includes('audio') || ct.includes('ogg') || ct.includes('mpeg') || ct.includes('opus') ||
            url.includes('.ogg') || url.includes('.oga') || url.includes('.mp3') || url.includes('.wav') || url.includes('.opus') ||
            url.includes('/voice') || url.includes('/audio') || url.includes('/message/audio') ||
            url.includes('a.oneme.ru/audio') || url.includes('oneme.ru/audio')) &&
            !url.includes('/_app/immutable/') && !url.includes('/assets/')) {
          try {
            const buffer = await response.buffer();
            if (buffer.length > 1000) {
              capMap(this.voiceUrls);
              this.voiceUrls.set(url, { url, buffer, timestamp: Date.now(), contentType: ct, chatId: capturedChatId });
              logger.debug({ url, size: buffer.length, contentType: ct }, 'Captured voice URL from network');
            }
          } catch (error) {
            logger.debug({ url, err: error.message }, 'Failed to capture voice response buffer');
          }
        }

        if ((ct.includes('video') || ct.includes('webm') || ct.includes('mp4') ||
            url.includes('.mp4') || url.includes('.webm') || url.includes('.mov') ||
            url.includes('/video') || url.includes('/message/video') ||
            url.includes('a.oneme.ru/video') || url.includes('oneme.ru/video')) &&
            !url.includes('/_app/immutable/') && !url.includes('/assets/')) {
          try {
            const buffer = await response.buffer();
            if (buffer.length > 1000) {
              capMap(this.videoUrls);
              this.videoUrls.set(url, { url, buffer, timestamp: Date.now(), contentType: ct, chatId: capturedChatId });
              logger.debug({ url, size: buffer.length, contentType: ct }, 'Captured video URL from network');
            }
          } catch (error) {
            logger.debug({ url, err: error.message }, 'Failed to capture video response buffer');
          }
        }

        if ((ct.includes('application/pdf') || ct.includes('application/octet-stream') ||
            ct.includes('application/msword') || ct.includes('application/vnd.') || ct.includes('application/zip') ||
            url.includes('/getfile') || url.includes('/download') || url.includes('/attachment')) &&
            !url.includes('lottie=true') && !url.includes('/sticker') &&
            !url.includes('/_app/immutable/') && !url.includes('/assets/') && !url.includes('.js') && !url.includes('.css')) {
          try {
            const buffer = await response.buffer();
            if (buffer.length > 1000) {
              capMap(this.documentUrls);
              this.documentUrls.set(url, { url, buffer, timestamp: Date.now(), contentType: ct, chatId: capturedChatId });
              logger.debug({ url, size: buffer.length, contentType: ct }, 'Captured document from network');
            }
          } catch (error) {
            logger.debug({ url, err: error.message }, 'Failed to capture document response buffer');
          }
        }

      } catch (err) {
        logger.debug({ err }, 'response capture handler error');
      }
    });

    await this.page.goto(this.config.webUrl, { waitUntil: 'domcontentloaded' });
    logger.info({ url: this.config.webUrl }, 'Opened Max Web');
  }

  cleanupBrowserLocks() {
    for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
      const lockPath = path.join(this.config.userDataDir, name);
      try {
        fs.lstatSync(lockPath);
        fs.rmSync(lockPath, { force: true });
        logger.warn({ lockPath }, 'Removed stale Chromium profile lock');
      } catch (error) {
        if (error.code !== 'ENOENT') {
          logger.warn({ err: error, lockPath }, 'Failed to remove Chromium profile lock');
        }
      }
    }
  }

  async waitForReady(timeoutMs = 120000) {
    await this.waitForSelectorFree(this.selectors.chatList, { timeout: timeoutMs });
    const url = this.page.url();
    if (!url.includes('web.max.ru')) {
      throw new Error(`Max Web session may have expired. Current URL: ${url}`);
    }
    logger.info({ url }, 'Max Web chat list is ready');
  }

  // Which screen is MAX Web showing right now?
  //   'ready'          — chat list present, the session is live
  //   'login-required' — the QR sign-in screen (fresh profile or expired session)
  //   'unknown'        — still loading, or something we do not recognise
  // Deliberately structural, not text-based: MAX's login screen renders in the
  // browser's language ("Sign in to MAX via QR code" / «Вход по QR-коду»), so
  // matching words would break the moment the UI language differs.
  async getSessionState() {
    if (!this.page || this.page.isClosed?.()) return 'unknown';
    try {
      return await this.page.evaluate((chatListSelector) => {
        if (document.querySelector(chatListSelector)) return 'ready';
        // Strong signals: the sign-in screen is `form.auth.auth--qr-code`
        // wrapping `div.qr > svg` (verified against the live login page).
        if (document.querySelector('.qr svg') || document.querySelector('form[class*="auth"]')) {
          return 'login-required';
        }
        // Weak fallback for a future class rename: a large square inline SVG.
        // Gated on the app shell being absent — a signed-in page always has
        // <main>, so this can never mistake a mid-render chat view (chat list
        // not yet painted) for a sign-in screen and mail the owner a junk QR.
        const squareSvg = [...document.querySelectorAll('svg')].some((el) => {
          const rect = el.getBoundingClientRect();
          return rect.width >= 150 && Math.abs(rect.width - rect.height) < 24;
        });
        if (squareSvg && !document.querySelector('main')) return 'login-required';
        return 'unknown';
      }, this.selectors.chatList);
    } catch (error) {
      logger.debug({ err: error }, 'getSessionState evaluate failed');
      return 'unknown';
    }
  }

  // MAX does NOT keep issuing fresh sign-in codes on its own. Measured on the
  // live page: ~115s after it is drawn the code is blurred out, the text turns
  // into "QR code has expired", a refresh button appears — and the page then
  // sits there unchanged indefinitely. So an unattended sign-in has to press
  // that button itself, or the owner is left staring at a dead code.
  //
  // Detection is structural (a blur filter on the QR or an ancestor) rather
  // than textual, because the sign-in screen renders in the browser's language.
  async isLoginQrExpired() {
    if (!this.page || this.page.isClosed?.()) return false;
    try {
      return await this.page.evaluate(() => {
        const qr = document.querySelector('.qr svg')
          || [...document.querySelectorAll('svg')].find((el) => {
            const rect = el.getBoundingClientRect();
            return rect.width >= 150 && Math.abs(rect.width - rect.height) < 24;
          });
        if (!qr) return false;
        let node = qr;
        for (let level = 0; node && level < 5; level++) {
          const filter = getComputedStyle(node).filter;
          if (filter && filter !== 'none') return true;
          node = node.parentElement;
        }
        return false;
      });
    } catch (error) {
      logger.debug({ err: error }, 'isLoginQrExpired failed');
      return false;
    }
  }

  // Clicks MAX's "refresh the code" control. Prefers a button rendered inside
  // the QR box (that is where MAX puts it, and it needs no language), and
  // falls back to a label match. Returns true if something was clicked.
  async refreshLoginQr() {
    if (!this.page || this.page.isClosed?.()) return false;
    try {
      const clicked = await this.page.evaluate(() => {
        const qrBox = document.querySelector('.qr');
        const form = document.querySelector('form[class*="auth"]');
        const buttons = [...(form || document).querySelectorAll('button, [role="button"]')];
        const target = buttons.find((button) => qrBox?.contains(button))
          || buttons.find((button) => /refresh|update|обнов/i.test(button.getAttribute('aria-label') || ''));
        if (!target) return false;
        target.click();
        return true;
      });
      if (!clicked) {
        logger.warn('MAX login QR expired but no refresh control was found');
        return false;
      }
      // Wait for the fresh code to render, i.e. for the blur to lift.
      for (let attempt = 0; attempt < 20; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        if (!await this.isLoginQrExpired()) {
          logger.info('Refreshed the expired MAX login QR');
          return true;
        }
      }
      logger.warn('Clicked refresh but the MAX login QR is still expired');
      return false;
    } catch (error) {
      logger.warn({ err: error?.message || String(error) }, 'Failed to refresh the MAX login QR');
      return false;
    }
  }

  // Grabs the login QR as a scannable PNG plus a hash of its markup, so the
  // caller can tell a rotated code from the same one and avoid re-uploading.
  // Returns null when no QR is on screen, or when the code on screen is
  // expired and could not be refreshed — a blurred, dead code must never be
  // sent to the owner captioned "scan this".
  //
  // The raw element shot is dark paths on a transparent background: rendered
  // against a dark Telegram theme that is unscannable, so the code is flattened
  // onto white, given a quiet zone and upscaled for phone cameras.
  async captureLoginQr({ knownHash = null } = {}) {
    if (!this.page || this.page.isClosed?.()) return null;

    if (await this.isLoginQrExpired()) {
      const refreshed = await this.refreshLoginQr();
      if (!refreshed) return null;
    }
    // Every candidate must LOOK like a QR (large and square). Without that the
    // fallback would happily grab the sign-in form's logo or back-arrow icon —
    // the owner would be told to scan a 24px icon upscaled to 640px, and since
    // the hash of a static icon never changes, no corrected code would ever be
    // sent for the rest of the wait.
    const handle = await this.page.evaluateHandle(() => {
      const looksLikeQr = (el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        return rect.width >= 150 && Math.abs(rect.width - rect.height) < 24;
      };
      const candidates = [
        document.querySelector('.qr svg'),
        document.querySelector('form[class*="auth"] svg'),
        ...document.querySelectorAll('svg')
      ];
      return candidates.find(looksLikeQr) || null;
    });
    const element = handle.asElement();
    if (!element) {
      await handle.dispose().catch(() => {});
      return null;
    }

    try {
      const markup = await element.evaluate((el) => el.outerHTML);
      const hash = crypto.createHash('sha256').update(markup).digest('hex').slice(0, 16);
      // Same code as last time: skip the screenshot and the sharp pipeline.
      // The sign-in wait is open-ended and polls every few seconds, while MAX
      // only rotates the code every couple of minutes — re-encoding an
      // unchanged image would be pure waste for the whole wait.
      if (knownHash && hash === knownHash) return { hash, unchanged: true, png: null };

      const raw = await element.screenshot({ type: 'png', omitBackground: true });
      const png = await sharp(raw)
        .flatten({ background: '#ffffff' })
        .resize(576, 576, { fit: 'contain', background: '#ffffff' })
        .extend({ top: 32, bottom: 32, left: 32, right: 32, background: '#ffffff' })
        .png()
        .toBuffer();
      // hash identifies THIS code: MAX re-renders the SVG with new payload
      // paths when it rotates, so a changed hash means a new code to deliver.
      return { png, hash, unchanged: false };
    } catch (error) {
      logger.warn({ err: error }, 'Failed to capture MAX login QR');
      return null;
    } finally {
      await element.dispose().catch(() => {});
    }
  }

  async listChats() {
    await this.ensurePage();
    const selectors = this.selectors;
    return this.page.$$eval(selectors.chatItem, (nodes, innerSelectors) => nodes.map((node, index) => {
      const titleNode = node.querySelector(innerSelectors.chatTitle);
      const unreadNode = node.querySelector(innerSelectors.chatUnread);
      const title = titleNode?.textContent?.trim() || node.textContent?.trim() || `Chat ${index + 1}`;
      const domId = node.getAttribute('data-chat-id')
        || node.getAttribute('data-id')
        || node.id
        || title;
      return {
        id: domId,
        title,
        lastSeenAt: Date.now(),
        metadata: {
          index,
          unread: Boolean(unreadNode),
          unreadText: unreadNode?.textContent?.trim() || ''
        }
      };
    }), selectors);
  }

  async selectChat(chatIdOrIndex) {
    await this.ensurePage();

    const url = this.page.url();
    if (!url.includes('web.max.ru')) {
      throw new Error(`Max Web session expired or page navigated away: ${url}`);
    }

    // Switching chats: drop media buffers captured for the previous chat so a
    // video/voice/sticker from another chat (e.g. an onboarding promo clip)
    // cannot leak into a message here. Fresh buffers load after navigation.
    this.clearMediaCaches();

    // Try to find the chat in the visible list; if not found, scroll down
    // to load virtualized items that are off-screen.
    let chat = null;
    const maxScrollAttempts = 10;
    for (let attempt = 0; attempt <= maxScrollAttempts; attempt++) {
      const chats = await this.listChats();
      chat = chats.find((candidate, index) =>
        candidate.id === chatIdOrIndex || String(index + 1) === String(chatIdOrIndex)
      );
      if (chat) break;

      if (attempt < maxScrollAttempts) {
        await this.page.evaluate((sel) => {
          // The scrollable parent wraps .scrollListContent
          const content = document.querySelector(sel);
          const scrollable = content?.closest('.scrollable, .scrollListScrollable') || content?.parentElement;
          if (scrollable) {
            scrollable.scrollTop += 600;
            scrollable.dispatchEvent(new Event('scroll', { bubbles: true }));
          }
        }, this.selectors.chatList);
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }

    if (!chat) {
      // Scroll back to top for next operation
      await this.page.evaluate((sel) => {
        const content = document.querySelector(sel);
        const scrollable = content?.closest('.scrollable, .scrollListScrollable') || content?.parentElement;
        if (scrollable) scrollable.scrollTop = 0;
      }, this.selectors.chatList).catch(() => null);
      throw new Error(`Max chat not found: ${chatIdOrIndex}`);
    }

    // From the click on, the page no longer shows the previous chat. Forget it
    // now, so a switch that fails below (title never verified, list reordered
    // under the click) cannot leave activeChatId naming a chat that is not on
    // screen — readMessages/sendText skip re-selection when the ids match, and
    // would then read or type into whatever chat the page actually shows.
    this.activeChatId = null;
    this.activeChatTitle = null;
    this.captureChatId = chat.id;

    // Clicked inside the page: no ElementHandles, so nothing is pinned (see
    // disposeHandles). The resource-timing list is cleared at the same time:
    // fetchRecentLottieFromPage reads the newest sticker files from it, and
    // in a page that lives for days that list (250 entries, then it stops
    // recording) otherwise held stickers from long-gone chats.
    const clicked = await this.page.evaluate((selector, index) => {
      const node = document.querySelectorAll(selector)[index];
      if (!node) return false;
      try { performance.clearResourceTimings(); } catch { /* not available */ }
      const btn = node.querySelector('button.cell') || node;
      btn.scrollIntoView({ block: 'center' });
      btn.click();
      return true;
    }, this.selectors.chatItem, chat.metadata.index);
    if (!clicked) throw new Error(`Chat node index not found: ${chat.metadata.index}`);

    // Scroll chat list back to top so future listChats sees top items
    await this.page.evaluate((sel) => {
      const content = document.querySelector(sel);
      const scrollable = content?.closest('.scrollable, .scrollListScrollable') || content?.parentElement;
      if (scrollable) scrollable.scrollTop = 0;
    }, this.selectors.chatList).catch(() => null);

    await this.page.waitForFunction(
      (selector) => {
        const el = document.querySelector(selector);
        return el && el.textContent.trim().length > 0;
      },
      { timeout: 30000 },
      this.selectors.activeChatTitle
    );
    await this.verifyActiveChat(chat);

    // Mark the chat active BEFORE the scroll below. Scrolling lazy-loads message
    // bubbles and triggers MAX to fetch their media (e.g. sticker Lottie); those
    // network captures are tagged with activeChatId, so it must already point at
    // this chat or the captures get attributed to the previous one and lost.
    this.activeChatId = chat.id;
    this.activeChatTitle = chat.title;

    // Wait for message bubbles to render (lazy-loaded after chat opens)
    await this.waitForSelectorFree(this.selectors.messageItem, { timeout: 5000 }).catch(() => null);

    // Scroll message area to bottom to ensure newest messages are visible
    await this.scrollMessageListToBottom();

    // Brief wait for any newly loaded messages to render after scroll
    await new Promise((r) => setTimeout(r, 300));

    logger.debug({ chatId: chat.id, title: chat.title }, 'Selected Max chat');
    return chat;
  }

  // Scrolls every scrollable message-list container to the bottom (newest
  // messages). Shared by selectChat (after opening a chat) and sendText
  // (restoring the view after findAndHoverMessage scrolled it up to locate a
  // reply target — see Fix 8 in the reply-feature review). Never throws.
  async scrollMessageListToBottom() {
    await this.page.evaluate(() => {
      const scrollables = document.querySelectorAll('main .scrollable, main [style*="overflow"]');
      for (const el of scrollables) {
        el.scrollTop = el.scrollHeight;
      }
    }).catch(() => null);
  }

  // Scrolls every scrollable message-list container by `deltaPx` (negative to
  // scroll up, toward older history). Used by findAndHoverMessage to page
  // through history while searching for a reply target. Never throws.
  async scrollMessageListBy(deltaPx) {
    await this.page.evaluate((delta) => {
      const scrollables = document.querySelectorAll('main .scrollable, main [style*="overflow"]');
      for (const el of scrollables) el.scrollTop += delta;
    }, deltaPx).catch(() => null);
  }

  // Scrapes all currently-rendered message bubbles into a flat list of raw row
  // objects (text, author, time, media, reply-quote info, a content fingerprint
  // etc.). Shared by readMessages() (forwarding new incoming messages) and
  // getLastOutgoingFingerprint() (capturing our own just-sent message's
  // fingerprint for later Telegram->MAX reply matching).
  scrapeMessageRows() {
    const selectors = this.selectors;
    return this.page.$$eval(selectors.messageItem, (nodes, innerSelectors, docLinkFallbackSelector, decor) => {
      // --- Shared with findAndHoverMessage: keep the two in step. ---
      const safeClosest = (el, sel) => {
        try { return sel && el ? el.closest(sel) : null; } catch { return null; }
      };
      const safeAll = (root, sel) => {
        try { return sel && root ? [...root.querySelectorAll(sel)] : []; } catch { return []; }
      };
      // Pictures of emoji — never a message's own media (see BUBBLE_DECOR).
      const isDecor = (el) => Boolean(safeClosest(el, decor.graphics) || safeClosest(el, decor.bigEmoji)
        || safeClosest(el, innerSelectors.messageReactions));
      // What the static-animoji mode (STATIC_ANIMOJI_SCRIPT) turned from a
      // canvas into an <img>: reaction chips and the stand-in of an animated
      // big emoji. Left out of the id so a bubble keeps the id it always had;
      // the other emoji pictures were always <img> and stay in it for the
      // same reason.
      const isAnimojiStandIn = (el) => {
        if (safeClosest(el, innerSelectors.messageReactions)) return true;
        const big = safeClosest(el, decor.bigEmoji);
        const glyph = big && safeClosest(el, decor.graphics);
        return Boolean(glyph) && glyph.parentElement !== big;
      };
      // --- End of the shared part. ---
      const pictographic = /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20E3/u;
      const segmenter = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
      const emojiIn = (value) => (segmenter ? [...segmenter.segment(value || '')].map((part) => part.segment) : Array.from(value || ''))
        .filter((grapheme) => pictographic.test(grapheme));
      // Text as the reader sees it. MAX draws emoji as <img alt="😀"> (and
      // animoji as a span carrying the emoji), which textContent leaves out:
      // "Привет 😀" used to come through as "Привет".
      const readable = (root) => {
        let out = '';
        const walk = (n) => {
          if (n.nodeType === 3) {
            out += n.nodeValue;
            return;
          }
          if (n.nodeType !== 1) return;
          const glyph = n.getAttribute('data-lexical-animoji-emoji') || n.getAttribute('data-lexical-emoji');
          if (glyph) {
            out += glyph;
            return;
          }
          if (n.tagName === 'IMG') {
            const alt = n.getAttribute('alt') || '';
            if (alt.length <= 32 && pictographic.test(alt)) out += alt;
            return;
          }
          for (const child of n.childNodes) walk(child);
        };
        if (root) walk(root);
        return out;
      };
      const parseCount = (value) => {
        const match = /(\d+(?:[.,]\d+)?)\s*([KkКкMmМм])?/u.exec(String(value || ''));
        if (!match) return 1;
        const scale = /[KkКк]/u.test(match[2] || '') ? 1000 : (/[MmМм]/u.test(match[2] || '') ? 1000000 : 1);
        return Math.max(1, Math.round(Number.parseFloat(match[1].replace(',', '.')) * scale));
      };
      const isOrHasMessage = (el) => {
        try {
          return el.matches(innerSelectors.messageItem) || Boolean(el.querySelector(innerSelectors.messageItem));
        } catch {
          return false;
        }
      };
      // A bubble's reaction chips. MAX puts them inside the bubble for media,
      // and for text right AFTER the bubble's wrapper, as its next sibling.
      // Walking up stops at the level of the message rows, so a neighbour's
      // reactions are never taken for this bubble's.
      const reactionChipsOf = (node, replyLink) => {
        const containerSel = innerSelectors.messageReactions;
        const chipSel = innerSelectors.messageReactionChip;
        if (!containerSel || !chipSel) return [];
        const containers = safeAll(node, containerSel);
        let level = node.parentElement;
        for (let depth = 0; level && depth < 3 && !containers.length; depth++, level = level.parentElement) {
          let reachedNextMessage = false;
          for (let sibling = level.nextElementSibling, seen = 0; sibling && seen < 3; sibling = sibling.nextElementSibling, seen++) {
            if (isOrHasMessage(sibling)) {
              reachedNextMessage = true;
              break;
            }
            let isContainer = false;
            try { isContainer = sibling.matches(containerSel); } catch { /* bad selector */ }
            if (isContainer) containers.push(sibling);
            else containers.push(...safeAll(sibling, containerSel));
          }
          if (reachedNextMessage) break;
        }
        const chips = new Set();
        for (const container of containers) {
          if (replyLink && replyLink.contains(container)) continue;
          safeAll(container, chipSel).forEach((chip) => chips.add(chip));
        }
        return [...chips];
      };
      const chipInfo = (chip) => {
        const labels = safeAll(chip, '[data-lexical-animoji-emoji], [data-lexical-emoji], img[alt]')
          .map((el) => el.getAttribute('data-lexical-animoji-emoji') || el.getAttribute('data-lexical-emoji') || el.getAttribute('alt') || '');
        const emoji = [...labels, chip.getAttribute('aria-label') || '', chip.textContent || ''].flatMap(emojiIn)[0] || null;
        const counter = chip.querySelector('.counter')?.textContent ?? chip.textContent;
        const active = /(^|\s)[\w-]*--active(\s|$)/.test(chip.getAttribute('class') || '')
          || chip.getAttribute('aria-pressed') === 'true';
        const rect = chip.getBoundingClientRect();
        return { emoji, count: parseCount(counter), active, x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      };

      const rows = nodes.map((node, index) => {
        // Detect reply quote: present only on reply bubbles as a direct child .link
        const bubbleContent = node.querySelector('.bubbleContent') || node;
        const replyLink = bubbleContent.querySelector(':scope > .link') || node.querySelector('.bubbleContent > .link');
        const inQuote = (el) => Boolean(el && replyLink && replyLink.contains(el));

        let replyToAuthor = '';
        let replyToSnippet = '';
        let replyToHasMedia = false;
        let replyToMediaUrl = '';
        if (replyLink) {
          const replyAuthorEl = replyLink.querySelector('.author');
          replyToAuthor = replyAuthorEl ? replyAuthorEl.textContent.trim() : '';
          // Find the quoted snippet: a .text inside the quote that is NOT inside .author
          const markTexts = Array.from(replyLink.querySelectorAll('.text'));
          const snippetEl = markTexts.find((el) => !replyAuthorEl || !replyAuthorEl.contains(el));
          replyToSnippet = snippetEl ? readable(snippetEl).trim() : '';
          // A reply to media (photo/video/sticker) shows a thumbnail in the quote
          // but no text snippet, so it cannot be matched by text — flag it so the
          // bridge can fall back to matching the most recent media message.
          // Emoji pictures in a quoted text are not media.
          const replyMediaEl = safeAll(replyLink, 'img, video').find((el) => !isDecor(el)) || null;
          replyToHasMedia = Boolean(replyMediaEl
            || safeAll(replyLink, 'canvas, [class*="sticker"], [class*="Sticker"]').some((el) => !isDecor(el)));
          // Capture the quoted thumbnail's URL so the bridge can match the reply to
          // the original media by its CDN identity instead of guessing by recency.
          replyToMediaUrl = replyMediaEl ? (replyMediaEl.currentSrc || replyMediaEl.src || '') : '';
        }

        // Extract the real message text: the .text that is a direct child of .bubbleContent,
        // NOT the one inside .link (which is the quoted author's name or snippet).
        let textEl = bubbleContent.querySelector(':scope > .text') || bubbleContent.querySelector(':scope > [data-lexical-text]');
        if (replyLink && textEl && replyLink.contains(textEl)) textEl = null;
        // The id of a bubble before the time was part of it (see legacyRawId
        // below) took the first .text of the bubble when it had no text of
        // its own — the sender's name in a group, else the time.
        const legacyFingerprintText = (textEl ? textEl.textContent : (node.querySelector(innerSelectors.messageText)?.textContent || '')).trim();
        // The bubble's own chrome: the quote, the sender's name above it and
        // its meta line (the time, "ред."). MAX draws the time as a .text too,
        // so an uncaptioned photo came through captioned "12:04" — and a voice
        // message, having "text", was not taken for a voice message.
        const isChrome = (el) => inQuote(el)
          || Boolean(safeClosest(el, innerSelectors.messageAuthor))
          || Boolean(safeClosest(el, innerSelectors.messageSender))
          || Boolean(safeClosest(el, innerSelectors.messageMetaTime));
        // What is delivered: with its emoji. An emoji-only message has no
        // .text at all; its emoji are drawn big instead.
        const textSource = textEl || safeAll(node, innerSelectors.messageText).find((el) => !isChrome(el)) || null;
        const bigEmojiEl = safeAll(node, decor.bigEmoji).find((el) => !inQuote(el)) || null;
        // A location, a poll…: said in words (they used to come through as
        // "12:04", their time).
        const kind = (decor.kinds || []).find(([selector]) => safeAll(node, selector).some((el) => !inQuote(el)));
        const text = readable(textSource).trim() || readable(bigEmojiEl).trim() || (kind ? `${kind[1]} — открой в MAX` : '');
        const fingerprintText = (textSource ? textSource.textContent : '').trim();

        const author = node.querySelector(innerSelectors.messageAuthor)?.textContent?.trim() || '';
        // Who wrote it, for showing in Telegram (group chats): the name above
        // the bubble — MAX shows it on the first of a run of bubbles from one
        // sender — else the bubble's own author line; never the quoted author
        // of a reply (which `author` may have picked up, and keeps for the id).
        const senderHeader = safeAll(node, innerSelectors.messageSender).find((el) => !inQuote(el)) || null;
        const senderEl = (senderHeader && (senderHeader.querySelector('.name') || senderHeader))
          || safeAll(node, innerSelectors.messageAuthor).find((el) => !inQuote(el)) || null;
        const sender = senderEl ? readable(senderEl).replace(/\s+/g, ' ').trim() : '';
        const timeNode = node.querySelector(innerSelectors.messageTime);
        const legacyTime = timeNode?.getAttribute('aria-label') || timeNode?.textContent?.trim() || '';
        // MAX shows a bubble's time as the text of its meta line, not in a
        // .time[aria-label] element — which does not exist, so the time used
        // to be missing from every id, and a text repeating any earlier
        // message of the chat ("Ок" today after "Ок" last week) was taken for
        // that one and never delivered.
        const metaText = safeAll(node, innerSelectors.messageMetaTime).find((el) => !inQuote(el))?.textContent || '';
        const time = legacyTime || (/\d{1,2}:\d{2}(?:\s?[AaPp][Mm])?/.exec(metaText) || [''])[0];
        // Media/type detection must ignore anything inside the reply quote (.link):
        // a reply to a photo/video/sticker embeds the quoted media's thumbnail,
        // which would otherwise be misdetected as this message's own media and
        // re-sent instead of forwarding the reply text. Emoji pictures are not
        // media either: a text with an emoji used to become a "photo" of it.
        const ownEl = (el) => (inQuote(el) ? null : el);
        // A file is a card (.attaches > button.container: its name in .title,
        // its size in .info — "Скачать • 1.23 MB"). Its preview picture (a
        // photo or video sent as a file) is not the message's photo: the file
        // itself is. Nor is the picture of a link's preview card (.share) —
        // a text with a link used to arrive as a photo of that picture.
        const fileCard = ownEl(safeAll(node, innerSelectors.messageFileCard)[0] || null);
        const inLinkPreview = (el) => Boolean(safeClosest(el, innerSelectors.messageLinkPreview));
        const notContent = (el) => inQuote(el) || isDecor(el) || inLinkPreview(el) || Boolean(fileCard && fileCard.contains(el));
        const contentEl = (sel) => safeAll(node, sel).find((el) => !notContent(el)) || null;
        const imgEl = contentEl('img');
        // An animated big emoji is a canvas when it cannot be read as an emoji
        // (static-animoji mode off); it is then treated as a sticker, as before.
        const canvasEl = contentEl('canvas') || (text ? null : ownEl(node.querySelector('canvas')));
        const videoEl = contentEl('video');
        const sourceEl = contentEl('source[type="video"], source[type="webm"]');
        const audioEl = contentEl('audio');
        const voiceEl = ownEl(node.querySelector('[class*="voice"], [data-testid*="voice"], [aria-label*="voice"], [aria-label*="Voice"], [class*="audioMessage"], [class*="audio-player"], [class*="attachAudio"], [class*="wave"]'));
        const roundVideoEl = ownEl(node.querySelector('[class*="roundVideo"], [class*="round-video"], [class*="videoNote"], [class*="video-note"], [data-testid*="video-note"], [data-testid*="round-video"], [class*="videoMessage"], [class*="videoCanvas"]'));
        const durationEl = ownEl(node.querySelector('.duration, [class*="duration"]'));
        const hasDuration = durationEl && /^\d{2}:\d{2}$/.test(durationEl.textContent.trim());
        const imageUrl = imgEl?.src || '';
        const audioUrl = audioEl?.src || '';
        const videoUrl = videoEl?.src || sourceEl?.src || '';
        // The first file-like link, as ids have always taken it (a link in the
        // text included).
        const legacyDocumentLink = ownEl(node.querySelector(innerSelectors.messageDocument))
          || ownEl(node.querySelector(docLinkFallbackSelector));
        // A link in the text ("…/file/…", "…/download…") or in its preview
        // card is not a file to download.
        const inText = (el) => Boolean(safeClosest(el, innerSelectors.messageText)) || inLinkPreview(el);
        const documentLink = [...safeAll(node, innerSelectors.messageDocument), ...safeAll(node, docLinkFallbackSelector)]
          .find((el) => !inQuote(el) && !inText(el)) || null;
        const documentEl = fileCard || documentLink || ownEl(node.querySelector('[class*="document"], [class*="attachDoc"], [class*="file-info"], [class*="fileName"], [class*="fileIcon"], [data-testid*="document"], [data-testid*="file"], button[aria-label*="качать"]'));
        const documentUrl = documentLink?.href || '';
        const hasDocumentElement = Boolean(documentEl);
        // The file's name, and its size as MAX states it — the bridge does not
        // download what Telegram would not take anyway.
        const fileNameEl = (fileCard && fileCard.querySelector('.title'))
          || ownEl(node.querySelector('[class*="fileName"], [class*="file-name"], [class*="title"]'));
        const documentFileName = fileNameEl?.textContent?.trim() || '';
        const fileInfo = fileCard?.querySelector('.info')?.textContent || '';
        const sizes = [...fileInfo.matchAll(/(\d+(?:[.,]\d+)?)\s*(B|KB|MB|GB|TB|Б|КБ|МБ|ГБ|ТБ)(?![\p{L}])/giu)];
        const lastSize = sizes.at(-1);
        const sizeUnits = ['B', 'KB', 'MB', 'GB', 'TB'];
        const unitIndex = lastSize ? Math.max(sizeUnits.indexOf(lastSize[2].toUpperCase()), ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'].indexOf(lastSize[2].toUpperCase())) : -1;
        const documentSize = unitIndex >= 0 ? Math.round(Number.parseFloat(lastSize[1].replace(',', '.')) * 1024 ** unitIndex) : 0;
        // "Файл удален" / "Файл недоступен", or the card switched off.
        const documentUnavailable = Boolean(fileCard) && (fileCard.disabled || /удал[её]н|недоступ|deleted|unavailable/i.test(fileInfo));
        const mediaUrl = imageUrl || audioUrl || videoUrl || documentUrl || '';
        // The id: author|time|text|media. Its media part is built the way it
        // always was — the first <img> (emoji pictures included), <audio>,
        // <video> or file link, minus the animoji stand-ins, which used to be
        // canvases — so an uncaptioned photo in a private chat keeps the id it
        // had (then its time came in as its "text").
        const legacySrc = (sel) => ownEl(node.querySelector(sel))?.src || '';
        const fingerprintImg = ownEl(safeAll(node, 'img').find((el) => !isAnimojiStandIn(el)) || null);
        const fingerprintMediaUrl = (fingerprintImg?.src || '') || legacySrc('audio')
          || legacySrc('video') || legacySrc('source[type="video"], source[type="webm"]') || legacyDocumentLink?.href || '';
        const explicitId = node.getAttribute('data-message-id') || node.getAttribute('data-id') || node.id || '';
        const fallbackId = [author, time, fingerprintText, fingerprintMediaUrl].filter(Boolean).join('|');
        const rawId = explicitId || fallbackId || `visible-${index}`;
        // The id this bubble had before the time was part of it — for finding
        // messages recorded under it (see BridgeService.adoptLegacyId).
        const legacyRawId = explicitId || [author, legacyTime, legacyFingerprintText, fingerprintMediaUrl].filter(Boolean).join('|') || `visible-${index}`;
        const outgoing = Boolean(
          node.closest('[data-outgoing="true"], .outgoing, .message-out')
          || node.closest('[data-bubbles-variant="outgoing"]')
          || node.parentElement?.getAttribute('data-bubbles-variant') === 'outgoing'
        );

        // Reactions (emoji, how many, whether one of them is ours), for the
        // bridge to mirror into Telegram. A chip whose emoji cannot be read
        // (an animoji still drawn on a canvas) is only counted as unknown.
        const chips = reactionChipsOf(node, replyLink).map(chipInfo);
        const reactions = chips.filter((chip) => chip.emoji);
        const reactionsUnknown = chips.length > reactions.length;

        const stickerEl = ownEl(node.querySelector('[class*="sticker"], [class*="Sticker"], [data-testid*="sticker"], [class*="emoji-big"], [class*="animatedEmoji"]'));
        // The weak voice signals ("wave"/"duration") also match some text
        // bubbles, so they only mean "voice" when the bubble has no real text.
        // roundVideoEl (videoMessage/videoCanvas/roundVideo) and audioUrl are
        // specific enough to trust on their own — a video note may carry a
        // duration/label in its text, and must still be detected as a video note.
        const hasText = Boolean(text);
        let type = 'text';
        if (stickerEl) type = 'sticker';
        else if (imageUrl) type = 'photo';
        else if (roundVideoEl) type = 'video_note';
        else if (audioUrl) type = 'voice';
        else if ((voiceEl || hasDuration) && !hasText) type = 'voice';
        else if (videoUrl) type = 'video';
        else if (documentUrl || hasDocumentElement) type = 'document';
        else if (canvasEl) {
          const cw = canvasEl.width || 0;
          const ch = canvasEl.height || 0;
          if (cw > 40 && ch > 40) {
            type = 'sticker';
          }
        }

        // For stickers: if there's an img inside the sticker element, use it as mediaUrl
        const stickerImgUrl = (type === 'sticker' && imgEl?.src && !imgEl.src.startsWith('data:')) ? imgEl.src : '';
        const stickerIndex = (type === 'sticker' && !mediaUrl && !stickerImgUrl) ? index : -1;
        const rect = node.getBoundingClientRect();

        return {
          rawId,
          legacyRawId,
          text,
          author,
          sender,
          time,
          outgoing,
          mediaUrl: stickerImgUrl || mediaUrl,
          type,
          stickerIndex,
          hasVoiceElement: Boolean(voiceEl),
          hasRoundVideoElement: Boolean(roundVideoEl),
          hasDuration,
          // Needed outside the page context to index document bubbles in DOM
          // order the same way triggerDocumentDownload does (see readMessages).
          hasDocumentElement,
          documentFileName,
          documentSize,
          documentUnavailable,
          replyToAuthor,
          replyToSnippet,
          replyToHasMedia,
          replyToMediaUrl,
          replyLinkPresent: Boolean(replyLink),
          reactions,
          reactionsUnknown,
          box: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
          _htmlSnippet: node.innerHTML.substring(0, 200)
        };
      });

      // Bubbles whose content gives them the same id — two "ок" from the same
      // person in the same minute — are numbered in page order, the first
      // keeping the plain id. The second used to be dropped as the same
      // message. Voice messages keep their own "#vN" numbering.
      const voiceCounts = new Map();
      const sameCounts = new Map();
      const legacyVoiceCounts = new Map();
      for (const row of rows) {
        if (row.rawId.startsWith('visible-')) continue;
        if (!row.outgoing && (row.hasVoiceElement || row.hasRoundVideoElement || row.hasDuration)) {
          const n = (voiceCounts.get(row.rawId) || 0) + 1;
          voiceCounts.set(row.rawId, n);
          if (n > 1) row.rawId = `${row.rawId}#v${n}`;
          // The old ids numbered voice messages the same way (and nothing else).
          const legacyN = (legacyVoiceCounts.get(row.legacyRawId) || 0) + 1;
          legacyVoiceCounts.set(row.legacyRawId, legacyN);
          if (legacyN > 1) row.legacyRawId = `${row.legacyRawId}#v${legacyN}`;
          continue;
        }
        const key = `${row.outgoing ? 'out' : 'in'}\u0000${row.rawId}`;
        const n = (sameCounts.get(key) || 0) + 1;
        sameCounts.set(key, n);
        if (n > 1) row.rawId = `${row.rawId}#d${n}`;
      }
      return rows;
    }, selectors, DOCUMENT_LINK_FALLBACK_SELECTOR, BUBBLE_DECOR);
  }

  // Telegram→MAX replies (v2): after sending our own text message into a MAX
  // chat, captures the fingerprint of that freshly-created outgoing bubble (the
  // same rawId format produced by scrapeMessageRows) so a later reply to it can
  // find and quote it. `sentText` is the text we just sent — the last outgoing
  // row is only accepted once its text matches, so a slow render (bubble not
  // painted yet under the fixed-sleep window) can never return the PREVIOUS
  // outgoing message's fingerprint instead (see Fix 2 in the reply-feature
  // review). Best-effort: returns null (never throws, never a wrong
  // fingerprint) if no confirmed match is found within the deadline, and
  // callers must not block message delivery on this.
  async getLastOutgoingFingerprint(chatId, sentText) {
    // Guard against a chat switch racing in behind us: if some other chat is
    // now active, any rows we'd scrape belong to it, not the one we just sent to.
    if (chatId && this.activeChatId !== chatId) return null;
    const deadline = Date.now() + 3000;
    const pollMs = 300;
    // Whitespace-insensitive: a multi-line message's bubble text comes back
    // without its line breaks (textContent of separate paragraphs).
    const expected = withoutWhitespace(sentText);
    if (!expected) return null;
    try {
      while (Date.now() < deadline) {
        const rows = await this.scrapeMessageRows();
        const outgoingRows = rows.filter((row) => row.outgoing);
        const last = outgoingRows.at(-1);
        if (last && withoutWhitespace(last.text) === expected) {
          if (last.rawId.startsWith('visible-')) return null;
          return last.rawId;
        }
        await new Promise((r) => setTimeout(r, pollMs));
      }
      return null;
    } catch (error) {
      logger.warn({ err: error, chatId }, 'getLastOutgoingFingerprint: failed to capture own message fingerprint');
      return null;
    }
  }

  // After a file went out: how to find that bubble again later (a reply or a
  // reaction to it from Telegram) — by its CDN token, the part of the media
  // URL that survives MAX re-signing its URLs on every page load. The bubble
  // shows a local preview until the upload finishes, so this waits for the
  // token. null when there is none (never an id that would not last).
  async getLastOutgoingMediaFingerprint(chatId, { timeoutMs = 5000 } = {}) {
    if (chatId && this.activeChatId !== chatId) return null;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const rows = await this.scrapeMessageRows().catch(() => []);
      const token = mediaTokenOf(rows.filter((row) => row.outgoing).at(-1)?.mediaUrl);
      if (token) return `media-token:${token}`;
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    return null;
  }

  async readMessages(chatId, { isKnown = null } = {}) {
    await this.ensurePage();
    if (chatId && this.activeChatId !== chatId) {
      await this.selectChat(chatId);
    }

    const selectors = this.selectors;
    let rawMessages = await this.scrapeMessageRows();
    // A reply's quoted media thumbnail loads lazily (~seconds after the bubble).
    // If a NEW reply is visible but its quote has not populated yet, wait briefly
    // in place and re-scrape, so the reply forwards with its quote promptly instead
    // of only on a much later poll of this chat (the poll cycle can be slow). Gate
    // on unknown messages so an already-forwarded reply whose quote never loaded
    // (e.g. reply to a deleted message) can't stall this chat on every poll.
    const hasNewUnresolvedReply = rawMessages.some((m) => {
      if (m.outgoing || !m.replyLinkPresent || m.replyToMediaUrl || m.replyToSnippet) return false;
      const id = stableId('max', this.activeChatId || chatId, m.rawId);
      return !isKnown || !isKnown(id, m.rawId, m.legacyRawId !== m.rawId ? m.legacyRawId : undefined);
    });
    if (hasNewUnresolvedReply) {
      await new Promise((resolve) => setTimeout(resolve, 3500));
      rawMessages = await this.scrapeMessageRows();
    }

    logger.trace({ chatId, rawCount: rawMessages.length, selector: selectors.messageItem }, 'readMessages raw');

    // Bubbles sharing an id are already numbered by scrapeMessageRows ("#vN"
    // for voice messages, "#dN" otherwise), so uniqueMessages() keeps them all.
    // A group chat names the sender only on the first bubble of a run of
    // messages from the same person; the others belong to the last name seen
    // (our own bubbles end a run).
    let runSender = '';
    for (const row of rawMessages) {
      if (row.outgoing) {
        runSender = '';
        continue;
      }
      if (row.sender) runSender = row.sender;
      else row.sender = runSender;
    }
    // Kept for readReactions, which the bridge calls right after this.
    this.lastReactionScan = { chatId: this.activeChatId || chatId, at: Date.now(), rows: rawMessages.map(reactionRowOf) };

    const stickerIndices = rawMessages
      .filter((m) => m.stickerIndex >= 0)
      .map((m) => m.stickerIndex);

    const stickerScreenshots = stickerIndices.length > 0
      ? await this.page.$$eval(selectors.messageItem, (nodes, indices) => {
          return indices.map((idx) => {
            const node = nodes[idx];
            if (!node) return null;
            const canvas = node.querySelector('canvas');
            if (!canvas) return null;
            try {
              const dataUrl = canvas.toDataURL('image/png');
              const w = canvas.width || 0;
              const h = canvas.height || 0;
              return { dataUrl, width: w, height: h };
            } catch (e) {
              return { error: e?.message || 'canvas toDataURL failed' };
            }
          });
        }, stickerIndices).catch((error) => {
          logger.debug({ err: error.message }, 'Failed to evaluate sticker screenshots');
          return [];
        })
      : [];

    const filtered = uniqueMessages(rawMessages
      .filter((message) => !message.outgoing && (message.text || message.mediaUrl || message.type === 'sticker' || message.type === 'document' || message.hasVoiceElement || message.hasRoundVideoElement || message.hasDuration))
      .map((message) => {
        if (message.type === 'sticker' && !message.mediaUrl) {
          const dataIdx = stickerIndices.indexOf(message.stickerIndex);
          const screenshot = dataIdx >= 0 ? stickerScreenshots[dataIdx] : null;
          if (screenshot?.error) {
            logger.debug({ chatId, error: screenshot.error, stickerIndex: message.stickerIndex }, 'Canvas toDataURL failed for sticker');
            message._needsScreenshot = true;
          } else if (screenshot && screenshot.dataUrl && screenshot.dataUrl.startsWith('data:image')) {
            message._stickerDataUrl = screenshot.dataUrl;
            message._stickerSize = screenshot.width;
          } else {
            message._needsScreenshot = true;
          }
        }
        return message;
      }));

    if (rawMessages.length > 0) {
      const sample = rawMessages.slice(0, 3).map((m) => ({
        text: m.text?.substring(0, 30),
        outgoing: m.outgoing,
        mediaUrl: m.mediaUrl ? 'yes' : 'no',
        type: m.type
      }));
      logger.trace({ chatId, rawCount: rawMessages.length, filteredCount: filtered.length, sample }, 'readMessages detail');

      // Log document detections for debugging
      const docMsgs = rawMessages.filter((m) => !m.outgoing && m.type === 'document');
      if (docMsgs.length > 0) {
        logger.debug({ chatId, count: docMsgs.length, docs: docMsgs.map((m) => ({ rawId: m.rawId, fileName: m.documentFileName })) }, 'readMessages: documents detected');
      }
    }

    if (rawMessages.length > 0 && filtered.length === 0) {
      await this.captureDiagnostics(`empty-filter-${chatTag(chatId)}`, { throttleMs: 60000 }).catch(() => null);
      const bubbleHtml = await this.page.evaluate((sel) => {
        const el = document.querySelector(sel);
        return el ? el.innerHTML.substring(0, 3000) : 'not found';
      }, selectors.messageItem).catch(() => 'eval failed');
      // Same privacy rule as diagnostic dumps: for a text bubble this raw
      // innerHTML IS the private message text, and Docker retains up to 50 MB
      // of these logs on the VPS — redact before logging (structure survives,
      // which is all the selector debugging needs).
      const loggedBubbleHtml = sanitizeDiagnosticHtml(bubbleHtml, { redactText: this.diagnosticRedactText });
      logger.warn({ chatId, rawCount: rawMessages.length, bubbleHtml: loggedBubbleHtml.substring(0, 500) }, 'readMessages: all messages filtered out');
    }

    if (stickerIndices.length > 0) {
      await this.captureDiagnostics(`sticker-detected-${chatTag(chatId)}`, { throttleMs: 60000 }).catch(() => null);
      const stickerHtmls = await this.page.$$eval(selectors.messageItem, (nodes, indices) => {
        return indices.map((idx) => {
          const node = nodes[idx];
          if (!node) return null;
          return {
            index: idx,
            outerHTML: node.outerHTML.substring(0, 2000),
            hasCanvas: Boolean(node.querySelector('canvas')),
            hasImg: Boolean(node.querySelector('img')),
            imgSrc: node.querySelector('img')?.src || '',
            classes: node.className,
            childClasses: Array.from(node.querySelectorAll('*')).slice(0, 20).map(el => el.className).filter(Boolean)
          };
        });
      }, stickerIndices).catch(() => []);
      const networkStickerCount = this.stickerUrls.size;
      const recentStickerUrls = [...this.stickerUrls.values()].slice(-5).map(s => ({ url: s.url, size: s.buffer?.length, ct: s.contentType }));
      logger.debug({ chatId, stickerCount: stickerIndices.length, networkStickerCount, recentStickerUrls, stickerHtmls }, 'readMessages: sticker detected — full diagnostic');
    }

    if (rawMessages.length > filtered.length) {
      const filteredOut = rawMessages.filter((m) => !filtered.find((f) => f.rawId === m.rawId));
      logger.trace({ chatId, filteredCount: filteredOut.length, filteredOut: filteredOut.map((m) => ({ text: m.text?.substring(0, 30), type: m.type, mediaUrl: m.mediaUrl || 'none', outgoing: m.outgoing })) }, 'readMessages: messages filtered out');
    }

    const messages = filtered.map((message) => ({
        id: stableId('max', this.activeChatId || chatId, message.rawId),
        chatId: this.activeChatId || chatId,
        direction: Direction.MAX_TO_TG,
        type: normalizeMaxType(message.type),
        text: normalizeText(message.text),
        mediaUrl: message.mediaUrl || null,
        mediaPath: null,
        sourceMessageId: message.rawId,
        originalFilename: message.documentFileName || null,
        createdAt: Date.now(),
        metadata: {
          author: message.author,
          sender: message.sender || undefined,
          legacyId: message.legacyRawId && message.legacyRawId !== message.rawId ? message.legacyRawId : undefined,
          time: message.time,
          replyToAuthor: message.replyToAuthor || undefined,
          replyToSnippet: message.replyToSnippet || undefined,
          replyToHasMedia: message.replyToHasMedia || undefined,
          replyToMediaUrl: message.replyToMediaUrl || undefined,
          replyLinkPresent: message.replyLinkPresent || undefined,
          fileSize: message.type === 'document' && message.documentSize ? message.documentSize : undefined,
          fileUnavailable: message.type === 'document' && message.documentUnavailable ? true : undefined
        }
      }));

    const stickerSourceFor = (msg) => filtered.find((f) => (f._stickerDataUrl || f._needsScreenshot)
      && stableId('max', this.activeChatId || chatId, f.rawId) === msg.id);
    // Network captures (a Lottie file, a sticker image) cannot be tied to a
    // particular bubble: with two new stickers at once the newest capture went
    // to the first one and the next to the second — the animations came out
    // swapped. They are only used when a single sticker is waiting; otherwise
    // each sticker is captured from its own canvas.
    const pendingStickers = messages.filter((msg) => !(isKnown && isKnown(msg.id, msg.sourceMessageId, msg.metadata.legacyId)) && stickerSourceFor(msg)).length;
    const networkStickerUsable = pendingStickers <= 1;

    for (const msg of messages) {
      if (isKnown && isKnown(msg.id, msg.sourceMessageId, msg.metadata.legacyId)) continue;
      const src = stickerSourceFor(msg);
      if (!src) continue;

      let saved = false;
      logger.debug({ chatId, msgId: msg.id, hasDataUrl: Boolean(src._stickerDataUrl), needsScreenshot: Boolean(src._needsScreenshot), stickerIndex: src.stickerIndex, networkCacheSize: this.stickerUrls.size }, 'Sticker capture — starting');

      // Strategy 0a (preferred): render the Lottie JSON captured from the network
      // ourselves with lottie-web (reliable in headless) → PNG frames → the
      // bridge encodes a real animated .webm sticker.
      if (!saved && networkStickerUsable) {
        let lottie = this.findNetworkLottie();
        if (!lottie?.buffer) {
          // Not intercepted (served from cache) — fetch it from the page.
          lottie = await this.fetchRecentLottieFromPage();
        }
        logger.debug({ chatId, hasLottie: Boolean(lottie), fromPage: Boolean(lottie && !lottie.chatId), size: lottie?.buffer?.length || 0 }, 'Sticker strategy 0a: network Lottie');
        if (lottie?.buffer && lottie.buffer.length > 500) {
          try {
            const { frames, fps } = await this.renderLottieToFrames(lottie.buffer);
            logger.debug({ chatId, renderedFrames: frames.length, fps }, 'Rendered Lottie via lottie-web');
            if (frames.length >= 4) {
              const framesDir = this.saveFrameBuffers(msg.id, frames);
              msg.mediaPath = framesDir;
              msg.type = 'sticker';
              msg.metadata = { ...msg.metadata, animated: true, frameCount: frames.length, fps, source: 'lottie' };
              saved = true;
              logger.info({ chatId, framesDir, frames: frames.length, fps, url: lottie.url }, 'Animated sticker rendered from Lottie JSON');
            }
          } catch (error) {
            logger.warn({ err: error, chatId }, 'Lottie render failed; falling back to canvas capture');
          }
        }
      }

      // Strategy 0b: sample MAX's own sticker canvas over ~1.7s; if the frames
      // actually change (Lottie playing) save them for .webm encoding. If frames
      // don't change it's effectively static — fall through to single-frame.
      if (!saved && src.stickerIndex >= 0) {
        try {
          const { frames, fps } = await this.captureStickerFrames(src.stickerIndex);
          const distinct = countDistinctFrames(frames);
          logger.debug({ chatId, frameCount: frames.length, distinct, fps }, 'Sticker strategy 0b: canvas frame capture');
          if (frames.length >= 4 && distinct >= 3) {
            const framesDir = this.saveFrameBuffers(msg.id, frames);
            msg.mediaPath = framesDir;
            msg.type = 'sticker';
            msg.metadata = { ...msg.metadata, animated: true, frameCount: frames.length, fps };
            saved = true;
            logger.info({ chatId, framesDir, frames: frames.length, distinct, fps }, 'Animated sticker frames captured');
          }
        } catch (error) {
          logger.warn({ err: error, chatId }, 'Animated sticker frame capture failed');
        }
      }

      if (!saved && src._stickerDataUrl) {
        try {
          const base64 = src._stickerDataUrl.replace(/^data:image\/\w+;base64,/, '');
          const buffer = Buffer.from(base64, 'base64');
          logger.debug({ chatId, bufferSize: buffer.length }, 'Sticker strategy 1: canvas toDataURL');
          if (buffer.length > 2000) {
            const stickerPath = saveBuffer(this.mediaDir, `sticker-${msg.id}.png`, buffer);
            msg.mediaPath = stickerPath;
            // Kept a sticker (not a photo): the bridge sends it as a real
            // Telegram sticker, transparent, instead of a picture.
            msg.type = 'sticker';
            saved = true;
            logger.info({ chatId, stickerPath, size: buffer.length }, 'Sticker SAVED from canvas toDataURL');
          } else {
            logger.debug({ chatId, bufferSize: buffer.length }, 'Sticker canvas toDataURL too small (likely empty canvas)');
          }
        } catch (error) {
          logger.warn({ err: error, chatId }, 'Failed to save sticker canvas');
        }
      }

      if (!saved && networkStickerUsable) {
        const networkSticker = this.findNetworkSticker();
        logger.debug({ chatId, hasNetworkSticker: Boolean(networkSticker), cacheSize: this.stickerUrls.size }, 'Sticker strategy 2: network intercept');
        if (networkSticker) {
          try {
            const ext = (networkSticker.contentType || '').includes('webp') ? 'webp' : 'png';
            const stickerPath = saveBuffer(this.mediaDir, `sticker-${msg.id}-${Date.now()}.${ext}`, networkSticker.buffer);
            msg.mediaPath = stickerPath;
            msg.type = 'sticker';
            saved = true;
            logger.info({ chatId, stickerPath, size: networkSticker.buffer.length, url: networkSticker.url }, 'Sticker SAVED from network');
          } catch (error) {
            logger.warn({ err: error, chatId }, 'Failed to save network sticker');
          }
        }
      }

      // NOTE: the old "bubble screenshot" strategy was removed — it captured the
      // chat wallpaper behind an unrendered sticker and sent it as a photo.

      if (!saved && src._needsScreenshot && src.stickerIndex >= 0) {
        // The canvas INSIDE this sticker's bubble. `${messageItem} canvas`
        // only appended " canvas" to the last selector of the list, so it
        // matched every bubble — and the screenshot taken was of the chat's
        // first bubble, whatever text it held.
        let bubbles = [];
        let canvas = null;
        try {
          bubbles = await this.page.$$(selectors.messageItem);
          canvas = await bubbles[src.stickerIndex]?.$('canvas');
          logger.debug({ chatId, hasCanvasEl: Boolean(canvas), stickerIndex: src.stickerIndex }, 'Sticker strategy: canvas element screenshot');
          if (canvas) {
            const screenshotBuffer = await canvas.screenshot({ type: 'png', omitBackground: true });
            if (screenshotBuffer && screenshotBuffer.length > 2000) {
              const stickerPath = saveBuffer(this.mediaDir, `sticker-${msg.id}.png`, screenshotBuffer);
              msg.mediaPath = stickerPath;
              msg.type = 'sticker';
              saved = true;
              logger.info({ chatId, stickerPath, size: screenshotBuffer.length }, 'Sticker SAVED via canvas screenshot');
            }
          }
        } catch (error) {
          logger.warn({ err: error, chatId }, 'Failed to screenshot sticker canvas');
        } finally {
          await disposeHandles(canvas, bubbles);
        }
      }

      if (!saved) {
        msg.text = '[Стикер]';
        msg.type = 'text';
        logger.info({ chatId, msgId: msg.id }, 'Sticker could not be captured — sent as [Стикер] text');
      }
    }

    // Voice messages and video notes are fetched by clicking their own bubble
    // (see clickInBubble).
    for (const msg of messages) {
      if (isKnown && isKnown(msg.id, msg.sourceMessageId, msg.metadata.legacyId)) continue;
      if (msg.mediaPath) continue;
      if (msg.type !== 'text' && msg.type !== 'voice' && msg.type !== 'video_note') continue;

      const src = filtered.find((f) => (f.hasVoiceElement || f.hasRoundVideoElement || f.hasDuration) && stableId('max', this.activeChatId || chatId, f.rawId) === msg.id);
      if (!src) continue;

      const msgIsKnown = isKnown && isKnown(msg.id, msg.sourceMessageId, msg.metadata.legacyId);

      if (src.hasRoundVideoElement || src.type === 'video_note') {
        if (msgIsKnown) continue;
        let networkVideo = this.findNetworkVideo();
        if (!networkVideo) {
          networkVideo = await this.triggerVideoNoteDownload(chatId, src.rawId);
        }
        if (networkVideo) {
          try {
            const ext = networkVideo.contentType?.includes('webm') ? '.webm' : '.mp4';
            const videoPath = saveBuffer(this.mediaDir, `video-note-${msg.id}${ext}`, networkVideo.buffer);
            msg.mediaPath = videoPath;
            msg.type = 'video_note';
            msg.text = '';
            logger.debug({ chatId, videoPath, size: networkVideo.buffer.length, contentType: networkVideo.contentType }, 'Saved video note from network');
          } catch (error) {
            logger.warn({ err: error, chatId }, 'Failed to save network video note');
            msg.text = VIDEO_NOTE_MISSING;
            msg.metadata.fileCaptureFailed = true;
          }
        } else {
          // Tried again on the next reads before this text goes out.
          msg.text = VIDEO_NOTE_MISSING;
          msg.metadata.fileCaptureFailed = true;
        }
      } else if (src.hasVoiceElement || src.type === 'voice') {
        if (msgIsKnown) continue;
        let networkVoice = this.findNetworkVoice();
        if (!networkVoice) {
          networkVoice = await this.triggerVoiceDownload(src, chatId);
        }
        if (networkVoice) {
          try {
            // M7: both branches were '.ogg' — now honour the actual content type.
            // OGG/Opus is the most common MAX voice format; fall back to .ogg.
            const ext = networkVoice.contentType?.includes('opus') ? '.opus'
              : networkVoice.contentType?.includes('mp3') ? '.mp3'
              : '.ogg';
            const voicePath = saveBuffer(this.mediaDir, `voice-${msg.id}${ext}`, networkVoice.buffer);
            msg.mediaPath = voicePath;
            msg.type = 'voice';
            msg.text = '';
            logger.debug({ chatId, voicePath, size: networkVoice.buffer.length, contentType: networkVoice.contentType }, 'Saved voice from network');
          } catch (error) {
            logger.warn({ err: error, chatId }, 'Failed to save network voice');
            msg.text = VOICE_MISSING;
            msg.metadata.fileCaptureFailed = true;
          }
        } else {
          // Tried again on the next reads before this text goes out.
          msg.text = VOICE_MISSING;
          msg.metadata.fileCaptureFailed = true;
        }
      }
    }

    // Handle documents (PDFs, etc.): fetched by clicking their own bubble
    // (see clickInBubble).
    for (const msg of messages) {
      if (isKnown && isKnown(msg.id, msg.sourceMessageId, msg.metadata.legacyId)) continue;
      if (msg.mediaPath) continue;
      if (msg.type !== 'document') continue;

      if (msg.mediaUrl) {
        // Document has a direct download URL — use it
        msg.mediaPath = msg.mediaUrl;
      } else if (msg.metadata.fileUnavailable) {
        // Deleted in MAX: there is nothing to download (the bridge says so).
      } else if (msg.metadata.fileSize > MAX_DOCUMENT_BYTES) {
        // Not downloaded at all: the bridge could not deliver it, and the
        // browser would have filled the disk with it and the bridge its
        // memory. The bridge sends a notice instead.
        msg.metadata.fileTooBig = true;
      } else {
        // Need to trigger click to download
        let networkDoc = this.findNetworkDocument();
        if (!networkDoc) {
          networkDoc = await this.triggerDocumentDownload(chatId, msg.sourceMessageId);
        }
        if (networkDoc?.tooBig) {
          msg.metadata.fileTooBig = true;
          msg.metadata.fileSize = networkDoc.bytes;
        } else if (networkDoc) {
          try {
            // The name MAX shows on the card first: a file downloaded again
            // after a failed try comes out of the browser as "name (1).pdf".
            const cardName = msg.originalFilename || '';
            const downloadedExt = path.extname(networkDoc.originalName || '');
            const originalName = cardName
              ? (path.extname(cardName) || !downloadedExt ? cardName : `${cardName}${downloadedExt}`)
              : (networkDoc.originalName || '');
            const ext = originalName ? path.extname(originalName) : this.guessDocExtension(networkDoc.contentType, networkDoc.url);
            // A directory per message: named straight into mediaDir, two
            // documents with the same name (or any two Cyrillic names, which
            // the old ASCII-only sanitizer reduced to "_.pdf") read in one
            // poll overwrote each other before either was forwarded.
            const filename = originalName ? safeDisplayName(originalName) : `document${ext}`;
            const docPath = saveBuffer(path.join(this.mediaDir, `doc-${msg.id}`), filename, networkDoc.buffer);
            msg.mediaPath = docPath;
            msg.originalFilename = originalName || filename;
            logger.debug({ chatId, docPath, originalName: msg.originalFilename, size: networkDoc.buffer.length, contentType: networkDoc.contentType }, 'Saved document from network');
          } catch (error) {
            logger.warn({ err: error, chatId }, 'Failed to save network document');
            msg.metadata.fileCaptureFailed = true;
          }
        } else {
          // Tried again on the next reads; after that the bridge says it could
          // not fetch the file (it used to go out as the text "[Document]").
          msg.metadata.fileCaptureFailed = true;
        }
      }
    }

    return messages;
  }

  guessDocExtension(contentType, url) {
    if (contentType?.includes('pdf')) return '.pdf';
    if (contentType?.includes('msword') || contentType?.includes('wordprocessingml')) return '.docx';
    if (contentType?.includes('spreadsheetml') || contentType?.includes('excel')) return '.xlsx';
    if (contentType?.includes('zip')) return '.zip';
    if (contentType?.includes('png')) return '.png';
    if (contentType?.includes('jpeg') || contentType?.includes('jpg')) return '.jpg';
    // Try to extract from URL
    const urlMatch = url?.match(/\.([a-zA-Z0-9]{2,5})(?:\?|$)/);
    if (urlMatch) return '.' + urlMatch[1];
    return '.bin';
  }

  // Telegram→MAX replies: locates the message bubble whose content fingerprint
  // matches `fingerprint` (the same `author|time|text|mediaUrl` string stored as
  // sourceMessageId when the message was originally read — see scrapeMessageRows
  // above), scrolling the message list upward to load older history if it isn't
  // visible yet. Hovers the bubble (required for its quick-action row to render)
  // and returns its bounding box ({x, y, w, h}) on success, null if it could
  // not be found within the bounded search — callers must treat that as "send
  // without a reply link", not an error. The box is also used by replyToMessage
  // (Fix 3 in the reply-feature review) to scope the Reply button lookup to
  // this specific bubble's row instead of the first Reply button in the page.
  //
  // A fingerprint prefixed "media-token:" switches to matching a media bubble
  // by its CDN identity token (see bridge.js resolveMaxReplyTarget) instead of
  // the exact author|time|text|mediaUrl string, since a media bubble's img/video
  // src can lazy-swap resolution (fn=w_180 -> fn=w_1280) between when it was
  // first read and when we search for it again — the token stays stable.
  async findAndHoverMessage(fingerprint) {
    // The unstable index fallback can never be found again (see scrapeMessageRows).
    if (!fingerprint || fingerprint.startsWith('visible-')) return null;
    const maxScrollAttempts = 8;
    const mediaTokenPrefix = 'media-token:';
    const mediaToken = fingerprint.startsWith(mediaTokenPrefix) ? fingerprint.slice(mediaTokenPrefix.length) : null;
    for (let attempt = 0; attempt <= maxScrollAttempts; attempt++) {
      // The same scrape readMessages uses, so a bubble is found under exactly
      // the id it was given (numbering of identical bubbles included) — the
      // two used to compute it separately and drift apart.
      const rows = await this.scrapeMessageRows();
      // A fingerprint stored before the time was part of ids is that bubble's
      // legacy id.
      const row = [...rows].reverse().find((candidate) => (mediaToken
        ? mediaTokenOf(candidate.mediaUrl) === mediaToken
        : candidate.rawId === fingerprint || candidate.legacyRawId === fingerprint));
      const box = row?.box;

      if (box) {
        const cx = box.x + box.w / 2;
        const cy = box.y + box.h / 2;
        await this.page.mouse.move(cx, cy, { steps: 8 });
        await new Promise((r) => setTimeout(r, 250));
        return box;
      }

      if (attempt < maxScrollAttempts) {
        await this.scrollMessageListBy(-800);
        await new Promise((r) => setTimeout(r, 350));
      }
    }
    return null;
  }

  // Hovers and clicks the target bubble's Reply button, then waits for the
  // composer to enter reply mode. Best-effort: returns false (never throws) if
  // the bubble can't be located or the click doesn't visibly engage reply mode,
  // so the caller can fall back to a plain (non-reply) send.
  //
  // The Reply button lookup is scoped to the hovered bubble's row (Fix 3 in
  // the reply-feature review): querying this.selectors.messageReplyButton
  // page-wide is unsafe when more than one Reply button is mounted at once
  // (e.g. hover transitions across bubbles while the mouse moves into place)
  // — the first match in document order could belong to the wrong message,
  // silently engaging reply mode on it instead.
  async replyToMessage(fingerprint) {
    if (!fingerprint) return false;
    let candidates = [];
    try {
      const box = await this.findAndHoverMessage(fingerprint);
      if (!box) {
        logger.warn({ fingerprint }, 'replyToMessage: target bubble not found');
        return false;
      }
      candidates = await this.page.$$(this.selectors.messageReplyButton);
      if (!candidates.length) {
        logger.warn({ fingerprint }, 'replyToMessage: Reply button not present after hover');
        return false;
      }
      const rowTop = box.y - 40;
      const rowBottom = box.y + box.h + 40;
      const matches = [];
      for (const candidate of candidates) {
        const candidateBox = await candidate.boundingBox().catch(() => null);
        if (!candidateBox) continue;
        const centerY = candidateBox.y + candidateBox.height / 2;
        if (centerY >= rowTop && centerY <= rowBottom) matches.push(candidate);
      }
      if (matches.length !== 1) {
        logger.warn({ fingerprint, candidateCount: candidates.length, matchCount: matches.length }, 'replyToMessage: could not unambiguously locate Reply button for target bubble');
        return false;
      }
      await matches[0].click();
      await this.waitForSelectorFree(this.selectors.composerReplyActive, { timeout: 3000, visible: true });
      return true;
    } catch (error) {
      logger.warn({ err: error, fingerprint }, 'replyToMessage: failed to engage reply mode');
      return false;
    } finally {
      await disposeHandles(candidates);
    }
  }

  // Reactions of the bubbles on screen in the active chat, for the bridge to
  // mirror into Telegram: [{ rawId, outgoing, reactions: [{ emoji, count,
  // active }], reactionsUnknown }] (active = one of them is ours). Reuses what
  // the last readMessages of this chat scraped moments ago, so a poll does not
  // scrape twice. Bubbles whose id is not unique on screen are left out — they
  // cannot be told apart. null when another chat is open.
  async readReactions(chatId, { maxAgeMs = REACTION_SCAN_MAX_AGE_MS } = {}) {
    if (!this.page || !chatId || this.activeChatId !== chatId) return null;
    const cached = this.lastReactionScan;
    const rows = cached && cached.chatId === chatId && Date.now() - cached.at <= maxAgeMs
      ? cached.rows
      : (await this.scrapeMessageRows()).map(reactionRowOf);
    const counts = new Map();
    for (const row of rows) counts.set(row.rawId, (counts.get(row.rawId) || 0) + 1);
    return rows.filter((row) => !row.rawId.startsWith('visible-') && counts.get(row.rawId) === 1);
  }

  // Sets the owner's reaction on a MAX bubble to `emoji`, or takes it back
  // (emoji null). MAX keeps one reaction of your own per message; choosing
  // another replaces it. The ways, in order: a chip under the bubble already
  // shows that emoji (clicking it toggles ours); otherwise the message menu —
  // right click, or the "Message actions" button — whose top row lists the
  // reactions, expanded when the emoji is not among the first ones.
  // Resolves to { ok, changed, reason, available }; never throws for a
  // missing button or emoji, only for a broken page.
  async reactToMessage(chatId, fingerprint, emoji) {
    await this.ensureActiveChat(chatId);
    // A reaction, or several acceptable ones, best first; none = take back.
    const candidates = (Array.isArray(emoji) ? emoji : [emoji]).map(normalizeEmojiInPage).filter(Boolean);
    const wanted = candidates.length ? candidates : null;
    try {
      const found = await this.findAndHoverMessage(fingerprint);
      if (!found) return { ok: false, reason: 'message-not-found' };
      const box = await this.revealBubble(found);
      const viewport = this.page.viewport() || { width: 1440, height: 980 };
      const onScreen = (chip) => Boolean(chip) && chip.x > 0 && chip.y > 0 && chip.x < viewport.width && chip.y < viewport.height;
      const chips = await this.reactionChipsAt(box);
      const own = chips.find((chip) => chip.active);
      if (!wanted) {
        if (!own) return { ok: true, changed: false };
        if (!onScreen(own)) return await this.pickReactionFromMenu(box, null);
        await this.page.mouse.click(own.x, own.y);
        return { ok: true, changed: true };
      }
      if (own && wanted.includes(normalizeEmojiInPage(own.emoji))) return { ok: true, changed: false, emoji: own.emoji };
      for (const candidate of wanted) {
        const existing = chips.find((chip) => normalizeEmojiInPage(chip.emoji) === candidate);
        if (onScreen(existing)) {
          await this.page.mouse.click(existing.x, existing.y);
          return { ok: true, changed: true, emoji: existing.emoji };
        }
      }
      return await this.pickReactionFromMenu(box, wanted);
    } finally {
      await this.closeMessageMenu();
      await this.scrollMessageListToBottom();
    }
  }

  // Brings the bubble at `box` (as findAndHoverMessage returned it) to the
  // middle of the message list — its reaction chips sit below it — and
  // hovers it again. Returns where it is now.
  async revealBubble(box) {
    const moved = await this.page.evaluate((sel, area) => {
      const node = [...document.querySelectorAll(sel)].find((el) => {
        const rect = el.getBoundingClientRect();
        return Math.abs(rect.x - area.x) < 4 && Math.abs(rect.y - area.y) < 4 && Math.abs(rect.height - area.h) < 4;
      });
      if (!node) return null;
      node.scrollIntoView({ block: 'center', inline: 'nearest' });
      const rect = node.getBoundingClientRect();
      return { x: rect.x, y: rect.y, w: rect.width, h: rect.height };
    }, this.selectors.messageItem, box).catch(() => null);
    if (!moved) return box;
    await this.page.mouse.move(moved.x + moved.w / 2, moved.y + Math.min(moved.h / 2, 24), { steps: 4 });
    await new Promise((resolve) => setTimeout(resolve, 200));
    return moved;
  }

  // The reaction chips of the bubble at `box`, with where to click them.
  async reactionChipsAt(box) {
    const rows = await this.scrapeMessageRows();
    const row = rows.find((candidate) => candidate.box
      && Math.abs(candidate.box.x - box.x) < 4 && Math.abs(candidate.box.y - box.y) < 4
      && Math.abs(candidate.box.h - box.h) < 4);
    return row?.reactions || [];
  }

  // Opens the bubble's message menu and picks the first of `wanted` its
  // reaction row has (null: takes back the one marked as ours).
  async pickReactionFromMenu(box, wanted) {
    if (!await this.openMessageMenu(box)) {
      logger.warn('reactToMessage: the message menu did not open');
      await this.captureDiagnostics('reaction-no-menu', { throttleMs: 10 * 60 * 1000 }).catch(() => null);
      return { ok: false, reason: 'menu-not-found' };
    }
    let picked = await this.clickReactionOption(wanted);
    if (!picked.found && wanted && await this.clickFirstVisible(this.selectors.reactionExpand)) {
      await new Promise((resolve) => setTimeout(resolve, 400));
      picked = await this.clickReactionOption(wanted);
    }
    if (picked.found) return { ok: true, changed: picked.clicked, emoji: picked.emoji };
    if (!picked.available.length) {
      await this.captureDiagnostics('reaction-no-options', { throttleMs: 10 * 60 * 1000 }).catch(() => null);
      return { ok: false, reason: 'no-reactions-in-menu', available: [] };
    }
    return { ok: false, reason: 'emoji-not-available', available: picked.available };
  }

  // Right click on the bubble (MAX opens its message menu on contextmenu),
  // else its "Message actions" button. True once the menu's reactions show.
  async openMessageMenu(box) {
    const cx = box.x + box.w / 2;
    const cy = box.y + Math.min(box.h / 2, 24);
    await this.page.mouse.click(cx, cy, { button: 'right' });
    if (await this.waitForVisible(this.selectors.reactionOption, 1500)) return true;
    await this.closeMessageMenu();
    await this.page.mouse.move(cx, cy);
    await new Promise((resolve) => setTimeout(resolve, 250));
    const clicked = await this.page.evaluate((sel, area) => {
      try {
        const top = area.y - 40;
        const bottom = area.y + area.h + 40;
        const button = [...document.querySelectorAll(sel)].find((el) => {
          const rect = el.getBoundingClientRect();
          const centerY = rect.y + rect.height / 2;
          return rect.width > 0 && centerY >= top && centerY <= bottom;
        });
        if (!button) return false;
        button.click();
        return true;
      } catch {
        return false;
      }
    }, this.selectors.messageActionsButton, box).catch(() => false);
    return clicked && this.waitForVisible(this.selectors.reactionOption, 1500);
  }

  // Clicks the first of the reactions `wanted` the open menu has — unless it
  // is already ours (clicking would take it back); with wanted null, clicks
  // the one that is ours. In the page, so it works wherever MAX placed the
  // menu. Resolves to { found, clicked, emoji, available }.
  async clickReactionOption(wanted) {
    return this.page.evaluate((sel, target) => {
      const pictographic = /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20E3/u;
      const segmenter = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
      const emojiIn = (value) => (segmenter ? [...segmenter.segment(value || '')].map((part) => part.segment) : Array.from(value || ''))
        .filter((grapheme) => pictographic.test(grapheme));
      const normalize = (value) => String(value || '').replace(/[\uFE0E\uFE0F]/gu, '').replace(/[\u{1F3FB}-\u{1F3FF}]/gu, '').trim();
      let elements = [];
      try {
        elements = [...document.querySelectorAll(sel)];
      } catch {
        return { found: false, clicked: false, available: [] };
      }
      const options = elements.map((el) => {
        const rect = el.getBoundingClientRect();
        if (!rect.width || !rect.height) return null;
        const labels = [...el.querySelectorAll('[data-lexical-animoji-emoji], [data-lexical-emoji], img[alt]')]
          .map((node) => node.getAttribute('data-lexical-animoji-emoji') || node.getAttribute('data-lexical-emoji') || node.getAttribute('alt') || '');
        const emoji = [...labels, el.getAttribute('aria-label') || '', el.getAttribute('title') || '', el.textContent || ''].flatMap(emojiIn)[0] || null;
        const active = /(^|\s)[\w-]*--active(\s|$)/.test(el.getAttribute('class') || '') || el.getAttribute('aria-pressed') === 'true';
        return { el, emoji, active };
      }).filter(Boolean);
      const available = [...new Set(options.map((option) => option.emoji).filter(Boolean))];
      if (target === null) {
        const ours = options.find((option) => option.active);
        if (ours) ours.el.click();
        return { found: options.length > 0, clicked: Boolean(ours), available };
      }
      const option = target.map((wanted) => options.find((candidate) => normalize(candidate.emoji) === wanted)).find(Boolean);
      if (!option) return { found: false, clicked: false, available };
      if (!option.active) option.el.click();
      return { found: true, clicked: !option.active, emoji: option.emoji, available };
    }, this.selectors.reactionOption, wanted).catch(() => ({ found: false, clicked: false, available: [] }));
  }

  async waitForVisible(selector, timeoutMs) {
    if (!selector) return false;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const visible = await this.page.evaluate((sel) => {
        try {
          return [...document.querySelectorAll(sel)].some((el) => {
            const rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          });
        } catch {
          return false;
        }
      }, selector).catch(() => false);
      if (visible) return true;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    return false;
  }

  async clickFirstVisible(selector) {
    if (!selector) return false;
    return this.page.evaluate((sel) => {
      try {
        const element = [...document.querySelectorAll(sel)].find((el) => {
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        });
        if (!element) return false;
        element.click();
        return true;
      } catch {
        return false;
      }
    }, selector).catch(() => false);
  }

  // Escape closes an open menu — but with no menu open, MAX takes it as
  // "close this chat". So only when a menu is actually showing.
  async closeMessageMenu() {
    if (!this.page) return;
    const open = await this.page.evaluate((sel) => {
      try {
        return [...document.querySelectorAll(sel)].some((el) => {
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        });
      } catch {
        return false;
      }
    }, this.selectors.messageMenu || '[role="menu"]').catch(() => false);
    if (open) await this.page.keyboard.press('Escape').catch(() => {});
  }

  async sendText(chatId, text, replyToFingerprint = null) {
    await this.ensureActiveChat(chatId);
    await this.clearComposer();
    if (replyToFingerprint) {
      const replied = await this.replyToMessage(replyToFingerprint);
      logger.debug({ chatId, replyToFingerprint, replied }, 'sendText: reply engagement result');
    }
    // findAndHoverMessage (inside replyToMessage) scrolls the message list up
    // to locate the target bubble, whether or not it ultimately found one,
    // leaving the chat scrolled away from the bottom. Both readMessages and
    // ensureActiveChat only reset scroll on an actual chat switch
    // (activeChatId !== chatId), so if this same chat is already active on
    // the next poll, the stale scroll position would be read from directly —
    // risking missed new messages in the virtualized list. The finally block
    // below restores scroll-to-bottom on every exit path (success or throw),
    // not just the happy path — see Fix 1 in the reply-feature review.
    try {
      await this.waitForSelectorFree(this.selectors.composer, { timeout: 30000 });
      await this.page.focus(this.selectors.composer);
      await this.typeIntoComposer(text, { timeoutMs: this.config.protocolTimeoutMs || 60000 });
      await this.submitComposer();
    } catch (error) {
      // Whatever was typed stays in the composer as the chat's draft and went
      // out together with the next message into this chat.
      await this.clearComposer().catch((clearError) => {
        logger.warn({ err: clearError, chatId }, 'sendText: could not clear the composer after a failed send');
      });
      if (replyToFingerprint) {
        // A throw anywhere after reply mode was engaged would otherwise leave
        // the shared composer stuck in reply-to-X mode forever — there is no
        // other code path that closes the reply banner, so the NEXT message
        // sent (to any chat) would silently become a wrong-target reply.
        // Best-effort cancel; never let a failure here mask the real error.
        try {
          await this.clickSelector(this.selectors.composerReplyActive);
        } catch (cancelError) {
          logger.warn({ err: cancelError, chatId }, 'sendText: failed to cancel reply mode after send failure');
        }
      }
      throw error;
    } finally {
      if (replyToFingerprint) {
        await this.scrollMessageListToBottom();
      }
    }
  }

  // Empties the composer. MAX keeps whatever is typed as the chat's draft, so
  // the remains of a send that failed half-way used to be sent along with the
  // next message into that chat (or as the caption of the next file).
  async clearComposer() {
    const hasContent = await this.page.evaluate((sel) => {
      const el = document.querySelector(sel);
      return Boolean(el && ((el.textContent || '').trim() || el.querySelector('img, [data-lexical-decorator]')));
    }, this.selectors.composer).catch(() => false);
    if (!hasContent) return;
    await this.page.focus(this.selectors.composer);
    const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
    await this.page.keyboard.down(modifier);
    try {
      await this.page.keyboard.press('KeyA');
    } finally {
      await this.page.keyboard.up(modifier);
    }
    await this.page.keyboard.press('Backspace');
    logger.info('Cleared text left over in the MAX composer');
  }

  // Types a message into the focused composer. Puppeteer's keyboard.type maps
  // "\n" to the Enter key, and Enter SENDS in MAX's composer — typing a
  // multi-line message used to fire one partial message per line (only the
  // first carrying the reply quote). Line breaks are Shift+Enter instead, and
  // tabs become spaces (Tab would move focus out of the composer, and the rest
  // of the text would be typed into some other element).
  //
  // Typed in chunks with the deadline checked in between, so a timeout really
  // stops the typing: racing one long type() against a timer only rejected
  // the caller while the keystrokes kept flowing into the page after the lock
  // had been released.
  async typeIntoComposer(text, { timeoutMs = 60000, chunkSize = 200 } = {}) {
    const deadline = Date.now() + timeoutMs;
    const lines = String(text ?? '').replace(/\t/g, '    ').split(/\r\n|\r|\n/);
    for (let i = 0; i < lines.length; i++) {
      if (i > 0) {
        await this.page.keyboard.down('Shift');
        try {
          await this.page.keyboard.press('Enter');
        } finally {
          await this.page.keyboard.up('Shift');
        }
      }
      const chars = Array.from(lines[i]);
      for (let start = 0; start < chars.length; start += chunkSize) {
        if (Date.now() > deadline) throw new Error('Typing timeout');
        await this.page.keyboard.type(chars.slice(start, start + chunkSize).join(''), { delay: 1 });
      }
    }
  }

  // Sends the file alone: MAX's attach flow has no caption the bridge fills
  // in, so the bridge sends a caption as a separate text message.
  async sendFile(chatId, filePath) {
    await this.ensureActiveChat(chatId);
    // Text left in the composer would go out as the file's caption.
    await this.clearComposer();

    const absolutePath = path.resolve(filePath);

    // --- Step 1: open the attach menu, pick the option, and accept the file ---
    // MAX's paperclip opens an actions menu; the real file <input> is only wired
    // up after choosing "Photo or video" (images/videos) or "File" (everything
    // else). Setting the input directly does nothing, so we drive the menu.
    const isImageOrVideo = /\.(jpe?g|png|gif|webp|bmp|heic|heif|mp4|webm|mov|m4v|mkv)$/i.test(absolutePath);
    const menuItemSel = isImageOrVideo ? this.selectors.attachMenuMedia : this.selectors.attachMenuFile;
    if (!await this.clickSelector(this.selectors.attachButton)) {
      throw new Error(`sendFile: attach button not found (${this.selectors.attachButton})`);
    }
    await this.waitForSelectorFree(menuItemSel, { timeout: 10000 });
    const [fileChooser] = await Promise.all([
      this.page.waitForFileChooser({ timeout: 15000 }),
      this.page.click(menuItemSel)
    ]);
    await fileChooser.accept([absolutePath]);
    logger.debug({ chatId, filePath: absolutePath }, 'File accepted via attach menu');

    // --- Step 2: wait for evidence the attachment is staged in the composer ---
    // Poll up to 10 s for a preview/thumbnail element that appears after accept.
    const attachStagedTimeoutMs = 10000;
    const attachStagedPollMs = 300;
    const attachPreviewSel = this.selectors.attachPreview;
    let staged = false;
    const attachDeadline = Date.now() + attachStagedTimeoutMs;
    while (Date.now() < attachDeadline) {
      staged = await this.page.evaluate((sel) => Boolean(document.querySelector(sel)), attachPreviewSel).catch(() => false);
      if (staged) break;
      await new Promise((r) => setTimeout(r, attachStagedPollMs));
    }

    if (!staged) {
      // The attachment did not appear in the composer — the file was not staged.
      // Capture diagnostics so the live DOM can be inspected for selector tuning.
      await this.captureDiagnostics('attach-not-staged').catch(() => null);
      logger.warn({ chatId, filePath: absolutePath, attachPreviewSel }, 'sendFile: attachment preview not detected in composer after file accept — selector may need tuning');
      // We continue optimistically: the DOM shape may differ and the file may
      // still be staged.  The post-send verification will catch a real failure.
    } else {
      logger.debug({ chatId, filePath: absolutePath }, 'sendFile: attachment staged in composer');
    }

    // --- Step 3: snapshot outgoing bubble count before triggering send ---
    const outgoingBubbleSel = this.selectors.outgoingBubble;
    const outgoingCountBefore = await this.page.evaluate(
      (sel) => document.querySelectorAll(sel).length,
      outgoingBubbleSel
    ).catch(() => 0);

    // --- Step 4: click send button (or fall back to Enter) ---
    if (!await this.clickSelector(this.selectors.sendButton)) {
      await this.page.keyboard.press('Enter');
    }

    // --- Step 5: poll up to 10 s for a new outgoing bubble ---
    const sendConfirmTimeoutMs = 10000;
    const sendConfirmPollMs = 400;
    let confirmed = false;
    const sendDeadline = Date.now() + sendConfirmTimeoutMs;
    while (Date.now() < sendDeadline) {
      const outgoingCountAfter = await this.page.evaluate(
        (sel) => document.querySelectorAll(sel).length,
        outgoingBubbleSel
      ).catch(() => 0);
      if (outgoingCountAfter > outgoingCountBefore) {
        confirmed = true;
        break;
      }
      await new Promise((r) => setTimeout(r, sendConfirmPollMs));
    }

    if (!confirmed) {
      // Only on failure: two full-page screenshots + HTML dumps on EVERY file
      // send were pure overhead, and pushed the dumps of real failures out of
      // the retention window.
      await this.captureDiagnostics('send-not-confirmed').catch(() => null);
      logger.error({ chatId, filePath: absolutePath, outgoingCountBefore, outgoingBubbleSel }, 'sendFile: no new outgoing message bubble detected after send');
      throw new Error(`sendFile: file send not confirmed — no new outgoing bubble appeared (chatId=${chatId}, file=${absolutePath}). Selector may need tuning; check diagnostics.`);
    }

    logger.debug({ chatId, filePath: absolutePath }, 'Sent file');
  }

  // Chats where someone is typing right now, as MAX's chat list shows it —
  // "печатает", "Иван записывает аудио"… in place of the last message; the
  // chat need not be open. [{ chatId, action }], action being the Telegram
  // chat action for what they are doing.
  async typingChats() {
    if (!this.page || this.page.isClosed?.()) return [];
    const found = await this.page.$$eval(this.selectors.chatItem, (nodes, sel) => nodes.map((node) => {
      let typing = null;
      try {
        typing = node.querySelector(sel.chatTyping);
      } catch {
        return null;
      }
      if (!typing) return null;
      const title = node.querySelector(sel.chatTitle)?.textContent?.trim() || '';
      return title ? { title, label: (typing.textContent || '').replace(/\s+/g, ' ').trim() } : null;
    }).filter(Boolean), this.selectors).catch(() => []);
    return found.map(({ title, label }) => ({ chatId: title, action: typingAction(label) }));
  }

  async isTyping() {
    await this.ensurePage();
    return this.page.evaluate((selector) => Boolean(document.querySelector(selector)), this.selectors.typing);
  }

  async healthCheck() {
    await this.ensurePage();
    const result = {
      browserConnected: Boolean(this.browser?.connected),
      url: this.page.url(),
      pageTitle: await this.page.title().catch(() => ''),
      activeChatId: this.activeChatId,
      checks: []
    };

    await this.addSelectorCheck(result, 'chatList', this.selectors.chatList);
    await this.addSelectorCheck(result, 'chatItem', this.selectors.chatItem);

    let chats = [];
    try {
      chats = await this.listChats();
      result.chatCount = chats.length;
      result.checks.push({ name: 'listChats', ok: true, detail: `${chats.length} chats` });
    } catch (error) {
      result.chatCount = 0;
      result.checks.push({ name: 'listChats', ok: false, detail: error.message });
    }

    const probeChat = chats.find((chat) => chat.id === this.activeChatId) || chats[0];
    if (!probeChat) {
      result.checks.push({ name: 'probeChat', ok: false, detail: 'No visible Max chats' });
      return result;
    }

    try {
      await this.selectChat(probeChat.id);
      result.checks.push({ name: 'selectChat', ok: true, detail: probeChat.title });
    } catch (error) {
      result.checks.push({ name: 'selectChat', ok: false, detail: error.message });
      return result;
    }

    await this.addSelectorCheck(result, 'activeChatTitle', this.selectors.activeChatTitle);
    await this.addSelectorCheck(result, 'messageList', this.selectors.messageList);
    await this.addSelectorCheck(result, 'messageItem', this.selectors.messageItem, false);
    await this.addSelectorCheck(result, 'composer', this.selectors.composer);
    await this.addSelectorCheck(result, 'attachInput', this.selectors.attachInput, false);
    await this.addSelectorCheck(result, 'sendButton', this.selectors.sendButton, false);

    return result;
  }

  // H5: all findNetwork* helpers filter by this.activeChatId so that a capture
  // tagged to a different chat (slow response that arrived after selectChat) is
  // never returned for the current chat. Untagged legacy entries (chatId: null)
  // are accepted when activeChatId is also null, keeping behaviour unchanged in
  // tests and edge cases where no chat has been selected yet.
  _chatMatches(entry) {
    return entry.chatId === this.activeChatId;
  }

  findNetworkSticker() {
    return findNewestCapture(this._filteredMap(this.stickerUrls));
  }

  // Reliable Lottie fallback: MAX often serves the sticker JSON from HTTP cache,
  // so no `response` event fires and the network interceptor never sees it. The
  // URL is still listed in the page's Performance resource timeline, so we fetch
  // it from inside the (authenticated) MAX page — works for cached resources too.
  async fetchRecentLottieFromPage() {
    const result = await this.page.evaluate(async () => {
      try {
        const names = performance.getEntriesByType('resource')
          .map((e) => e.name)
          .filter((n) => n.includes('lottie=true'));
        const urls = [...new Set(names)].reverse().slice(0, 5);
        for (const url of urls) {
          try {
            const resp = await fetch(url, { credentials: 'include' });
            if (!resp.ok) continue;
            const bytes = new Uint8Array(await resp.arrayBuffer());
            if (bytes.length < 500) continue;
            let binary = '';
            for (let i = 0; i < bytes.length; i += 8192) {
              binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
            }
            return { url, base64: btoa(binary) };
          } catch {
            /* try next url */
          }
        }
      } catch {
        /* performance/fetch unavailable */
      }
      return null;
    }).catch(() => null);
    if (!result?.base64) return null;
    return {
      url: result.url,
      buffer: Buffer.from(result.base64, 'base64'),
      timestamp: Date.now(),
      contentType: 'application/octet-stream'
    };
  }

  // Newest captured sticker asset that is a Lottie animation (served by MAX as
  // `...lottie=true` / application/octet-stream). Consumed so it is used once.
  findNetworkLottie() {
    let bestKey = null;
    let best = null;
    for (const [key, entry] of this.stickerUrls) {
      if (!this._chatMatches(entry)) continue;
      const isLottie = (entry.url && entry.url.includes('lottie=true'))
        || (entry.contentType || '').includes('octet-stream');
      if (!isLottie) continue;
      if (!best || entry.timestamp > best.timestamp) {
        best = entry;
        bestKey = key;
      }
    }
    if (bestKey !== null) this.stickerUrls.delete(bestKey);
    return best;
  }

  findNetworkVoice() {
    return consumeNewestCapture(this._filteredMap(this.voiceUrls));
  }

  findNetworkVideo() {
    // Filter out small thumbnails (< 10KB) — keep only actual video buffers
    for (const [key, entry] of this.videoUrls) {
      if (entry.buffer.length < 10000 || (entry.contentType && entry.contentType.startsWith('image/'))) {
        this.videoUrls.delete(key);
      }
    }
    return consumeNewestCapture(this._filteredMap(this.videoUrls));
  }

  findNetworkDocument() {
    return consumeNewestCapture(this._filteredMap(this.documentUrls));
  }

  // Build a shallow view of a capture map containing only entries that match
  // the current activeChatId. The view shares the same entry objects so a
  // delete on the original map is reflected immediately after consumption.
  _filteredMap(source) {
    const view = new Map();
    for (const [key, entry] of source) {
      if (this._chatMatches(entry)) view.set(key, entry);
    }
    // consumeNewestCapture / findNewestCapture delete from the map they receive;
    // we need deletions to propagate back to the original. Proxy the delete.
    return new Proxy(view, {
      get(target, prop) {
        if (prop === 'delete') {
          return (key) => { target.delete(key); source.delete(key); };
        }
        const val = target[prop];
        return typeof val === 'function' ? val.bind(target) : val;
      }
    });
  }

  // Clicks the first element matching one of `targets` (tried in order)
  // inside the bubble read as `rawId`. The bubble is found by the same scrape
  // that gave it that id — counting bubbles of a kind in the page and in Node
  // drifted apart (an outgoing bubble is marked on an ancestor, which the
  // page-side count did not see), and the next file or voice message was
  // fetched for this one. False when the bubble is gone or has no target.
  async clickInBubble(rawId, targets) {
    if (!rawId) return false;
    const rows = await this.scrapeMessageRows();
    const index = rows.findIndex((row) => row.rawId === rawId);
    if (index < 0) return false;
    return this.page.$$eval(this.selectors.messageItem, (nodes, i, box, selectorList) => {
      const node = nodes[i];
      if (!node) return false;
      // The list must not have moved since it was read.
      const rect = node.getBoundingClientRect();
      if (box && (Math.abs(rect.x - box.x) > 2 || Math.abs(rect.y - box.y) > 2)) return false;
      for (const selector of selectorList) {
        let target = null;
        try {
          target = selector ? node.querySelector(selector) : null;
        } catch {
          target = null;
        }
        if (target) {
          target.click();
          return true;
        }
      }
      return false;
    }, index, rows[index].box || null, targets).catch(() => false);
  }

  async triggerDocumentDownload(chatId, rawId) {
    try {
      const docCountBefore = this.documentUrls.size;
      // Before the click: a file the browser saves is found as a new name in
      // the downloads folder.
      const downloadFilesBefore = new Set(fs.readdirSync(this.downloadDir));

      const clicked = await this.clickInBubble(rawId, [
        this.selectors.messageFileCard,
        'button[aria-label*="качать"], button[aria-label*="Download"], a[href][download], button[class*="download"], [class*="download"]',
        // A file link, never one in the text or its preview.
        `:is(a[href*="/file"], a[href*="/download"]):not(:is(${this.selectors.messageText}, ${this.selectors.messageLinkPreview}) *)`,
        '[class*="fileIcon"], [class*="document"], [class*="attachDoc"], [class*="file-info"], [class*="fileName"], [data-testid*="document"], [data-testid*="file"]'
      ]);

      if (!clicked) {
        logger.debug({ chatId }, 'triggerDocumentDownload: no document element found');
        return null;
      }

      logger.debug({ chatId }, 'triggerDocumentDownload: clicked, waiting for network response');

      const sizeOf = (name) => {
        try {
          return fs.statSync(path.join(this.downloadDir, name)).size;
        } catch {
          return 0;
        }
      };

      // A few seconds for the download to start, then as long as it keeps
      // growing: a file of a few MB used to be given up on after 5 seconds.
      const startedAt = Date.now();
      let deadline = startedAt + DOCUMENT_DOWNLOAD_START_MS;
      let partialBytes = 0;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        if (this.documentUrls.size > docCountBefore) {
          const doc = this.findNetworkDocument();
          if (doc) {
            logger.debug({ chatId, size: doc.buffer.length, contentType: doc.contentType }, 'triggerDocumentDownload: captured document from network');
            return doc;
          }
        }
        // Check for new files in download dir (browser download)
        const entries = fs.readdirSync(this.downloadDir).filter((f) => !downloadFilesBefore.has(f));
        const newFiles = entries.filter((f) => !f.endsWith('.crdownload'));
        if (newFiles.length > 0) {
          const originalName = newFiles[0];
          const filePath = path.join(this.downloadDir, originalName);
          const bytes = sizeOf(originalName);
          if (bytes > MAX_DOCUMENT_BYTES) {
            // Its card did not say how big it is: never read it into memory.
            fs.rmSync(filePath, { force: true });
            logger.info({ chatId, bytes }, 'triggerDocumentDownload: file is over the size limit, not forwarded');
            return { tooBig: true, bytes, originalName };
          }
          const buffer = fs.readFileSync(filePath);
          const ext = path.extname(originalName) || '.bin';
          logger.debug({ chatId, filePath, size: buffer.length, originalName }, 'triggerDocumentDownload: captured document from download dir');
          fs.unlinkSync(filePath);
          return { url: filePath, buffer, timestamp: Date.now(), contentType: `application/${ext.slice(1)}`, originalName };
        }
        const partial = entries.filter((f) => f.endsWith('.crdownload')).reduce((sum, f) => sum + sizeOf(f), 0);
        if (partial > MAX_DOCUMENT_BYTES) {
          // (The browser finishes it on its own; the downloads sweep removes it.)
          logger.info({ chatId, bytes: partial }, 'triggerDocumentDownload: file is over the size limit, not forwarded');
          return { tooBig: true, bytes: partial };
        }
        if (partial > partialBytes) {
          partialBytes = partial;
          deadline = Math.min(startedAt + DOCUMENT_DOWNLOAD_MAX_MS, Date.now() + DOCUMENT_DOWNLOAD_START_MS);
        }
      }

      logger.debug({ chatId }, 'triggerDocumentDownload: no document captured after click');
      return null;
    } catch (error) {
      logger.warn({ err: error, chatId }, 'triggerDocumentDownload failed');
      return null;
    }
  }

  async triggerVoiceDownload(src, chatId) {
    try {
      const voiceCountBefore = this.voiceUrls.size;

      const clicked = await this.clickInBubble(src.rawId, [
        'button[class*="play"], button[aria-label*="Play"], button[aria-label*="play"], [class*="playBtn"], [class*="play-btn"], [data-testid*="play"], .play',
        '[class*="attachAudio"] button, [class*="voice"] button, [class*="audioMessage"] button',
        '[class*="voice"], [data-testid*="voice"], [class*="audioMessage"], [class*="audio-player"], [class*="attachAudio"], [class*="wave"]'
      ]);

      if (!clicked) {
        logger.debug({ chatId }, 'triggerVoiceDownload: no voice play button found');
        return null;
      }

      logger.debug({ chatId }, 'triggerVoiceDownload: clicked play, waiting for network audio');

      for (let attempt = 0; attempt < 10; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        if (this.voiceUrls.size > voiceCountBefore) {
          const voice = this.findNetworkVoice();
          if (voice) {
            logger.debug({ chatId, size: voice.buffer.length }, 'triggerVoiceDownload: captured voice after click');
            await this.page.evaluate(() => {
              document.querySelectorAll('audio').forEach((a) => { a.pause(); a.currentTime = 0; });
            }).catch(() => null);
            return voice;
          }
        }
      }

      logger.debug({ chatId }, 'triggerVoiceDownload: no audio captured after click');
      return null;
    } catch (error) {
      logger.warn({ err: error, chatId }, 'triggerVoiceDownload failed');
      return null;
    }
  }

  async triggerVideoNoteDownload(chatId, rawId) {
    try {
      const videoCountBefore = this.videoUrls.size;

      // (It used to be the newest video note on screen, whichever this was.)
      const clicked = await this.clickInBubble(rawId, [
        '[class*="videoMessage"], [class*="videoCanvas"], [class*="roundVideo"]'
      ]);

      if (!clicked) {
        logger.debug({ chatId }, 'triggerVideoNoteDownload: no video note element found');
        return null;
      }

      logger.debug({ chatId }, 'triggerVideoNoteDownload: clicked video note, waiting for network video');

      for (let attempt = 0; attempt < 10; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        const video = this.findNetworkVideo();
        if (video) {
          logger.debug({ chatId, size: video.buffer.length }, 'triggerVideoNoteDownload: captured video after click');
          return video;
        }
      }

      logger.debug({ chatId }, 'triggerVideoNoteDownload: no video captured after click');
      return null;
    } catch (error) {
      logger.warn({ err: error, chatId }, 'triggerVideoNoteDownload failed');
      return null;
    }
  }

  // Sample the canvas of the sticker bubble at `stickerIndex` repeatedly so an
  // animated (Lottie) sticker can be reconstructed as a video. Returns an array
  // of PNG frame buffers (newest Chromium renders Lottie to canvas in headless).
  async captureStickerFrames(stickerIndex, { frames = 24, intervalMs = 50 } = {}) {
    const buffers = [];
    const startedAt = Date.now();
    for (let i = 0; i < frames; i++) {
      const dataUrl = await this.page.$$eval(this.selectors.messageItem, (nodes, idx) => {
        const canvas = nodes[idx] && nodes[idx].querySelector('canvas');
        if (!canvas) return null;
        try {
          return canvas.toDataURL('image/png');
        } catch {
          return null;
        }
      }, stickerIndex).catch(() => null);
      if (dataUrl && dataUrl.startsWith('data:image')) {
        buffers.push(Buffer.from(dataUrl.split(',')[1], 'base64'));
      }
      if (i < frames - 1) await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    // Capture happens in real time, so the playback fps is how fast we actually
    // sampled (including per-frame overhead) — encoding the GIF at this fps
    // reproduces the sticker's real speed instead of running it fast/slow.
    const elapsedSec = Math.max(0.001, (Date.now() - startedAt) / 1000);
    const fps = buffers.length > 1 ? (buffers.length - 1) / elapsedSec : 15;
    return { frames: buffers, fps };
  }

  // Render a MAX Lottie sticker (raw or gzipped JSON) into PNG frame buffers by
  // playing it with lottie-web's canvas renderer in a throwaway page. This is
  // reliable in headless Chromium (unlike MAX's own WebGL canvas) because the
  // canvas renderer is pure 2D.
  async renderLottieToFrames(lottieBuffer, { targetFps = 20 } = {}) {
    const isGzip = lottieBuffer.length > 1 && lottieBuffer[0] === 0x1f && lottieBuffer[1] === 0x8b;
    const json = (isGzip ? zlib.gunzipSync(lottieBuffer) : lottieBuffer).toString('utf8');
    let animationData;
    try {
      animationData = JSON.parse(json);
    } catch {
      throw new Error('Lottie payload is not valid JSON');
    }
    if (!this._lottieScript) {
      // The "light" canvas build has no expression support. The full build
      // eval()s JavaScript embedded in the animation — and these animations
      // come from other people (MAX stickers, Telegram .tgs), played in the
      // tab that holds the logged-in MAX session.
      const scriptPath = path.join(process.cwd(), 'node_modules', 'lottie-web', 'build', 'player', 'lottie_light_canvas.min.js');
      this._lottieScript = fs.readFileSync(scriptPath, 'utf8');
    }

    const page = await this.browser.newPage();
    try {
      await page.setViewport({ width: 512, height: 512, deviceScaleFactor: 1 });
      await page.setContent(
        '<!DOCTYPE html><html><body style="margin:0;background:transparent">'
        + '<div id="lottie" style="width:512px;height:512px"></div></body></html>',
        { waitUntil: 'domcontentloaded' }
      );
      await page.addScriptTag({ content: this._lottieScript });
      // Sample frames proportionally to the animation's native duration so the
      // GIF, played back at the returned fps, runs at the sticker's real speed.
      const result = await page.evaluate((data, fps) => new Promise((resolve, reject) => {
        try {
          const container = document.getElementById('lottie');
          const anim = window.lottie.loadAnimation({
            container,
            renderer: 'canvas',
            loop: false,
            autoplay: false,
            animationData: data,
            rendererSettings: { clearCanvas: true }
          });
          let done = false;
          const capture = () => {
            if (done) return;
            done = true;
            const total = anim.totalFrames || 1;
            const frameRate = anim.frameRate || 30;
            const durationSec = total / frameRate;
            const numFrames = Math.max(8, Math.min(72, Math.round(durationSec * fps)));
            const out = [];
            for (let i = 0; i < numFrames; i++) {
              anim.goToAndStop((total * i) / numFrames, true);
              const canvas = container.querySelector('canvas');
              out.push(canvas ? canvas.toDataURL('image/png') : null);
            }
            resolve({ dataUrls: out, durationSec });
          };
          anim.addEventListener('DOMLoaded', capture);
          setTimeout(capture, 3000);
        } catch (error) {
          reject(error);
        }
      }), animationData, targetFps);
      const frames = (result?.dataUrls || [])
        .filter((d) => d && d.startsWith('data:image'))
        .map((d) => Buffer.from(d.split(',')[1], 'base64'));
      const fps = result?.durationSec > 0 ? frames.length / result.durationSec : targetFps;
      return { frames, fps };
    } finally {
      await page.close().catch(() => null);
    }
  }

  saveFrameBuffers(msgId, frames) {
    const framesDir = path.join(this.mediaDir, `sticker-frames-${msgId}`);
    fs.rmSync(framesDir, { recursive: true, force: true });
    fs.mkdirSync(framesDir, { recursive: true });
    frames.forEach((buf, i) => {
      fs.writeFileSync(path.join(framesDir, `frame-${String(i).padStart(3, '0')}.png`), buf);
    });
    return framesDir;
  }

  clearMediaCaches() {
    this.stickerUrls.clear();
    this.voiceUrls.clear();
    this.videoUrls.clear();
    this.documentUrls.clear();
  }

  async stop() {
    const browser = this.browser;
    // Detach first: the 'disconnected' handler uses this to tell a requested
    // close from a crash, and nothing may keep driving a page that is closing.
    this.browser = null;
    this.page = null;
    this.activeChatId = null;
    this.activeChatTitle = null;
    this.captureChatId = null;
    this.clearMediaCaches();
    if (!browser) return;

    const browserProcess = browser.process?.() || null;
    let timer = null;
    try {
      await Promise.race([
        browser.close(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`browser.close() timed out after ${BROWSER_CLOSE_TIMEOUT_MS}ms`)), BROWSER_CLOSE_TIMEOUT_MS);
        })
      ]);
    } catch (error) {
      logger.warn({ err: error?.message || String(error) }, 'Chrome did not close cleanly; killing the process');
      try { browserProcess?.kill('SIGKILL'); } catch { /* already gone */ }
    } finally {
      clearTimeout(timer);
    }
  }

  // False once the browser is gone or its page was closed (a crash, a failed
  // relaunch). A crashed renderer can leave both looking alive, so callers
  // that must notice that also count failing page calls.
  isAlive() {
    return Boolean(this.browser?.connected && this.page && !this.page.isClosed?.() && !this.pageCrashed);
  }

  // Memory held by the whole Chromium process tree (see measureProcessTreeMemory):
  // { bytes, processes, method } or null when it cannot be measured (no local
  // browser process, or no /proc).
  async getBrowserMemoryUsage() {
    const pid = this.browser?.process?.()?.pid;
    if (!pid) return null;
    const usage = await measureProcessTreeMemory(pid);
    if (!usage) return null;
    // DOM node count and JS heap of the MAX page: what the handle leak used to
    // grow, so a regression shows up in /status and the logs.
    const metrics = await this.page?.metrics().catch(() => null);
    if (metrics) usage.page = { domNodes: metrics.Nodes, jsHeapBytes: metrics.JSHeapUsedSize };
    return usage;
  }

  // Reloads the MAX page in place: drops the renderer's DOM, JS heap and
  // DevTools network buffer (the network cap, the response listener and the
  // download behaviour all survive a reload). Much cheaper than a browser
  // relaunch. The caller holds the bridge's lock and waits for the chat list.
  async reloadPage({ timeoutMs = 60000 } = {}) {
    await this.ensurePage();
    this.activeChatId = null;
    this.activeChatTitle = null;
    this.captureChatId = null;
    this.clearMediaCaches();
    // A beforeunload prompt would block the reload forever.
    const acceptDialog = (dialog) => { dialog.accept().catch(() => {}); };
    this.page.on('dialog', acceptDialog);
    try {
      await this.page.reload({ waitUntil: 'domcontentloaded', timeout: timeoutMs });
    } finally {
      this.page.off('dialog', acceptDialog);
    }
    logger.info('Reloaded the MAX page');
  }

  async captureDiagnostics(reason, { throttleMs = 0 } = {}) {
    if (!this.page || !this.diagnosticDir) return null;
    // High-frequency automatic captures (e.g. a sticker sitting on screen,
    // re-detected every poll) pass throttleMs to avoid hammering the disk with
    // full-page screenshots + HTML. Failure/manual captures pass no throttle.
    if (throttleMs > 0 && Date.now() - this.lastDiagnosticAt < throttleMs) {
      return null;
    }
    this.lastDiagnosticAt = Date.now();
    fs.mkdirSync(this.diagnosticDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const basename = `${stamp}-${safeName(reason || 'diagnostic', 80)}`;
    const screenshotPath = path.join(this.diagnosticDir, `${basename}.png`);
    const htmlPath = path.join(this.diagnosticDir, `${basename}.html`);

    // On the sign-in screen the page IS a credential: a full-page screenshot
    // contains a scannable login QR, and /diagnostics uploads the newest files
    // to whatever chat asked — including the relay group. Capture the markup
    // only (with SVG contents stripped, see sanitizeDiagnosticHtml), never the
    // pixels. Selector debugging still gets everything it needs.
    const onLoginScreen = await this.getSessionState() === 'login-required';
    if (!onLoginScreen) {
      await this.page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => null);
    } else {
      logger.warn({ reason }, 'Skipping diagnostic screenshot: the sign-in QR is on screen');
    }

    const html = await this.page.content().catch(() => '');
    if (html) {
      fs.writeFileSync(htmlPath, sanitizeDiagnosticHtml(html, { redactText: this.diagnosticRedactText }));
    }
    await this.pruneDiagnostics().catch((error) => {
      logger.warn({ err: error }, 'Failed to prune Max Web diagnostics');
    });
    logger.warn({ reason, screenshotPath: onLoginScreen ? null : screenshotPath, htmlPath }, 'Captured Max Web diagnostics');
    return { screenshotPath: onLoginScreen ? null : screenshotPath, htmlPath };
  }

  async pruneDiagnostics() {
    const limit = this.diagnosticRetentionFiles;
    if (!Number.isFinite(limit) || limit <= 0 || !this.diagnosticDir) return;

    const files = await listFilesByMtime(this.diagnosticDir);
    const overflow = files.slice(limit);
    await Promise.all(overflow.map((file) => fsp.unlink(file.path).catch(() => null)));
  }

  async addSelectorCheck(result, name, selector, required = true) {
    try {
      const count = await this.page.$$eval(selector, (nodes) => nodes.length);
      result.checks.push({
        name,
        ok: required ? count > 0 : true,
        detail: `${count} match(es)`
      });
    } catch (error) {
      result.checks.push({ name, ok: false, detail: error.message });
    }
  }

  async ensureActiveChat(chatId) {
    await this.ensurePage();
    if (this.activeChatId !== chatId) {
      await this.selectChat(chatId);
    }
    // Always verify the header before typing. A chat scrolled out of MAX's
    // virtualized list is not in listChats(), and skipping the check for it
    // meant a send could go into whatever chat was really on screen; the
    // title remembered when the chat was selected covers that case.
    const chat = (await this.listChats()).find((candidate) => candidate.id === chatId)
      || (this.activeChatId === chatId && this.activeChatTitle ? { id: chatId, title: this.activeChatTitle } : null);
    if (!chat) throw new Error(`Cannot verify active Max chat before sending: ${chatId}`);
    await this.verifyActiveChat(chat);
  }

  async ensurePage() {
    if (!this.page) throw new Error('Max Web page is not started');
  }

  // waitForSelector without keeping the handle it resolves to (see
  // disposeHandles). Resolves true when the element appeared.
  async waitForSelectorFree(selector, options) {
    const handle = await this.page.waitForSelector(selector, options);
    await disposeHandles(handle);
    return Boolean(handle);
  }

  // Clicks the first match like a user would (real mouse events, which MAX's
  // buttons need), then lets the handle go. False when nothing matched.
  async clickSelector(selector) {
    const handle = await this.page.$(selector);
    if (!handle) return false;
    try {
      await handle.click();
    } finally {
      await disposeHandles(handle);
    }
    return true;
  }

  async verifyActiveChat(chat) {
    const title = await this.page.evaluate((selector) => {
      const el = document.querySelector(selector);
      return el?.textContent?.trim() || '';
    }, this.selectors.activeChatTitle).catch(() => '');

    if (!title) {
      await this.captureDiagnostics('active-chat-title-missing').catch(() => null);
      throw new Error(`Cannot verify active Max chat before sending: ${chat.title}`);
    }

    if (!sameTitle(title, chat.title)) {
      await this.captureDiagnostics('active-chat-title-mismatch').catch(() => null);
      throw new Error(`Active Max chat mismatch: expected "${chat.title}", got "${title}"`);
    }
  }

  async submitComposer() {
    if (!await this.clickSelector(this.selectors.sendButton)) {
      await this.page.keyboard.press('Enter');
    }

    // H2: wait for the composer to clear, which confirms the message was actually
    // queued by the UI. If it never clears within 10 s, throw so the caller can
    // mark the delivery as failed rather than silently recording a missed send.
    try {
      await this.page.waitForFunction(
        (sel) => { const el = document.querySelector(sel); return el && el.textContent.trim().length === 0; },
        { timeout: 10000 },
        this.selectors.composer
      );
    } catch {
      throw new Error('Message send failed: composer did not clear after triggering send (MAX UI may not have accepted the message)');
    }
  }
}

// For comparing a sent text with what the bubble shows: line breaks come back
// as nothing (separate paragraphs), and an emoji may come back with or without
// its U+FE0F variation selector.
const withoutWhitespace = (value) => String(value ?? '').replace(/[\s\uFE0E\uFE0F]+/g, '');

// Same normalisation as domain/reactions.js normalizeEmoji, for comparing with
// what the page renders.
const normalizeEmojiInPage = (emoji) => String(emoji ?? '')
  .replace(/[\uFE0E\uFE0F]/gu, '')
  .replace(/[\u{1F3FB}-\u{1F3FF}]/gu, '')
  .trim();

// A chat in a diagnostic file name: a short hash, not the contact's name —
// /diagnostics uploads these files, names included, to the asking chat.
const chatTag = (chatId) => crypto.createHash('sha256').update(String(chatId ?? '')).digest('hex').slice(0, 8);

// The CDN identity of a MAX media URL (its r= parameter): the same for every
// size of a picture, and across the re-signing of URLs on page loads.
const mediaTokenOf = (url) => {
  const match = /[?&]r=([^&]+)/.exec(url || '');
  return match ? match[1] : null;
};

const normalizeMaxType = (type) => {
  if (Object.values(MessageType).includes(type)) return type;
  return MessageType.TEXT;
};

const countDistinctFrames = (frames) => {
  const seen = new Set();
  for (const frame of frames) {
    seen.add(crypto.createHash('sha1').update(frame).digest('hex'));
  }
  return seen.size;
};

const uniqueMessages = (messages) => {
  const seen = new Map();
  for (const message of messages) {
    const key = message.rawId || [message.author, message.time, message.text, message.mediaUrl].filter(Boolean).join('|');
    if (!seen.has(key)) seen.set(key, message);
  }
  return [...seen.values()];
};


const sameTitle = (actual, expected) => {
  const normalizedActual = normalizeTitle(actual);
  const normalizedExpected = normalizeTitle(expected);
  if (normalizedActual === normalizedExpected) return true;
  return stripActiveChatPrefix(normalizedActual) === normalizedExpected;
};

const normalizeTitle = (value) => String(value || '')
  .replace(/\u00a0/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .toLowerCase();

const stripActiveChatPrefix = (value) => value.replace(
  /^(chat window with|окно чата с|чат с)\s+/,
  ''
);

// A diagnostic dump is a full capture of the live MAX page, so it contains the
// user's private conversations — including messages from people who have no
// idea this bridge exists. These files sit on the VPS disk and can be shipped
// into Telegram via /diagnostics. Debugging them only ever needs the DOM
// STRUCTURE (which elements exist, their tags/classes/aria-labels), never the
// message text, so replace every visible text node with a length marker while
// leaving the markup byte-for-byte intact. <style>/<svg> bodies are left alone:
// they carry no conversation content and mangling them makes the dump harder to
// open. Set DIAGNOSTIC_REDACT_TEXT=false for a one-off deep debug session.
// Attribute values that are MAX's own UI labels rather than user content, and
// that debugging genuinely depends on (they are how the bridge locates the
// composer, the send/reply buttons and the attach menu). Everything else is
// redacted, because attributes also carry personal data — e.g. MAX renders a
// contact's chat header as aria-label="Open <full name>'s profile", which a
// text-node-only pass leaves untouched.
const SAFE_LABEL_VALUES = new Set([
  'Send message', 'Upload file', 'Reply', 'Message actions', 'Open sticker menu',
  'Photo or video', 'File', 'Contact', 'Go back', 'Start call', 'Start video call',
  'Open message search', 'Sticker', 'Start chatting', 'Message',
  'Еще', 'Видео', 'Изменить ширину', 'Скачать', 'качать'
]);

const redactDiagnosticText = (html) => html
  .replace(
    /<(style|svg)\b[\s\S]*?<\/\1\s*>|>([^<>]+)</gi,
    (match, skippedTag, text) => {
      if (skippedTag) return match;
      const trimmed = text.trim();
      if (!trimmed) return match;
      return `>[redacted ${trimmed.length} chars]<`;
    }
  )
  // Redact unknown label-ish attribute values. Default-deny: a label MAX adds
  // later is redacted rather than silently leaking, and its length still shows
  // in the dump (run once with DIAGNOSTIC_REDACT_TEXT=false if the real value
  // is needed to write a new selector). `value` carries typed text (a draft in
  // the composer, a search query).
  .replace(
    /\s(aria-label|title|alt|placeholder|value)\s*=\s*"([^"]*)"/gi,
    (match, attribute, value) => {
      const trimmed = value.trim();
      if (!trimmed || SAFE_LABEL_VALUES.has(trimmed)) return match;
      return ` ${attribute}="[redacted ${trimmed.length} chars]"`;
    }
  )
  // MAX serves media over SIGNED URLs (…/i?r=<token>&expires=…): whoever holds
  // one can fetch that private photo or file. Keep scheme, host and path —
  // enough to see what an element points at — and drop the query everywhere
  // (src, href, srcset, style url(), data-* attributes).
  .replace(/(https?:\/\/[^\s"'<>?#)]+)\?[^\s"'<>#)]*/gi, '$1?[redacted]');

// SVG children are dropped unconditionally — including with redaction turned
// off. MAX renders the sign-in QR as inline SVG paths, so a dump taken on the
// login screen would otherwise carry a working login credential that
// /diagnostics happily uploads into a group chat. The <svg> element itself and
// its attributes survive, which is all selector debugging needs; nothing in
// this project is ever debugged from path geometry.
const stripSvgContents = (html) => html.replace(
  /(<svg\b[^>]*>)([\s\S]*?)(<\/svg\s*>)/gi,
  (match, open, inner, close) => `${open}<!-- ${inner.length} chars of svg content removed -->${close}`
);

export const sanitizeDiagnosticHtml = (html, { redactText = true } = {}) => {
  const withoutScripts = html
    .replace(/<script[\s\S]*?<\/script\s*>/gi, '<!-- script removed -->')
    .replace(/<script[^>]*\/>/gi, '<!-- script removed -->')
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son\w+\s*=\s*'[^']*'/gi, '');
  const withoutSvg = stripSvgContents(withoutScripts);
  return redactText ? redactDiagnosticText(withoutSvg) : withoutSvg;
};
