import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Telegraf } from 'telegraf';
import { Direction, MessageType, stableId } from '../domain/messages.js';
import { logger } from '../logger.js';
import { documentDisplayName } from '../utils/fileHelpers.js';

export class TelegramBotAdapter {
  constructor(telegramConfig, mediaService) {
    this.config = telegramConfig;
    this.mediaService = mediaService;
    this.bot = new Telegraf(telegramConfig.token);
    this.onOutboundMessage = null;
    this.onChatListRequested = null;
    this.onChatSelectRequested = null;
    this.onHistoryRequested = null;
    this.onStatusRequested = null;
    this.onSyncRequested = null;
    this.onCheckRequested = null;
    this.onDiagnosticsRequested = null;
    this.onDeliveriesRequested = null;
    this.onMergeRequested = null;
    this.onUnmergeRequested = null;
    this.onMuteRequested = null;
    this.onUnmuteRequested = null;
    this.onLoginRequested = null;
    this.onIdentityDiscoveredHandler = null;
    this.onRelayLostHandler = null;
    this.onReactionHandler = null;
    // Set by startPairing() when no owner is configured (see /pair).
    this.pairingCode = null;
    // Wrong /pair attempts per Telegram user (see /pair).
    this.pairingFailures = new Map();
    // Groups the bot was added to before anyone claimed it, keyed by the user
    // who added it (see /pair).
    this.pendingRelayChats = new Map();
    this.launchPromise = null;
    // Keeps outbound Telegram messages in the order they were sent (see the
    // 'message' handler).
    this.outboundQueue = Promise.resolve();
    // Reactions mirrored into MAX, in the order they were made (see the
    // 'message_reaction' handler).
    this.reactionQueue = Promise.resolve();
    this.installHandlers();
  }

  // Publishes the command list so Telegram's "/" menu autocompletes. Without
  // it the menu is empty and a user who reads the docs, types "/" and sees
  // nothing concludes the commands are unsupported.
  async publishCommandMenu() {
    const commands = [
      { command: 'status', description: 'Состояние моста' },
      { command: 'chats', description: 'Список чатов MAX и маршрутов' },
      { command: 'new', description: 'Начать чат в MAX: /new <имя или номер>' },
      { command: 'login', description: 'Прислать QR для входа в MAX' },
      { command: 'relay', description: 'Сделать эту группу местом для чатов MAX' },
      { command: 'sync', description: 'Обновить чаты и темы' },
      { command: 'select', description: 'Чат для личных сообщений (без группы): /select <номер>' },
      { command: 'history', description: 'Последние сообщения этой темы' },
      { command: 'mute', description: 'Не пересылать чат: /mute <название>' },
      { command: 'unmute', description: 'Вернуть пересылку: /unmute <название>' },
      { command: 'merge', description: 'Объединить дублированный чат в эту тему' },
      { command: 'unmerge', description: 'Отменить объединение' },
      { command: 'check', description: 'Проверить MAX Web' },
      { command: 'diagnostics', description: 'Прислать диагностические файлы' },
      { command: 'deliveries', description: 'Статистика доставки' }
    ];
    try {
      await this.bot.telegram.setMyCommands(commands);
    } catch (error) {
      logger.warn({ err: error?.message || String(error) }, 'Could not publish the command menu');
    }
  }

  start() {
    return new Promise((resolve, reject) => {
      let launched = false;
      // allowed_updates must be spelled out: Telegram never sends
      // message_reaction (the owner reacting to a message) unless asked to.
      this.launchPromise = this.bot.launch({ allowedUpdates: ALLOWED_UPDATES }, () => {
        launched = true;
        logger.info({ username: this.bot.botInfo?.username }, 'Telegram bot polling started');
        this.publishCommandMenu();
        resolve();
      }).catch((error) => {
        logger.error({ err: error }, 'Telegram bot polling failed');
        if (!launched) {
          reject(error);
          return;
        }
        // Polling died after launch (409: the same token polled elsewhere,
        // 401: token revoked). Nothing restarts it, and the process stayed
        // up looking healthy while every command and message from Telegram
        // was ignored. Hand it to the supervisor instead (index.js exits).
        this.onFatalHandler?.(error);
      });
    });
  }

  onFatal(handler) {
    this.onFatalHandler = handler;
  }

  stop(signal = 'SIGTERM') {
    try {
      this.bot.stop(signal);
    } catch (error) {
      if (error?.message !== 'Bot is not running!') throw error;
    }
  }

  targetChatId() {
    return this.config.relayChatId || this.config.ownerId;
  }

  onMessage(handler) {
    this.onOutboundMessage = handler;
  }

  onChats(handler) {
    this.onChatListRequested = handler;
  }

  onSelectChat(handler) {
    this.onChatSelectRequested = handler;
  }

  onHistory(handler) {
    this.onHistoryRequested = handler;
  }

  onStatus(handler) {
    this.onStatusRequested = handler;
  }

  onSync(handler) {
    this.onSyncRequested = handler;
  }

  onCheck(handler) {
    this.onCheckRequested = handler;
  }

  onDiagnostics(handler) {
    this.onDiagnosticsRequested = handler;
  }

  onDeliveries(handler) {
    this.onDeliveriesRequested = handler;
  }

  onMerge(handler) {
    this.onMergeRequested = handler;
  }

  onUnmerge(handler) {
    this.onUnmergeRequested = handler;
  }

  onMute(handler) {
    this.onMuteRequested = handler;
  }

  // /new <query>: returns { text, choices: [{ label, data }] }.
  onNewChat(handler) {
    this.onNewChatRequested = handler;
  }

  // A button under /new's answer: (sessionId, choice) → text.
  onNewChatChoice(handler) {
    this.onNewChatChosen = handler;
  }

  onUnmute(handler) {
    this.onUnmuteRequested = handler;
  }

  onLogin(handler) {
    this.onLoginRequested = handler;
  }

  // Called when an owner or a relay group is discovered at runtime, so the
  // bridge can persist it (the adapter has no database of its own).
  onIdentityDiscovered(handler) {
    this.onIdentityDiscoveredHandler = handler;
  }

  // Called when the bot is removed from the relay group.
  onRelayLost(handler) {
    this.onRelayLostHandler = handler;
  }

  // Called when the owner changes their reaction on a message.
  onReaction(handler) {
    this.onReactionHandler = handler;
  }

  // "typing…" (or "recording a voice message"…) in a chat's topic; Telegram
  // shows it for about 5 seconds.
  async sendChatAction(route, action = 'typing') {
    await this.bot.telegram.sendChatAction(route.telegramChatId, action, threadExtra(route));
  }

