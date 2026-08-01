import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { MessageType, Direction, stableId, normalizeText, humanMessage } from '../../src/domain/messages.js';

describe('MessageType', () => {
  it('has all expected types', () => {
    expect(MessageType.TEXT).toBe('text');
    expect(MessageType.PHOTO).toBe('photo');
    expect(MessageType.VOICE).toBe('voice');
    expect(MessageType.VIDEO).toBe('video');
    expect(MessageType.DOCUMENT).toBe('document');
    expect(MessageType.STICKER).toBe('sticker');
  });

  it('is frozen', () => {
    expect(Object.isFrozen(MessageType)).toBe(true);
  });
});

describe('Direction', () => {
  it('has both directions', () => {
    expect(Direction.MAX_TO_TG).toBe('max_to_tg');
    expect(Direction.TG_TO_MAX).toBe('tg_to_max');
  });

  it('is frozen', () => {
    expect(Object.isFrozen(Direction)).toBe(true);
  });
});

describe('stableId', () => {
  it('returns 32-char hex string', () => {
    const id = stableId('test', 'value');
    expect(id).toMatch(/^[a-f0-9]{32}$/);
  });

  it('is deterministic', () => {
    const a = stableId('hello', 'world');
    const b = stableId('hello', 'world');
    expect(a).toBe(b);
  });

  it('produces different ids for different inputs', () => {
    const a = stableId('hello', 'world');
    const b = stableId('hello', 'there');
    expect(a).not.toBe(b);
  });

  it('filters falsy values', () => {
    const a = stableId('hello', '', null, undefined, 'world');
    const b = stableId('hello', 'world');
    expect(a).toBe(b);
  });

  it('matches manual SHA-256 computation', () => {
    const expected = crypto.createHash('sha256').update('a|b').digest('hex').slice(0, 32);
    expect(stableId('a', 'b')).toBe(expected);
  });
});

describe('normalizeText', () => {
  it('trims whitespace', () => {
    expect(normalizeText('  hello  ')).toBe('hello');
  });

  it('replaces CRLF with LF', () => {
    expect(normalizeText('hello\r\nworld')).toBe('hello\nworld');
  });

  it('handles null/undefined', () => {
    expect(normalizeText(null)).toBe('');
    expect(normalizeText(undefined)).toBe('');
  });

  it('handles empty string', () => {
    expect(normalizeText('')).toBe('');
  });
});

describe('humanMessage', () => {
  it('formats text message from Max', () => {
    const msg = {
      direction: Direction.MAX_TO_TG,
      type: MessageType.TEXT,
      text: 'Hello world',
      createdAt: new Date('2026-06-12T12:00:00Z').getTime()
    };
    const result = humanMessage(msg);
    expect(result).toContain('Max');
    expect(result).toContain('Hello world');
  });

  it('formats text message from Telegram', () => {
    const msg = {
      direction: Direction.TG_TO_MAX,
      type: MessageType.TEXT,
      text: 'Hi there',
      createdAt: new Date('2026-06-12T12:00:00Z').getTime()
    };
    const result = humanMessage(msg);
    expect(result).toContain('Telegram');
    expect(result).toContain('Hi there');
  });

  it('falls back to mediaUrl', () => {
    const msg = {
      direction: Direction.MAX_TO_TG,
      type: MessageType.PHOTO,
      text: '',
      mediaUrl: 'https://example.com/photo.jpg',
      createdAt: Date.now()
    };
    const result = humanMessage(msg);
    expect(result).toContain('https://example.com/photo.jpg');
  });

  it('falls back to type placeholder', () => {
    const msg = {
      direction: Direction.MAX_TO_TG,
      type: MessageType.VOICE,
      createdAt: Date.now()
    };
    const result = humanMessage(msg);
    expect(result).toContain('[voice]');
  });
});
