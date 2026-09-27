import { describe, it, expect, vi, afterEach } from 'vitest';
import { makeBridge, makeFakeTelegramBot } from '../helpers/bridgeHarness.js';

// start() binds every command handler; the shared fake lacks the mute ones.
const telegramBot = () => makeFakeTelegramBot({ onMute: vi.fn(), onUnmute: vi.fn() });

// BridgeService.start() end to end over the fake collaborators.

describe('BridgeService.start', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits for a /login sign-in started while the browser was launching instead of exiting', async () => {
    // The bot comes up before MAX, so the owner can send /login while Chromium
    // is still starting. That flow raises loginInProgress first; start()'s own
    // ensureMaxLogin then returned false, start() threw "MAX Web did not reach
    // a usable state" and the process exited in the middle of the sign-in.
    vi.useFakeTimers();
    const { bridge, maxClient } = makeBridge({ telegramBot: telegramBot() });
    const states = ['unknown', 'unknown', 'unknown'];
    maxClient.getSessionState.mockImplementation(async () => (states.length ? states.shift() : 'ready'));
    maxClient.start.mockImplementation(async () => {
      await bridge.requestLogin(); // "/login" arriving mid-launch
    });

    const started = bridge.start().then(() => 'started', (error) => error);
    await vi.advanceTimersByTimeAsync(10000);

    await expect(started).resolves.toBe('started');
    expect(bridge.running).toBe(true);
    expect(maxClient.waitForReady).toHaveBeenCalled();
    await bridge.stop();
  });

  it('drives the page for startup work only under the lock', async () => {
    // With the bot already live, a Telegram send could verify chat X and then
    // have startup priming click chat Y before the text was typed.
    const { bridge, db, maxClient } = makeBridge({ telegramBot: telegramBot() });
    bridge.config.startupPrimeExistingMessages = true;
    maxClient.listChats.mockResolvedValue([{ id: 'chat-a', title: 'A', metadata: {} }]);
    const lockedCalls = [];
    const original = bridge.maxLock.run.bind(bridge.maxLock);
    let depth = 0;
    bridge.maxLock.run = (task) => original(async () => {
      depth += 1;
      try { return await task(); } finally { depth -= 1; }
    });
    maxClient.listChats.mockImplementation(async () => {
      lockedCalls.push(['listChats', depth > 0]);
      return [{ id: 'chat-a', title: 'A', metadata: {} }];
    });
    maxClient.readMessages.mockImplementation(async () => {
      lockedCalls.push(['readMessages', depth > 0]);
      return [];
    });
    expect(db.isEmptyOfMessages()).toBe(true);

    await bridge.start();
    await bridge.stop();

    expect(lockedCalls.length).toBeGreaterThan(0);
    expect(lockedCalls.filter(([, locked]) => !locked)).toEqual([]);
  });
});
