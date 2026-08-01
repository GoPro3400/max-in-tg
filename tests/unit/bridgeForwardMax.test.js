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
    // Prior forwarded copy of the same bubble under an older signed URL:
    // same chat, same perceptual hash, same stable fingerprint prefix
    // (the part before the first '|').
    db.insertMessage({
      ...maxMessage('old-copy', 'chat-4', {
        type: 'photo',
        sourceMessageId: '12:00 photo|old-signed-url'
      }),
      mediaHash: 'a1b2c3d4e5f60718'
    });

    const message = maxMessage('m4', 'chat-4', {
      type: 'photo',
      mediaUrl: 'https://i.oneme.ru/i?r=NEWTOKEN&fn=w_1280',
      sourceMessageId: '12:00 photo|new-signed-url'
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
        sourceMessageId: '12:00 photo|old-signed-url'
      }),
      mediaHash: 'a1b2c3d4e5f60718'
    });

    const message = maxMessage('m4b', 'chat-4', {
      type: 'photo',
      mediaUrl: 'https://i.oneme.ru/i?r=OTHERTOKEN&fn=w_1280',
      sourceMessageId: '18:45 photo|new-signed-url' // different prefix
    });
    const result = await bridge.forwardMaxMessage(message);

    expect(result).toBe(true);
    expect(telegramBot.sendMessage).toHaveBeenCalledTimes(1);
    expect(telegramBot.sendMessage.mock.calls[0][0].id).toBe('m4b');
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
    // Non-photo media identity uses the content hash of the encoded file.
    expect(mediaService.fileContentHash).toHaveBeenCalledWith('/tmp/frames/stick-1/out.gif');
    expect(db.getDeliveryStats()).toEqual([{ status: 'sent', count: 1 }]);
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
