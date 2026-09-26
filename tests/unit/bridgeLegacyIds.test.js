import { describe, it, expect } from 'vitest';
import { stableId } from '../../src/domain/messages.js';
import { makeBridge, linkChat, maxMessage } from '../helpers/bridgeHarness.js';

// Message ids used to lack the time (MAX shows it in the bubble's meta line,
// where the old selector did not look), so a text repeating any earlier
// message of the chat — "Ок" today after "Ок" last week — was taken for it
// and never delivered. Ids now carry the time. What the bridge adds: bubbles
// recorded under their old ids are not delivered a second time after the
// update, and the old ids stop deciding anything about new messages.

const CHAT = 'chat-a';

// A bubble as MaxWebClient reads it now: "time|text", with its old id.
const bubble = (time, text, { legacyId = text } = {}) => maxMessage(stableId('max', CHAT, `${time}|${text}`), CHAT, {
  text,
  sourceMessageId: `${time}|${text}`,
  metadata: { time, legacyId }
});

// A message delivered before the update, under its old id.
const recordLegacy = (db, text, telegramMessageId) => db.insertMessage({
  ...maxMessage(stableId('max', CHAT, text), CHAT, { text, sourceMessageId: text }),
  createdAt: Date.now() - 86400000,
  telegramMessageId
});

const sentTexts = (telegramBot) => telegramBot.sendMessage.mock.calls.map(([message]) => message.text);

describe('message ids with the time in them', () => {
  it('does not deliver history again after the update, and keeps its Telegram links', async () => {
    const { bridge, db, maxClient, telegramBot } = makeBridge();
    linkChat(db, CHAT, { unread: true });
    recordLegacy(db, 'Привет', 501);
    recordLegacy(db, 'Как дела', 502);
    maxClient.readMessages.mockResolvedValue([bubble('10:00', 'Привет'), bubble('10:01', 'Как дела'), bubble('10:05', 'Новое')]);

    await bridge.pollMax();

    expect(sentTexts(telegramBot)).toEqual(['Новое']);
    const adopted = db.getMessage(stableId('max', CHAT, '10:00|Привет'));
    expect(adopted.telegramMessageId).toBe(501);
    expect(adopted.metadata.adoptedFrom).toBe(stableId('max', CHAT, 'Привет'));
    expect(db.getSetting(`timed_ids:${CHAT}`)).toBe('1');
  });

  it('delivers a text repeating an older one once the chat is on the new ids', async () => {
    const { bridge, db, maxClient, telegramBot } = makeBridge();
    linkChat(db, CHAT, { unread: true });
    recordLegacy(db, 'Ок', 501);
    maxClient.readMessages.mockResolvedValue([bubble('10:00', 'Ок')]);
    await bridge.pollMax();
    expect(telegramBot.sendMessage).not.toHaveBeenCalled();

    // The same "Ок" again, hours later: its old id is the first one's.
    maxClient.readMessages.mockResolvedValue([bubble('10:00', 'Ок'), bubble('15:00', 'Ок')]);
    await bridge.pollMax();

    expect(sentTexts(telegramBot)).toEqual(['Ок']);
    expect(db.getMessage(stableId('max', CHAT, '15:00|Ок')).telegramMessageId).not.toBe(501);
  });

  it('still recognises old history that scrolls into view above known bubbles', async () => {
    const { bridge, db, maxClient, telegramBot } = makeBridge();
    linkChat(db, CHAT, { unread: true });
    db.setSetting(`timed_ids:${CHAT}`, '1');
    recordLegacy(db, 'Давнее', 400);
    db.insertMessage(bubble('10:05', 'Новое'));
    maxClient.readMessages.mockResolvedValue([bubble('09:00', 'Давнее'), bubble('10:05', 'Новое'), bubble('10:06', 'Давнее')]);

    await bridge.pollMax();

    // The one below the newest known bubble has just arrived.
    expect(sentTexts(telegramBot)).toEqual(['Давнее']);
    expect(db.getMessage(stableId('max', CHAT, '09:00|Давнее')).telegramMessageId).toBe(400);
    expect(db.getMessage(stableId('max', CHAT, '10:06|Давнее')).telegramMessageId).not.toBe(400);
  });

  it('delivers a message waiting for another try, whatever its old id says', async () => {
    const { bridge, db, maxClient, telegramBot } = makeBridge();
    linkChat(db, CHAT, { unread: true });
    db.setSetting(`timed_ids:${CHAT}`, '1');
    recordLegacy(db, 'Ок', 501);
    const retry = bubble('15:00', 'Ок');
    db.updateDeliveryStatus(db.createDelivery(retry.id, 'max_to_tg'), 'failed', 'Telegram was down');
    db.insertMessage(bubble('15:01', 'Потом'));
    maxClient.readMessages.mockResolvedValue([retry, bubble('15:01', 'Потом')]);

    await bridge.pollMax();

    expect(sentTexts(telegramBot)).toEqual(['Ок']);
  });

  it('finishes the switch on the next read when flood control cut the first one short', async () => {
    const { bridge, db, maxClient, telegramBot } = makeBridge();
    linkChat(db, CHAT, { unread: true });
    recordLegacy(db, 'Привет', 501);
    recordLegacy(db, 'Пока', 502);
    const screen = [bubble('10:00', 'Привет'), bubble('10:05', 'Новое'), bubble('10:06', 'Пока')];
    maxClient.readMessages.mockImplementationOnce(async () => {
      bridge.telegramPausedUntil = Date.now() + 60000;
      return screen;
    });

    await bridge.pollMax();
    expect(telegramBot.sendMessage).not.toHaveBeenCalled();
    expect(db.getSetting(`timed_ids:${CHAT}`, '')).toBe('');

    bridge.telegramPausedUntil = 0;
    maxClient.readMessages.mockResolvedValue(screen);
    await bridge.pollMax();

    expect(sentTexts(telegramBot)).toEqual(['Новое']);
    expect(db.getMessage(stableId('max', CHAT, '10:06|Пока')).telegramMessageId).toBe(502);
    expect(db.getSetting(`timed_ids:${CHAT}`)).toBe('1');
  });

  it('does not finish the switch on an empty read', async () => {
    const { bridge, db, maxClient } = makeBridge();
    linkChat(db, CHAT, { unread: true });
    recordLegacy(db, 'Привет', 501);
    maxClient.readMessages.mockResolvedValue([]);

    await bridge.pollMax();

    expect(db.getSetting(`timed_ids:${CHAT}`, '')).toBe('');
  });

  it('tells the MAX client that a bubble known by its old id needs no capture on the first read', async () => {
    const { bridge, db, maxClient } = makeBridge();
    linkChat(db, CHAT, { unread: true });
    recordLegacy(db, 'стикер', 501);
    let known = null;
    maxClient.readMessages.mockImplementation(async (chatId, { isKnown }) => {
      known = [isKnown(stableId('max', CHAT, '10:00|стикер'), '10:00|стикер', 'стикер'), isKnown(stableId('max', CHAT, '10:01|x'), '10:01|x', 'x')];
      return [];
    });

    await bridge.pollMax();

    expect(known).toEqual([true, false]);
  });
});
