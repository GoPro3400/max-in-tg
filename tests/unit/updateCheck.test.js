import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppDatabase } from '../../src/storage/database.js';
import { UpdateChecker, compareVersions, parseVersion } from '../../src/services/updateCheck.js';
import { APP_VERSION } from '../../src/version.js';
import { makeBridge, makeTestConfig } from '../helpers/bridgeHarness.js';

describe('versions', () => {
  it('reads what a release tag looks like', () => {
    expect(parseVersion('v0.2.0')).toEqual({ numbers: [0, 2, 0], prerelease: null });
    expect(parseVersion('1.10.3')).toEqual({ numbers: [1, 10, 3], prerelease: null });
    expect(parseVersion('v1.0.0-rc.1')).toEqual({ numbers: [1, 0, 0], prerelease: 'rc.1' });
    expect(parseVersion('v1.0.0+build.5')).toEqual({ numbers: [1, 0, 0], prerelease: null });
    for (const bad of ['', 'latest', 'v1.2', '1.2.3.4', 'x.y.z', null, undefined, 'v1.2.3; rm -rf /']) {
      expect(parseVersion(bad)).toBeNull();
    }
  });

  it('tells which is newer, numbers not text', () => {
    expect(compareVersions('0.10.0', '0.9.0')).toBe(1);
    expect(compareVersions('0.2.0', '0.10.0')).toBe(-1);
    expect(compareVersions('v1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('1.0.1', '1.0.0')).toBe(1);
    expect(compareVersions('2.0.0', '1.99.99')).toBe(1);
    expect(compareVersions('1.0.0', '1.0.0-rc.1')).toBe(1);
    expect(compareVersions('1.0.0-rc.1', '1.0.0')).toBe(-1);
    expect(compareVersions('1.0.0-rc.2', '1.0.0-rc.1')).toBe(1);
    expect(compareVersions('unknown', '1.0.0')).toBeNull();
  });
});

describe('UpdateChecker', () => {
  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;
  let db;
  let clock;
  let notify;
  let answers;
  let fetchImpl;

  const release = (tag, extra = {}) => ({ tag_name: tag, html_url: 'https://elsewhere.example/x', draft: false, prerelease: false, ...extra });
  const respond = (body, status = 200) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
  const make = (overrides = {}) => new UpdateChecker({
    db,
    notify,
    currentVersion: '0.2.0',
    repo: 'GoPro3400/max-in-tg',
    enabled: true,
    fetchImpl,
    now: () => clock,
    ...overrides
  });

  beforeEach(() => {
    db = new AppDatabase(':memory:');
    clock = Date.UTC(2026, 8, 29, 12, 0, 0);
    notify = vi.fn(async () => true);
    answers = [respond(release('v0.3.0'))];
    fetchImpl = vi.fn(async () => (answers.length > 1 ? answers.shift() : answers[0]));
  });
  afterEach(() => {
    vi.useRealTimers();
    db.close();
  });

  it('tells the owner once about a newer release, with what to run', async () => {
    const result = await make().check();

    expect(result).toMatchObject({ state: 'available', latest: { version: '0.3.0' }, notified: true });
    expect(notify).toHaveBeenCalledTimes(1);
    const text = notify.mock.calls[0][0];
    expect(text).toContain('0.3.0');
    expect(text).toContain('сейчас 0.2.0');
    expect(text).toContain('docker compose pull');
    expect(text).toContain('docker compose up -d');
    expect(text).toContain('UPDATE_CHECK=false');
    // The address is made from the tag, never taken from the answer.
    expect(text).toContain('https://github.com/GoPro3400/max-in-tg/releases/tag/v0.3.0');
    expect(text).not.toContain('elsewhere.example');
  });

  it('asks GitHub for that repository\'s latest release, and says who is asking', async () => {
    await make({ repo: 'someone/fork' }).check();

    const [url, options] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.github.com/repos/someone/fork/releases/latest');
    expect(options.headers['User-Agent']).toBe('max-in-tg/0.2.0');
    expect(options.headers.Accept).toBe('application/vnd.github+json');
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it('asks once a day, and does not repeat itself about a version already announced', async () => {
    const checker = make();
    await checker.check();
    clock += 5 * HOUR;
    expect(await checker.check()).toMatchObject({ state: 'available', notified: false });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledTimes(1);

    // A day later: asked again, the same version is not announced again ...
    clock += DAY;
    await checker.check();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenCalledTimes(1);

    // ... and a newer one is.
    answers = [respond(release('v0.4.0'))];
    clock += DAY;
    await checker.check();
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify.mock.calls[1][0]).toContain('0.4.0');
  });

  it('remembers what it was told across restarts', async () => {
    await make().check();
    clock += 2 * DAY;
    // A new process, the same database.
    await make().check();
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('says nothing when it is up to date, or ahead', async () => {
    expect(await make({ currentVersion: '0.3.0' }).check()).toMatchObject({ state: 'current' });
    clock += 2 * DAY;
    expect(await make({ currentVersion: '0.9.0' }).check()).toMatchObject({ state: 'current' });
    expect(notify).not.toHaveBeenCalled();
  });

  it('ignores drafts, pre-releases, odd tags and repositories with no release', async () => {
    for (const answer of [
      respond(release('v0.3.0', { draft: true })),
      respond(release('v0.3.0', { prerelease: true })),
      respond(release('v0.3.0-rc.1')),
      respond(release('nightly')),
      respond({ message: 'Not Found' }, 404)
    ]) {
      db.setSetting('update_check', {});
      answers = [answer];
      expect(await make().check()).toMatchObject({ state: 'current', latest: null });
    }
    expect(notify).not.toHaveBeenCalled();
  });

  it('counts "no release yet" as a check, so it does not ask again within the day', async () => {
    answers = [respond({}, 404)];
    const checker = make();
    await checker.check();
    clock += HOUR;
    await checker.check();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('tries again at the next step after a failed request, and never tells the owner about it', async () => {
    fetchImpl = vi.fn()
      .mockRejectedValueOnce(new Error('getaddrinfo ENOTFOUND api.github.com'))
      .mockResolvedValueOnce(respond({ message: 'rate limit exceeded' }, 403))
      .mockResolvedValue(respond(release('v0.3.0')));
    const checker = make();

    expect(await checker.check()).toEqual({ state: 'failed' });
    clock += HOUR;
    expect(await checker.check()).toEqual({ state: 'failed' });
    expect(notify).not.toHaveBeenCalled();
    clock += HOUR;
    expect(await checker.check()).toMatchObject({ state: 'available', notified: true });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('tries the message again, without asking GitHub again, when Telegram did not take it', async () => {
    notify = vi.fn().mockResolvedValueOnce(false).mockRejectedValueOnce(new Error('ETIMEDOUT')).mockResolvedValue(true);
    const checker = make();

    expect(await checker.check()).toMatchObject({ state: 'available', notified: false });
    clock += HOUR;
    expect(await checker.check()).toMatchObject({ state: 'available', notified: false });
    clock += HOUR;
    expect(await checker.check()).toMatchObject({ state: 'available', notified: true });
    clock += HOUR;
    await checker.check();

    expect(notify).toHaveBeenCalledTimes(3);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does nothing when switched off, or when it does not know its own version', async () => {
    expect(await make({ enabled: false }).check()).toEqual({ state: 'disabled' });
    expect(await make({ currentVersion: 'unknown' }).check()).toEqual({ state: 'unknown-version' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(make({ enabled: false }).available()).toBeNull();
  });

  it('knows the newer release for /status without asking', async () => {
    const checker = make();
    expect(checker.available()).toBeNull();
    await checker.check();
    expect(checker.available()).toEqual({ version: '0.3.0', url: 'https://github.com/GoPro3400/max-in-tg/releases/tag/v0.3.0' });
    // Once updated, it is not "available" any more.
    expect(make({ currentVersion: '0.3.0' }).available()).toBeNull();
  });

  it('checks a little after starting, then every step, and stops when told', async () => {
    vi.useFakeTimers();
    const checker = make();
    const spy = vi.spyOn(checker, 'check').mockResolvedValue({ state: 'current' });

    checker.start({ firstDelayMs: 1000, tickMs: 5000 });
    expect(spy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(spy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(spy).toHaveBeenCalledTimes(2);

    checker.stop();
    await vi.advanceTimersByTimeAsync(20000);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('does not schedule anything when switched off', async () => {
    vi.useFakeTimers();
    const checker = make({ enabled: false });
    const spy = vi.spyOn(checker, 'check');
    checker.start({ firstDelayMs: 10 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('the bridge and the update notice', () => {
  it('shows its version in /status, and a newer release when it knows of one', async () => {
    const { bridge, db } = makeBridge({ config: makeTestConfig({ updateCheck: true, updateCheckRepo: 'GoPro3400/max-in-tg' }) });
    expect((await bridge.formatStatus()).split('\n')[0]).toBe(`Version: ${APP_VERSION}`);
    expect(await bridge.formatStatus()).not.toContain('Update available');

    db.setSetting('update_check', { checkedAt: Date.now(), latest: { version: '99.0.0', url: 'https://github.com/GoPro3400/max-in-tg/releases/tag/v99.0.0' } });
    expect(await bridge.formatStatus()).toContain('Update available: 99.0.0 — https://github.com/GoPro3400/max-in-tg/releases/tag/v99.0.0');
  });

  it('is off unless the configuration turns it on (so no test or script reaches for the network)', async () => {
    const { bridge } = makeBridge();
    expect(bridge.updateChecker.enabled).toBe(false);
    expect(makeBridge({ config: makeTestConfig({ updateCheck: true }) }).bridge.updateChecker.enabled).toBe(true);
  });

  it('sends the notice to the owner in Telegram, and reports whether it went', async () => {
    const { bridge, telegramBot } = makeBridge();
    expect(await bridge.notifyUpdate('hello')).toBe(true);
    expect(telegramBot.sendOwnerText).toHaveBeenCalledWith('hello');

    // Nobody to tell yet (the bot is not paired): not sent.
    telegramBot.sendOwnerText.mockResolvedValueOnce(null);
    expect(await bridge.notifyUpdate('hello')).toBe(false);
    telegramBot.sendOwnerText.mockRejectedValueOnce(new Error('403: Forbidden'));
    expect(await bridge.notifyUpdate('hello')).toBe(false);
  });
});
