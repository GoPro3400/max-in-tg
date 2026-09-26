import { describe, it, expect, vi } from 'vitest';
import { MaxWebClient } from '../../src/adapters/maxWebClient.js';

// Puppeteer's keyboard.type turns "\n" into an Enter keypress, and Enter sends
// the message in MAX's composer: a multi-line Telegram message used to arrive
// in MAX as one message per line. These pin how text reaches the composer.

function makeClient() {
  const client = new MaxWebClient(
    { userDataDir: '/tmp/x', selectors: { messageItem: '.bubble' }, headless: true },
    { mediaDir: '/tmp/m' }
  );
  const events = [];
  client.page = {
    keyboard: {
      type: vi.fn(async (text) => { events.push(['type', text]); }),
      down: vi.fn(async (key) => { events.push(['down', key]); }),
      up: vi.fn(async (key) => { events.push(['up', key]); }),
      press: vi.fn(async (key) => { events.push(['press', key]); })
    }
  };
  return { client, events };
}

describe('MaxWebClient.typeIntoComposer', () => {
  it('turns line breaks into Shift+Enter and never types a raw newline', async () => {
    const { client, events } = makeClient();

    await client.typeIntoComposer('Line1\nLine2\r\nLine3');

    expect(events).toEqual([
      ['type', 'Line1'],
      ['down', 'Shift'], ['press', 'Enter'], ['up', 'Shift'],
      ['type', 'Line2'],
      ['down', 'Shift'], ['press', 'Enter'], ['up', 'Shift'],
      ['type', 'Line3']
    ]);
    for (const [kind, value] of events) {
      if (kind === 'type') expect(value).not.toMatch(/[\r\n]/);
    }
  });

  it('keeps empty lines and replaces tabs, which would move focus out of the composer', async () => {
    const { client, events } = makeClient();

    await client.typeIntoComposer('a\n\n\tb');

    expect(events.filter(([kind]) => kind === 'press')).toHaveLength(2);
    expect(events.filter(([kind]) => kind === 'type').map(([, text]) => text)).toEqual(['a', '    b']);
  });

  it('types long text in chunks without splitting a surrogate pair', async () => {
    const { client, events } = makeClient();
    const text = '😀'.repeat(5) + 'x'.repeat(7);

    await client.typeIntoComposer(text, { chunkSize: 4 });

    const typed = events.map(([, value]) => value);
    expect(typed.join('')).toBe(text);
    expect(typed).toHaveLength(3);
  });

  it('stops typing once the deadline has passed', async () => {
    const { client } = makeClient();
    client.page.keyboard.type.mockImplementation(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });

    await expect(client.typeIntoComposer('x'.repeat(50), { timeoutMs: 10, chunkSize: 5 })).rejects.toThrow('Typing timeout');
    expect(client.page.keyboard.type.mock.calls.length).toBeLessThan(10);
  });
});

describe('MaxWebClient.getLastOutgoingFingerprint', () => {
  it('matches a multi-line message whose bubble text lost its line breaks', async () => {
    const { client } = makeClient();
    client.activeChatId = 'chat-a';
    client.scrapeMessageRows = vi.fn(async () => [
      { rawId: 'older', text: 'previous', outgoing: true },
      { rawId: 'fp-new', text: 'Line1Line2', outgoing: true }
    ]);

    await expect(client.getLastOutgoingFingerprint('chat-a', 'Line1\nLine2')).resolves.toBe('fp-new');
  });

  it('never matches an empty text against a media bubble', async () => {
    const { client } = makeClient();
    client.activeChatId = 'chat-a';
    client.scrapeMessageRows = vi.fn(async () => [{ rawId: 'photo', text: '', outgoing: true }]);

    await expect(client.getLastOutgoingFingerprint('chat-a', '   ')).resolves.toBeNull();
    expect(client.scrapeMessageRows).not.toHaveBeenCalled();
  });
});
