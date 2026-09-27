import { describe, it, expect } from 'vitest';
import { stableId } from '../../src/domain/messages.js';
import { makeBridge, linkChat, maxMessage } from '../helpers/bridgeHarness.js';

// Two identical bubbles — the same "ок" from the same person in the same
// minute — share a content id. The second one used to be dropped as "already
// delivered"; MaxWebClient now numbers it ("…#d2"). What the bridge adds:
// duplicates whose first copy was delivered before that change are recorded
// without being delivered, so an update does not dump old ones into Telegram.

const incoming = (chatId, sourceMessageId) => maxMessage(stableId('max', chatId, sourceMessageId), chatId, { text: 'ок', sourceMessageId });

describe('identical MAX messages', () => {
  it('delivers a second identical message that arrives now', async () => {
    const { bridge, db, maxClient, telegramBot } = makeBridge();
    linkChat(db, 'chat-a', { unread: true });
    bridge.duplicateIdsSince = Date.now() - 60000;
    maxClient.readMessages.mockResolvedValue([incoming('chat-a', 'Bob|12:00|ок'), incoming('chat-a', 'Bob|12:00|ок#d2')]);

    await bridge.pollMax();

    expect(telegramBot.sendMessage).toHaveBeenCalledTimes(2);
    expect(db.hasMessage(stableId('max', 'chat-a', 'Bob|12:00|ок#d2'))).toBe(true);
  });

  it('only records a duplicate whose first copy was delivered before the update', async () => {
    const { bridge, db, maxClient, telegramBot } = makeBridge();
    linkChat(db, 'chat-a', { unread: true });
    const first = incoming('chat-a', 'Bob|12:00|ок');
    db.insertMessage({ ...first, createdAt: Date.now() - 3600000, telegramMessageId: 10 });
    bridge.duplicateIdsSince = Date.now() - 60000;
    maxClient.readMessages.mockResolvedValue([first, incoming('chat-a', 'Bob|12:00|ок#d2')]);

    await bridge.pollMax();

    expect(telegramBot.sendMessage).not.toHaveBeenCalled();
    const second = db.getMessage(stableId('max', 'chat-a', 'Bob|12:00|ок#d2'));
    expect(second.metadata.primedAsBacklog).toBe(true);
  });

  it('remembers when the numbering started, across restarts', () => {
    const { bridge, db } = makeBridge();
    const first = bridge.firstRunOf('duplicate_ids_since');
    db.setSetting('unrelated', 'x');
    expect(bridge.firstRunOf('duplicate_ids_since')).toBe(first);
  });
});