  // Sets the bot's reaction on a message (null clears it). Only emoji from
  // Telegram's fixed list are accepted — see domain/reactions.js.
  async setReaction(chatId, messageId, emoji) {
    await this.bot.telegram.setMessageReaction(chatId, messageId, emoji ? [{ type: 'emoji', emoji }] : []);
  }

  // Zero-config ownership: with TELEGRAM_OWNER_ID unset the bot accepts a
  // single `/pair <code>` from anyone who can read the container logs, and
  // binds that user as the owner. The code is what keeps a stranger who merely
  // guessed the bot's @username from claiming it.
  // A bot's @username is globally searchable, so anyone who knows this project
  // was deployed can find an unclaimed instance and start guessing. Six digits
  // is ~900k combinations — hours of brute force at Telegram's own rate limit,
  // and winning it means the attacker is handed the MAX login QR. Hence a
  // 64-bit code plus a cap on wrong attempts per user.
  startPairing() {
    if (!this.pairingCode) {
      this.pairingCode = crypto.randomBytes(8).toString('base64url');
      this.pairingFailures.clear();
    }
    return this.pairingCode;
  }

  // The QR and pairing conversation always happen in the owner's PRIVATE chat:
  // the relay group can have other members, and a MAX login QR is a credential.
  ownerChatId() {
    return this.config.ownerId;
  }

  async sendOwnerText(text) {
    const chatId = this.ownerChatId();
    if (!chatId) return null;
    return await this.bot.telegram.sendMessage(chatId, text);
  }

  // Sends the MAX login QR to the owner, or replaces the photo of the message
  // already sent — MAX rotates the code every ~2 minutes, and editing keeps the
  // chat from filling up with dead QR codes that still look scannable.
  async sendOwnerQr(pngBuffer, existingMessageId = null) {
    const chatId = this.ownerChatId();
    if (!chatId) return null;
    const caption = 'QR для входа в MAX — отсканируй в приложении: Настройки → Устройства → Подключить устройство.';

    if (existingMessageId) {
      try {
        await this.bot.telegram.editMessageMedia(
          chatId,
          existingMessageId,
          undefined,
          { type: 'photo', media: { source: pngBuffer }, caption },
          {}
        );
        return existingMessageId;
      } catch (error) {
        // The message may have been deleted by the owner, or Telegram may
        // reject the edit; fall through and send a fresh one. Remove the stale
        // one first — a dead QR that still looks scannable is worse than none.
        logger.warn({ err: error, messageId: existingMessageId }, 'Failed to update login QR message, sending a new one');
        await this.deleteOwnerMessage(existingMessageId).catch(() => null);
      }
    }

    const sent = await this.bot.telegram.sendPhoto(chatId, { source: pngBuffer }, { caption });
    return sent.message_id;
  }

  // Adopts a group the bot was put into before it had an owner. Verified, not
  // assumed: the freshly paired owner must themselves be a member of that
  // group, otherwise anyone could add this bot to a group they control and
  // wait for the real owner to pair.
  //
  // And only a group the new owner added the bot to themselves: membership
  // alone proves little, since by default anyone can add a user to a group.
  // With a single "last group seen" slot, a stranger who found the unclaimed
  // bot could add it to their own forum group (and the owner to that group),
  // overwrite the owner's candidate, and have every private conversation
  // relayed to them once the owner paired.
  async adoptPendingRelayGroup(ctx) {
    const chatId = this.pendingRelayChats.get(this.config.ownerId);
    this.pendingRelayChats.clear();
    if (!chatId || this.config.relayChatId || !this.config.ownerId) return false;

    const chat = await this.bot.telegram.getChat(chatId);
    if (chat.type !== 'supergroup' || !chat.is_forum) {
      await ctx.reply('Кстати: я уже состою в группе, но в ней не включены Темы (Topics). Включи их и отправь в той группе /relay — добавлять меня заново не нужно.');
      return false;
    }
    const member = await this.bot.telegram.getChatMember(chatId, this.config.ownerId);
    if (!['creator', 'administrator', 'member'].includes(member.status)) {
      logger.warn({ chatId, ownerId: this.config.ownerId, status: member.status }, 'Refusing to adopt a relay group the owner is not in');
      return false;
    }
    const me = await this.bot.telegram.getChatMember(chatId, this.bot.botInfo?.id ?? (await this.bot.telegram.getMe()).id);
    if (me.status !== 'administrator') {
      await ctx.reply(`Кстати: я уже в группе «${chat.title}», но без прав администратора. Выдай их — и я подключу её.`);
      return false;
    }

    this.config.relayChatId = chatId;
    await this.onIdentityDiscoveredHandler?.({ relayChatId: chatId });
    logger.info({ relayChatId: chatId, title: chat.title }, 'Adopted the relay group the bot was added to before pairing');
    await ctx.reply(`✅ Группа «${chat.title}» подключена как релей — чаты MAX появятся там отдельными темами.`);
    return true;
  }

  async deleteOwnerMessage(messageId) {
    const chatId = this.ownerChatId();
    if (!chatId || !messageId) return false;
    try {
      await this.bot.telegram.deleteMessage(chatId, messageId);
      return true;
    } catch (error) {
      logger.debug({ err: error, messageId }, 'Could not delete message (already gone?)');
      return false;
    }
  }

  async createTopic(title) {
    if (!this.config.relayChatId || !this.config.useTopics) return null;
    const topic = await this.bot.telegram.createForumTopic(this.config.relayChatId, sanitizeTopicTitle(title));
    return topic.message_thread_id;
  }

  // Renames an existing forum topic (used to prefix muted chats with 🔇 so
  // their state is visible right in Telegram's topic list, not only in /chats).
  async renameTopic(threadId, title) {
    if (!this.config.relayChatId || !this.config.useTopics || !threadId) return false;
    await this.bot.telegram.editForumTopic(this.config.relayChatId, threadId, {
      name: sanitizeTopicTitle(title)
    });
    return true;
  }

  async sendText(text, route = {}) {
    await this.bot.telegram.sendMessage(
      route.telegramChatId || this.targetChatId(),
      text,
      threadExtra(route)
    );
  }

  // Tells the owner that one of their messages did not reach MAX: a reply to
  // it, with a button that sends it again (see the RETRY_ACTION handler).
  async sendRetryNotice(text, route = {}, replyToMessageId = null) {
    return this.bot.telegram.sendMessage(route.telegramChatId || this.targetChatId(), text, {
      ...threadExtra(route),
      ...replyParameters(replyToMessageId),
      reply_markup: { inline_keyboard: [[{ text: '🔁 Повторить', callback_data: RETRY_ACTION }]] }
    });
  }

