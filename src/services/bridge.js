import path from 'node:path';
import { MessageType, humanMessage } from '../domain/messages.js';
import { logger } from '../logger.js';
import { listFilesByMtime } from '../utils/fileHelpers.js';
import { AsyncLock } from './asyncLock.js';

// Extracts the stable CDN identity token from a MAX media URL
// (e.g. https://i.oneme.ru/i?r=<TOKEN>&fn=w_1280 -> "<TOKEN>"). The same token
// is reused across image sizes, so it links a reply's quoted thumbnail back to
// the original full-size media. Returns null if the URL carries no token.
export function extractMediaToken(url) {
  if (!url || typeof url !== 'string') return null;
  const match = /[?&]r=([^&]+)/.exec(url);
  return match ? match[1] : null;
}

// Hamming distance between two equal-length hex-encoded hashes (e.g. dHashes).
// Returns Infinity for missing or mismatched-length inputs so callers can treat
// it as "no match".
export function hammingHex(a, b) {
  if (!a || !b || a.length !== b.length) return Infinity;
  let dist = 0;
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) { dist += x & 1; x >>= 1; }
  }
  return dist;
}

// Max Hamming distance (out of 64 bits) at which two dHashes are considered the
// same image. Same picture at different sizes is usually 0-6; distinct images
// are typically >20. Kept conservative so a wrong quote is never preferred over
// no quote.
const MEDIA_HASH_MATCH_THRESHOLD = 12;

// Max polls a reply whose quote has not finished loading is held before we give
// up and forward it anyway. A reply-to-media's quoted thumbnail URL loads lazily
// (~seconds after the bubble), and Telegram can't add a reply to an already-sent
// message, so we wait for the quote to populate. Only replies wait — plain
// messages forward immediately. The cap prevents a never-loading quote (e.g. a
// reply to a deleted message) from blocking forwarding forever.
const REPLY_GRACE_SIGHTINGS = 5;

// MAX rotates the login QR about every two minutes (measured on the live login
// screen). Poll a little faster than that so a rotated code reaches Telegram
// while it is still valid, and so a completed scan is noticed promptly.
const LOGIN_POLL_INTERVAL_MS = 4000;
// How long a freshly opened MAX page is given to settle into a recognisable
// state, and how many consecutive sign-in readings are required before the
// owner is bothered with a QR (guards against a mid-render page looking
// signed-out for an instant).
const LOGIN_DETECT_SETTLE_MS = 45000;
const LOGIN_DETECT_CONFIRMATIONS = 3;
// Consecutive poll cycles in which every chat came back unreachable before the
// session itself is questioned. A couple of cycles like that happen normally
// while MAX's virtualized list scrolls; a signed-out page never recovers.
const ZERO_REACHABLE_SESSION_PROBE = 5;
// How long a text we sent into MAX stays recognisable as "ours" when the
// poller reads it back. Long enough to cover a slow render of the outgoing
// marker, short enough that a genuine identical reply minutes later is still
// delivered (see the echo guard in forwardMaxMessage).
const ECHO_GUARD_WINDOW_MS = 20000;
// While waiting to be signed in, remind the owner at most this often — the QR
// photo itself is updated silently in place.
const LOGIN_REMINDER_INTERVAL_MS = 30 * 60 * 1000;
// Consecutive failed QR captures (each ~LOGIN_POLL_INTERVAL_MS apart) after
// which the page is taken for dead — e.g. a crashed renderer, which leaves the
// browser connected — and the browser is relaunched.
const LOGIN_CAPTURE_FAILURES_BEFORE_RELAUNCH = 5;
// Planned browser recycling (see maybeRecycleBrowser). The memory reading walks
// /proc, so it is taken at most once a minute rather than every 650 ms poll.
const BROWSER_MEMORY_CHECK_INTERVAL_MS = 60 * 1000;
// A memory-triggered recycle never fires on a browser younger than this: if a
// FRESH Chromium already sits above the limit (heavy account, limit set too
// low), recycling would only loop every minute and never help.
const BROWSER_RECYCLE_MIN_AGE_MS = 15 * 60 * 1000;
// How long a relaunched MAX page gets to show its chat list while the recycle
// still holds the lock. Telegram sends queued behind the lock then run against
// a usable page rather than a half-painted one.
const BROWSER_RECYCLE_READY_TIMEOUT_MS = 90 * 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const toMb = (bytes) => Math.round(bytes / (1024 * 1024));
// Echo-guard comparison key. Whitespace is dropped: a multi-line message comes
// back from the page without its line breaks.
const echoKey = (text) => String(text ?? '').replace(/\s+/g, '');

// The bot can no longer post in that chat at all (removed, banned, the group
// deleted or turned into another chat) — not a temporary restriction.
const isChatGoneError = (reason) => /kicked|not a member|chat not found|group chat was (deleted|upgraded)|CHANNEL_PRIVATE/i
  .test(String(reason || ''));

// Seconds Telegram asked us to wait (429 Too Many Requests), or 0.
export const telegramRetryAfter = (error) => {
  const code = error?.code ?? error?.response?.error_code;
  if (code !== 429) return 0;
  const seconds = Number(error?.parameters?.retry_after ?? error?.response?.parameters?.retry_after);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 5;
};

// A MAX fingerprint is author|time|text|mediaUrl (empty parts dropped). The
// media URL is signed and regenerated on every page load; everything before it
// is what identifies the bubble across loads.
export const fingerprintWithoutMediaUrl = (sourceMessageId, mediaUrl) => {
  const fingerprint = String(sourceMessageId || '');
  if (mediaUrl && fingerprint.endsWith(`|${mediaUrl}`)) return fingerprint.slice(0, -(mediaUrl.length + 1));
  if (mediaUrl && fingerprint === mediaUrl) return '';
  return fingerprint.replace(/\|(?:https?:|blob:)[^|]*$/, '');
};

export class BridgeService {
  constructor({ db, maxClient, telegramBot, mediaService, config }) {
    this.db = db;
    this.maxClient = maxClient;
    this.telegramBot = telegramBot;
    this.mediaService = mediaService;
    this.config = config;
    this.running = false;
    this.pollTimer = null;
    this.lastChatRefreshAt = 0;
    this.chatCursor = 0;
    this.consecutivePollFailures = 0;
    this.pollCount = 0;
    this.maxLock = new AsyncLock();
    this.topicCreationBlockedReason = null;
    this.missingRouteWarningChatIds = new Set();
    this.startupChatIds = new Set();
    // Chats that have repeatedly failed to open in Max's virtualized list (see
    // the "Max chat not found" handling in pollMax). Excluded from the
    // round-robin fallback in pickChatsForPoll so they stop occupying a poll
    // slot on every pass — otherwise they dilute how often reachable chats get
    // polled. Still gets a fair shot the instant MAX marks it unread again
    // (the unread-priority bucket bypasses this exclusion), and is removed
    // from this set as soon as a read succeeds.
    this.chronicallyUnreachableChatIds = new Set();
    // Rotates the unread-priority bucket in pickChatsForPoll so one busy chat
    // cannot hold the only poll slot forever (see the comment there).
    this.unreadCursor = 0;
    // Tracks consecutive "Max chat not found" failures per chat (keyed
    // `notfound:<chatId>`, see pollMax) leading up to a chat being marked
    // chronically unreachable. Initialized here (not lazily inline) so its
    // lifecycle is easy to reason about alongside chronicallyUnreachableChatIds.
    this._chatNotFoundCounts = new Map();
    // Tracks how many polls a brand-new MAX message has been seen but not yet
    // forwarded — used to give lazily-rendered reply quotes time to appear.
    this.pendingSeenCounts = new Map();
    // Muted MAX chats (/mute): excluded from polling entirely, and anything
    // that still reaches forwardMaxMessage from them is consumed without being
    // sent to Telegram. In-memory mirror of db.listMutedChatIds(); the
    // optional call keeps lightweight test fakes without the method working.
    this.mutedChatIds = new Set(this.db.listMutedChatIds ? this.db.listMutedChatIds() : []);
    // True while the QR sign-in flow owns the MAX page: polling steps aside so
    // it does not spam failures against a logged-out page (and so the failure
    // counter does not trigger a pointless browser restart mid-login).
    this.loginInProgress = false;
    this.loginFlow = null;
    // Distinct from `running`, which is also false during startup: this marks a
    // deliberate shutdown so long-running loops (the QR wait) bail out.
    this.stopping = false;
    // Consecutive poll cycles where every chat was unreachable — the signature
    // of a signed-out session (see pollMax).
    this.zeroReachableStreak = 0;
    // One-shot: do not repeat the "I can't DM you" warning on every retry.
    this.ownerUnreachableWarned = false;
    // Texts just delivered into MAX, per chat — see the echo guard in
    // forwardMaxMessage.
    this.recentSendsToMax = new Map();
    // Planned browser recycling (maybeRecycleBrowser): when the current
    // Chromium was launched, when its memory was last read (and the reading),
    // how many recycles ran, and whether one is running right now.
    this.browserStartedAt = 0;
    this.lastBrowserMemoryCheckAt = 0;
    this.lastBrowserMemory = null;
    this.browserRecycles = 0;
    this.lastBrowserRecycle = null;
    this.browserRecycling = false;
    // Telegram flood control (429): no forwarding before this time.
    this.telegramPausedUntil = 0;
    // A transient createForumTopic failure: no new topic before this time.
    this.topicCreationRetryAt = 0;
  }

  async start() {
    this.restoreIdentity();
    this.bindTelegramHandlers();
    // Telegram comes up FIRST now: on a fresh install it is the channel that
    // carries the pairing code and the MAX sign-in QR, so nothing about MAX can
    // be resolved until the bot can talk to its owner.
    logger.info('Starting Telegram bot');
    await this.telegramBot.start();
    logger.info('Telegram bot started');
    await this.ensureOwner();

    logger.info('Starting Max Web client');
    await this.startMaxClient();
    let signedIn = await this.ensureMaxLogin({ reason: 'startup' });
    // false can also mean "a sign-in is already running": the owner sent
    // /login while the browser was still launching. Giving up here would throw
    // below and exit the process in the middle of that sign-in — wait for it.
    if (!signedIn && this.loginFlow) {
      signedIn = await this.loginFlow.catch(() => false);
    }
    // ensureMaxLogin only returns false when it never recognised the page (it
    // has no timeout otherwise), so waiting for a chat list here would just
    // burn 120s and then kill the process — taking the Telegram bot down with
    // it, right after telling the owner to run /login. Fail loudly instead.
    if (!signedIn && await this.maxSessionState() !== 'ready') {
      throw new Error('MAX Web did not reach a usable state (neither the chat list nor the sign-in screen)');
    }
    // Under the lock: the Telegram bot is already live, so /check could be
    // driving the same page concurrently. Same for everything below that
    // touches the page.
    await this.maxLock.run(() => this.maxClient.waitForReady());
    logger.info('Max Web client ready');
    logger.info('Refreshing MAX chats');
    const startupChats = await this.maxLock.run(() => this.refreshChats({ ensureMappings: false }));
    this.startupChatIds = new Set(startupChats.map((chat) => chat.id));
    // Priming = "mark what MAX already shows as seen, without delivering it".
    // It belongs to a FIRST run only:
    //   * first run, database empty — every visible bubble in every chat is
    //     unknown, so without priming the owner's Telegram is flooded with
    //     hundreds of old messages the moment polling starts;
    //   * any later start — the database already knows the history, and
    //     anything unseen genuinely arrived while the bridge was down, so
    //     priming it would silently swallow real messages (restarts and
    //     browser recycles recur on a schedule, so that window would too).
    if (!this.config.startupPrimeExistingMessages) {
      logger.info('Skipping startup MAX message priming by configuration');
    } else if (this.db.isEmptyOfMessages()) {
      logger.info({ chats: startupChats.length }, 'First run: priming existing MAX history so it is not delivered as new');
      // Priming opens every chat in turn and can take minutes. Without the
      // lock a Telegram send (the bot is already live) verified chat X, then
      // priming clicked chat Y before the text was typed — into Y.
      await this.maxLock.run(() => this.primeExistingMaxMessages(startupChats));
    } else {
      logger.info('Not a first run: skipping priming so messages that arrived while the bridge was down are still delivered');
    }

    const selected = this.db.getSelectedChat() || this.db.listChats()[0];
    if (selected) this.db.selectChat(selected.id);

    this.running = true;
    this.schedulePoll(0);
    logger.info('Bridge started');
  }

