import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AppDatabase } from '../../src/storage/database.js';

describe('AppDatabase', () => {
  let dbPath;
  let db;

  beforeEach(() => {
    const tmpDir = path.join(os.tmpdir(), `db-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    dbPath = path.join(tmpDir, 'test.sqlite');
    db = new AppDatabase(dbPath);
  });

  afterEach(() => {
    db.close();
    const dir = path.dirname(dbPath);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe('initialization', () => {
    it('creates database file', () => {
      expect(fs.existsSync(dbPath)).toBe(true);
    });

    it('uses WAL journal mode', () => {
      const result = db.db.pragma('journal_mode');
      expect(result[0].journal_mode).toBe('wal');
    });

    it('has foreign keys enabled', () => {
      const result = db.db.pragma('foreign_keys');
      expect(result[0].foreign_keys).toBe(1);
    });

    it('creates a covering index on messages(direction, source_message_id)', () => {
      // Backs getTgToMaxMessageBySourceIdStmt so a Telegram->MAX reply lookup
      // doesn't full-table-scan messages inside the maxLock'd send path
      // (see Fix 7 in the reply-feature review).
      const index = db.db.prepare(
        "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_messages_direction_source'"
      ).get();
      expect(index).toBeTruthy();
      expect(index.sql).toContain('messages(direction, source_message_id)');
    });
  });

  describe('chats', () => {
    it('upserts and lists a chat', () => {
      db.upsertChat({ id: 'chat-1', title: 'Test Chat' });
      const chats = db.listChats();
      expect(chats).toHaveLength(1);
      expect(chats[0].id).toBe('chat-1');
      expect(chats[0].title).toBe('Test Chat');
    });

    it('updates chat on conflict', () => {
      db.upsertChat({ id: 'chat-1', title: 'Old Title' });
      db.upsertChat({ id: 'chat-1', title: 'New Title' });
      const chats = db.listChats();
      expect(chats).toHaveLength(1);
      expect(chats[0].title).toBe('New Title');
    });

    it('stores metadata as JSON', () => {
      db.upsertChat({ id: 'chat-1', title: 'Chat', metadata: { unread: true } });
      const chats = db.listChats();
      expect(chats[0].metadata).toEqual({ unread: true });
    });

    it('defaults metadata to empty object', () => {
      db.upsertChat({ id: 'chat-1', title: 'Chat' });
      const chats = db.listChats();
      expect(chats[0].metadata).toEqual({});
    });

    it('orders by last_seen_at descending', () => {
      db.upsertChat({ id: 'chat-1', title: 'Old', lastSeenAt: 1000 });
      db.upsertChat({ id: 'chat-2', title: 'New', lastSeenAt: 2000 });
      const chats = db.listChats();
      expect(chats[0].id).toBe('chat-2');
      expect(chats[1].id).toBe('chat-1');
    });
  });

  describe('chat selection', () => {
    it('selects a chat', () => {
      db.upsertChat({ id: 'chat-1', title: 'Chat 1' });
      db.upsertChat({ id: 'chat-2', title: 'Chat 2' });
      db.selectChat('chat-1');
      const selected = db.getSelectedChat();
      expect(selected).not.toBeNull();
      expect(selected.id).toBe('chat-1');
    });

    it('deselects previous chat when selecting new one', () => {
      db.upsertChat({ id: 'chat-1', title: 'Chat 1' });
      db.upsertChat({ id: 'chat-2', title: 'Chat 2' });
      db.selectChat('chat-1');
      db.selectChat('chat-2');
      const selected = db.getSelectedChat();
      expect(selected.id).toBe('chat-2');
    });

    it('returns null when no chat selected', () => {
      const selected = db.getSelectedChat();
      expect(selected).toBeNull();
    });
  });

  describe('chat mappings', () => {
    beforeEach(() => {
      db.upsertChat({ id: 'max-1', title: 'Max Chat' });
    });

    it('creates a mapping', () => {
      db.upsertChatMapping({
        maxChatId: 'max-1',
        telegramChatId: -1001234,
        telegramThreadId: 5,
        title: 'Max Chat'
      });
      const mapping = db.getChatMapping('max-1');
      expect(mapping).not.toBeNull();
      expect(mapping.maxChatId).toBe('max-1');
      expect(mapping.telegramChatId).toBe(-1001234);
      expect(mapping.telegramThreadId).toBe(5);
      expect(mapping.title).toBe('Max Chat');
      expect(mapping.enabled).toBe(true);
    });

    it('returns null for non-existent mapping', () => {
      expect(db.getChatMapping('nonexistent')).toBeNull();
    });

    it('looks up mapping by telegram thread', () => {
      db.upsertChatMapping({
        maxChatId: 'max-1',
        telegramChatId: -1001234,
        telegramThreadId: 10,
        title: 'Max Chat'
      });
      const mapping = db.getChatMappingByTelegramThread(-1001234, 10);
      expect(mapping).not.toBeNull();
      expect(mapping.maxChatId).toBe('max-1');
    });

    it('returns null for wrong thread id', () => {
      db.upsertChatMapping({
        maxChatId: 'max-1',
        telegramChatId: -1001234,
        telegramThreadId: 10,
        title: 'Max Chat'
      });
      const mapping = db.getChatMappingByTelegramThread(-1001234, 99);
      expect(mapping).toBeNull();
    });

    it('lists all enabled mappings', () => {
      db.upsertChat({ id: 'max-2', title: 'Max Chat 2' });
      db.upsertChatMapping({
        maxChatId: 'max-1',
        telegramChatId: -1001234,
        telegramThreadId: 1,
        title: 'Chat 1'
      });
      db.upsertChatMapping({
        maxChatId: 'max-2',
        telegramChatId: -1001234,
        telegramThreadId: 2,
        title: 'Chat 2'
      });
      const mappings = db.listChatMappings();
      expect(mappings).toHaveLength(2);
    });

    it('excludes disabled mappings from lookup', () => {
      db.upsertChatMapping({
        maxChatId: 'max-1',
        telegramChatId: -1001234,
        telegramThreadId: 1,
        title: 'Disabled',
        enabled: false
      });
      expect(db.getChatMapping('max-1')).toBeNull();
    });

    it('updates mapping title on conflict', () => {
      db.upsertChatMapping({
        maxChatId: 'max-1',
        telegramChatId: -1001234,
        telegramThreadId: 5,
        title: 'Old Title'
      });
      db.upsertChatMapping({
        maxChatId: 'max-1',
        telegramChatId: -1001234,
        telegramThreadId: 5,
        title: 'New Title'
      });
      const mapping = db.getChatMapping('max-1');
      expect(mapping.title).toBe('New Title');
    });
  });

  describe('messages', () => {
    beforeEach(() => {
      db.upsertChat({ id: 'chat-1', title: 'Chat' });
    });

    it('inserts a message', () => {
      const inserted = db.insertMessage({
        id: 'msg-1',
        chatId: 'chat-1',
        direction: 'max_to_tg',
        type: 'text',
        text: 'Hello',
        createdAt: 1000
      });
      expect(inserted).toBe(true);
    });

    it('ignores duplicate messages', () => {
      db.insertMessage({
        id: 'msg-1',
        chatId: 'chat-1',
        direction: 'max_to_tg',
        type: 'text',
        text: 'Hello',
        createdAt: 1000
      });
      const inserted = db.insertMessage({
        id: 'msg-1',
        chatId: 'chat-1',
        direction: 'max_to_tg',
        type: 'text',
        text: 'Duplicate',
        createdAt: 2000
      });
      expect(inserted).toBe(false);
    });

    it('checks if message exists', () => {
      db.insertMessage({
        id: 'msg-1',
        chatId: 'chat-1',
        direction: 'max_to_tg',
        type: 'text',
        text: 'Hello',
        createdAt: 1000
      });
      expect(db.hasMessage('msg-1')).toBe(true);
      expect(db.hasMessage('msg-999')).toBe(false);
    });

    it('returns recent messages in chronological order', () => {
      for (let i = 1; i <= 5; i++) {
        db.insertMessage({
          id: `msg-${i}`,
          chatId: 'chat-1',
          direction: 'max_to_tg',
          type: 'text',
          text: `Message ${i}`,
          createdAt: i * 1000
        });
      }
      const messages = db.recentMessages('chat-1', 3);
      expect(messages).toHaveLength(3);
      // Should be last 3 in chronological order
      expect(messages[0].text).toBe('Message 3');
      expect(messages[1].text).toBe('Message 4');
      expect(messages[2].text).toBe('Message 5');
    });

    it('stores media fields', () => {
      db.insertMessage({
        id: 'msg-media',
        chatId: 'chat-1',
        direction: 'tg_to_max',
        type: 'photo',
        mediaPath: '/tmp/photo.jpg',
        mediaUrl: 'https://example.com/photo.jpg',
        createdAt: 1000
      });
      const messages = db.recentMessages('chat-1', 1);
      expect(messages[0].mediaPath).toBe('/tmp/photo.jpg');
      expect(messages[0].mediaUrl).toBe('https://example.com/photo.jpg');
      expect(messages[0].type).toBe('photo');
    });

    it('stores message metadata', () => {
      db.insertMessage({
        id: 'msg-meta',
        chatId: 'chat-1',
        direction: 'max_to_tg',
        type: 'text',
        text: 'Hello',
        createdAt: 1000,
        metadata: { forwarded: true }
      });
      const messages = db.recentMessages('chat-1', 1);
      expect(messages[0].metadata).toEqual({ forwarded: true });
    });

    it('persists telegramMessageId and returns it via recentMessages', () => {
      db.insertMessage({
        id: 'msg-tgid',
        chatId: 'chat-1',
        direction: 'max_to_tg',
        type: 'text',
        text: 'Forwarded',
        createdAt: 1000,
        telegramMessageId: 42
      });
      const messages = db.recentMessages('chat-1', 1);
      expect(messages[0].telegramMessageId).toBe(42);
    });

    it('stores null telegramMessageId when not provided', () => {
      db.insertMessage({
        id: 'msg-notg',
        chatId: 'chat-1',
        direction: 'max_to_tg',
        type: 'text',
        text: 'No tg id',
        createdAt: 1000
      });
      const messages = db.recentMessages('chat-1', 1);
      expect(messages[0].telegramMessageId).toBeNull();
    });
  });

  describe('getMessageByTelegramMessageId', () => {
    beforeEach(() => {
      db.upsertChat({ id: 'chat-1', title: 'Chat' });
    });

    it('finds a message by telegram_message_id', () => {
      db.insertMessage({
        id: 'msg-tg-lookup',
        chatId: 'chat-1',
        direction: 'max_to_tg',
        type: 'text',
        text: 'Hello',
        createdAt: 2000,
        telegramMessageId: 99
      });
      const found = db.getMessageByTelegramMessageId(99);
      expect(found).not.toBeNull();
      expect(found.id).toBe('msg-tg-lookup');
      expect(found.telegramMessageId).toBe(99);
    });

    it('returns null for an unknown telegram_message_id', () => {
      const result = db.getMessageByTelegramMessageId(99999);
      expect(result).toBeNull();
    });
  });

  describe('findRepliedMessage', () => {
    beforeEach(() => {
      db.upsertChat({ id: 'chat-1', title: 'Chat' });
    });

    it('finds a message by exact text match', () => {
      db.insertMessage({
        id: 'msg-orig',
        chatId: 'chat-1',
        direction: 'max_to_tg',
        type: 'text',
        text: 'Привет, как дела?',
        createdAt: 1000,
        telegramMessageId: 101
      });
      const found = db.findRepliedMessage('chat-1', 'Привет, как дела?');
      expect(found).not.toBeNull();
      expect(found.id).toBe('msg-orig');
      expect(found.telegramMessageId).toBe(101);
    });

    // A quoted snippet is user-authored text; its own % and _ must not act as
    // SQL wildcards, or the reply gets attached to a different message.
    it('treats % and _ in a quoted snippet literally', () => {
      db.insertMessage({
        id: 'msg-other', chatId: 'chat-1', direction: 'max_to_tg', type: 'text',
        text: 'Скидка 50X сегодня действует', createdAt: 1000, telegramMessageId: 201
      });
      db.insertMessage({
        id: 'msg-real', chatId: 'chat-1', direction: 'max_to_tg', type: 'text',
        text: 'Скидка 50% сегодня', createdAt: 2000, telegramMessageId: 202
      });
      expect(db.findRepliedMessage('chat-1', 'Скидка 50% сегодня').id).toBe('msg-real');
      // '50_' must not wildcard-match '50X' / '50%'.
      expect(db.findRepliedMessage('chat-1', 'Скидка 50_ сегодня')).toBeNull();
    });

    it('finds a message by prefix match (snippet shorter than stored text)', () => {
      db.insertMessage({
        id: 'msg-long',
        chatId: 'chat-1',
        direction: 'max_to_tg',
        type: 'text',
        text: 'Длинное сообщение с кучей текста',
        createdAt: 2000,
        telegramMessageId: 202
      });
      // MAX truncates quoted text, so the snippet is only the beginning
      const found = db.findRepliedMessage('chat-1', 'Длинное сообщение');
      expect(found).not.toBeNull();
      expect(found.id).toBe('msg-long');
    });

    it('returns null when no message matches', () => {
      db.insertMessage({
        id: 'msg-other',
        chatId: 'chat-1',
        direction: 'max_to_tg',
        type: 'text',
        text: 'Совсем другое сообщение',
        createdAt: 1000,
        telegramMessageId: 303
      });
      const found = db.findRepliedMessage('chat-1', 'Ничего общего');
      expect(found).toBeNull();
    });

    it('ignores max_to_tg messages without a telegramMessageId', () => {
      // A max_to_tg message that was never forwarded (no telegramMessageId)
      // cannot be used as a Telegram reply target
      db.insertMessage({
        id: 'msg-no-tg-id',
        chatId: 'chat-1',
        direction: 'max_to_tg',
        type: 'text',
        text: 'Сообщение без telegram_message_id',
        createdAt: 1000
        // telegramMessageId is null (not provided)
      });
      const found = db.findRepliedMessage('chat-1', 'Сообщение без telegram_message_id');
      expect(found).toBeNull();
    });

    it('returns tg_to_max message even without telegramMessageId (uses sourceMessageId as reply target)', () => {
      // A tg_to_max message: the Telegram message_id is stored in sourceMessageId
      db.insertMessage({
        id: 'msg-tg-to-max',
        chatId: 'chat-1',
        direction: 'tg_to_max',
        type: 'text',
        text: 'Сообщение из Telegram',
        sourceMessageId: '555',
        createdAt: 3000
        // telegramMessageId is null for tg_to_max messages
      });
      const found = db.findRepliedMessage('chat-1', 'Сообщение из Telegram');
      expect(found).not.toBeNull();
      expect(found.direction).toBe('tg_to_max');
      expect(found.sourceMessageId).toBe('555');
    });

    it('returns the most recent match when multiple messages have the same text', () => {
      db.insertMessage({
        id: 'msg-older',
        chatId: 'chat-1',
        direction: 'max_to_tg',
        type: 'text',
        text: 'Привет',
        createdAt: 1000,
        telegramMessageId: 11
      });
      db.insertMessage({
        id: 'msg-newer',
        chatId: 'chat-1',
        direction: 'max_to_tg',
        type: 'text',
        text: 'Привет',
        createdAt: 2000,
        telegramMessageId: 22
      });
      const found = db.findRepliedMessage('chat-1', 'Привет');
      expect(found).not.toBeNull();
      expect(found.id).toBe('msg-newer');
      expect(found.telegramMessageId).toBe(22);
    });
  });

  describe('findRepliedMediaMessage', () => {
    beforeEach(() => {
      db.upsertChat({ id: 'chat-1', title: 'Chat' });
    });

    it('returns the most recent media message with a telegram id', () => {
      db.insertMessage({ id: 'm-text', chatId: 'chat-1', direction: 'max_to_tg', type: 'text', text: 'hi', createdAt: 1000, telegramMessageId: 1 });
      db.insertMessage({ id: 'm-photo-old', chatId: 'chat-1', direction: 'max_to_tg', type: 'photo', createdAt: 2000, telegramMessageId: 2 });
      db.insertMessage({ id: 'm-photo-new', chatId: 'chat-1', direction: 'max_to_tg', type: 'photo', createdAt: 3000, telegramMessageId: 3 });
      const found = db.findRepliedMediaMessage('chat-1');
      expect(found.id).toBe('m-photo-new');
      expect(found.telegramMessageId).toBe(3);
    });

    it('ignores media without a telegram reply target', () => {
      db.insertMessage({ id: 'm-photo', chatId: 'chat-1', direction: 'max_to_tg', type: 'photo', createdAt: 2000 });
      expect(db.findRepliedMediaMessage('chat-1')).toBeNull();
    });

    it('returns null when the chat has no media', () => {
      db.insertMessage({ id: 'm-text', chatId: 'chat-1', direction: 'max_to_tg', type: 'text', text: 'hi', createdAt: 1000, telegramMessageId: 1 });
      expect(db.findRepliedMediaMessage('chat-1')).toBeNull();
    });

    it('countRepliedMediaMessages counts only valid media targets', () => {
      db.insertMessage({ id: 'm-text', chatId: 'chat-1', direction: 'max_to_tg', type: 'text', text: 'hi', createdAt: 1000, telegramMessageId: 1 });
      db.insertMessage({ id: 'm-photo-1', chatId: 'chat-1', direction: 'max_to_tg', type: 'photo', createdAt: 2000, telegramMessageId: 2 });
      expect(db.countRepliedMediaMessages('chat-1')).toBe(1);
      db.insertMessage({ id: 'm-photo-2', chatId: 'chat-1', direction: 'max_to_tg', type: 'photo', createdAt: 3000, telegramMessageId: 3 });
      expect(db.countRepliedMediaMessages('chat-1')).toBe(2);
    });
  });

  describe('findMessageByMediaToken', () => {
    beforeEach(() => {
      db.upsertChat({ id: 'chat-1', title: 'Chat' });
    });

    it('matches the original message by CDN token substring', () => {
      db.insertMessage({ id: 'm-a', chatId: 'chat-1', direction: 'max_to_tg', type: 'photo', mediaUrl: 'https://i.oneme.ru/i?r=TOKEN_A&fn=w_1280', createdAt: 1000, telegramMessageId: 10 });
      db.insertMessage({ id: 'm-b', chatId: 'chat-1', direction: 'max_to_tg', type: 'photo', mediaUrl: 'https://i.oneme.ru/i?r=TOKEN_B&fn=w_1280', createdAt: 2000, telegramMessageId: 20 });
      const found = db.findMessageByMediaToken('chat-1', 'TOKEN_A');
      expect(found.id).toBe('m-a');
      expect(found.telegramMessageId).toBe(10);
    });

    it('returns null for an unknown token or empty token', () => {
      db.insertMessage({ id: 'm-a', chatId: 'chat-1', direction: 'max_to_tg', type: 'photo', mediaUrl: 'https://i.oneme.ru/i?r=TOKEN_A&fn=w', createdAt: 1000, telegramMessageId: 10 });
      expect(db.findMessageByMediaToken('chat-1', 'NOPE')).toBeNull();
      expect(db.findMessageByMediaToken('chat-1', null)).toBeNull();
    });
  });

  describe('media_hash and getReplyMediaCandidates', () => {
    beforeEach(() => {
      db.upsertChat({ id: 'chat-1', title: 'Chat' });
    });

    it('persists and reads back media_hash', () => {
      db.insertMessage({ id: 'm-a', chatId: 'chat-1', direction: 'max_to_tg', type: 'photo', mediaHash: 'abcd1234abcd1234', createdAt: 1000, telegramMessageId: 10 });
      const candidates = db.getReplyMediaCandidates('chat-1');
      expect(candidates).toHaveLength(1);
      expect(candidates[0].mediaHash).toBe('abcd1234abcd1234');
    });

    it('only returns messages that have a hash and a reply target', () => {
      db.insertMessage({ id: 'm-hash-tgt', chatId: 'chat-1', direction: 'max_to_tg', type: 'photo', mediaHash: 'aaaa', createdAt: 3000, telegramMessageId: 30 });
      db.insertMessage({ id: 'm-hash-notgt', chatId: 'chat-1', direction: 'max_to_tg', type: 'photo', mediaHash: 'bbbb', createdAt: 2000 });
      db.insertMessage({ id: 'm-nohash', chatId: 'chat-1', direction: 'max_to_tg', type: 'photo', createdAt: 1000, telegramMessageId: 40 });
      const ids = db.getReplyMediaCandidates('chat-1').map((m) => m.id);
      expect(ids).toEqual(['m-hash-tgt']);
    });

    it('includes tg_to_max messages (reply target is source_message_id)', () => {
      db.insertMessage({ id: 'm-tg', chatId: 'chat-1', direction: 'tg_to_max', type: 'photo', mediaHash: 'cccc', sourceMessageId: '777', createdAt: 1000 });
      const candidates = db.getReplyMediaCandidates('chat-1');
      expect(candidates).toHaveLength(1);
      expect(candidates[0].id).toBe('m-tg');
    });
  });

  describe('hasForwardedMediaCopy (stale signed-URL re-forward guard)', () => {
    beforeEach(() => {
      db.upsertChat({ id: 'chat-1', title: 'Chat' });
      db.upsertChat({ id: 'chat-2', title: 'Other' });
    });

    it('matches the same bubble when only the signed URL changed', () => {
      // Same photo, same timestamp — MAX regenerated the CDN token/expires.
      db.insertMessage({
        id: 'm-first', chatId: 'chat-1', direction: 'max_to_tg', type: 'photo',
        mediaHash: '80c161f0ccccc4c4', sourceMessageId: '07:09 PM|https://i.oneme.ru/i?r=TOKEN_A&expires=111', createdAt: 1000
      });
      expect(db.hasForwardedMediaCopy('chat-1', '80c161f0ccccc4c4', '07:09 PM')).toBe(true);
    });

    it('does not match a different image at the same timestamp', () => {
      db.insertMessage({
        id: 'm-a', chatId: 'chat-1', direction: 'max_to_tg', type: 'photo',
        mediaHash: 'aaaaaaaaaaaaaaaa', sourceMessageId: '07:09 PM|https://i.oneme.ru/i?r=A', createdAt: 1000
      });
      expect(db.hasForwardedMediaCopy('chat-1', 'bbbbbbbbbbbbbbbb', '07:09 PM')).toBe(false);
    });

    it('does not match the same image sent at a different time', () => {
      db.insertMessage({
        id: 'm-a', chatId: 'chat-1', direction: 'max_to_tg', type: 'photo',
        mediaHash: 'aaaaaaaaaaaaaaaa', sourceMessageId: '07:09 PM|https://i.oneme.ru/i?r=A', createdAt: 1000
      });
      expect(db.hasForwardedMediaCopy('chat-1', 'aaaaaaaaaaaaaaaa', '09:15 AM')).toBe(false);
    });

    it('is scoped per chat', () => {
      db.insertMessage({
        id: 'm-a', chatId: 'chat-1', direction: 'max_to_tg', type: 'photo',
        mediaHash: 'aaaaaaaaaaaaaaaa', sourceMessageId: '07:09 PM|https://x', createdAt: 1000
      });
      expect(db.hasForwardedMediaCopy('chat-2', 'aaaaaaaaaaaaaaaa', '07:09 PM')).toBe(false);
    });

    it('treats LIKE wildcards in a caption literally', () => {
      db.insertMessage({
        id: 'm-a', chatId: 'chat-1', direction: 'max_to_tg', type: 'photo',
        mediaHash: 'aaaaaaaaaaaaaaaa', sourceMessageId: '100% done|https://x', createdAt: 1000
      });
      expect(db.hasForwardedMediaCopy('chat-1', 'aaaaaaaaaaaaaaaa', '100% done')).toBe(true);
      // '100_done' must not match '100% done' via the _ wildcard.
      expect(db.hasForwardedMediaCopy('chat-1', 'aaaaaaaaaaaaaaaa', '100_done')).toBe(false);
    });

    it('returns false when hash or chat is missing', () => {
      expect(db.hasForwardedMediaCopy('chat-1', null, '07:09 PM')).toBe(false);
      expect(db.hasForwardedMediaCopy(null, 'aaaa', '07:09 PM')).toBe(false);
    });
  });

  describe('max_fingerprint and getTgToMaxMessageBySourceId', () => {
    beforeEach(() => {
      db.upsertChat({ id: 'chat-1', title: 'Chat' });
    });

    it('persists and reads back max_fingerprint', () => {
      db.insertMessage({
        id: 'm-a', chatId: 'chat-1', direction: 'tg_to_max', type: 'text', text: 'hi',
        sourceMessageId: '555', maxFingerprint: 'Me|02:38 PM|hi|', createdAt: 1000
      });
      const found = db.getTgToMaxMessageBySourceId('555');
      expect(found.maxFingerprint).toBe('Me|02:38 PM|hi|');
    });

    it('returns null when no tg_to_max message matches the source id', () => {
      expect(db.getTgToMaxMessageBySourceId('999')).toBeNull();
    });

    it('does not match a max_to_tg message even with the same source_message_id value', () => {
      db.insertMessage({
        id: 'm-b', chatId: 'chat-1', direction: 'max_to_tg', type: 'text', text: 'hi',
        sourceMessageId: '555', createdAt: 1000
      });
      expect(db.getTgToMaxMessageBySourceId('555')).toBeNull();
    });

    it('returns the most recent match when called multiple times for the same id', () => {
      db.insertMessage({ id: 'm-old', chatId: 'chat-1', direction: 'tg_to_max', type: 'text', sourceMessageId: '1', maxFingerprint: 'old', createdAt: 1000 });
      db.insertMessage({ id: 'm-new', chatId: 'chat-1', direction: 'tg_to_max', type: 'text', sourceMessageId: '1', maxFingerprint: 'new', createdAt: 2000 });
      expect(db.getTgToMaxMessageBySourceId('1').maxFingerprint).toBe('new');
    });
  });

  describe('settings', () => {
    it('sets and gets a setting', () => {
      db.setSetting('theme', 'dark');
      expect(db.getSetting('theme')).toBe('dark');
    });

    it('returns fallback for missing setting', () => {
      expect(db.getSetting('nonexistent', 'default')).toBe('default');
    });

    it('returns null fallback by default', () => {
      expect(db.getSetting('nonexistent')).toBeNull();
    });

    it('updates existing setting', () => {
      db.setSetting('key', 'old');
      db.setSetting('key', 'new');
      expect(db.getSetting('key')).toBe('new');
    });

    it('stores complex values as JSON', () => {
      db.setSetting('complex', { nested: [1, 2, 3] });
      expect(db.getSetting('complex')).toEqual({ nested: [1, 2, 3] });
    });
  });

  describe('message deliveries', () => {
    it('creates a delivery record', () => {
      const id = db.createDelivery('msg-1', 'max_to_tg');
      expect(id).toBeGreaterThan(0);
    });

    it('lists pending deliveries', () => {
      db.createDelivery('msg-1', 'max_to_tg');
      db.createDelivery('msg-2', 'tg_to_max');
      const pending = db.getPendingDeliveries(10);
      expect(pending).toHaveLength(2);
      expect(pending[0].message_id).toBe('msg-1');
      expect(pending[0].status).toBe('pending');
    });

    it('updates delivery status to sent', () => {
      const id = db.createDelivery('msg-1', 'max_to_tg');
      db.updateDeliveryStatus(id, 'sent');
      const pending = db.getPendingDeliveries(10);
      expect(pending).toHaveLength(0);
    });

    it('updates delivery status to failed with error', () => {
      const id = db.createDelivery('msg-1', 'max_to_tg');
      db.updateDeliveryStatus(id, 'failed', 'Network timeout');
      const failed = db.getFailedDeliveries(10);
      expect(failed).toHaveLength(1);
      expect(failed[0].last_error).toBe('Network timeout');
    });

    it('increments attempts on each update', () => {
      const id = db.createDelivery('msg-1', 'max_to_tg');
      db.updateDeliveryStatus(id, 'failed', 'Error 1');
      db.updateDeliveryStatus(id, 'failed', 'Error 2');
      const failed = db.getFailedDeliveries(10);
      expect(failed[0].attempts).toBe(2);
    });

    it('returns delivery stats', () => {
      db.createDelivery('msg-1', 'max_to_tg');
      db.createDelivery('msg-2', 'max_to_tg');
      const id3 = db.createDelivery('msg-3', 'tg_to_max');
      db.updateDeliveryStatus(id3, 'sent');

      const stats = db.getDeliveryStats();
      const pending = stats.find((s) => s.status === 'pending');
      const sent = stats.find((s) => s.status === 'sent');
      expect(pending.count).toBe(2);
      expect(sent.count).toBe(1);
    });

    it('respects limit on pending deliveries', () => {
      for (let i = 0; i < 5; i++) {
        db.createDelivery(`msg-${i}`, 'max_to_tg');
      }
      const pending = db.getPendingDeliveries(3);
      expect(pending).toHaveLength(3);
    });

    it('counts failed deliveries per message and direction', () => {
      const a1 = db.createDelivery('msg-1', 'max_to_tg');
      db.updateDeliveryStatus(a1, 'failed', 'boom');
      const a2 = db.createDelivery('msg-1', 'max_to_tg');
      db.updateDeliveryStatus(a2, 'failed', 'boom again');
      // A sent attempt and a different direction must not be counted.
      const a3 = db.createDelivery('msg-1', 'max_to_tg');
      db.updateDeliveryStatus(a3, 'sent');
      const other = db.createDelivery('msg-1', 'tg_to_max');
      db.updateDeliveryStatus(other, 'failed', 'unrelated');

      expect(db.countFailedDeliveries('msg-1', 'max_to_tg')).toBe(2);
      expect(db.countFailedDeliveries('msg-1', 'tg_to_max')).toBe(1);
      expect(db.countFailedDeliveries('msg-unknown', 'max_to_tg')).toBe(0);
    });
  });
});
