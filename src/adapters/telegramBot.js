import crypto from 'node:crypto';
import { Telegraf } from 'telegraf';
import { Direction, MessageType, stableId } from '../domain/messages.js';
import { logger } from '../logger.js';

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
    // Set by startPairing() when no owner is configured (see /pair).
    this.pairingCode = null;
    this.pairingAttempts = 0;
    // A group the bot was added to before anyone claimed it (see /pair).
    this.pendingRelayChatId = null;
    this.launchPromise = null;
    this.installHandlers();
  }

  // Publishes the command list so Telegram's "/" menu autocompletes. Without
  // it the menu is empty and a user who reads the docs, types "/" and sees
  // nothing concludes the commands are unsupported.
  async publishCommandMenu() {
    const commands = [
      { command: 'status', description: 'Состояние моста' },
      { command: 'chats', description: 'Список чатов MAX и маршрутов' },
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
      this.launchPromise = this.bot.launch({}, () => {
        launched = true;
        logger.info({ username: this.bot.botInfo?.username }, 'Telegram bot polling started');
        this.publishCommandMenu();
        resolve();
      }).catch((error) => {
        logger.error({ err: error }, 'Telegram bot polling failed');
        if (!launched) reject(error);
      });
    });
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

  // Zero-config ownership: with TELEGRAM_OWNER_ID unset the bot accepts a
  // single `/pair <code>` from anyone who can read the container logs, and
  // binds that user as the owner. The code is what keeps a stranger who merely
  // guessed the bot's @username from claiming it.
  // A bot's @username is globally searchable, so anyone who knows this project
  // was deployed can find an unclaimed instance and start guessing. Six digits
  // is ~900k combinations — hours of brute force at Telegram's own rate limit,
  // and winning it means the attacker is handed the MAX login QR. Hence a
  // 64-bit code plus a cap on wrong attempts.
  startPairing() {
    if (!this.pairingCode) {
      this.pairingCode = crypto.randomBytes(8).toString('base64url');
      this.pairingAttempts = 0;
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
  async adoptPendingRelayGroup(ctx) {
    const chatId = this.pendingRelayChatId;
    if (!chatId || this.config.relayChatId || !this.config.ownerId) return false;
    this.pendingRelayChatId = null;

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

    if (message.type === MessageType.TEXT) {
      return await this.sendTextChunks(chatId, message.text || '', route, replyExtra);
    }

    const filePath = message.mediaPath;
    if (!filePath) {
      return await this.sendTextChunks(chatId, message.text || `[${message.type}] ${message.mediaUrl || ''}`, route, replyExtra);
    }

    // Telegram rejects the whole upload when a caption is over 1024 characters
    // — on every retry, until the message was given up on and dropped. A
    // longer text is sent right after the media instead, as a reply to it.
    const text = message.text || '';
    const captionFits = text.length <= TELEGRAM_CAPTION_LIMIT;
    const extra = {
      ...threadExtra(route),
      ...replyExtra,
      caption: captionFits ? (text || undefined) : undefined
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
  async sendTextChunks(chatId, text, route = {}, replyExtra = {}) {
    let first = null;
    const chunks = splitTelegramText(text);
    for (let index = 0; index < chunks.length; index++) {
      const sent = await this.bot.telegram.sendMessage(chatId, chunks[index], {
        ...threadExtra(route),
        ...(index === 0 ? replyExtra : {})
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
      return await this.bot.telegram.sendPhoto(chatId, { source: filePath }, extra);
    } else if (message.type === MessageType.VOICE) {
      return await this.bot.telegram.sendVoice(chatId, { source: filePath }, extra);
    } else if (message.type === MessageType.VIDEO_NOTE) {
      return await this.bot.telegram.sendVideoNote(chatId, { source: filePath }, { ...threadExtra(route), ...replyExtra });
    } else if (message.type === MessageType.VIDEO) {
      return await this.bot.telegram.sendVideo(chatId, { source: filePath }, extra);
    } else {
      const docSource = { source: filePath };
      if (message.originalFilename) {
        docSource.filename = message.originalFilename;
      }
      return await this.bot.telegram.sendDocument(chatId, docSource, extra);
    }
  }

  // Try to send a file as a Telegram sticker (.tgs/.webm). Returns true on
  // success, false if Telegram rejects it (so the caller can fall back). The
  // rejection reason is logged so we can tell whether MAX's Lottie conforms.
  async trySendSticker(filePath, route = {}) {
    try {
      await this.bot.telegram.sendSticker(
        route.telegramChatId || this.targetChatId(),
        { source: filePath },
        threadExtra(route)
      );
      return true;
    } catch (error) {
      logger.warn({ err: error?.message || String(error), filePath }, 'sendSticker rejected by Telegram');
      return false;
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
        const [, arg] = ctx.message.text.split(/\s+/, 2);
        if (!arg) {
          await ctx.reply('Usage: /select <number>', threadExtraFromContext(ctx));
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
        // Constant-time-ish compare is overkill for a 6-digit code that is only
        // valid until the first success, but a failed attempt must be logged:
        // it means someone else found this bot.
        if (code !== this.pairingCode) {
          this.pairingAttempts = (this.pairingAttempts || 0) + 1;
          logger.warn(
            { telegramUserId: ctx.from?.id, attempts: this.pairingAttempts },
            'Rejected /pair attempt with a wrong code'
          );
          if (this.pairingAttempts >= MAX_PAIRING_ATTEMPTS) {
            // Rotate rather than lock out: a guessing attacker has to start
            // over from zero knowledge, while the real operator only needs to
            // re-read the new code from the logs.
            this.pairingCode = crypto.randomBytes(8).toString('base64url');
            this.pairingAttempts = 0;
            logger.warn({ pairingCode: this.pairingCode }, 'Too many wrong /pair attempts — pairing code regenerated, use the new one');
            await ctx.reply('Слишком много неудачных попыток. Код перевыпущен — возьми новый в логах контейнера.');
            return;
          }
          await ctx.reply('Код не подходит.');
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
        await ctx.reply(previous && previous !== chat.id
          ? '✅ Теперь чаты MAX идут сюда. Темы, созданные в прошлой группе, там и останутся — новые появятся здесь.'
          : '✅ Эта группа подключена — чаты MAX будут появляться здесь отдельными темами.');
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
          this.pendingRelayChatId = chat.id;
          logger.info({ chatId: chat.id }, 'Added to a group before pairing — remembered as a candidate relay group');
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

    this.bot.on('message', async (ctx) => {
      if (!this.onOutboundMessage || !ctx.message) return;
      // Skip only real bot commands (already served by their own handlers).
      // Matching every leading "/" silently swallowed ordinary messages that
      // merely start with one — a file path like "/home/user/photo.jpg" or a
      // note like "/2 ideas" never reached MAX and produced no log at all.
      if ('text' in ctx.message && isBotCommand(ctx.message.text)) return;
      try {
        const message = await this.telegramMessageToDomain(ctx);
        if (message) await this.onOutboundMessage(message);
      } catch (error) {
        logger.error({ err: error, chatId: ctx.chat?.id }, 'Failed to process outbound Telegram message');
        await ctx.reply(`⚠️ Failed to process message: ${error.message}`, threadExtraFromContext(ctx)).catch(() => {});
      }
    });
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

  async telegramMessageToDomain(ctx) {
    const msg = ctx.message;
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
      const mediaPath = await this.mediaService.telegramFileToLocal(ctx, photo.file_id, 'photo');
      return { ...base, type: MessageType.PHOTO, text: msg.caption, mediaPath };
    }

    if ('voice' in msg) {
      const mediaPath = await this.mediaService.telegramFileToLocal(ctx, msg.voice.file_id, 'voice');
      return { ...base, type: MessageType.VOICE, mediaPath };
    }

    if ('video' in msg) {
      const mediaPath = await this.mediaService.telegramFileToLocal(ctx, msg.video.file_id, msg.video.file_name || 'video');
      return { ...base, type: MessageType.VIDEO, text: msg.caption, mediaPath };
    }

    if ('video_note' in msg) {
      const mediaPath = await this.mediaService.telegramFileToLocal(ctx, msg.video_note.file_id, 'video-note');
      return { ...base, type: MessageType.VIDEO_NOTE, mediaPath };
    }

    if ('document' in msg) {
      const mediaPath = await this.mediaService.telegramFileToLocal(ctx, msg.document.file_id, msg.document.file_name || 'document');
      return { ...base, type: MessageType.DOCUMENT, text: msg.caption, mediaPath };
    }

    if ('sticker' in msg) {
      const mediaPath = await this.mediaService.telegramFileToLocal(ctx, msg.sticker.file_id, 'sticker');
      return { ...base, type: MessageType.STICKER, mediaPath };
    }

    return null;
  }
}

// Commands registered via bot.command() below — anything else beginning with
// "/" is ordinary user text and must be forwarded to MAX, not dropped.
const BOT_COMMANDS = new Set([
  'start', 'sync', 'chats', 'select', 'history', 'status',
  'check', 'diagnostics', 'deliveries', 'merge', 'unmerge',
  'mute', 'unmute', 'pair', 'login', 'relay'
]);

// Wrong /pair codes tolerated before the code is rotated (see startPairing).
const MAX_PAIRING_ATTEMPTS = 5;

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