  async stop(signal = 'SIGTERM') {
    this.running = false;
    this.stopping = true;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.telegramBot.stop(signal);
    // Drain in-flight browser work before tearing the browser down: during a
    // container restart a TG→MAX send can be mid-flight, and closing the page
    // under it records the delivery as failed even though MAX actually
    // received the message. Polling and new sends are already off (running
    // is false, the bot is stopped), so the queue only shrinks. If a task is
    // wedged, give up after 8s and close anyway — index.js force-exits at 10s.
    const drained = this.maxLock.run(() => {}).catch(() => null);
    await Promise.race([
      drained,
      new Promise((resolve) => {
        const timer = setTimeout(() => {
          logger.warn('maxLock did not drain within 8s during shutdown; closing browser anyway');
          resolve();
        }, 8000);
        if (timer.unref) timer.unref();
      })
    ]);
    await this.maxClient.stop();
    this.db.close();
  }

  bindTelegramHandlers() {
    this.telegramBot.onMessage((message) => this.handleTelegramMessage(message));
    this.telegramBot.onChats(() => this.formatChats());
    this.telegramBot.onSelectChat((arg) => this.selectChat(arg));
    this.telegramBot.onHistory((telegramChatId, telegramThreadId) => this.formatHistory(telegramChatId, telegramThreadId));
    this.telegramBot.onStatus(() => this.formatStatus());
    this.telegramBot.onSync(() => this.syncTopics());
    this.telegramBot.onCheck(() => this.runHealthCheck());
    this.telegramBot.onDiagnostics((telegramChatId, telegramThreadId) => this.sendDiagnostics(telegramChatId, telegramThreadId));
    this.telegramBot.onDeliveries(() => this.formatDeliveries());
    this.telegramBot.onMerge((sourceName, telegramChatId, telegramThreadId) => this.mergeChat(sourceName, telegramChatId, telegramThreadId));
    this.telegramBot.onUnmerge((sourceName) => this.unmergeChat(sourceName));
    this.telegramBot.onMute((chatName) => this.muteChat(chatName));
    this.telegramBot.onUnmute((chatName) => this.unmuteChat(chatName));
    this.telegramBot.onLogin(() => this.requestLogin());
    this.telegramBot.onIdentityDiscovered((identity) => this.persistIdentity(identity));
    this.telegramBot.onRelayLost?.((chatId, reason) => this.handleRelayLost(chatId, reason));
  }

  // Owner and relay group can be discovered at runtime instead of configured;
  // once known they live in the settings table so a container restart does not
  // ask again. Environment variables still win when present — an explicit
  // deployment choice should not be silently overridden by a past discovery.
  restoreIdentity() {
    if (!this.config.telegram.ownerId) {
      const stored = Number(this.db.getSetting('telegram_owner_id', '')) || null;
      if (stored) {
        this.config.telegram.ownerId = stored;
        logger.info({ ownerId: stored }, 'Restored Telegram owner from settings');
      }
    }
    if (!this.config.telegram.relayChatId) {
      const stored = Number(this.db.getSetting('telegram_relay_chat_id', '')) || null;
      if (stored) {
        this.config.telegram.relayChatId = stored;
        logger.info({ relayChatId: stored }, 'Restored Telegram relay group from settings');
      }
    }
  }

  persistIdentity({ ownerId = null, relayChatId = null } = {}) {
    if (ownerId) this.db.setSetting('telegram_owner_id', String(ownerId));
    if (relayChatId) this.db.setSetting('telegram_relay_chat_id', String(relayChatId));
  }

  // The bot was removed from the relay group (or the group is gone). Keeping
  // relayChatId pointed at it dropped every MAX message after 5 failed tries,
  // with the "given up" notices aimed at that same dead group. Fall back to
  // the owner's private chat, where routes are rebuilt on the next message.
  async handleRelayLost(chatId, reason = '') {
    if (!chatId || this.config.telegram.relayChatId !== chatId) return false;
    this.config.telegram.relayChatId = null;
    this.db.setSetting('telegram_relay_chat_id', '');
    this.topicCreationBlockedReason = null;
    logger.warn({ chatId, reason }, 'Relay group is no longer usable — falling back to the owner private chat');
    await this.notifyOwner([
      '⚠️ Группа-релей больше недоступна: меня из неё убрали, или её удалили.',
      'Пока сообщения из MAX приходят сюда, в личку.',
      'Чтобы вернуть группу: добавь меня в группу с Темами админом или отправь /relay в нужной группе.'
    ].join('\n'));
    return true;
  }

  // Launches the browser and opens MAX Web. Deliberately does NOT wait for the
  // chat list: a logged-out profile never shows one, and blocking here is what
  // used to turn a fresh install into a silent restart loop. Callers follow up
  // with ensureMaxLogin() (which drives the QR sign-in) and then waitForReady().
  async startMaxClient() {
    try {
      await this.maxClient.start();
      this.browserStartedAt = Date.now();
      this.lastBrowserMemoryCheckAt = 0;
    } catch (error) {
      await this.maxClient.captureDiagnostics('startup-failed').catch(() => null);
      throw error;
    }
  }

  // Tears the browser down and launches a fresh one on the same profile (the
  // MAX session survives, it lives in the profile). The caller must hold
  // maxLock: both halves drive the page.
  async relaunchMaxClient() {
    await this.maxClient.stop().catch(() => null);
    await this.startMaxClient();
    // The new page has no chat list yet: re-read it on the next poll.
    this.lastChatRefreshAt = 0;
  }

  // Blocks until a Telegram owner is known. With TELEGRAM_OWNER_ID unset (the
  // zero-config path) the bot prints a pairing code and waits for /pair, so a
  // fresh deploy needs no user-id lookups before it can talk to anyone.
  async ensureOwner() {
    if (this.config.telegram.ownerId) return this.config.telegram.ownerId;

    const code = this.telegramBot.startPairing();
    logger.warn({ pairingCode: code }, 'No TELEGRAM_OWNER_ID configured — send "/pair <code>" to the bot in Telegram to claim it');
    let announced = Date.now();
    while (!this.config.telegram.ownerId && !this.stopping) {
      await sleep(2000);
      // Re-announce periodically: the operator may only look at the logs after
      // the container has been up for a while.
      if (Date.now() - announced > 60000) {
        announced = Date.now();
        logger.warn({ pairingCode: code }, 'Still waiting to be claimed — send "/pair <code>" to the bot in Telegram');
      }
    }
    return this.config.telegram.ownerId;
  }

  // Drives MAX Web's QR sign-in entirely through Telegram: no VNC, no shell on
  // the server. Returns true once the session is live.
  //
  // The QR is a live credential — whoever scans it binds a device to the MAX
  // account — so it goes to the owner's PRIVATE chat only (never the relay
  // group, which may have other members) and the message is removed as soon as
  // it is no longer needed.
  async ensureMaxLogin({ reason = 'startup' } = {}) {
    // Single-flight, and the flag is raised BEFORE the multi-second detection
    // phase: polling keeps firing every 650 ms, so anything checking
    // loginInProgress during detection (another failing poll, a second /login)
    // would otherwise start a parallel sign-in and put a SECOND live QR
    // credential in the chat, with each loop clearing the shared flag from
    // under the other.
    if (this.loginInProgress) return false;
    this.loginInProgress = true;
    // Kept so a caller that must not give up (start()) can wait for a flow
    // someone else started — e.g. /login sent while the browser was launching.
    const flow = this.runLoginFlow(reason);
    this.loginFlow = flow;
    try {
      return await flow;
    } finally {
      this.loginInProgress = false;
      this.loginFlow = null;
    }
  }

  async runLoginFlow(reason) {
    // MAX Web takes ~10s to paint, so the first reads of a freshly opened page
    // are meaningless. Wait for it to settle, bail out the moment it turns out
    // to be signed in, and only conclude "sign-in needed" after seeing that
    // screen several times running — a single transient reading must never
    // mail the owner a QR for a session that was actually fine.
    const settleDeadline = Date.now() + LOGIN_DETECT_SETTLE_MS;
    let confirmations = 0;
    while (Date.now() < settleDeadline && !this.stopping) {
      const state = await this.maxSessionState();
      if (state === 'ready') return true;
      confirmations = state === 'login-required' ? confirmations + 1 : 0;
      if (confirmations >= LOGIN_DETECT_CONFIRMATIONS) break;
      await sleep(1500);
    }
    if (confirmations < LOGIN_DETECT_CONFIRMATIONS) {
      logger.warn({ reason }, 'MAX page never settled into a recognisable state; continuing without QR sign-in');
      return false;
    }

    logger.warn({ reason }, 'MAX Web needs a sign-in — delivering QR to Telegram');
    let qrMessageId = null;
    let lastHash = null;
    let delivered = 0;
    let lastReminderAt = 0;
    let failedCaptures = 0;

    const intro = [
      '🔐 Нужен вход в MAX.',
      '',
      'Сейчас пришлю QR-код. Открой MAX на телефоне →',
      'Настройки → Устройства → Подключить устройство → отсканируй код.',
      '',
      '⚠️ Этот QR даёт полный доступ к твоему аккаунту MAX — никому не пересылай.',
      'Код действует около 2 минут: когда он протухает, я обновляю его сам',
      'прямо в этом сообщении — просто открой картинку заново.'
    ].join('\n');

    // There is deliberately NO deadline. Until MAX is signed in the bridge can
    // do nothing at all, so giving up would just mean sitting there silently
    // (and, at startup, crashing the process before the owner could even run
    // /login). Instead the QR is kept fresh indefinitely and the owner is
    // nudged occasionally; stop() ends the loop.
    while (!this.stopping) {
      if (await this.maxSessionState() === 'ready') {
        await this.telegramBot.deleteOwnerMessage(qrMessageId).catch(() => null);
        await this.notifyOwner('✅ MAX подключён — мост запускается.');
        logger.info({ reason, qrCodesDelivered: delivered }, 'MAX Web sign-in completed');
        return true;
      }

      if (Date.now() - lastReminderAt > LOGIN_REMINDER_INTERVAL_MS) {
        lastReminderAt = Date.now();
        await this.notifyOwner(delivered === 0 ? intro : '🔐 Всё ещё жду вход в MAX — код выше обновляется автоматически.');
      }

      // /login during an active wait means "the QR message is gone" — drop the
      // message id so a NEW one is posted, and clear the hash so the current
      // code is delivered again instead of waiting for the next rotation.
      if (this.resendQr) {
        this.resendQr = false;
        qrMessageId = null;
        lastHash = null;
      }

      // The wait is open-ended and polling stands down meanwhile, so nothing
      // else would notice a browser that died under it: every capture would
      // fail forever and the owner's last code would stay dead. (This used to
      // be papered over by the external cron restarting the container.)
      // Relaunch it here and carry on with a fresh page and a fresh code.
      if (!this.stopping && (this.maxClient.isAlive?.() === false || failedCaptures >= LOGIN_CAPTURE_FAILURES_BEFORE_RELAUNCH)) {
        logger.warn({ failedCaptures }, 'MAX browser is gone during the sign-in wait — relaunching it');
        await this.maxLock.run(() => this.relaunchMaxClient()).catch((error) => {
          logger.error({ err: error }, 'Relaunching the MAX browser during sign-in failed; will retry');
        });
        failedCaptures = 0;
        lastHash = null;
      }

      // knownHash lets the capture skip its screenshot + re-encode when the
      // code has not rotated, which is most passes of this open-ended wait.
      const qr = await this.maxLock.run(() => this.maxClient.captureLoginQr({ knownHash: lastHash })).then((result) => {
        failedCaptures = 0;
        return result;
      }, (error) => {
        failedCaptures += 1;
        logger.warn({ err: error?.message || String(error), failedCaptures }, 'QR capture failed; retrying');
        return null;
      });

      if (qr && qr.png && qr.hash !== lastHash) {
        try {
          qrMessageId = await this.telegramBot.sendOwnerQr(qr.png, qrMessageId);
          // Only now: a send that failed must be retried on the next pass
          // rather than skipped until MAX rotates the code ~2 minutes later.
          lastHash = qr.hash;
          delivered += 1;
        } catch (error) {
          // Log the MESSAGE only. Telegraf attaches the whole request payload
          // to its errors, and the payload holds the QR PNG buffer — logging
          // the error object would write the credential into the container
          // logs, which are routinely shared when debugging.
          logger.warn({ err: error?.message || String(error) }, 'Failed to deliver login QR to Telegram');
          await this.warnOwnerUnreachable(error);
        }
      }

      await sleep(LOGIN_POLL_INTERVAL_MS);
    }

    // Shutting down mid-sign-in: take the QR with us rather than leaving a
    // dead-but-scannable-looking code sitting in the chat.
    await this.telegramBot.deleteOwnerMessage(qrMessageId).catch(() => null);
    return false;
  }

