import { describe, it, expect, vi } from 'vitest';
import { normalizeEmoji, toTelegramReaction, reactionCandidates } from '../../src/domain/reactions.js';
import { TelegramBotAdapter } from '../../src/adapters/telegramBot.js';
import { AppDatabase } from '../../src/storage/database.js';

describe('reaction emoji', () => {
  it('compares emoji without variation selectors and skin tones', () => {
    expect(normalizeEmoji('❤️')).toBe('❤');
    expect(normalizeEmoji('👍🏽')).toBe('👍');
    expect(normalizeEmoji(null)).toBe('');
  });

  it('maps to a reaction a Telegram bot may set, or its nearest relative', () => {
    expect(toTelegramReaction('👍')).toBe('👍');
    expect(toTelegramReaction('❤️')).toBe('❤');
    expect(toTelegramReaction('😂')).toBe('🤣');
    expect(toTelegramReaction('😮')).toBe('🤯');
    expect(toTelegramReaction('💙')).toBe('❤');
    expect(toTelegramReaction('🦖')).toBeNull();
  });

  it('offers MAX the emoji first, then its relatives', () => {
    expect(reactionCandidates('🤣').slice(0, 2)).toEqual(['🤣', '😂']);
    expect(reactionCandidates('👍')).toEqual(['👍']);
    expect(reactionCandidates('')).toEqual([]);
  });
});

const OWNER_ID = 555;
const RELAY_ID = -1001234567890;
let updateId = 0;

const makeAdapter = () => {
  const adapter = new TelegramBotAdapter({
    token: 'test:token',
    ownerId: OWNER_ID,
    relayChatId: RELAY_ID,
    useTopics: true,
    autoCreateTopics: true
  }, {});
  adapter.bot.botInfo = { id: 1, is_bot: true, username: 'testbot', first_name: 'test' };
  const api = { setMessageReaction: vi.fn(async () => true), sendMessage: vi.fn(async () => ({ message_id: 1 })) };
  adapter.bot.context.telegram = api;
  Object.assign(adapter.bot.telegram, api);
  return { adapter, api };
};

const reactionUpdate = ({ chatId = RELAY_ID, fromId = OWNER_ID, messageId = 55, oldReaction = [], newReaction = [] } = {}) => ({
  update_id: ++updateId,
  message_reaction: {
    chat: { id: chatId, type: chatId === OWNER_ID ? 'private' : 'supergroup', title: 'relay', is_forum: true },
    message_id: messageId,
    user: { id: fromId, is_bot: false, first_name: 'user' },
    date: 1700000000,
    old_reaction: oldReaction,
    new_reaction: newReaction
  }
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 10));

