import { describe, it, expect, vi } from 'vitest';
import {
  makeBridge,
  makeFakeMaxClient,
  makeTestConfig,
  linkChat,
  telegramMessage
} from '../helpers/bridgeHarness.js';

// The planned browser recycle replaces the host cron that restarted the whole
// container every 2 hours because Chromium's memory keeps growing. What has to
// hold: it fires on age or on measured memory, only at a safe point (never
// during a QR sign-in, never across an in-flight send), a Telegram send that
// lands mid-recycle waits instead of being refused, and a failed relaunch is
// left to the ordinary poll-failure recovery.

const MB = 1024 * 1024;
const MIN = 60 * 1000;

function recyclingBridge({ config = {}, maxClient } = {}) {
  const harness = makeBridge({
    maxClient: maxClient || makeFakeMaxClient({
      getBrowserMemoryUsage: vi.fn(async () => ({ bytes: 500 * MB, processes: 6, method: 'pss' }))
    }),
    config: makeTestConfig({ browserRecycleMinutes: 120, browserMemoryLimitMb: 1300, ...config })
  });
  harness.bridge.running = true;
  harness.bridge.browserStartedAt = Date.now();
  return harness;
}

describe('BridgeService planned browser recycle', () => {
  describe('when it is due', () => {
    it('does nothing for a young browser under the memory limit', async () => {
      const { bridge, maxClient } = recyclingBridge();

      await expect(bridge.maybeRecycleBrowser()).resolves.toBe(false);

      expect(maxClient.getBrowserMemoryUsage).toHaveBeenCalledTimes(1);
      expect(maxClient.stop).not.toHaveBeenCalled();
      expect(bridge.lastBrowserMemory.bytes).toBe(500 * MB);
    });

    it('recycles once the browser reaches the configured age', async () => {
      const { bridge, maxClient, telegramBot } = recyclingBridge();
      bridge.browserStartedAt = Date.now() - 121 * MIN;
      bridge.consecutivePollFailures = 2;

      await expect(bridge.maybeRecycleBrowser()).resolves.toBe(true);

      expect(maxClient.stop).toHaveBeenCalledTimes(1);
      expect(maxClient.start).toHaveBeenCalledTimes(1);
      expect(maxClient.stop.mock.invocationCallOrder[0]).toBeLessThan(maxClient.start.mock.invocationCallOrder[0]);
      expect(maxClient.waitForReady).toHaveBeenCalledTimes(1);
      expect(bridge.browserRecycles).toBe(1);
      expect(bridge.lastBrowserRecycle).toMatchObject({ reason: 'age', ok: true });
      expect(bridge.consecutivePollFailures).toBe(0);
      expect(bridge.browserStartedAt).toBeGreaterThan(Date.now() - 1000);
      expect(bridge.lastChatRefreshAt).toBe(0);
      // Routine maintenance: the owner is not pinged about it.
      expect(telegramBot.sendText).not.toHaveBeenCalled();
      expect(telegramBot.sendOwnerText).not.toHaveBeenCalled();
    });

    it('relaunches at once when the browser crashed or disconnected, however young', async () => {
      const { bridge, maxClient } = recyclingBridge({
        maxClient: makeFakeMaxClient({
          isAlive: vi.fn(() => false),
          getBrowserMemoryUsage: vi.fn(async () => ({ bytes: 100 * MB, processes: 1, method: 'pss' }))
        })
      });
      bridge.browserStartedAt = Date.now() - 1 * MIN;

      await expect(bridge.maybeRecycleBrowser()).resolves.toBe(true);

      expect(maxClient.stop).toHaveBeenCalledTimes(1);
      expect(maxClient.start).toHaveBeenCalledTimes(1);
      expect(bridge.lastBrowserRecycle).toMatchObject({ tier: 'relaunch', reason: 'browser-gone', ok: true });
    });

    it('leaves a live browser alone', async () => {
      const { bridge, maxClient } = recyclingBridge({
        maxClient: makeFakeMaxClient({
          isAlive: vi.fn(() => true),
          getBrowserMemoryUsage: vi.fn(async () => ({ bytes: 100 * MB, processes: 1, method: 'pss' }))
        })
      });

      await expect(bridge.maybeRecycleBrowser()).resolves.toBe(false);
      expect(maxClient.stop).not.toHaveBeenCalled();
    });

    it('recycles as soon as Chromium is above the memory limit', async () => {
      const { bridge, maxClient } = recyclingBridge();
      bridge.browserStartedAt = Date.now() - 40 * MIN;
      maxClient.getBrowserMemoryUsage.mockResolvedValue({ bytes: 1500 * MB, processes: 7, method: 'pss' });

      await expect(bridge.maybeRecycleBrowser()).resolves.toBe(true);

      expect(maxClient.start).toHaveBeenCalledTimes(1);
      expect(bridge.lastBrowserRecycle).toMatchObject({ reason: 'memory', ok: true });
    });

    it('does not loop on a fresh browser that already starts above the limit', async () => {
      const { bridge, maxClient } = recyclingBridge();
      bridge.browserStartedAt = Date.now() - 2 * MIN;
      maxClient.getBrowserMemoryUsage.mockResolvedValue({ bytes: 1500 * MB, processes: 7, method: 'pss' });

      await expect(bridge.maybeRecycleBrowser()).resolves.toBe(false);

      expect(maxClient.stop).not.toHaveBeenCalled();
    });

    it('reads memory at most once a minute', async () => {
      const { bridge, maxClient } = recyclingBridge();
      const now = Date.now();

      await bridge.maybeRecycleBrowser(now);
      await bridge.maybeRecycleBrowser(now + 30 * 1000);
      expect(maxClient.getBrowserMemoryUsage).toHaveBeenCalledTimes(1);

      await bridge.maybeRecycleBrowser(now + 61 * 1000);
      expect(maxClient.getBrowserMemoryUsage).toHaveBeenCalledTimes(2);
    });

    it('still recycles by age where memory cannot be measured', async () => {
      const { bridge, maxClient } = recyclingBridge();
      maxClient.getBrowserMemoryUsage.mockResolvedValue(null);
      await expect(bridge.maybeRecycleBrowser()).resolves.toBe(false);

      bridge.browserStartedAt = Date.now() - 125 * MIN;
      await expect(bridge.maybeRecycleBrowser()).resolves.toBe(true);
      expect(maxClient.start).toHaveBeenCalledTimes(1);
    });

    it('is fully disabled with both limits set to 0', async () => {
      const { bridge, maxClient } = recyclingBridge({ config: { browserRecycleMinutes: 0, browserMemoryLimitMb: 0 } });
      bridge.browserStartedAt = Date.now() - 24 * 60 * MIN;

      await expect(bridge.maybeRecycleBrowser()).resolves.toBe(false);

      expect(maxClient.getBrowserMemoryUsage).not.toHaveBeenCalled();
      expect(maxClient.stop).not.toHaveBeenCalled();
    });
  });

  describe('when it must NOT run', () => {
    it('never interrupts a QR sign-in', async () => {
      const { bridge, maxClient } = recyclingBridge();
      bridge.browserStartedAt = Date.now() - 500 * MIN;
      bridge.loginInProgress = true;

      await expect(bridge.maybeRecycleBrowser()).resolves.toBe(false);
      expect(maxClient.stop).not.toHaveBeenCalled();
    });

    it('does nothing once the bridge is stopping', async () => {
      const { bridge, maxClient } = recyclingBridge();
      bridge.browserStartedAt = Date.now() - 500 * MIN;
      bridge.running = false;

      await expect(bridge.maybeRecycleBrowser()).resolves.toBe(false);
      expect(maxClient.stop).not.toHaveBeenCalled();
    });

    it('bails out under the lock if stop() began while it was queued', async () => {
      const { bridge, maxClient } = recyclingBridge();
      bridge.browserStartedAt = Date.now() - 500 * MIN;

      bridge.maxLock.run(() => new Promise((resolve) => setTimeout(resolve, 30)));
      const recycle = bridge.maybeRecycleBrowser(); // passes the outer guard, queues on the lock
      const stopping = bridge.stop();
      await Promise.all([recycle, stopping]);

      expect(maxClient.start).not.toHaveBeenCalled();
      expect(maxClient.stop).toHaveBeenCalledTimes(1); // the shutdown close only
      expect(bridge.browserRecycles).toBe(0);
    });

    it('lets an in-flight send finish before tearing the page down', async () => {
      const { bridge, maxClient } = recyclingBridge();
      bridge.browserStartedAt = Date.now() - 500 * MIN;
      const events = [];
      maxClient.stop.mockImplementation(async () => { events.push('browser-closed'); });
      bridge.maxLock.run(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        events.push('send-done');
      });

      await bridge.maybeRecycleBrowser();

      expect(events).toEqual(['send-done', 'browser-closed']);
    });
  });

  it('a Telegram message arriving mid-recycle waits for the new page instead of being refused', async () => {
    let releaseStart;
    const maxClient = makeFakeMaxClient({ getBrowserMemoryUsage: vi.fn(async () => null) });
    const { bridge, db, telegramBot } = recyclingBridge({ maxClient });
    linkChat(db, 'chat-a');
    bridge.browserStartedAt = Date.now() - 500 * MIN;
    // Between stop() and the end of start() the client has no page at all —
    // exactly the state that used to make a send answer "MAX is not connected".
    maxClient.stop.mockImplementation(async () => { maxClient.page = null; });
    maxClient.start.mockImplementation(() => new Promise((resolve) => {
      releaseStart = () => {
        maxClient.page = { url: () => 'https://web.max.ru/' };
        resolve();
      };
    }));

    const recycle = bridge.maybeRecycleBrowser();
    await vi.waitFor(() => expect(maxClient.start).toHaveBeenCalled());
    expect(maxClient.page).toBeNull();
    const send = bridge.handleTelegramMessage(telegramMessage('tg-1', { text: 'hello' }));
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(maxClient.sendText).not.toHaveBeenCalled();

    releaseStart();
    await Promise.all([recycle, send]);

    expect(maxClient.waitForReady.mock.invocationCallOrder[0])
      .toBeLessThan(maxClient.sendText.mock.invocationCallOrder[0]);
    expect(maxClient.sendText).toHaveBeenCalledWith('chat-a', 'hello', null);
    expect(telegramBot.sendText).not.toHaveBeenCalled(); // no "MAX is not connected" refusal
  });

  it('hands over to the sign-in check when the new page never shows the chat list', async () => {
    const { bridge, maxClient } = recyclingBridge();
    bridge.browserStartedAt = Date.now() - 500 * MIN;
    maxClient.waitForReady.mockRejectedValue(new Error('Waiting for selector failed'));
    const login = vi.spyOn(bridge, 'ensureMaxLogin').mockResolvedValue(true);

    await expect(bridge.maybeRecycleBrowser()).resolves.toBe(true);

    expect(login).toHaveBeenCalledWith({ reason: 'after-recycle' });
    expect(bridge.lastBrowserRecycle).toMatchObject({ reason: 'age', ok: false });
  });

  it('a relaunch that throws is reported, clears the in-progress flag, and polling carries on', async () => {
    const { bridge, maxClient } = recyclingBridge();
    bridge.browserStartedAt = Date.now() - 500 * MIN;
    maxClient.start.mockRejectedValue(new Error('Failed to launch the browser process'));
    const poll = vi.spyOn(bridge, 'pollMax').mockResolvedValue();

    await bridge.runPollCycle();

    expect(bridge.browserRecycling).toBe(false);
    expect(bridge.lastBrowserRecycle).toMatchObject({ reason: 'age', ok: false, error: 'Failed to launch the browser process' });
    expect(poll).toHaveBeenCalledTimes(1);
  });

  it('runs between poll cycles: the recycle completes before the next poll starts', async () => {
    const { bridge, maxClient } = recyclingBridge();
    bridge.browserStartedAt = Date.now() - 500 * MIN;
    const events = [];
    maxClient.start.mockImplementation(async () => { events.push('relaunched'); });
    vi.spyOn(bridge, 'pollMax').mockImplementation(async () => { events.push('poll'); });

    await bridge.runPollCycle();

    expect(events).toEqual(['relaunched', 'poll']);
  });

  it('shows the browser state in /status', async () => {
    const { bridge } = recyclingBridge({ config: { pageReloadMemoryMb: 900 } });
    bridge.browserStartedAt = Date.now() - 42 * MIN;
    bridge.pageLoadedAt = Date.now() - 10 * MIN;
    bridge.lastBrowserMemory = { bytes: 812 * MB, processes: 6, method: 'pss', at: Date.now(), page: { domNodes: 4100, jsHeapBytes: 30 * MB } };
    bridge.browserRecycles = 3;
    bridge.pageReloads = 2;
    bridge.lastBrowserRecycle = { at: Date.now() - 10 * MIN, tier: 'reload', reason: 'memory', ok: true };

    const status = await bridge.formatStatus();

    expect(status).toContain('Browser uptime: 42 min (relaunch every 120 min)');
    expect(status).toContain('Page reloaded: 10 min ago');
    expect(status).toContain('Browser memory: 812 MB, 4100 DOM nodes (reload at 900, relaunch at 1300 MB)');
    expect(status).toContain('Browser recycles: 3, page reloads: 2 (last: reload for memory, 10 min ago)');
  });
});

