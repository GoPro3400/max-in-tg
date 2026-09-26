import { describe, it, expect, vi } from 'vitest';
import { stableId } from '../../src/domain/messages.js';
import { phoneQuery } from '../../src/services/bridge.js';
import { TelegramBotAdapter } from '../../src/adapters/telegramBot.js';
import { makeBridge, makeFakeMaxClient, linkChat, maxMessage } from '../helpers/bridgeHarness.js';

// /new <имя или номер>: MAX's search finds chats and people, the owner picks
// one with a button, and only then is that chat opened in MAX and given a
// topic. Nothing is ever sent to anyone.

const FOUND = [
  { kind: 'chat', title: 'Иван', hint: '', ordinal: 0 },
  { kind: 'global', title: 'Иван Петров', hint: '@ivan', ordinal: 0 },
  { kind: 'phone', title: '', hint: '', ordinal: 0 }
];

const setup = ({ found = FOUND, opened = { title: 'Иван Петров', maxId: '5005', listed: false }, shown = [] } = {}) => {
  const maxClient = makeFakeMaxClient({
    searchChats: vi.fn(async () => found),
    openSearchResult: vi.fn(async () => {
      maxClient.activeChatId = opened.title;
      maxClient.activeMaxChatId = opened.maxId;
      return opened;
    }),
    readMessages: vi.fn(async (chatId) => shown.map((make) => make(chatId))),
    rememberChatId: vi.fn(),
    forgetActiveChat: vi.fn(() => {
      maxClient.activeChatId = null;
      maxClient.activeMaxChatId = null;
    })
  });
  return makeBridge({ maxClient });
};

const bubble = (time, text) => (chatId) => maxMessage(stableId('max', chatId, `${time}|${text}`), chatId, {
  text,
  sourceMessageId: `${time}|${text}`,
  metadata: { time }
});

const pick = async (bridge, query, label) => {
  const offer = await bridge.startNewChat(query);
  const choice = offer.choices.find((item) => item.label.includes(label));
  const [, sessionId, index] = choice.data.split(':');
  return bridge.chooseNewChat(sessionId, index);
};

describe('phoneQuery', () => {
  it('turns what people type into a number MAX searches by', () => {
    expect(phoneQuery('+7 999 123-45-67')).toBe('+79991234567');
    expect(phoneQuery('8 (999) 123-45-67')).toBe('+79991234567');
    expect(phoneQuery('79991234567')).toBe('+79991234567');
    expect(phoneQuery('9991234567')).toBe('+79991234567');
    expect(phoneQuery('+44 20 7946 0958')).toBe('+442079460958');
    expect(phoneQuery('0044 20 7946 0958')).toBe('+442079460958');
    expect(phoneQuery('Иван Петров')).toBeNull();
    expect(phoneQuery('12345')).toBeNull();
  });
});