  async notifyOwner(text) {
    try {
      await this.telegramBot.sendOwnerText(text);
      return true;
    } catch (error) {
      logger.warn({ err: error?.message || String(error) }, 'Failed to message the owner');
      await this.warnOwnerUnreachable(error);
      return false;
    }
  }

  // A bot cannot open a private chat first: if the owner has only ever talked
  // to it inside the relay group, every owner-directed send fails with 403 and
  // the sign-in would stall in total silence. Say so once, in the group —
  // text only, never the QR itself.
  async warnOwnerUnreachable(error) {
    const message = error?.message || String(error);
    if (!/403|blocked|initiate conversation|chat not found/i.test(message)) return;
    if (this.ownerUnreachableWarned) return;
    this.ownerUnreachableWarned = true;
    await this.telegramBot.sendText(
      '⚠️ Не могу написать владельцу в личку, а QR-код для входа в MAX отправляется только туда. '
      + 'Открой чат с ботом и нажми Start, затем пришли /login.'
    ).catch(() => null);
  }

  // Remembers a text we just delivered into a MAX chat, so the poller can
  // recognise it if it reads that same bubble back before MAX has marked it as
  // ours. Only text: media identity already survives via the perceptual-hash
  // re-forward guard, and matching media by caption would be far too loose.
  rememberSentToMax(chatId, text) {
    const key = echoKey(text);
    if (!chatId || !key) return;
    const pending = this.recentSendsToMax.get(chatId) || [];
    pending.push({ text: key, at: Date.now() });
    this.recentSendsToMax.set(chatId, pending);
  }

  // Drops the record of a send once MAX itself shows that bubble as OUR
  // outgoing message: the poller already skips outgoing bubbles, so the record
  // can then only ever match — and swallow — the contact's own identical reply
  // ("Да", "Ок", "+"), which normally arrives within the guard window.
  forgetSentToMax(chatId, text) {
    const key = echoKey(text);
    const pending = this.recentSendsToMax.get(chatId);
    if (!pending || !key) return;
    const index = pending.findIndex((entry) => entry.text === key);
    if (index >= 0) pending.splice(index, 1);
    if (!pending.length) this.recentSendsToMax.delete(chatId);
  }

  // True when this incoming MAX message is one of ours coming back. Matching
  // entries are removed, and stale ones expire, so this can swallow at most
  // one message per send and only within seconds of it. Only text is guarded:
  // what we record is text we typed, and a photo from the contact that merely
  // carries the same caption is a real message.
  consumeRecentSend(message) {
    const pending = this.recentSendsToMax.get(message.chatId);
    if (!pending || !pending.length) return false;

    const now = Date.now();
    const fresh = pending.filter((entry) => now - entry.at <= ECHO_GUARD_WINDOW_MS);
    const key = message.type === MessageType.TEXT ? echoKey(message.text) : '';
    const index = key ? fresh.findIndex((entry) => entry.text === key) : -1;
    if (index >= 0) fresh.splice(index, 1);

    if (fresh.length) this.recentSendsToMax.set(message.chatId, fresh);
    else this.recentSendsToMax.delete(message.chatId);

    return index >= 0;
  }

  // Session state read under the browser lock (it evaluates in the page).
  async maxSessionState() {
    return this.maxLock.run(() => this.maxClient.getSessionState()).catch(() => 'unknown');
  }

  // /login: re-run the QR flow on demand — e.g. MAX kicked the session and the
  // owner wants to reconnect without touching the server.
  async requestLogin() {
    // Careful with wording: /login may be sent from the relay group, but the QR
    // itself only ever goes to the private chat.
    if (this.loginInProgress) {
      // The documented reason to run /login during a sign-in is "I deleted the
      // QR message". Answering "already running" and doing nothing points the
      // owner at a message that no longer exists — and the flow would not post
      // a new one until MAX rotates the code. Ask the loop for a fresh one.
      this.resendQr = true;
      return 'Сейчас пришлю новый QR-код в личные сообщения.';
    }
    if (await this.maxSessionState() === 'ready') {
      return 'MAX уже подключён. Если что-то не работает, попробуй /check.';
    }
    // Deliberately not awaited: the flow runs for minutes and the command must
    // answer immediately.
    this.ensureMaxLogin({ reason: 'manual' }).catch((error) => {
      logger.error({ err: error }, 'Manual login flow failed');
    });
    return 'Сейчас пришлю QR-код для входа в MAX.';
  }

  schedulePoll(delay = this.config.pollIntervalMs) {
    if (!this.running) return;
    this.pollTimer = setTimeout(() => {
      this.runPollCycle().finally(() => this.schedulePoll());
    }, delay);
  }

  async runPollCycle() {
    // Between two polls nothing is scraping the page, so this is where a
    // planned browser recycle happens (it also takes maxLock, so an in-flight
    // Telegram send finishes first). Its failure is not a poll failure.
    await this.maybeRecycleBrowser().catch((error) => {
      logger.error({ err: error }, 'Planned MAX browser recycle failed');
    });
    if (!this.running) return;
    try {
      await this.pollMax();
      this.consecutivePollFailures = 0;
    } catch (error) {
      this.consecutivePollFailures += 1;
      logger.error({ err: error, failures: this.consecutivePollFailures }, 'Max polling failed');
      this.handlePollFailure(error).catch((failureError) => {
        logger.error({ err: failureError }, 'Poll failure recovery failed');
      });
    }
  }

  // Replaces the external cron that used to `docker compose restart` the whole
  // container every 2 hours. Chromium's memory grows the longer one MAX page
  // stays open (~2 GB in ~3 h, after which sends into MAX start failing while
  // /status still looks fine), so the bridge relaunches the browser itself:
  // once it is older than browserRecycleMinutes, or as soon as its process
  // tree holds more than browserMemoryLimitMb. Unlike the container restart
  // this keeps the Telegram bot online, and it never cuts into a send, a poll
  // or a QR sign-in.
  async maybeRecycleBrowser(now = Date.now()) {
    const due = await this.browserRecycleDue(now);
    if (!due) return false;
    return this.recycleBrowser(due);
  }

  async browserRecycleDue(now = Date.now()) {
    if (!this.running || this.stopping || this.loginInProgress || this.browserRecycling) return null;
    if (!this.browserStartedAt || !this.maxClient.page) return null;

    const ageMs = now - this.browserStartedAt;
    const maxAgeMs = Math.max(0, this.config.browserRecycleMinutes || 0) * 60 * 1000;
    if (maxAgeMs > 0 && ageMs >= maxAgeMs) {
      return { reason: 'age', ageMs, memory: this.lastBrowserMemory };
    }

    const limitBytes = Math.max(0, this.config.browserMemoryLimitMb || 0) * 1024 * 1024;
    if (!limitBytes || typeof this.maxClient.getBrowserMemoryUsage !== 'function') return null;
    if (now - this.lastBrowserMemoryCheckAt < BROWSER_MEMORY_CHECK_INTERVAL_MS) return null;
    this.lastBrowserMemoryCheckAt = now;

    const usage = await this.maxClient.getBrowserMemoryUsage().catch(() => null);
    if (!usage) return null;
    this.lastBrowserMemory = { ...usage, at: now };
    if (usage.bytes < limitBytes) return null;
    if (ageMs < BROWSER_RECYCLE_MIN_AGE_MS) {
      logger.warn(
        { memoryMb: toMb(usage.bytes), limitMb: this.config.browserMemoryLimitMb, ageMin: Math.round(ageMs / 60000) },
        'Chromium is already above MAX_BROWSER_MEMORY_LIMIT_MB shortly after launch — waiting before recycling (is the limit too low?)'
      );
      return null;
    }
    return { reason: 'memory', ageMs, memory: this.lastBrowserMemory };
  }

  async recycleBrowser({ reason = 'manual', ageMs = 0, memory = null } = {}) {
    if (!this.running || this.loginInProgress || this.browserRecycling) return false;
    this.browserRecycling = true;
    let relaunched = false;
    let ready = false;
    try {
      // One lock section from teardown until the new page shows its chat list:
      // a Telegram send queued meanwhile then runs against a usable page, and
      // nothing can drive the page while it is being replaced.
      await this.maxLock.run(async () => {
        // Re-checked under the lock: stop() or a sign-in may have begun while
        // this waited behind an in-flight send.
        if (!this.running || this.loginInProgress) return;
        logger.info(
          { reason, ageMin: Math.round(ageMs / 60000), memoryMb: memory ? toMb(memory.bytes) : null },
          'Recycling the MAX browser to release Chromium memory'
        );
        await this.relaunchMaxClient();
        relaunched = true;
        ready = await this.maxClient.waitForReady(BROWSER_RECYCLE_READY_TIMEOUT_MS).then(() => true, (error) => {
          logger.warn({ err: error }, 'MAX Web did not show the chat list after a planned browser recycle');
          return false;
        });
      });
    } catch (error) {
      this.lastBrowserRecycle = { at: Date.now(), reason, ok: false, error: error?.message || String(error) };
      throw error;
    } finally {
      this.browserRecycling = false;
    }
    if (!relaunched) return false;

    this.browserRecycles += 1;
    this.consecutivePollFailures = 0;
    this.lastBrowserRecycle = { at: Date.now(), reason, ok: ready };
    logger.info({ reason, ready, recycles: this.browserRecycles }, 'MAX browser recycled');
    if (!ready && this.running) {
      // As after a failure restart: the relaunched profile may be signed out,
      // in which case the QR flow takes over (it no-ops on a live session).
      await this.ensureMaxLogin({ reason: 'after-recycle' });
    }
    return true;
  }