describe('BridgeService page reload tier', () => {
  function reloadingBridge(memoryMb) {
    const harness = recyclingBridge({
      config: { pageReloadMemoryMb: 900 },
      maxClient: makeFakeMaxClient({
        getBrowserMemoryUsage: vi.fn(async () => ({ bytes: memoryMb * MB, processes: 6, method: 'pss' })),
        reloadPage: vi.fn(async () => {})
      })
    });
    harness.bridge.browserStartedAt = Date.now() - 60 * MIN;
    harness.bridge.pageLoadedAt = harness.bridge.browserStartedAt;
    return harness;
  }

  it('above the reload threshold only reloads the page — no browser relaunch', async () => {
    const { bridge, maxClient } = reloadingBridge(1000);
    const before = bridge.pageLoadedAt;

    await expect(bridge.maybeRecycleBrowser()).resolves.toBe(true);

    expect(maxClient.reloadPage).toHaveBeenCalledTimes(1);
    expect(maxClient.stop).not.toHaveBeenCalled();
    expect(maxClient.start).not.toHaveBeenCalled();
    expect(maxClient.waitForReady).toHaveBeenCalledTimes(1);
    expect(bridge.pageReloads).toBe(1);
    expect(bridge.browserRecycles).toBe(0);
    // Media URLs are re-signed on every load: the re-forward guard must treat
    // everything forwarded before this moment as "previous page".
    expect(bridge.pageLoadedAt).toBeGreaterThan(before);
  });

  it('above the relaunch limit relaunches even though a reload would be cheaper', async () => {
    const { bridge, maxClient } = reloadingBridge(1400);

    await bridge.maybeRecycleBrowser();

    expect(maxClient.reloadPage).not.toHaveBeenCalled();
    expect(maxClient.start).toHaveBeenCalledTimes(1);
    expect(bridge.lastBrowserRecycle).toMatchObject({ tier: 'relaunch', reason: 'memory' });
  });

  it('still above the reload threshold soon after a reload: the growth is outside the page, relaunch', async () => {
    const { bridge, maxClient } = reloadingBridge(1000);
    const now = Date.now();
    await bridge.maybeRecycleBrowser(now);
    expect(maxClient.reloadPage).toHaveBeenCalledTimes(1);

    // 20 minutes later (past the 15-minute minimum page age), memory unchanged.
    bridge.pageLoadedAt = now - 20 * MIN;
    await bridge.maybeRecycleBrowser(now + 20 * MIN);

    expect(maxClient.reloadPage).toHaveBeenCalledTimes(1);
    expect(maxClient.start).toHaveBeenCalledTimes(1);
    expect(bridge.lastBrowserRecycle).toMatchObject({ tier: 'relaunch', reason: 'memory-after-reload' });
  });

  it('a reload that fails falls back to a relaunch', async () => {
    const { bridge, maxClient } = reloadingBridge(1000);
    maxClient.reloadPage.mockRejectedValue(new Error('Navigation timeout of 60000 ms exceeded'));

    await expect(bridge.maybeRecycleBrowser()).resolves.toBe(true);

    expect(maxClient.start).toHaveBeenCalledTimes(1);
    expect(bridge.browserRecycles).toBe(1);
    expect(bridge.lastBrowserRecycle).toMatchObject({ tier: 'relaunch', ok: true });
  });
});
