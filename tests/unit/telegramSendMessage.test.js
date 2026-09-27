import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi, afterAll } from 'vitest';
import { TelegramBotAdapter, splitTelegramText } from '../../src/adapters/telegramBot.js';

// Telegram refuses a text over 4096 characters and a caption over 1024. The
// bridge used to pass MAX content through untouched, so a long message or a
// photo with a long description failed on every retry until it was given up
// on and dropped. These pin how it is split instead.

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-send-'));
const photoPath = path.join(tmpDir, 'p.jpg');
fs.writeFileSync(photoPath, 'jpg');

afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

function makeAdapter() {
  const adapter = new TelegramBotAdapter({ token: 'test:token', ownerId: 1, relayChatId: -100, useTopics: true }, {});
  let nextId = 100;
  const api = {
    sendMessage: vi.fn(async () => ({ message_id: nextId++ })),
    sendPhoto: vi.fn(async () => ({ message_id: nextId++ }))
  };
  Object.assign(adapter.bot.telegram, api);
  return { adapter, api };
}

describe('splitTelegramText', () => {
  it('leaves short text alone', () => {
    expect(splitTelegramText('hello')).toEqual(['hello']);
    expect(splitTelegramText('')).toEqual(['']);
  });

  it('splits at a line break or space, every part within the limit, nothing lost', () => {
    const text = `${'a'.repeat(30)}\n${'b'.repeat(30)} ${'c'.repeat(30)}`;
    const parts = splitTelegramText(text, 40);
    expect(parts.every((part) => part.length <= 40)).toBe(true);
    expect(parts[0]).toBe('a'.repeat(30));
    expect(parts.join('')).toBe(text.replace(/[\n ]/g, ''));
  });

  it('hard-splits a long word without breaking a surrogate pair', () => {
    const text = 'x'.repeat(9) + '😀'.repeat(10);
    const parts = splitTelegramText(text, 10);
    expect(parts.join('')).toBe(text);
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(10);
      expect(part).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
    }
  });
});

describe('TelegramBotAdapter.sendMessage file handling', () => {
  it('passes the file PATH to Telegraf, so a missing file is a rejected send, not a process crash', async () => {
    // A bare fs.createReadStream() on a missing file emits an 'error' nobody
    // listens to — an uncaught exception that took the whole bridge down
    // (reached via the animated-sticker fallback). Telegraf stats a path and
    // rejects normally.
    const { adapter, api } = makeAdapter();

    await adapter.sendMessage({ type: 'photo', text: '', mediaPath: photoPath }, { telegramChatId: -100 });

    expect(api.sendPhoto.mock.calls[0][1]).toEqual({ source: photoPath });
  });
});

describe('TelegramBotAdapter.sendMessage limits', () => {
  it('sends a text over 4096 characters in parts, quoting only on the first, returning the first', async () => {
    const { adapter, api } = makeAdapter();
    const text = `${'слово '.repeat(1000)}`.trim(); // ~6000 chars

    const sent = await adapter.sendMessage(
      { type: 'text', text, replyToMessageId: 55 },
      { telegramChatId: -100, telegramThreadId: 7 }
    );

    expect(api.sendMessage).toHaveBeenCalledTimes(2);
    const [first, second] = api.sendMessage.mock.calls;
    expect(first[1].length).toBeLessThanOrEqual(4096);
    expect(first[2]).toMatchObject({ message_thread_id: 7, reply_parameters: { message_id: 55 } });
    expect(second[2]).toEqual({ message_thread_id: 7 });
    expect(`${first[1]} ${second[1]}`).toBe(text);
    expect(sent.message_id).toBe(100);
  });

  it('moves a caption over 1024 characters into a follow-up reply to the media', async () => {
    const { adapter, api } = makeAdapter();
    const caption = 'описание '.repeat(200).trim(); // ~1800 chars

    const sent = await adapter.sendMessage(
      { type: 'photo', text: caption, mediaPath: photoPath },
      { telegramChatId: -100, telegramThreadId: 7 }
    );

    expect(api.sendPhoto).toHaveBeenCalledTimes(1);
    expect(api.sendPhoto.mock.calls[0][2].caption).toBeUndefined();
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(api.sendMessage.mock.calls[0][1]).toBe(caption);
    expect(api.sendMessage.mock.calls[0][2]).toMatchObject({ message_thread_id: 7, reply_parameters: { message_id: sent.message_id } });
  });

  it('keeps a caption that fits on the media itself', async () => {
    const { adapter, api } = makeAdapter();

    await adapter.sendMessage({ type: 'photo', text: 'короткая подпись', mediaPath: photoPath }, { telegramChatId: -100 });

    expect(api.sendPhoto.mock.calls[0][2].caption).toBe('короткая подпись');
    expect(api.sendMessage).not.toHaveBeenCalled();
  });
});

