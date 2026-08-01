import { describe, it, expect, vi, afterEach } from 'vitest';
import { BridgeService } from '../../src/services/bridge.js';
import {
  makeBridge,
  makeTestConfig,
  makeFakeMaxClient,
  makeFakeTelegramBot,
  makeFakeMediaService,
  linkChat
} from '../helpers/bridgeHarness.js';

// QR sign-in coverage for BridgeService: ensureOwner (the /pair wait),
// ensureMaxLogin (session detection + the QR delivery loop), its interaction
// with pollMax and handlePollFailure, the /login command, and the owner/relay
// identity that is discovered at runtime and persisted in the settings table.
//
// Two invariants these tests are here to protect:
//   * The login QR is a CREDENTIAL — it may only ever reach the owner's
//     private chat (sendOwnerQr / sendOwnerText), never the relay group
//     (sendText / sendMessage / sendDocument).
//   * maxLock is NOT reentrant. ensureMaxLogin takes the lock per step, so it
//     must never be called from inside a maxLock section — the post-restart
//     path in handlePollFailure would deadlock the whole bridge forever. A
//     deadlock shows up here as a test that never resolves.
//
// The flow probes every 1.5s while the page settles and sleeps 4s between QR
// polls, waiting indefinitely until the code is scanned or the bridge stops, so
// every test that gets past the first probe drives it with vi.useFakeTimers() +
// advanceTimersByTimeAsync — no test ever waits real time.

// Mirrors the module-private constants in src/services/bridge.js.
const LOGIN_POLL_INTERVAL_MS = 4000;
const LOGIN_DETECT_SETTLE_MS = 45000;
const LOGIN_DETECT_CONFIRMATIONS = 3;
const LOGIN_DETECT_PROBE_INTERVAL_MS = 1500;
// Fake time the settle phase costs before the QR loop starts: the gaps between
// the confirmations (the last confirmation breaks out without sleeping).
const SETTLE_MS = (LOGIN_DETECT_CONFIRMATIONS - 1) * LOGIN_DETECT_PROBE_INTERVAL_MS;

const LOGIN_REQUIRED = 'login-required';
const RESTART_NOTICE = 'MAX Web was restarted after repeated polling failures.';
const QR_MESSAGE_ID = 9100; // what the harness' sendOwnerQr fake returns

// A freshly opened MAX page is only believed after LOGIN_DETECT_CONFIRMATIONS
// consecutive 'login-required' readings, so a state script has to answer
// 'login-required' that many times before the QR loop is even entered.
const SETTLE_LOGIN_REQUIRED = Array(LOGIN_DETECT_CONFIRMATIONS).fill(LOGIN_REQUIRED);

// Scripts getSessionState: the queued states in order, then `tail` forever.
function scriptSessionStates(maxClient, sequence, tail = 'ready') {
  const queue = [...sequence];
  maxClient.getSessionState.mockImplementation(async () => (queue.length ? queue.shift() : tail));
}

function makeQr(hash) {
  return { png: Buffer.from(`png-${hash}`), hash };
}

// Nothing about the QR may reach the relay group or any shared chat.
function expectNothingLeakedToTheGroup(telegramBot) {
  expect(telegramBot.sendText).not.toHaveBeenCalled();
  expect(telegramBot.sendMessage).not.toHaveBeenCalled();
  expect(telegramBot.sendDocument).not.toHaveBeenCalled();
  expect(telegramBot.sendPinnedText).not.toHaveBeenCalled();
}

