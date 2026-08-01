import { describe, it, expect } from 'vitest';
import { extractMediaToken, hammingHex } from '../../src/services/bridge.js';

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
