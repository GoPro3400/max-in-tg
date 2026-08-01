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