  async handlePollFailure(error) {
    // The tail of the final poll can land here while stop() is already
    // draining the lock — recovery (and especially a browser relaunch) must
    // not run during shutdown.
    if (!this.running) return;
    // A sign-in in flight is not a fault to recover from.
    if (this.loginInProgress) return;

    // A dropped MAX session looks exactly like repeated read failures. Check
    // for the sign-in screen before assuming the browser is broken: relaunching
    // Chromium cannot fix a logged-out account, which is how this used to turn
    // into an endless restart loop with «MAX Web was restarted…» every cycle.
    if (await this.maxSessionState() === 'login-required') {
      logger.warn('Polling failures are caused by a signed-out MAX session — starting QR sign-in');
      this.consecutivePollFailures = 0;
      await this.ensureMaxLogin({ reason: 'session-expired' });
      return;
    }
    // Everything here touches the live page (diagnostics capture runs
    // page.content() + screenshot over CDP) or tears the browser down, so the
    // whole recovery is one maxLock section — otherwise it interleaves with a
    // TG→MAX send that is mid-flight on the same page. Note maxLock is NOT
    // reentrant: no nested maxLock.run() inside.
    let restarted = false;
    await this.maxLock.run(async () => {
      if (!this.running) return;
      await this.maxClient.captureDiagnostics(`poll-failure-${this.consecutivePollFailures}`).catch(() => null);

      const url = this.maxClient.page?.url() || '';
      if (url && !url.includes('web.max.ru')) {
        logger.error({ url }, 'Max Web session expired or navigated away');
        this.consecutivePollFailures = this.config.maxPollFailuresBeforeRestart;
      }

      if (this.consecutivePollFailures < this.config.maxPollFailuresBeforeRestart) return;

      logger.warn('Restarting Max browser after repeated polling failures');
      await this.relaunchMaxClient();
      this.consecutivePollFailures = 0;
      restarted = true;
    });
    if (restarted) {
      await this.telegramBot.sendText('MAX Web was restarted after repeated polling failures.').catch(() => null);
      // The relaunched browser may come up on the sign-in screen (the profile's
      // session can expire while the old page was failing). ensureMaxLogin
      // no-ops when the restored session is fine, and takes the lock per step —
      // so it must run OUTSIDE the section above (maxLock is not reentrant).
      await this.ensureMaxLogin({ reason: 'after-restart' });
      // Then let the fresh page finish loading before polling resumes: without
      // this the next poll fires ~650 ms after relaunch against an empty page
      // and starts racking up failures toward another restart. Logged rather
      // than thrown — a page that never becomes ready is handled by the normal
      // failure path on the next cycle.
      await this.maxLock.run(() => this.maxClient.waitForReady())
        .catch((error) => logger.warn({ err: error }, 'Max Web did not become ready after restart'));
    }
  }

  async pollMax() {
    // The QR sign-in flow owns the page while it runs, and a logged-out page
    // has nothing to poll: reading it would only manufacture failures that
    // escalate into a browser restart in the middle of the sign-in.
    if (this.loginInProgress) return;
    await this.maxLock.run(async () => {
      if (Date.now() - this.lastChatRefreshAt > 15000) {
        await this.refreshChats({ ensureMappings: false });
      }

      const chats = this.pickChatsForPoll();
      let failedChats = 0;
      let unreachableChats = 0;
      for (const chat of chats) {
        // Telegram asked us to back off: nothing read now could be forwarded,
        // and everything stays unseen until the window has passed.
        if (this.telegramPaused()) break;
        let messages;
        try {
          messages = await this.maxClient.readMessages(chat.id, {
            // Dedup strictly by the exact message id. We must NOT collapse a
            // disambiguated "#vN" id onto its base id: two distinct media
            // messages sent close together (e.g. two video notes) share the
            // same base rawId, and collapsing would drop all but the first.
            isKnown: (id) => this.db.hasMessage(id)
          });
        } catch (error) {
          // A single chat failing to read (e.g. virtual-scroll chat not yet in
          // DOM, transient "Max chat not found") must not abort the whole poll
          // cycle or bury the other chats. Skip it and retry on the next poll.
          if (error.message && error.message.includes('Max chat not found')) {
            // Chat is off-screen in the virtualized list. Track consecutive failures
            // and mark unreachable to avoid restart loops.
            const key = `notfound:${chat.id}`;
            const count = (this._chatNotFoundCounts.get(key) || 0) + 1;
            this._chatNotFoundCounts.set(key, count);
            if (count >= 3) {
              // Clear unread flag so this chat stops being polled until refreshChats re-discovers it
              this.db.upsertChat({ ...chat, metadata: { ...chat.metadata, unread: false } });
              this._chatNotFoundCounts.delete(key);
              this.chronicallyUnreachableChatIds.add(chat.id);
              logger.warn({ chatId: chat.id, attempts: count }, 'Chat unreachable in virtual scroll, cleared unread flag');
            }
            // A known-unreachable chat (archived / off-screen in the
            // virtualized list) is benign and must NOT count as a poll failure,
            // otherwise one unread archived chat triggers an endless MAX Web
            // restart loop.
            unreachableChats += 1;
            logger.warn({ err: error, chatId: chat.id }, 'Chat unreachable, skipping until next poll');
            continue;
          }
          failedChats += 1;
          logger.warn({ err: error, chatId: chat.id }, 'Failed to read chat, skipping until next poll');
          continue;
        }
        // A successful read means the chat is reachable again (e.g. it scrolled
        // back into the virtualized list) — stop excluding it from round-robin.
        this.chronicallyUnreachableChatIds.delete(chat.id);
        for (const message of messages) {
          // Dedup by exact id only — see the isKnown note above. Collapsing a
          // "#vN" id onto its base id would drop a genuine second media message
          // that shares the same base rawId.
          if (this.db.hasMessage(message.id)) {
            this.pendingSeenCounts.delete(message.id);
            continue;
          }
          // Stop at the first message that cannot go out while Telegram's
          // flood control lasts, so the rest of the chat keeps its order.
          if (this.telegramPaused()) break;
          // Grace for lazily-rendered reply quotes. The .link container and the
          // quoted author render synchronously with the bubble, but a quoted
          // media thumbnail's URL loads ~seconds later. So forward plain messages
          // immediately (no quote to wait for); for a reply, wait until its quote
          // is populated (snippet for text, media URL for media) before
          // forwarding — Telegram can't add a reply after the fact. The same
          // message is re-read next poll with its quote filled in, since it is
          // only inserted into the DB after a successful forward.
          const isReply = Boolean(message.metadata?.replyLinkPresent || message.metadata?.replyToAuthor);
          const replyResolved = Boolean(message.metadata?.replyToSnippet || message.metadata?.replyToMediaUrl);
          const seen = (this.pendingSeenCounts.get(message.id) || 0) + 1;
          if (isReply && !replyResolved && seen < REPLY_GRACE_SIGHTINGS) {
            this.pendingSeenCounts.set(message.id, seen);
            continue;
          }
          this.pendingSeenCounts.delete(message.id);
          const forwarded = await this.forwardMaxMessage(message);
          if (forwarded) {
            // Delivered — mark as seen so it is never forwarded again.
            this.db.insertMessage(message);
          } else if (this.db.countFailedDeliveries(message.id, 'max_to_tg') >= this.config.maxDeliveryAttempts) {
            // Out of retries: stop re-forwarding this message every poll and
            // surface the failure instead of silently dropping or spamming.
            this.db.insertMessage({
              ...message,
              metadata: { ...message.metadata, deliveryFailed: true }
            });
            logger.error(
              { messageId: message.id, chatId: message.chatId, attempts: this.config.maxDeliveryAttempts },
              'Giving up forwarding Max message after max delivery attempts'
            );
            await this.telegramBot.sendText(
              `⚠️ Не удалось доставить сообщение из MAX (чат ${chat.title || message.chatId}) после ${this.config.maxDeliveryAttempts} попыток — пропущено.`
            ).catch((notifyError) => {
              logger.warn({ err: notifyError }, 'Failed to notify Telegram about dropped Max message');
            });
          }
          // Otherwise leave it unseen so the next poll retries it.
        }
      }
      // If every reachable chat failed, this is a real problem (expired session,
      // broken DOM) rather than archived/unreachable chats — surface it so
      // handlePollFailure can capture diagnostics and eventually restart the browser.
      const reachableChats = chats.length - unreachableChats;
      if (reachableChats > 0 && failedChats === reachableChats) {
        throw new Error(`All ${failedChats} polled chats failed to read`);
      }

      // A signed-out MAX page is NOT a poll failure — and that is the trap.
      // The sign-in screen simply has no chat rows, so listChats() returns []
      // and every stored chat raises "Max chat not found", which is counted as
      // unreachable (benign, by design, so one archived chat cannot spin the
      // restart loop). With every chat unreachable, reachableChats is 0, the
      // throw above is skipped and pollMax RESOLVES: the failure counter is
      // reset, handlePollFailure never runs, and the bridge goes quietly deaf
      // forever. Count those all-unreachable cycles so the watchdog below can
      // ask the page what is actually going on.
      this.zeroReachableStreak = (chats.length > 0 && reachableChats === 0)
        ? this.zeroReachableStreak + 1
        : 0;

      if (this.pollCount++ % 100 === 0) {
        this.mediaService.cleanupOlderThan(3600000).catch((error) => {
          logger.warn({ err: error }, 'Failed to cleanup old media files');
        });
      }
    });

    // Outside the lock: ensureMaxLogin acquires it per step and maxLock is not
    // reentrant.
    if (this.zeroReachableStreak >= ZERO_REACHABLE_SESSION_PROBE) {
      this.zeroReachableStreak = 0;
      if (await this.maxSessionState() === 'login-required') {
        logger.warn('Every chat became unreachable because the MAX session is signed out — starting QR sign-in');
        await this.ensureMaxLogin({ reason: 'session-expired' });
      }
    }
  }

  async primeExistingMaxMessages(chats = []) {
    // A cap here is a footgun, not a safety net: every chat left unprimed on a
    // first run dumps its whole visible history into Telegram. Observed on a
    // real account — 30 chats with the cap at 3 would have delivered ~800 old
    // messages. So 0 (or unset) now means "all chats", and a positive value is
    // an explicit, deliberate limit.
    const limit = Math.max(0, this.config.startupPrimeChatsLimit ?? 0);
    const eligible = chats.filter((chat) => this.startupChatIds.has(chat.id));
    const startupChats = limit > 0 ? eligible.slice(0, limit) : eligible;
    if (limit > 0 && eligible.length > limit) {
      logger.warn(
        { limit, chats: eligible.length, unprimed: eligible.length - limit },
        'STARTUP_PRIME_CHATS_LIMIT leaves chats unprimed — their existing history WILL be forwarded to Telegram on the first run'
      );
    }
    if (!startupChats.length) return;

    let primedMessages = 0;
    let primedChats = 0;
    for (const chat of startupChats) {
      try {
        const messages = await this.maxClient.readMessages(chat.id);
        let inserted = 0;
        for (const message of messages) {
          if (this.db.insertMessage({
            ...message,
            metadata: {
              ...message.metadata,
              primedAtStartup: true
            }
          })) inserted += 1;
        }
        if (inserted > 0) {
          primedMessages += inserted;
          primedChats += 1;
        }
      } catch (error) {
        logger.warn({ err: error, chatId: chat.id, title: chat.title }, 'Failed to prime existing MAX messages');
      }
    }

    logger.info({ chats: primedChats, messages: primedMessages }, 'Primed existing MAX messages without forwarding');
  }

