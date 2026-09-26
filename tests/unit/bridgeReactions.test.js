import { describe, it, expect, vi } from 'vitest';
import { stableId } from '../../src/domain/messages.js';
import { mirroredReaction } from '../../src/services/bridge.js';
import { makeBridge, makeFakeMaxClient, makeFakeTelegramBot, makeTestConfig, linkChat, maxMessage } from '../helpers/bridgeHarness.js';

// Reactions travel both ways. MAX -> Telegram: what other people put on a
// message in MAX shows as the bot's reaction on the bridged Telegram message.
// Telegram -> MAX: the owner's reaction on a bridged message becomes their
// reaction in MAX.

const RELAY = -100500;

const setup = ({ maxClient = {}, telegramBot = {}, config = {} } = {}) => makeBridge({
  maxClient: makeFakeMaxClient({
    readReactions: vi.fn(async () => []),
    reactToMessage: vi.fn(async () => ({ ok: true, changed: true })),
    ...maxClient
  }),
  telegramBot: makeFakeTelegramBot({
    setReaction: vi.fn(async () => true),
    onReaction: vi.fn(),
    ...telegramBot
  }),
  config: makeTestConfig({ reactionsEnabled: true, ...config })
});

// A MAX message the bridge forwarded, as pollMax stores it.
const forwarded = (db, chatId, rawId, { telegramMessageId = 501, telegramChatId = RELAY, type = 'text', mediaUrl = null } = {}) => {
  const message = {
    ...maxMessage(stableId('max', chatId, rawId), chatId, { type, mediaUrl, sourceMessageId: rawId }),
    telegramMessageId,
    metadata: telegramChatId ? { telegramChatId } : {}
  };
  db.insertMessage(message);
  return message;
};

// The owner's own message, typed in Telegram and sent into MAX.
const ownSent = (db, chatId, { telegramMessageId = 601, maxFingerprint = '12:06|Моё сообщение', telegramChatId = RELAY, telegramThreadId = 77 } = {}) => {
  db.insertMessage({
    id: `tg-own-${telegramMessageId}`,
    chatId,
    direction: 'tg_to_max',
    type: 'text',
    text: 'Моё сообщение',
    sourceMessageId: String(telegramMessageId),
    createdAt: Date.now(),
    metadata: { telegramChatId, telegramThreadId },
    maxFingerprint
  });
};

const row = (rawId, reactions, extra = {}) => ({ rawId, outgoing: false, reactions, reactionsUnknown: false, ...extra });

describe('mirroredReaction', () => {
  it('is the most used reaction of other people that a bot may set', () => {
    expect(mirroredReaction([{ emoji: '👍', count: 1, active: false }])).toBe('👍');
    expect(mirroredReaction([{ emoji: '❤️', count: 2, active: true }])).toBe('❤');
    expect(mirroredReaction([{ emoji: '🦖', count: 3, active: false }, { emoji: '🔥', count: 1, active: false }])).toBe('🔥');
  });

  it('leaves out the owner\'s own reaction', () => {
    expect(mirroredReaction([{ emoji: '❤️', count: 1, active: true }])).toBeNull();
    expect(mirroredReaction([])).toBeNull();
    expect(mirroredReaction(undefined)).toBeNull();
  });
});