describe('TelegramBotAdapter.sendStickerFile', () => {
  function stickerAdapter(sendSticker) {
    const adapter = new TelegramBotAdapter({ token: 'test:token', ownerId: 1, relayChatId: -100, useTopics: true }, {});
    const api = { sendSticker: vi.fn(sendSticker), deleteMessage: vi.fn(async () => true) };
    Object.assign(adapter.bot.telegram, api);
    return { adapter, api };
  }

  it('returns the message when Telegram shows it as a sticker, with thread and quote', async () => {
    const { adapter, api } = stickerAdapter(async () => ({ message_id: 7, sticker: { file_id: 'x' } }));

    const sent = await adapter.sendStickerFile('/tmp/s.webm', { telegramChatId: -100, telegramThreadId: 5 }, 42);

    expect(sent.message_id).toBe(7);
    expect(api.sendSticker).toHaveBeenCalledWith(-100, { source: '/tmp/s.webm' }, {
      message_thread_id: 5,
      reply_parameters: { message_id: 42, allow_sending_without_reply: true }
    });
  });

  it('removes a file Telegram posted as a plain document and reports failure, so the caller falls back', async () => {
    const { adapter, api } = stickerAdapter(async () => ({ message_id: 8, document: { file_id: 'x' } }));

    await expect(adapter.sendStickerFile('/tmp/s.webm', { telegramChatId: -100 })).resolves.toBeNull();
    expect(api.deleteMessage).toHaveBeenCalledWith(-100, 8);
  });

  it('treats a rejected upload as "fall back", but lets flood control through', async () => {
    const rejected = stickerAdapter(async () => { throw Object.assign(new Error('400: Bad Request: STICKER_VIDEO_LONG'), { code: 400 }); });
    await expect(rejected.adapter.sendStickerFile('/tmp/s.webm', {})).resolves.toBeNull();

    const flooded = stickerAdapter(async () => { throw Object.assign(new Error('429: retry after 9'), { code: 429, parameters: { retry_after: 9 } }); });
    await expect(flooded.adapter.sendStickerFile('/tmp/s.webm', {})).rejects.toThrow('429');
  });
});

describe('Telegram size limits for bots', () => {
  const sparseFile = (name, bytes) => {
    const filePath = path.join(tmpDir, name);
    fs.writeFileSync(filePath, '');
    fs.truncateSync(filePath, bytes);
    return filePath;
  };

  it('says what a file over 50 MB was instead of failing on every retry', async () => {
    const { adapter, api } = makeAdapter();
    adapter.bot.telegram.sendDocument = api.sendDocument = vi.fn();
    const filePath = sparseFile('big.zip', 51 * 1024 * 1024);

    await adapter.sendMessage({ type: 'document', mediaPath: filePath, originalFilename: 'Архив.zip', text: 'вот' }, { telegramChatId: -100, telegramThreadId: 5 });

    expect(api.sendDocument).not.toHaveBeenCalled();
    const [chatId, text, extra] = api.sendMessage.mock.calls[0];
    expect(chatId).toBe(-100);
    expect(text).toContain('«Архив.zip»');
    expect(text).toContain('51,0 МБ');
    expect(text).toContain('вот');
    expect(extra.message_thread_id).toBe(5);
  });

  it('sends a photo over 10 MB as a file', async () => {
    const { adapter, api } = makeAdapter();
    adapter.bot.telegram.sendDocument = api.sendDocument = vi.fn(async () => ({ message_id: 1 }));
    const filePath = sparseFile('huge.jpg', 11 * 1024 * 1024);

    await adapter.sendMessage({ type: 'photo', mediaPath: filePath }, { telegramChatId: -100 });

    expect(api.sendPhoto).not.toHaveBeenCalled();
    expect(api.sendDocument).toHaveBeenCalledTimes(1);
  });
});

