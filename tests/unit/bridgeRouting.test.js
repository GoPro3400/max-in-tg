import { describe, it, expect, vi } from 'vitest';
import {
  makeBridge,
  makeFakeTelegramBot,
  makeTestConfig,
  linkChat,
  maxMessage
} from '../helpers/bridgeHarness.js';

// Routes (MAX chat -> Telegram topic) have to survive the things people do to
// a Telegram group: delete a topic, move the bridge with /relay, remove the
// bot, merge a duplicate chat. Each of these used to leave a route that looked
// fine and silently dropped or misrouted messages.

const RELAY = -100500;
const NEW_RELAY = -100999;

function routedBridge(overrides = {}) {
  const parts = makeBridge(overrides);
  parts.bridge.lastChatRefreshAt = Date.now();
  return parts;
}

describe('routing recovery', () => {
  it('a deleted topic is recreated instead of dropping every later message', async () => {
    const { bridge, db, maxClient, telegramBot } = routedBridge();
    linkChat(db, 'chat-a', { unread: true, telegramThreadId: 77 });
    maxClient.readMessages.mockResolvedValue([maxMessage('m1', 'chat-a')]);
    telegramBot.sendMessage.mockRejectedValueOnce(new Error('400: Bad Request: message thread not found'));
    telegramBot.createTopic.mockResolvedValue(88);

    await bridge.pollMax(); // fails, forgets thread 77
    expect(db.getChatMapping('chat-a').telegramThreadId).toBeNull();
    expect(db.countFailedDeliveries('m1', 'max_to_tg')).toBe(0);

    await bridge.pollMax(); // new topic, delivered

    expect(telegramBot.createTopic).toHaveBeenCalledTimes(1);
    expect(db.getChatMapping('chat-a').telegramThreadId).toBe(88);
    expect(telegramBot.sendMessage.mock.calls.at(-1)[1].telegramThreadId).toBe(88);
    expect(db.hasMessage('m1')).toBe(true);
  });

  it('after /relay moved the bridge, a chat gets a topic in the NEW group', async () => {
    let target = RELAY;
    const telegramBot = makeFakeTelegramBot({ targetChatId: vi.fn(() => target), createTopic: vi.fn(async () => 5) });
    const { bridge, db, config } = routedBridge({ telegramBot });
    linkChat(db, 'chat-a', { telegramChatId: RELAY, telegramThreadId: 77 });

    // /relay in another group
    config.telegram.relayChatId = NEW_RELAY;
    target = NEW_RELAY;
    await bridge.forwardMaxMessage(maxMessage('m1', 'chat-a'));

    const mapping = db.getChatMapping('chat-a');
    expect(mapping.telegramChatId).toBe(NEW_RELAY);
    expect(mapping.telegramThreadId).toBe(5);
    expect(telegramBot.sendMessage.mock.calls.at(-1)[1]).toMatchObject({ telegramChatId: NEW_RELAY, telegramThreadId: 5 });
  });

  it('removed from the relay group: falls back to the private chat and tells the owner', async () => {
    const OWNER = 12345;
    let target = RELAY;
    const telegramBot = makeFakeTelegramBot({ targetChatId: vi.fn(() => target) });
    const { bridge, db, maxClient, config } = routedBridge({ telegramBot });
    linkChat(db, 'chat-a', { unread: true, telegramChatId: RELAY, telegramThreadId: 77 });
    maxClient.readMessages.mockResolvedValue([maxMessage('m1', 'chat-a')]);
    telegramBot.sendMessage.mockImplementationOnce(async () => {
      throw new Error('403: Forbidden: bot was kicked from the supergroup chat');
    });
    telegramBot.targetChatId.mockImplementation(() => config.telegram.relayChatId || OWNER);

    await bridge.pollMax();

    expect(config.telegram.relayChatId).toBeNull();
    expect(db.getSetting('telegram_relay_chat_id')).toBe('');
    expect(telegramBot.sendOwnerText).toHaveBeenCalledTimes(1);
    expect(db.countFailedDeliveries('m1', 'max_to_tg')).toBe(0);

    await bridge.pollMax();

    const [, route] = telegramBot.sendMessage.mock.calls.at(-1);
    expect(route).toMatchObject({ telegramChatId: OWNER, telegramThreadId: null });
    expect(db.hasMessage('m1')).toBe(true);
  });

  it('a 429 on topic creation is retried later, not latched until /sync', async () => {
    const { bridge, db, telegramBot } = routedBridge();
    db.upsertChat({ id: 'new-chat', title: 'New', metadata: {} });
    telegramBot.createTopic
      .mockRejectedValueOnce(Object.assign(new Error('429: Too Many Requests: retry after 1'), { code: 429, parameters: { retry_after: 1 } }))
      .mockResolvedValue(42);

    expect(await bridge.ensureMapping({ id: 'new-chat', title: 'New' })).toBeNull();
    expect(bridge.topicCreationBlockedReason).toBeNull();
    bridge.topicCreationRetryAt = Date.now() - 1; // the window has passed

    const mapping = await bridge.ensureMapping({ id: 'new-chat', title: 'New' });
    expect(mapping.telegramThreadId).toBe(42);
  });

  it('a missing admin right still latches until /sync, with the reason shown', async () => {
    const { bridge, db, telegramBot } = routedBridge();
    db.upsertChat({ id: 'new-chat', title: 'New', metadata: {} });
    telegramBot.createTopic.mockRejectedValue(new Error('400: Bad Request: not enough rights to create a topic'));

    await bridge.ensureMapping({ id: 'new-chat', title: 'New' });
    await bridge.ensureMapping({ id: 'new-chat', title: 'New' });

    expect(telegramBot.createTopic).toHaveBeenCalledTimes(1);
    expect(bridge.topicCreationBlockedReason).toContain('not enough rights');
  });

  it('TELEGRAM_AUTO_CREATE_TOPICS=false: no topic on incoming messages, /sync still creates them', async () => {
    const { bridge, db, telegramBot, maxClient } = routedBridge({
      config: makeTestConfig({ telegram: { autoCreateTopics: false } })
    });
    db.upsertChat({ id: 'chat-x', title: 'X', metadata: {} });

    expect(await bridge.forwardMaxMessage(maxMessage('m1', 'chat-x'))).toBe(false);
    expect(telegramBot.createTopic).not.toHaveBeenCalled();

    maxClient.listChats.mockResolvedValue([{ id: 'chat-x', title: 'X', metadata: {} }]);
    await bridge.syncTopics();
    expect(telegramBot.createTopic).toHaveBeenCalledTimes(1);
  });
});

