import { describe, it, expect, vi, afterEach } from 'vitest';
import { MaxWebClient } from '../../src/adapters/maxWebClient.js';

// MAX does not keep issuing fresh sign-in codes: measured on the live page, a
// QR is drawn, and ~115s later MAX blurs it, swaps the caption to "QR code has
// expired" and grows a refresh button INSIDE the .qr box — then the page sits
// unchanged forever. So an unattended sign-in must press that button itself.
//
// Two properties matter here, and both protect the owner:
//   * a blurred, dead code must NEVER be delivered captioned "scan this";
//   * the client must recover on its own, or the sign-in stalls indefinitely.
//
// These drive the real methods against a stubbed Puppeteer page — the DOM
// shapes below are the ones observed on the live login screen.

function makeClient({ evaluate } = {}) {
  const client = new MaxWebClient(
    { userDataDir: '/tmp/x', selectors: { chatList: '.chat-list' }, headless: true },
    { diagnosticDir: '/tmp/d', mediaDir: '/tmp/m' }
  );
  client.page = {
    isClosed: () => false,
    evaluate: evaluate || vi.fn(async () => false)
  };
  return client;
}

describe('MAX login QR expiry', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('isLoginQrExpired', () => {
    it('reports the expired state the page actually shows', async () => {
      const client = makeClient({ evaluate: vi.fn(async () => true) });
      await expect(client.isLoginQrExpired()).resolves.toBe(true);
    });

    it('reports a live code as not expired', async () => {
      const client = makeClient({ evaluate: vi.fn(async () => false) });
      await expect(client.isLoginQrExpired()).resolves.toBe(false);
    });

    it('does not claim expiry when the page cannot be read', async () => {
      // A detached page must not be mistaken for an expired code: that would
      // start a pointless refresh-click loop against a dead frame.
      const client = makeClient({ evaluate: vi.fn(async () => { throw new Error('page detached'); }) });
      await expect(client.isLoginQrExpired()).resolves.toBe(false);
    });

    it('has no page yet', async () => {
      const client = makeClient();
      client.page = null;
      await expect(client.isLoginQrExpired()).resolves.toBe(false);
    });
  });

  describe('refreshLoginQr', () => {
    it('clicks refresh and resolves once the blur lifts', async () => {
      vi.useFakeTimers();
      // First evaluate = the click (returns true), then the expiry re-checks:
      // still blurred once, then clear.
      const evaluate = vi.fn()
        .mockResolvedValueOnce(true)   // click
        .mockResolvedValueOnce(true)   // still expired
        .mockResolvedValue(false);     // fresh code rendered
      const client = makeClient({ evaluate });

      const refreshing = client.refreshLoginQr();
      await vi.advanceTimersByTimeAsync(2000);

      await expect(refreshing).resolves.toBe(true);
    });

    it('gives up when no refresh control exists, without waiting', async () => {
      const evaluate = vi.fn().mockResolvedValue(false); // nothing clickable
      const client = makeClient({ evaluate });

      await expect(client.refreshLoginQr()).resolves.toBe(false);
      // Exactly one evaluate: the click attempt. No polling for an un-blur
      // that can never come.
      expect(evaluate).toHaveBeenCalledTimes(1);
    });

    it('gives up when the code stays blurred after clicking', async () => {
      vi.useFakeTimers();
      const evaluate = vi.fn()
        .mockResolvedValueOnce(true) // click landed
        .mockResolvedValue(true);    // ...but the code never refreshes
      const client = makeClient({ evaluate });

      const refreshing = client.refreshLoginQr();
      await vi.advanceTimersByTimeAsync(20 * 500 + 1000);

      await expect(refreshing).resolves.toBe(false);
    });
  });

  describe('captureLoginQr', () => {
    it('returns nothing rather than handing back a dead code it could not refresh', async () => {
      // The whole point: an expired QR that cannot be refreshed must produce
      // NO image, so the bridge has nothing to send. Delivering the blurred
      // placeholder would tell the owner to scan a code that cannot work.
      const evaluate = vi.fn()
        .mockResolvedValueOnce(true)   // isLoginQrExpired -> yes
        .mockResolvedValueOnce(false); // refresh: no control found
      const client = makeClient({ evaluate });
      // Would throw if the capture path were reached — it must not be.
      client.page.evaluateHandle = vi.fn(async () => { throw new Error('must not screenshot an expired code'); });

      await expect(client.captureLoginQr()).resolves.toBeNull();
      expect(client.page.evaluateHandle).not.toHaveBeenCalled();
    });
  });
});