describe('/new', () => {
  it('offers what MAX found by name: own chats and people, never the phone action', async () => {
    const { bridge, maxClient } = setup();
    const offer = await bridge.startNewChat('Иван');
    expect(maxClient.searchChats).toHaveBeenCalledWith('Иван');
    expect(offer.choices.map((choice) => choice.label)).toEqual(['💬 Иван', '👤 Иван Петров · @ivan', 'Отмена']);
    expect(offer.choices.every((choice) => /^new:[\w-]+:(\d+|x)$/.test(choice.data))).toBe(true);
  });

  it('searches a phone number the way MAX wants it, and offers only "find by number"', async () => {
    const { bridge, maxClient } = setup();
    const offer = await bridge.startNewChat('8 999 123-45-67');
    expect(maxClient.searchChats).toHaveBeenCalledWith('+79991234567');
    expect(offer.choices.map((choice) => choice.label)).toEqual(['📞 +7 999 123-45-67 — найти в MAX', 'Отмена']);
  });

  it('says why when there is nothing to offer', async () => {
    const empty = setup({ found: [] });
    expect((await empty.bridge.startNewChat('Никто')).text).toContain('ничего не нашлось');
    const noPhone = setup({ found: [{ kind: 'chat', title: '79991234567', ordinal: 0 }] });
    const offer = await noPhone.bridge.startNewChat('+7 999 123 45 67');
    expect(offer.text).toContain('нужен полный номер');
    expect(offer.choices).toBeUndefined();
    const usage = await empty.bridge.startNewChat('  ');
    expect(usage.text).toContain('/new Иван Петров');
  });

  it('does nothing while MAX is not connected', async () => {
    const { bridge, maxClient } = setup();
    maxClient.getSessionState.mockResolvedValue('login');
    expect((await bridge.startNewChat('Иван')).text).toContain('MAX не подключён');
    expect(maxClient.searchChats).not.toHaveBeenCalled();
  });

  it('opens the chat picked, gives it a topic and a link to it, and delivers none of its history', async () => {
    const { bridge, db, maxClient, telegramBot } = setup({
      shown: [(chatId) => maxMessage(stableId('max', chatId, '10:00|давнее'), chatId, { text: 'давнее', sourceMessageId: '10:00|давнее' })]
    });

    const text = await pick(bridge, 'Иван', 'Иван Петров');

    expect(maxClient.openSearchResult).toHaveBeenCalledWith('Иван', expect.objectContaining({ kind: 'global', title: 'Иван Петров' }));
    expect(telegramBot.createTopic).toHaveBeenCalledWith('Иван Петров');
    expect(db.getChatMapping('Иван Петров')).toMatchObject({ telegramChatId: -100500, telegramThreadId: 7700 });
    expect(text).toContain('https://t.me/c/500/7700');
    // MAX lists a chat only once it has messages: it is opened by its id,
    // and its first message watched.
    expect(db.getSetting('max_chat:5005')).toBe('Иван Петров');
    expect(maxClient.rememberChatId).toHaveBeenCalledWith('Иван Петров', '5005', { listed: false });
    expect(db.getMessage(stableId('max', 'Иван Петров', '10:00|давнее')).metadata.primedAsBacklog).toBe(true);
    expect(telegramBot.sendMessage).not.toHaveBeenCalled();
  });

  it('notes in the new topic that it was started by phone number', async () => {
    const { bridge, telegramBot } = setup();
    await pick(bridge, '+7 999 123-45-67', 'найти в MAX');
    expect(telegramBot.sendText).toHaveBeenCalledWith(expect.stringContaining('+7 999 123-45-67'), expect.objectContaining({ telegramThreadId: 7700 }));
  });

  it('points to the topic a chat already has instead of making another', async () => {
    const { bridge, db, telegramBot } = setup({ opened: { title: 'Иван', maxId: '4004' } });
    linkChat(db, 'Иван', { telegramThreadId: 77 });
    const text = await pick(bridge, 'Иван', '💬 Иван');
    expect(text).toContain('тема уже есть');
    expect(telegramBot.createTopic).not.toHaveBeenCalled();
  });

  it('refuses a chat named like another one of the bridge (they would share a topic), and lets go of it in MAX', async () => {
    const { bridge, db, maxClient, telegramBot } = setup();
    linkChat(db, 'Иван Петров', { telegramThreadId: 77 });
    db.setSetting('max_chat:9009', 'Иван Петров');
    const text = await pick(bridge, 'Иван', 'Иван Петров');
    expect(text).toContain('другой чат с именем «Иван Петров»');
    expect(telegramBot.createTopic).not.toHaveBeenCalled();
    // What opened is not that chat: the next message into its topic must
    // not be typed into it.
    expect(maxClient.forgetActiveChat).toHaveBeenCalled();
    expect([maxClient.activeChatId, maxClient.activeMaxChatId]).toEqual([null, null]);
    expect(maxClient.readMessages).not.toHaveBeenCalled();
    expect(db.getSetting('max_chat:5005', '')).toBe('');
    expect(maxClient.rememberChatId).not.toHaveBeenCalled();
  });

  it('refuses someone found beyond the owner\'s chats under the name of a chat it has, unless its id says it is that chat', async () => {
    // The bridge has an "Иван Петров" (muted, say: its id in MAX never read).
    const byName = setup();
    linkChat(byName.db, 'Иван Петров', { telegramThreadId: 77 });
    const text = await pick(byName.bridge, 'Иван', '👤 Иван Петров');
    expect(text).toContain('уже есть чат «Иван Петров» (https://t.me/c/500/77)');
    expect(byName.maxClient.forgetActiveChat).toHaveBeenCalled();
    expect(byName.db.getSetting('max_chat:5005', '')).toBe('');

    const byPhone = setup();
    byPhone.db.upsertChat({ id: 'Иван Петров', title: 'Иван Петров', lastSeenAt: Date.now(), metadata: {} });
    expect(await pick(byPhone.bridge, '+7 999 123-45-67', 'найти в MAX')).toContain('уже есть чат «Иван Петров»');
    expect(byPhone.telegramBot.createTopic).not.toHaveBeenCalled();

    // One of that name renamed away in MAX is not in the way.
    const renamed = setup();
    renamed.db.upsertChat({ id: 'Иван Петров', title: 'Иван Петров', lastSeenAt: Date.now(), metadata: { renamedTo: 'Иван П.' } });
    expect(await pick(renamed.bridge, 'Иван', '👤 Иван Петров')).toContain('готов');
    expect(renamed.db.listChats().find((item) => item.id === 'Иван Петров').metadata).toMatchObject({ startedWithNew: true });
    expect(renamed.db.listChats().find((item) => item.id === 'Иван Петров').metadata.renamedTo).toBeUndefined();

    // Known to be that chat: its topic.
    const same = setup();
    linkChat(same.db, 'Иван Петров', { telegramThreadId: 77 });
    same.db.setSetting('max_chat:5005', 'Иван Петров');
    expect(await pick(same.bridge, 'Иван', '👤 Иван Петров')).toContain('тема уже есть: https://t.me/c/500/77');
    expect(same.maxClient.forgetActiveChat).not.toHaveBeenCalled();
  });

  it('leaves messages of a chat the bridge has to polling, and delivers them', async () => {
    const { bridge, db, telegramBot } = setup({
      opened: { title: 'Иван', maxId: '4004', listed: true },
      shown: [bubble('10:00', 'старое'), bubble('10:05', 'ещё не доставлено')]
    });
    linkChat(db, 'Иван', { telegramThreadId: 77 });
    db.insertMessage({ ...bubble('10:00', 'старое')('Иван'), telegramMessageId: 501 });
    db.upsertChat({ id: 'Иван', title: 'Иван', lastSeenAt: Date.now(), metadata: { unread: true, unreadText: '1' } });

    expect(await pick(bridge, 'Иван', '💬 Иван')).toContain('тема уже есть');
    expect(db.hasMessage(stableId('max', 'Иван', '10:05|ещё не доставлено'))).toBe(false);

    await bridge.pollMax();
    expect(telegramBot.sendMessage.mock.calls.map(([sent]) => sent.text)).toEqual(['ещё не доставлено']);
  });

  it('records a new chat\'s history without delivering it, but for its unread messages', async () => {
    const { bridge, db } = setup({
      opened: { title: 'Иван', maxId: '4004', listed: true },
      shown: [bubble('10:00', 'давнее'), bubble('10:01', 'тоже давнее'), bubble('10:05', 'непрочитанное')]
    });
    db.upsertChat({ id: 'Иван', title: 'Иван', lastSeenAt: Date.now(), metadata: { unread: true, unreadText: '1' } });

    await pick(bridge, 'Иван', '💬 Иван');

    expect(db.getMessage(stableId('max', 'Иван', '10:01|тоже давнее')).metadata.primedAsBacklog).toBe(true);
    expect(db.hasMessage(stableId('max', 'Иван', '10:05|непрочитанное'))).toBe(false);
  });

  it('answers the first press of a button only, and a list of choices goes stale after ten minutes', async () => {
    const { bridge, maxClient } = setup();
    const offer = await bridge.startNewChat('Иван');
    const [, sessionId] = offer.choices[0].data.split(':');
    await bridge.chooseNewChat(sessionId, 'x');
    // A second press on its way: nothing more to say.
    expect(await bridge.chooseNewChat(sessionId, '1')).toBeNull();
    expect(maxClient.openSearchResult).not.toHaveBeenCalled();

    const later = await bridge.startNewChat('Иван');
    const [, laterId] = later.choices[0].data.split(':');
    bridge.newChatSessions.get(laterId).createdAt -= 11 * 60 * 1000;
    expect(await bridge.chooseNewChat(laterId, '1')).toContain('устарел');
    // A list from before a restart.
    expect(await bridge.chooseNewChat('gone', '0')).toContain('устарел');
  });

  it('never cuts an emoji in half on a button', async () => {
    const title = `Дача ${'а'.repeat(50)} 2026 гг 🏡🌲`;
    const { bridge } = setup({ found: [{ kind: 'chat', title, hint: '', ordinal: 0 }] });
    const [choice] = (await bridge.startNewChat('Дача')).choices;
    expect(choice.label).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    expect(choice.label.endsWith('…')).toBe(true);
    expect([...new Intl.Segmenter('ru', { granularity: 'grapheme' }).segment(choice.label)]).toHaveLength(60);
  });

  it('passes on why MAX could not open it', async () => {
    const { bridge, maxClient, telegramBot } = setup();
    maxClient.openSearchResult.mockRejectedValue(new Error('MAX не нашёл такой номер (Не нашли номер +79990000000).'));
    expect(await pick(bridge, '+79990000000', 'найти в MAX')).toBe('⚠️ MAX не нашёл такой номер (Не нашли номер +79990000000).');
    expect(telegramBot.createTopic).not.toHaveBeenCalled();
  });
});

