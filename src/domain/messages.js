import crypto from 'node:crypto';

export const MessageType = Object.freeze({
  TEXT: 'text',
  PHOTO: 'photo',
  VOICE: 'voice',
  VIDEO: 'video',
  VIDEO_NOTE: 'video_note',
  DOCUMENT: 'document',
  STICKER: 'sticker'
});

export const Direction = Object.freeze({
  MAX_TO_TG: 'max_to_tg',
  TG_TO_MAX: 'tg_to_max'
});

export const stableId = (...parts) => crypto
  .createHash('sha256')
  .update(parts.filter(Boolean).join('|'))
  .digest('hex')
  .slice(0, 32);

export const normalizeText = (value) => String(value || '').replace(/\r\n/g, '\n').trim();

export const humanMessage = (message) => {
  const time = new Date(message.createdAt || Date.now()).toLocaleString();
  const prefix = message.direction === Direction.MAX_TO_TG ? 'Max' : 'Telegram';
  const body = message.text || message.mediaUrl || message.mediaPath || `[${message.type}]`;
  return `${time} ${prefix}: ${body}`;
};
