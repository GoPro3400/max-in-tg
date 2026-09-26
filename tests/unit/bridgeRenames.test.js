import { describe, it, expect, vi } from 'vitest';
import { stableId } from '../../src/domain/messages.js';
import { makeBridge, linkChat, maxMessage } from '../helpers/bridgeHarness.js';

// Chats are known by their titles, so a contact or group renamed in MAX used
// to look like a new chat: a new topic, and the old one left behind. MAX's
// own chat id (the page's address, /<id>) tells a renamed chat apart.

const OLD = 'Иван';
const NEW = 'Иван Петров';

const bubble = (chatId, time, text) => maxMessage(stableId('max', chatId, `${time}|${text}`), chatId, {
  text,
  sourceMessageId: `${time}|${text}`,
  metadata: { time }
});

// A MAX client whose chats have the given ids in MAX (known once a chat is
// opened) and show these bubbles.
const setup = ({ maxIds, screens }) => {
  const made = makeBridge();
  const { maxClient } = made;
  maxClient.selectChat.mockImplementation(async (chatId) => {
    maxClient.activeChatId = chatId;
    maxClient.activeMaxChatId = maxIds[chatId] ?? null;
  });
  maxClient.readMessages.mockImplementation(async (chatId) => (screens[chatId] || []).map((make) => make(chatId)));
  return made;
};

// As MAX's chat list shows it: with how many unread messages.
const listChat = (db, id, unread = 1) => db.upsertChat({
  id, title: id, lastSeenAt: Date.now(), metadata: { unread: unread > 0, unreadText: unread ? String(unread) : '' }
});

