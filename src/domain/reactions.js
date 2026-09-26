// Reactions travel between MAX and Telegram as emoji. Telegram only accepts a
// fixed set of them from a bot (Bot API, ReactionTypeEmoji), written without
// the U+FE0F variation selector ("❤", not "❤️") and without skin tones.

export const TELEGRAM_REACTIONS = new Set([
  '👍', '👎', '❤', '🔥', '🥰', '👏', '😁', '🤔', '🤯', '😱', '🤬', '😢', '🎉', '🤩',
  '🤮', '💩', '🙏', '👌', '🕊', '🤡', '🥱', '🥴', '😍', '🐳', '❤‍🔥', '🌚', '🌭', '💯',
  '🤣', '⚡', '🍌', '🏆', '💔', '🤨', '😐', '🍓', '🍾', '💋', '🖕', '😈', '😴', '😭',
  '🤓', '👻', '👨‍💻', '👀', '🎃', '🙈', '😇', '😨', '🤝', '✍', '🤗', '🫡', '🎅', '🎄',
  '☃', '💅', '🤪', '🗿', '🆒', '💘', '🙉', '🦄', '😘', '💊', '🙊', '😎', '👾', '🤷‍♂',
  '🤷', '🤷‍♀', '😡'
]);

// The comparable core of an emoji: no variation selectors, no skin tones.
export const normalizeEmoji = (emoji) => String(emoji ?? '')
  .replace(/[︎️]/gu, '')
  .replace(/[\u{1F3FB}-\u{1F3FF}]/gu, '')
  .trim();

// The two sides offer different sets — Telegram has no 😂 or 😮, MAX may not
// have 🤣 or 🤯 — so each emoji stands in for its nearest relatives. The
// first member of a group is the one Telegram offers.
const RELATIVES = [
  ['🤣', '😂', '😹'],
  ['😁', '😆', '😄', '😃', '😀', '😅', '😸'],
  ['🤯', '😮', '😯', '😲', '😦', '😧'],
  ['😢', '🥲', '😥', '😪', '😿', '😞', '😔', '☹', '🙁'],
  ['❤', '♥', '💖', '💗', '💓', '💕', '💞', '💝', '😻', '❣', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '🤎'],
  ['😡', '😠'],
  ['🎉', '🥳', '🎊'],
  ['🤮', '🤢'],
  ['🥰', '😊', '☺', '🙂']
].map((group) => group.map(normalizeEmoji));

const relativesOf = (emoji) => RELATIVES.find((group) => group.includes(emoji)) || [];

// The Telegram reaction an emoji maps to — itself, or its nearest relative a
// bot may set — or null.
export const toTelegramReaction = (emoji) => {
  const normalized = normalizeEmoji(emoji);
  if (TELEGRAM_REACTIONS.has(normalized)) return normalized;
  return relativesOf(normalized).find((relative) => TELEGRAM_REACTIONS.has(relative)) || null;
};

// What to look for in MAX for a Telegram reaction, best first: the emoji
// itself, then its relatives.
export const reactionCandidates = (emoji) => {
  const normalized = normalizeEmoji(emoji);
  if (!normalized) return [];
  return [normalized, ...relativesOf(normalized).filter((relative) => relative !== normalized)];
};
