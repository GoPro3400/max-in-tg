import { describe, it, expect, vi } from 'vitest';
import { MaxWebClient } from '../../src/adapters/maxWebClient.js';

// activeChatId is what readMessages/sendText trust to skip re-selecting a
// chat. If it ever names a chat that is not on screen, the bridge reads that
// chat's messages into the wrong Telegram topic and types replies into the
// wrong conversation. These drive the real selectChat/ensureActiveChat against
// a stubbed Puppeteer page whose header title we control.

const SELECTORS = {
  chatList: '.chat-list',
  chatItem: '.chat-item',
  activeChatTitle: '.active-title',
  messageItem: '.bubble'
};

function makeClient({ visibleChats, header }) {
  const client = new MaxWebClient(
    { userDataDir: '/tmp/x', selectors: SELECTORS, headless: true },
    { mediaDir: '/tmp/m' } // no diagnosticDir: captures are no-ops here
  );
  const state = { header };
  client.page = {
    url: () => 'https://web.max.ru/',
    $$eval: vi.fn(async () => visibleChats.map((chat, index) => ({ ...chat, metadata: { index } }))),
    evaluate: vi.fn(async (fn, arg, index) => {
      if (arg === SELECTORS.activeChatTitle) return state.header;
      if (arg === SELECTORS.chatItem) return index < visibleChats.length; // the in-page click
      return undefined;
    }),
    waitForFunction: vi.fn(async () => {}),
    waitForSelector: vi.fn(async () => null)
  };
  return { client, state };
}

describe('MaxWebClient chat switching', () => {
  it('a switch that fails verification leaves no chat marked active', async () => {
    const { client } = makeClient({
      visibleChats: [{ id: 'Alice', title: 'Alice' }, { id: 'Bob', title: 'Bob' }],
      header: 'Carol' // the click landed somewhere else
    });
    client.activeChatId = 'Alice';

    await expect(client.selectChat('Bob')).rejects.toThrow('Active Max chat mismatch');

    // Before the fix this stayed 'Alice', so the next readMessages('Alice')
    // skipped selection and scraped Carol's messages as Alice's.
    expect(client.activeChatId).toBeNull();
  });

  it('a successful switch remembers both the id and the title', async () => {
    const { client } = makeClient({
      visibleChats: [{ id: 'Alice', title: 'Alice' }, { id: 'Bob', title: 'Bob' }],
      header: 'Bob'
    });

    await client.selectChat('Bob');

    expect(client.activeChatId).toBe('Bob');
    expect(client.activeChatTitle).toBe('Bob');
  });

  it('refuses to send when the active chat scrolled out of the list and the header shows another chat', async () => {
    const { client } = makeClient({
      visibleChats: [{ id: 'Carol', title: 'Carol' }], // Alice is off-screen in the virtualized list
      header: 'Carol'
    });
    client.activeChatId = 'Alice';
    client.activeChatTitle = 'Alice';

    await expect(client.ensureActiveChat('Alice')).rejects.toThrow('Active Max chat mismatch');
  });

  it('accepts an off-screen active chat whose header still matches', async () => {
    const { client } = makeClient({ visibleChats: [{ id: 'Carol', title: 'Carol' }], header: 'Alice' });
    client.activeChatId = 'Alice';
    client.activeChatTitle = 'Alice';

    await expect(client.ensureActiveChat('Alice')).resolves.toBeUndefined();
  });
});
