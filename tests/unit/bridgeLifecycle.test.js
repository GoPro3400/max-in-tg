import { describe, it, expect, vi, afterEach } from 'vitest';
import { makeBridge, makeFakeMaxClient } from '../helpers/bridgeHarness.js';

// Lifecycle coverage for BridgeService.handlePollFailure and BridgeService.stop:
// the failure-threshold restart machinery, the session-navigated-away fast
// path, and how both methods serialize on the non-reentrant maxLock (including
// the 8s wedge escape hatch in stop()).

const RESTART_NOTICE = 'MAX Web was restarted after repeated polling failures.';

describe('BridgeService lifecycle', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('handlePollFailure', () => {
    it('below threshold: captures diagnostics but does not restart or notify', async () => {
      const { bridge, maxClient, telegramBot } = makeBridge();
      bridge.running = true;
      // One short of the threshold (3): the tight boundary, so an off-by-one
      // in the >= comparison that restarts one failure early fails this test.
      bridge.consecutivePollFailures = 2;

      await bridge.handlePollFailure(new Error('poll boom'));

      expect(maxClient.captureDiagnostics).toHaveBeenCalledTimes(1);
      expect(maxClient.captureDiagnostics).toHaveBeenCalledWith('poll-failure-2');
      expect(maxClient.stop).not.toHaveBeenCalled();
      expect(maxClient.start).not.toHaveBeenCalled();
      expect(telegramBot.sendText).not.toHaveBeenCalled();
      expect(bridge.consecutivePollFailures).toBe(2);
    });

    it('at threshold: stops then relaunches the browser, resets the counter, notifies Telegram', async () => {
      const { bridge, maxClient, telegramBot } = makeBridge();
      bridge.running = true;
      bridge.consecutivePollFailures = 3; // == maxPollFailuresBeforeRestart

      await bridge.handlePollFailure(new Error('poll boom'));

      expect(maxClient.stop).toHaveBeenCalledTimes(1);
      expect(maxClient.start).toHaveBeenCalledTimes(1);
      expect(maxClient.waitForReady).toHaveBeenCalledTimes(1);
      // Old browser must be torn down before the new one is launched.
      expect(maxClient.stop.mock.invocationCallOrder[0])
        .toBeLessThan(maxClient.start.mock.invocationCallOrder[0]);
      expect(bridge.consecutivePollFailures).toBe(0);
      expect(telegramBot.sendText).toHaveBeenCalledTimes(1);
      expect(telegramBot.sendText).toHaveBeenCalledWith(RESTART_NOTICE);
    });

    it('session navigated away from web.max.ru forces an immediate restart even on the first failure', async () => {
      const maxClient = makeFakeMaxClient({
        page: { url: () => 'https://accounts.example.com/login' }
      });
      const { bridge, telegramBot } = makeBridge({ maxClient });
      bridge.running = true;
      bridge.consecutivePollFailures = 1; // below threshold, but the URL check escalates it

      await bridge.handlePollFailure(new Error('poll boom'));

      expect(maxClient.stop).toHaveBeenCalledTimes(1);
      expect(maxClient.start).toHaveBeenCalledTimes(1);
      expect(maxClient.waitForReady).toHaveBeenCalledTimes(1);
      expect(bridge.consecutivePollFailures).toBe(0);
      expect(telegramBot.sendText).toHaveBeenCalledWith(RESTART_NOTICE);
    });

    it('restarts even when diagnostics capture and browser close both reject', async () => {
      const { bridge, maxClient, telegramBot } = makeBridge();
      bridge.running = true;
      bridge.consecutivePollFailures = 3;
      // Both failure modes at once: a dead page cannot serve a screenshot and
      // may refuse to close. The .catch(() => null) swallows on both sites are
      // exactly what keeps the restart itself alive — remove either and this
      // test fails.
      maxClient.captureDiagnostics.mockRejectedValue(new Error('page is gone'));
      maxClient.stop.mockRejectedValue(new Error('browser already dead'));

      await bridge.handlePollFailure(new Error('poll boom'));

      expect(maxClient.start).toHaveBeenCalledTimes(1);
      expect(maxClient.waitForReady).toHaveBeenCalledTimes(1);
      expect(bridge.consecutivePollFailures).toBe(0);
      expect(telegramBot.sendText).toHaveBeenCalledWith(RESTART_NOTICE);
    });

    it('does nothing at all when the bridge is not running', async () => {
      const { bridge, maxClient, telegramBot } = makeBridge();
      bridge.running = false;
      bridge.consecutivePollFailures = 3;

      await bridge.handlePollFailure(new Error('poll boom'));

      expect(maxClient.captureDiagnostics).not.toHaveBeenCalled();
      expect(maxClient.stop).not.toHaveBeenCalled();
      expect(maxClient.start).not.toHaveBeenCalled();
      expect(telegramBot.sendText).not.toHaveBeenCalled();
    });

    it('waits for an in-flight maxLock task before capturing diagnostics', async () => {
      const { bridge, maxClient } = makeBridge();
      bridge.running = true;
      bridge.consecutivePollFailures = 3;

      const events = [];
      maxClient.captureDiagnostics.mockImplementation(async () => {
        events.push('diag');
        return null;
      });

      // Occupy the lock with a task that only finishes after a 50ms macrotask.
      const slow = bridge.maxLock.run(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        events.push('slow-done');
      });

      const recovery = bridge.handlePollFailure(new Error('poll boom'));

      // Flush the microtask queue several times: if handlePollFailure could
      // jump the lock, captureDiagnostics would have run by now — the only
      // thing holding it back is the slow task's pending timer.
      for (let i = 0; i < 10; i++) await Promise.resolve();
      expect(maxClient.captureDiagnostics).not.toHaveBeenCalled();

      await Promise.all([slow, recovery]);
      expect(events).toEqual(['slow-done', 'diag']);
    });
  });

  describe('stop', () => {
    it('drains in-flight maxLock work before closing the browser, and stops the bot', async () => {
      const { bridge, maxClient, telegramBot } = makeBridge();
      bridge.running = true;

      const events = [];
      maxClient.stop.mockImplementation(async () => {
        events.push('browser-closed');
      });
      bridge.maxLock.run(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        events.push('task-done');
      });

      await bridge.stop();

      expect(events).toEqual(['task-done', 'browser-closed']);
      expect(telegramBot.stop).toHaveBeenCalledTimes(1);
      expect(telegramBot.stop).toHaveBeenCalledWith('SIGTERM');
      expect(bridge.running).toBe(false);
    });

    it('gives up on a wedged maxLock task after 8s and closes the browser anyway', async () => {
      vi.useFakeTimers();
      const { bridge, maxClient, telegramBot } = makeBridge();
      bridge.running = true;

      // A task that never resolves: the drain promise inside stop() can never
      // settle, so only the 8s timeout can unblock shutdown.
      bridge.maxLock.run(() => new Promise(() => {}));

      const stopping = bridge.stop();
      await vi.advanceTimersByTimeAsync(8000);
      await stopping;

      expect(maxClient.stop).toHaveBeenCalledTimes(1);
      expect(telegramBot.stop).toHaveBeenCalledTimes(1);
      vi.useRealTimers();
    });

    it('recovery already QUEUED behind the lock bails out once stop() flips running', async () => {
      // The other shutdown ordering: handlePollFailure passes the outer
      // running-guard while the lock is busy, its recovery section is queued,
      // and only THEN does stop() begin. The inner re-check of this.running
      // inside the lock section is the only thing preventing a browser
      // relaunch (and a spurious restart notice) mid-shutdown.
      const { bridge, maxClient, telegramBot } = makeBridge();
      bridge.running = true;
      bridge.consecutivePollFailures = 3;

      bridge.maxLock.run(() => new Promise((resolve) => setTimeout(resolve, 30)));
      const recovery = bridge.handlePollFailure(new Error('poll boom')); // queued, outer guard passed
      const stopping = bridge.stop(); // flips running=false before recovery's section runs
      await Promise.all([recovery, stopping]);

      expect(maxClient.captureDiagnostics).not.toHaveBeenCalled();
      expect(maxClient.start).not.toHaveBeenCalled();
      expect(maxClient.stop).toHaveBeenCalledTimes(1); // the shutdown close only
      expect(telegramBot.sendText).not.toHaveBeenCalled();
    });

    it('handlePollFailure racing stop() never relaunches the browser during shutdown', async () => {
      const { bridge, maxClient, telegramBot } = makeBridge();
      bridge.running = true;
      bridge.consecutivePollFailures = 3;

      // stop() flips running=false synchronously before its first await, so a
      // poll-failure tail landing right after must bail out immediately.
      const stopping = bridge.stop();
      const recovery = bridge.handlePollFailure(new Error('poll boom'));
      await Promise.all([stopping, recovery]);

      expect(maxClient.start).not.toHaveBeenCalled();
      expect(maxClient.captureDiagnostics).not.toHaveBeenCalled();
      // Exactly one stop: the shutdown one, not a recovery restart.
      expect(maxClient.stop).toHaveBeenCalledTimes(1);
      expect(telegramBot.sendText).not.toHaveBeenCalled();
    });
  });
});
