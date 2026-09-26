import { describe, it, expect, vi } from 'vitest';
import { makeBridge, makeFakeMaxClient } from '../helpers/bridgeHarness.js';

// /chats numbers MAX's chat list as it is shown; /select <number> has to pick
// from that same list (it used to index the database's own order), and a
// chat name may contain spaces.

const listed = [
  { id: 'Мария', title: 'Мария', metadata: {} },
  { id: 'Иван Петров', title: 'Иван Петров', metadata: {} },
  { id: 'Иван Работа', title: 'Иван Работа', metadata: {} }
];

const setup = () => {
  const harness = makeBridge({ maxClient: makeFakeMaxClient({ listChats: vi.fn(async () => listed) }) });
  // The database knows the chats in a different order than MAX shows them.
  for (const [index, chat] of [...listed].reverse().entries()) {
    harness.db.upsertChat({ ...chat, lastSeenAt: Date.now() + index * 1000 });
  }
  harness.bridge.ensureMapping = vi.fn(async () => null);
  return harness;
};

describe('/chats and /select', () => {
  it('selects by the number shown in /chats', async () => {
    const { bridge, db } = setup();
    const text = await bridge.formatChats();
    expect(text.split('\n')[1]).toContain('2. Иван Петров');

    await bridge.selectChat('2');

    expect(db.getSelectedChat().id).toBe('Иван Петров');
    expect((await bridge.formatChats()).split('\n')[1]).toMatch(/^\* 2\. Иван Петров/);
  });

  it('selects by a full name with spaces, or by a part that fits one chat only', async () => {
    const { bridge, db } = setup();
    await bridge.selectChat('иван петров');
    expect(db.getSelectedChat().id).toBe('Иван Петров');
    await bridge.selectChat('Мар');
    expect(db.getSelectedChat().id).toBe('Мария');
  });

  it('asks to be more precise when a part fits several chats', async () => {
    const { bridge, db } = setup();
    const reply = await bridge.selectChat('Иван');
    expect(reply).toContain('несколько чатов');
    expect(db.getSelectedChat()).toBeNull();
  });
});
