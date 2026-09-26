import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import puppeteer from 'puppeteer';
import { serve } from '../fixtures/fakeMaxPage.js';

// The real MaxWebClient in a real Chromium, against a page built like MAX
// Web (tests/fixtures/fakeMaxPage.js). Skipped when no Chromium is around;
// CI points PUPPETEER_EXECUTABLE_PATH at the runner's Chrome.

const findChrome = () => {
  const candidates = [process.env.PUPPETEER_EXECUTABLE_PATH, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  try {
    candidates.push(puppeteer.executablePath());
  } catch {
    // no bundled browser
  }
  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) || null;
};
const chrome = findChrome();

const chats = () => ([
  {
    title: 'Bob',
    maxId: '1001',
    messages: [
      { id: 'm1', time: '12:00', text: ['Привет ', { emoji: '😀' }], reactions: [{ emoji: '👍', count: 1 }] },
      { id: 'm2', time: '12:01', text: ['Огонь ', { animoji: '🔥' }] },
      { id: 'm3', time: '12:02', big: [{ plain: '🫠' }] },
      { id: 'm4', time: '12:03', big: [{ anim: '👍' }] },
      { id: 'm5', time: '12:04', media: '/photo/p1.png?r=TOKEN1&fn=w_1280', reactions: [{ emoji: '❤️', count: 2 }], mine: '❤️' },
      { id: 'm6', time: '12:05', sticker: '/sticker/7?lottie=true' },
      { id: 'm7', time: '12:06', out: true, text: ['Моё сообщение'], reactions: [{ emoji: '😂', count: 1 }] },
      { id: 'm8', time: '12:07', text: ['Без реакций'] },
      { id: 'd1', time: '12:08', text: ['ок'] },
      { id: 'd2', time: '12:08', text: ['ок'] }
    ]
  },
  {
    title: 'Group',
    maxId: '-2002',
    messages: [
      { id: 'g1', time: '13:00', author: 'Анна', media: '/photo/p2.png?r=TOKEN2&fn=w_1280' },
      { id: 'g2', time: '13:01', author: 'Анна', text: ['Всем привет ', { emoji: '👋' }] },
      { id: 'g3', time: '13:02', text: ['и ещё'] },
      { id: 'g4', time: '13:03', author: 'Борис', text: ['привет'] },
      { id: 'g5', time: '13:04', out: true, text: ['моё'] },
      { id: 'g6', time: '13:05', text: ['без имени после моего'] }
    ]
  },
  {
    title: 'Files',
    messages: [
      { id: 'o1', time: '14:00', out: true, file: { name: 'Моё.pdf', size: '0.50 MB' } },
      { id: 'f1', time: '14:01', file: { name: 'Отчёт.pdf', size: '1.23 MB' } },
      { id: 'f2', time: '14:02', file: { name: 'Фильм.mkv', size: '1.50 GB' } },
      { id: 'f3', time: '14:03', file: { name: 'Старое.doc', deleted: true } },
      { id: 't1', time: '14:04', text: ['Смотри ', { link: 'https://example.com/file/42' }] },
      { id: 't2', time: '14:05', text: ['Статья ', { link: 'https://example.com/a' }], share: { url: 'https://example.com/a', image: '/photo/prev.png' } },
      { id: 'f4', time: '14:06', file: { name: 'IMG_1.jpg', size: '2.00 MB', preview: '/photo/p3.png' } },
      { id: 'l1', time: '14:07', location: true },
      // Ours and theirs, the same minute, the same name: the same id.
      { id: 'o2', time: '14:08', out: true, file: { name: 'Акт.pdf', size: '0.10 MB' } },
      { id: 'f5', time: '14:08', file: { name: 'Акт.pdf', size: '0.10 MB' } }
    ]
  }
]);

