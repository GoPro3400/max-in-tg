import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

/**
 * Sanitize a string for use as a filename.
 * Replaces non-word characters (except dot and hyphen) with underscores.
 */
export const safeName = (value, maxLength = 180) =>
  String(value || 'file')
    .replace(/[^\w.-]+/g, '_')
    .replace(/\.{2,}/g, '.')
    .replace(/^[.-]+/, '')
    .slice(0, maxLength) || 'file';

/**
 * The human part of a file name, as it should be shown to the recipient:
 * invisible format characters removed (bidi isolates and marks that web UIs
 * wrap names in — "report.pdf\u2069" no longer ends in ".pdf", so Telegram
 * clients appended the extension again: "report.pdf.pdf"), whitespace
 * collapsed, and an extension that is already doubled reduced to one.
 */
export const cleanDisplayName = (value) => String(value ?? '')
  .normalize('NFC')
  .replace(/\p{Cf}+/gu, '')
  .replace(/\s+/g, ' ')
  .trim()
  .replace(/(\.[\p{L}\p{N}]{1,10})(?:\1)+$/iu, '$1');

/**
 * The name a document is delivered under: the cleaned original name, with the
 * real file's extension added when the name has none (a bare "Договор" is
 * opened as an unknown file type), or the file's own name as a fallback.
 */
export const documentDisplayName = (originalName, filePath = '') => {
  const name = cleanDisplayName(originalName);
  const fileExt = path.extname(filePath || '');
  if (!name) return path.basename(filePath || '') || 'file';
  if (!path.extname(name) && fileExt) return `${name}${fileExt}`;
  return name;
};

// Filesystems cap a name at 255 BYTES, and a Cyrillic character is two of
// them in UTF-8; leave room for the prefixes some callers add.
const MAX_DISPLAY_NAME_BYTES = 200;

/**
 * Sanitize a file name that a person will see (a document sent to a MAX or
 * Telegram contact). Unlike safeName it keeps letters and digits of every
 * script — safeName turns "Договор.pdf" into "_.pdf", so every Cyrillic name
 * looked the same and collided — and it keeps the extension when shortening.
 * Separators, control/format characters (e.g. right-to-left overrides) and
 * leading dots are still removed, so the result cannot leave its directory.
 */
export const safeDisplayName = (value, maxLength = 180) => {
  const cleaned = cleanDisplayName(value)
    .replace(/[^\p{L}\p{M}\p{N}_.-]+/gu, '_')
    .replace(/\.{2,}/g, '.')
    .replace(/^[._-]+/, '');
  if (!cleaned || !cleaned.replace(/[._-]/g, '')) return 'file';

  const ext = path.extname(cleaned);
  const keepExt = ext.length > 1 && ext.length <= 16 && ext.length < cleaned.length;
  const extPart = keepExt ? ext : '';
  const stem = Array.from(keepExt ? cleaned.slice(0, -ext.length) : cleaned)
    .slice(0, Math.max(1, maxLength - extPart.length));
  while (stem.length && Buffer.byteLength(stem.join('') + extPart) > MAX_DISPLAY_NAME_BYTES) stem.pop();
  return stem.length ? stem.join('') + extPart : 'file';
};

/**
 * List files in a directory sorted by modification time (newest first).
 * Returns array of { name, path, mtimeMs }.
 */
export const listFilesByMtime = async (dir) => {
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  const files = await Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map(async (entry) => {
        const filePath = path.join(dir, entry.name);
        const stat = await fsp.stat(filePath);
        return { name: entry.name, path: filePath, mtimeMs: stat.mtimeMs };
      })
  );
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs);
};

/**
 * Save a buffer to a file, creating parent directories as needed.
 * Returns the absolute file path.
 */
export const saveBuffer = (dir, filename, buffer) => {
  const filePath = path.join(dir, filename);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, buffer);
  return filePath;
};

/**
 * Replace the extension of a file path.
 */
export const replaceExtension = (filePath, extension) => {
  const cleanExtension = extension.startsWith('.') ? extension : `.${extension}`;
  return path.join(
    path.dirname(filePath),
    `${path.basename(filePath, path.extname(filePath))}${cleanExtension}`
  );
};
