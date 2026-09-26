import { describe, it, expect, vi } from 'vitest';
import {
  makeBridge,
  makeTestConfig,
  linkChat,
  maxMessage
} from '../helpers/bridgeHarness.js';

// pollMax is the MAX→Telegram heartbeat: it picks chats, reads their new
// messages, forwards them, and only then records them as seen. These tests run
// the real method over the real in-memory database; only the browser client,
// the Telegram bot and the media service are fakes.
//
// Every test sets bridge.lastChatRefreshAt = Date.now() so pollMax skips the
// refreshChats() detour (listChats would otherwise rewrite the seeded chats).

function primedBridge(overrides = {}) {
  const parts = makeBridge(overrides);
  parts.bridge.lastChatRefreshAt = Date.now();
  return parts;
}

describe('pollMax', () => {
  it('forwards a new MAX message to Telegram and records it in the db', async () => {
    const { bridge, db, maxClient, telegramBot } = primedBridge();
    linkChat(db, 'chat-a', { unread: true });
    maxClient.readMessages.mockResolvedValue([maxMessage('m1', 'chat-a')]);

    await bridge.pollMax();

    expect(telegramBot.sendMessage).toHaveBeenCalledTimes(1);
    const [outgoing, mapping] = telegramBot.sendMessage.mock.calls[0];
    expect(outgoing.id).toBe('m1');
    expect(outgoing.text).toBe('text of m1');
    expect(mapping.maxChatId).toBe('chat-a');
    expect(mapping.telegramThreadId).toBe(77);
    // Delivered -> persisted, so the next poll's dedup will skip it.
    expect(db.hasMessage('m1')).toBe(true);
    expect(db.countFailedDeliveries('m1', 'max_to_tg')).toBe(0);
  });

  it('does not re-forward a message whose id is already stored', async () => {
    const { bridge, db, maxClient, telegramBot } = primedBridge();
    linkChat(db, 'chat-a', { unread: true });
    db.insertMessage(maxMessage('m1', 'chat-a'));
    maxClient.readMessages.mockResolvedValue([maxMessage('m1', 'chat-a')]);

    await bridge.pollMax();

    expect(telegramBot.sendMessage).not.toHaveBeenCalled();
    expect(db.hasMessage('m1')).toBe(true);

    // The isKnown callback handed to readMessages is the PRIMARY dedup (the
    // in-loop hasMessage check is a backstop). Its contract: exact-id lookup
    // only — a disambiguated '#vN' id must NOT collapse onto its base id,
    // or the second of two same-fingerprint media messages gets dropped.
    const options = maxClient.readMessages.mock.calls[0][1];
    expect(options.isKnown('m1')).toBe(true);
    expect(options.isKnown('m1#v2')).toBe(false);
    expect(options.isKnown('never-seen')).toBe(false);
  });

  it('holds an unresolved reply for four sightings and forwards it on the fifth', async () => {
    const { bridge, db, maxClient, telegramBot } = primedBridge();
    linkChat(db, 'chat-a', { unread: true });
    // Reply bubble whose quote never loads: the .link container is there but
    // neither the text snippet nor the media thumbnail URL ever populates.
    maxClient.readMessages.mockImplementation(async () => [
      maxMessage('r1', 'chat-a', { metadata: { replyLinkPresent: true } })
    ]);

    // Sightings 1-4: held back, nothing sent, nothing stored (so it is re-read).
    for (let sighting = 1; sighting <= 4; sighting++) {
      await bridge.pollMax();
      expect(telegramBot.sendMessage).not.toHaveBeenCalled();
      expect(db.hasMessage('r1')).toBe(false);
    }

    // Sighting 5 (REPLY_GRACE_SIGHTINGS): grace exhausted, forwarded anyway.
    await bridge.pollMax();
    expect(telegramBot.sendMessage).toHaveBeenCalledTimes(1);
    expect(telegramBot.sendMessage.mock.calls[0][0].id).toBe('r1');
    expect(db.hasMessage('r1')).toBe(true);
  });

  it('forwards a held reply as soon as its quote snippet resolves', async () => {
    const { bridge, db, maxClient, telegramBot } = primedBridge();
    linkChat(db, 'chat-a', { unread: true });
    maxClient.readMessages
      // Poll 1: quote still loading -> held.
      .mockResolvedValueOnce([
        maxMessage('r1', 'chat-a', { metadata: { replyLinkPresent: true } })
      ])
      // Poll 2: same bubble re-read with the snippet populated -> forwarded now,
      // well before the 5-sighting grace cap.
      .mockResolvedValueOnce([
        maxMessage('r1', 'chat-a', {
          metadata: { replyLinkPresent: true, replyToSnippet: 'original text' }
        })
      ]);

    await bridge.pollMax();
    expect(telegramBot.sendMessage).not.toHaveBeenCalled();
    expect(db.hasMessage('r1')).toBe(false);

    await bridge.pollMax();
    expect(telegramBot.sendMessage).toHaveBeenCalledTimes(1);
    expect(telegramBot.sendMessage.mock.calls[0][0].id).toBe('r1');
    expect(db.hasMessage('r1')).toBe(true);
  });

  it('retries a failed forward, then gives up with deliveryFailed after maxDeliveryAttempts', async () => {
    const { bridge, db, maxClient, telegramBot } = primedBridge();
    linkChat(db, 'chat-a', { unread: true });
    maxClient.readMessages.mockImplementation(async () => [maxMessage('m1', 'chat-a')]);
    telegramBot.sendMessage.mockRejectedValue(new Error('telegram down'));

    // Attempt 1 fails: message stays un-inserted so the next poll retries it.
    await bridge.pollMax();
    expect(telegramBot.sendMessage).toHaveBeenCalledTimes(1);
    expect(db.hasMessage('m1')).toBe(false);
    expect(db.countFailedDeliveries('m1', 'max_to_tg')).toBe(1);
    expect(telegramBot.sendText).not.toHaveBeenCalled();

    // Attempt 2 fails too: maxDeliveryAttempts(=2) reached, so the message is
    // parked as deliveryFailed and the owner is warned instead of retrying forever.
    await bridge.pollMax();
    expect(telegramBot.sendMessage).toHaveBeenCalledTimes(2);
    expect(db.hasMessage('m1')).toBe(true);
    expect(db.countFailedDeliveries('m1', 'max_to_tg')).toBe(2);
    const stored = db.recentMessages('chat-a', 10).find((m) => m.id === 'm1');
    expect(stored.metadata.deliveryFailed).toBe(true);
    expect(telegramBot.sendText).toHaveBeenCalledTimes(1);
    expect(telegramBot.sendText.mock.calls[0][0]).toContain('Не удалось доставить');
    expect(telegramBot.sendText.mock.calls[0][0]).toContain('chat-a');

    // Poll 3: the parked message is now known -> no further send attempts.
    await bridge.pollMax();
    expect(telegramBot.sendMessage).toHaveBeenCalledTimes(2);
    expect(telegramBot.sendText).toHaveBeenCalledTimes(1);
  });

  it('marks a chat chronically unreachable after 3 "Max chat not found" polls without throwing', async () => {
    const { bridge, db, maxClient } = primedBridge();
    linkChat(db, 'ghost', { unread: true });
    maxClient.readMessages.mockRejectedValue(new Error('Max chat not found: ghost'));

    // First two failures are tolerated silently: still unread, still polled.
    await bridge.pollMax();
    await bridge.pollMax();
    expect(bridge.chronicallyUnreachableChatIds.has('ghost')).toBe(false);
    expect(db.listChats().find((c) => c.id === 'ghost').metadata.unread).toBe(true);

    // Third consecutive not-found: chat is benched, unread flag cleared so it
    // stops occupying a poll slot — and none of the three polls rejected
    // (unreachable is benign and must not feed the restart loop).
    await expect(bridge.pollMax()).resolves.toBeUndefined();
    expect(bridge.chronicallyUnreachableChatIds.has('ghost')).toBe(true);
    expect(db.listChats().find((c) => c.id === 'ghost').metadata.unread).toBe(false);
  });

  it('rejects when every reachable chat fails to read with a generic error', async () => {
    const { bridge, db, maxClient } = primedBridge();
    linkChat(db, 'chat-a', { unread: true });
    linkChat(db, 'chat-b', { unread: true, telegramThreadId: 78 });
    maxClient.readMessages.mockRejectedValue(new Error('page crashed'));

    await expect(bridge.pollMax()).rejects.toThrow('All 2 polled chats failed to read');
  });

  it('keeps forwarding from a healthy chat when another chat fails generically', async () => {
    const { bridge, db, maxClient, telegramBot } = primedBridge();
    linkChat(db, 'bad', { unread: true });
    linkChat(db, 'good', { unread: true, telegramThreadId: 78 });
    maxClient.readMessages.mockImplementation(async (chatId) => {
      if (chatId === 'bad') throw new Error('detached DOM node');
      return [maxMessage('g1', 'good')];
    });

    // One healthy chat succeeded, so this is not an "all failed" situation.
    await expect(bridge.pollMax()).resolves.toBeUndefined();
    expect(telegramBot.sendMessage).toHaveBeenCalledTimes(1);
    expect(telegramBot.sendMessage.mock.calls[0][0].id).toBe('g1');
    expect(db.hasMessage('g1')).toBe(true);
  });
});

