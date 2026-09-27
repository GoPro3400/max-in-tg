import { describe, it, expect, vi, afterEach } from 'vitest';
import { MaxWebClient } from '../../src/adapters/maxWebClient.js';

// stop() now runs on a schedule (the planned browser recycle), not only at
// shutdown, so it must never hang: a wedged Chromium that ignores the CDP
// close request would otherwise hold the bridge's global lock for the whole
// protocol timeout. And a close we asked for is not an "unexpected disconnect".

function makeClient() {
  return new MaxWebClient(
    { userDataDir: '/tmp/x', selectors: { chatList: '.chat-list' }, headless: true },
    { diagnosticDir: '/tmp/d', mediaDir: '/tmp/m' }
  );
}

function fakeBrowser({ close }) {
  const kill = vi.fn();
  return {
    close: vi.fn(close),
    process: () => ({ pid: 4242, kill }),
    kill
  };
}

describe('MaxWebClient.stop', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('closes the browser and resets all page state', async () => {
    const client = makeClient();
    const browser = fakeBrowser({ close: async () => {} });
    client.browser = browser;
    client.page = {};
    client.activeChatId = 'chat-a';
    client.voiceUrls.set('u', { buffer: Buffer.alloc(1) });

    await client.stop();

    expect(browser.close).toHaveBeenCalledTimes(1);
    expect(browser.kill).not.toHaveBeenCalled();
    expect(client.browser).toBeNull();
    expect(client.page).toBeNull();
    expect(client.activeChatId).toBeNull();
    expect(client.voiceUrls.size).toBe(0);
  });

  it('kills Chromium when close() never answers', async () => {
    vi.useFakeTimers();
    const client = makeClient();
    const browser = fakeBrowser({ close: () => new Promise(() => {}) });
    client.browser = browser;
    client.page = {};

    const stopping = client.stop();
    await vi.advanceTimersByTimeAsync(15000);
    await stopping;

    expect(browser.kill).toHaveBeenCalledWith('SIGKILL');
    expect(client.page).toBeNull();
  });

  it('kills Chromium and does not throw when close() rejects', async () => {
    const client = makeClient();
    const browser = fakeBrowser({ close: async () => { throw new Error('Connection closed'); } });
    client.browser = browser;

    await expect(client.stop()).resolves.toBeUndefined();
    expect(browser.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('is a no-op without a browser', async () => {
    await expect(makeClient().stop()).resolves.toBeUndefined();
  });
});

describe('MaxWebClient.getBrowserMemoryUsage', () => {
  it('returns null without a local browser process', async () => {
    const client = makeClient();
    await expect(client.getBrowserMemoryUsage()).resolves.toBeNull();
    client.browser = { process: () => null };
    await expect(client.getBrowserMemoryUsage()).resolves.toBeNull();
  });

  it('measures the process tree of the launched browser', async () => {
    if (process.platform !== 'linux') return;
    const client = makeClient();
    client.browser = { process: () => ({ pid: process.pid }) };
    const usage = await client.getBrowserMemoryUsage();
    expect(usage.bytes).toBeGreaterThan(0);
  });
});