describe('/merge and /unmerge', () => {
  it('redirects a duplicate chat into this topic, replies here still reach the topic owner, and /unmerge restores it', async () => {
    const { bridge, db, telegramBot } = routedBridge();
    linkChat(db, 'Alice', { telegramThreadId: 11 });
    linkChat(db, 'Alice (2)', { telegramThreadId: 22 });

    const reply = bridge.mergeChat('Alice (2)', RELAY, 11);

    expect(reply).toContain('✅');
    expect(db.getChatMapping('Alice (2)').telegramThreadId).toBe(11);
    // The topic still answers to Alice, not to the chat merged into it.
    expect(db.getChatMappingByTelegramThread(RELAY, 11).maxChatId).toBe('Alice');
    await bridge.forwardMaxMessage(maxMessage('m-dup', 'Alice (2)'));
    expect(telegramBot.sendMessage.mock.calls.at(-1)[1].telegramThreadId).toBe(11);

    expect(bridge.unmergeChat('Alice (2)')).toContain('✅');
    expect(db.getChatMapping('Alice (2)').telegramThreadId).toBe(22);
    expect(db.getChatMappingByTelegramThread(RELAY, 22).maxChatId).toBe('Alice (2)');
  });

  it('merging a chat that has no topic of its own works too (used to fail with a UNIQUE error)', () => {
    const { bridge, db } = routedBridge();
    linkChat(db, 'Alice', { telegramThreadId: 11 });
    db.upsertChat({ id: 'Alice (2)', title: 'Alice (2)', metadata: {} });
    db.upsertChatMapping({ maxChatId: 'Alice (2)', telegramChatId: RELAY, telegramThreadId: null, title: 'Alice (2)', metadata: {} });

    expect(bridge.mergeChat('Alice (2)', RELAY, 11)).toContain('✅');
    expect(db.getChatMapping('Alice (2)').telegramThreadId).toBe(11);
  });
});