  async refreshChats({ ensureMappings = false } = {}) {
    const chats = await this.maxClient.listChats();

    // MAX's chat rows usually carry no stable id attribute, so listChats falls
    // back to the display title as the chat id — which means two chats sharing
    // a name collapse into ONE identity: their messages would be stored under
    // the same chat id and routed into the same Telegram topic, mixing two
    // people's conversations. Changing the id scheme would orphan every
    // existing mapping, so surface the collision loudly instead of silently
    // merging; the fix is to rename one of the chats in MAX.
    const titleCounts = new Map();
    for (const chat of chats) {
      titleCounts.set(chat.id, (titleCounts.get(chat.id) || 0) + 1);
    }
    for (const [chatId, count] of titleCounts) {
      if (count > 1) {
        logger.error(
          { chatId, count },
          'Multiple MAX chats share one identity — their messages will be mixed into a single Telegram topic. Rename one of them in MAX.'
        );
      }
    }

    for (const chat of chats) {
      this.db.upsertChat(chat);
      if (ensureMappings) {
        await this.ensureMapping(chat);
      } else {
        const existing = this.db.getChatMapping(chat.id);
        if (existing) this.db.upsertChatMapping({ ...existing, title: chat.title });
      }
    }

    // Prune chat-health tracking for chats that no longer exist in MAX's own
    // list (e.g. left/deleted chats) so these structures don't grow forever
    // and so a stale entry can't keep excluding a chat id that could later be
    // reused. Safe to do here: this is the one place with the fresh chat list.
    const freshChatIds = new Set(chats.map((chat) => chat.id));
    for (const chatId of this.chronicallyUnreachableChatIds) {
      if (!freshChatIds.has(chatId)) this.chronicallyUnreachableChatIds.delete(chatId);
    }
    for (const key of this._chatNotFoundCounts.keys()) {
      const chatId = key.startsWith('notfound:') ? key.slice('notfound:'.length) : key;
      if (!freshChatIds.has(chatId)) this._chatNotFoundCounts.delete(key);
    }

    this.lastChatRefreshAt = Date.now();
    return chats;
  }

  shouldAutoCreateTopics() {
    return Boolean(
      this.config.telegram.relayChatId
      && this.config.telegram.useTopics
      && this.config.telegram.autoCreateTopics
      && !this.topicCreationBlockedReason
    );
  }

  requiresTelegramTopic() {
    return Boolean(this.config.telegram.relayChatId && this.config.telegram.useTopics);
  }

  pickChatsForPoll() {
    const chats = this.db.listChats();
    if (!chats.length) return [];

    const limit = Math.max(1, this.config.maxChatsPerPoll);
    // Muted chats are a hard exclusion — unlike chronically-unreachable ones
    // they do not even keep a spot in the unread bucket: MAX's ad feeds are
    // "unread" almost permanently and would otherwise burn a poll slot.
    const pollable = chats.filter((chat) => !this.mutedChatIds.has(chat.id));
    if (!pollable.length) return [];
    const unreadAll = pollable.filter((chat) => chat.metadata?.unread);
    // Chats that keep failing to open still deserve an occasional retry (MAX may
    // scroll them back into the virtualized list), but they must not sit at the
    // FRONT of the unread queue: refreshChats rewrites `unread` from live MAX
    // data every ~15s, so a permanently unreachable chat is unread again on
    // every pass and — with the production MAX_CHATS_PER_POLL=1 — would consume
    // the only slot forever while reachable chats are never read.
    const unread = [
      ...unreadAll.filter((chat) => !this.chronicallyUnreachableChatIds.has(chat.id)),
      ...unreadAll.filter((chat) => this.chronicallyUnreachableChatIds.has(chat.id))
    ];

    // Rotate through the unread queue instead of always taking its first
    // `limit` entries. db.listChats() is ordered by recency, so a continuously
    // active chat would otherwise hold the slot on every poll and any other
    // unread chat would never be polled at all — messages sitting in it are
    // simply never forwarded (observed in production as "a message from MAX
    // never arrived in Telegram").
    const picked = new Map();
    for (let i = 0; i < unread.length && picked.size < limit; i++) {
      const chat = unread[(this.unreadCursor + i) % unread.length];
      picked.set(chat.id, chat);
    }
    if (unread.length) {
      this.unreadCursor = (this.unreadCursor + picked.size) % unread.length;
    }

    // Round-robin fallback fills remaining slots from all chats, skipping ones
    // in chronicallyUnreachableChatIds (see pollMax) so they don't occupy a
    // slot on every pass forever. Bounded by maxAttempts so the loop always
    // terminates even if every remaining chat is currently excluded.
    let attempts = 0;
    const maxAttempts = chats.length * 2;
    while (picked.size < limit && picked.size < pollable.length && attempts < maxAttempts) {
      const chat = chats[this.chatCursor % chats.length];
      this.chatCursor += 1;
      attempts += 1;
      // Note: `!picked.has(chat.id)` was previously ANDed into this condition
      // but is a no-op — Map.set on an already-present key just overwrites it
      // with the same chat, so whether the chat is already picked never
      // changes the skip decision (see Fix 9 in the reply-feature review).
      if (this.chronicallyUnreachableChatIds.has(chat.id)) continue;
      if (this.mutedChatIds.has(chat.id)) continue;
      picked.set(chat.id, chat);
    }

    return [...picked.values()];
  }

  // `createTopics` is false only for automatic routing with
  // TELEGRAM_AUTO_CREATE_TOPICS=false; /sync and /select always may create.
  async ensureMapping(chat, { createTopics = true } = {}) {
    const existing = this.db.getChatMapping(chat.id);
    // A route only counts when it points at the CURRENT destination: after
    // /relay moved the bridge (or the relay group was lost), old routes still
    // pointed at the previous group, where the owner's replies are no longer
    // accepted — so the conversation silently became one-way.
    const current = existing && existing.telegramChatId === this.telegramBot.targetChatId();
    if (current && (!this.requiresTelegramTopic() || existing.telegramThreadId)) {
      this.db.upsertChatMapping({ ...existing, title: chat.title });
      const mapping = this.db.getChatMapping(chat.id);
      await this.ensureTopicIntro(chat, mapping);
      return mapping;
    }

    let telegramThreadId = null;
    if (this.requiresTelegramTopic()) {
      if (!createTopics || this.topicCreationBlockedReason) return null;
      if (Date.now() < this.topicCreationRetryAt) return null;
      try {
        telegramThreadId = await this.telegramBot.createTopic(chat.title);
      } catch (error) {
        const reason = error?.message || String(error);
        logger.error({ err: reason, chatId: chat.id, title: chat.title }, 'Failed to create Telegram topic');
        if (/rights|not enough|permission|CHAT_ADMIN_REQUIRED|not a forum|TOPICS?_DISABLED/i.test(reason)) {
          // Only a missing right is worth latching until /sync: the owner has
          // to change group settings first, and retrying just spams errors.
          this.topicCreationBlockedReason = reason;
        } else {
          // A 429 or a network blip used to latch too, blocking every new
          // chat's route until someone happened to run /sync.
          this.topicCreationRetryAt = Date.now() + (telegramRetryAfter(error) || 30) * 1000;
        }
        return null;
      }
    }

    if (this.requiresTelegramTopic() && !telegramThreadId) {
      logger.warn({ chatId: chat.id, title: chat.title }, 'Refusing to create fallback route while Telegram topics are required');
      return null;
    }

    const mapping = {
      maxChatId: chat.id,
      telegramChatId: this.telegramBot.targetChatId(),
      telegramThreadId,
      title: chat.title,
      metadata: {
        createdBy: telegramThreadId ? 'telegram-topic' : 'fallback-chat'
      }
    };
    this.db.upsertChatMapping(mapping);
    const storedMapping = this.db.getChatMapping(chat.id);
    await this.ensureTopicIntro(chat, storedMapping);
    return this.db.getChatMapping(chat.id);
  }

  async ensureTopicIntro(chat, mapping) {
    if (!mapping?.telegramThreadId || !this.requiresTelegramTopic()) return;
    if (mapping.metadata?.topicIntroMessageId) return;

    try {
      const sent = await this.telegramBot.sendPinnedText(this.formatTopicIntro(chat, mapping), mapping);
      this.db.upsertChatMapping({
        ...mapping,
        metadata: {
          ...mapping.metadata,
          topicIntroMessageId: sent.message_id,
          topicIntroPinnedAt: Date.now(),
          topicIntroPinned: Boolean(sent.pinned),
          topicIntroPinError: sent.pinError || null,
          maxChatTitle: chat.title,
          maxChatId: chat.id
        }
      });
    } catch (error) {
      logger.warn({ err: error, chatId: chat.id, threadId: mapping.telegramThreadId }, 'Failed to send or pin Telegram topic intro');
    }
  }

  formatTopicIntro(chat, mapping) {
    return [
      'MAX chat route',
      `Name: ${chat.title}`,
      `MAX chat id: ${chat.id}`,
      `Telegram topic id: ${mapping.telegramThreadId}`,
      '',
      'Messages in this Telegram topic are sent only to this MAX chat.'
    ].join('\n');
  }

  // Best-effort perceptual hash of a forwarded photo, so a later reply to it can
  // be matched by image similarity. Only photos are hashed; failures are
  // swallowed (returns null) — hashing must never block forwarding.
  // Identity for a media bubble that survives MAX regenerating its signed CDN
  // URLs on every page load (the cause of the 53-copies re-forward bug, PR #68).
  // Photos use a perceptual hash so the match still holds if the image is
  // re-encoded; every other media type is byte-identical when re-downloaded, so
  // a content digest is both exact and cheaper. Without this, only photos were
  // protected and voice/video/video notes/documents kept duplicating on every
  // restart. Returns null when no hash is possible (e.g. a sticker frames
  // directory), in which case callers simply skip the guard.
  async computeMediaHash(filePath, type) {
    if (!filePath || type === MessageType.TEXT) return null;
    try {
      if (type === MessageType.PHOTO) return await this.mediaService.imageDHash(filePath);
      return await this.mediaService.fileContentHash(filePath);
    } catch (error) {
      logger.warn({ err: error, filePath, type }, 'Failed to compute media hash');
      return null;
    }
  }

  // Resolves a reply-to-media to its original message by perceptual hash: fetches
  // the quoted thumbnail, hashes it, and returns the closest stored candidate
  // within the match threshold (or null if none is close enough).
  async resolveMediaReplyByHash(chatId, replyMediaUrl) {
    if (!replyMediaUrl) return null;
    const candidates = this.db.getReplyMediaCandidates(chatId);
    if (!candidates.length) return null;
    let thumbHash;
    try {
      const thumbPath = await this.mediaService.downloadUrl(replyMediaUrl, 'reply-thumb');
      thumbHash = await this.mediaService.imageDHash(thumbPath);
    } catch (error) {
      logger.warn({ err: error, replyMediaUrl }, 'Failed to hash reply thumbnail');
      return null;
    }
    let best = null;
    let bestDist = Infinity;
    for (const candidate of candidates) {
      const dist = hammingHex(thumbHash, candidate.mediaHash);
      if (dist < bestDist) {
        bestDist = dist;
        best = candidate;
      }
    }
    logger.info({ chatId, bestDist, threshold: MEDIA_HASH_MATCH_THRESHOLD, candidates: candidates.length }, 'Media reply hash match');
    return bestDist <= MEDIA_HASH_MATCH_THRESHOLD ? best : null;
  }