describe.skipIf(!chrome)('MaxWebClient in Chromium', { timeout: 30000 }, () => {
  let MaxWebClient;
  let config;
  let site;
  let client;
  let dir;

  const openChat = async (title) => {
    client.activeChatId = null;
    await client.selectChat(title);
    await new Promise((resolve) => setTimeout(resolve, 1200)); // lottie players settle
  };
  const pageState = (id) => client.page.evaluate((mid) => {
    for (const chat of window.__chats) for (const m of chat.messages) if (m.id === mid) return { mine: m.mine || null, reactions: m.reactions || [] };
    return null;
  }, id);

  beforeAll(async () => {
    process.env.PUPPETEER_EXECUTABLE_PATH = chrome;
    process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'silent';
    ({ MaxWebClient } = await import('../../src/adapters/maxWebClient.js'));
    ({ config } = await import('../../src/config.js'));
    site = await serve({ chats: chats() });
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'max-browser-'));
    client = new MaxWebClient(
      { ...config.max, webUrl: site.url, headless: true, userDataDir: path.join(dir, 'profile'), remoteDebuggingPort: 0, protocolTimeoutMs: 30000 },
      { mediaDir: path.join(dir, 'media') }
    );
    await client.start();
    await client.waitForReady(20000);
    await openChat('Bob');
  }, 60000);

  afterAll(async () => {
    await client?.stop().catch(() => {});
    site?.server.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('puts the time from the meta line into bubble ids, and knows their old ids', async () => {
    const origin = new URL(site.url).origin;
    const rows = await client.scrapeMessageRows();
    const ids = rows.map((row) => row.rawId);
    expect(ids[0]).toBe(`12:00|Привет|${origin}/e/1f600.png`);
    expect(ids[1]).toMatch(/^12:01\|Огонь\|data:image\/png;base64,/);
    expect(ids[2]).toBe(`12:02|${origin}/e/1fae0.png`);
    expect(ids[3]).toBe('12:03');
    expect(ids[4]).toBe(`12:04|${origin}/photo/p1.png?r=TOKEN1&fn=w_1280`);
    expect(ids[6]).toBe('12:06|Моё сообщение');
    // Before, texts had no time in their ids; bubbles without a text of their
    // own had it by accident (it was their first .text), and keep their ids.
    const legacy = rows.map((row) => row.legacyRawId);
    expect(legacy[0]).toBe(`Привет|${origin}/e/1f600.png`);
    expect(legacy[6]).toBe('Моё сообщение');
    expect(legacy.slice(2, 6)).toEqual(ids.slice(2, 6));
    // The previous build numbered identical bubbles too.
    expect(legacy.slice(8, 10)).toEqual(['ок', 'ок#d2']);
  });

  it('keeps animoji still and stickers animated', async () => {
    const canvases = await client.page.evaluate(() => ({
      animoji: document.querySelectorAll('.lottie:not([data-url*="lottie=true"]) canvas').length,
      sticker: document.querySelectorAll('.lottie[data-url*="lottie=true"] canvas').length
    }));
    expect(canvases).toEqual({ animoji: 0, sticker: 1 });
    expect(site.requests.some((request) => request.startsWith('/animoji/'))).toBe(true);
  });

  it('reads texts with their emoji and never takes an emoji picture for a photo', async () => {
    const messages = await client.readMessages('Bob', { isKnown: () => false });
    const at = (time) => messages.find((message) => message.metadata.time === time);
    expect(at('12:00')).toMatchObject({ type: 'text', text: 'Привет 😀' });
    expect(at('12:01')).toMatchObject({ type: 'text', text: 'Огонь 🔥', mediaUrl: null });
    expect(at('12:02')).toMatchObject({ type: 'text', text: '🫠' });
    expect(at('12:03')).toMatchObject({ type: 'text', text: '👍' });
    expect(at('12:04')).toMatchObject({ type: 'photo', text: '' }); // the time is no caption
    expect(at('12:04').mediaUrl).toContain('TOKEN1');
    expect(at('12:00').metadata.legacyId).toMatch(/^Привет\|/);
    expect(at('12:04').metadata.legacyId).toBeUndefined();
  });

  it('numbers identical bubbles instead of dropping the second', async () => {
    const messages = await client.readMessages('Bob', { isKnown: () => false });
    expect(messages.filter((message) => message.text === 'ок').map((message) => message.sourceMessageId))
      .toEqual(['12:08|ок', '12:08|ок#d2']);
  });

  it('reads reactions, marks ours, and keeps neighbours apart', async () => {
    await client.readMessages('Bob', { isKnown: () => false });
    const rows = await client.readReactions('Bob');
    const at = (time) => rows.find((row) => row.rawId.startsWith(time));
    expect(at('12:00').reactions).toEqual([{ emoji: '👍', count: 1, active: false }]);
    expect(at('12:04').reactions).toEqual([{ emoji: '❤️', count: 2, active: true }]);
    expect(at('12:04').mediaToken).toBe('TOKEN1');
    expect(at('12:06')).toMatchObject({ outgoing: true, reactions: [{ emoji: '😂', count: 1, active: false }] });
    expect(at('12:07').reactions).toEqual([]);
  });

  it('reacts through an existing chip, the menu and its expanded list', async () => {
    let result = await client.reactToMessage('Bob', rowId('12:00'), '👍');
    expect(result).toMatchObject({ ok: true, changed: true });
    expect((await pageState('m1')).mine).toBe('👍');
    expect(await client.reactToMessage('Bob', rowId('12:00'), '👍')).toMatchObject({ ok: true, changed: false });

    result = await client.reactToMessage('Bob', rowId('12:07'), '🔥');
    expect(result).toMatchObject({ ok: true, changed: true });
    expect((await pageState('m8')).mine).toBe('🔥');

    result = await client.reactToMessage('Bob', rowId('12:07'), '🎉');
    expect(result).toMatchObject({ ok: true, changed: true });
    expect((await pageState('m8')).mine).toBe('🎉');
  });

  it('picks the nearest relative MAX has, and reports an emoji it lacks', async () => {
    const relative = await client.reactToMessage('Bob', rowId('12:07'), ['🤣', '😂']);
    expect(relative).toMatchObject({ ok: true, emoji: '😂' });

    const missing = await client.reactToMessage('Bob', rowId('12:07'), '🤡');
    expect(missing).toMatchObject({ ok: false, reason: 'emoji-not-available' });
    expect(missing.available).toContain('👍');
    expect(await client.page.evaluate(() => Boolean(document.querySelector('[role=menu]')))).toBe(false);
  });

  it('takes a reaction back, finds media by token, and never closes the chat with Escape', async () => {
    expect(await client.reactToMessage('Bob', rowId('12:07'), null)).toMatchObject({ ok: true, changed: true });
    expect((await pageState('m8')).mine).toBeNull();
    expect(await client.reactToMessage('Bob', 'media-token:TOKEN1', '👍')).toMatchObject({ ok: true });
    expect((await pageState('m5')).mine).toBe('👍');
    expect(await client.reactToMessage('Bob', 'no|such|bubble', '👍')).toMatchObject({ ok: false, reason: 'message-not-found' });
    expect(await client.page.evaluate(() => [window.__escapeClosedChat, window.__active])).toEqual([0, 'Bob']);
  });

  it('reacts on the second of two identical bubbles', async () => {
    expect(await client.reactToMessage('Bob', '12:08|ок#d2', '👍')).toMatchObject({ ok: true, changed: true });
    expect((await pageState('d1')).mine).toBeNull();
    expect((await pageState('d2')).mine).toBe('👍');
  });

  it('falls back to the "Message actions" button without a context menu', async () => {
    await client.page.evaluate(() => { opts.noContextMenu = true; });
    try {
      expect(await client.reactToMessage('Bob', rowId('12:06'), '❤')).toMatchObject({ ok: true });
      expect((await pageState('m7')).mine).toBe('❤️');
    } finally {
      await client.page.evaluate(() => { opts.noContextMenu = false; });
    }
  });

  it('sends only the new text when an old one was left in the composer', async () => {
    await client.page.evaluate(() => { document.getElementById('composer').textContent = 'остаток прошлой попытки'; });
    await client.sendText('Bob', 'новое сообщение');
    const sent = await client.page.evaluate(() => window.__sent);
    expect(sent.at(-1)).toEqual({ chat: 'Bob', text: 'новое сообщение' });
  });

  it('does not take the sender\'s name for a caption, and keeps emoji in group texts', async () => {
    await openChat('Group');
    const messages = await client.readMessages('Group', { isKnown: () => false });
    const photo = messages.find((message) => message.metadata.time === '13:00');
    expect(photo).toMatchObject({ type: 'photo', text: '' });
    // Its old id took the sender's name for its text.
    expect(photo.sourceMessageId).toMatch(/^13:00\|http/);
    expect(photo.metadata.legacyId).toMatch(/^Анна\|http/);
    expect(messages.find((message) => message.metadata.time === '13:01')).toMatchObject({ type: 'text', text: 'Всем привет 👋' });
    const senders = Object.fromEntries(messages.map((message) => [message.metadata.time, message.metadata.sender]));
    // MAX names the sender on the first bubble of a run only.
    expect(senders).toMatchObject({ '13:00': 'Анна', '13:01': 'Анна', '13:02': 'Анна', '13:03': 'Борис' });
    expect(senders['13:05']).toBeUndefined();
    await openChat('Bob');
  });

  it('fetches each file from its own card, and never takes a link for a file', async () => {
    await openChat('Files');
    const messages = await client.readMessages('Files', { isKnown: () => false });
    const at = (time) => messages.find((message) => message.metadata.time === time);
    // Our own file before it used to be clicked instead (bubbles were counted
    // differently in the page).
    expect(at('14:01')).toMatchObject({ type: 'document', originalFilename: 'Отчёт.pdf' });
    expect(fs.readFileSync(at('14:01').mediaPath, 'utf8')).toMatch(/^FILE:Отчёт\.pdf/);
    // A picture sent as a file is that file, not a photo of its preview.
    expect(at('14:06')).toMatchObject({ type: 'document', originalFilename: 'IMG_1.jpg' });
    expect(fs.readFileSync(at('14:06').mediaPath, 'utf8')).toMatch(/^FILE:IMG_1\.jpg/);
    // Too big for Telegram: not downloaded at all.
    expect(at('14:02')).toMatchObject({ type: 'document', mediaPath: null });
    expect(at('14:02').metadata).toMatchObject({ fileTooBig: true, fileSize: Math.round(1.5 * 1024 ** 3) });
    expect(at('14:03').metadata.fileUnavailable).toBe(true);
    expect(await client.page.evaluate(() => window.__downloads)).toEqual(['Отчёт.pdf', 'IMG_1.jpg', 'Акт.pdf']);
    // Theirs, not ours.
    expect(await client.page.evaluate(() => window.__clickedFiles)).toEqual(['f1', 'f4', 'f5']);
    expect(at('14:08').sourceMessageId).toBe('14:08|Акт.pdf');
    // A link in the text, and a link's preview card, are texts.
    expect(at('14:04')).toMatchObject({ type: 'text', mediaUrl: null, text: 'Смотри https://example.com/file/42' });
    expect(at('14:05')).toMatchObject({ type: 'text', mediaUrl: null });
    // What cannot be carried over is named, not dropped (nor sent as "14:07").
    expect(at('14:07')).toMatchObject({ type: 'text', text: '📍 Геопозиция — открой в MAX' });
    await openChat('Bob');
  });

  it('knows the open chat\'s own id in MAX from the address, never the previous chat\'s', async () => {
    await openChat('Group');
    expect(client.activeMaxChatId).toBe('-2002');
    await openChat('Bob');
    expect(client.activeMaxChatId).toBe('1001');
    // Opened again without the address changing: not trusted.
    await openChat('Bob');
    expect(client.activeMaxChatId).toBeNull();
    // A chat whose address says nothing.
    await openChat('Files');
    expect(client.activeMaxChatId).toBeNull();
    await openChat('Bob');
  });

  it('sees who is typing in the chat list, and what they are doing', async () => {
    expect(await client.typingChats()).toEqual([]);
    await client.page.evaluate(() => {
      window.__chats[0].typing = 'печатает';
      window.__chats[1].typing = 'Анна записывает аудио';
      window.renderChats();
    });
    expect(await client.typingChats()).toEqual([
      { chatId: 'Bob', action: 'typing' },
      { chatId: 'Group', action: 'record_voice' }
    ]);
    // The chat titles still read the same.
    expect((await client.listChats()).map((chat) => chat.title)).toEqual(['Bob', 'Group', 'Files']);
  });

  it('learns the id of the open chat when MAX renames it (the address stays the same)', async () => {
    await openChat('Group');
    await openChat('Bob');
    expect(client.activeMaxChatId).toBe('1001');
    await client.page.evaluate(() => {
      window.__chats[0].title = 'Bobby';
      window.renderChats();
    });
    // Opened from Bob itself: another chat and back, then the id is sure.
    await client.selectChat('Bobby');
    expect(client.activeChatId).toBe('Bobby');
    expect(client.activeMaxChatId).toBe('1001');
    await client.page.evaluate(() => {
      window.__chats[0].title = 'Bob';
      window.renderChats();
    });
    await openChat('Bob');
  });

  it('notices a crashed page at once', async () => {
    expect(client.isAlive()).toBe(true);
    await client.page.goto('chrome://crash').catch(() => null);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(client.isAlive()).toBe(false);
  });

  // Ids of the bubbles on screen right now, by their time.
  let rowIds = null;
  function rowId(time) {
    return rowIds.find((id) => id.startsWith(`${time}|`) || id === time);
  }
  beforeAll(async () => {
    rowIds = (await client.scrapeMessageRows()).map((row) => row.rawId);
  });
});
