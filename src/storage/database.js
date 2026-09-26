import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export class AppDatabase {
  constructor(filename) {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new Database(filename);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
    this.prepare();
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chats (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        last_seen_at INTEGER,
        selected INTEGER NOT NULL DEFAULT 0,
        metadata TEXT NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        direction TEXT NOT NULL CHECK(direction IN ('max_to_tg', 'tg_to_max')),
        type TEXT NOT NULL,
        text TEXT,
        media_path TEXT,
        media_url TEXT,
        source_message_id TEXT,
        created_at INTEGER NOT NULL,
        metadata TEXT NOT NULL DEFAULT '{}',
        FOREIGN KEY(chat_id) REFERENCES chats(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_messages_chat_created
        ON messages(chat_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS chat_mappings (
        max_chat_id TEXT PRIMARY KEY,
        telegram_chat_id INTEGER NOT NULL,
        telegram_thread_id INTEGER,
        title TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        metadata TEXT NOT NULL DEFAULT '{}',
        FOREIGN KEY(max_chat_id) REFERENCES chats(id) ON DELETE CASCADE
      );


      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    // Legacy message_deliveries carried a FOREIGN KEY that the current schema
    // dropped. SQLite cannot remove a constraint in place, so the table has to
    // be rebuilt — but a plain DROP would wipe all delivery history and retry
    // state. Rename it aside instead; the CREATE below makes the new table and
    // the copy step after it moves the rows over. Crash-safe: if the process
    // dies between the rename and the copy, the next boot finds the _legacy
    // table and resumes at the copy step.
    const legacyDeliveries = this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='message_deliveries'").get();
    if (legacyDeliveries?.sql?.includes('FOREIGN KEY')) {
      this.db.exec('DROP TABLE IF EXISTS message_deliveries_legacy');
      this.db.exec('ALTER TABLE message_deliveries RENAME TO message_deliveries_legacy');
    }

    // Idempotent migration: add telegram_message_id column if it does not exist yet.
    // Existing databases keep all their rows; the new column defaults to NULL.
    const messageColumns = this.db.pragma('table_info(messages)');
    const hasTelegramMessageId = messageColumns.some((col) => col.name === 'telegram_message_id');
    if (!hasTelegramMessageId) {
      this.db.exec('ALTER TABLE messages ADD COLUMN telegram_message_id INTEGER');
    }
    // Idempotent migration: perceptual hash (dHash) of media content, used to
    // match a reply-to-media back to the original by image similarity.
    const hasMediaHash = messageColumns.some((col) => col.name === 'media_hash');
    if (!hasMediaHash) {
      this.db.exec('ALTER TABLE messages ADD COLUMN media_hash TEXT');
    }
    // Idempotent migration: MAX-side content fingerprint (same format as
    // messages.source_message_id for max_to_tg rows) captured right after we
    // send a tg_to_max text message into MAX. Lets a later Telegram reply to
    // that message be matched back to it and quoted inside MAX (see
    // bridge.js resolveMaxReplyTarget / maxClient.getLastOutgoingFingerprint).
    const hasMaxFingerprint = messageColumns.some((col) => col.name === 'max_fingerprint');
    if (!hasMaxFingerprint) {
      this.db.exec('ALTER TABLE messages ADD COLUMN max_fingerprint TEXT');
    }

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_messages_telegram_message_id
        ON messages(telegram_message_id);
    `);

    // One topic belongs to one MAX chat — except for chats /merge redirected
    // into another chat's topic, which share it. The original unique index
    // allowed no sharing at all, so /merge either did nothing or failed with
    // "UNIQUE constraint failed". Merged mappings are now left out of it (and
    // out of the topic -> chat lookup, see getMappingByTelegramThreadStmt).
    this.db.exec(`
      DROP INDEX IF EXISTS idx_chat_mappings_telegram_thread;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_mappings_thread_owner
        ON chat_mappings(telegram_chat_id, telegram_thread_id)
        WHERE telegram_thread_id IS NOT NULL AND json_extract(metadata, '$.mergedInto') IS NULL;
    `);

    // Covers getTgToMaxMessageBySourceIdStmt (WHERE direction='tg_to_max' AND
    // source_message_id=?), which otherwise full-table-scans an unbounded
    // table on every Telegram->MAX reply resolution inside the maxLock'd send
    // path (see Fix 7 in the reply-feature review).
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_messages_direction_source
        ON messages(direction, source_message_id);
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS message_deliveries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT NOT NULL,
        direction TEXT NOT NULL CHECK(direction IN ('max_to_tg', 'tg_to_max')),
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'sent', 'failed')),
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
      );

      CREATE INDEX IF NOT EXISTS idx_deliveries_status
        ON message_deliveries(status);

      CREATE INDEX IF NOT EXISTS idx_deliveries_message
        ON message_deliveries(message_id);
    `);

    // Second half of the legacy message_deliveries rebuild (see the rename
    // above): move the preserved rows into the fresh FK-less table. Column
    // intersection keeps this correct even if the legacy schema predates a
    // later column addition. On any copy failure the legacy table is left in
    // place — history stays recoverable and the next boot retries the copy.
    const legacyLeftover = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='message_deliveries_legacy'").get();
    if (legacyLeftover) {
      try {
        const newColumns = this.db.pragma('table_info(message_deliveries)').map((col) => col.name);
        const oldColumns = this.db.pragma('table_info(message_deliveries_legacy)').map((col) => col.name);
        const shared = newColumns.filter((name) => oldColumns.includes(name)).join(', ');
        this.db.transaction(() => {
          this.db.exec(`INSERT INTO message_deliveries (${shared}) SELECT ${shared} FROM message_deliveries_legacy`);
          this.db.exec('DROP TABLE message_deliveries_legacy');
        })();
      } catch (error) {
        // No logger here (it pulls in config, which tests must not require).
        console.error('Failed to migrate legacy message_deliveries rows; legacy table kept:', error);
      }
    }
  }

  prepare() {
    this.upsertChatStmt = this.db.prepare(`
      INSERT INTO chats (id, title, last_seen_at, metadata)
      VALUES (@id, @title, @lastSeenAt, @metadata)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        last_seen_at = excluded.last_seen_at,
        metadata = excluded.metadata
    `);

    this.selectChatStmt = this.db.prepare('UPDATE chats SET selected = CASE WHEN id = ? THEN 1 ELSE 0 END');
    this.getSelectedChatStmt = this.db.prepare('SELECT * FROM chats WHERE selected = 1 LIMIT 1');
    this.listChatsStmt = this.db.prepare('SELECT * FROM chats ORDER BY COALESCE(last_seen_at, 0) DESC, title ASC');

    this.upsertMappingStmt = this.db.prepare(`
      INSERT INTO chat_mappings (
        max_chat_id, telegram_chat_id, telegram_thread_id, title, enabled, created_at, updated_at, metadata
      ) VALUES (
        @maxChatId, @telegramChatId, @telegramThreadId, @title, @enabled, @createdAt, @updatedAt, @metadata
      )
      ON CONFLICT(max_chat_id) DO UPDATE SET
        telegram_chat_id = excluded.telegram_chat_id,
        -- A new topic always wins (a /relay move, /merge, /unmerge, a topic
        -- recreated after the old one was deleted). A missing one keeps the
        -- current topic only within the same Telegram chat — moving to
        -- another chat without a topic must not carry a foreign thread id.
        telegram_thread_id = CASE
          WHEN excluded.telegram_thread_id IS NOT NULL THEN excluded.telegram_thread_id
          WHEN excluded.telegram_chat_id = chat_mappings.telegram_chat_id THEN chat_mappings.telegram_thread_id
          ELSE NULL
        END,
        title = excluded.title,
        enabled = excluded.enabled,
        updated_at = excluded.updated_at,
        metadata = excluded.metadata
    `);
    this.getMappingByMaxChatStmt = this.db.prepare('SELECT * FROM chat_mappings WHERE max_chat_id = ? AND enabled = 1 LIMIT 1');
    this.getMappingByTelegramThreadStmt = this.db.prepare(`
      SELECT * FROM chat_mappings
      WHERE telegram_chat_id = ?
        AND COALESCE(telegram_thread_id, 0) = COALESCE(?, 0)
        AND enabled = 1
        AND json_extract(metadata, '$.mergedInto') IS NULL
      ORDER BY updated_at DESC
      LIMIT 1
    `);
    this.clearMappingThreadStmt = this.db.prepare(`
      UPDATE chat_mappings SET telegram_thread_id = NULL, metadata = ?, updated_at = ? WHERE max_chat_id = ?
    `);
    this.listMappingsStmt = this.db.prepare('SELECT * FROM chat_mappings WHERE enabled = 1 ORDER BY title ASC');

    this.insertMessageStmt = this.db.prepare(`
      INSERT OR IGNORE INTO messages (
        id, chat_id, direction, type, text, media_path, media_url, source_message_id, created_at, metadata,
        telegram_message_id, media_hash, max_fingerprint
      ) VALUES (
        @id, @chatId, @direction, @type, @text, @mediaPath, @mediaUrl, @sourceMessageId, @createdAt, @metadata,
        @telegramMessageId, @mediaHash, @maxFingerprint
      )
    `);

    this.getMessageByTelegramMessageIdStmt = this.db.prepare(
      'SELECT * FROM messages WHERE telegram_message_id = ? LIMIT 1'
    );

    // Telegram→MAX replies (v2): finds a message the user typed in Telegram and
    // the bridge sent into MAX (direction=tg_to_max), by the Telegram message_id
    // it was typed as (stored as source_message_id for that direction — see
    // telegramMessageToDomain in telegramBot.js). Used to resolve a reply to the
    // user's own earlier message back to its MAX-side fingerprint.
    this.getTgToMaxMessageBySourceIdStmt = this.db.prepare(`
      SELECT * FROM messages
      WHERE direction = 'tg_to_max' AND source_message_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `);

    // Re-forward guard: MAX serves media over SIGNED CDN URLs whose token and
    // `expires` parameter are regenerated on every page load, and those URLs are
    // baked into a message's content fingerprint (source_message_id). After a
    // browser/container restart the same old photo therefore produces a brand
    // new fingerprint -> new stable id -> hasMessage() misses -> it gets
    // forwarded to Telegram all over again (observed: 53 copies of one photo).
    // The perceptual hash of the image itself IS stable across those URL
    // changes, so it identifies the bubble when the URL cannot. Matching also
    // on the fingerprint's leading field (the bubble's timestamp/caption, which
    // is stable) keeps a genuinely re-sent identical image at a different time
    // deliverable instead of being swallowed as a duplicate.
    this.hasForwardedMediaCopyStmt = this.db.prepare(`
      SELECT 1 FROM messages
      WHERE chat_id = ?
        AND direction = 'max_to_tg'
        AND media_hash = ?
        AND (source_message_id = ? OR source_message_id LIKE ? ESCAPE '\\')
        AND created_at < ?
      LIMIT 1
    `);

    this.recentMessagesStmt = this.db.prepare(`
      SELECT * FROM messages
      WHERE chat_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `);

    this.hasMessageStmt = this.db.prepare('SELECT 1 FROM messages WHERE id = ? LIMIT 1');
    this.hasMessagesInChatStmt = this.db.prepare('SELECT 1 FROM messages WHERE chat_id = ? LIMIT 1');
    this.setSettingStmt = this.db.prepare(`
      INSERT INTO settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);
    this.getSettingStmt = this.db.prepare('SELECT value FROM settings WHERE key = ?');

    this.createDeliveryStmt = this.db.prepare(`
      INSERT INTO message_deliveries (message_id, direction, status, attempts, created_at, updated_at)
      VALUES (@messageId, @direction, 'pending', 0, @createdAt, @createdAt)
    `);

    this.updateDeliveryStatusStmt = this.db.prepare(`
      UPDATE message_deliveries
      SET status = @status,
          attempts = attempts + 1,
          last_error = @lastError,
          updated_at = @updatedAt
      WHERE id = @id
    `);

    this.getPendingDeliveriesStmt = this.db.prepare(`
      SELECT * FROM message_deliveries
      WHERE status = 'pending'
      ORDER BY created_at ASC
      LIMIT ?
    `);

    this.getFailedDeliveriesStmt = this.db.prepare(`
      SELECT * FROM message_deliveries
      WHERE status = 'failed'
      ORDER BY updated_at DESC
      LIMIT ?
    `);

    this.getDeliveryStatsStmt = this.db.prepare(`
      SELECT
        status,
        COUNT(*) as count
      FROM message_deliveries
      GROUP BY status
    `);

    this.countFailedDeliveriesStmt = this.db.prepare(`
      SELECT COUNT(*) AS n FROM message_deliveries
      WHERE message_id = ? AND direction = ? AND status = 'failed'
    `);

    // Finds the most recent stored message in a MAX chat whose text matches the
    // quoted snippet (exact or prefix match) and that has a Telegram reply target.
    this.findRepliedMessageStmt = this.db.prepare(`
      SELECT * FROM messages
      WHERE chat_id = ?
        AND text IS NOT NULL AND text <> ''
        AND (text = ? OR text LIKE ? ESCAPE '\\')
        AND (telegram_message_id IS NOT NULL OR direction = 'tg_to_max')
      ORDER BY created_at DESC
      LIMIT 1
    `);

    // Fallback for replies to media without a caption (no text snippet to match):
    // the most recent media message in the chat with a Telegram reply target.
    this.findRepliedMediaMessageStmt = this.db.prepare(`
      SELECT * FROM messages
      WHERE chat_id = ?
        AND type IN ('photo', 'video', 'video_note', 'voice', 'document', 'sticker')
        AND (telegram_message_id IS NOT NULL OR direction = 'tg_to_max')
      ORDER BY created_at DESC
      LIMIT 1
    `);

    // Counts media messages in a chat that could be a reply target — used to keep
    // the recency fallback safe: only quote by recency when there is exactly one
    // candidate, never guess among several.
    this.countRepliedMediaMessagesStmt = this.db.prepare(`
      SELECT COUNT(*) AS n FROM messages
      WHERE chat_id = ?
        AND type IN ('photo', 'video', 'video_note', 'voice', 'document', 'sticker')
        AND (telegram_message_id IS NOT NULL OR direction = 'tg_to_max')
    `);

    // Exact-identity match for a reply to media: find the original message whose
    // stored media_url carries the same CDN token as the quoted thumbnail.
    this.findMessageByMediaTokenStmt = this.db.prepare(`
      SELECT * FROM messages
      WHERE chat_id = ?
        AND media_url LIKE ?
        AND (telegram_message_id IS NOT NULL OR direction = 'tg_to_max')
      ORDER BY created_at DESC
      LIMIT 1
    `);

    // Candidates for perceptual-hash matching of a reply to media: recent messages
    // in the chat that have a stored media_hash and a Telegram reply target. The
    // bridge computes the Hamming distance against the quoted thumbnail's hash.
    this.replyMediaCandidatesStmt = this.db.prepare(`
      SELECT * FROM messages
      WHERE chat_id = ?
        AND media_hash IS NOT NULL
        AND (telegram_message_id IS NOT NULL OR direction = 'tg_to_max')
      ORDER BY created_at DESC
      LIMIT 60
    `);
  }

  upsertChat(chat) {
    this.upsertChatStmt.run({
      id: chat.id,
      title: chat.title,
      lastSeenAt: chat.lastSeenAt || Date.now(),
      metadata: JSON.stringify(chat.metadata || {})
    });
  }

  listChats() {
    return this.listChatsStmt.all().map(rowToChat);
  }

  selectChat(chatId) {
    this.selectChatStmt.run(chatId);
  }

  getSelectedChat() {
    const row = this.getSelectedChatStmt.get();
    return row ? rowToChat(row) : null;
  }

  upsertChatMapping(mapping) {
    const now = Date.now();
    this.upsertMappingStmt.run({
      maxChatId: mapping.maxChatId,
      telegramChatId: mapping.telegramChatId,
      telegramThreadId: mapping.telegramThreadId || null,
      title: mapping.title,
      enabled: mapping.enabled === false ? 0 : 1,
      createdAt: mapping.createdAt || now,
      updatedAt: now,
      metadata: JSON.stringify(mapping.metadata || {})
    });
  }

  getChatMapping(maxChatId) {
    const row = this.getMappingByMaxChatStmt.get(maxChatId);
    return row ? rowToMapping(row) : null;
  }

  // The topic was deleted in Telegram: forget it (the upsert cannot, since a
  // missing topic keeps the current one) so the next message creates a new
  // topic. The intro bookkeeping goes too — the new topic needs its own.
  clearChatMappingThread(maxChatId) {
    const mapping = this.getChatMapping(maxChatId);
    if (!mapping) return;
    const { topicIntroMessageId, topicIntroPinnedAt, topicIntroPinned, topicIntroPinError, ...metadata } = mapping.metadata || {};
    this.clearMappingThreadStmt.run(JSON.stringify(metadata), Date.now(), maxChatId);
  }

  getChatMappingByTelegramThread(telegramChatId, telegramThreadId = null) {
    const row = this.getMappingByTelegramThreadStmt.get(telegramChatId, telegramThreadId || null);
    return row ? rowToMapping(row) : null;
  }

  listChatMappings() {
    return this.listMappingsStmt.all().map(rowToMapping);
  }

  insertMessage(message) {
    const result = this.insertMessageStmt.run({
      id: message.id,
      chatId: message.chatId,
      direction: message.direction,
      type: message.type,
      text: message.text || null,
      mediaPath: message.mediaPath || null,
      mediaUrl: message.mediaUrl || null,
      sourceMessageId: message.sourceMessageId || null,
      createdAt: message.createdAt || Date.now(),
      metadata: JSON.stringify(message.metadata || {}),
      telegramMessageId: message.telegramMessageId ?? null,
      mediaHash: message.mediaHash ?? null,
      maxFingerprint: message.maxFingerprint ?? null
    });
    return result.changes > 0;
  }

  // Returns the message whose Telegram message_id matches, or null if not found.
  getMessageByTelegramMessageId(telegramMessageId) {
    const row = this.getMessageByTelegramMessageIdStmt.get(telegramMessageId);
    return row ? rowToMessage(row) : null;
  }

  // Returns the tg_to_max message (one the user typed in Telegram and the
  // bridge sent into MAX) whose source Telegram message_id matches, or null.
  getTgToMaxMessageBySourceId(telegramMessageId) {
    const row = this.getTgToMaxMessageBySourceIdStmt.get(String(telegramMessageId));
    return row ? rowToMessage(row) : null;
  }

  // True if this exact media bubble was already forwarded from this MAX chat.
  // Identified by the image's perceptual hash plus the stable leading field of
  // its fingerprint (timestamp/caption), because MAX's signed CDN URLs — which
  // the fingerprint embeds — are regenerated on every page load and therefore
  // cannot identify it. See hasForwardedMediaCopyStmt for the full rationale.
  // `storedBefore` limits the match to rows stored before the current page was
  // loaded: signed URLs only change across page loads, so a same-session twin
  // is a genuinely new message, not a stale copy.
  hasForwardedMediaCopy(chatId, mediaHash, fingerprintPrefix, storedBefore = Number.MAX_SAFE_INTEGER) {
    if (!chatId || !mediaHash) return false;
    const prefix = String(fingerprintPrefix ?? '');
    // Escape LIKE wildcards in the caption/timestamp so a message whose text
    // contains % or _ can't match unrelated rows.
    const escaped = prefix.replace(/[\\%_]/g, '\\$&');
    return Boolean(this.hasForwardedMediaCopyStmt.get(chatId, mediaHash, prefix, escaped + '|%', storedBefore));
  }

  // Returns the most recent stored message in a MAX chat whose text matches the
  // quoted snippet (exact or prefix match, since MAX truncates quoted text).
  // Only messages that have a Telegram reply target are returned.
  findRepliedMessage(chatId, snippet) {
    // The snippet is user-authored message text, so its own % and _ must be
    // escaped or they act as SQL wildcards: quoting "Скидка 50% сегодня" would
    // otherwise match a different message and attach the reply to the wrong
    // original (the same class of bug already guarded in hasForwardedMediaCopy).
    const snippetPrefix = String(snippet ?? '').replace(/[\\%_]/g, '\\$&') + '%';
    const row = this.findRepliedMessageStmt.get(chatId, snippet, snippetPrefix);
    return row ? rowToMessage(row) : null;
  }

  // Returns the most recent media message in a MAX chat that has a Telegram
  // reply target. Used for replies to captionless media, which carry no text
  // snippet to match on.
  findRepliedMediaMessage(chatId) {
    const row = this.findRepliedMediaMessageStmt.get(chatId);
    return row ? rowToMessage(row) : null;
  }

  countRepliedMediaMessages(chatId) {
    return this.countRepliedMediaMessagesStmt.get(chatId).n;
  }

  // Returns the most recent message in a MAX chat whose stored media_url contains
  // the given CDN token (extracted from a reply quote's thumbnail), or null.
  // Only messages that have a Telegram reply target are returned.
  findMessageByMediaToken(chatId, token) {
    if (!token) return null;
    const row = this.findMessageByMediaTokenStmt.get(chatId, '%' + token + '%');
    return row ? rowToMessage(row) : null;
  }

  // Returns recent media messages in a MAX chat that have a stored perceptual
  // hash and a Telegram reply target, for similarity matching of media replies.
  getReplyMediaCandidates(chatId) {
    return this.replyMediaCandidatesStmt.all(chatId).map(rowToMessage);
  }

  hasMessage(id) {
    return Boolean(this.hasMessageStmt.get(id));
  }

  // True once anything from this MAX chat has been stored (forwarded, primed
  // or sent into it).
  hasMessagesInChat(chatId) {
    return this.hasMessagesInChatStmt.get(chatId) !== undefined;
  }

  // True on a brand-new database — nothing has ever been forwarded or primed.
  // Used to tell a first run (where MAX's existing history must be swallowed,
  // not delivered) from a restart (where anything unseen is genuinely new).
  isEmptyOfMessages() {
    return this.db.prepare('SELECT 1 FROM messages LIMIT 1').get() === undefined;
  }

  recentMessages(chatId, limit) {
    return this.recentMessagesStmt.all(chatId, limit).reverse().map(rowToMessage);
  }

  setSetting(key, value) {
    this.setSettingStmt.run(key, JSON.stringify(value));
  }

  getSetting(key, fallback = null) {
    const row = this.getSettingStmt.get(key);
    if (!row) return fallback;
    try {
      return JSON.parse(row.value);
    } catch {
      return fallback;
    }
  }

  close() {
    this.db.close();
  }

  // Muted MAX chats (service/ad feeds like «Интересное для вас»): stored as a
  // JSON array in the settings table so the list survives restarts. The bridge
  // keeps an in-memory Set mirror for the per-poll hot path.
  listMutedChatIds() {
    try {
      const parsed = JSON.parse(this.getSetting('muted_chat_ids', '[]'));
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  setChatMuted(chatId, muted) {
    const ids = new Set(this.listMutedChatIds());
    if (muted) ids.add(chatId);
    else ids.delete(chatId);
    this.setSetting('muted_chat_ids', JSON.stringify([...ids]));
  }

  createDelivery(messageId, direction) {
    const now = Date.now();
    const result = this.createDeliveryStmt.run({
      messageId,
      direction,
      createdAt: now
    });
    return result.lastInsertRowid;
  }

  updateDeliveryStatus(id, status, lastError = null) {
    const now = Date.now();
    this.updateDeliveryStatusStmt.run({
      id,
      status,
      lastError,
      updatedAt: now
    });
  }

  getPendingDeliveries(limit = 10) {
    return this.getPendingDeliveriesStmt.all(limit);
  }

  getFailedDeliveries(limit = 20) {
    return this.getFailedDeliveriesStmt.all(limit);
  }

  getDeliveryStats() {
    return this.getDeliveryStatsStmt.all();
  }

  countFailedDeliveries(messageId, direction) {
    return this.countFailedDeliveriesStmt.get(messageId, direction).n;
  }
}

const rowToChat = (row) => ({
  id: row.id,
  title: row.title,
  lastSeenAt: row.last_seen_at,
  selected: Boolean(row.selected),
  metadata: safeJsonParse(row.metadata)
});

const rowToMessage = (row) => ({
  id: row.id,
  chatId: row.chat_id,
  direction: row.direction,
  type: row.type,
  text: row.text,
  mediaPath: row.media_path,
  mediaUrl: row.media_url,
  sourceMessageId: row.source_message_id,
  createdAt: row.created_at,
  metadata: safeJsonParse(row.metadata),
  telegramMessageId: row.telegram_message_id ?? null,
  mediaHash: row.media_hash ?? null,
  maxFingerprint: row.max_fingerprint ?? null
});

const rowToMapping = (row) => ({
  maxChatId: row.max_chat_id,
  telegramChatId: row.telegram_chat_id,
  telegramThreadId: row.telegram_thread_id,
  title: row.title,
  enabled: Boolean(row.enabled),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  metadata: safeJsonParse(row.metadata)
});

const safeJsonParse = (value) => {
  try {
    return JSON.parse(value || '{}');
  } catch {
    return {};
  }
};