  async forwardMaxMessage(message) {
    // Echo guard. A message we just sent INTO MAX is read back out of the page
    // moments later, and the only thing stopping it from being delivered back
    // to Telegram is MAX marking its bubble as outgoing. That marking is not
    // instant: with a fast poll interval the bubble can be scraped before it
    // is applied, and the owner gets their own message quoted back at them
    // (observed live: sent at 13:00:03, echoed at 13:00:09).
    //
    // Message identity cannot help here — MAX renders no author and no
    // timestamp we can read, so a message fingerprint is effectively just its
    // text, in a different id namespace from the Telegram side. So match on
    // what we know we just sent, and consume the record on the first hit: a
    // genuine identical reply arriving later is still delivered.
    if (this.consumeRecentSend(message)) {
      logger.info(
        { messageId: message.id, chatId: message.chatId },
        'Skipped our own message read back from MAX (echo of a Telegram send)'
      );
      return true;
    }

    // Muted chat: consume without forwarding. Returning true makes pollMax
    // record the message as seen, so /unmute later does not dump the whole
    // accumulated ad backlog into Telegram. (Normally unreachable — muted
    // chats are not polled — but startup priming and races still land here.)
    if (this.mutedChatIds.has(message.chatId)) {
      logger.debug({ messageId: message.id, chatId: message.chatId }, 'Skipped message from muted chat');
      return true;
    }
    const chat = this.db.listChats().find((item) => item.id === message.chatId) || {
      id: message.chatId,
      title: message.chatId
    };
    const mapping = await this.ensureMapping(chat, { createTopics: this.config.telegram.autoCreateTopics !== false });
    if (!mapping) {
      if (!this.missingRouteWarningChatIds.has(message.chatId)) {
        this.missingRouteWarningChatIds.add(message.chatId);
        logger.warn({ messageId: message.id, chatId: message.chatId }, 'Skipped Max message because no safe Telegram route exists');
      }
      return false;
    }

    const deliveryId = this.db.createDelivery(message.id, 'max_to_tg');

    try {
      const outgoing = { ...message };

      // Resolve reply target: if this MAX message is a reply, find the original
      // stored message and set replyToMessageId so Telegram renders the outgoing
      // message as a quote. Matching order (most to least reliable):
      //   1. quoted text snippet (text replies),
      //   2. quoted media's CDN token vs stored media_url (media, same direction),
      //   3. perceptual hash of the quoted thumbnail vs stored media_hash (any direction),
      //   4. most recent media message in the chat (last-resort fallback).
      let replyToMessageId = null;
      let matchMethod = null;
      const snippet = message.metadata?.replyToSnippet;
      const replyMediaUrl = message.metadata?.replyToMediaUrl;
      let original = snippet ? this.db.findRepliedMessage(message.chatId, snippet) : null;
      if (original) matchMethod = 'snippet';
      if (!original && replyMediaUrl) {
        const token = extractMediaToken(replyMediaUrl);
        original = token ? this.db.findMessageByMediaToken(message.chatId, token) : null;
        if (original) matchMethod = 'token';
      }
      if (!original && replyMediaUrl) {
        original = await this.resolveMediaReplyByHash(message.chatId, replyMediaUrl);
        if (original) matchMethod = 'dhash';
      }
      if (!original && message.metadata?.replyToHasMedia
          && this.db.countRepliedMediaMessages(message.chatId) === 1) {
        // Only quote by recency when there is a single unambiguous media
        // candidate; never guess among several (a wrong quote is worse than none).
        original = this.db.findRepliedMediaMessage(message.chatId);
        if (original) matchMethod = 'recency';
      }
      if (original) {
        replyToMessageId = original.telegramMessageId
          ?? (original.direction === 'tg_to_max' ? (Number(original.sourceMessageId) || null) : null);
      }
      outgoing.replyToMessageId = replyToMessageId;
      // Log reply resolution only for actual replies, to keep the path of plain
      // messages quiet. matchMethod=null here means the quote could not be linked.
      if (snippet || replyMediaUrl || message.metadata?.replyToAuthor || message.metadata?.replyLinkPresent) {
        // Keep the quoted TEXT out of production logs (LOG_LEVEL=info there):
        // it is private conversation content and Docker retains up to 50 MB of
        // these logs on the VPS. The length alone is enough to tell whether a
        // snippet was present and why matching succeeded or failed; the full
        // text is still available at debug level for a deliberate session.
        logger.info(
          {
            messageId: message.id,
            snippetLength: snippet ? snippet.length : 0,
            hasReplyMedia: Boolean(replyMediaUrl),
            matchMethod,
            replyToMessageId
          },
          'REPLY_RESOLVE'
        );
      }

      // The file whose bytes identify this bubble for the re-forward guard —
      // set to the pre-conversion source below, since conversion output is not
      // guaranteed to be reproducible byte-for-byte.
      let sourceForHash = null;

      // Animated stickers are sent as an autoplaying GIF. Telegram accepts a
      // .tgs upload without error but renders MAX's Lottie as a plain document
      // ("Unknown Track"), so the native-sticker path is intentionally not used.
      if (message.type === MessageType.STICKER && message.metadata?.animated && message.mediaPath) {
        // GIF fallback: mediaPath is a directory of captured PNG frames. Telegram
        // autoplays the GIF (no transparency). If encoding fails, degrade to the
        // first frame as a photo rather than dropping the sticker.
        try {
          outgoing.mediaPath = await this.mediaService.framesDirToGif(message.mediaPath, message.metadata.fps);
        } catch (encodeError) {
          logger.warn({ err: encodeError, messageId: message.id }, 'Animated sticker encode failed; sending first frame as photo');
          outgoing.mediaPath = path.join(message.mediaPath, 'frame-000.png');
          outgoing.type = MessageType.PHOTO;
          outgoing.metadata = { ...message.metadata, animated: false };
        }
      } else if (message.mediaUrl) {
        outgoing.mediaPath = await this.mediaService.downloadUrl(message.mediaUrl, `max-${message.type}`);
        // Hash the ORIGINAL download, not the converted output: re-encoding is
        // not guaranteed to be byte-identical run to run, which would break the
        // content-hash identity used by the re-forward guard below.
        sourceForHash = outgoing.mediaPath;
        outgoing.mediaPath = await this.mediaService.ensureTelegramCompatible(outgoing.mediaPath, message.type);
      } else if (message.mediaPath) {
        sourceForHash = message.mediaPath;
        outgoing.mediaPath = await this.mediaService.ensureTelegramCompatible(message.mediaPath, message.type);
      }

      // Hash the forwarded media so (a) a later reply to a photo can be matched
      // by image and (b) the re-forward guard below can recognise this exact
      // bubble again after MAX regenerates its signed URLs.
      message.mediaHash = await this.computeMediaHash(sourceForHash || outgoing.mediaPath, message.type);

      // Re-forward guard. MAX's media URLs are signed and regenerated on every
      // page load, and they are part of a message's content fingerprint, so
      // after a browser/container restart an old photo looks brand new to the
      // id-based dedup in pollMax and gets re-sent (observed: 53 copies of the
      // same photo, one per restart). The image's perceptual hash is stable
      // across those URL changes, so if this chat already forwarded a bubble
      // with the same hash AND the same stable fingerprint prefix (its
      // timestamp/caption), this is that same bubble again — record it as
      // delivered without sending a duplicate to Telegram.
      if (message.mediaHash) {
        // Everything in the fingerprint except the signed media URL. It used
        // to be only the first field — often just the sender's name — so the
        // same sticker or picture sent again later by the same person was
        // swallowed as "already delivered". Only rows from before the current
        // page load count: signed URLs change only across page loads.
        const fingerprintPrefix = fingerprintWithoutMediaUrl(message.sourceMessageId, message.mediaUrl);
        if (this.db.hasForwardedMediaCopy(message.chatId, message.mediaHash, fingerprintPrefix, this.browserStartedAt || undefined)) {
          this.db.updateDeliveryStatus(deliveryId, 'sent');
          logger.info(
            { messageId: message.id, chatId: message.chatId, mediaHash: message.mediaHash },
            'Skipped re-forward of already-delivered media (stale signed URL produced a new id)'
          );
          return true;
        }
      }

      const sent = await this.telegramBot.sendMessage(outgoing, mapping);
      // Persist the Telegram message_id on the original message object so that
      // the subsequent insertMessage call (in pollMax) stores it in the DB.
      // This enables future reply-linking features via getMessageByTelegramMessageId.
      message.telegramMessageId = sent?.message_id ?? null;
      this.db.updateDeliveryStatus(deliveryId, 'sent');
      logger.info({ messageId: message.id, type: message.type, chatId: message.chatId }, 'Forwarded Max message to Telegram');
      return true;
    } catch (error) {
      const retryAfter = telegramRetryAfter(error);
      if (retryAfter) {
        // Flood control is not a failure of THIS message. Counted as one, the
        // 5 attempts burned out within seconds while Telegram was asking for
        // 30+ (a whole relay group shares ~20 messages a minute), and the
        // burst was dropped for good. Pause forwarding for the window
        // instead; the message stays unseen and is retried, in order.
        this.telegramPausedUntil = Math.max(this.telegramPausedUntil, Date.now() + retryAfter * 1000);
        this.db.updateDeliveryStatus(deliveryId, 'pending', `rate limited: retry after ${retryAfter}s`);
        logger.warn({ messageId: message.id, chatId: message.chatId, retryAfter }, 'Telegram flood control — pausing forwarding');
        return false;
      }
      const reason = error?.message || String(error);
      if (mapping.telegramThreadId && /thread not found|TOPIC_DELETED/i.test(reason)) {
        // The topic was deleted in Telegram. Every later message used to fail
        // 5 times and be dropped, and /sync could not help (the route still
        // "had" a topic). Forget it; the next attempt creates a fresh one.
        this.db.clearChatMappingThread(message.chatId);
        this.db.updateDeliveryStatus(deliveryId, 'pending', 'topic deleted, recreating');
        logger.warn({ chatId: message.chatId, threadId: mapping.telegramThreadId }, 'Telegram topic was deleted — a new one will be created');
        return false;
      }
      if (mapping.telegramChatId === this.config.telegram.relayChatId && isChatGoneError(reason)) {
        // Kicked from (or no longer able to post in) the relay group: fall
        // back to the owner's private chat instead of dropping everything.
        this.db.updateDeliveryStatus(deliveryId, 'pending', reason);
        await this.handleRelayLost(mapping.telegramChatId, reason);
        return false;
      }
      this.db.updateDeliveryStatus(deliveryId, 'failed', error.message);
      logger.error({ err: error, messageId: message.id, chatId: message.chatId }, 'Failed to forward Max message to Telegram');
      return false;
    }
  }

  telegramPaused(now = Date.now()) {
    return now < this.telegramPausedUntil;
  }

