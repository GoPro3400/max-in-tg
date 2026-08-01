import { describe, it, expect } from 'vitest';
import { findNewestCapture, consumeNewestCapture } from '../../src/utils/networkCapture.js';

describe('findNewestCapture', () => {
  it('returns null for empty map', () => {
    expect(findNewestCapture(new Map())).toBeNull();
    expect(findNewestCapture(null)).toBeNull();
  });

  it('returns the newest entry within maxAge', () => {
    const map = new Map();
    const now = Date.now();
    map.set('old', { url: 'a', timestamp: now - 20000 });
    map.set('new', { url: 'b', timestamp: now - 1000 });

    const result = findNewestCapture(map);
    expect(result.url).toBe('b');
  });

  it('returns null when all entries are expired', () => {
    const map = new Map();
    map.set('expired', { url: 'a', timestamp: Date.now() - 60000 });

    expect(findNewestCapture(map, 30000)).toBeNull();
  });

  it('respects custom maxAgeMs', () => {
    const map = new Map();
    map.set('entry', { url: 'a', timestamp: Date.now() - 5000 });

    expect(findNewestCapture(map, 3000)).toBeNull();
    expect(findNewestCapture(map, 10000)).not.toBeNull();
  });
});

describe('consumeNewestCapture', () => {
  it('returns null for empty map', () => {
    expect(consumeNewestCapture(new Map())).toBeNull();
    expect(consumeNewestCapture(null)).toBeNull();
  });

  it('returns newest and removes it from map', () => {
    const map = new Map();
    const now = Date.now();
    map.set('first', { url: 'a', buffer: Buffer.from('aaa'), timestamp: now - 3000 });
    map.set('second', { url: 'b', buffer: Buffer.from('bbb'), timestamp: now - 1000 });

    const result = consumeNewestCapture(map);
    expect(result.url).toBe('b');
    expect(map.has('second')).toBe(false);
    expect(map.has('first')).toBe(true);
  });

  it('returns entries one by one when called multiple times', () => {
    const map = new Map();
    const now = Date.now();
    map.set('v1', { url: 'voice1', timestamp: now - 4000 });
    map.set('v2', { url: 'voice2', timestamp: now - 2000 });
    map.set('v3', { url: 'voice3', timestamp: now - 1000 });

    const first = consumeNewestCapture(map);
    expect(first.url).toBe('voice3');
    expect(map.size).toBe(2);

    const second = consumeNewestCapture(map);
    expect(second.url).toBe('voice2');
    expect(map.size).toBe(1);

    const third = consumeNewestCapture(map);
    expect(third.url).toBe('voice1');
    expect(map.size).toBe(0);

    const fourth = consumeNewestCapture(map);
    expect(fourth).toBeNull();
  });
});