  async sendPinnedText(text, route = {}) {
    const chatId = route.telegramChatId || this.targetChatId();
    const sent = await this.bot.telegram.sendMessage(chatId, text, threadExtra(route));
    try {
      await this.bot.telegram.pinChatMessage(chatId, sent.message_id, { disable_notification: true });
      return { ...sent, pinned: true };
    } catch (error) {
      logger.warn({ err: error, chatId, messageId: sent.message_id }, 'Failed to pin Telegram message');
      return { ...sent, pinned: false, pinError: error?.message || String(error) };
    }
  }

  async sendMessage(message, route = {}) {
    const chatId = route.telegramChatId || this.targetChatId();
    const replyExtra = replyParameters(message.replyToMessageId);

    // In a group chat, the sender's name in bold on top — as Telegram shows
    // it in its own groups. An entity rather than HTML: nothing to escape.
    const sender = String(message.sender || '').trim();
    const withSender = (text) => (sender ? (text ? `${sender}\n${text}` : sender) : text);
    const senderEntities = sender ? [{ type: 'bold', offset: 0, length: sender.length }] : undefined;

    if (message.type === MessageType.TEXT) {
      return await this.sendTextChunks(chatId, withSender(message.text || ''), route, replyExtra, senderEntities);
    }

    const filePath = message.mediaPath;
    if (!filePath) {
      return await this.sendTextChunks(chatId, withSender(message.text || `[${message.type}] ${message.mediaUrl || ''}`), route, replyExtra, senderEntities);
    }

    // Telegram takes at most 50 MB from a bot. A bigger upload failed on every
    // retry until the message was given up on; say what it was right away.
    const size = await fsp.stat(filePath).then((stat) => stat.size, () => 0);
    if (size > TELEGRAM_UPLOAD_LIMIT_BYTES) {
      const name = documentDisplayName(message.originalFilename, filePath) || path.basename(filePath);
      const notice = `📎 «${name}» — ${formatMb(size)}: больше 50 МБ, столько бот в Telegram отправить не может. Файл можно открыть в MAX.`;
      return await this.sendTextChunks(chatId, withSender(message.text ? `${notice}\n\n${message.text}` : notice), route, replyExtra, senderEntities);
    }

    // Telegram rejects the whole upload when a caption is over 1024 characters
    // — on every retry, until the message was given up on and dropped. A
    // longer text is sent right after the media instead, as a reply to it.
    const text = message.text || '';
    const captionFits = withSender(text).length <= TELEGRAM_CAPTION_LIMIT;
    const caption = captionFits ? withSender(text) : withSender('');
    const extra = {
      ...threadExtra(route),
      ...replyExtra,
      caption: caption || undefined,
      ...(caption && senderEntities ? { caption_entities: senderEntities } : {})
    };
    const sent = await this.sendMedia(chatId, message, filePath, extra, route, replyExtra);
    if (!captionFits) {
      await this.sendTextChunks(chatId, text, route, replyParameters(sent?.message_id));
    }
    return sent;
  }

  // Telegram caps a text message at 4096 characters and rejects anything
  // longer outright, so long MAX texts go out in several parts. Returns the
  // first part (its message_id is what later replies are matched against).
  // `entities` (formatting, e.g. the sender's bold name) apply to the first part.
  async sendTextChunks(chatId, text, route = {}, replyExtra = {}, entities = undefined) {
    let first = null;
    const chunks = splitTelegramText(text);
    for (let index = 0; index < chunks.length; index++) {
      const sent = await this.bot.telegram.sendMessage(chatId, chunks[index], {
        ...threadExtra(route),
        ...(index === 0 ? replyExtra : {}),
        ...(index === 0 && entities ? { entities } : {})
      });
      first = first || sent;
    }
    return first;
  }

  async sendMedia(chatId, message, filePath, extra, route, replyExtra) {
    if (message.type === MessageType.STICKER && message.metadata?.lottie) {
      // Animated sticker as a Telegram .tgs (gzipped Lottie). Telegram validates
      // .tgs strictly; if it is rejected, deliver a text marker rather than
      // dropping the message (the log tells us .tgs failed → fall back to webm).
      try {
        return await this.bot.telegram.sendSticker(chatId, { source: filePath }, { ...threadExtra(route), ...replyExtra });
      } catch (tgsError) {
        logger.warn({ err: tgsError, filePath }, 'sendSticker (.tgs) rejected by Telegram');
        return await this.bot.telegram.sendMessage(chatId, '[Стикер]', { ...threadExtra(route), ...replyExtra });
      }
    }

    if (message.type === MessageType.STICKER && message.metadata?.animated) {
      // Animated sticker encoded as a GIF — Telegram autoplays it inline.
      // Fall back to a document only if the animation upload is rejected.
      try {
        return await this.bot.telegram.sendAnimation(chatId, { source: filePath }, extra);
      } catch (animationError) {
        logger.warn({ err: animationError?.message || String(animationError), filePath }, 'sendAnimation rejected, sending as document');
        return await this.bot.telegram.sendDocument(chatId, { source: filePath }, extra);
      }
    } else if (message.type === MessageType.PHOTO || message.type === MessageType.STICKER) {
      // A photo over 10 MB is refused as a photo, but fine as a file.
      const size = await fsp.stat(filePath).then((stat) => stat.size, () => 0);
      if (size > TELEGRAM_PHOTO_LIMIT_BYTES) return await this.bot.telegram.sendDocument(chatId, { source: filePath }, extra);
      return await this.bot.telegram.sendPhoto(chatId, { source: filePath }, extra);
    } else if (message.type === MessageType.VOICE) {
      return await this.bot.telegram.sendVoice(chatId, { source: filePath }, extra);
    } else if (message.type === MessageType.VIDEO_NOTE) {
      return await this.bot.telegram.sendVideoNote(chatId, { source: filePath }, { ...threadExtra(route), ...replyExtra });
    } else if (message.type === MessageType.VIDEO) {
      return await this.bot.telegram.sendVideo(chatId, { source: filePath }, extra);
    } else {
      // The name comes from MAX's page, where it can carry invisible bidi
      // characters (and so lose its extension in the eyes of Telegram
      // clients, which then add it again: "report.pdf.pdf").
      const docSource = { source: filePath, filename: documentDisplayName(message.originalFilename, filePath) };
      return await this.bot.telegram.sendDocument(chatId, docSource, extra);
    }
  }

