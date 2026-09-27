import { describe, it, expect, vi, afterEach } from 'vitest';
import { makeBridge, linkChat, maxMessage, telegramMessage } from '../helpers/bridgeHarness.js';

// A message sent from Telegram into MAX is rendered as a bubble in the MAX
// page, and the poller reads that page. The only thing that normally stops it
// coming straight back to Telegram is MAX marking the bubble as outgoing — and
// that marking is not instant. Observed live on a fast poll interval: sent at
// 13:00:03, echoed back into the same topic at 13:00:09.
//
// Identity cannot save us here: MAX renders no author and no timestamp the
// scraper can read, so a message fingerprint is effectively just its text, in
// a different id namespace from the Telegram side. Hence a guard on what we
// know we just sent — deliberately narrow, so a real identical reply later is
// still delivered.

describe('echo guard', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not deliver our own message back when MAX serves it up as incoming', async () => {
    const { bridge, db, maxClient, telegramBot } = makeBridge();
    bridge.lastChatRefreshAt = Date.now();
    linkChat(db, 'chat-a', { unread: true });

    await bridge.handleTelegramMessage(telegramMessage('tg-1', { text: 'привет' }));
    expect(maxClient.sendText).toHaveBeenCalledTimes(1);

    // The poller reads the page and hands back a bubble that was NOT flagged
    // outgoing — exactly what the live failure looked like.
    maxClient.readMessages.mockResolvedValue([maxMessage('echo-1', 'chat-a', { text: 'привет' })]);
    await bridge.pollMax();

    expect(telegramBot.sendMessage).not.toHaveBeenCalled();
    // Recorded as seen, so the next poll does not reconsider it.
    expect(db.hasMessage('echo-1')).toBe(true);
  });

  it('still delivers a genuine reply that happens to repeat our words', async () => {
    const { bridge, db, maxClient, telegramBot } = makeBridge();
    bridge.lastChatRefreshAt = Date.now();
    linkChat(db, 'chat-a', { unread: true });

    await bridge.handleTelegramMessage(telegramMessage('tg-1', { text: 'Да' }));

    // First 'Да' back is ours; the contact's own 'Да' after it must arrive.
    maxClient.readMessages.mockResolvedValueOnce([maxMessage('echo-1', 'chat-a', { text: 'Да' })]);
    await bridge.pollMax();
    expect(telegramBot.sendMessage).not.toHaveBeenCalled();

    maxClient.readMessages.mockResolvedValue([maxMessage('real-1', 'chat-a', { text: 'Да' })]);
    await bridge.pollMax();

    expect(telegramBot.sendMessage).toHaveBeenCalledTimes(1);
    expect(telegramBot.sendMessage.mock.calls[0][0].id).toBe('real-1');
  });

  it('once MAX shows our bubble as outgoing, the contact repeating our words right away is delivered', async () => {
    // The usual case: MAX marks our bubble outgoing within a second, the
    // poller never sees it — and the unconsumed record used to swallow the
    // contact's identical reply ("Да", "Ок", "+") for the next 20 seconds.
    const { bridge, db, maxClient, telegramBot } = makeBridge();
    bridge.lastChatRefreshAt = Date.now();
    linkChat(db, 'chat-a', { unread: true });
    maxClient.getLastOutgoingFingerprint.mockResolvedValue('fp-ours|12:00|Да');

    await bridge.handleTelegramMessage(telegramMessage('tg-1', { text: 'Да' }));
    maxClient.readMessages.mockResolvedValue([maxMessage('contact-1', 'chat-a', { text: 'Да' })]);
    await bridge.pollMax();

    expect(telegramBot.sendMessage).toHaveBeenCalledTimes(1);
    expect(telegramBot.sendMessage.mock.calls[0][0].id).toBe('contact-1');
  });

  it('recognises a multi-line echo whose line breaks were lost in the page', async () => {
    const { bridge, db, maxClient, telegramBot } = makeBridge();
    bridge.lastChatRefreshAt = Date.now();
    linkChat(db, 'chat-a', { unread: true });

    await bridge.handleTelegramMessage(telegramMessage('tg-1', { text: 'первая строка\nвторая' }));
    maxClient.readMessages.mockResolvedValue([maxMessage('echo-1', 'chat-a', { text: 'первая строкавторая' })]);
    await bridge.pollMax();

    expect(telegramBot.sendMessage).not.toHaveBeenCalled();
  });

  it('expires, so the same words minutes later are not swallowed', async () => {
    vi.useFakeTimers();
    const { bridge, db, maxClient, telegramBot } = makeBridge();
    bridge.lastChatRefreshAt = Date.now();
    linkChat(db, 'chat-a', { unread: true });

    await bridge.handleTelegramMessage(telegramMessage('tg-1', { text: 'ок' }));

    await vi.advanceTimersByTimeAsync(60000);
    bridge.lastChatRefreshAt = Date.now();
    maxClient.readMessages.mockResolvedValue([maxMessage('later-1', 'chat-a', { text: 'ок' })]);
    await bridge.pollMax();

    expect(telegramBot.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('is per-chat: the same text in another chat is untouched', async () => {
    const { bridge, db, maxClient, telegramBot } = makeBridge();
    bridge.lastChatRefreshAt = Date.now();
    linkChat(db, 'chat-a', { unread: true });
    linkChat(db, 'chat-b', { unread: true, telegramThreadId: 78 });

    await bridge.handleTelegramMessage(telegramMessage('tg-1', { text: 'привет' }));

    maxClient.readMessages.mockImplementation(async (chatId) => (
      chatId === 'chat-b' ? [maxMessage('other-1', 'chat-b', { text: 'привет' })] : []
    ));
    await bridge.pollMax();

    expect(telegramBot.sendMessage).toHaveBeenCalledTimes(1);
    expect(telegramBot.sendMessage.mock.calls[0][0].chatId).toBe('chat-b');
  });

  it('leaves media alone — its identity is already protected by the media hash', async () => {
    const { bridge, db, telegramBot } = makeBridge();
    linkChat(db, 'chat-a');

    await bridge.handleTelegramMessage(telegramMessage('tg-1', {
      type: 'photo', mediaPath: '/tmp/a.jpg', text: 'подпись'
    }));

    // A photo arriving from MAX with the same caption is a real message.
    const forwarded = await bridge.forwardMaxMessage(
      maxMessage('m-photo', 'chat-a', { type: 'photo', text: 'подпись', mediaUrl: 'https://i.oneme.ru/i?r=T' })
    );

    expect(forwarded).toBe(true);
    expect(telegramBot.sendMessage).toHaveBeenCalledTimes(1);
  });
});
