import { describe, it, expect, vi } from 'vitest';
import { makeBridge, makeTestConfig, linkChat } from '../helpers/bridgeHarness.js';
import { typingAction } from '../../src/adapters/maxWebClient.js';

// Someone typing in MAX shows as "typing…" in that chat's topic in Telegram.

const setup = ({ typing = [], config = {} } = {}) => {
  const made = makeBridge({ config: makeTestConfig({ typingEnabled: true, ...config }) });
  made.maxClient.typingChats = vi.fn(async () => typing);
  made.telegramBot.sendChatAction = vi.fn(async () => true);
  return made;
};

describe('typing in MAX', () => {
  it('shows in the chat\'s topic, as what they are doing', async () => {
    const { bridge, db, telegramBot } = setup({ typing: [{ chatId: 'Анна', action: 'record_voice' }] });
    linkChat(db, 'Анна', { telegramThreadId: 42 });

    await bridge.relayTyping(10_000);

    expect(telegramBot.sendChatAction).toHaveBeenCalledWith(expect.objectContaining({ telegramThreadId: 42 }), 'record_voice');
  });

  it('is repeated while it lasts, not on every look', async () => {
    const { bridge, db, telegramBot } = setup({ typing: [{ chatId: 'Анна', action: 'typing' }] });
    linkChat(db, 'Анна');

    await bridge.relayTyping(10_000);
    await bridge.relayTyping(12_000);
    expect(telegramBot.sendChatAction).toHaveBeenCalledTimes(1);
    await bridge.relayTyping(14_500);
    expect(telegramBot.sendChatAction).toHaveBeenCalledTimes(2);
  });

  it('skips chats without a topic yet, muted chats, and SYNC_TYPING=false', async () => {
    const typing = [{ chatId: 'Новый', action: 'typing' }, { chatId: 'Реклама', action: 'typing' }];
    const { bridge, db, telegramBot } = setup({ typing });
    linkChat(db, 'Реклама');
    bridge.mutedChatIds.add('Реклама');
    await bridge.relayTyping(10_000);
    expect(telegramBot.sendChatAction).not.toHaveBeenCalled();

    const off = setup({ typing: [{ chatId: 'Анна', action: 'typing' }], config: { typingEnabled: false } });
    linkChat(off.db, 'Анна');
    await off.bridge.relayTyping(10_000);
    expect(off.maxClient.typingChats).not.toHaveBeenCalled();
  });

  it('never holds up polling when Telegram fails', async () => {
    const { bridge, db, telegramBot } = setup({ typing: [{ chatId: 'Анна', action: 'typing' }] });
    linkChat(db, 'Анна');
    telegramBot.sendChatAction.mockRejectedValue(new Error('Bad Request: not enough rights'));

    await expect(bridge.relayTyping(10_000)).resolves.toBeUndefined();
  });
});

describe('typingAction', () => {
  it('reads what MAX says someone is doing', () => {
    expect(typingAction('печатает')).toBe('typing');
    expect(typingAction('Иван и Пётр печатают')).toBe('typing');
    expect(typingAction('записывает аудио')).toBe('record_voice');
    expect(typingAction('recording a voice message')).toBe('record_voice');
    expect(typingAction('записывает видеосообщение')).toBe('record_video_note');
    expect(typingAction('отправляет видео')).toBe('upload_video');
    expect(typingAction('отправляет фото')).toBe('upload_photo');
    expect(typingAction('отправляет файл')).toBe('upload_document');
    expect(typingAction('выбирает стикер')).toBe('choose_sticker');
    expect(typingAction('')).toBe('typing');
  });
});