  // Sends a file as a real Telegram sticker (a .webp, or a .webm video
  // sticker). Telegram does not always refuse a file it cannot use as a
  // sticker: it may post it as a plain document instead. So the result is
  // checked and such a stray message removed. Returns the sent message, or
  // null so the caller can fall back (GIF / photo). Flood control (429) is
  // rethrown: the bridge has to pause, not fall back and send again.
  async sendStickerFile(filePath, route = {}, replyToMessageId = null) {
    const chatId = route.telegramChatId || this.targetChatId();
    try {
      const sent = await this.bot.telegram.sendSticker(chatId, { source: filePath }, {
        ...threadExtra(route),
        ...replyParameters(replyToMessageId)
      });
      if (sent?.sticker) return sent;
      if (sent?.message_id) await this.bot.telegram.deleteMessage(chatId, sent.message_id).catch(() => {});
      logger.warn({ filePath }, 'Telegram did not take the file as a sticker');
      return null;
    } catch (error) {
      if ((error?.code ?? error?.response?.error_code) === 429) throw error;
      logger.warn({ err: error?.message || String(error), filePath }, 'sendSticker rejected by Telegram');
      return null;
    }
  }

  async sendDocument(filePath, route = {}, caption) {
    await this.bot.telegram.sendDocument(
      route.telegramChatId || this.targetChatId(),
      { source: filePath },
      {
        ...threadExtra(route),
        caption
      }
    );
  }

