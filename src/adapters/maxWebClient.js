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
import { listFilesByMtime, safeName, saveBuffer } from '../utils/fileHelpers.js';
import { findNewestCapture, consumeNewestCapture } from '../utils/networkCapture.js';

puppeteer.use(StealthPlugin());

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

export class MaxWebClient {
  constructor(maxConfig, options = {}) {
    this.config = maxConfig;
    this.browser = null;
    this.page = null;
    this.activeChatId = null;
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
        // exposed to the host network or the internet.
        '--remote-debugging-port=9222'
      ]
    });
    this.page = await this.browser.newPage();
    await this.page.setViewport({ width: 1440, height: 980 });
    // MAX serves sticker assets (Lottie JSON) from the HTTP cache, so on repeat
    // displays no `response` fires and we cannot capture the animation. Disable
    // the page cache so every sticker is re-fetched over the network and our
    // interceptor reliably sees the Lottie.
    await this.page.setCacheEnabled(false);

    this.browser.on('disconnected', () => {
      logger.error('Chrome browser disconnected unexpectedly');
      this.onDisconnect?.();
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
        const capturedChatId = this.activeChatId;

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

        if (url.includes('max.ru') && !url.includes('.js') && !url.includes('.css') && !url.includes('.woff') && !url.includes('.svg') && !url.includes('favicon') && !url.includes('/_app/immutable/')) {
          try {
            const buffer = await response.buffer();
            if (buffer.length > 5000 && buffer.length < 500000 && ct.includes('audio')) {
              logger.debug({ url, size: buffer.length, contentType: ct }, 'Potential voice: audio response from max.ru');
            }
          } catch (error) {
            logger.debug({ url, err: error.message }, 'Failed to capture max.ru audio response buffer');
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
    await this.page.waitForSelector(this.selectors.chatList, { timeout: timeoutMs });
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

    const chatItems = await this.page.$$(this.selectors.chatItem);
    const targetNode = chatItems[chat.metadata.index];
    if (!targetNode) throw new Error(`Chat node index not found: ${chat.metadata.index}`);

    await targetNode.evaluate((node) => {
      const btn = node.querySelector('button.cell') || node;
      btn.scrollIntoView({ block: 'center' });
    });
    await targetNode.evaluate((node) => {
      const btn = node.querySelector('button.cell') || node;
      btn.click();
    });

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

    // Wait for message bubbles to render (lazy-loaded after chat opens)
    await this.page.waitForSelector(this.selectors.messageItem, { timeout: 5000 }).catch(() => null);

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
    return this.page.$$eval(selectors.messageItem, (nodes, innerSelectors, docLinkFallbackSelector) => nodes.map((node, index) => {
      // Detect reply quote: present only on reply bubbles as a direct child .link
      const bubbleContent = node.querySelector('.bubbleContent') || node;
      const replyLink = bubbleContent.querySelector(':scope > .link') || node.querySelector('.bubbleContent > .link');

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
        replyToSnippet = snippetEl ? snippetEl.textContent.trim() : '';
        // A reply to media (photo/video/sticker) shows a thumbnail in the quote
        // but no text snippet, so it cannot be matched by text — flag it so the
        // bridge can fall back to matching the most recent media message.
        const replyMediaEl = replyLink.querySelector('img, video');
        replyToHasMedia = Boolean(replyMediaEl || replyLink.querySelector('canvas, [class*="sticker"], [class*="Sticker"]'));
        // Capture the quoted thumbnail's URL so the bridge can match the reply to
        // the original media by its CDN identity instead of guessing by recency.
        replyToMediaUrl = replyMediaEl ? (replyMediaEl.currentSrc || replyMediaEl.src || '') : '';
      }

      // Extract the real message text: the .text that is a direct child of .bubbleContent,
      // NOT the one inside .link (which is the quoted author's name or snippet).
      let textEl = bubbleContent.querySelector(':scope > .text') || bubbleContent.querySelector(':scope > [data-lexical-text]');
      if (replyLink && textEl && replyLink.contains(textEl)) textEl = null;
      const text = (textEl ? textEl.textContent : (node.querySelector(innerSelectors.messageText)?.textContent || '')).trim();

      const author = node.querySelector(innerSelectors.messageAuthor)?.textContent?.trim() || '';
      const timeNode = node.querySelector(innerSelectors.messageTime);
      const time = timeNode?.getAttribute('aria-label') || timeNode?.textContent?.trim() || '';
      // Media/type detection must ignore anything inside the reply quote (.link):
      // a reply to a photo/video/sticker embeds the quoted media's thumbnail,
      // which would otherwise be misdetected as this message's own media and
      // re-sent instead of forwarding the reply text.
      const ownEl = (el) => (el && replyLink && replyLink.contains(el)) ? null : el;
      const imgEl = ownEl(node.querySelector('img'));
      const canvasEl = ownEl(node.querySelector('canvas'));
      const videoEl = ownEl(node.querySelector('video'));
      const sourceEl = ownEl(node.querySelector('source[type="video"], source[type="webm"]'));
      const audioEl = ownEl(node.querySelector('audio'));
      const voiceEl = ownEl(node.querySelector('[class*="voice"], [data-testid*="voice"], [aria-label*="voice"], [aria-label*="Voice"], [class*="audioMessage"], [class*="audio-player"], [class*="attachAudio"], [class*="wave"]'));
      const roundVideoEl = ownEl(node.querySelector('[class*="roundVideo"], [class*="round-video"], [class*="videoNote"], [class*="video-note"], [data-testid*="video-note"], [data-testid*="round-video"], [class*="videoMessage"], [class*="videoCanvas"]'));
      const durationEl = ownEl(node.querySelector('.duration, [class*="duration"]'));
      const hasDuration = durationEl && /^\d{2}:\d{2}$/.test(durationEl.textContent.trim());
      const imageUrl = imgEl?.src || '';
      const audioUrl = audioEl?.src || '';
      const videoUrl = videoEl?.src || sourceEl?.src || '';
      const documentLink = ownEl(node.querySelector(innerSelectors.messageDocument))
        || ownEl(node.querySelector(docLinkFallbackSelector));
      const documentEl = documentLink || ownEl(node.querySelector('[class*="document"], [class*="attachDoc"], [class*="file-info"], [class*="fileName"], [class*="fileIcon"], [data-testid*="document"], [data-testid*="file"], button[aria-label*="качать"]'));
      const documentUrl = documentLink?.href || '';
      const hasDocumentElement = Boolean(documentEl);
      // Try to extract original filename from document bubble
      const fileNameEl = ownEl(node.querySelector('[class*="fileName"], [class*="file-name"], [class*="title"]'));
      const documentFileName = fileNameEl?.textContent?.trim() || '';
      const mediaUrl = imageUrl || audioUrl || videoUrl || documentUrl || '';
      const explicitId = node.getAttribute('data-message-id') || node.getAttribute('data-id') || node.id || '';
      const fallbackId = [author, time, text, mediaUrl].filter(Boolean).join('|');
      const rawId = explicitId || fallbackId || `visible-${index}`;
      const outgoing = Boolean(
        node.closest('[data-outgoing="true"], .outgoing, .message-out')
        || node.closest('[data-bubbles-variant="outgoing"]')
        || node.parentElement?.getAttribute('data-bubbles-variant') === 'outgoing'
      );

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

      return {
        rawId,
        text,
        author,
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
        replyToAuthor,
        replyToSnippet,
        replyToHasMedia,
        replyToMediaUrl,
        replyLinkPresent: Boolean(replyLink),
        _htmlSnippet: node.innerHTML.substring(0, 200)
      };
    }), selectors, DOCUMENT_LINK_FALLBACK_SELECTOR);
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
    const expected = String(sentText ?? '').trim();
    try {
      while (Date.now() < deadline) {
        const rows = await this.scrapeMessageRows();
        const outgoingRows = rows.filter((row) => row.outgoing);
        const last = outgoingRows.at(-1);
        if (last && last.text === expected) {
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
      return !isKnown || !isKnown(id);
    });
    if (hasNewUnresolvedReply) {
      await new Promise((resolve) => setTimeout(resolve, 3500));
      rawMessages = await this.scrapeMessageRows();
    }

    logger.trace({ chatId, rawCount: rawMessages.length, selector: selectors.messageItem }, 'readMessages raw');

    // Disambiguate voice messages that share the same rawId (same time, no text/media).
    // Append #vN suffix so uniqueMessages() doesn't collapse them into one entry.
    const voiceIdCounts = new Map();
    for (const msg of rawMessages) {
      if (msg.outgoing) continue;
      if (!(msg.hasVoiceElement || msg.hasRoundVideoElement || msg.hasDuration)) continue;
      if (msg.rawId.startsWith('visible-')) continue;
      const base = msg.rawId;
      const n = (voiceIdCounts.get(base) || 0) + 1;
      voiceIdCounts.set(base, n);
      if (n > 1) msg.rawId = `${base}#v${n}`;
    }

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
      .filter((message) => !message.outgoing && (message.text || message.mediaUrl || message.type === 'sticker' || message.hasVoiceElement || message.hasRoundVideoElement || message.hasDuration))
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
      await this.captureDiagnostics(`empty-filter-${chatId}`, { throttleMs: 60000 }).catch(() => null);
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
      await this.captureDiagnostics(`sticker-detected-${chatId}`, { throttleMs: 60000 }).catch(() => null);
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
          time: message.time,
          replyToAuthor: message.replyToAuthor || undefined,
          replyToSnippet: message.replyToSnippet || undefined,
          replyToHasMedia: message.replyToHasMedia || undefined,
          replyToMediaUrl: message.replyToMediaUrl || undefined,
          replyLinkPresent: message.replyLinkPresent || undefined
        }
      }));

    for (const msg of messages) {
      if (isKnown && isKnown(msg.id, msg.sourceMessageId)) continue;
      const src = filtered.find((f) => (f._stickerDataUrl || f._needsScreenshot) && stableId('max', this.activeChatId || chatId, f.rawId) === msg.id);
      if (!src) continue;

      let saved = false;
      logger.debug({ chatId, msgId: msg.id, hasDataUrl: Boolean(src._stickerDataUrl), needsScreenshot: Boolean(src._needsScreenshot), stickerIndex: src.stickerIndex, networkCacheSize: this.stickerUrls.size }, 'Sticker capture — starting');

      // Strategy 0a (preferred): render the Lottie JSON captured from the network
      // ourselves with lottie-web (reliable in headless) → PNG frames → the
      // bridge encodes a real animated .webm sticker.
      if (!saved) {
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
            msg.type = 'photo';
            saved = true;
            logger.info({ chatId, stickerPath, size: buffer.length }, 'Sticker SAVED from canvas toDataURL');
          } else {
            logger.debug({ chatId, bufferSize: buffer.length }, 'Sticker canvas toDataURL too small (likely empty canvas)');
          }
        } catch (error) {
          logger.warn({ err: error, chatId }, 'Failed to save sticker canvas');
        }
      }

      if (!saved) {
        const networkSticker = this.findNetworkSticker();
        logger.debug({ chatId, hasNetworkSticker: Boolean(networkSticker), cacheSize: this.stickerUrls.size }, 'Sticker strategy 2: network intercept');
        if (networkSticker) {
          try {
            const ext = (networkSticker.contentType || '').includes('webp') ? 'webp' : 'png';
            const stickerPath = saveBuffer(this.mediaDir, `sticker-${msg.id}-${Date.now()}.${ext}`, networkSticker.buffer);
            msg.mediaPath = stickerPath;
            msg.type = 'photo';
            saved = true;
            logger.info({ chatId, stickerPath, size: networkSticker.buffer.length, url: networkSticker.url }, 'Sticker SAVED from network');
          } catch (error) {
            logger.warn({ err: error, chatId }, 'Failed to save network sticker');
          }
        }
      }

      // NOTE: the old "bubble screenshot" strategy was removed — it captured the
      // chat wallpaper behind an unrendered sticker and sent it as a photo.

      if (!saved && src._needsScreenshot) {
        try {
          const selector = `${selectors.messageItem} canvas`;
          const elements = await this.page.$$(selector);
          const stickerIdx = stickerIndices.indexOf(src.stickerIndex);
          const el = elements[stickerIdx];
          logger.debug({ chatId, hasCanvasEl: Boolean(el), canvasCount: elements.length }, 'Sticker strategy: canvas element screenshot');
          if (el) {
            const screenshotBuffer = await el.screenshot({ type: 'png' });
            if (screenshotBuffer && screenshotBuffer.length > 2000) {
              const stickerPath = saveBuffer(this.mediaDir, `sticker-${msg.id}.png`, screenshotBuffer);
              msg.mediaPath = stickerPath;
              msg.type = 'photo';
              saved = true;
              logger.info({ chatId, stickerPath, size: screenshotBuffer.length }, 'Sticker SAVED via canvas screenshot');
            }
          }
        } catch (error) {
          logger.warn({ err: error, chatId }, 'Failed to screenshot sticker canvas');
        }
      }

      if (!saved) {
        msg.text = '[Sticker]';
        msg.type = 'text';
        logger.info({ chatId, msgId: msg.id }, 'Sticker could not be captured — sent as [Sticker] text');
      }
    }

    // Position of each voice bubble among the NON-OUTGOING voice bubbles in DOM
    // order — exactly how triggerVoiceDownload indexes `voiceNodes` inside the
    // page. This used to be counted inline while walking `messages`, which
    // incremented for every already-known message of ANY type (text, photo…)
    // while skipping unknown non-voice ones, so the counter drifted out of sync
    // with the page: the click landed on a different voice bubble and its audio
    // was saved onto this message, or the index ran past the end and the real
    // voice was silently replaced by the '[Voice message]' placeholder.
    const voiceOrdinalById = new Map();
    let voiceOrdinal = 0;
    for (const row of filtered) {
      if (row.outgoing || !row.hasVoiceElement) continue;
      voiceOrdinalById.set(stableId('max', this.activeChatId || chatId, row.rawId), voiceOrdinal);
      voiceOrdinal += 1;
    }

    for (const msg of messages) {
      if (isKnown && isKnown(msg.id, msg.sourceMessageId)) continue;
      if (msg.mediaPath) continue;
      if (msg.type !== 'text' && msg.type !== 'voice' && msg.type !== 'video_note') continue;

      const src = filtered.find((f) => (f.hasVoiceElement || f.hasRoundVideoElement || f.hasDuration) && stableId('max', this.activeChatId || chatId, f.rawId) === msg.id);
      if (!src) continue;

      const msgIsKnown = isKnown && isKnown(msg.id, msg.sourceMessageId);

      if (src.hasRoundVideoElement || src.type === 'video_note') {
        if (msgIsKnown) continue;
        let networkVideo = this.findNetworkVideo();
        if (!networkVideo) {
          networkVideo = await this.triggerVideoNoteDownload(chatId);
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
            msg.text = '[Video note]';
          }
        } else {
          msg.text = '[Video note]';
        }
      } else if (src.hasVoiceElement || src.type === 'voice') {
        if (msgIsKnown) continue;
        let networkVoice = this.findNetworkVoice();
        if (!networkVoice) {
          // Ordinal comes from the DOM-order map built above, so it always
          // refers to this exact bubble regardless of what else was skipped.
          networkVoice = await this.triggerVoiceDownload(src, chatId, voiceOrdinalById.get(msg.id) ?? 0);
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
            msg.text = '[Voice message]';
          }
        } else {
          msg.text = '[Voice message]';
        }
      }
    }

    // Handle documents (PDFs, etc.)
    // Same DOM-order indexing as voice above: triggerDocumentDownload indexes
    // non-outgoing document bubbles inside the page, so counting inline while
    // walking `messages` (which incremented for known messages of any type)
    // pointed the click at the wrong file — or none — and attached the wrong
    // attachment to this message.
    const docOrdinalById = new Map();
    let docOrdinal = 0;
    for (const row of filtered) {
      if (row.outgoing || !row.hasDocumentElement) continue;
      // triggerDocumentDownload skips voice/round-video bubbles before building
      // its docNodes list, so mirror that here or the ordinals drift apart.
      if (row.hasVoiceElement || row.hasRoundVideoElement) continue;
      docOrdinalById.set(stableId('max', this.activeChatId || chatId, row.rawId), docOrdinal);
      docOrdinal += 1;
    }

    for (const msg of messages) {
      if (isKnown && isKnown(msg.id, msg.sourceMessageId)) continue;
      if (msg.mediaPath) continue;
      if (msg.type !== 'document') continue;

      const msgIsKnown = isKnown && isKnown(msg.id, msg.sourceMessageId);
      if (msgIsKnown) continue;
      const docIndex = docOrdinalById.get(msg.id) ?? 0;

      if (msg.mediaUrl) {
        // Document has a direct download URL — use it
        msg.mediaPath = msg.mediaUrl;
      } else {
        // Need to trigger click to download
        let networkDoc = this.findNetworkDocument();
        if (!networkDoc) {
          networkDoc = await this.triggerDocumentDownload(chatId, docIndex);
        }
        if (networkDoc) {
          try {
            const originalName = networkDoc.originalName || msg.originalFilename || '';
            const ext = originalName ? path.extname(originalName) : this.guessDocExtension(networkDoc.contentType, networkDoc.url);
            const filename = originalName ? safeName(originalName, 200) : `doc-${msg.id}${ext}`;
            const docPath = saveBuffer(this.mediaDir, filename, networkDoc.buffer);
            msg.mediaPath = docPath;
            msg.originalFilename = originalName || filename;
            logger.debug({ chatId, docPath, originalName: msg.originalFilename, size: networkDoc.buffer.length, contentType: networkDoc.contentType }, 'Saved document from network');
          } catch (error) {
            logger.warn({ err: error, chatId }, 'Failed to save network document');
            msg.text = msg.text || '[Document]';
          }
        } else {
          msg.text = msg.text || '[Document]';
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
    const selectors = this.selectors;
    const maxScrollAttempts = 8;
    const mediaTokenPrefix = 'media-token:';
    const mediaToken = fingerprint.startsWith(mediaTokenPrefix) ? fingerprint.slice(mediaTokenPrefix.length) : null;
    for (let attempt = 0; attempt <= maxScrollAttempts; attempt++) {
      const box = await this.page.evaluate((sel, innerSelectors, target, tokenTarget, docLinkFallbackSelector) => {
        const extractToken = (url) => {
          const m = /[?&]r=([^&]+)/.exec(url || '');
          return m ? m[1] : null;
        };
        const nodes = [...document.querySelectorAll(sel)];
        for (let i = nodes.length - 1; i >= 0; i--) {
          const node = nodes[i];
          const bubbleContent = node.querySelector('.bubbleContent') || node;
          const replyLink = bubbleContent.querySelector(':scope > .link') || node.querySelector('.bubbleContent > .link');
          let textEl = bubbleContent.querySelector(':scope > .text') || bubbleContent.querySelector(':scope > [data-lexical-text]');
          if (replyLink && textEl && replyLink.contains(textEl)) textEl = null;
          const text = (textEl ? textEl.textContent : (node.querySelector(innerSelectors.messageText)?.textContent || '')).trim();
          const author = node.querySelector(innerSelectors.messageAuthor)?.textContent?.trim() || '';
          const timeNode = node.querySelector(innerSelectors.messageTime);
          const time = timeNode?.getAttribute('aria-label') || timeNode?.textContent?.trim() || '';
          const ownEl = (el) => (el && replyLink && replyLink.contains(el)) ? null : el;
          const imgEl = ownEl(node.querySelector('img'));
          const audioEl = ownEl(node.querySelector('audio'));
          const videoEl = ownEl(node.querySelector('video'));
          const sourceEl = ownEl(node.querySelector('source[type="video"], source[type="webm"]'));
          const documentLink = ownEl(node.querySelector(innerSelectors.messageDocument))
            || ownEl(node.querySelector(docLinkFallbackSelector));
          const mediaUrl = imgEl?.src || audioEl?.src || videoEl?.src || sourceEl?.src || documentLink?.href || '';

          if (tokenTarget) {
            if (mediaUrl && extractToken(mediaUrl) === tokenTarget) {
              const r = node.getBoundingClientRect();
              return { x: r.x, y: r.y, w: r.width, h: r.height };
            }
            continue;
          }

          const explicitId = node.getAttribute('data-message-id') || node.getAttribute('data-id') || node.id || '';
          const fallbackId = [author, time, text, mediaUrl].filter(Boolean).join('|');
          const rawId = explicitId || fallbackId;
          if (rawId && rawId === target) {
            const r = node.getBoundingClientRect();
            return { x: r.x, y: r.y, w: r.width, h: r.height };
          }
        }
        return null;
      }, selectors.messageItem, selectors, fingerprint, mediaToken, DOCUMENT_LINK_FALLBACK_SELECTOR);

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
    try {
      const box = await this.findAndHoverMessage(fingerprint);
      if (!box) {
        logger.warn({ fingerprint }, 'replyToMessage: target bubble not found');
        return false;
      }
      const candidates = await this.page.$$(this.selectors.messageReplyButton);
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
      await this.page.waitForSelector(this.selectors.composerReplyActive, { timeout: 3000, visible: true });
      return true;
    } catch (error) {
      logger.warn({ err: error, fingerprint }, 'replyToMessage: failed to engage reply mode');
      return false;
    }
  }

  async sendText(chatId, text, replyToFingerprint = null) {
    await this.ensureActiveChat(chatId);
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
      await this.page.waitForSelector(this.selectors.composer, { timeout: 30000 });
      await this.page.focus(this.selectors.composer);
      const typeTimeout = this.config.protocolTimeoutMs || 60000;
      await Promise.race([
        this.page.keyboard.type(text, { delay: 1 }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Typing timeout')), typeTimeout))
      ]);
      await this.submitComposer();
    } catch (error) {
      if (replyToFingerprint) {
        // A throw anywhere after reply mode was engaged would otherwise leave
        // the shared composer stuck in reply-to-X mode forever — there is no
        // other code path that closes the reply banner, so the NEXT message
        // sent (to any chat) would silently become a wrong-target reply.
        // Best-effort cancel; never let a failure here mask the real error.
        try {
          const closeBtn = await this.page.$(this.selectors.composerReplyActive);
          if (closeBtn) await closeBtn.click();
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

  async sendFile(chatId, filePath, caption = '') {
    await this.ensureActiveChat(chatId);

    const absolutePath = path.resolve(filePath);

    // --- Step 1: open the attach menu, pick the option, and accept the file ---
    // MAX's paperclip opens an actions menu; the real file <input> is only wired
    // up after choosing "Photo or video" (images/videos) or "File" (everything
    // else). Setting the input directly does nothing, so we drive the menu.
    const isImageOrVideo = /\.(jpe?g|png|gif|webp|bmp|heic|heif|mp4|webm|mov|m4v|mkv)$/i.test(absolutePath);
    const menuItemSel = isImageOrVideo ? this.selectors.attachMenuMedia : this.selectors.attachMenuFile;
    const attachBtn = await this.page.$(this.selectors.attachButton);
    if (!attachBtn) throw new Error(`sendFile: attach button not found (${this.selectors.attachButton})`);
    await attachBtn.click();
    await this.page.waitForSelector(menuItemSel, { timeout: 10000 });
    const [fileChooser] = await Promise.all([
      this.page.waitForFileChooser({ timeout: 15000 }),
      this.page.click(menuItemSel)
    ]);
    await fileChooser.accept([absolutePath]);
    logger.debug({ chatId, filePath: absolutePath }, 'File accepted via attach menu');

    await this.captureDiagnostics('after-file-accept').catch(() => null);

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
    const sendBtn = await this.page.$(this.selectors.sendButton);
    if (sendBtn) {
      await sendBtn.click();
    } else {
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

    await this.captureDiagnostics('after-send').catch(() => null);

    if (!confirmed) {
      logger.error({ chatId, filePath: absolutePath, outgoingCountBefore, outgoingBubbleSel }, 'sendFile: no new outgoing message bubble detected after send');
      throw new Error(`sendFile: file send not confirmed — no new outgoing bubble appeared (chatId=${chatId}, file=${absolutePath}). Selector may need tuning; check diagnostics.`);
    }

    logger.debug({ chatId, filePath: absolutePath }, 'Sent file');
  }

  async isTyping() {
    await this.ensurePage();
    return Boolean(await this.page.$(this.selectors.typing));
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

  async triggerDocumentDownload(chatId, docIndex = 0) {
    try {
      const docCountBefore = this.documentUrls.size;
      const selectors = this.selectors;

      const clicked = await this.page.$$eval(selectors.messageItem, (nodes, innerArgs) => {
        const docNodes = [];
        for (let i = 0; i < nodes.length; i++) {
          const node = nodes[i];
          if (node.querySelector('.is-outgoing, .outgoing')) continue;
          // Skip voice/video elements
          if (node.querySelector('[class*="attachAudio"], [class*="wave"], [class*="roundVideo"], [class*="videoMessage"]')) continue;
          const docEl = node.querySelector('[class*="fileIcon"], button[aria-label*="качать"], [class*="document"], [class*="attachDoc"], [class*="file-info"], [class*="fileName"], [data-testid*="document"], [data-testid*="file"], a[href][download], a[href*="/file"]');
          if (!docEl) continue;
          docNodes.push({ node, docEl });
        }
        const target = docNodes[innerArgs.docIndex];
        if (!target) return false;
        const downloadBtn = target.node.querySelector('button[aria-label*="качать"], button[aria-label*="Скачать"], a[href][download], a[href*="/file"], a[href*="/download"], button[class*="download"], [class*="download"]');
        if (downloadBtn) {
          downloadBtn.click();
          return true;
        }
        target.docEl.click();
        return true;
      }, { docIndex });

      if (!clicked) {
        logger.debug({ chatId, docIndex }, 'triggerDocumentDownload: no document element found');
        return null;
      }

      logger.debug({ chatId, docIndex }, 'triggerDocumentDownload: clicked, waiting for network response');

      // Track download directory for files that bypass network interception
      const downloadFilesBefore = new Set(fs.readdirSync(this.downloadDir).filter((f) => !f.endsWith('.crdownload')));

      for (let attempt = 0; attempt < 10; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        if (this.documentUrls.size > docCountBefore) {
          const doc = this.findNetworkDocument();
          if (doc) {
            logger.debug({ chatId, size: doc.buffer.length, contentType: doc.contentType }, 'triggerDocumentDownload: captured document from network');
            return doc;
          }
        }
        // Check for new files in download dir (browser download)
        const currentFiles = fs.readdirSync(this.downloadDir).filter((f) => !f.endsWith('.crdownload'));
        const newFiles = currentFiles.filter((f) => !downloadFilesBefore.has(f));
        if (newFiles.length > 0) {
          const originalName = newFiles[0];
          const filePath = path.join(this.downloadDir, originalName);
          const buffer = fs.readFileSync(filePath);
          const ext = path.extname(originalName) || '.bin';
          logger.debug({ chatId, filePath, size: buffer.length, originalName }, 'triggerDocumentDownload: captured document from download dir');
          fs.unlinkSync(filePath);
          return { url: filePath, buffer, timestamp: Date.now(), contentType: `application/${ext.slice(1)}`, originalName };
        }
      }

      logger.debug({ chatId }, 'triggerDocumentDownload: no document captured after click');
      return null;
    } catch (error) {
      logger.warn({ err: error, chatId }, 'triggerDocumentDownload failed');
      return null;
    }
  }

  async triggerVoiceDownload(src, chatId, voiceIndex = 0) {
    try {
      const voiceCountBefore = this.voiceUrls.size;
      const selectors = this.selectors;

      const clicked = await this.page.$$eval(selectors.messageItem, (nodes, innerSrc) => {
        const voiceNodes = [];
        for (let i = 0; i < nodes.length; i++) {
          const node = nodes[i];
          const voiceEl = node.querySelector('[class*="voice"], [data-testid*="voice"], [class*="audioMessage"], [class*="audio-player"], [class*="attachAudio"], [class*="wave"]');
          if (!voiceEl) continue;
          if (node.querySelector('.is-outgoing, .outgoing')) continue;
          voiceNodes.push({ node, voiceEl });
        }
        const target = voiceNodes[innerSrc.voiceIndex];
        if (!target) return false;
        const playBtn = target.node.querySelector('button[class*="play"], button[aria-label*="Play"], button[aria-label*="play"], [class*="playBtn"], [class*="play-btn"], [data-testid*="play"], .play, button');
        if (playBtn) {
          playBtn.click();
          return true;
        }
        target.voiceEl.click();
        return true;
      }, { time: src.time, voiceIndex });

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

  async triggerVideoNoteDownload(chatId) {
    try {
      const videoCountBefore = this.videoUrls.size;
      const selectors = this.selectors;

      const clicked = await this.page.$$eval(selectors.messageItem, (nodes) => {
        for (let i = nodes.length - 1; i >= 0; i--) {
          const node = nodes[i];
          if (node.querySelector('.is-outgoing, .outgoing')) continue;
          const videoMsg = node.querySelector('[class*="videoMessage"], [class*="videoCanvas"], [class*="roundVideo"]');
          if (!videoMsg) continue;
          videoMsg.click();
          return true;
        }
        return false;
      }, selectors);

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
      const scriptPath = path.join(process.cwd(), 'node_modules', 'lottie-web', 'build', 'player', 'lottie.min.js');
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
    await this.browser?.close();
    this.browser = null;
    this.page = null;
    this.activeChatId = null;
    this.clearMediaCaches();
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
    const chat = (await this.listChats()).find((candidate) => candidate.id === chatId);
    if (chat) await this.verifyActiveChat(chat);
  }

  async ensurePage() {
    if (!this.page) throw new Error('Max Web page is not started');
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
    const sendButton = await this.page.$(this.selectors.sendButton);
    if (sendButton) {
      await sendButton.click();
    } else {
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
  // is needed to write a new selector).
  .replace(
    /\s(aria-label|title|alt|placeholder)\s*=\s*"([^"]*)"/gi,
    (match, attribute, value) => {
      const trimmed = value.trim();
      if (!trimmed || SAFE_LABEL_VALUES.has(trimmed)) return match;
      return ` ${attribute}="[redacted ${trimmed.length} chars]"`;
    }
  );

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
