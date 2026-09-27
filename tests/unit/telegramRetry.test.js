import { describe, it, expect, vi } from 'vitest';
import { TelegramBotAdapter } from '../../src/adapters/telegramBot.js';
import { makeBridge, makeFakeTelegramBot, linkChat, telegramMessage } from '../helpers/bridgeHarness.js';

// A message that did not reach MAX gets a notice with a "Повторить" button.
// The notice is a reply to the message, so pressing the button hands that
// message back to the bot, which sends it again — nothing has to be resent.

const OWNER = 555;
const RELAY = -100777;

const makeAdapter = () => {
  const adapter = new TelegramBotAdapter({ token: 'test:token', ownerId: OWNER, relayChatId: RELAY, useTopics: true }, {});
  adapter.bot.botInfo = { id: 1, is_bot: true, username: 'testbot', first_name: 'test' };
  const api = {
    sendMessage: vi.fn(async () => ({ message_id: 900 })),
    answerCbQuery: vi.fn(async () => true),
    deleteMessage: vi.fn(async () => true)
  };
  adapter.bot.context.telegram = api;
  Object.assign(adapter.bot.telegram, api);
  const outbound = vi.fn(async () => {});
  adapter.onMessage(outbound);
  return { adapter, api, outbound };
};

const original = {
  message_id: 42,
  message_thread_id: 7,
  date: 1700000000,
  chat: { id: RELAY, type: 'supergroup', is_forum: true },
  from: { id: OWNER, is_bot: false, first_name: 'owner' },
  text: 'привет'
};

const retryPress = ({ fromId = OWNER, replyTo = original } = {}) => ({
  update_id: 1,
  callback_query: {
    id: 'cb1',
    from: { id: fromId, is_bot: false, first_name: 'user' },
    chat_instance: 'x',
    data: 'retry',
    message: {
      message_id: 900,
      message_thread_id: 7,
      date: 1700000100,
      chat: { id: RELAY, type: 'supergroup', is_forum: true },
      from: { id: 1, is_bot: true, first_name: 'test' },
      text: '⚠️ Не ушло в MAX: boom',
      ...(replyTo ? { reply_to_message: replyTo } : {})
    }
  }
});

describe('retry button', () => {
  it('posts the notice as a reply to the message, with the button', async () => {
    const { adapter, api } = makeAdapter();
    await adapter.sendRetryNotice('⚠️ Не ушло в MAX: boom', { telegramChatId: RELAY, telegramThreadId: 7 }, 42);
    const [chatId, text, extra] = api.sendMessage.mock.calls[0];
    expect(chatId).toBe(RELAY);
    expect(text).toContain('Не ушло');
    expect(extra.message_thread_id).toBe(7);
    expect(extra.reply_parameters.message_id).toBe(42);
    expect(extra.reply_markup.inline_keyboard[0][0]).toEqual({ text: '🔁 Повторить', callback_data: 'retry' });
  });

  it('sends the original message again when pressed, and removes the notice', async () => {
    const { adapter, api, outbound } = makeAdapter();

    await adapter.bot.handleUpdate(retryPress());

    expect(api.answerCbQuery).toHaveBeenCalled();
    expect(api.deleteMessage).toHaveBeenCalledWith(RELAY, 900);
    expect(outbound).toHaveBeenCalledTimes(1);
    const message = outbound.mock.calls[0][0];
    expect(message).toMatchObject({ type: 'text', text: 'привет', sourceMessageId: '42' });
    expect(message.metadata).toMatchObject({ telegramChatId: RELAY, telegramThreadId: 7 });
  });

  it('keeps the same id as the first attempt, so a success is recorded against it', async () => {
    const { adapter, outbound } = makeAdapter();
    await adapter.bot.handleUpdate(retryPress());
    const direct = await adapter.telegramMessageToDomain({}, original);
    expect(outbound.mock.calls[0][0].id).toBe(direct.id);
  });

  it('says so when the original message is gone', async () => {
    const { adapter, api, outbound } = makeAdapter();
    await adapter.bot.handleUpdate(retryPress({ replyTo: null }));
    expect(outbound).not.toHaveBeenCalled();
    expect(api.answerCbQuery.mock.calls[0].join(' ')).toContain('не найдено');
  });

  it('ignores anyone but the owner', async () => {
    const { adapter, outbound } = makeAdapter();
    await adapter.bot.handleUpdate(retryPress({ fromId: 999 }));
    expect(outbound).not.toHaveBeenCalled();
  });
});

describe('bridge: notices that a message did not reach MAX', () => {
  it('come with the retry button, as a reply to the message', async () => {
    const telegramBot = makeFakeTelegramBot({ sendRetryNotice: vi.fn(async () => ({ message_id: 1 })) });
    const { bridge, db, maxClient } = makeBridge({ telegramBot });
    linkChat(db, 'chat-a', { telegramThreadId: 77 });
    maxClient.sendText.mockRejectedValue(new Error('MAX exploded'));

    await bridge.handleTelegramMessage(telegramMessage('tg-321', { telegramThreadId: 77 }));

    expect(telegramBot.sendRetryNotice).toHaveBeenCalledTimes(1);
    const [text, route, replyTo] = telegramBot.sendRetryNotice.mock.calls[0];
    expect(text).toContain('MAX exploded');
    expect(route).toEqual({ telegramChatId: -100500, telegramThreadId: 77 });
    expect(replyTo).toBe(321);
  });
});