describe('BridgeService QR sign-in', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('ensureMaxLogin session detection', () => {
    it('no-ops when the MAX session is already live', async () => {
      const { bridge, maxClient, telegramBot } = makeBridge();

      await expect(bridge.ensureMaxLogin({ reason: 'startup' })).resolves.toBe(true);

      // A single probe: the ready fast path must not pay for the settle wait.
      expect(maxClient.getSessionState).toHaveBeenCalledTimes(1);
      expect(maxClient.captureLoginQr).not.toHaveBeenCalled();
      expect(telegramBot.sendOwnerText).not.toHaveBeenCalled();
      expect(telegramBot.sendOwnerQr).not.toHaveBeenCalled();
      expect(telegramBot.deleteOwnerMessage).not.toHaveBeenCalled();
      expect(bridge.loginInProgress).toBe(false);
    });

    it('does not mail a QR for a transient sign-in reading on a still-painting page', async () => {
      vi.useFakeTimers();
      const { bridge, maxClient, telegramBot } = makeBridge();
      // Two "signed out" readings while MAX Web paints, then the chat list
      // appears — one short of the confirmations required to bother the owner.
      scriptSessionStates(maxClient, [LOGIN_REQUIRED, LOGIN_REQUIRED], 'ready');

      const flow = bridge.ensureMaxLogin({ reason: 'startup' });
      await vi.advanceTimersByTimeAsync(SETTLE_MS);
      await expect(flow).resolves.toBe(true);

      expect(maxClient.captureLoginQr).not.toHaveBeenCalled();
      expect(telegramBot.sendOwnerText).not.toHaveBeenCalled();
      expect(telegramBot.sendOwnerQr).not.toHaveBeenCalled();
      expect(bridge.loginInProgress).toBe(false);
    });

    it('sends nothing when the page never settles into a recognisable state', async () => {
      vi.useFakeTimers();
      const { bridge, maxClient, telegramBot } = makeBridge();
      // maxSessionState swallows the error and reports 'unknown'.
      maxClient.getSessionState.mockRejectedValue(new Error('page detached'));

      const flow = bridge.ensureMaxLogin({ reason: 'startup' });
      await vi.advanceTimersByTimeAsync(LOGIN_DETECT_SETTLE_MS + LOGIN_DETECT_PROBE_INTERVAL_MS);
      await expect(flow).resolves.toBe(false);

      expect(maxClient.captureLoginQr).not.toHaveBeenCalled();
      expect(telegramBot.sendOwnerText).not.toHaveBeenCalled();
      expect(telegramBot.sendOwnerQr).not.toHaveBeenCalled();
      expect(bridge.loginInProgress).toBe(false);
    });

    it('requires the sign-in readings to be CONSECUTIVE — a flapping page gets no QR', async () => {
      vi.useFakeTimers();
      const { bridge, maxClient, telegramBot } = makeBridge();
      // Alternating readings: the confirmation counter resets on every
      // non-'login-required' answer, so it can never reach the threshold.
      let flip = false;
      maxClient.getSessionState.mockImplementation(async () => {
        flip = !flip;
        return flip ? LOGIN_REQUIRED : 'unknown';
      });

      const flow = bridge.ensureMaxLogin({ reason: 'startup' });
      await vi.advanceTimersByTimeAsync(LOGIN_DETECT_SETTLE_MS + LOGIN_DETECT_PROBE_INTERVAL_MS);
      await expect(flow).resolves.toBe(false);

      // It really did keep probing — the flow is not just an early return.
      expect(maxClient.getSessionState.mock.calls.length)
        .toBeGreaterThan(LOGIN_DETECT_CONFIRMATIONS);
      expect(telegramBot.sendOwnerQr).not.toHaveBeenCalled();
      expect(telegramBot.sendOwnerText).not.toHaveBeenCalled();
    });
  });

  describe('ensureMaxLogin QR loop', () => {
    it('delivers the QR to the owner, then confirms and deletes it once the code is scanned', async () => {
      vi.useFakeTimers();
      const { bridge, maxClient, telegramBot } = makeBridge();
      // Signed out through the settle probes and the first loop pass; the phone
      // scans the code before the second pass.
      scriptSessionStates(maxClient, [...SETTLE_LOGIN_REQUIRED, LOGIN_REQUIRED], 'ready');
      const qr = makeQr('hash-1');
      maxClient.captureLoginQr.mockResolvedValue(qr);

      const flow = bridge.ensureMaxLogin({ reason: 'startup' });
      await vi.advanceTimersByTimeAsync(SETTLE_MS + LOGIN_POLL_INTERVAL_MS * 2);
      await expect(flow).resolves.toBe(true);

      // The QR went to the owner's private chat, as a first (not edited) message.
      expect(telegramBot.sendOwnerQr).toHaveBeenCalledTimes(1);
      const [png, existingMessageId] = telegramBot.sendOwnerQr.mock.calls[0];
      expect(png).toBe(qr.png);
      expect(existingMessageId).toBeNull();

      // The dead QR is removed, and only then is success announced.
      expect(telegramBot.deleteOwnerMessage).toHaveBeenCalledTimes(1);
      expect(telegramBot.deleteOwnerMessage).toHaveBeenCalledWith(QR_MESSAGE_ID);
      const ownerTexts = telegramBot.sendOwnerText.mock.calls.map((call) => call[0]);
      expect(ownerTexts).toHaveLength(2);
      expect(ownerTexts[0]).toContain('Нужен вход в MAX');
      expect(ownerTexts[1]).toContain('MAX подключён');
      expect(telegramBot.deleteOwnerMessage.mock.invocationCallOrder[0])
        .toBeLessThan(telegramBot.sendOwnerText.mock.invocationCallOrder[1]);

      expectNothingLeakedToTheGroup(telegramBot);
      expect(bridge.loginInProgress).toBe(false);
    });

    it('uploads a rotated code by editing the SAME message, and never re-uploads an unchanged one', async () => {
      vi.useFakeTimers();
      const { bridge, maxClient, telegramBot } = makeBridge();
      // Three loop passes on the sign-in screen, then scanned.
      scriptSessionStates(
        maxClient,
        [...SETTLE_LOGIN_REQUIRED, LOGIN_REQUIRED, LOGIN_REQUIRED, LOGIN_REQUIRED],
        'ready'
      );
      const first = makeQr('rot-1');
      const second = makeQr('rot-2');
      // pass 1: fresh code, pass 2: MAX has not rotated yet, pass 3: rotated.
      const captures = [first, first, second];
      maxClient.captureLoginQr.mockImplementation(async () => captures.shift() || second);

      const flow = bridge.ensureMaxLogin({ reason: 'startup' });
      await vi.advanceTimersByTimeAsync(SETTLE_MS + LOGIN_POLL_INTERVAL_MS * 4);
      await expect(flow).resolves.toBe(true);

      expect(maxClient.captureLoginQr).toHaveBeenCalledTimes(3);
      // The last delivered hash is handed down so the capture can skip its
      // screenshot + re-encode while the code has not rotated — the wait is
      // open-ended, so most passes are exactly that case.
      expect(maxClient.captureLoginQr.mock.calls[0][0]).toEqual({ knownHash: null });
      expect(maxClient.captureLoginQr.mock.calls[1][0]).toEqual({ knownHash: first.hash });
      expect(maxClient.captureLoginQr.mock.calls[2][0]).toEqual({ knownHash: first.hash });
      // The identical second capture must not produce a second upload.
      expect(telegramBot.sendOwnerQr).toHaveBeenCalledTimes(2);
      expect(telegramBot.sendOwnerQr.mock.calls[0]).toEqual([first.png, null]);
      // The rotated code edits the existing message in place instead of
      // stacking a second scannable-looking QR in the chat.
      expect(telegramBot.sendOwnerQr.mock.calls[1]).toEqual([second.png, QR_MESSAGE_ID]);
      expect(telegramBot.deleteOwnerMessage).toHaveBeenCalledWith(QR_MESSAGE_ID);
    });

    it('holds loginInProgress for the whole flow, and pollMax stands down while it is set', async () => {
      vi.useFakeTimers();
      const { bridge, db, maxClient, telegramBot } = makeBridge();
      linkChat(db, 'chat-a', { unread: true });
      bridge.lastChatRefreshAt = Date.now(); // skip the refreshChats detour in pollMax
      maxClient.getSessionState.mockResolvedValue(LOGIN_REQUIRED);
      maxClient.captureLoginQr.mockResolvedValue(makeQr('hash-1'));

      expect(bridge.loginInProgress).toBe(false);
      const flow = bridge.ensureMaxLogin({ reason: 'startup' });
      await vi.advanceTimersByTimeAsync(SETTLE_MS + LOGIN_POLL_INTERVAL_MS);
      expect(bridge.loginInProgress).toBe(true);

      // Polling a logged-out page only manufactures failures, so pollMax must
      // return before it even reaches the browser.
      await bridge.pollMax();
      expect(maxClient.readMessages).not.toHaveBeenCalled();

      // Control: the same poll with the flag cleared really does read the chat,
      // so the assertion above is about the flag and not about an empty setup.
      bridge.loginInProgress = false;
      await bridge.pollMax();
      expect(maxClient.readMessages).toHaveBeenCalledTimes(1);
      bridge.loginInProgress = true;

      // A shutdown mid-login exits the loop without nagging the owner.
      bridge.stopping = true;
      await vi.advanceTimersByTimeAsync(LOGIN_POLL_INTERVAL_MS);
      await expect(flow).resolves.toBe(false);
      expect(bridge.loginInProgress).toBe(false);
      const ownerTexts = telegramBot.sendOwnerText.mock.calls.map((call) => call[0]);
      expect(ownerTexts.some((text) => text.includes('/login'))).toBe(false);
    });

    it('keeps waiting instead of giving up, and takes the QR down on shutdown', async () => {
      // There is deliberately no deadline: until MAX is signed in the bridge
      // can do nothing anyway, and at startup a give-up used to crash the
      // process — killing the very bot that was telling the owner to run
      // /login. Only stop() ends the wait.
      vi.useFakeTimers();
      const { bridge, maxClient, telegramBot } = makeBridge();
      maxClient.getSessionState.mockResolvedValue(LOGIN_REQUIRED); // never scanned
      maxClient.captureLoginQr.mockResolvedValue(makeQr('hash-1'));

      const flow = bridge.ensureMaxLogin({ reason: 'startup' });
      await vi.advanceTimersByTimeAsync(SETTLE_MS + 20 * 60 * 1000);

      // Still going after 20 minutes, still holding the flag.
      expect(bridge.loginInProgress).toBe(true);
      // The hash never changed, so exactly one upload over the whole wait.
      expect(telegramBot.sendOwnerQr).toHaveBeenCalledTimes(1);

      bridge.stopping = true;
      await vi.advanceTimersByTimeAsync(LOGIN_POLL_INTERVAL_MS * 2);
      await expect(flow).resolves.toBe(false);

      // The QR goes away with us rather than staying scannable in the chat.
      expect(telegramBot.deleteOwnerMessage).toHaveBeenCalledWith(QR_MESSAGE_ID);
      expect(bridge.loginInProgress).toBe(false);
      expectNothingLeakedToTheGroup(telegramBot);
    });

    // Regression: loginInProgress used to be raised only AFTER the multi-second
    // detection phase, so every guard against re-entry (requestLogin's check,
    // handlePollFailure's early return, pollMax's stand-down) read a flag that
    // was still false. With polling firing every 650 ms, a single expiry
    // spawned several concurrent flows — several separate LIVE QR credentials
    // in the chat, each with its own message id, and the first one to finish
    // cleared the shared flag while the others were still driving the page.
    it('does not start a second sign-in flow while the first one is still settling', async () => {
      vi.useFakeTimers();
      const { bridge, maxClient, telegramBot } = makeBridge();
      maxClient.getSessionState.mockResolvedValue(LOGIN_REQUIRED);
      maxClient.captureLoginQr.mockResolvedValue(makeQr('hash-1'));

      const first = bridge.ensureMaxLogin({ reason: 'startup' });
      await vi.advanceTimersByTimeAsync(LOGIN_DETECT_PROBE_INTERVAL_MS);
      // A /login (or the next poll-failure recovery) landing mid-settle.
      const second = bridge.ensureMaxLogin({ reason: 'manual' });
      await expect(second).resolves.toBe(false);
      await vi.advanceTimersByTimeAsync(SETTLE_MS + LOGIN_POLL_INTERVAL_MS);

      expect(telegramBot.sendOwnerText).toHaveBeenCalledTimes(1);
      expect(telegramBot.sendOwnerQr).toHaveBeenCalledTimes(1);

      bridge.stopping = true;
      await vi.advanceTimersByTimeAsync(LOGIN_POLL_INTERVAL_MS * 2);
      await first;
    });

    it('clears loginInProgress even when the flow throws', async () => {
      vi.useFakeTimers();
      const { bridge } = makeBridge();
      // Only the `finally` can release the flag on an unexpected throw. If it
      // leaked, pollMax would stand down forever and the bridge would go
      // permanently silent while looking healthy.
      bridge.maxSessionState = () => { throw new Error('page probe blew up'); };

      const settled = bridge.ensureMaxLogin({ reason: 'startup' }).then(
        () => new Error('ensureMaxLogin resolved instead of rejecting'),
        (error) => error
      );
      await vi.advanceTimersByTimeAsync(SETTLE_MS);

      expect((await settled).message).toBe('page probe blew up');
      expect(bridge.loginInProgress).toBe(false);
    });

    it('keeps signing in when Telegram messaging fails, instead of aborting', async () => {
      // A transient Telegram error (or an owner who never opened a DM, which
      // makes every owner-directed send fail with 403) must not abort the
      // sign-in: that used to leave the bridge silently stuck with no QR and
      // nothing reported anywhere.
      vi.useFakeTimers();
      const { bridge, maxClient, telegramBot } = makeBridge();
      scriptSessionStates(maxClient, [...SETTLE_LOGIN_REQUIRED, LOGIN_REQUIRED], 'ready');
      maxClient.captureLoginQr.mockResolvedValue(makeQr('hash-1'));
      telegramBot.sendOwnerText.mockRejectedValue(new Error('403: bot can\'t initiate conversation with a user'));

      const flow = bridge.ensureMaxLogin({ reason: 'startup' });
      await vi.advanceTimersByTimeAsync(SETTLE_MS + LOGIN_POLL_INTERVAL_MS * 3);

      await expect(flow).resolves.toBe(true);
      // The owner cannot be DM'd, so the group is told once — text only, and
      // explicitly never the QR itself.
      expect(telegramBot.sendText).toHaveBeenCalledTimes(1);
      expect(telegramBot.sendText.mock.calls[0][0]).toContain('/login');
    });
  });

  describe('handlePollFailure', () => {
    it('a signed-out session starts the sign-in instead of restarting the browser', async () => {
      vi.useFakeTimers();
      const { bridge, maxClient, telegramBot } = makeBridge();
      bridge.running = true;
      bridge.consecutivePollFailures = 3; // already at maxPollFailuresBeforeRestart

      // 1 probe for handlePollFailure + the settle probes + 1 QR loop pass.
      scriptSessionStates(
        maxClient,
        [LOGIN_REQUIRED, ...SETTLE_LOGIN_REQUIRED, LOGIN_REQUIRED],
        'ready'
      );
      maxClient.captureLoginQr.mockResolvedValue(makeQr('hash-1'));

      const recovery = bridge.handlePollFailure(new Error('All 4 polled chats failed to read'));
      await vi.advanceTimersByTimeAsync(SETTLE_MS + LOGIN_POLL_INTERVAL_MS * 2);
      await recovery;

      // Relaunching Chromium cannot log an account back in — doing it anyway is
      // what used to produce an endless restart loop.
      expect(maxClient.stop).not.toHaveBeenCalled();
      expect(maxClient.start).not.toHaveBeenCalled();
      expect(maxClient.captureDiagnostics).not.toHaveBeenCalled();
      expect(telegramBot.sendText).not.toHaveBeenCalled(); // no «MAX Web was restarted…» spam
      // ...and the sign-in really ran.
      expect(telegramBot.sendOwnerQr).toHaveBeenCalledTimes(1);
      // Counter reset, so the next genuine failure starts from zero.
      expect(bridge.consecutivePollFailures).toBe(0);
    });

    it('a live session still restarts the browser and waits for ready (regression guard)', async () => {
      const { bridge, maxClient, telegramBot } = makeBridge(); // getSessionState: 'ready'
      bridge.running = true;
      bridge.consecutivePollFailures = 3;

      await bridge.handlePollFailure(new Error('poll boom'));

      expect(maxClient.captureDiagnostics).toHaveBeenCalledTimes(1);
      expect(maxClient.stop).toHaveBeenCalledTimes(1);
      expect(maxClient.start).toHaveBeenCalledTimes(1);
      expect(maxClient.waitForReady).toHaveBeenCalledTimes(1);
      expect(maxClient.start.mock.invocationCallOrder[0])
        .toBeLessThan(maxClient.waitForReady.mock.invocationCallOrder[0]);
      expect(telegramBot.sendText).toHaveBeenCalledWith(RESTART_NOTICE);
      expect(bridge.consecutivePollFailures).toBe(0);
      // A healthy session must not be bothered with a QR.
      expect(telegramBot.sendOwnerQr).not.toHaveBeenCalled();
      expect(maxClient.captureLoginQr).not.toHaveBeenCalled();
      // The post-restart ensureMaxLogin still probed the relaunched page.
      expect(maxClient.getSessionState).toHaveBeenCalledTimes(2);
    });

    it('a restart that comes back to the sign-in screen signs in and still waits for ready', async () => {
      vi.useFakeTimers();
      const { bridge, maxClient, telegramBot } = makeBridge();
      bridge.running = true;
      bridge.consecutivePollFailures = 3;
      // Session looks fine at failure time (so the restart path is taken), but
      // the relaunched browser comes up logged out.
      scriptSessionStates(maxClient, ['ready', ...SETTLE_LOGIN_REQUIRED, LOGIN_REQUIRED], 'ready');
      maxClient.captureLoginQr.mockResolvedValue(makeQr('hash-1'));

      const recovery = bridge.handlePollFailure(new Error('poll boom'));
      await vi.advanceTimersByTimeAsync(SETTLE_MS + LOGIN_POLL_INTERVAL_MS * 2);
      // Resolving at all is the assertion that matters most here: ensureMaxLogin
      // takes maxLock per step, so if it were called from inside the recovery's
      // lock section this await would hang forever (maxLock is not reentrant).
      await recovery;

      expect(maxClient.start).toHaveBeenCalledTimes(1);
      expect(telegramBot.sendText).toHaveBeenCalledWith(RESTART_NOTICE);
      expect(telegramBot.sendOwnerQr).toHaveBeenCalledTimes(1);
      expect(telegramBot.deleteOwnerMessage).toHaveBeenCalledWith(QR_MESSAGE_ID);
      // Ready is awaited AFTER the sign-in, so polling does not resume against
      // a page that is still on the login screen.
      expect(maxClient.waitForReady).toHaveBeenCalledTimes(1);
      expect(telegramBot.sendOwnerQr.mock.invocationCallOrder[0])
        .toBeLessThan(maxClient.waitForReady.mock.invocationCallOrder[0]);
    });

    it('does not recover at all while a sign-in is already in flight', async () => {
      const { bridge, maxClient, telegramBot } = makeBridge();
      bridge.running = true;
      bridge.consecutivePollFailures = 3;
      bridge.loginInProgress = true;

      await bridge.handlePollFailure(new Error('poll boom'));

      expect(maxClient.getSessionState).not.toHaveBeenCalled();
      expect(maxClient.captureDiagnostics).not.toHaveBeenCalled();
      expect(maxClient.stop).not.toHaveBeenCalled();
      expect(maxClient.start).not.toHaveBeenCalled();
      expect(telegramBot.sendText).not.toHaveBeenCalled();
    });
  });

  describe('requestLogin (/login)', () => {
    it('answers "already connected" without touching the QR machinery', async () => {
      const { bridge, maxClient, telegramBot } = makeBridge(); // getSessionState: 'ready'

      await expect(bridge.requestLogin())
        .resolves.toBe('MAX уже подключён. Если что-то не работает, попробуй /check.');

      expect(maxClient.captureLoginQr).not.toHaveBeenCalled();
      expect(telegramBot.sendOwnerText).not.toHaveBeenCalled();
      expect(telegramBot.sendOwnerQr).not.toHaveBeenCalled();
    });

    it('asks the running sign-in for a fresh QR instead of pointing at a message that may be gone', async () => {
      // The documented reason to send /login mid-sign-in is "I deleted the QR
      // message". Replying "already running" left the owner staring at a
      // message that no longer existed, and no new one was posted until MAX
      // rotated the code ~2 minutes later.
      const { bridge, maxClient, telegramBot } = makeBridge();
      bridge.loginInProgress = true;

      const answer = await bridge.requestLogin();

      expect(bridge.resendQr).toBe(true);
      // /login can be sent from the relay group, so the answer must point at
      // the private chat rather than claim the QR is "here".
      expect(answer).toContain('личные сообщения');
      // Answers from the flag alone — no page work, no duplicate flow.
      expect(maxClient.getSessionState).not.toHaveBeenCalled();
      expect(telegramBot.sendOwnerQr).not.toHaveBeenCalled();
    });

    it('the running flow re-posts the QR as a NEW message when asked', async () => {
      vi.useFakeTimers();
      const { bridge, maxClient, telegramBot } = makeBridge();
      // Never scanned: the flow keeps waiting, which is the situation in which
      // /login is actually used.
      scriptSessionStates(maxClient, SETTLE_LOGIN_REQUIRED, LOGIN_REQUIRED);
      // Same code throughout: without the resend flag the loop would send it
      // exactly once and never again.
      maxClient.captureLoginQr.mockImplementation(async ({ knownHash } = {}) => (
        knownHash === 'stable' ? { hash: 'stable', unchanged: true, png: null } : makeQr('stable')
      ));

      const flow = bridge.ensureMaxLogin({ reason: 'startup' });
      await vi.advanceTimersByTimeAsync(SETTLE_MS + LOGIN_POLL_INTERVAL_MS);
      expect(telegramBot.sendOwnerQr).toHaveBeenCalledTimes(1);

      await bridge.requestLogin(); // the owner deleted the message
      await vi.advanceTimersByTimeAsync(LOGIN_POLL_INTERVAL_MS * 2);

      expect(telegramBot.sendOwnerQr).toHaveBeenCalledTimes(2);
      // A NEW message, not an edit of the one that was deleted.
      expect(telegramBot.sendOwnerQr.mock.calls[1][1]).toBeNull();

      bridge.stopping = true;
      await vi.advanceTimersByTimeAsync(LOGIN_POLL_INTERVAL_MS * 2);
      await flow;
    });

    it('answers immediately and drives the QR flow in the background', async () => {
      vi.useFakeTimers();
      const { bridge, maxClient, telegramBot } = makeBridge();
      maxClient.getSessionState.mockResolvedValue(LOGIN_REQUIRED);
      maxClient.captureLoginQr.mockResolvedValue(makeQr('hash-1'));

      // The command handler must not be held for the (up to 15 minute) loop:
      // the answer has to settle on microtasks alone, with no timer advanced.
      const answer = await Promise.race([
        bridge.requestLogin(),
        (async () => {
          for (let i = 0; i < 200; i++) await Promise.resolve();
          return 'BLOCKED_ON_THE_LOGIN_LOOP';
        })()
      ]);
      expect(answer).toBe('Сейчас пришлю QR-код для входа в MAX.');

      // ...and the flow it kicked off really is running.
      await vi.advanceTimersByTimeAsync(SETTLE_MS + LOGIN_POLL_INTERVAL_MS);
      expect(bridge.loginInProgress).toBe(true);
      expect(telegramBot.sendOwnerQr).toHaveBeenCalledTimes(1);

      // Let the detached loop finish so it does not outlive the test.
      bridge.stopping = true;
      await vi.advanceTimersByTimeAsync(LOGIN_POLL_INTERVAL_MS);
      expect(bridge.loginInProgress).toBe(false);
    });
  });

  describe('ensureOwner', () => {
    it('returns the configured owner immediately and never starts pairing', async () => {
      const { bridge, telegramBot } = makeBridge();

      await expect(bridge.ensureOwner()).resolves.toBe(12345);
      expect(telegramBot.startPairing).not.toHaveBeenCalled();
    });

    it('blocks on a pairing code until /pair claims the bot', async () => {
      vi.useFakeTimers();
      const config = makeTestConfig({ telegram: { ownerId: null } });
      const { bridge, telegramBot } = makeBridge({ config });

      const pending = bridge.ensureOwner();
      await vi.advanceTimersByTimeAsync(2000);
      expect(telegramBot.startPairing).toHaveBeenCalledTimes(1);

      // What the /pair handler does in the adapter.
      bridge.config.telegram.ownerId = 4242;
      await vi.advanceTimersByTimeAsync(2000);
      await expect(pending).resolves.toBe(4242);
    });

    it('stops waiting for a pairing code when the bridge is shutting down', async () => {
      vi.useFakeTimers();
      const config = makeTestConfig({ telegram: { ownerId: null } });
      const { bridge } = makeBridge({ config });

      const pending = bridge.ensureOwner();
      bridge.stopping = true;
      await vi.advanceTimersByTimeAsync(2000);

      await expect(pending).resolves.toBeNull();
    });
  });

  describe('restoreIdentity / persistIdentity', () => {
    it('lets the configured ids win over anything stored in the database', () => {
      const { bridge, db, config } = makeBridge();
      db.setSetting('telegram_owner_id', '999');
      db.setSetting('telegram_relay_chat_id', '-100999');

      bridge.restoreIdentity();

      // An explicit deployment choice must not be silently overridden by a
      // past runtime discovery.
      expect(config.telegram.ownerId).toBe(12345);
      expect(config.telegram.relayChatId).toBe(-100500);
    });

    it('restores both ids from the settings table when the environment leaves them unset', () => {
      const config = makeTestConfig({ telegram: { ownerId: null, relayChatId: null } });
      const { bridge, db } = makeBridge({ config });
      db.setSetting('telegram_owner_id', '4242');
      db.setSetting('telegram_relay_chat_id', '-1001234567890');

      bridge.restoreIdentity();

      expect(config.telegram.ownerId).toBe(4242);
      expect(config.telegram.relayChatId).toBe(-1001234567890);
    });

    it('leaves the ids unset when the settings table is empty', () => {
      const config = makeTestConfig({ telegram: { ownerId: null, relayChatId: null } });
      const { bridge } = makeBridge({ config });

      bridge.restoreIdentity();

      expect(config.telegram.ownerId).toBeNull();
      expect(config.telegram.relayChatId).toBeNull();
    });

    it('persists both keys, and a fresh BridgeService over the same db picks them up', () => {
      const { bridge, db } = makeBridge();

      // The adapter reports the two discoveries separately (/pair, then the bot
      // being added to the relay group).
      bridge.persistIdentity({ ownerId: 555 });
      bridge.persistIdentity({ relayChatId: -100777 });

      expect(db.getSetting('telegram_owner_id')).toBe('555');
      expect(db.getSetting('telegram_relay_chat_id')).toBe('-100777');

      // A container restart: same database file, no environment ids.
      const restarted = new BridgeService({
        db,
        maxClient: makeFakeMaxClient(),
        telegramBot: makeFakeTelegramBot(),
        mediaService: makeFakeMediaService(),
        config: makeTestConfig({ telegram: { ownerId: null, relayChatId: null } })
      });
      restarted.restoreIdentity();

      expect(restarted.config.telegram.ownerId).toBe(555);
      expect(restarted.config.telegram.relayChatId).toBe(-100777);
    });

    it('writes nothing when a discovery carries neither id', () => {
      const { bridge, db } = makeBridge();

      bridge.persistIdentity({});
      bridge.persistIdentity();

      expect(db.getSetting('telegram_owner_id')).toBeNull();
      expect(db.getSetting('telegram_relay_chat_id')).toBeNull();
    });
  });
});