  installHandlers() {
    // Without this, any handler that throws outside its own try/catch reaches
    // Telegraf's default error handler, which rethrows — that rejection escapes
    // the detached polling loop, which then stops fetching updates for good.
    // The process keeps running and looks healthy while the bridge has silently
    // gone deaf to Telegram. Swallowing here keeps polling alive; per-handler
    // catches still report their own failures to the user.
    this.bot.catch((error, ctx) => {
      logger.error(
        { err: error, updateType: ctx?.updateType, chatId: ctx?.chat?.id },
        'Unhandled Telegram handler error (polling kept alive)'
      );
    });

    this.bot.use(async (ctx, next) => {
      if (!this.isAllowedContext(ctx)) {
        logger.warn({ telegramUserId: ctx.from?.id, chatId: ctx.chat?.id }, 'Ignored Telegram update');
        return;
      }
      await next();
    });

    this.bot.start((ctx) => ctx.reply([
      'Max <-> Telegram proxy is running.',
      'Daily use: open a topic named after the MAX chat and just write there.',
      '/status - bridge status',
      '/check - run Max Web selector healthcheck',
      '/diagnostics - send latest Max Web diagnostic files',
      '/chats - route list',
      '/new <имя или +7…> - начать новый чат в MAX',
      '/sync - force refresh if a topic is missing',
      '/history - last messages in this topic'
    ].join('\n')));

    this.bot.command('sync', async (ctx) => {
      try {
        const text = await this.onSyncRequested?.();
        await ctx.reply(text || 'Sync is not available.', threadExtraFromContext(ctx));
      } catch (error) {
        logger.error({ err: error }, 'Command /sync failed');
        await ctx.reply(`⚠️ Sync failed: ${error.message}`, threadExtraFromContext(ctx)).catch(() => {});
      }
    });

    this.bot.command('chats', async (ctx) => {
      try {
        const text = await this.onChatListRequested?.();
        await ctx.reply(text || 'Chat list is not available yet.', threadExtraFromContext(ctx));
      } catch (error) {
        logger.error({ err: error }, 'Command /chats failed');
        await ctx.reply(`⚠️ Chats failed: ${error.message}`, threadExtraFromContext(ctx)).catch(() => {});
      }
    });

    this.bot.command('select', async (ctx) => {
      try {
        // Everything after the command: a chat name can have spaces in it.
        const arg = ctx.message.text.replace(/^\/select(@\w+)?/i, '').trim();
        if (!arg) {
          await ctx.reply('Usage: /select <номер из /chats или название чата>', threadExtraFromContext(ctx));
          return;
        }
        const text = await this.onChatSelectRequested?.(arg);
        await ctx.reply(text || 'Chat was not selected.', threadExtraFromContext(ctx));
      } catch (error) {
        logger.error({ err: error }, 'Command /select failed');
        await ctx.reply(`⚠️ Select failed: ${error.message}`, threadExtraFromContext(ctx)).catch(() => {});
      }
    });

    this.bot.command('history', async (ctx) => {
      try {
        const text = await this.onHistoryRequested?.(ctx.chat.id, ctx.message.message_thread_id || null);
        await ctx.reply(text || 'No history for this chat.', threadExtraFromContext(ctx));
      } catch (error) {
        logger.error({ err: error }, 'Command /history failed');
        await ctx.reply(`⚠️ History failed: ${error.message}`, threadExtraFromContext(ctx)).catch(() => {});
      }
    });

    this.bot.command('status', async (ctx) => {
      try {
        const text = await this.onStatusRequested?.();
        await ctx.reply(text || 'Status is unavailable.', threadExtraFromContext(ctx));
      } catch (error) {
        logger.error({ err: error }, 'Command /status failed');
        await ctx.reply(`⚠️ Status failed: ${error.message}`, threadExtraFromContext(ctx)).catch(() => {});
      }
    });

    this.bot.command('check', async (ctx) => {
      try {
        const text = await this.onCheckRequested?.();
        await ctx.reply(text || 'Check is unavailable.', threadExtraFromContext(ctx));
      } catch (error) {
        logger.error({ err: error }, 'Command /check failed');
        await ctx.reply(`⚠️ Check failed: ${error.message}`, threadExtraFromContext(ctx)).catch(() => {});
      }
    });

    this.bot.command('diagnostics', async (ctx) => {
      try {
        const text = await this.onDiagnosticsRequested?.(ctx.chat.id, ctx.message.message_thread_id || null);
        await ctx.reply(text || 'Diagnostics are unavailable.', threadExtraFromContext(ctx));
      } catch (error) {
        logger.error({ err: error }, 'Command /diagnostics failed');
        await ctx.reply(`⚠️ Diagnostics failed: ${error.message}`, threadExtraFromContext(ctx)).catch(() => {});
      }
    });

    this.bot.command('deliveries', async (ctx) => {
      try {
        const text = await this.onDeliveriesRequested?.();
        await ctx.reply(text || 'Delivery stats are unavailable.', threadExtraFromContext(ctx));
      } catch (error) {
        logger.error({ err: error }, 'Command /deliveries failed');
        await ctx.reply(`⚠️ Deliveries failed: ${error.message}`, threadExtraFromContext(ctx)).catch(() => {});
      }
    });

    this.bot.command('merge', async (ctx) => {
      try {
        const arg = ctx.message.text.replace(/^\/merge\s*/, '').trim();
        if (!arg) {
          await ctx.reply('Usage: /merge <chatName>\nОтправьте в топике, куда нужно перенаправить сообщения.', threadExtraFromContext(ctx));
          return;
        }
        const threadId = ctx.message.message_thread_id || null;
        const text = await this.onMergeRequested?.(arg, ctx.chat.id, threadId);
        await ctx.reply(text || 'Merge is not available.', threadExtraFromContext(ctx));
      } catch (error) {
        logger.error({ err: error }, 'Command /merge failed');
        await ctx.reply(`⚠️ Merge failed: ${error.message}`, threadExtraFromContext(ctx)).catch(() => {});
      }
    });

    this.bot.command('unmerge', async (ctx) => {
      try {
        const arg = ctx.message.text.replace(/^\/unmerge\s*/, '').trim();
        if (!arg) {
          await ctx.reply('Usage: /unmerge <chatName>\nОтменяет объединение — чат снова будет писать в свой оригинальный топик.', threadExtraFromContext(ctx));
          return;
        }
        const text = await this.onUnmergeRequested?.(arg);
        await ctx.reply(text || 'Unmerge is not available.', threadExtraFromContext(ctx));
      } catch (error) {
        logger.error({ err: error }, 'Command /unmerge failed');
        await ctx.reply(`⚠️ Unmerge failed: ${error.message}`, threadExtraFromContext(ctx)).catch(() => {});
      }
    });

    this.bot.command('pair', async (ctx) => {
      try {
        if (this.config.ownerId) {
          await ctx.reply('Этот мост уже привязан к владельцу.');
          return;
        }
        if (!this.pairingCode) {
          await ctx.reply('Привязка сейчас не запрошена. Перезапусти контейнер и посмотри код в логах.');
          return;
        }
        const [, code] = ctx.message.text.trim().split(/\s+/, 2);
        if (!code) {
          await ctx.reply('Использование: /pair <код из логов контейнера>');
          return;
        }
        // A failed attempt must be logged: it means someone else found this
        // bot. Failures are counted per user and lock out only that user for
        // a while. The code itself is never rotated because of them: with 64
        // random bits guessing is hopeless anyway, and a shared rotation let
        // any stranger keep changing the code faster than the operator could
        // copy it out of the logs.
        const userId = ctx.from?.id;
        const failures = this.pairingFailures.get(userId) || { count: 0, lockedUntil: 0 };
        if (Date.now() < failures.lockedUntil) {
          await ctx.reply('Слишком много неудачных попыток — попробуй позже.');
          return;
        }
        if (code !== this.pairingCode) {
          failures.count += 1;
          if (failures.count >= MAX_PAIRING_ATTEMPTS) {
            failures.count = 0;
            failures.lockedUntil = Date.now() + PAIRING_LOCKOUT_MS;
          }
          this.pairingFailures.set(userId, failures);
          logger.warn({ telegramUserId: userId, lockedOut: failures.lockedUntil > Date.now() }, 'Rejected /pair attempt with a wrong code');
          await ctx.reply(failures.lockedUntil > Date.now()
            ? 'Слишком много неудачных попыток — попробуй позже.'
            : 'Код не подходит.');
          return;
        }

        this.config.ownerId = ctx.from.id;
        this.pairingCode = null;
        await this.onIdentityDiscoveredHandler?.({ ownerId: ctx.from.id });
        logger.info({ ownerId: ctx.from.id }, 'Owner paired');
        await ctx.reply([
          '✅ Готово, ты владелец этого моста.',
          '',
          'Дальше: создай приватную группу с включёнными Темами (Topics)',
          'и добавь меня туда админом — я подхвачу её автоматически.',
          'Без группы всё будет приходить сюда, в личку.'
        ].join('\n'));
        // The bot may already be sitting in the group: Telegram delivered that
        // my_chat_member while nobody owned this instance, so it could not be
        // trusted then and was only remembered. Now that an owner exists, adopt
        // it — but only after confirming this owner actually belongs to that
        // group, so a stranger cannot pre-plant their own group and have every
        // private conversation relayed into it.
        await this.adoptPendingRelayGroup(ctx).catch((error) => {
          logger.warn({ err: error?.message || String(error) }, 'Could not adopt the pending relay group');
        });
      } catch (error) {
        logger.error({ err: error }, 'Command /pair failed');
      }
    });

    // Escape hatch for relay auto-discovery: point the bridge at THIS group.
    // Without it a wrong first guess (or a group added at the wrong moment)
    // could only be undone by editing SQLite on the server — exactly the
    // server access this onboarding exists to remove.
    this.bot.command('relay', async (ctx) => {
      try {
        const chat = ctx.chat;
        if (chat?.type !== 'supergroup') {
          await ctx.reply('Отправь /relay внутри приватной супергруппы с включёнными Темами — она станет местом для чатов MAX.');
          return;
        }
        if (!chat.is_forum) {
          await ctx.reply('⚠️ В этой группе не включены Темы (Topics). Включи их в настройках группы и повтори /relay.');
          return;
        }
        const me = await ctx.telegram.getChatMember(chat.id, ctx.botInfo?.id ?? (await ctx.telegram.getMe()).id);
        if (me.status !== 'administrator') {
          await ctx.reply('⚠️ Нужны права администратора — прежде всего «Управление темами» (Manage Topics).');
          return;
        }
        // Being an admin is not enough: Telegram grants each right separately,
        // and without can_manage_topics every createForumTopic fails with
        // "not enough rights to create a topic". That surfaced only later, as
        // a /sync answering "routes: 0" with no explanation — so check the
        // specific right here, while the owner is still in the group settings.
        if (me.can_manage_topics === false) {
          await ctx.reply([
            '⚠️ Я администратор, но без права «Управление темами» (Manage Topics) — без него Telegram не даёт создавать темы.',
            '',
            'Группа → Администраторы → выбери меня → включи «Управление темами» → повтори /relay.'
          ].join('\n'));
          return;
        }

        const previous = this.config.relayChatId;
        this.config.relayChatId = chat.id;
        await this.onIdentityDiscoveredHandler?.({ relayChatId: chat.id });
        logger.info({ relayChatId: chat.id, previous, title: chat.title }, 'Relay group set via /relay');
        const lines = [previous && previous !== chat.id
          ? '✅ Теперь чаты MAX идут сюда. Темы, созданные в прошлой группе, там и останутся — новые появятся здесь.'
          : '✅ Эта группа подключена — чаты MAX будут появляться здесь отдельными темами.'];
        // The environment wins over what /relay stores (see restoreIdentity):
        // without this the bridge went back to the old group on the next
        // restart, silently.
        const pinned = Number.parseInt(process.env.TELEGRAM_RELAY_CHAT_ID || '', 10);
        if (pinned && pinned !== chat.id) {
          lines.push('', `⚠️ В .env задан TELEGRAM_RELAY_CHAT_ID=${pinned}: после перезапуска мост вернётся в ту группу. Убери эту строку из .env или впиши туда ${chat.id}.`);
        }
        await ctx.reply(lines.join('\n'));
      } catch (error) {
        logger.error({ err: error }, 'Command /relay failed');
        await ctx.reply(`⚠️ Relay failed: ${error.message}`).catch(() => {});
      }
    });

    this.bot.command('login', async (ctx) => {
      try {
        const text = await this.onLoginRequested?.();
        await ctx.reply(text || 'Login is not available.', threadExtraFromContext(ctx));
      } catch (error) {
        logger.error({ err: error }, 'Command /login failed');
        await ctx.reply(`⚠️ Login failed: ${error.message}`, threadExtraFromContext(ctx)).catch(() => {});
      }
    });

    // Relay group auto-discovery: the owner adding the bot to a forum-enabled
    // supergroup IS the configuration step, so no chat-id hunting through
    // getUpdates is needed. Only fires while no relay chat is set.
    this.bot.on('my_chat_member', async (ctx) => {
      try {
        const update = ctx.myChatMember;
        const status = update?.new_chat_member?.status;
        const chat = update?.chat;
        if (!chat || (chat.type !== 'supergroup' && chat.type !== 'group')) return;
        if ((status === 'left' || status === 'kicked') && chat.id === this.config.relayChatId) {
          logger.warn({ chatId: chat.id, status }, 'Removed from the relay group');
          await this.onRelayLostHandler?.(chat.id, status);
          return;
        }
        if (status !== 'administrator' && status !== 'member') return;
        if (this.config.relayChatId) {
          if (chat.id !== this.config.relayChatId) {
            logger.info({ chatId: chat.id }, 'Added to a group while a relay chat is already configured — ignoring');
          }
          return;
        }
        // Added before anyone claimed this bot. Telegram never re-sends
        // my_chat_member, so dropping it here would lose the group forever
        // (the natural order really is "make the group, add the bot, then
        // pair"). Remember it and let /pair adopt it after verifying the new
        // owner is actually in that group.
        if (!this.config.ownerId) {
          const addedBy = update?.from?.id;
          if (addedBy) this.pendingRelayChats.set(addedBy, chat.id);
          logger.info({ chatId: chat.id, addedBy }, 'Added to a group before pairing — remembered as a candidate relay group');
          return;
        }

        if (chat.type !== 'supergroup' || !chat.is_forum) {
          await ctx.telegram.sendMessage(chat.id,
            // Telegram sends my_chat_member only when the bot is added or its
            // status changes, so enabling Topics afterwards produces no new
            // event and nothing happens on its own. /relay is the one-step fix;
            // suggesting a re-add first sent people through the longer route.
            '⚠️ В этой группе не включены Темы (Topics).\n\n'
            + 'Включи их в настройках группы, а потом отправь сюда /relay — и каждый чат MAX получит свою тему. '
            + 'Заново добавлять меня не нужно.'
          ).catch(() => null);
          return;
        }
        if (status !== 'administrator') {
          await ctx.telegram.sendMessage(chat.id,
            '⚠️ Мне нужны права администратора — главное «Управление темами» (Manage Topics), '
            + 'плюс закрепление сообщений.\n\n'
            + 'Выдай их и отправь сюда /relay. Если ты назначаешь меня админом прямо сейчас, '
            + 'ничего отправлять не нужно — я подхвачу группу сам.'
          ).catch(() => null);
          return;
        }

        this.config.relayChatId = chat.id;
        await this.onIdentityDiscoveredHandler?.({ relayChatId: chat.id });
        logger.info({ relayChatId: chat.id, title: chat.title }, 'Relay group discovered automatically');
        await ctx.telegram.sendMessage(chat.id,
          '✅ Эта группа подключена — чаты MAX будут появляться здесь отдельными темами.'
        ).catch(() => null);
      } catch (error) {
        logger.error({ err: error }, 'my_chat_member handling failed');
      }
    });

    // /new <имя или номер>: MAX's search, then a button per chat found. Only
    // the owner reaches it (see isAllowedContext), and nothing is sent to
    // anyone in MAX.
    this.bot.command('new', async (ctx) => {
      const extra = threadExtraFromContext(ctx);
      try {
        const arg = ctx.message.text.replace(/^\/new(@\w+)?/i, '').trim();
        if (arg) await ctx.sendChatAction('typing', extra).catch(() => {});
        const result = await this.onNewChatRequested?.(arg);
        const choices = result?.choices || [];
        await ctx.reply(result?.text || '/new is not available.', {
          ...extra,
          ...(choices.length ? { reply_markup: { inline_keyboard: choices.map((choice) => [{ text: choice.label, callback_data: choice.data }]) } } : {})
        });
      } catch (error) {
        logger.error({ err: error }, 'Command /new failed');
        await ctx.reply(`⚠️ /new: ${error.message}`, extra).catch(() => {});
      }
    });

    this.bot.action(/^new:([A-Za-z0-9_-]{1,32}):(\d{1,2}|x)$/, async (ctx) => {
      const [, sessionId, choice] = ctx.match;
      await ctx.answerCbQuery(choice === 'x' ? 'Отменено' : 'Открываю чат в MAX…').catch(() => {});
      // The buttons go at once: a second press must not open a second chat.
      await ctx.editMessageReplyMarkup(undefined).catch(() => {});
      let text;
      try {
        text = await this.onNewChatChosen?.(sessionId, choice);
      } catch (error) {
        logger.error({ err: error }, '/new choice failed');
        text = `⚠️ ${error.message}`;
      }
      // A second press of a button already pressed: the first one answers.
      if (text === null) return;
      const reply = text || '/new is not available.';
      await ctx.editMessageText(reply, { link_preview_options: { is_disabled: true } })
        .catch(() => ctx.reply(reply, { ...threadExtra({ telegramThreadId: ctx.callbackQuery?.message?.message_thread_id || null }) }).catch(() => {}));
    });

    this.bot.command('mute', async (ctx) => {
      try {
        const arg = ctx.message.text.replace(/^\/mute\s*/, '').trim();
        if (!arg) {
          await ctx.reply('Usage: /mute <chatName>\nПерестаёт пересылать сообщения этого MAX-чата (например, рекламные ленты). Список: /chats', threadExtraFromContext(ctx));
          return;
        }
        const text = await this.onMuteRequested?.(arg);
        await ctx.reply(text || 'Mute is not available.', threadExtraFromContext(ctx));
      } catch (error) {
        logger.error({ err: error }, 'Command /mute failed');
        await ctx.reply(`⚠️ Mute failed: ${error.message}`, threadExtraFromContext(ctx)).catch(() => {});
      }
    });

    this.bot.command('unmute', async (ctx) => {
      try {
        const arg = ctx.message.text.replace(/^\/unmute\s*/, '').trim();
        if (!arg) {
          await ctx.reply('Usage: /unmute <chatName>\nВозвращает пересылку заглушённого чата (🔇 в /chats).', threadExtraFromContext(ctx));
          return;
        }
        const text = await this.onUnmuteRequested?.(arg);
        await ctx.reply(text || 'Unmute is not available.', threadExtraFromContext(ctx));
      } catch (error) {
        logger.error({ err: error }, 'Command /unmute failed');
        await ctx.reply(`⚠️ Unmute failed: ${error.message}`, threadExtraFromContext(ctx)).catch(() => {});
      }
    });

    this.bot.on('message_reaction', (ctx) => {
      const update = ctx.messageReaction;
      if (!update || !this.onReactionHandler) return undefined;
      const emojis = (list) => (list || []).filter((reaction) => reaction.type === 'emoji').map((reaction) => reaction.emoji);
      const reaction = {
        telegramChatId: update.chat.id,
        telegramMessageId: update.message_id,
        emojis: emojis(update.new_reaction),
        previousEmojis: emojis(update.old_reaction),
        // Custom-emoji and paid reactions have no MAX counterpart.
        otherReactions: (update.new_reaction || []).filter((reaction) => reaction.type !== 'emoji').length
      };
      // Mirroring drives the MAX page and can take seconds: it must not hold
      // up Telegram polling, only keep its order.
      this.reactionQueue = this.reactionQueue
        .then(() => this.onReactionHandler(reaction))
        .catch((error) => {
          logger.error({ err: error, chatId: reaction.telegramChatId }, 'Failed to mirror a Telegram reaction into MAX');
        });
      return undefined;
    });

    // "Повторить" under a notice that a message did not reach MAX: the
    // notice is a reply to that message, so Telegram hands it back here and
    // it goes through the ordinary path again — nothing has to be resent.
    this.bot.action(RETRY_ACTION, async (ctx) => {
      const notice = ctx.callbackQuery?.message;
      const original = notice?.reply_to_message;
      if (!original || !this.onOutboundMessage) {
        await ctx.answerCbQuery('Исходное сообщение не найдено — пришли его ещё раз.').catch(() => {});
        return;
      }
      await ctx.answerCbQuery('Отправляю ещё раз…').catch(() => {});
      await ctx.deleteMessage().catch(() => {});
      const task = this.outboundQueue.then(() => this.processOutbound(ctx, original));
      this.outboundQueue = task.catch(() => {});
      await task;
    });

    this.bot.on('message', (ctx) => {
      if (!this.onOutboundMessage || !ctx.message) return undefined;
      // Skip only real bot commands (already served by their own handlers).
      // Matching every leading "/" silently swallowed ordinary messages that
      // merely start with one — a file path like "/home/user/photo.jpg" or a
      // note like "/2 ideas" never reached MAX and produced no log at all.
      if ('text' in ctx.message && isBotCommand(ctx.message.text)) return undefined;
      // Telegraf handles all updates of one getUpdates batch concurrently,
      // and a photo first waits for its download while a text sent right
      // after it does not: "photo, then 'what do you think?'" reached MAX
      // text first, and album items in whatever order their downloads
      // finished. Queue each message now, before anything awaits, so they go
      // out in the order they were sent.
      const task = this.outboundQueue.then(() => this.processOutbound(ctx));
      this.outboundQueue = task.catch(() => {});
      return task;
    });
  }

