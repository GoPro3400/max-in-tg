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
    sendPhoto: vi.fn(async (chatId, input) => {
      // Drain the upload stream like a real request would, so no file handle
      // is still pending when the temp dir is removed.
      await new Promise((resolve) => {
        input.source.on('close', resolve).on('error', resolve).resume();
      });
      return { message_id: nextId++ };
    })
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