describe('MAX -> Telegram', () => {
  it('shows a MAX reaction as the bot\'s reaction on the forwarded message, once', async () => {
    const { bridge, db, maxClient, telegramBot } = setup();
    linkChat(db, 'chat-a');
    const message = forwarded(db, 'chat-a', '12:00|Привет');
    maxClient.readReactions.mockResolvedValue([row('12:00|Привет', [{ emoji: '👍', count: 1, active: false }])]);

    await bridge.syncReactionsFromMax({ id: 'chat-a' });
    await bridge.syncReactionsFromMax({ id: 'chat-a' });

    expect(telegramBot.setReaction).toHaveBeenCalledTimes(1);
    expect(telegramBot.setReaction).toHaveBeenCalledWith(RELAY, 501, '👍');
    expect(db.getMessage(message.id).metadata.mirroredReaction).toBe('👍');
  });

  it('takes the bot\'s reaction back when the MAX reaction goes away', async () => {
    const { bridge, db, maxClient, telegramBot } = setup();
    linkChat(db, 'chat-a');
    forwarded(db, 'chat-a', '12:00|Привет');
    maxClient.readReactions.mockResolvedValueOnce([row('12:00|Привет', [{ emoji: '👍', count: 1, active: false }])]);
    await bridge.syncReactionsFromMax({ id: 'chat-a' });
    maxClient.readReactions.mockResolvedValueOnce([row('12:00|Привет', [])]);
    await bridge.syncReactionsFromMax({ id: 'chat-a' });

    expect(telegramBot.setReaction).toHaveBeenLastCalledWith(RELAY, 501, null);
  });

  it('does not echo the owner\'s own MAX reaction back', async () => {
    const { bridge, db, maxClient, telegramBot } = setup();
    linkChat(db, 'chat-a');
    forwarded(db, 'chat-a', '12:00|Привет');
    maxClient.readReactions.mockResolvedValue([row('12:00|Привет', [{ emoji: '🔥', count: 1, active: true }])]);

    await bridge.syncReactionsFromMax({ id: 'chat-a' });

    expect(telegramBot.setReaction).not.toHaveBeenCalled();
  });

  it('does not guess when a reaction chip could not be read', async () => {
    const { bridge, db, maxClient, telegramBot } = setup();
    linkChat(db, 'chat-a');
    forwarded(db, 'chat-a', '12:00|Привет');
    maxClient.readReactions.mockResolvedValue([row('12:00|Привет', [], { reactionsUnknown: true })]);

    await bridge.syncReactionsFromMax({ id: 'chat-a' });

    expect(telegramBot.setReaction).not.toHaveBeenCalled();
  });

  it('puts the contact\'s reaction on the owner\'s own Telegram message', async () => {
    const { bridge, db, maxClient, telegramBot } = setup();
    linkChat(db, 'chat-a');
    ownSent(db, 'chat-a', { telegramMessageId: 601, telegramChatId: 12345 });
    maxClient.readReactions.mockResolvedValue([row('12:06|Моё сообщение', [{ emoji: '😂', count: 1, active: false }], { outgoing: true })]);

    await bridge.syncReactionsFromMax({ id: 'chat-a' });

    // Telegram has no 😂 for bots: its nearest relative stands in.
    expect(telegramBot.setReaction).toHaveBeenCalledWith(12345, 601, '🤣');
  });

  it('finds the owner\'s own file by its media token', async () => {
    const { bridge, db, maxClient, telegramBot } = setup();
    linkChat(db, 'chat-a');
    ownSent(db, 'chat-a', { telegramMessageId: 602, maxFingerprint: 'media-token:PIC1', telegramChatId: 12345 });
    maxClient.readReactions.mockResolvedValue([row('12:07|https://i.oneme.ru/i?r=PIC1&sig=x', [{ emoji: '🔥', count: 1, active: false }], { outgoing: true, mediaToken: 'PIC1' })]);

    await bridge.syncReactionsFromMax({ id: 'chat-a' });

    expect(telegramBot.setReaction).toHaveBeenCalledWith(12345, 602, '🔥');
  });

  it('skips bubbles that were never delivered to Telegram', async () => {
    const { bridge, db, maxClient, telegramBot } = setup();
    linkChat(db, 'chat-a');
    forwarded(db, 'chat-a', '12:00|primed', { telegramMessageId: null });
    maxClient.readReactions.mockResolvedValue([
      row('12:00|primed', [{ emoji: '👍', count: 1, active: false }]),
      row('12:01|unknown', [{ emoji: '👍', count: 1, active: false }])
    ]);

    await bridge.syncReactionsFromMax({ id: 'chat-a' });

    expect(telegramBot.setReaction).not.toHaveBeenCalled();
  });

  it('pauses on Telegram flood control and tries again later', async () => {
    const floodError = Object.assign(new Error('429: Too Many Requests'), { code: 429, parameters: { retry_after: 7 } });
    const { bridge, db, maxClient, telegramBot } = setup({ telegramBot: { setReaction: vi.fn().mockRejectedValueOnce(floodError).mockResolvedValue(true) } });
    linkChat(db, 'chat-a');
    const message = forwarded(db, 'chat-a', '12:00|Привет');
    maxClient.readReactions.mockResolvedValue([row('12:00|Привет', [{ emoji: '👍', count: 1, active: false }])]);

    await bridge.syncReactionsFromMax({ id: 'chat-a' });
    expect(bridge.telegramPaused()).toBe(true);
    expect(db.getMessage(message.id).metadata.mirroredReaction).toBeUndefined();

    bridge.telegramPausedUntil = 0;
    await bridge.syncReactionsFromMax({ id: 'chat-a' });
    expect(telegramBot.setReaction).toHaveBeenCalledTimes(2);
    expect(db.getMessage(message.id).metadata.mirroredReaction).toBe('👍');
  });

  it('records a reaction Telegram refused, so it is not retried every poll', async () => {
    const { bridge, db, maxClient, telegramBot } = setup({ telegramBot: { setReaction: vi.fn(async () => { throw new Error('400: Bad Request: REACTION_INVALID'); }) } });
    linkChat(db, 'chat-a');
    forwarded(db, 'chat-a', '12:00|Привет');
    maxClient.readReactions.mockResolvedValue([row('12:00|Привет', [{ emoji: '👍', count: 1, active: false }])]);

    await bridge.syncReactionsFromMax({ id: 'chat-a' });
    await bridge.syncReactionsFromMax({ id: 'chat-a' });

    expect(telegramBot.setReaction).toHaveBeenCalledTimes(1);
  });

  it('only trusts the current route for an old record when the route has not changed since', async () => {
    const { bridge, db, maxClient, telegramBot } = setup();
    linkChat(db, 'chat-a');
    const old = forwarded(db, 'chat-a', '12:00|old', { telegramChatId: null });
    db.upsertChatMapping({ ...db.getChatMapping('chat-a'), telegramChatId: -100999, metadata: { topicIntroMessageId: 1 } });
    db.db.prepare('UPDATE chat_mappings SET updated_at = ? WHERE max_chat_id = ?').run(old.createdAt + 1000, 'chat-a');
    maxClient.readReactions.mockResolvedValue([row('12:00|old', [{ emoji: '👍', count: 1, active: false }])]);

    await bridge.syncReactionsFromMax({ id: 'chat-a' });

    expect(telegramBot.setReaction).not.toHaveBeenCalled();
  });

  it('is off with SYNC_REACTIONS=false', async () => {
    const { bridge, db, maxClient, telegramBot } = setup({ config: { reactionsEnabled: false } });
    linkChat(db, 'chat-a');
    forwarded(db, 'chat-a', '12:00|Привет');
    maxClient.readReactions.mockResolvedValue([row('12:00|Привет', [{ emoji: '👍', count: 1, active: false }])]);

    await bridge.syncReactionsFromMax({ id: 'chat-a' });

    expect(maxClient.readReactions).not.toHaveBeenCalled();
    expect(telegramBot.setReaction).not.toHaveBeenCalled();
  });

  it('runs as part of polling, after the chat\'s messages are forwarded', async () => {
    const { bridge, db, maxClient, telegramBot } = setup();
    linkChat(db, 'chat-a', { unread: true });
    const incoming = maxMessage(stableId('max', 'chat-a', '12:00|Привет'), 'chat-a', { sourceMessageId: '12:00|Привет' });
    maxClient.readMessages.mockResolvedValue([incoming]);
    maxClient.readReactions.mockResolvedValue([row('12:00|Привет', [{ emoji: '🔥', count: 1, active: false }])]);

    await bridge.pollMax();

    const stored = db.getMessage(incoming.id);
    expect(stored.telegramMessageId).toBeTruthy();
    expect(stored.metadata.telegramChatId).toBe(RELAY);
    expect(telegramBot.setReaction).toHaveBeenCalledWith(RELAY, stored.telegramMessageId, '🔥');
  });
});