  async handleTelegramMessage(message) {
    // The bot now comes online BEFORE the MAX page is usable (it has to — it
    // carries the sign-in QR), so a message can land while MAX is still
    // starting or waiting to be scanned. Sending it would throw deep in
    // Puppeteer and burn the message as a failed delivery with no retry path,
    // so say plainly that it was not sent and let the user resend. A planned
    // browser recycle is different: it holds maxLock until the new page is
    // usable, so the send below simply waits for it instead of being refused.
    if (this.loginInProgress || (!this.maxClient.page && !this.browserRecycling)) {
      await this.telegramBot.sendText(
        '⏳ MAX ещё не подключён — сообщение НЕ отправлено. Пришли его снова, когда придёт «✅ MAX подключён».',
        {
          telegramChatId: message.metadata.telegramChatId,
          telegramThreadId: message.metadata.telegramThreadId
        }
      ).catch(() => null);
      return;
    }

    const mapping = this.resolveTelegramMapping(message);
    if (!mapping) {
      await this.telegramBot.sendText(
        'This Telegram topic is not linked to a MAX chat. Run /sync in the relay group or use /chats.',
        {
          telegramChatId: message.metadata.telegramChatId,
          telegramThreadId: message.metadata.telegramThreadId
        }
      );
      return;
    }

    const enriched = { ...message, chatId: mapping.maxChatId };
    if (this.db.hasMessage(enriched.id)) return;

    const deliveryId = this.db.createDelivery(enriched.id, 'tg_to_max');
    let captionError = null;

    try {
      await this.maxLock.run(async () => {
        if (enriched.type === MessageType.TEXT) {
          const replyToFingerprint = this.resolveMaxReplyTarget(enriched);
          await this.maxClient.sendText(mapping.maxChatId, enriched.text, replyToFingerprint);
          // Note it BEFORE anything else can await: the poller runs every few
          // hundred milliseconds and may reach this chat while the lines below
          // are still running.
          this.rememberSentToMax(mapping.maxChatId, enriched.text);
          // Capture our own outgoing bubble's fingerprint (v2) so a later
          // Telegram reply to THIS message can find and quote it inside Max.
          // Passing the sent text lets getLastOutgoingFingerprint verify it
          // captured THIS message rather than a previous outgoing one that
          // was still the last row when a slow render raced the fixed sleep
          // (see Fix 2 in the reply-feature review).
          enriched.maxFingerprint = await this.maxClient.getLastOutgoingFingerprint(mapping.maxChatId, enriched.text).catch(() => null);
          // A fingerprint means MAX already renders the bubble as outgoing,
          // which the poller skips by itself: the echo record is no longer
          // needed and would only swallow an identical reply from the contact.
          if (enriched.maxFingerprint) this.forgetSentToMax(mapping.maxChatId, enriched.text);
        } else {
          const filePath = await this.mediaService.ensureMaxCompatible(enriched.mediaPath, enriched.type);
          await this.maxClient.sendFile(mapping.maxChatId, filePath);
          enriched.mediaPath = filePath;
          // Hash the media we just sent into MAX so a reply to it can be matched.
          enriched.mediaHash = await this.computeMediaHash(filePath, enriched.type);
          // The attach flow has no caption field the bridge fills in, and the
          // caption used to be dropped without a trace. It follows as its own
          // message instead. The file is already in MAX by now, so a failure
          // here must not mark the delivery failed (the owner would resend the
          // file) — it is reported separately below.
          if (enriched.text?.trim()) {
            try {
              await this.maxClient.sendText(mapping.maxChatId, enriched.text);
              this.rememberSentToMax(mapping.maxChatId, enriched.text);
              const captionFingerprint = await this.maxClient.getLastOutgoingFingerprint(mapping.maxChatId, enriched.text).catch(() => null);
              if (captionFingerprint) this.forgetSentToMax(mapping.maxChatId, enriched.text);
            } catch (error) {
              captionError = error;
            }
          }
        }
      });

      this.db.insertMessage(enriched);
      this.db.updateDeliveryStatus(deliveryId, 'sent');
      logger.info({ messageId: enriched.id, type: enriched.type, chatId: mapping.maxChatId }, 'Forwarded Telegram message to Max');
      if (captionError) {
        logger.warn({ err: captionError, messageId: enriched.id, chatId: mapping.maxChatId }, 'File sent to MAX but its caption was not');
        await this.telegramBot.sendText(
          `⚠️ Файл ушёл в MAX, а подпись к нему — нет: ${captionError.message}`,
          {
            telegramChatId: message.metadata.telegramChatId,
            telegramThreadId: message.metadata.telegramThreadId
          }
        ).catch(() => null);
      }
    } catch (error) {
      this.db.updateDeliveryStatus(deliveryId, 'failed', error.message);
      logger.error({ err: error, messageId: enriched.id, chatId: mapping.maxChatId }, 'Failed to forward Telegram message to Max');
      await this.telegramBot.sendText(
        `⚠️ Failed to send to MAX: ${error.message}`,
        {
          telegramChatId: message.metadata.telegramChatId,
          telegramThreadId: message.metadata.telegramThreadId
        }
      ).catch((notifyError) => {
        logger.warn({ err: notifyError }, 'Failed to notify Telegram user about forwarding failure');
      });
    }
  }

  // Telegram→MAX replies: if this Telegram message replies to one the bridge
  // previously forwarded FROM Max, resolve it back to the MAX-side bubble
  // fingerprint (sourceMessageId, captured by readMessages — see scrapeRaw in
  // maxWebClient.js) so maxClient.sendText can re-locate that exact bubble and
  // trigger MAX's own Reply UI on it.
  //
  // Three-way resolution, most to least direct:
  //   1. Text originals from MAX (direction === 'max_to_tg', type === text):
  //      quote by the stored sourceMessageId fingerprint directly.
  //   2. Media originals from MAX: the sourceMessageId fingerprint embeds the
  //      exact media URL at read time, which MAX may rotate/expire — instead
  //      quote by the stable `media-token:<CDN r-token>` extracted from the
  //      stored mediaUrl (see extractMediaToken).
  //   3. Replies to the user's own previously-sent MAX messages (typed in
  //      Telegram and sent into Max, direction === 'tg_to_max'): quote by the
  //      MAX-side fingerprint captured right after sending and stored as
  //      max_fingerprint (see handleTelegramMessage / getLastOutgoingFingerprint).
  //      Text only — a MAX-side fingerprint is not captured for media sends.
  // Every branch is guarded against the unstable 'visible-N' index-based
  // fallback id (unmatchable — see maxWebClient.js scrapeMessageRows), and
  // returns null (send as a plain message, no quote) when not resolvable —
  // mirrors the conservative "no quote is better than a wrong one" policy
  // already used for Max→Telegram reply matching.
  resolveMaxReplyTarget(message) {
    const replyToTelegramMessageId = message.metadata?.replyToTelegramMessageId;
    if (!replyToTelegramMessageId) return null;

    const original = this.db.getMessageByTelegramMessageId(replyToTelegramMessageId);
    if (!original || original.direction !== 'max_to_tg') {
      // Not something the bridge forwarded FROM Max. Check the other case
      // (v2): replying to one of the user's own earlier messages that was
      // typed in Telegram and sent into Max — text only, since we only
      // capture a MAX-side fingerprint for those (see handleTelegramMessage).
      const ownSent = this.db.getTgToMaxMessageBySourceId(replyToTelegramMessageId);
      if (ownSent && ownSent.type === MessageType.TEXT && ownSent.maxFingerprint
          && !ownSent.maxFingerprint.startsWith('visible-')) {
        return ownSent.maxFingerprint;
      }
      return null;
    }
    if (original.type === MessageType.TEXT) {
      if (!original.sourceMessageId || original.sourceMessageId.startsWith('visible-')) return null;
      return original.sourceMessageId;
    }
    // Media original (v2): the sourceMessageId fingerprint embeds the exact
    // media URL at read time, which is unreliable to re-match later — MAX
    // lazy-loads bubble images, so the src may have swapped resolution
    // (fn=w_180 -> fn=w_1280) by the time we search the live DOM again (the
    // same lazy-load quirk that affects reply-quote thumbnails). Instead,
    // match by the stable CDN identity token only (see extractMediaToken /
    // the MAX->Telegram media-reply matcher, which established that r=<token>
    // is reused across sizes for the same media). Any media type qualifies as
    // long as its URL carries a token — no type allowlist needed.
    const token = original.mediaUrl ? extractMediaToken(original.mediaUrl) : null;
    return token ? `media-token:${token}` : null;
  }

  resolveTelegramMapping(message) {
    const telegramChatId = message.metadata.telegramChatId;
    const telegramThreadId = message.metadata.telegramThreadId || null;
    if (this.config.telegram.relayChatId && this.config.telegram.useTopics) {
      if (!telegramThreadId) return null;
      return this.db.getChatMappingByTelegramThread(telegramChatId, telegramThreadId);
    }

    // No topics: every MAX chat is delivered into the same Telegram chat with
    // no thread, so every mapping shares (chat, no thread) and a lookup by
    // thread would return whichever chat happened to be inserted first. What
    // the owner means is, in order: the chat of the message they replied to,
    // else the chat picked with /select.
    const repliedTo = this.fallbackReplyTarget(message);
    const target = repliedTo || this.db.getSelectedChat();
    return target ? {
      maxChatId: target.id,
      telegramChatId: this.telegramBot.targetChatId(),
      telegramThreadId: null,
      title: target.title
    } : null;
  }

  // The MAX chat a Telegram reply points back to: the chat a forwarded MAX
  // message came from, or the one an earlier Telegram message was sent into.
  fallbackReplyTarget(message) {
    const replyToTelegramMessageId = message.metadata?.replyToTelegramMessageId;
    if (!replyToTelegramMessageId) return null;
    const original = this.db.getMessageByTelegramMessageId(replyToTelegramMessageId)
      || this.db.getTgToMaxMessageBySourceId(replyToTelegramMessageId);
    if (!original?.chatId) return null;
    return this.db.listChats().find((chat) => chat.id === original.chatId) || null;
  }

  async syncTopics() {
    this.topicCreationBlockedReason = null;
    this.topicCreationRetryAt = 0;
    const chats = await this.maxLock.run(() => this.refreshChats({ ensureMappings: true }));
    const mappings = this.db.listChatMappings();
    const validMappings = mappings.filter((mapping) => mapping.telegramThreadId);
    const pendingMappings = mappings.length - validMappings.length;
    return [
      `Synced MAX chats: ${chats.length}`,
      `Telegram routes: ${validMappings.length}`,
      this.requiresTelegramTopic() ? `Pending topics: ${pendingMappings}` : null,
      this.config.telegram.relayChatId && this.config.telegram.useTopics
        ? 'Mode: Telegram topics'
        : 'Mode: fallback single chat',
      // Without this the answer to a failed /sync was just "routes: 0,
      // pending: 5" — the bridge knew exactly why and kept it to itself,
      // leaving the owner to guess or go read container logs.
      ...this.topicCreationFailureLines()
    ].filter(Boolean).join('\n');
  }

  // Explains a latched topic-creation failure in the chat that asked, and
  // translates the one Telegram error that is actually actionable.
  topicCreationFailureLines() {
    const reason = this.topicCreationBlockedReason;
    if (!reason) return [];
    const lines = ['', `⚠️ Темы не создаются: ${reason}`];
    if (/rights|permission|not enough/i.test(reason)) {
      lines.push(
        'Боту не хватает права «Управление темами» (Manage Topics).',
        'Группа → Администраторы → выбери бота → включи это право → повтори /sync.'
      );
    }
    return lines;
  }

  async formatChats() {
    const chats = await this.maxLock.run(() => this.refreshChats({ ensureMappings: false }));
    if (!chats.length) return 'No Max chats found.';

    const mappings = new Map(this.db.listChatMappings().map((mapping) => [mapping.maxChatId, mapping]));
    return chats.map((chat, index) => {
      const marker = chat.selected ? '*' : ' ';
      const mapped = mappings.has(chat.id) ? 'topic' : 'not linked';
      const unread = chat.metadata?.unread ? ' unread' : '';
      const muted = this.mutedChatIds.has(chat.id) ? ' 🔇 muted' : '';
      return `${marker} ${index + 1}. ${chat.title} (${mapped}${unread}${muted})`;
    }).join('\n');
  }

  async selectChat(arg) {
    const chats = this.db.listChats();
    const index = Number.parseInt(arg, 10) - 1;
    const chat = Number.isInteger(index) && index >= 0 ? chats[index] : chats.find((item) => item.id === arg);
    if (!chat) return `Chat not found: ${arg}`;

    await this.maxLock.run(() => this.maxClient.selectChat(chat.id));
    this.db.selectChat(chat.id);
    await this.ensureMapping(chat);
    return `Selected fallback chat: ${chat.title}`;
  }

  async formatHistory(telegramChatId, telegramThreadId) {
    // Only a topic identifies a chat; without topics every mapping shares the
    // same (chat, no thread) and a lookup would pick an arbitrary one.
    const topicsInUse = Boolean(this.config.telegram.relayChatId && this.config.telegram.useTopics);
    const mapping = telegramChatId && topicsInUse && telegramThreadId
      ? this.db.getChatMappingByTelegramThread(telegramChatId, telegramThreadId)
      : null;
    const selected = mapping
      ? this.db.listChats().find((chat) => chat.id === mapping.maxChatId)
      : this.db.getSelectedChat();

    if (!selected) return 'No linked or selected MAX chat.';
    const messages = this.db.recentMessages(selected.id, this.config.historyLimit);
    if (!messages.length) return `No stored history for ${selected.title}.`;
    // Telegram caps a message at 4096 characters; keep the NEWEST lines, which
    // are the ones /history is asked for.
    return messages.map(humanMessage).join('\n').slice(-3900);
  }

