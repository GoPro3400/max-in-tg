import { describe, it, expect, vi } from 'vitest';
import { TelegramBotAdapter } from '../../src/adapters/telegramBot.js';

// Zero-config onboarding, adapter side. A fresh container knows only
// TELEGRAM_BOT_TOKEN: the owner claims the bot with `/pair <code>` and the
// relay group is picked up when the owner adds the bot to a forum supergroup.
// Until that happens the bot must be undriveable by whoever finds it, and the
// MAX login QR — a credential that binds a device to the user's MAX account —
// must only ever reach the owner's PRIVATE chat, never the shared relay group.

const OWNER_ID = 555;
const STRANGER_ID = 777;
const RELAY_ID = -1001234567890;
const OTHER_GROUP_ID = -1009876543210;

const makeAdapter = (overrides = {}) => {
  const adapter = new TelegramBotAdapter({
    token: 'test:token',
    ownerId: null,
    relayChatId: null,
    useTopics: true,
    autoCreateTopics: true,
    ...overrides
  }, {});

  // Skips Telegraf's lazy getMe() call, which would hit the network.
  adapter.bot.botInfo = { id: 1, is_bot: true, username: 'testbot', first_name: 'test' };

  const api = {
    sendMessage: vi.fn(async () => ({ message_id: 1 })),
    sendPhoto: vi.fn(async () => ({ message_id: 42 })),
    editMessageMedia: vi.fn(async () => true),
    deleteMessage: vi.fn(async () => true)
  };

  // Telegraf's handleUpdate builds a FRESH Telegram instance per update, so
  // stubbing bot.telegram alone still lets ctx.reply reach api.telegram.org.
  // bot.context is Object.assign-ed onto every ctx after construction, so it
  // overrides ctx.telegram; bot.telegram covers the adapter's own direct calls.
  adapter.bot.context.telegram = api;
  Object.assign(adapter.bot.telegram, api);

  const identities = [];
  adapter.onIdentityDiscovered(async (identity) => { identities.push(identity); });

  return { adapter, api, identities };
};

let updateId = 0;

// Composer.command() only fires on a real bot_command entity at offset 0 —
// a bare `text` never reaches the handler.
const commandUpdate = (text, { chatId, chatType = 'private', fromId }) => ({
  update_id: ++updateId,
  message: {
    message_id: 1000 + updateId,
    date: 1700000000,
    chat: { id: chatId, type: chatType },
    from: { id: fromId, is_bot: false, first_name: 'user' },
    text,
    entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0].length }]
  }
});

const membershipUpdate = ({
  chatId,
  chatType = 'supergroup',
  isForum = true,
  status = 'administrator',
  fromId = OWNER_ID,
  title = 'MAX relay'
}) => ({
  update_id: ++updateId,
  my_chat_member: {
    chat: { id: chatId, type: chatType, title, is_forum: isForum },
    from: { id: fromId, is_bot: false, first_name: 'user' },
    date: 1700000000,
    old_chat_member: { status: 'left', user: { id: 1, is_bot: true, first_name: 'test', username: 'testbot' } },
    new_chat_member: { status, user: { id: 1, is_bot: true, first_name: 'test', username: 'testbot' } }
  }
});

const chatIdsOf = (mock) => mock.mock.calls.map((call) => call[0]);

