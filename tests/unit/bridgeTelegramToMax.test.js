import { describe, it, expect, vi } from 'vitest';
import {
  makeBridge,
  makeFakeMaxClient,
  makeFakeMediaService,
  makeFakeTelegramBot,
  makeTestConfig,
  linkChat,
  telegramMessage
} from '../helpers/bridgeHarness.js';

// Raw delivery rows (status/direction/last_error) straight from SQLite, so the
// tests can assert on the exact persisted record, not just aggregate stats.
function allDeliveries(db) {
  return db.db.prepare('SELECT * FROM message_deliveries ORDER BY id').all();
}

describe('handleTelegramMessage', () => {
  it('forwards text from a linked topic into MAX and records a sent tg_to_max delivery', async () => {
    const { bridge, db, maxClient } = makeBridge({
      maxClient: makeFakeMaxClient({
        getLastOutgoingFingerprint: vi.fn(async () => 'out-fp|12:34|x')
      })
    });
    linkChat(db, 'max-1');
    const message = telegramMessage('tg-100', { text: 'hello max' });

    await bridge.handleTelegramMessage(message);

    expect(maxClient.sendText).toHaveBeenCalledTimes(1);
    // No reply metadata -> third arg (replyToFingerprint) is null.
    expect(maxClient.sendText).toHaveBeenCalledWith('max-1', 'hello max', null);
    expect(maxClient.getLastOutgoingFingerprint).toHaveBeenCalledWith('max-1', 'hello max');

    expect(db.hasMessage('tg-100')).toBe(true);
    const stored = db.recentMessages('max-1', 10).find((m) => m.id === 'tg-100');
    expect(stored).toBeDefined();
    expect(stored.direction).toBe('tg_to_max');
    expect(stored.chatId).toBe('max-1');
    expect(stored.maxFingerprint).toBe('out-fp|12:34|x');

    const deliveries = allDeliveries(db);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({
      message_id: 'tg-100',
      direction: 'tg_to_max',
      status: 'sent'
    });
    expect(db.getDeliveryStats()).toEqual([{ status: 'sent', count: 1 }]);
  });

  it('sends a hint to the topic and nothing to MAX when the thread has no mapping', async () => {
    const { bridge, db, maxClient, telegramBot } = makeBridge();
    linkChat(db, 'max-1'); // mapped to thread 77; the message arrives in thread 88
    // A selected fallback chat exists — in relay/topics mode it must be
    // IGNORED. If the relay-mode guard in resolveTelegramMapping regressed,
    // this message would silently misroute into max-1 instead of bouncing.
    db.selectChat('max-1');
    const message = telegramMessage('tg-200', { telegramThreadId: 88 });

    await bridge.handleTelegramMessage(message);

    expect(maxClient.sendText).not.toHaveBeenCalled();
    expect(maxClient.sendFile).not.toHaveBeenCalled();
    expect(telegramBot.sendText).toHaveBeenCalledTimes(1);
    const [hint, route] = telegramBot.sendText.mock.calls[0];
    expect(hint).toContain('not linked to a MAX chat');
    expect(route).toEqual({ telegramChatId: -100500, telegramThreadId: 88 });

    expect(db.hasMessage('tg-200')).toBe(false);
    expect(db.getDeliveryStats()).toEqual([]);
  });

  it('is idempotent: a duplicate message id is not re-sent and creates no second delivery', async () => {
    const { bridge, db, maxClient } = makeBridge();
    linkChat(db, 'max-1');
    const message = telegramMessage('tg-300');

    await bridge.handleTelegramMessage(message);
    await bridge.handleTelegramMessage(message);

    expect(maxClient.sendText).toHaveBeenCalledTimes(1);
    expect(allDeliveries(db)).toHaveLength(1);
    expect(db.getDeliveryStats()).toEqual([{ status: 'sent', count: 1 }]);
  });

  it('converts media for MAX, sends the converted file, and stores the enriched message', async () => {
    const { bridge, db, maxClient, mediaService } = makeBridge({
      mediaService: makeFakeMediaService({
        ensureMaxCompatible: vi.fn(async () => '/tmp/converted.jpg')
      })
    });
    linkChat(db, 'max-1');
    const message = telegramMessage('tg-400', {
      type: 'photo',
      mediaPath: '/tmp/original.jpg',
      text: 'caption'
    });

    await bridge.handleTelegramMessage(message);

    expect(mediaService.ensureMaxCompatible).toHaveBeenCalledWith('/tmp/original.jpg', 'photo');
    expect(maxClient.sendFile).toHaveBeenCalledTimes(1);
    expect(maxClient.sendFile).toHaveBeenCalledWith('max-1', '/tmp/converted.jpg');
    // The caption used to be passed to sendFile, which ignored it: the text
    // never reached MAX. It now follows the file as its own message.
    expect(maxClient.sendText).toHaveBeenCalledWith('max-1', 'caption');
    expect(maxClient.sendFile.mock.invocationCallOrder[0])
      .toBeLessThan(maxClient.sendText.mock.invocationCallOrder[0]);
    // Photo hash is computed over the file actually sent into MAX.
    expect(mediaService.imageDHash).toHaveBeenCalledWith('/tmp/converted.jpg');

    expect(db.hasMessage('tg-400')).toBe(true);
    const stored = db.recentMessages('max-1', 10).find((m) => m.id === 'tg-400');
    expect(stored.mediaPath).toBe('/tmp/converted.jpg');
    expect(stored.mediaHash).toBe('a1b2c3d4e5f60718');
    expect(db.getDeliveryStats()).toEqual([{ status: 'sent', count: 1 }]);

    // The media message itself gets no MAX-side fingerprint (a later Telegram
    // reply to a media send cannot be quoted back inside MAX) — pin that.
    expect(stored.maxFingerprint).toBeNull();
  });

  it('a media send without a caption sends no text', async () => {
    const { bridge, db, maxClient } = makeBridge();
    linkChat(db, 'max-1');

    await bridge.handleTelegramMessage(telegramMessage('tg-401', { type: 'photo', mediaPath: '/tmp/a.jpg', text: '' }));

    expect(maxClient.sendFile).toHaveBeenCalledTimes(1);
    expect(maxClient.sendText).not.toHaveBeenCalled();
  });

  it('a caption that fails after the file went through is reported, but the file is not marked failed', async () => {
    const { bridge, db, maxClient, telegramBot } = makeBridge({
      maxClient: makeFakeMaxClient({
        sendText: vi.fn(async () => { throw new Error('composer did not clear'); })
      })
    });
    linkChat(db, 'max-1');

    await bridge.handleTelegramMessage(telegramMessage('tg-402', { type: 'photo', mediaPath: '/tmp/a.jpg', text: 'подпись' }));

    expect(maxClient.sendFile).toHaveBeenCalledTimes(1);
    expect(db.hasMessage('tg-402')).toBe(true);
    expect(db.getDeliveryStats()).toEqual([{ status: 'sent', count: 1 }]);
    expect(telegramBot.sendText).toHaveBeenCalledTimes(1);
    expect(telegramBot.sendText.mock.calls[0][0]).toContain('подпись к нему — нет');
  });

  it('records a failed delivery, keeps the message unstored, and notifies the user when the MAX send fails', async () => {
    const { bridge, db, telegramBot } = makeBridge({
      maxClient: makeFakeMaxClient({
        sendText: vi.fn(async () => { throw new Error('MAX exploded'); })
      })
    });
    linkChat(db, 'max-1');
    const message = telegramMessage('tg-500');

    await bridge.handleTelegramMessage(message);

    expect(db.hasMessage('tg-500')).toBe(false);
    const deliveries = allDeliveries(db);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({
      message_id: 'tg-500',
      direction: 'tg_to_max',
      status: 'failed',
      last_error: 'MAX exploded'
    });
    expect(db.countFailedDeliveries('tg-500', 'tg_to_max')).toBe(1);

    expect(telegramBot.sendText).toHaveBeenCalledTimes(1);
    const [notice, route] = telegramBot.sendText.mock.calls[0];
    expect(notice).toContain('Failed to send to MAX');
    expect(notice).toContain('MAX exploded');
    expect(route).toEqual({ telegramChatId: -100500, telegramThreadId: 77 });
  });

  it('swallows a notification failure: resolves even when both sends reject', async () => {
    const { bridge, db, telegramBot } = makeBridge({
      maxClient: makeFakeMaxClient({
        sendText: vi.fn(async () => { throw new Error('MAX down'); })
      })
    });
    telegramBot.sendText.mockRejectedValue(new Error('TG down too'));
    linkChat(db, 'max-1');
    const message = telegramMessage('tg-600');

    await expect(bridge.handleTelegramMessage(message)).resolves.toBeUndefined();

    // The failure itself was still recorded before the notification attempt.
    expect(telegramBot.sendText).toHaveBeenCalledTimes(1);
    expect(db.hasMessage('tg-600')).toBe(false);
    expect(db.getDeliveryStats()).toEqual([{ status: 'failed', count: 1 }]);
  });

  it('quotes the original MAX bubble fingerprint when replying to a forwarded text message', async () => {
    const { bridge, db, maxClient } = makeBridge();
    linkChat(db, 'max-1');
    // Original text message the bridge previously forwarded FROM Max.
    db.insertMessage({
      id: 'max-orig-1',
      chatId: 'max-1',
      direction: 'max_to_tg',
      type: 'text',
      text: 'original from MAX',
      sourceMessageId: 'fp-orig|12:00|x',
      createdAt: Date.now(),
      metadata: {},
      telegramMessageId: 555
    });
    const message = telegramMessage('tg-700', {
      text: 'my reply',
      metadata: { replyToTelegramMessageId: 555 }
    });

    await bridge.handleTelegramMessage(message);

    expect(maxClient.sendText).toHaveBeenCalledTimes(1);
    expect(maxClient.sendText).toHaveBeenCalledWith('max-1', 'my reply', 'fp-orig|12:00|x');
  });

  it("falls back to a plain send when the original's sourceMessageId is an unstable 'visible-' id", async () => {
    const { bridge, db, maxClient } = makeBridge();
    linkChat(db, 'max-1');
    db.insertMessage({
      id: 'max-orig-2',
      chatId: 'max-1',
      direction: 'max_to_tg',
      type: 'text',
      text: 'unstable original',
      sourceMessageId: 'visible-7',
      createdAt: Date.now(),
      metadata: {},
      telegramMessageId: 556
    });
    const message = telegramMessage('tg-800', {
      text: 'reply anyway',
      metadata: { replyToTelegramMessageId: 556 }
    });

    await bridge.handleTelegramMessage(message);

    expect(maxClient.sendText).toHaveBeenCalledTimes(1);
    expect(maxClient.sendText).toHaveBeenCalledWith('max-1', 'reply anyway', null);
  });
});