describe('a chat renamed in MAX', () => {
  it('carries on in its old topic, renamed, with its messages\' Telegram links', async () => {
    const { bridge, db, telegramBot } = setup({
      maxIds: { [NEW]: '123' },
      screens: { [NEW]: [(chat) => bubble(chat, '10:00', 'Привет'), (chat) => bubble(chat, '10:05', 'Новое')] }
    });
    linkChat(db, OLD, { telegramThreadId: 77 });
    db.insertMessage({ ...bubble(OLD, '10:00', 'Привет'), telegramMessageId: 501 });
    db.setSetting('max_chat:123', OLD);
    listChat(db, OLD, 0);
    listChat(db, NEW, 1);

    await bridge.pollMax();

    expect(telegramBot.createTopic).not.toHaveBeenCalled();
    expect(telegramBot.renameTopic).toHaveBeenCalledWith(77, NEW);
    expect(telegramBot.sendText.mock.calls[0][0]).toContain(`теперь называется «${NEW}»`);
    const [sent, route] = telegramBot.sendMessage.mock.calls[0];
    expect(telegramBot.sendMessage).toHaveBeenCalledTimes(1);
    expect(sent.text).toBe('Новое');
    expect(route.telegramThreadId).toBe(77);
    // Replies and reactions to the old message keep working.
    expect(db.getMessage(stableId('max', NEW, '10:00|Привет')).telegramMessageId).toBe(501);
    // Telegram -> MAX from that topic goes to the chat under its new name.
    expect(db.getChatMappingByTelegramThread(-100500, 77).maxChatId).toBe(NEW);
    expect(db.getChatMapping(OLD)).toBeNull();
    expect(db.getSetting('max_chat:123')).toBe(NEW);
  });

  it('leaves a note in a topic already made for the new name', async () => {
    const { bridge, db, telegramBot } = setup({
      maxIds: { [NEW]: '123' },
      screens: { [NEW]: [(chat) => bubble(chat, '10:00', 'Привет')] }
    });
    linkChat(db, OLD, { telegramThreadId: 77 });
    linkChat(db, NEW, { telegramThreadId: 88 });
    db.insertMessage({ ...bubble(OLD, '10:00', 'Привет'), telegramMessageId: 501 });
    db.setSetting('max_chat:123', OLD);

    await bridge.pollMax();

    expect(db.getChatMapping(NEW).telegramThreadId).toBe(77);
    const notes = telegramBot.sendText.mock.calls.map(([text, where]) => [where.telegramThreadId, text]);
    expect(notes).toEqual([
      [77, expect.stringContaining('переписка продолжается здесь')],
      [88, expect.stringContaining('эта больше не нужна')]
    ]);
    expect(telegramBot.sendMessage).not.toHaveBeenCalled();
  });

  it('keeps a muted chat muted', async () => {
    const { bridge, db, telegramBot } = setup({
      maxIds: { [NEW]: '123' },
      screens: { [NEW]: [(chat) => bubble(chat, '10:00', 'реклама')] }
    });
    linkChat(db, OLD, { telegramThreadId: 77 });
    db.setChatMuted(OLD, true);
    bridge.mutedChatIds.add(OLD);
    db.setSetting('max_chat:123', OLD);
    listChat(db, NEW);

    await bridge.pollMax();

    expect(bridge.mutedChatIds.has(NEW)).toBe(true);
    expect(telegramBot.renameTopic).toHaveBeenCalledWith(77, `🔇 ${NEW}`);
  });

  it('delivers new messages that repeat old ones, and never guesses by an old id there', async () => {
    // Renamed, then "Отлично!" and "ок" — and an "ок" from long ago on record
    // under the old name, by its old id (without the time).
    const { bridge, db, telegramBot } = setup({
      maxIds: { [NEW]: '123' },
      screens: {
        [NEW]: [
          (chat) => bubble(chat, '10:00', 'Привет'),
          (chat) => bubble(chat, '15:00', 'Отлично!'),
          (chat) => ({ ...bubble(chat, '15:01', 'ок'), metadata: { time: '15:01', legacyId: 'ок' } })
        ]
      }
    });
    linkChat(db, OLD, { telegramThreadId: 77 });
    db.insertMessage({ ...bubble(OLD, '10:00', 'Привет'), telegramMessageId: 501 });
    db.insertMessage({ ...maxMessage(stableId('max', OLD, 'ок'), OLD, { text: 'ок', sourceMessageId: 'ок' }), telegramMessageId: 400 });
    db.setSetting('max_chat:123', OLD);
    listChat(db, OLD, 0);
    listChat(db, NEW, 2);

    await bridge.pollMax();

    expect(telegramBot.sendMessage.mock.calls.map(([sent]) => sent.text)).toEqual(['Отлично!', 'ок']);
  });

  it('keeps a chat merged into another topic merged there', async () => {
    const { bridge, db, telegramBot } = setup({
      maxIds: { [NEW]: '123' },
      screens: { [NEW]: [(chat) => bubble(chat, '10:00', 'Привет')] }
    });
    linkChat(db, 'Семья', { telegramThreadId: 55 });
    linkChat(db, OLD, { telegramThreadId: 77 });
    bridge.mergeChat(OLD, -100500, 55);
    db.setSetting('max_chat:123', OLD);
    listChat(db, NEW, 0);

    await bridge.pollMax();

    const moved = db.getChatMapping(NEW);
    expect(moved).toMatchObject({ telegramThreadId: 55, metadata: expect.objectContaining({ mergedInto: 'Семья' }) });
    expect(db.getChatMappingByTelegramThread(-100500, 55).maxChatId).toBe('Семья');
    // That topic is the other chat's, and keeps its name.
    expect(telegramBot.renameTopic).not.toHaveBeenCalled();
    expect(db.getSetting('max_chat:123')).toBe(NEW);
  });

  it('stops polling the old name', async () => {
    const { bridge, db } = setup({
      maxIds: { [NEW]: '123' },
      screens: { [NEW]: [(chat) => bubble(chat, '10:00', 'Привет')] }
    });
    linkChat(db, OLD, { telegramThreadId: 77 });
    db.setSetting('max_chat:123', OLD);
    listChat(db, OLD, 0);
    listChat(db, NEW, 0);

    await bridge.pollMax();

    expect(bridge.pickChatsForPoll().map((chat) => chat.id)).not.toContain(OLD);
  });

  it('only remembers a chat\'s id when it is new, or the same chat\'s', async () => {
    const { bridge, db, telegramBot } = setup({
      maxIds: { [OLD]: '123' },
      screens: { [OLD]: [(chat) => bubble(chat, '10:00', 'Привет')] }
    });
    linkChat(db, OLD, { telegramThreadId: 77 });

    await bridge.pollMax();
    await bridge.pollMax();

    expect(db.getSetting('max_chat:123')).toBe(OLD);
    expect(telegramBot.renameTopic).not.toHaveBeenCalled();
    expect(telegramBot.sendText).not.toHaveBeenCalled();
  });

  it('does nothing without an id from MAX', async () => {
    const { bridge, db, telegramBot } = setup({
      maxIds: {},
      screens: { [NEW]: [(chat) => bubble(chat, '10:00', 'Привет')] }
    });
    linkChat(db, OLD, { telegramThreadId: 77 });
    db.setSetting('max_chat:123', OLD);
    listChat(db, NEW);
    const renameSpy = vi.spyOn(bridge, 'carryOnRenamedChat');

    await bridge.pollMax();

    expect(renameSpy).not.toHaveBeenCalled();
    expect(telegramBot.renameTopic).not.toHaveBeenCalled();
  });
});
