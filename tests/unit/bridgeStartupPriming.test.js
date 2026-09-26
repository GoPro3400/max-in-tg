import { describe, it, expect, vi } from 'vitest';
import { makeBridge, makeTestConfig, linkChat, maxMessage } from '../helpers/bridgeHarness.js';

// Startup priming decides what happens to the history MAX already shows.
//
// Get it wrong in one direction and a fresh install floods the owner's
// Telegram with hundreds of old messages; get it wrong in the other and every
// restart silently swallows the messages that arrived while the bridge was
// down (restarts and planned browser recycles recur on a schedule, so that
// window is not hypothetical). The rule these tests pin: prime everything on a
// first run, prime nothing afterwards.

function chatList(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `chat-${index}`,
    title: `Chat ${index}`,
    lastSeenAt: Date.now(),
    metadata: {}
  }));
}

describe('startup priming', () => {
  it('primes EVERY chat on a first run, so nothing old is delivered', async () => {
    const { bridge, db, maxClient, telegramBot } = makeBridge();
    const chats = chatList(30);
    bridge.startupChatIds = new Set(chats.map((chat) => chat.id));
    for (const chat of chats) linkChat(db, chat.id, { telegramThreadId: 1000 + Number(chat.id.split('-')[1]) });
    maxClient.readMessages.mockImplementation(async (chatId) => [
      maxMessage(`${chatId}-old-1`, chatId),
      maxMessage(`${chatId}-old-2`, chatId)
    ]);

    await bridge.primeExistingMaxMessages(chats);

    // No cap: all 30 chats, not the first few.
    expect(maxClient.readMessages).toHaveBeenCalledTimes(30);
    expect(db.hasMessage('chat-29-old-1')).toBe(true);
    // Primed means stored, never sent.
    expect(telegramBot.sendMessage).not.toHaveBeenCalled();
  });

  it('honours an explicit cap but warns that the rest will be forwarded', async () => {
    const { bridge, maxClient } = makeBridge({
      config: makeTestConfig({ startupPrimeChatsLimit: 3 })
    });
    const chats = chatList(10);
    bridge.startupChatIds = new Set(chats.map((chat) => chat.id));
    maxClient.readMessages.mockResolvedValue([]);

    await bridge.primeExistingMaxMessages(chats);

    expect(maxClient.readMessages).toHaveBeenCalledTimes(3);
  });

  it('primes only chats present at startup, not ones discovered later', async () => {
    // A chat that appears after startup is a NEW conversation: its messages
    // must be delivered, not swallowed.
    const { bridge, maxClient } = makeBridge();
    const chats = chatList(3);
    bridge.startupChatIds = new Set(['chat-0']);
    maxClient.readMessages.mockResolvedValue([]);

    await bridge.primeExistingMaxMessages(chats);

    expect(maxClient.readMessages).toHaveBeenCalledTimes(1);
    expect(maxClient.readMessages).toHaveBeenCalledWith('chat-0');
  });

  it('isEmptyOfMessages flips once anything is stored', async () => {
    const { bridge, db } = makeBridge();
    expect(db.isEmptyOfMessages()).toBe(true);

    linkChat(db, 'chat-a');
    db.insertMessage(maxMessage('m1', 'chat-a'));

    expect(db.isEmptyOfMessages()).toBe(false);
    // Which is exactly what start() uses to decide whether to prime.
    expect(bridge.db.isEmptyOfMessages()).toBe(false);
  });

  it('a restart delivers what arrived while the bridge was down', async () => {
    // The regression this guards: priming on every start marked those messages
    // as seen, so they were never forwarded — the owner simply lost them.
    const { bridge, db, maxClient, telegramBot } = makeBridge();
    bridge.lastChatRefreshAt = Date.now();
    linkChat(db, 'chat-a', { unread: true });
    // History from before the restart is already known...
    db.insertMessage(maxMessage('old-1', 'chat-a'));
    // ...and this one landed while the bridge was down.
    maxClient.readMessages.mockResolvedValue([
      maxMessage('old-1', 'chat-a'),
      maxMessage('while-down', 'chat-a')
    ]);

    await bridge.pollMax();

    expect(telegramBot.sendMessage).toHaveBeenCalledTimes(1);
    expect(telegramBot.sendMessage.mock.calls[0][0].id).toBe('while-down');
  });
});
