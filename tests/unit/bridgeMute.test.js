import { describe, it, expect } from 'vitest';
import { AppDatabase } from '../../src/storage/database.js';
import { BridgeService } from '../../src/services/bridge.js';
import { makeBridge, linkChat, maxMessage } from '../helpers/bridgeHarness.js';

// /mute and /unmute: muted MAX chats (service/ad feeds like «Интересное для
// вас») must be excluded from polling entirely, their messages consumed
// without forwarding, and the state must survive restarts via the settings
// table. Unmute primes the accumulated backlog so old ads are not dumped.

describe('muted chats', () => {
  it('muteChat persists, marks /chats, and survives a bridge restart', async () => {
    const { bridge, db } = makeBridge();
    linkChat(db, 'Интересное для вас');

    const reply = await bridge.muteChat('Интересное для вас');

    expect(reply).toContain('🔇');
    expect(bridge.mutedChatIds.has('Интересное для вас')).toBe(true);
    expect(db.listMutedChatIds()).toEqual(['Интересное для вас']);

    // A new BridgeService over the same db (container restart) reloads the set.
    const reborn = new BridgeService({
      db,
      maxClient: bridge.maxClient,
      telegramBot: bridge.telegramBot,
      mediaService: bridge.mediaService,
      config: bridge.config
    });
    expect(reborn.mutedChatIds.has('Интересное для вас')).toBe(true);
  });

  it('muting twice is idempotent and reported as such', async () => {
    const { bridge, db } = makeBridge();
    linkChat(db, 'ads');
    await bridge.muteChat('ads');
    expect(await bridge.muteChat('ads')).toContain('уже заглушён');
    expect(db.listMutedChatIds()).toEqual(['ads']);
  });

  it('an unknown chat name can still be muted ahead of time, with a warning', async () => {
    const { bridge, db } = makeBridge();
    const reply = await bridge.muteChat('Каналы для вас');
    expect(reply).toContain('сейчас нет в списке');
    expect(db.listMutedChatIds()).toEqual(['Каналы для вас']);
  });

  it('pickChatsForPoll never selects a muted chat, even a permanently-unread one', async () => {
    const { bridge, db } = makeBridge({ config: undefined });
    bridge.config.maxChatsPerPoll = 2;
    linkChat(db, 'ads', { unread: true });
    linkChat(db, 'real', { unread: true, telegramThreadId: 78 });
    await bridge.muteChat('ads');

    for (let i = 0; i < 5; i++) {
      const picked = bridge.pickChatsForPoll().map((chat) => chat.id);
      expect(picked).toEqual(['real']);
    }
  });

  it('pollMax does not read a muted chat at all', async () => {
    const { bridge, db, maxClient } = makeBridge();
    bridge.lastChatRefreshAt = Date.now();
    linkChat(db, 'ads', { unread: true });
    await bridge.muteChat('ads');

    await bridge.pollMax();

    expect(maxClient.readMessages).not.toHaveBeenCalled();
  });

  it('forwardMaxMessage consumes a muted-chat message without sending or recording a delivery', async () => {
    const { bridge, db, telegramBot } = makeBridge();
    linkChat(db, 'ads');
    await bridge.muteChat('ads');

    const result = await bridge.forwardMaxMessage(maxMessage('ad-1', 'ads'));

    // true = "handled": pollMax will insert it as seen, never retried.
    expect(result).toBe(true);
    expect(telegramBot.sendMessage).not.toHaveBeenCalled();
    expect(db.getDeliveryStats()).toEqual([]);
  });

  it('unmuteChat primes the visible backlog as seen so only new messages forward afterwards', async () => {
    const { bridge, db, maxClient, telegramBot } = makeBridge();
    bridge.lastChatRefreshAt = Date.now();
    linkChat(db, 'ads', { unread: true });
    await bridge.muteChat('ads');

    // Two ads accumulated while muted; they are what readMessages shows now.
    maxClient.readMessages.mockResolvedValueOnce([
      maxMessage('ad-1', 'ads'),
      maxMessage('ad-2', 'ads')
    ]);

    const reply = await bridge.unmuteChat('ads');

    expect(reply).toContain('2 сообщ.');
    expect(bridge.mutedChatIds.has('ads')).toBe(false);
    expect(db.listMutedChatIds()).toEqual([]);
    // Backlog is recorded as seen without a single Telegram send.
    expect(db.hasMessage('ad-1')).toBe(true);
    expect(db.hasMessage('ad-2')).toBe(true);
    expect(telegramBot.sendMessage).not.toHaveBeenCalled();

    // The next poll forwards only the genuinely new message.
    maxClient.readMessages.mockResolvedValue([
      maxMessage('ad-1', 'ads'),
      maxMessage('ad-2', 'ads'),
      maxMessage('ad-3', 'ads')
    ]);
    await bridge.pollMax();
    expect(telegramBot.sendMessage).toHaveBeenCalledTimes(1);
    expect(telegramBot.sendMessage.mock.calls[0][0].id).toBe('ad-3');
  });

  it('unmuting a chat that was never muted says so and does not touch the page', async () => {
    const { bridge, maxClient } = makeBridge();
    const reply = await bridge.unmuteChat('real');
    expect(reply).toContain('не был заглушён');
    expect(maxClient.readMessages).not.toHaveBeenCalled();
  });

  it('unmute still completes when priming fails (unreachable chat)', async () => {
    const { bridge, db, maxClient } = makeBridge();
    linkChat(db, 'ads');
    await bridge.muteChat('ads');
    maxClient.readMessages.mockRejectedValue(new Error('Max chat not found'));

    const reply = await bridge.unmuteChat('ads');

    expect(reply).toContain('🔊');
    expect(bridge.mutedChatIds.has('ads')).toBe(false);
  });

  it('mute renames the Telegram topic to «🔇 <title>» and unmute restores the clean title', async () => {
    const { bridge, db, telegramBot } = makeBridge();
    linkChat(db, 'ads', { telegramThreadId: 91 });

    await bridge.muteChat('ads');
    expect(telegramBot.renameTopic).toHaveBeenCalledWith(91, '🔇 ads');

    await bridge.unmuteChat('ads');
    expect(telegramBot.renameTopic).toHaveBeenLastCalledWith(91, 'ads');
  });

  it('mute succeeds even when the topic rename fails or no topic exists', async () => {
    const { bridge, db, telegramBot } = makeBridge();
    linkChat(db, 'ads', { telegramThreadId: 91 });
    telegramBot.renameTopic.mockRejectedValue(new Error('TOPIC_NOT_MODIFIED'));

    expect(await bridge.muteChat('ads')).toContain('🔇');
    expect(bridge.mutedChatIds.has('ads')).toBe(true);

    // Never-mapped chat: no rename attempted, mute still lands.
    expect(await bridge.muteChat('phantom')).toContain('🔇');
    expect(telegramBot.renameTopic).toHaveBeenCalledTimes(1);
  });

  it('listMutedChatIds tolerates corrupt settings JSON', () => {
    const db = new AppDatabase(':memory:');
    db.setSetting('muted_chat_ids', 'not-json{');
    expect(db.listMutedChatIds()).toEqual([]);
    db.setSetting('muted_chat_ids', '"a-string"');
    expect(db.listMutedChatIds()).toEqual([]);
  });
});