  // `msg`: the owner's message — the update's own, or the one a "retry"
  // button points back to.
  async processOutbound(ctx, msg = ctx.message) {
    const answer = (text) => ctx.telegram.sendMessage(msg.chat.id, text, threadExtra({ telegramThreadId: msg.message_thread_id || null })).catch(() => {});
    try {
      const message = await this.telegramMessageToDomain(ctx, msg);
      if (message) {
        await this.onOutboundMessage(message);
      } else if (UNSUPPORTED_CONTENT.some((key) => key in msg)) {
        // These used to vanish without a word, so the owner assumed they
        // were delivered. (Service messages also land here and stay quiet.)
        await answer('⚠️ Такой тип сообщения в MAX не пересылается — отправь текстом или файлом.');
      }
    } catch (error) {
      logger.error({ err: error, chatId: msg.chat?.id }, 'Failed to process outbound Telegram message');
      await answer(error?.userFacing ? `⚠️ ${error.message}` : `⚠️ Failed to process message: ${error.message}`);
    }
  }

  isAllowedContext(ctx) {
    // Unclaimed instance: only `/pair <code>` gets through, and only in a
    // private chat. Everything else stays blocked until an owner exists, so an
    // unconfigured bot cannot be driven by whoever finds it.
    if (!this.config.ownerId) {
      // my_chat_member carries no user input and cannot act on the bridge; it
      // is only remembered as a candidate relay group and adopted later, after
      // /pair verifies the owner is in that group. Dropping it here instead
      // would lose the group permanently, since Telegram never resends it.
      if (ctx.updateType === 'my_chat_member') return true;
      return ctx.chat?.type === 'private' && /^\/pair(\s|$|@)/.test(ctx.message?.text || '');
    }
    // Being removed from the relay group arrives from whichever admin did
    // it, not necessarily the owner — and must still be noticed. It carries
    // no user input; the handler only reacts to left/kicked there.
    if (ctx.updateType === 'my_chat_member' && this.config.relayChatId && ctx.chat?.id === this.config.relayChatId) return true;
    if (ctx.from?.id !== this.config.ownerId) return false;
    // The owner adding the bot to a group is how the relay group is found;
    // the my_chat_member handler itself decides whether to adopt it.
    if (ctx.updateType === 'my_chat_member') return true;
    if (this.config.relayChatId && ctx.chat?.id === this.config.relayChatId) return true;
    // /relay is how the owner MOVES the bridge to a different group, so it has
    // to be reachable from a group that is not the current relay — otherwise
    // the escape hatch only works where it is not needed, and re-pointing the
    // bridge means editing SQLite on the server. Owner-only: the sender was
    // already checked above.
    if (isGroupChat(ctx.chat) && /^\/relay(\s|$|@)/.test(ctx.message?.text || '')) return true;
    // Anything else only from the owner's private chat. Without a relay group
    // this used to accept the owner's messages from ANY chat the bot was in —
    // an ordinary message typed in some unrelated group was then delivered to
    // the MAX chat picked with /select.
    return ctx.chat?.type === 'private' && ctx.chat.id === this.config.ownerId;
  }