  formatDeliveries() {
    const stats = this.db.getDeliveryStats();
    const failed = this.db.getFailedDeliveries(5);

    const lines = ['📊 Delivery Stats:'];
    for (const stat of stats) {
      const emoji = stat.status === 'sent' ? '✅' : stat.status === 'failed' ? '❌' : '⏳';
      lines.push(`${emoji} ${stat.status}: ${stat.count}`);
    }

    if (failed.length) {
      lines.push('', '❌ Recent failures:');
      for (const f of failed) {
        const time = new Date(f.updated_at).toLocaleString();
        lines.push(`  ${time} [${f.direction}] ${f.last_error || 'unknown error'}`);
      }
    }

    return lines.join('\n');
  }

  mergeChat(sourceName, telegramChatId, telegramThreadId) {
    if (!telegramThreadId) {
      return '⚠️ Команду /merge нужно отправлять внутри топика, куда перенаправить сообщения.';
    }

    // Find the source mapping (the one being merged away)
    const sourceMapping = this.db.getChatMapping(sourceName);
    if (!sourceMapping) {
      return `⚠️ Чат «${sourceName}» не найден в маппингах. Проверьте /chats для списка доступных чатов.`;
    }

    // Find the target mapping (the topic where the command was sent)
    const targetMapping = this.db.getChatMappingByTelegramThread(telegramChatId, telegramThreadId);
    if (!targetMapping) {
      return '⚠️ Не найден маппинг для текущего топика. Убедитесь, что этот топик привязан к чату Max.';
    }

    if (sourceMapping.maxChatId === targetMapping.maxChatId) {
      return '⚠️ Нельзя объединить чат сам с собой.';
    }

    // Redirect source to the target's thread
    this.db.upsertChatMapping({
      maxChatId: sourceMapping.maxChatId,
      telegramChatId: targetMapping.telegramChatId,
      telegramThreadId: targetMapping.telegramThreadId,
      title: sourceMapping.title,
      enabled: true,
      metadata: {
        ...sourceMapping.metadata,
        originalThreadId: sourceMapping.telegramThreadId,
        mergedInto: targetMapping.maxChatId,
        mergedAt: Date.now()
      }
    });

    logger.info({
      source: sourceMapping.maxChatId,
      target: targetMapping.maxChatId,
      targetThread: targetMapping.telegramThreadId
    }, 'Chat merged');

    return `✅ Чат «${sourceName}» объединён → сообщения теперь приходят в этот топик (${targetMapping.title}).`;
  }

  unmergeChat(sourceName) {
    const mapping = this.db.getChatMapping(sourceName);
    if (!mapping) {
      return `⚠️ Чат «${sourceName}» не найден в маппингах.`;
    }

    if (!mapping.metadata?.mergedInto) {
      return `⚠️ Чат «${sourceName}» не является объединённым.`;
    }

    const originalThread = mapping.metadata.originalThreadId;
    if (!originalThread) {
      return `⚠️ У чата «${sourceName}» нет сохранённого оригинального топика. Используйте /sync для пересоздания.`;
    }

    this.db.upsertChatMapping({
      maxChatId: mapping.maxChatId,
      telegramChatId: mapping.telegramChatId,
      telegramThreadId: originalThread,
      title: mapping.title,
      enabled: true,
      metadata: {
        ...mapping.metadata,
        mergedInto: undefined,
        mergedAt: undefined,
        unmergedAt: Date.now()
      }
    });

    logger.info({ source: mapping.maxChatId, restoredThread: originalThread }, 'Chat unmerged');
    return `✅ Чат «${sourceName}» отсоединён — сообщения снова идут в его оригинальный топик.`;
  }

  // /mute <name>: stop forwarding a MAX chat (service/ad feeds like
  // «Интересное для вас»). Chat ids ARE their titles in this system, so the
  // name resolves directly; a chat not currently in the list can still be
  // muted ahead of time if MAX re-creates it later.
  async muteChat(chatName) {
    const known = this.db.listChats().find((chat) => chat.id === chatName || chat.title === chatName);
    const target = known?.id || chatName;
    if (this.mutedChatIds.has(target)) {
      return `Чат «${target}» уже заглушён.`;
    }
    this.db.setChatMuted(target, true);
    this.mutedChatIds.add(target);
    await this.markTopicMuted(target, true);
    logger.info({ chatId: target, knownChat: Boolean(known) }, 'Chat muted');
    const suffix = known ? '' : '\n(Чата с таким именем сейчас нет в списке — правило сработает, как только он появится. Проверьте написание: /chats)';
    return `🔇 Чат «${target}» заглушён — его сообщения больше не пересылаются в Telegram.\nВернуть: /unmute ${target}${suffix}`;
  }

  // Renames the chat's Telegram topic to «🔇 <title>» (or back) so the muted
  // state is visible in Telegram's own topic list, not only in /chats.
  // mapping.title always stores the CLEAN MAX title (the prefix lives only in
  // Telegram), so restoring is a plain rename to mapping.title. Best-effort:
  // a missing topic or missing rights must not fail the mute itself.
  async markTopicMuted(chatId, muted) {
    const mapping = this.db.getChatMapping(chatId);
    if (!mapping?.telegramThreadId) return false;
    const title = muted ? `🔇 ${mapping.title}` : mapping.title;
    try {
      return await this.telegramBot.renameTopic(mapping.telegramThreadId, title);
    } catch (error) {
      logger.warn({ err: error, chatId, threadId: mapping.telegramThreadId }, 'Failed to rename Telegram topic for mute state');
      return false;
    }
  }

  async unmuteChat(chatName) {
    const known = this.db.listChats().find((chat) => chat.id === chatName || chat.title === chatName);
    const target = known?.id || chatName;
    if (!this.mutedChatIds.has(target)) {
      return `Чат «${target}» не был заглушён. Заглушённые чаты помечены 🔇 в /chats.`;
    }
    // While muted the chat was not polled, so everything visible in it is
    // "new" to the db and would be dumped into Telegram wholesale on the next
    // poll. Prime it first (same trick as startup): mark the current backlog
    // as seen without forwarding, so only genuinely new messages flow.
    // Best-effort — an unreachable chat just skips the priming.
    let primed = 0;
    if (known) {
      try {
        await this.maxLock.run(async () => {
          const messages = await this.maxClient.readMessages(target, {
            isKnown: (id) => this.db.hasMessage(id)
          });
          for (const message of messages) {
            if (!this.db.hasMessage(message.id)) {
              this.db.insertMessage(message);
              primed += 1;
            }
          }
        });
      } catch (error) {
        logger.warn({ err: error, chatId: target }, 'Failed to prime chat backlog on unmute');
      }
    }
    this.db.setChatMuted(target, false);
    this.mutedChatIds.delete(target);
    await this.markTopicMuted(target, false);
    logger.info({ chatId: target, primed }, 'Chat unmuted');
    return `🔊 Чат «${target}» снова пересылается. Скопившееся за время тишины (${primed} сообщ.) не досылается — только новые.`;
  }

  async formatStatus() {
    const selected = this.db.getSelectedChat();
    const chats = this.db.listChats();
    const mappings = this.db.listChatMappings();
    const validMappings = mappings.filter((mapping) => mapping.telegramThreadId);
    const pendingMappings = mappings.length - validMappings.length;
    const typing = selected ? await this.maxLock.run(() => this.maxClient.isTyping()).catch(() => false) : false;
    return [
      `Running: ${this.running ? 'yes' : 'no'}`,
      `Chats: ${chats.length}`,
      `Routes: ${validMappings.length}`,
      this.requiresTelegramTopic() ? `Pending topics: ${pendingMappings}` : null,
      `Fallback selected: ${selected?.title || 'none'}`,
      `Max typing in active chat: ${typing ? 'yes' : 'no'}`,
      `Poll interval: ${this.config.pollIntervalMs} ms`,
      `Chats per poll: ${this.config.maxChatsPerPoll}`,
      `Auto topics: ${this.shouldAutoCreateTopics() ? 'yes' : 'no'}`,
      this.topicCreationBlockedReason ? `Topic creation blocked: ${this.topicCreationBlockedReason}` : null,
      `Poll failures: ${this.consecutivePollFailures}`,
      this.telegramPaused()
        ? `Telegram flood control: forwarding paused for ${Math.ceil((this.telegramPausedUntil - Date.now()) / 1000)} s`
        : null,
      ...this.formatBrowserStatusLines()
    ].filter(Boolean).join('\n');
  }

  // The planned-recycle state, so the owner can see from Telegram that the
  // browser is being kept in check (this used to be an invisible host cron).
  formatBrowserStatusLines(now = Date.now()) {
    if (!this.browserStartedAt) return [];
    const minutesAgo = (at) => `${Math.max(0, Math.round((now - at) / 60000))} min`;
    const memory = this.lastBrowserMemory;
    const limitMb = this.config.browserMemoryLimitMb || 0;
    const recycleMinutes = this.config.browserRecycleMinutes || 0;
    const last = this.lastBrowserRecycle;
    return [
      `Browser uptime: ${minutesAgo(this.browserStartedAt)}${recycleMinutes ? ` (recycle every ${recycleMinutes} min)` : ''}`,
      memory
        ? `Browser memory: ${toMb(memory.bytes)} MB${limitMb ? ` (limit ${limitMb} MB)` : ''}`
        : null,
      `Browser recycles: ${this.browserRecycles}${last ? ` (last: ${last.reason}, ${minutesAgo(last.at)} ago${last.ok ? '' : ', FAILED'})` : ''}`
    ];
  }

  async runHealthCheck() {
    let report;
    try {
      report = await this.maxLock.run(() => this.maxClient.healthCheck());
    } catch (error) {
      logger.error({ err: error }, 'Max Web healthcheck failed');
      // captureDiagnostics drives the live page over CDP — same lock rule as
      // every other page access.
      await this.maxLock.run(() => this.maxClient.captureDiagnostics('manual-healthcheck-error')).catch(() => null);
      return [
        'Max Web check: ERROR',
        `Bridge running: ${this.running ? 'yes' : 'no'}`,
        `Error: ${error?.message || String(error)}`,
        '',
        'Diagnostics were captured if the browser page was already open.'
      ].join('\n').slice(0, 3900);
    }

    const failed = report.checks.filter((check) => !check.ok);
    const lines = [
      `Max Web check: ${failed.length ? 'FAILED' : 'OK'}`,
      `Browser connected: ${report.browserConnected ? 'yes' : 'no'}`,
      `URL: ${report.url}`,
      `Page title: ${report.pageTitle || 'unknown'}`,
      `Chats visible: ${report.chatCount ?? 'unknown'}`,
      '',
      ...report.checks.map((check) => `${check.ok ? 'OK' : 'FAIL'} ${check.name}: ${check.detail}`)
    ];

    if (failed.length) {
      await this.maxLock.run(() => this.maxClient.captureDiagnostics('manual-healthcheck-failed')).catch(() => null);
      lines.push('', 'Diagnostics were captured because the healthcheck failed.');
    }

    return lines.join('\n').slice(0, 3900);
  }

  async sendDiagnostics(telegramChatId, telegramThreadId) {
    const route = { telegramChatId, telegramThreadId };
    const files = await this.latestDiagnosticFiles();
    if (!files.length) {
      return `No diagnostic files found in ${this.config.diagnosticDir}. Run /check after a failure or wait for an automatic polling failure.`;
    }

    for (const file of files) {
      await this.telegramBot.sendDocument(file.path, route, `Diagnostic: ${file.name}`);
    }

    return `Sent ${files.length} latest diagnostic file(s).`;
  }

  async latestDiagnosticFiles() {
    const files = await listFilesByMtime(this.config.diagnosticDir);
    return files.slice(0, this.config.diagnosticFilesLimit);
  }
}