describe('routing without topics (no relay group)', () => {
  const OWNER = 12345;

  // Without topics every MAX chat is delivered into the owner's private chat,
  // so every mapping is (owner, no thread): a lookup by thread returned the
  // first-inserted chat and ignored /select — a reply meant for one contact was
  // typed into another contact's chat.
  function fallbackBridge() {
    const harness = makeBridge({
      config: makeTestConfig({ telegram: { relayChatId: null } }),
      telegramBot: makeFakeTelegramBot({ targetChatId: vi.fn(() => OWNER) })
    });
    linkChat(harness.db, 'Mom', { telegramChatId: OWNER, telegramThreadId: null });
    linkChat(harness.db, 'Boss', { telegramChatId: OWNER, telegramThreadId: null });
    return harness;
  }

  it('sends to the chat picked with /select, not to whichever mapping came first', async () => {
    const { bridge, db, maxClient } = fallbackBridge();
    db.selectChat('Boss');

    await bridge.handleTelegramMessage(telegramMessage('tg-1', {
      text: 'for the boss', telegramChatId: OWNER, telegramThreadId: null
    }));

    expect(maxClient.sendText).toHaveBeenCalledWith('Boss', 'for the boss', null);
  });

  it('a reply goes to the chat of the message it replies to', async () => {
    const { bridge, db, maxClient } = fallbackBridge();
    db.selectChat('Boss');
    db.insertMessage({
      id: 'max-from-mom',
      chatId: 'Mom',
      direction: 'max_to_tg',
      type: 'text',
      text: 'are you coming?',
      sourceMessageId: 'fp-mom|18:00|are you coming?',
      createdAt: Date.now(),
      metadata: {},
      telegramMessageId: 901
    });

    await bridge.handleTelegramMessage(telegramMessage('tg-2', {
      text: 'yes', telegramChatId: OWNER, telegramThreadId: null,
      metadata: { replyToTelegramMessageId: 901 }
    }));

    expect(maxClient.sendText).toHaveBeenCalledWith('Mom', 'yes', 'fp-mom|18:00|are you coming?');
  });

  it('/history shows the selected chat', async () => {
    const { bridge, db } = fallbackBridge();
    db.selectChat('Boss');
    db.insertMessage({
      id: 'boss-1', chatId: 'Boss', direction: 'max_to_tg', type: 'text', text: 'report due',
      sourceMessageId: 'b1', createdAt: Date.now(), metadata: {}
    });
    db.insertMessage({
      id: 'mom-1', chatId: 'Mom', direction: 'max_to_tg', type: 'text', text: 'dinner at 7',
      sourceMessageId: 'm1', createdAt: Date.now(), metadata: {}
    });

    const history = await bridge.formatHistory(OWNER, null);

    expect(history).toContain('report due');
    expect(history).not.toContain('dinner at 7');
  });
});
