import path from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import {
  makeBridge,
  makeFakeTelegramBot,
  makeFakeMediaService,
  linkChat,
  maxMessage
} from '../helpers/bridgeHarness.js';

describe('forwardMaxMessage', () => {
  it('forwards a text message from a linked chat and records the delivery as sent', async () => {
    const { bridge, db, telegramBot } = makeBridge();
    linkChat(db, 'chat-1');

    const message = maxMessage('m1', 'chat-1');
    const result = await bridge.forwardMaxMessage(message);

    expect(result).toBe(true);
    expect(telegramBot.sendMessage).toHaveBeenCalledTimes(1);
    const [outgoing, usedMapping] = telegramBot.sendMessage.mock.calls[0];
    expect(outgoing.id).toBe('m1');
    expect(outgoing.text).toBe('text of m1');
    // A plain (non-reply) message carries an explicit null reply target.
    expect(outgoing.replyToMessageId).toBeNull();
    expect(usedMapping.maxChatId).toBe('chat-1');
    expect(usedMapping.telegramChatId).toBe(-100500);
    expect(usedMapping.telegramThreadId).toBe(77);
    // Telegram's message_id is persisted on the original message object so the
    // caller's insertMessage stores it.
    expect(message.telegramMessageId).toBe(1000);
    expect(db.getDeliveryStats()).toEqual([{ status: 'sent', count: 1 }]);
  });

  it('returns false without sending or creating a delivery row when no safe route exists', async () => {
    const telegramBot = makeFakeTelegramBot({
      createTopic: vi.fn(async () => { throw new Error('not enough rights'); })
    });
    const { bridge, db } = makeBridge({ telegramBot });
    // Chat never linked; topics required (relayChatId=-100500, useTopics=true)
    // and topic creation is unavailable -> ensureMapping returns null.

    const result = await bridge.forwardMaxMessage(maxMessage('m2', 'ghost-chat'));

    expect(result).toBe(false);
    expect(telegramBot.createTopic).toHaveBeenCalledTimes(1);
    expect(telegramBot.sendMessage).not.toHaveBeenCalled();
    expect(db.getChatMapping('ghost-chat')).toBeNull();
    // The early return happens BEFORE createDelivery: no delivery row at all.
    expect(db.getDeliveryStats()).toEqual([]);
  });

  it('downloads then converts photo media, hashing the pre-conversion download', async () => {
    const mediaService = makeFakeMediaService({
      downloadUrl: vi.fn(async () => '/tmp/dl/original.jpg'),
      ensureTelegramCompatible: vi.fn(async () => '/tmp/conv/converted.jpg')
    });
    const { bridge, db, telegramBot } = makeBridge({ mediaService });
    linkChat(db, 'chat-3');

    const message = maxMessage('m3', 'chat-3', {
      type: 'photo',
      mediaUrl: 'https://i.oneme.ru/i?r=TOKEN3&fn=w_1280'
    });
    const result = await bridge.forwardMaxMessage(message);

    expect(result).toBe(true);
    expect(mediaService.downloadUrl).toHaveBeenCalledWith('https://i.oneme.ru/i?r=TOKEN3&fn=w_1280', 'max-photo');
    expect(mediaService.ensureTelegramCompatible).toHaveBeenCalledWith('/tmp/dl/original.jpg', 'photo');
    // download happens before conversion
    expect(mediaService.downloadUrl.mock.invocationCallOrder[0])
      .toBeLessThan(mediaService.ensureTelegramCompatible.mock.invocationCallOrder[0]);
    // The perceptual hash is computed on the DOWNLOADED file, not on the
    // (possibly non-reproducible) converted output.
    expect(mediaService.imageDHash).toHaveBeenCalledTimes(1);
    expect(mediaService.imageDHash).toHaveBeenCalledWith('/tmp/dl/original.jpg');
    expect(message.mediaHash).toBe('a1b2c3d4e5f60718');
    // Telegram receives the converted path.
    const [outgoing] = telegramBot.sendMessage.mock.calls[0];
    expect(outgoing.mediaPath).toBe('/tmp/conv/converted.jpg');
    expect(db.getDeliveryStats()).toEqual([{ status: 'sent', count: 1 }]);
  });

  it('re-forward guard: skips sending an already-forwarded bubble but marks the delivery sent', async () => {
    const { bridge, db, telegramBot, mediaService } = makeBridge();
    linkChat(db, 'chat-4');
    // Prior forwarded copy of the same bubble under an older signed URL,
    // stored before the current page was loaded: same chat, same perceptual
    // hash, same fingerprint apart from the (re-signed) media URL.
    db.insertMessage({
      ...maxMessage('old-copy', 'chat-4', {
        type: 'photo',
        sourceMessageId: 'Мама|12:00|https://i.oneme.ru/i?r=OLDTOKEN&fn=w_1280'
      }),
      createdAt: Date.now() - 60000,
      mediaHash: 'a1b2c3d4e5f60718'
    });
    bridge.pageLoadedAt = Date.now() - 1000; // a page load since then

    const message = maxMessage('m4', 'chat-4', {
      type: 'photo',
      mediaUrl: 'https://i.oneme.ru/i?r=NEWTOKEN&fn=w_1280',
      sourceMessageId: 'Мама|12:00|https://i.oneme.ru/i?r=NEWTOKEN&fn=w_1280'
    });
    const result = await bridge.forwardMaxMessage(message);

    expect(result).toBe(true);
    // The hash was computed (guard needs it) but nothing was sent to Telegram.
    expect(mediaService.imageDHash).toHaveBeenCalledTimes(1);
    expect(telegramBot.sendMessage).not.toHaveBeenCalled();
    expect(db.getDeliveryStats()).toEqual([{ status: 'sent', count: 1 }]);
  });

  it('re-forward guard negative control: the same image with a DIFFERENT fingerprint prefix still forwards', async () => {
    // The worst failure mode of the guard is false suppression — a genuinely
    // new message silently swallowed. Same perceptual hash (user re-sent the
    // same picture) but a different stable prefix (different timestamp) must
    // NOT be treated as a stale duplicate.
    const { bridge, db, telegramBot } = makeBridge();
    linkChat(db, 'chat-4');
    db.insertMessage({
      ...maxMessage('old-copy', 'chat-4', {
        type: 'photo',
        sourceMessageId: 'Мама|12:00|https://i.oneme.ru/i?r=OLDTOKEN&fn=w_1280'
      }),
      createdAt: Date.now() - 60000,
      mediaHash: 'a1b2c3d4e5f60718'
    });
    bridge.pageLoadedAt = Date.now() - 1000;

    const message = maxMessage('m4b', 'chat-4', {
      type: 'photo',
      mediaUrl: 'https://i.oneme.ru/i?r=OTHERTOKEN&fn=w_1280',
      // Same sender, different time: used to be swallowed, because only the
      // first field (here the sender's name) was compared.
      sourceMessageId: 'Мама|18:45|https://i.oneme.ru/i?r=OTHERTOKEN&fn=w_1280'
    });
    const result = await bridge.forwardMaxMessage(message);

    expect(result).toBe(true);
    expect(telegramBot.sendMessage).toHaveBeenCalledTimes(1);
    expect(telegramBot.sendMessage.mock.calls[0][0].id).toBe('m4b');
  });

  it('re-forward guard ignores copies from the current page load: an identical twin sent the same minute is new', async () => {
    const { bridge, db, telegramBot } = makeBridge();
    linkChat(db, 'chat-4');
    bridge.pageLoadedAt = Date.now() - 60000;
    db.insertMessage({
      ...maxMessage('first', 'chat-4', {
        type: 'photo',
        sourceMessageId: 'Мама|12:00|https://i.oneme.ru/i?r=A&fn=w_1280'
      }),
      createdAt: Date.now() - 1000, // forwarded in THIS session
      mediaHash: 'a1b2c3d4e5f60718'
    });

    const result = await bridge.forwardMaxMessage(maxMessage('second', 'chat-4', {
      type: 'photo',
      mediaUrl: 'https://i.oneme.ru/i?r=B&fn=w_1280',
      sourceMessageId: 'Мама|12:00|https://i.oneme.ru/i?r=B&fn=w_1280'
    }));

    expect(result).toBe(true);
    expect(telegramBot.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('records a failed delivery with the error message when the Telegram send rejects', async () => {
    const telegramBot = makeFakeTelegramBot({
      sendMessage: vi.fn(async () => { throw new Error('tg: 403 forbidden'); })
    });
    const { bridge, db } = makeBridge({ telegramBot });
    linkChat(db, 'chat-5');

    const message = maxMessage('m5', 'chat-5');
    const result = await bridge.forwardMaxMessage(message);

    expect(result).toBe(false);
    expect(message.telegramMessageId).toBeUndefined();
    const failed = db.getFailedDeliveries();
    expect(failed).toHaveLength(1);
    expect(failed[0].message_id).toBe('m5');
    expect(failed[0].direction).toBe('max_to_tg');
    expect(failed[0].status).toBe('failed');
    expect(failed[0].last_error).toBe('tg: 403 forbidden');
    expect(failed[0].attempts).toBe(1);
    expect(db.countFailedDeliveries('m5', 'max_to_tg')).toBe(1);
  });

  it('resolves a reply by quoted snippet and sets replyToMessageId to the original telegram id', async () => {
    const { bridge, db, telegramBot } = makeBridge();
    linkChat(db, 'chat-6');
    // Original max_to_tg text message previously forwarded as tg message 555.
    db.insertMessage({
      ...maxMessage('orig-1', 'chat-6', { text: 'hello original world' }),
      telegramMessageId: 555
    });

    const reply = maxMessage('m6', 'chat-6', {
      text: 'my reply',
      metadata: { replyToSnippet: 'hello original' }
    });
    const result = await bridge.forwardMaxMessage(reply);

    expect(result).toBe(true);
    expect(telegramBot.sendMessage).toHaveBeenCalledTimes(1);
    const [outgoing] = telegramBot.sendMessage.mock.calls[0];
    expect(outgoing.replyToMessageId).toBe(555);
    expect(db.getDeliveryStats()).toEqual([{ status: 'sent', count: 1 }]);
  });

  it('encodes an animated sticker frames dir to a GIF and sends it as-is', async () => {
    const { bridge, db, telegramBot, mediaService } = makeBridge();
    linkChat(db, 'chat-7');

    const message = maxMessage('m7', 'chat-7', {
      type: 'sticker',
      mediaPath: '/tmp/frames/stick-1',
      metadata: { animated: true, fps: 30 }
    });
    const result = await bridge.forwardMaxMessage(message);

    expect(result).toBe(true);
    expect(mediaService.framesDirToGif).toHaveBeenCalledWith('/tmp/frames/stick-1', 30);
    // This path bypasses download and Telegram-compat conversion entirely.
    expect(mediaService.downloadUrl).not.toHaveBeenCalled();
    expect(mediaService.ensureTelegramCompatible).not.toHaveBeenCalled();
    const [outgoing] = telegramBot.sendMessage.mock.calls[0];
    expect(outgoing.type).toBe('sticker');
    expect(outgoing.mediaPath).toBe('/tmp/frames/stick-1/out.gif');
    // The sticker's identity is its first frame — the same whichever encoder
    // (video sticker or GIF) ends up being used.
    expect(mediaService.fileContentHash).toHaveBeenCalledWith('/tmp/frames/stick-1/frame-000.png');
    expect(db.getDeliveryStats()).toEqual([{ status: 'sent', count: 1 }]);
  });

  describe('stickers as real Telegram stickers', () => {
    function stickerBridge({ sendStickerFile = vi.fn(async () => ({ message_id: 555, sticker: {} })) } = {}) {
      const mediaService = makeFakeMediaService({
        framesDirToWebmSticker: vi.fn(async (dir) => `${dir}/sticker.webm`),
        toWebpSticker: vi.fn(async (file) => `${file}-tg-sticker.webp`)
      });
      const telegramBot = makeFakeTelegramBot({ sendStickerFile });
      const harness = makeBridge({ mediaService, telegramBot });
      linkChat(harness.db, 'chat-s');
      return harness;
    }

    it('an animated MAX sticker goes out as a VP9 video sticker, not as a GIF', async () => {
      const { bridge, telegramBot, mediaService } = stickerBridge();

      const result = await bridge.forwardMaxMessage(maxMessage('st1', 'chat-s', {
        type: 'sticker', mediaPath: '/tmp/frames/st1', metadata: { animated: true, fps: 24 }
      }));

      expect(result).toBe(true);
      expect(mediaService.framesDirToWebmSticker).toHaveBeenCalledWith('/tmp/frames/st1', 24);
      expect(telegramBot.sendStickerFile).toHaveBeenCalledWith('/tmp/frames/st1/sticker.webm', expect.objectContaining({ maxChatId: 'chat-s' }), null);
      expect(mediaService.framesDirToGif).not.toHaveBeenCalled();
      expect(telegramBot.sendMessage).not.toHaveBeenCalled();
    });

    it('falls back to the GIF when Telegram does not take the video sticker', async () => {
      const { bridge, telegramBot, mediaService } = stickerBridge({ sendStickerFile: vi.fn(async () => null) });

      await bridge.forwardMaxMessage(maxMessage('st2', 'chat-s', {
        type: 'sticker', mediaPath: '/tmp/frames/st2', metadata: { animated: true, fps: 24 }
      }));

      expect(mediaService.framesDirToGif).toHaveBeenCalledWith('/tmp/frames/st2', 24);
      expect(telegramBot.sendMessage.mock.calls[0][0].mediaPath).toBe('/tmp/frames/st2/out.gif');
    });

    it('a static MAX sticker goes out as a WEBP sticker, with the photo as fallback', async () => {
      const { bridge, telegramBot, mediaService } = stickerBridge();

      await bridge.forwardMaxMessage(maxMessage('st3', 'chat-s', {
        type: 'sticker', mediaPath: '/tmp/media/sticker-st3.png'
      }));

      expect(mediaService.toWebpSticker).toHaveBeenCalledWith('/tmp/media/sticker-st3.png');
      expect(telegramBot.sendStickerFile.mock.calls[0][0]).toBe('/tmp/media/sticker-st3.png-tg-sticker.webp');
      expect(telegramBot.sendMessage).not.toHaveBeenCalled();
    });

    it('a sticker reply keeps its quote', async () => {
      const { bridge, db, telegramBot } = stickerBridge();
      db.insertMessage({
        id: 'orig', chatId: 'chat-s', direction: 'max_to_tg', type: 'text', text: 'как дела?',
        sourceMessageId: 'o', createdAt: Date.now(), metadata: {}, telegramMessageId: 321
      });

      await bridge.forwardMaxMessage(maxMessage('st4', 'chat-s', {
        type: 'sticker', mediaPath: '/tmp/media/sticker-st4.png', metadata: { replyToSnippet: 'как дела?' }
      }));

      expect(telegramBot.sendStickerFile.mock.calls[0][2]).toBe(321);
    });
  });

  it('falls back to the first frame as a photo when GIF encoding fails', async () => {
    const mediaService = makeFakeMediaService({
      framesDirToGif: vi.fn(async () => { throw new Error('gifski exploded'); })
    });
    const { bridge, db, telegramBot } = makeBridge({ mediaService });
    linkChat(db, 'chat-8');

    const message = maxMessage('m8', 'chat-8', {
      type: 'sticker',
      mediaPath: '/tmp/frames/stick-2',
      metadata: { animated: true, fps: 30 }
    });
    const result = await bridge.forwardMaxMessage(message);

    expect(result).toBe(true);
    expect(mediaService.framesDirToGif).toHaveBeenCalledTimes(1);
    expect(telegramBot.sendMessage).toHaveBeenCalledTimes(1);
    const [outgoing] = telegramBot.sendMessage.mock.calls[0];
    expect(outgoing.type).toBe('photo');
    // Full path, platform-safe: pins the directory component too, so a
    // regression that joins the frame onto the wrong dir cannot pass.
    expect(outgoing.mediaPath).toBe(path.join('/tmp/frames/stick-2', 'frame-000.png'));
    expect(outgoing.metadata.animated).toBe(false);
    expect(db.getDeliveryStats()).toEqual([{ status: 'sent', count: 1 }]);
  });
});

describe('computeMediaHash', () => {
  it('returns null for text messages and for missing paths without touching hashers', async () => {
    const { bridge, mediaService } = makeBridge();
    expect(await bridge.computeMediaHash('/tmp/a.jpg', 'text')).toBeNull();
    expect(await bridge.computeMediaHash(null, 'photo')).toBeNull();
    expect(mediaService.imageDHash).not.toHaveBeenCalled();
    expect(mediaService.fileContentHash).not.toHaveBeenCalled();
  });

  it('uses the perceptual hash for photos and the content hash for other media', async () => {
    const { bridge, mediaService } = makeBridge();
    expect(await bridge.computeMediaHash('/tmp/a.jpg', 'photo')).toBe('a1b2c3d4e5f60718');
    expect(mediaService.imageDHash).toHaveBeenCalledWith('/tmp/a.jpg');
    expect(await bridge.computeMediaHash('/tmp/v.mp4', 'video')).toBe('f'.repeat(32));
    expect(mediaService.fileContentHash).toHaveBeenCalledWith('/tmp/v.mp4');
  });

  it('swallows hashing failures and returns null so hashing never blocks forwarding', async () => {
    const mediaService = makeFakeMediaService({
      imageDHash: vi.fn(async () => { throw new Error('sharp died'); })
    });
    const { bridge } = makeBridge({ mediaService });
    expect(await bridge.computeMediaHash('/tmp/a.jpg', 'photo')).toBeNull();
  });
});

describe('forwardMaxMessage: files over Telegram\'s limit for bots', () => {
  it('sends a notice instead of failing on every retry', async () => {
    const tooBig = Object.assign(new Error('exceeds the 52428800 byte limit'), { code: 'EFILETOOBIG', bytes: 80 * 1024 * 1024 });
    const { bridge, db, telegramBot, mediaService } = makeBridge();
    linkChat(db, 'chat-a');
    mediaService.downloadUrl.mockRejectedValue(tooBig);
    const message = maxMessage('big-1', 'chat-a', { type: 'document', mediaUrl: 'https://fu.oneme.ru/f?r=T1', text: '' });
    message.originalFilename = 'Отчёт.pdf';

    await expect(bridge.forwardMaxMessage(message)).resolves.toBe(true);

    expect(telegramBot.sendMessage).toHaveBeenCalledTimes(1);
    const [sent] = telegramBot.sendMessage.mock.calls[0];
    expect(sent.type).toBe('text');
    expect(sent.text).toContain('«Отчёт.pdf»');
    expect(sent.text).toContain('больше 50 МБ');
    expect(message.telegramMessageId).toBeTruthy();
  });
});

describe('files MAX did not hand over', () => {
  const file = (id, metadata, text = '') => Object.assign(
    maxMessage(id, 'chat-a', { type: 'document', text, metadata }),
    { originalFilename: 'Фильм.mkv' }
  );

  it('names a file too big for Telegram, with its size, instead of sending it', async () => {
    const { bridge, db, telegramBot, mediaService } = makeBridge();
    linkChat(db, 'chat-a');

    await expect(bridge.forwardMaxMessage(file('f-1', { fileTooBig: true, fileSize: 1.5 * 1024 ** 3 }, 'смотри'))).resolves.toBe(true);

    expect(mediaService.downloadUrl).not.toHaveBeenCalled();
    const [sent] = telegramBot.sendMessage.mock.calls[0];
    expect(sent).toMatchObject({ type: 'text', mediaPath: null });
    expect(sent.text).toBe('📎 «Фильм.mkv» (1,5 ГБ) — больше 50 МБ, столько бот в Telegram отправить не может. Файл можно открыть в MAX.\n\nсмотри');
  });

  it('says a file was deleted in MAX, or could not be fetched', async () => {
    const { bridge, db, telegramBot } = makeBridge();
    linkChat(db, 'chat-a');

    await bridge.forwardMaxMessage(file('f-2', { fileUnavailable: true }));
    await bridge.forwardMaxMessage(file('f-3', { fileCaptureFailed: true, fileSize: 1290000 }));

    const texts = telegramBot.sendMessage.mock.calls.map(([sent]) => sent.text);
    expect(texts[0]).toBe('📎 «Фильм.mkv» — файл удалён или недоступен в MAX.');
    expect(texts[1]).toBe('📎 «Фильм.mkv» (1,2 МБ) — не удалось забрать из MAX. Файл можно открыть там.');
  });

  it('tries a file that did not download again on the next reads before giving up on it', async () => {
    const { bridge, db, maxClient, telegramBot } = makeBridge();
    linkChat(db, 'chat-a', { unread: true });
    const failed = file('f-4', { fileCaptureFailed: true });
    maxClient.readMessages.mockResolvedValue([failed]);

    await bridge.pollMax();
    await bridge.pollMax();
    expect(telegramBot.sendMessage).not.toHaveBeenCalled();
    expect(db.hasMessage('f-4')).toBe(false);

    await bridge.pollMax();
    expect(telegramBot.sendMessage.mock.calls[0][0].text).toContain('не удалось забрать из MAX');
    expect(db.hasMessage('f-4')).toBe(true);
  });

  it('delivers the file when a later read gets it', async () => {
    const { bridge, db, maxClient, telegramBot } = makeBridge();
    linkChat(db, 'chat-a', { unread: true });
    maxClient.readMessages.mockResolvedValueOnce([file('f-5', { fileCaptureFailed: true })]);
    await bridge.pollMax();

    const fetched = file('f-5', {});
    fetched.mediaPath = '/tmp/media/doc-f-5/Фильм.mkv';
    maxClient.readMessages.mockResolvedValue([fetched]);
    await bridge.pollMax();

    const [sent] = telegramBot.sendMessage.mock.calls[0];
    expect(sent).toMatchObject({ type: 'document', mediaPath: '/tmp/media/doc-f-5/Фильм.mkv' });
  });
});

describe('forwardMaxMessage: group chats', () => {
  it('passes the sender on, so Telegram shows who wrote it', async () => {
    const { bridge, db, telegramBot } = makeBridge();
    linkChat(db, 'Семья', { title: 'Семья' });
    await bridge.forwardMaxMessage(maxMessage('g-1', 'Семья', { text: 'ужин в 7', metadata: { sender: 'Мама' } }));
    expect(telegramBot.sendMessage.mock.calls[0][0].sender).toBe('Мама');
  });

  it('does not repeat the chat\'s own name (a channel, or a private chat)', async () => {
    const { bridge, db, telegramBot } = makeBridge();
    linkChat(db, 'Новости', { title: 'Новости' });
    await bridge.forwardMaxMessage(maxMessage('c-1', 'Новости', { text: 'пост', metadata: { sender: 'Новости' } }));
    expect(telegramBot.sendMessage.mock.calls[0][0].sender).toBeUndefined();
  });
});