describe('/pair ownership claim', () => {
  it('startPairing() returns a stable, high-entropy code across calls', () => {
    const { adapter } = makeAdapter();
    const code = adapter.startPairing();
    // 8 random bytes in base64url. A short numeric code was brute-forceable:
    // bot usernames are globally searchable, an unclaimed instance accepts
    // /pair from anyone, and winning it hands over the MAX login QR.
    expect(code).toMatch(/^[A-Za-z0-9_-]{11}$/);
    expect(adapter.startPairing()).toBe(code);
    expect(adapter.startPairing()).toBe(code);
    // Two instances must not share a code.
    expect(makeAdapter().adapter.startPairing()).not.toBe(code);
  });

  it('locks out a user after repeated wrong attempts, without letting them lock out anyone else', async () => {
    // The code used to be ROTATED after 5 wrong attempts from anyone: a
    // stranger hammering /pair kept changing it faster than the operator
    // could copy it out of the logs. With 64 random bits guessing is hopeless
    // anyway, so only the guesser is slowed down.
    const { adapter, api } = makeAdapter();
    const code = adapter.startPairing();

    for (let attempt = 0; attempt < 5; attempt++) {
      await adapter.bot.handleUpdate(commandUpdate('/pair wrong-guess', { chatId: STRANGER_ID, fromId: STRANGER_ID }));
    }
    // Locked out: even the right code is not accepted from this account now.
    await adapter.bot.handleUpdate(commandUpdate(`/pair ${code}`, { chatId: STRANGER_ID, fromId: STRANGER_ID }));
    expect(adapter.config.ownerId).toBeNull();
    expect(adapter.pairingCode).toBe(code);

    // The real operator is unaffected.
    await adapter.bot.handleUpdate(commandUpdate(`/pair ${code}`, { chatId: OWNER_ID, fromId: OWNER_ID }));
    expect(adapter.config.ownerId).toBe(OWNER_ID);
    expect(api.sendMessage).toHaveBeenCalled();
  });

  it('adopts a group added before pairing only if the new owner added it', async () => {
    const { adapter, api } = makeAdapter();
    const code = adapter.startPairing();
    api.getChat = vi.fn(async (chatId) => ({ id: chatId, type: 'supergroup', is_forum: true, title: 'g' }));
    api.getChatMember = vi.fn(async () => ({ status: 'administrator' }));
    Object.assign(adapter.bot.telegram, { getChat: api.getChat, getChatMember: api.getChatMember });

    // The owner adds the bot to their group; a stranger then adds it to theirs.
    await adapter.bot.handleUpdate(membershipUpdate({ chatId: RELAY_ID, fromId: OWNER_ID }));
    await adapter.bot.handleUpdate(membershipUpdate({ chatId: OTHER_GROUP_ID, fromId: STRANGER_ID }));
    await adapter.bot.handleUpdate(commandUpdate(`/pair ${code}`, { chatId: OWNER_ID, fromId: OWNER_ID }));

    expect(adapter.config.relayChatId).toBe(RELAY_ID);
  });

  it('the right code binds the sender as owner and reports the identity', async () => {
    const { adapter, api, identities } = makeAdapter();
    const code = adapter.startPairing();

    await adapter.bot.handleUpdate(commandUpdate(`/pair ${code}`, { chatId: OWNER_ID, fromId: OWNER_ID }));

    expect(adapter.config.ownerId).toBe(OWNER_ID);
    expect(identities).toEqual([{ ownerId: OWNER_ID }]);
    // The code is single-use: it is cleared so a second claimant cannot replay it.
    expect(adapter.pairingCode).toBeNull();
    expect(api.sendMessage).toHaveBeenCalledWith(OWNER_ID, expect.stringContaining('владелец'), expect.anything());
  });

  it('a wrong code does not claim ownership', async () => {
    const { adapter, identities } = makeAdapter();
    const code = adapter.startPairing();
    const wrong = String((Number(code) + 1) % 1000000).padStart(6, '0');

    await adapter.bot.handleUpdate(commandUpdate(`/pair ${wrong}`, { chatId: STRANGER_ID, fromId: STRANGER_ID }));

    expect(adapter.config.ownerId).toBeNull();
    expect(identities).toEqual([]);
    // Still claimable by the real owner afterwards.
    expect(adapter.pairingCode).toBe(code);
  });

  it('a second /pair cannot re-bind an already claimed bridge', async () => {
    const { adapter, identities } = makeAdapter({ ownerId: OWNER_ID });
    adapter.startPairing();

    await adapter.bot.handleUpdate(commandUpdate('/pair 000000', { chatId: OWNER_ID, fromId: OWNER_ID }));

    expect(adapter.config.ownerId).toBe(OWNER_ID);
    expect(identities).toEqual([]);
  });
});