describe('pollMax under Telegram flood control (429)', () => {
  // A whole relay group shares ~20 messages a minute. Counted as ordinary
  // failures, the retry budget (5 attempts, one per poll) burned out within
  // seconds while Telegram was asking for 30+, and the burst was dropped for
  // good — with the "given up" notice itself rejected by the same 429.
  function floodError(retryAfter = 30) {
    return Object.assign(new Error(`429: Too Many Requests: retry after ${retryAfter}`), {
      code: 429,
      parameters: { retry_after: retryAfter }
    });
  }

  it('pauses forwarding instead of burning the retry budget, then delivers in order', async () => {
    vi.useFakeTimers();
    try {
      const { bridge, db, maxClient, telegramBot } = primedBridge();
      linkChat(db, 'chat-a', { unread: true });
      maxClient.readMessages.mockResolvedValue([maxMessage('m1', 'chat-a'), maxMessage('m2', 'chat-a')]);
      telegramBot.sendMessage.mockRejectedValueOnce(floodError(30));

      for (let i = 0; i < 10; i++) {
        bridge.lastChatRefreshAt = Date.now();
        await bridge.pollMax();
        await vi.advanceTimersByTimeAsync(1000);
      }

      // One attempt, then silence for the window: m2 was never tried ahead
      // of m1, nothing was given up, no failure counted.
      expect(telegramBot.sendMessage).toHaveBeenCalledTimes(1);
      expect(db.countFailedDeliveries('m1', 'max_to_tg')).toBe(0);
      expect(db.hasMessage('m1')).toBe(false);
      expect(telegramBot.sendText).not.toHaveBeenCalled();
      expect(await bridge.formatStatus()).toContain('forwarding paused');

      await vi.advanceTimersByTimeAsync(21000);
      bridge.lastChatRefreshAt = Date.now();
      await bridge.pollMax();

      expect(telegramBot.sendMessage.mock.calls.slice(1).map(([message]) => message.id)).toEqual(['m1', 'm2']);
      expect(db.hasMessage('m1')).toBe(true);
      expect(db.hasMessage('m2')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('pollMax on a chat with no stored history', () => {
  // A renamed MAX chat (ids are titles), a new chat, or one that was scrolled
  // out of view during first-run priming: everything MAX shows in it is new to
  // the database, and all of it used to be forwarded at once.
  function historyBridge() {
    const parts = makeBridge({ config: makeTestConfig({ startupPrimeExistingMessages: true }) });
    parts.bridge.lastChatRefreshAt = Date.now();
    linkChat(parts.db, 'known', { unread: false });
    parts.db.insertMessage(maxMessage('known-1', 'known')); // not a first run
    return parts;
  }

  it('forwards only as many of the newest messages as the unread badge shows, and stores the rest as seen', async () => {
    const { bridge, db, maxClient, telegramBot } = historyBridge();
    linkChat(db, 'Anna 🌸', { unread: true, telegramThreadId: 81 });
    db.upsertChat({ id: 'Anna 🌸', title: 'Anna 🌸', lastSeenAt: Date.now() + 1000, metadata: { unread: true, unreadText: '2' } });
    const history = Array.from({ length: 40 }, (_, i) => maxMessage(`old-${i}`, 'Anna 🌸'));
    maxClient.readMessages.mockImplementation(async (chatId) => (chatId === 'Anna 🌸' ? history : []));

    await bridge.pollMax();

    expect(telegramBot.sendMessage.mock.calls.map(([message]) => message.id)).toEqual(['old-38', 'old-39']);
    expect(db.hasMessage('old-0')).toBe(true); // seen, not delivered
    expect(db.hasMessage('old-37')).toBe(true);
  });

  it('forwards at least the newest one when there is no badge', async () => {
    const { bridge, db, maxClient, telegramBot } = historyBridge();
    linkChat(db, 'Oleg', { unread: false, telegramThreadId: 82 });
    maxClient.readMessages.mockImplementation(async (chatId) => (
      chatId === 'Oleg' ? [maxMessage('o1', 'Oleg'), maxMessage('o2', 'Oleg')] : []
    ));

    await bridge.pollMax();

    expect(telegramBot.sendMessage.mock.calls.map(([message]) => message.id)).toEqual(['o2']);
  });

  it('a chat with stored history forwards every unseen message as before', async () => {
    const { bridge, db, maxClient, telegramBot } = historyBridge();
    maxClient.readMessages.mockImplementation(async (chatId) => (
      chatId === 'known' ? [maxMessage('known-1', 'known'), maxMessage('k2', 'known'), maxMessage('k3', 'known')] : []
    ));

    await bridge.pollMax();

    expect(telegramBot.sendMessage.mock.calls.map(([message]) => message.id)).toEqual(['k2', 'k3']);
  });
});