describe('/new in Telegram', () => {
  const OWNER = 555;
  const RELAY = -100777;
  const makeAdapter = () => {
    const adapter = new TelegramBotAdapter({ token: 'test:token', ownerId: OWNER, relayChatId: RELAY, useTopics: true }, {});
    adapter.bot.botInfo = { id: 1, is_bot: true, username: 'testbot', first_name: 'test' };
    const api = {
      sendMessage: vi.fn(async () => ({ message_id: 900 })),
      sendChatAction: vi.fn(async () => true),
      answerCbQuery: vi.fn(async () => true),
      editMessageReplyMarkup: vi.fn(async () => true),
      editMessageText: vi.fn(async () => true)
    };
    adapter.bot.context.telegram = api;
    Object.assign(adapter.bot.telegram, api);
    return { adapter, api };
  };
  const chat = { id: RELAY, type: 'supergroup', is_forum: true };
  const from = { id: OWNER, is_bot: false, first_name: 'owner' };

  it('answers /new with a button per choice', async () => {
    const { adapter, api } = makeAdapter();
    const requested = vi.fn(async () => ({ text: 'Что нашлось', choices: [{ label: '👤 Иван', data: 'new:abc:0' }, { label: 'Отмена', data: 'new:abc:x' }] }));
    adapter.onNewChat(requested);

    await adapter.bot.handleUpdate({
      update_id: 1,
      message: { message_id: 5, message_thread_id: 3, date: 1, chat, from, text: '/new Иван Петров', entities: [{ type: 'bot_command', offset: 0, length: 4 }] }
    });

    expect(requested).toHaveBeenCalledWith('Иван Петров');
    const [chatId, text, extra] = api.sendMessage.mock.calls[0];
    expect([chatId, text, extra.message_thread_id]).toEqual([RELAY, 'Что нашлось', 3]);
    expect(extra.reply_markup.inline_keyboard).toEqual([[{ text: '👤 Иван', callback_data: 'new:abc:0' }], [{ text: 'Отмена', callback_data: 'new:abc:x' }]]);
  });

  it('never sends /new to MAX as text, however it is spelled', async () => {
    const { adapter } = makeAdapter();
    const outbound = vi.fn(async () => {});
    adapter.onMessage(outbound);
    adapter.onNewChat(vi.fn(async () => ({ text: 'ok' })));

    let updateId = 10;
    for (const text of ['/New +7 999 123-45-67', '/NEW Иван', '/new@otherbot Иван']) {
      const length = text.split(' ')[0].length;
      await adapter.bot.handleUpdate({
        update_id: updateId++,
        message: { message_id: updateId, message_thread_id: 3, date: 1, chat, from, text, entities: [{ type: 'bot_command', offset: 0, length }] }
      });
    }

    expect(outbound).not.toHaveBeenCalled();
  });

  it('leaves the answer to the first press of a button alone', async () => {
    const { adapter, api } = makeAdapter();
    adapter.onNewChatChoice(vi.fn(async () => null));

    await adapter.bot.handleUpdate({
      update_id: 3,
      callback_query: {
        id: 'cb2', from, chat_instance: 'x', data: 'new:abc:0',
        message: { message_id: 901, message_thread_id: 3, date: 2, chat, from: { id: 1, is_bot: true, first_name: 'test' }, text: '✅ Чат с «Иван» готов' }
      }
    });

    expect(api.answerCbQuery).toHaveBeenCalled();
    expect(api.editMessageText).not.toHaveBeenCalled();
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it('takes the buttons away at once and shows what came of the choice', async () => {
    const { adapter, api } = makeAdapter();
    const chosen = vi.fn(async () => '✅ Чат с «Иван» готов');
    adapter.onNewChatChoice(chosen);

    await adapter.bot.handleUpdate({
      update_id: 2,
      callback_query: {
        id: 'cb', from, chat_instance: 'x', data: 'new:abc:0',
        message: { message_id: 901, message_thread_id: 3, date: 2, chat, from: { id: 1, is_bot: true, first_name: 'test' }, text: 'Что нашлось' }
      }
    });

    expect(chosen).toHaveBeenCalledWith('abc', '0');
    expect(api.editMessageReplyMarkup).toHaveBeenCalled();
    expect(api.editMessageText.mock.calls[0]).toEqual(expect.arrayContaining(['✅ Чат с «Иван» готов']));
  });
});