describe('isAllowedContext gate', () => {
  it('while unclaimed, everything except /pair in a private chat is blocked', async () => {
    const { adapter, api } = makeAdapter();
    adapter.startPairing();
    const onStatus = vi.fn(async () => 'status');
    adapter.onStatus(onStatus);

    // A command other than /pair, in a private chat.
    await adapter.bot.handleUpdate(commandUpdate('/status', { chatId: STRANGER_ID, fromId: STRANGER_ID }));
    expect(onStatus).not.toHaveBeenCalled();

    // /pair, but from a group — the pairing conversation is private-only.
    await adapter.bot.handleUpdate(
      commandUpdate(`/pair ${adapter.pairingCode}`, { chatId: OTHER_GROUP_ID, chatType: 'supergroup', fromId: OWNER_ID })
    );
    expect(adapter.config.ownerId).toBeNull();

    // Neither update produced any outbound traffic at all.
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it('once claimed, a different user is blocked', async () => {
    const { adapter, api } = makeAdapter({ ownerId: OWNER_ID });
    const onStatus = vi.fn(async () => 'status');
    adapter.onStatus(onStatus);

    await adapter.bot.handleUpdate(commandUpdate('/status', { chatId: STRANGER_ID, fromId: STRANGER_ID }));

    expect(onStatus).not.toHaveBeenCalled();
    expect(api.sendMessage).not.toHaveBeenCalled();

    // Sanity check that the same command from the owner does get through.
    await adapter.bot.handleUpdate(commandUpdate('/status', { chatId: OWNER_ID, fromId: OWNER_ID }));
    expect(onStatus).toHaveBeenCalledTimes(1);
  });

  it('without a relay group, the owner is only listened to in the private chat', async () => {
    // Regression: with no relay group the gate accepted the owner's updates
    // from ANY chat, so a message typed in an unrelated group the bot sits in
    // was delivered to whichever MAX chat /select pointed at.
    const { adapter } = makeAdapter({ ownerId: OWNER_ID });
    const outbound = vi.fn(async () => {});
    adapter.onMessage(outbound);
    const onStatus = vi.fn(async () => 'status');
    adapter.onStatus(onStatus);
    const groupText = {
      update_id: ++updateId,
      message: {
        message_id: 5000,
        date: 1700000000,
        chat: { id: OTHER_GROUP_ID, type: 'supergroup' },
        from: { id: OWNER_ID, is_bot: false, first_name: 'owner' },
        text: 'test 123'
      }
    };

    await adapter.bot.handleUpdate(groupText);
    await adapter.bot.handleUpdate(commandUpdate('/status', { chatId: OTHER_GROUP_ID, chatType: 'supergroup', fromId: OWNER_ID }));

    expect(outbound).not.toHaveBeenCalled();
    expect(onStatus).not.toHaveBeenCalled();

    await adapter.bot.handleUpdate(commandUpdate('/status', { chatId: OWNER_ID, fromId: OWNER_ID }));
    expect(onStatus).toHaveBeenCalledTimes(1);
  });

  it('without a relay group, the owner adding the bot to a group still reaches relay discovery', async () => {
    const { adapter } = makeAdapter({ ownerId: OWNER_ID });

    await adapter.bot.handleUpdate(membershipUpdate({ chatId: RELAY_ID }));

    expect(adapter.config.relayChatId).toBe(RELAY_ID);
  });
});

describe('my_chat_member relay discovery', () => {
  it('adopts a forum supergroup the owner made the bot an admin of', async () => {
    const { adapter, api, identities } = makeAdapter({ ownerId: OWNER_ID });

    await adapter.bot.handleUpdate(membershipUpdate({ chatId: RELAY_ID }));

    expect(adapter.config.relayChatId).toBe(RELAY_ID);
    expect(identities).toEqual([{ relayChatId: RELAY_ID }]);
    expect(api.sendMessage).toHaveBeenCalledWith(RELAY_ID, expect.stringContaining('подключена'));
  });

  it('refuses a supergroup without topics and says so', async () => {
    const { adapter, api, identities } = makeAdapter({ ownerId: OWNER_ID });

    await adapter.bot.handleUpdate(membershipUpdate({ chatId: RELAY_ID, isForum: false }));

    expect(adapter.config.relayChatId).toBeNull();
    expect(identities).toEqual([]);
    expect(api.sendMessage).toHaveBeenCalledWith(RELAY_ID, expect.stringContaining('Темы'));
  });

  it('refuses a forum supergroup where it is only a member, and asks for admin rights', async () => {
    const { adapter, api, identities } = makeAdapter({ ownerId: OWNER_ID });

    await adapter.bot.handleUpdate(membershipUpdate({ chatId: RELAY_ID, status: 'member' }));

    expect(adapter.config.relayChatId).toBeNull();
    expect(identities).toEqual([]);
    expect(api.sendMessage).toHaveBeenCalledWith(RELAY_ID, expect.stringContaining('администратора'));
  });

  it('ignores further groups once a relay chat is configured', async () => {
    const { adapter, identities } = makeAdapter({ ownerId: OWNER_ID, relayChatId: RELAY_ID });

    await adapter.bot.handleUpdate(membershipUpdate({ chatId: OTHER_GROUP_ID, title: 'Some other group' }));

    expect(adapter.config.relayChatId).toBe(RELAY_ID);
    expect(identities).toEqual([]);
  });
});

describe('owner-private-chat helpers', () => {
  it('sendOwnerQr sends the login QR to the owner, never to the relay group', async () => {
    const { adapter, api } = makeAdapter({ ownerId: OWNER_ID, relayChatId: RELAY_ID });

    const messageId = await adapter.sendOwnerQr(Buffer.from('fake-png'));

    expect(api.sendPhoto).toHaveBeenCalledTimes(1);
    expect(api.sendPhoto.mock.calls[0][0]).toBe(OWNER_ID);
    expect(messageId).toBe(42);
    // The QR is a credential: no chat other than the owner's may see it.
    expect(chatIdsOf(api.sendPhoto)).not.toContain(RELAY_ID);
    expect(chatIdsOf(api.sendMessage)).not.toContain(RELAY_ID);
    expect(api.editMessageMedia).not.toHaveBeenCalled();
  });

  it('sendOwnerQr edits the existing message in place when given its id', async () => {
    const { adapter, api } = makeAdapter({ ownerId: OWNER_ID, relayChatId: RELAY_ID });

    const messageId = await adapter.sendOwnerQr(Buffer.from('rotated-png'), 11);

    expect(messageId).toBe(11);
    expect(api.editMessageMedia).toHaveBeenCalledTimes(1);
    expect(api.editMessageMedia.mock.calls[0][0]).toBe(OWNER_ID);
    expect(api.editMessageMedia.mock.calls[0][1]).toBe(11);
    expect(api.sendPhoto).not.toHaveBeenCalled();
  });

  it('sendOwnerQr falls back to a fresh photo when the edit is rejected', async () => {
    const { adapter, api } = makeAdapter({ ownerId: OWNER_ID, relayChatId: RELAY_ID });
    api.editMessageMedia.mockRejectedValueOnce(new Error('400: message to edit not found'));

    const messageId = await adapter.sendOwnerQr(Buffer.from('rotated-png'), 11);

    expect(messageId).toBe(42);
    expect(api.sendPhoto).toHaveBeenCalledTimes(1);
    expect(api.sendPhoto.mock.calls[0][0]).toBe(OWNER_ID);
  });

  it('sendOwnerText and deleteOwnerMessage no-op while there is no owner', async () => {
    const { adapter, api } = makeAdapter({ relayChatId: RELAY_ID });

    expect(await adapter.sendOwnerText('anything')).toBeNull();
    expect(await adapter.deleteOwnerMessage(11)).toBe(false);
    expect(await adapter.sendOwnerQr(Buffer.from('png'))).toBeNull();

    // Crucially it does not silently fall back to the relay group.
    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(api.sendPhoto).not.toHaveBeenCalled();
    expect(api.deleteMessage).not.toHaveBeenCalled();
  });

  it('sendOwnerText targets the owner and deleteOwnerMessage survives an already-gone message', async () => {
    const { adapter, api } = makeAdapter({ ownerId: OWNER_ID, relayChatId: RELAY_ID });

    await adapter.sendOwnerText('QR больше не нужен');
    expect(api.sendMessage).toHaveBeenCalledWith(OWNER_ID, 'QR больше не нужен');

    expect(await adapter.deleteOwnerMessage(11)).toBe(true);
    expect(api.deleteMessage).toHaveBeenCalledWith(OWNER_ID, 11);

    expect(await adapter.deleteOwnerMessage(null)).toBe(false);

    api.deleteMessage.mockRejectedValueOnce(new Error('400: message to delete not found'));
    expect(await adapter.deleteOwnerMessage(12)).toBe(false);
  });
});

describe('losing the relay group', () => {
  it('reports removal from the relay group even when another admin did it', async () => {
    const { adapter } = makeAdapter({ ownerId: OWNER_ID, relayChatId: RELAY_ID });
    const lost = vi.fn();
    adapter.onRelayLost(lost);

    await adapter.bot.handleUpdate(membershipUpdate({ chatId: RELAY_ID, status: 'kicked', fromId: STRANGER_ID }));

    expect(lost).toHaveBeenCalledWith(RELAY_ID, 'kicked');
  });

  it('a stranger changing the bot in some other group still gets nowhere', async () => {
    const { adapter, identities } = makeAdapter({ ownerId: OWNER_ID, relayChatId: RELAY_ID });
    const lost = vi.fn();
    adapter.onRelayLost(lost);

    await adapter.bot.handleUpdate(membershipUpdate({ chatId: OTHER_GROUP_ID, status: 'kicked', fromId: STRANGER_ID }));
    await adapter.bot.handleUpdate(membershipUpdate({ chatId: RELAY_ID, status: 'administrator', fromId: STRANGER_ID }));

    expect(lost).not.toHaveBeenCalled();
    expect(adapter.config.relayChatId).toBe(RELAY_ID);
    expect(identities).toEqual([]);
  });
});

describe('outbound message order', () => {
  const messageUpdate = (message) => ({
    update_id: ++updateId,
    message: {
      message_id: 2000 + updateId,
      date: 1700000000,
      chat: { id: OWNER_ID, type: 'private' },
      from: { id: OWNER_ID, is_bot: false, first_name: 'owner' },
      ...message
    }
  });

  it('delivers in the order sent even when an earlier photo is still downloading', async () => {
    // Telegraf runs a whole getUpdates batch concurrently; the photo waits for
    // its download, the text does not — it used to reach MAX first.
    const { adapter } = makeAdapter({ ownerId: OWNER_ID });
    adapter.mediaService = {
      telegramFileToLocal: vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return '/tmp/photo.jpg';
      })
    };
    const delivered = [];
    adapter.onMessage(async (message) => { delivered.push(message.type); });

    await Promise.all([
      adapter.bot.handleUpdate(messageUpdate({ photo: [{ file_id: 'p1', width: 1, height: 1 }] })),
      adapter.bot.handleUpdate(messageUpdate({ text: 'what do you think?' }))
    ]);

    expect(delivered).toEqual(['photo', 'text']);
  });

  it('forwards audio files, and tells the owner about types MAX cannot take', async () => {
    const { adapter, api } = makeAdapter({ ownerId: OWNER_ID });
    adapter.mediaService = { telegramFileToLocal: vi.fn(async (ctx, fileId, name) => `/tmp/${name}`) };
    const delivered = [];
    adapter.onMessage(async (message) => { delivered.push(message); });

    await adapter.bot.handleUpdate(messageUpdate({ audio: { file_id: 'a1', duration: 3, file_name: 'song.mp3' }, caption: 'listen' }));
    await adapter.bot.handleUpdate(messageUpdate({ location: { latitude: 1, longitude: 2 } }));

    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ type: 'document', text: 'listen', mediaPath: '/tmp/song.mp3' });
    expect(api.sendMessage).toHaveBeenCalledWith(OWNER_ID, expect.stringContaining('не пересылается'), expect.anything());
  });

  it('sends the static preview of an animated sticker, or its emoji', async () => {
    const { adapter } = makeAdapter({ ownerId: OWNER_ID });
    adapter.mediaService = { telegramFileToLocal: vi.fn(async (ctx, fileId) => `/tmp/${fileId}`) };
    const delivered = [];
    adapter.onMessage(async (message) => { delivered.push(message); });

    await adapter.bot.handleUpdate(messageUpdate({ sticker: { file_id: 'tgs', is_animated: true, thumbnail: { file_id: 'thumb' }, emoji: '😀' } }));
    await adapter.bot.handleUpdate(messageUpdate({ sticker: { file_id: 'webm', is_video: true, emoji: '🔥' } }));

    expect(delivered[0]).toMatchObject({ type: 'sticker', mediaPath: '/tmp/thumb' });
    expect(delivered[1]).toMatchObject({ type: 'text', text: '🔥' });
  });
});