describe('Telegram adapter: reactions', () => {
  it('asks Telegram for reaction updates when it starts polling', async () => {
    const { adapter } = makeAdapter();
    adapter.bot.launch = vi.fn((options, onLaunch) => { onLaunch(); return new Promise(() => {}); });
    adapter.publishCommandMenu = vi.fn();
    await adapter.start();
    expect(adapter.bot.launch.mock.calls[0][0].allowedUpdates).toEqual(expect.arrayContaining(['message', 'my_chat_member', 'message_reaction']));
  });

  it('hands the owner\'s reaction to the bridge', async () => {
    const { adapter } = makeAdapter();
    const handler = vi.fn(async () => {});
    adapter.onReaction(handler);

    await adapter.bot.handleUpdate(reactionUpdate({ oldReaction: [{ type: 'emoji', emoji: '👍' }], newReaction: [{ type: 'emoji', emoji: '🔥' }] }));
    await flush();

    expect(handler).toHaveBeenCalledWith({
      telegramChatId: RELAY_ID,
      telegramMessageId: 55,
      emojis: ['🔥'],
      previousEmojis: ['👍'],
      otherReactions: 0
    });
  });

  it('counts custom-emoji reactions separately', async () => {
    const { adapter } = makeAdapter();
    const handler = vi.fn(async () => {});
    adapter.onReaction(handler);

    await adapter.bot.handleUpdate(reactionUpdate({ newReaction: [{ type: 'custom_emoji', custom_emoji_id: '5368324170671202286' }] }));
    await flush();

    expect(handler.mock.calls[0][0]).toMatchObject({ emojis: [], otherReactions: 1 });
  });

  it('ignores reactions of anyone but the owner', async () => {
    const { adapter } = makeAdapter();
    const handler = vi.fn(async () => {});
    adapter.onReaction(handler);

    await adapter.bot.handleUpdate(reactionUpdate({ fromId: 777, newReaction: [{ type: 'emoji', emoji: '👍' }] }));
    await flush();

    expect(handler).not.toHaveBeenCalled();
  });

  it('does not hold up polling while a reaction is mirrored, and keeps the order', async () => {
    const { adapter } = makeAdapter();
    const seen = [];
    let release;
    adapter.onReaction(async (reaction) => {
      if (!seen.length) await new Promise((resolve) => { release = resolve; });
      seen.push(reaction.emojis[0]);
    });

    await adapter.bot.handleUpdate(reactionUpdate({ newReaction: [{ type: 'emoji', emoji: '👍' }] }));
    await adapter.bot.handleUpdate(reactionUpdate({ newReaction: [{ type: 'emoji', emoji: '🔥' }] }));
    expect(seen).toEqual([]);
    release();
    await flush();
    expect(seen).toEqual(['👍', '🔥']);
  });

  it('keeps going after a failed mirror', async () => {
    const { adapter } = makeAdapter();
    const handler = vi.fn().mockRejectedValueOnce(new Error('page gone')).mockResolvedValue(undefined);
    adapter.onReaction(handler);

    await adapter.bot.handleUpdate(reactionUpdate({ newReaction: [{ type: 'emoji', emoji: '👍' }] }));
    await adapter.bot.handleUpdate(reactionUpdate({ newReaction: [{ type: 'emoji', emoji: '🔥' }] }));
    await flush();

    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('sets and clears the bot\'s reaction', async () => {
    const { adapter, api } = makeAdapter();
    await adapter.setReaction(RELAY_ID, 55, '🤣');
    await adapter.setReaction(RELAY_ID, 55, null);
    expect(api.setMessageReaction.mock.calls).toEqual([
      [RELAY_ID, 55, [{ type: 'emoji', emoji: '🤣' }]],
      [RELAY_ID, 55, []]
    ]);
  });
});

describe('database: finding what a reaction points at', () => {
  // Messages belong to a known chat (foreign key).
  const withChat = () => {
    const db = new AppDatabase(':memory:');
    db.upsertChat({ id: 'chat-a', title: 'chat-a', lastSeenAt: Date.now(), metadata: {} });
    return db;
  };
  const insert = (db, id, fields) => db.insertMessage({
    id,
    chatId: 'chat-a',
    direction: 'max_to_tg',
    type: 'text',
    text: id,
    sourceMessageId: `fp-${id}`,
    createdAt: Date.now(),
    metadata: {},
    ...fields
  });

  it('lists every message a Telegram id may refer to, newest first', () => {
    const db = withChat();
    insert(db, 'a', { telegramMessageId: 7, createdAt: 1000 });
    insert(db, 'b', { telegramMessageId: 7, createdAt: 2000 });
    insert(db, 'c', { telegramMessageId: 8 });
    expect(db.listMessagesByTelegramMessageId(7).map((m) => m.id)).toEqual(['b', 'a']);
  });

  it('finds our own message by its MAX bubble through an index', () => {
    const db = withChat();
    insert(db, 'own', { direction: 'tg_to_max', sourceMessageId: '601', maxFingerprint: '12:06|Моё сообщение' });
    expect(db.getTgToMaxMessageByMaxFingerprint('chat-a', '12:06|Моё сообщение')?.id).toBe('own');
    expect(db.listTgToMaxMessagesBySourceId(601).map((m) => m.id)).toEqual(['own']);
    const plan = db.db.prepare(`EXPLAIN QUERY PLAN SELECT * FROM messages
      WHERE chat_id = ? AND direction = 'tg_to_max' AND max_fingerprint = ? ORDER BY created_at DESC LIMIT 1`).all('chat-a', 'x');
    expect(plan.map((step) => step.detail).join(' ')).toContain('idx_messages_chat_max_fingerprint');
  });

  it('updates a message\'s metadata', () => {
    const db = withChat();
    insert(db, 'a', { metadata: { author: 'Bob' } });
    db.updateMessageMetadata('a', { author: 'Bob', mirroredReaction: '👍' });
    expect(db.getMessage('a').metadata).toEqual({ author: 'Bob', mirroredReaction: '👍' });
  });
});
