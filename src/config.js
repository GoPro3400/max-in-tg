import 'dotenv/config';
import path from 'node:path';

const bool = (value, fallback = false) => {
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
};

const int = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
};

const positiveInt = (name) => {
  const raw = required(name);
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, got: ${raw}`);
  }
  return parsed;
};

// Optional identity value: absent means "discover it at runtime and remember
// it" (the owner claims the bot with /pair, the relay group is picked up when
// the bot is added to it). Present-but-nonsense still fails loudly.
const optionalPositiveInt = (name) => {
  const raw = process.env[name];
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer when set, got: ${raw}`);
  }
  return parsed;
};

const rootPath = process.cwd();
const resolveFromRoot = (value) => path.resolve(rootPath, value);

export const config = {
  env: process.env.NODE_ENV || 'development',
  logLevel: process.env.LOG_LEVEL || 'info',
  telegram: {
    token: required('TELEGRAM_BOT_TOKEN'),
    // Both are discovered at runtime when unset (see bridge.restoreIdentity /
    // telegramBot /pair and my_chat_member) and persisted in the settings
    // table, so a fresh install only needs TELEGRAM_BOT_TOKEN.
    ownerId: optionalPositiveInt('TELEGRAM_OWNER_ID'),
    relayChatId: int(process.env.TELEGRAM_RELAY_CHAT_ID, 0) || null,
    useTopics: bool(process.env.TELEGRAM_USE_TOPICS, true),
    autoCreateTopics: bool(process.env.TELEGRAM_AUTO_CREATE_TOPICS, true)
  },
  max: {
    webUrl: process.env.MAX_WEB_URL || 'https://web.max.ru/',
    userDataDir: resolveFromRoot(process.env.MAX_USER_DATA_DIR || './data/chrome-profile'),
    headless: bool(process.env.MAX_HEADLESS, false),
    protocolTimeoutMs: int(process.env.MAX_PROTOCOL_TIMEOUT_MS, 180000),
    selectors: {
      chatList: process.env.MAX_SELECTORS_CHAT_LIST || 'aside[aria-labelledby="aside-header-title"] .scrollListContent',
      chatItem: process.env.MAX_SELECTORS_CHAT_ITEM || 'aside[aria-labelledby="aside-header-title"] .item[data-index]',
      chatTitle: process.env.MAX_SELECTORS_CHAT_TITLE || 'h3.title span.name span.text',
      chatUnread: process.env.MAX_SELECTORS_CHAT_UNREAD || '.indicator .badgeIcon, .badgeIcon[aria-label*="new"]',
      activeChatTitle: process.env.MAX_SELECTORS_ACTIVE_CHAT_TITLE || '[id="main-header-title"]',
      messageList: process.env.MAX_SELECTORS_MESSAGE_LIST || 'main .scrollListContent, main .content',
      messageItem: process.env.MAX_SELECTORS_MESSAGE_ITEM || 'main [data-bubbles-variant] > .bubble, main .bubble',
      messageText: process.env.MAX_SELECTORS_MESSAGE_TEXT || '.text, [data-lexical-text]',
      messageAuthor: process.env.MAX_SELECTORS_MESSAGE_AUTHOR || '.author, .sender, .bubbleAuthor',
      messageTime: process.env.MAX_SELECTORS_MESSAGE_TIME || '.time[aria-label], time',
      messageImage: process.env.MAX_SELECTORS_MESSAGE_IMAGE || 'img, canvas',
      messageAudio: process.env.MAX_SELECTORS_MESSAGE_AUDIO || 'audio, [class*="voice"], [data-testid*="voice"]',
      messageVideo: process.env.MAX_SELECTORS_MESSAGE_VIDEO || 'video, source[type="video"]',
      messageDocument: process.env.MAX_SELECTORS_MESSAGE_DOCUMENT || 'a[href][download],a[href*="/file"],a[href*="/download"]',
      composer: process.env.MAX_SELECTORS_COMPOSER || '[data-testid="composer"] [contenteditable][role="textbox"], [data-lexical-editor="true"]',
      attachInput: process.env.MAX_SELECTORS_ATTACH_INPUT || 'input[type="file"]',
      // Attach flow: MAX's paperclip opens an actions menu; the file <input> is
      // only wired up after picking a menu item. attachButton opens the menu,
      // attachMenuMedia is the "Photo or video" item (images/videos),
      // attachMenuFile is the "File" item (everything else).
      attachButton: process.env.MAX_SELECTORS_ATTACH_BUTTON || 'button[aria-label="Upload file"]',
      attachMenuMedia: process.env.MAX_SELECTORS_ATTACH_MENU_MEDIA || 'button[role="menuitem"][aria-label*="Photo"]',
      attachMenuFile: process.env.MAX_SELECTORS_ATTACH_MENU_FILE || 'button[role="menuitem"][aria-label*="File"]',
      sendButton: process.env.MAX_SELECTORS_SEND_BUTTON || '[data-testid="composer"] button[aria-label="Send message"], button[aria-label="Send message"]',
      typing: process.env.MAX_SELECTORS_TYPING || '[data-testid="typing-indicator"]',
      // Attachment staging: elements that appear in the composer preview area
      // after a file has been accepted by the file-chooser. If any of these are
      // present the attachment has been staged and the send button can be clicked.
      // Override with MAX_SELECTORS_ATTACH_PREVIEW if the live DOM differs.
      attachPreview: process.env.MAX_SELECTORS_ATTACH_PREVIEW || '[data-testid="composer"] [class*="attach"], [data-testid="composer"] [class*="preview"], [data-testid="composer"] img, [data-testid="composer"] video',
      // Outgoing message bubbles (used to verify a new one appeared after send).
      // Override with MAX_SELECTORS_OUTGOING_BUBBLE if the live DOM differs.
      outgoingBubble: process.env.MAX_SELECTORS_OUTGOING_BUBBLE || '[data-bubbles-variant="outgoing"]',
      // Telegram→MAX replies: hovering a message bubble reveals a per-message
      // quick-action row with a one-click Reply button (separate from the
      // "Message actions" /more menu). Clicking it puts the composer into
      // reply mode, shown by a banner with a close ("x") button that cancels it.
      messageReplyButton: process.env.MAX_SELECTORS_MESSAGE_REPLY_BUTTON || 'button[aria-label="Reply"]',
      composerReplyActive: process.env.MAX_SELECTORS_COMPOSER_REPLY_ACTIVE || '[data-testid="composer"] button.close'
    }
  },
  sqlitePath: resolveFromRoot(process.env.SQLITE_PATH || './data/max-in-tg.sqlite'),
  mediaDir: resolveFromRoot(process.env.MEDIA_DIR || './tmp/media'),
  diagnosticDir: resolveFromRoot(process.env.DIAGNOSTIC_DIR || './logs/diagnostics'),
  diagnosticFilesLimit: int(process.env.DIAGNOSTIC_FILES_LIMIT, 4),
  diagnosticRetentionFiles: int(process.env.DIAGNOSTIC_RETENTION_FILES, 80),
  // Diagnostic HTML dumps are full captures of the live MAX page and therefore
  // contain private conversation text. Redacted by default; set to false only
  // for a deliberate, short-lived debugging session.
  diagnosticRedactText: bool(process.env.DIAGNOSTIC_REDACT_TEXT, true),
  startupPrimeExistingMessages: bool(process.env.STARTUP_PRIME_EXISTING_MESSAGES, true),
  // 0 (the default) = prime every chat seen at startup. A positive value caps
  // it, which on a first run means the chats beyond the cap deliver their
  // existing history to Telegram — see primeExistingMaxMessages.
  startupPrimeChatsLimit: int(process.env.STARTUP_PRIME_CHATS_LIMIT, 0),
  pollIntervalMs: int(process.env.POLL_INTERVAL_MS, 650),
  historyLimit: int(process.env.HISTORY_LIMIT, 50),
  maxChatsPerPoll: int(process.env.MAX_CHATS_PER_POLL, 4),
  maxPollFailuresBeforeRestart: int(process.env.MAX_POLL_FAILURES_BEFORE_RESTART, 5),
  // Keeping Chromium's memory in check replaces the external cron restart (see
  // BridgeService.maybeRecycleBrowser): the MAX page is reloaded above
  // pageReloadMemoryMb, the browser relaunched above browserMemoryLimitMb or
  // after browserRecycleMinutes. 0 disables that trigger.
  pageReloadMemoryMb: Math.max(0, int(process.env.MAX_PAGE_RELOAD_MEMORY_MB, 900)),
  browserMemoryLimitMb: Math.max(0, int(process.env.MAX_BROWSER_MEMORY_LIMIT_MB, 1300)),
  browserRecycleMinutes: Math.max(0, int(process.env.MAX_BROWSER_RECYCLE_MINUTES, 360)),
  maxDeliveryAttempts: Math.max(1, int(process.env.MAX_DELIVERY_ATTEMPTS, 5))
};