describe('Telegram -> MAX', () => {
  it('sets the owner\'s reaction on the MAX message it was forwarded from', async () => {
    const { bridge, db, maxClient } = setup();
    linkChat(db, 'chat-a');
    forwarded(db, 'chat-a', '12:00|Привет');

    await bridge.handleTelegramReaction({ telegramChatId: RELAY, telegramMessageId: 501, emojis: ['👍'], previousEmojis: [] });

    expect(maxClient.reactToMessage).toHaveBeenCalledWith('chat-a', '12:00|Привет', ['👍']);
  });

  it('asks MAX for the nearest relative when it lacks the emoji', async () => {
    const { bridge, db, maxClient } = setup();
    linkChat(db, 'chat-a');
    forwarded(db, 'chat-a', '12:00|Привет');

    await bridge.handleTelegramReaction({ telegramChatId: RELAY, telegramMessageId: 501, emojis: ['🤣'], previousEmojis: [] });

    expect(maxClient.reactToMessage.mock.calls[0][2].slice(0, 2)).toEqual(['🤣', '😂']);
  });

  it('finds a media message by its CDN token', async () => {
    const { bridge, db, maxClient } = setup();
    linkChat(db, 'chat-a');
    forwarded(db, 'chat-a', '12:04|https://i.oneme.ru/i?r=TOKEN1&fn=w_1280', { type: 'photo', mediaUrl: 'https://i.oneme.ru/i?r=TOKEN1&fn=w_1280' });

    await bridge.handleTelegramReaction({ telegramChatId: RELAY, telegramMessageId: 501, emojis: ['❤'], previousEmojis: [] });

    expect(maxClient.reactToMessage.mock.calls[0][0]).toBe('chat-a');
    expect(maxClient.reactToMessage.mock.calls[0][1]).toBe('media-token:TOKEN1');
    expect(maxClient.reactToMessage.mock.calls[0][2][0]).toBe('❤');
  });

  it('reacts on the owner\'s own message in MAX too', async () => {
    const { bridge, db, maxClient } = setup();
    linkChat(db, 'chat-a');
    ownSent(db, 'chat-a', { telegramMessageId: 601 });

    await bridge.handleTelegramReaction({ telegramChatId: RELAY, telegramMessageId: 601, emojis: ['🔥'], previousEmojis: [] });

    expect(maxClient.reactToMessage).toHaveBeenCalledWith('chat-a', '12:06|Моё сообщение', ['🔥']);
  });

  it('takes the reaction back', async () => {
    const { bridge, db, maxClient } = setup();
    linkChat(db, 'chat-a');
    forwarded(db, 'chat-a', '12:00|Привет');

    await bridge.handleTelegramReaction({ telegramChatId: RELAY, telegramMessageId: 501, emojis: [], previousEmojis: ['👍'] });

    expect(maxClient.reactToMessage).toHaveBeenCalledWith('chat-a', '12:00|Привет', null);
  });

  it('with several reactions (Telegram Premium), uses the one just added, or what is left', async () => {
    const { bridge, db, maxClient } = setup();
    linkChat(db, 'chat-a');
    forwarded(db, 'chat-a', '12:00|Привет');

    await bridge.handleTelegramReaction({ telegramChatId: RELAY, telegramMessageId: 501, emojis: ['👍', '🔥'], previousEmojis: ['👍'] });
    await bridge.handleTelegramReaction({ telegramChatId: RELAY, telegramMessageId: 501, emojis: ['👍'], previousEmojis: ['👍', '🔥'] });

    expect(maxClient.reactToMessage.mock.calls.map((call) => call[2][0])).toEqual(['🔥', '👍']);
  });

  it('ignores a custom-emoji reaction instead of treating it as a removal', async () => {
    const { bridge, db, maxClient } = setup();
    linkChat(db, 'chat-a');
    forwarded(db, 'chat-a', '12:00|Привет');

    await bridge.handleTelegramReaction({ telegramChatId: RELAY, telegramMessageId: 501, emojis: [], previousEmojis: [], otherReactions: 1 });

    expect(maxClient.reactToMessage).not.toHaveBeenCalled();
  });

  it('ignores a message id from another Telegram chat', async () => {
    const { bridge, db, maxClient } = setup();
    linkChat(db, 'chat-a');
    forwarded(db, 'chat-a', '12:00|Привет');
    ownSent(db, 'chat-a', { telegramMessageId: 501, telegramChatId: RELAY });

    await bridge.handleTelegramReaction({ telegramChatId: 12345, telegramMessageId: 501, emojis: ['👍'], previousEmojis: [] });

    expect(maxClient.reactToMessage).not.toHaveBeenCalled();
  });

  it('tells the owner, once, when the emoji does not exist in MAX', async () => {
    const { bridge, db, maxClient, telegramBot } = setup({
      maxClient: { reactToMessage: vi.fn(async () => ({ ok: false, reason: 'emoji-not-available', available: ['👍', '❤️'] })) }
    });
    linkChat(db, 'chat-a');
    forwarded(db, 'chat-a', '12:00|Привет');

    await bridge.handleTelegramReaction({ telegramChatId: RELAY, telegramMessageId: 501, emojis: ['🤡'], previousEmojis: [] });
    await bridge.handleTelegramReaction({ telegramChatId: RELAY, telegramMessageId: 501, emojis: ['🤡'], previousEmojis: [] });

    expect(maxClient.reactToMessage).toHaveBeenCalledTimes(2);
    expect(telegramBot.sendText).toHaveBeenCalledTimes(1);
    const [text, route] = telegramBot.sendText.mock.calls[0];
    expect(text).toContain('🤡');
    expect(text).toContain('👍 ❤️');
    expect(route).toEqual({ telegramChatId: RELAY, telegramThreadId: 77 });
  });

  it('says so when MAX is not connected, without touching the page', async () => {
    const { bridge, db, maxClient, telegramBot } = setup();
    linkChat(db, 'chat-a');
    forwarded(db, 'chat-a', '12:00|Привет');
    maxClient.page = null;

    await bridge.handleTelegramReaction({ telegramChatId: RELAY, telegramMessageId: 501, emojis: ['👍'], previousEmojis: [] });

    expect(maxClient.reactToMessage).not.toHaveBeenCalled();
    expect(telegramBot.sendText.mock.calls[0][0]).toContain('MAX ещё не подключён');
  });

  it('holds the MAX page lock while reacting', async () => {
    let release;
    const { bridge, db, maxClient } = setup();
    linkChat(db, 'chat-a');
    forwarded(db, 'chat-a', '12:00|Привет');
    const busy = bridge.maxLock.run(() => new Promise((resolve) => { release = resolve; }));

    const reacting = bridge.handleTelegramReaction({ telegramChatId: RELAY, telegramMessageId: 501, emojis: ['👍'], previousEmojis: [] });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(maxClient.reactToMessage).not.toHaveBeenCalled();
    release();
    await busy;
    await reacting;
    expect(maxClient.reactToMessage).toHaveBeenCalledTimes(1);
  });

  it('is wired to the Telegram adapter on start', () => {
    const { bridge, telegramBot } = setup({ telegramBot: { onMute: vi.fn(), onUnmute: vi.fn() } });
    bridge.bindTelegramHandlers();
    expect(telegramBot.onReaction).toHaveBeenCalledTimes(1);
  });
});
