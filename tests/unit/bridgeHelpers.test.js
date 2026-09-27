import { describe, it, expect } from 'vitest';
import { extractMediaToken, hammingHex, fingerprintWithoutMediaUrl, telegramRetryAfter } from '../../src/services/bridge.js';

describe('extractMediaToken', () => {
  it('extracts the r= token from a MAX CDN url', () => {
    expect(extractMediaToken('https://i.oneme.ru/i?r=ABC123&fn=w_1280')).toBe('ABC123');
  });

  it('works regardless of the size (fn) parameter', () => {
    const full = extractMediaToken('https://i.oneme.ru/i?r=SAME&fn=w_1280');
    const thumb = extractMediaToken('https://i.oneme.ru/i?r=SAME&fn=w_180');
    expect(full).toBe('SAME');
    expect(thumb).toBe('SAME');
  });

  it('returns null when there is no token or no url', () => {
    expect(extractMediaToken('https://i.oneme.ru/i?fn=w')).toBeNull();
    expect(extractMediaToken('')).toBeNull();
    expect(extractMediaToken(null)).toBeNull();
    expect(extractMediaToken(undefined)).toBeNull();
  });
});

describe('hammingHex', () => {
  it('returns 0 for identical hashes', () => {
    expect(hammingHex('ffffffffffffffff', 'ffffffffffffffff')).toBe(0);
  });

  it('counts differing bits', () => {
    // 0x0 vs 0xf differ in 4 bits; one nibble difference => 4
    expect(hammingHex('0000000000000000', '000000000000000f')).toBe(4);
    expect(hammingHex('0000000000000000', 'ffffffffffffffff')).toBe(64);
  });

  it('returns Infinity for missing or mismatched-length inputs', () => {
    expect(hammingHex(null, 'ffff')).toBe(Infinity);
    expect(hammingHex('ffff', undefined)).toBe(Infinity);
    expect(hammingHex('ff', 'ffff')).toBe(Infinity);
  });
});

describe('fingerprintWithoutMediaUrl', () => {
  it('drops exactly the trailing signed media URL', () => {
    const url = 'https://i.oneme.ru/i?r=T&fn=w_1280';
    expect(fingerprintWithoutMediaUrl(`Мама|12:00|подпись|${url}`, url)).toBe('Мама|12:00|подпись');
    expect(fingerprintWithoutMediaUrl(url, url)).toBe('');
  });

  it('falls back to stripping a trailing URL-looking field, and leaves URL-less fingerprints whole', () => {
    expect(fingerprintWithoutMediaUrl('Мама|12:00|https://other/x?y=1', null)).toBe('Мама|12:00');
    expect(fingerprintWithoutMediaUrl('Мама|12:00', null)).toBe('Мама|12:00');
    expect(fingerprintWithoutMediaUrl(null, null)).toBe('');
  });
});

describe('telegramRetryAfter', () => {
  it('reads retry_after from a Telegraf 429 and ignores other errors', () => {
    expect(telegramRetryAfter({ code: 429, parameters: { retry_after: 31 } })).toBe(31);
    expect(telegramRetryAfter({ response: { error_code: 429, parameters: { retry_after: 7 } } })).toBe(7);
    expect(telegramRetryAfter({ code: 429 })).toBe(5);
    expect(telegramRetryAfter({ code: 400 })).toBe(0);
    expect(telegramRetryAfter(new Error('boom'))).toBe(0);
    expect(telegramRetryAfter(null)).toBe(0);
  });
});