describe('Telegram -> MAX: files Telegram will not hand to a bot', () => {
  it('explains the 20 MB limit instead of "file is too big"', async () => {
    const adapter = new TelegramBotAdapter({ token: 'test:token', ownerId: 1, relayChatId: null, useTopics: false }, {
      telegramFileToLocal: vi.fn(async () => '/tmp/never')
    });
    adapter.bot.botInfo = { id: 9, is_bot: true, username: 'testbot', first_name: 'test' };
    const reply = vi.fn(async () => ({ message_id: 1 }));
    adapter.bot.context.telegram = { sendMessage: reply };
    const outbound = vi.fn(async () => {});
    adapter.onMessage(outbound);

    await adapter.bot.handleUpdate({
      update_id: 1,
      message: {
        message_id: 7,
        date: 1700000000,
        chat: { id: 1, type: 'private' },
        from: { id: 1, is_bot: false, first_name: 'owner' },
        document: { file_id: 'F', file_unique_id: 'U', file_name: 'Видео.mp4', file_size: 25 * 1024 * 1024 }
      }
    });

    expect(outbound).not.toHaveBeenCalled();
    expect(adapter.mediaService.telegramFileToLocal).not.toHaveBeenCalled();
    const text = reply.mock.calls[0][1];
    expect(text).toMatch(/^⚠️ Файл «Видео\.mp4» весит 25,0 МБ/);
    expect(text).toContain('до 20 МБ');
  });
});

describe('group chats: the sender above the message', () => {
  it('puts the sender in bold on top of a text', async () => {
    const { adapter, api } = makeAdapter();
    await adapter.sendMessage({ type: 'text', text: 'Всем привет', sender: 'Анна' }, { telegramChatId: -100 });
    const [, text, extra] = api.sendMessage.mock.calls[0];
    expect(text).toBe('Анна\nВсем привет');
    expect(extra.entities).toEqual([{ type: 'bold', offset: 0, length: 4 }]);
  });

  it('uses the caption for media, and the sender alone when the text goes separately', async () => {
    const { adapter, api } = makeAdapter();
    await adapter.sendMessage({ type: 'photo', mediaPath: photoPath, text: 'смотрите', sender: 'Анна' }, { telegramChatId: -100 });
    expect(api.sendPhoto.mock.calls[0][2]).toMatchObject({ caption: 'Анна\nсмотрите', caption_entities: [{ type: 'bold', offset: 0, length: 4 }] });

    await adapter.sendMessage({ type: 'photo', mediaPath: photoPath, text: 'x'.repeat(1500), sender: 'Анна' }, { telegramChatId: -100 });
    expect(api.sendPhoto.mock.calls[1][2].caption).toBe('Анна');
  });

  it('leaves messages without a sender as they were', async () => {
    const { adapter, api } = makeAdapter();
    await adapter.sendMessage({ type: 'text', text: 'привет' }, { telegramChatId: -100 });
    expect(api.sendMessage.mock.calls[0][1]).toBe('привет');
    expect(api.sendMessage.mock.calls[0][2].entities).toBeUndefined();
  });
});
