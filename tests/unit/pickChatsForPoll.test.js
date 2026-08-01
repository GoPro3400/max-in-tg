import { describe, it, expect, vi } from 'vitest';
import { BridgeService } from '../../src/services/bridge.js';

function makeBridge(chats, { maxChatsPerPoll = 4 } = {}) {
  const db = { listChats: vi.fn(() => chats) };
  return new BridgeService({ db, maxClient: {}, telegramBot: {}, mediaService: {}, config: { maxChatsPerPoll } });
}

function chat(id, unread = false) {
  return { id, title: id, metadata: { unread } };
}

describe('pickChatsForPoll', () => {
  it('returns nothing when there are no chats', () => {
    const bridge = makeBridge([]);
    expect(bridge.pickChatsForPoll()).toEqual([]);
  });

  it('prioritizes unread chats up to the limit', () => {
    const chats = [chat('a', true), chat('b', true), chat('c'), chat('d')];
    const bridge = makeBridge(chats, { maxChatsPerPoll: 2 });
    const picked = bridge.pickChatsForPoll();
    expect(picked.map((c) => c.id).sort()).toEqual(['a', 'b']);
  });

  it('fills remaining slots via round-robin over all chats', () => {
    const chats = [chat('a'), chat('b'), chat('c'), chat('d')];
    const bridge = makeBridge(chats, { maxChatsPerPoll: 2 });
    const picked = bridge.pickChatsForPoll();
    expect(picked).toHaveLength(2);
  });

  it('skips chronically-unreachable chats in the round-robin fallback', () => {
    const chats = [chat('a'), chat('b'), chat('c'), chat('d')];
    const bridge = makeBridge(chats, { maxChatsPerPoll: 2 });
    bridge.chronicallyUnreachableChatIds.add('a');
    bridge.chronicallyUnreachableChatIds.add('b');
    const picked = bridge.pickChatsForPoll();
    expect(picked.map((c) => c.id).sort()).toEqual(['c', 'd']);
  });

  it('still includes an unreachable chat if it is unread (priority bucket bypasses exclusion)', () => {
    const chats = [chat('a', true), chat('b'), chat('c'), chat('d')];
    const bridge = makeBridge(chats, { maxChatsPerPoll: 1 });
    bridge.chronicallyUnreachableChatIds.add('a');
    const picked = bridge.pickChatsForPoll();
    expect(picked.map((c) => c.id)).toEqual(['a']);
  });

  it('terminates and returns fewer than the limit when every remaining chat is unreachable', () => {
    const chats = [chat('a'), chat('b'), chat('c')];
    const bridge = makeBridge(chats, { maxChatsPerPoll: 3 });
    bridge.chronicallyUnreachableChatIds.add('a');
    bridge.chronicallyUnreachableChatIds.add('b');
    bridge.chronicallyUnreachableChatIds.add('c');
    const picked = bridge.pickChatsForPoll();
    expect(picked).toEqual([]);
  });

  // Regression: with MAX_CHATS_PER_POLL=1 (production) the unread bucket used
  // to take the first `limit` entries every time, so one continuously active
  // chat held the only slot forever and other unread chats were never polled —
  // their messages simply never reached Telegram.
  it('rotates the single poll slot across all unread chats', () => {
    const chats = [chat('a', true), chat('b', true), chat('c', true)];
    const bridge = makeBridge(chats, { maxChatsPerPoll: 1 });
    const seen = [
      bridge.pickChatsForPoll()[0].id,
      bridge.pickChatsForPoll()[0].id,
      bridge.pickChatsForPoll()[0].id
    ];
    expect([...new Set(seen)].sort()).toEqual(['a', 'b', 'c']);
  });

  it('puts unreachable unread chats behind reachable ones', () => {
    const chats = [chat('stuck', true), chat('live', true)];
    const bridge = makeBridge(chats, { maxChatsPerPoll: 1 });
    bridge.chronicallyUnreachableChatIds.add('stuck');
    // 'stuck' is first in listChats order but must not pre-empt 'live'.
    expect(bridge.pickChatsForPoll().map((c) => c.id)).toEqual(['live']);
  });

  it('advances the cursor across calls instead of always starting from 0', () => {
    const chats = [chat('a'), chat('b'), chat('c'), chat('d')];
    const bridge = makeBridge(chats, { maxChatsPerPoll: 1 });
    const first = bridge.pickChatsForPoll().map((c) => c.id);
    const second = bridge.pickChatsForPoll().map((c) => c.id);
    expect(first).not.toEqual(second);
  });
});
