import { describe, it, expect, vi } from 'vitest';
import { BridgeService } from '../../src/services/bridge.js';
import { MessageType } from '../../src/domain/messages.js';

function makeBridge(getMessageByTelegramMessageId, getTgToMaxMessageBySourceId = () => null) {
  const db = {
    getMessageByTelegramMessageId: vi.fn(getMessageByTelegramMessageId),
    getTgToMaxMessageBySourceId: vi.fn(getTgToMaxMessageBySourceId)
  };
  return new BridgeService({ db, maxClient: {}, telegramBot: {}, mediaService: {}, config: {} });
}

describe('resolveMaxReplyTarget', () => {
  it('returns null when the message is not a reply', () => {
    const bridge = makeBridge(() => null);
    expect(bridge.resolveMaxReplyTarget({ metadata: {} })).toBeNull();
    expect(bridge.db.getMessageByTelegramMessageId).not.toHaveBeenCalled();
  });

  it('returns the MAX-side fingerprint for a text reply originally from MAX', () => {
    const bridge = makeBridge(() => ({
      direction: 'max_to_tg',
      type: MessageType.TEXT,
      sourceMessageId: 'Alice|02:38 PM|Привет|'
    }));
    const result = bridge.resolveMaxReplyTarget({ metadata: { replyToTelegramMessageId: 42 } });
    expect(result).toBe('Alice|02:38 PM|Привет|');
    expect(bridge.db.getMessageByTelegramMessageId).toHaveBeenCalledWith(42);
  });

  it('returns null when no original message is found', () => {
    const bridge = makeBridge(() => null);
    expect(bridge.resolveMaxReplyTarget({ metadata: { replyToTelegramMessageId: 42 } })).toBeNull();
  });

  it('returns null when the original was sent from Telegram (tg_to_max)', () => {
    const bridge = makeBridge(() => ({
      direction: 'tg_to_max',
      type: MessageType.TEXT,
      sourceMessageId: '999'
    }));
    expect(bridge.resolveMaxReplyTarget({ metadata: { replyToTelegramMessageId: 42 } })).toBeNull();
  });

  it('returns a media-token fingerprint for a media original with a CDN token', () => {
    const bridge = makeBridge(() => ({
      direction: 'max_to_tg',
      type: MessageType.PHOTO,
      mediaUrl: 'https://i.oneme.ru/i?r=TOKEN123&fn=w_1280'
    }));
    const result = bridge.resolveMaxReplyTarget({ metadata: { replyToTelegramMessageId: 42 } });
    expect(result).toBe('media-token:TOKEN123');
  });

  it('returns null for a media original with no extractable CDN token', () => {
    const bridge = makeBridge(() => ({
      direction: 'max_to_tg',
      type: MessageType.VOICE,
      mediaUrl: 'https://cdn.example.com/voice.ogg'
    }));
    expect(bridge.resolveMaxReplyTarget({ metadata: { replyToTelegramMessageId: 42 } })).toBeNull();
  });

  it('returns null for a media original with no stored mediaUrl', () => {
    const bridge = makeBridge(() => ({
      direction: 'max_to_tg',
      type: MessageType.PHOTO,
      mediaUrl: null
    }));
    expect(bridge.resolveMaxReplyTarget({ metadata: { replyToTelegramMessageId: 42 } })).toBeNull();
  });

  it('returns null when the fingerprint is an unstable "visible-N" fallback id', () => {
    const bridge = makeBridge(() => ({
      direction: 'max_to_tg',
      type: MessageType.TEXT,
      sourceMessageId: 'visible-3'
    }));
    expect(bridge.resolveMaxReplyTarget({ metadata: { replyToTelegramMessageId: 42 } })).toBeNull();
  });

  it('returns null when the original has no sourceMessageId', () => {
    const bridge = makeBridge(() => ({
      direction: 'max_to_tg',
      type: MessageType.TEXT,
      sourceMessageId: null
    }));
    expect(bridge.resolveMaxReplyTarget({ metadata: { replyToTelegramMessageId: 42 } })).toBeNull();
  });

  describe('replying to your own previously Telegram-sent message (v2)', () => {
    it('returns the stored MAX-side fingerprint for a text message the user sent earlier', () => {
      const bridge = makeBridge(
        () => null,
        (id) => (id === 42 ? { type: MessageType.TEXT, maxFingerprint: 'Me|02:40 PM|привет|' } : null)
      );
      const result = bridge.resolveMaxReplyTarget({ metadata: { replyToTelegramMessageId: 42 } });
      expect(result).toBe('Me|02:40 PM|привет|');
      expect(bridge.db.getTgToMaxMessageBySourceId).toHaveBeenCalledWith(42);
    });

    it('returns null when the own-sent maxFingerprint is an unstable "visible-N" fallback id', () => {
      const bridge = makeBridge(
        () => null,
        (id) => (id === 42 ? { type: MessageType.TEXT, maxFingerprint: 'visible-3' } : null)
      );
      expect(bridge.resolveMaxReplyTarget({ metadata: { replyToTelegramMessageId: 42 } })).toBeNull();
    });

    it('returns null when the own message has no captured fingerprint yet', () => {
      const bridge = makeBridge(
        () => null,
        () => ({ type: MessageType.TEXT, maxFingerprint: null })
      );
      expect(bridge.resolveMaxReplyTarget({ metadata: { replyToTelegramMessageId: 42 } })).toBeNull();
    });

    it('quotes an own file by the media token captured after sending it', () => {
      const bridge = makeBridge(
        () => null,
        () => ({ type: MessageType.PHOTO, maxFingerprint: 'media-token:TOKEN9' })
      );
      expect(bridge.resolveMaxReplyTarget({ metadata: { replyToTelegramMessageId: 42 } })).toBe('media-token:TOKEN9');
    });

    it('does not quote an own message from another MAX chat', () => {
      const bridge = makeBridge(
        () => null,
        () => ({ chatId: 'other-chat', type: MessageType.TEXT, maxFingerprint: 'Me|02:40 PM|hi' })
      );
      expect(bridge.resolveMaxReplyTarget({ chatId: 'this-chat', metadata: { replyToTelegramMessageId: 42 } })).toBeNull();
    });

    it('returns null when neither lookup finds anything', () => {
      const bridge = makeBridge(() => null, () => null);
      expect(bridge.resolveMaxReplyTarget({ metadata: { replyToTelegramMessageId: 42 } })).toBeNull();
    });

    it('prefers the max_to_tg match and does not check own-sent messages when found', () => {
      const bridge = makeBridge(
        () => ({ direction: 'max_to_tg', type: MessageType.TEXT, sourceMessageId: 'Alice|1PM|hi|' }),
        () => ({ type: MessageType.TEXT, maxFingerprint: 'should-not-be-used' })
      );
      const result = bridge.resolveMaxReplyTarget({ metadata: { replyToTelegramMessageId: 42 } });
      expect(result).toBe('Alice|1PM|hi|');
      expect(bridge.db.getTgToMaxMessageBySourceId).not.toHaveBeenCalled();
    });
  });
});