  async telegramMessageToDomain(ctx, msg = ctx.message) {
    const base = {
      id: stableId('tg', msg.chat.id, msg.message_thread_id || 0, msg.message_id, msg.date),
      direction: Direction.TG_TO_MAX,
      sourceMessageId: String(msg.message_id),
      createdAt: msg.date ? msg.date * 1000 : Date.now(),
      metadata: {
        telegramChatId: msg.chat.id,
        telegramThreadId: msg.message_thread_id || null,
        // If this message is a Telegram reply, the bridge resolves the quoted
        // message back to its MAX-side identity and replays it as a real MAX
        // reply (see bridge.js resolveMaxReplyTarget). null for plain messages.
        replyToTelegramMessageId: msg.reply_to_message?.message_id || null
      }
    };

    if ('text' in msg) {
      return { ...base, type: MessageType.TEXT, text: msg.text };
    }

    if ('photo' in msg) {
      const photo = msg.photo.at(-1);
      const mediaPath = await this.fetchFile(ctx, photo, 'photo');
      return { ...base, type: MessageType.PHOTO, text: msg.caption, mediaPath };
    }

    if ('voice' in msg) {
      const mediaPath = await this.fetchFile(ctx, msg.voice, 'voice');
      return { ...base, type: MessageType.VOICE, text: msg.caption, mediaPath };
    }

    if ('video' in msg) {
      const mediaPath = await this.fetchFile(ctx, msg.video, msg.video.file_name || 'video');
      return { ...base, type: MessageType.VIDEO, text: msg.caption, mediaPath };
    }

    if ('video_note' in msg) {
      const mediaPath = await this.fetchFile(ctx, msg.video_note, 'video-note');
      return { ...base, type: MessageType.VIDEO_NOTE, mediaPath };
    }

    if ('document' in msg) {
      const mediaPath = await this.fetchFile(ctx, msg.document, msg.document.file_name || 'document');
      return { ...base, type: MessageType.DOCUMENT, text: msg.caption, mediaPath };
    }

    // Music and other audio files (mp3/m4a) arrive as `audio`, not
    // `document`, and used to disappear without a trace.
    if ('audio' in msg) {
      const mediaPath = await this.fetchFile(ctx, msg.audio, msg.audio.file_name || 'audio');
      return { ...base, type: MessageType.DOCUMENT, text: msg.caption, mediaPath };
    }

    if ('sticker' in msg) {
      // The sticker file itself: .webp (static), .tgs (animated Lottie) or
      // .webm (video). The bridge turns it into something MAX shows — a PNG
      // or an animated GIF, transparency kept — and sends the emoji instead
      // if that fails.
      const sticker = msg.sticker;
      const mediaPath = await this.fetchFile(ctx, sticker, 'sticker');
      return {
        ...base,
        type: MessageType.STICKER,
        mediaPath,
        metadata: { ...base.metadata, stickerEmoji: sticker.emoji || null }
      };
    }

    return null;
  }

  // Telegram hands a bot files of up to 20 MB; for a bigger one getFile fails
  // with a bare "file is too big". Say it in words the owner can act on.
  async fetchFile(ctx, file, name) {
    if (file?.file_size > TELEGRAM_DOWNLOAD_LIMIT_BYTES) {
      throw userFacingError(`Файл «${name}» весит ${formatMb(file.file_size)}, а Telegram отдаёт ботам файлы только до 20 МБ — в MAX он не ушёл. Отправь его в MAX напрямую или сожми.`);
    }
    return this.mediaService.telegramFileToLocal(ctx, file.file_id, name);
  }
}

// Commands registered via bot.command() below — anything else beginning with
// "/" is ordinary user text and must be forwarded to MAX, not dropped.
const BOT_COMMANDS = new Set([
  'start', 'sync', 'chats', 'select', 'history', 'status',
  'check', 'diagnostics', 'deliveries', 'merge', 'unmerge',
  'mute', 'unmute', 'pair', 'login', 'relay', 'new'
]);

// Wrong /pair codes one user may send before being locked out for a while.
const MAX_PAIRING_ATTEMPTS = 5;
const PAIRING_LOCKOUT_MS = 10 * 60 * 1000;

// What Telegram lets a bot upload and download, and send as a photo.
const TELEGRAM_UPLOAD_LIMIT_BYTES = 50 * 1024 * 1024;
const TELEGRAM_DOWNLOAD_LIMIT_BYTES = 20 * 1024 * 1024;
const TELEGRAM_PHOTO_LIMIT_BYTES = 10 * 1024 * 1024;

const formatMb = (bytes) => `${(bytes / (1024 * 1024)).toFixed(1).replace('.', ',')} МБ`;

// An error whose message is written for the owner, shown to them as is.
const userFacingError = (message) => Object.assign(new Error(message), { userFacing: true });

// The update types the bot handles. Listing them is required to receive
// message_reaction at all.
const ALLOWED_UPDATES = ['message', 'my_chat_member', 'message_reaction', 'callback_query'];

// callback_data of the "Повторить" button (see sendRetryNotice).
const RETRY_ACTION = 'retry';

// Telegram content the bridge cannot represent in MAX; the sender is told.
const UNSUPPORTED_CONTENT = ['location', 'venue', 'contact', 'poll', 'dice', 'game', 'story'];

const isGroupChat = (chat) => chat?.type === 'supergroup' || chat?.type === 'group';

const isBotCommand = (text) => {
  const match = /^\/([A-Za-z0-9_]+)(?:@[A-Za-z0-9_]+)?(?:\s|$)/.exec(String(text || ''));
  return Boolean(match) && BOT_COMMANDS.has(match[1].toLowerCase());
};

const threadExtra = (route = {}) => (
  route.telegramThreadId ? { message_thread_id: route.telegramThreadId } : {}
);

// When the MAX message is a reply, Telegram renders it as a quote.
// allow_sending_without_reply keeps delivery working if the original was
// deleted or is unavailable in the target chat.
const replyParameters = (messageId) => (
  messageId ? { reply_parameters: { message_id: messageId, allow_sending_without_reply: true } } : {}
);

// Bot API limits, in UTF-16 code units (what String#length counts).
const TELEGRAM_TEXT_LIMIT = 4096;
const TELEGRAM_CAPTION_LIMIT = 1024;

// Splits text into parts Telegram accepts, preferring a line break, then a
// space, in the second half of each part; never splits a surrogate pair.
export const splitTelegramText = (text, limit = TELEGRAM_TEXT_LIMIT) => {
  const chunks = [];
  let rest = String(text ?? '');
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit);
    if (cut < limit / 2) cut = rest.lastIndexOf(' ', limit);
    if (cut < limit / 2) cut = limit;
    const code = rest.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^[\n ]/, '');
  }
  chunks.push(rest);
  return chunks;
};

const threadExtraFromContext = (ctx) => threadExtra({
  telegramThreadId: ctx.message?.message_thread_id || null
});

const sanitizeTopicTitle = (title) => String(title || 'MAX chat')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, 128) || 'MAX chat';
