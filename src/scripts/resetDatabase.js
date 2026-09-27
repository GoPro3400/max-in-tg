import fs from 'node:fs/promises';
import { config } from '../config.js';

// SQLite in WAL mode keeps recent writes in "-wal" (and an index in "-shm")
// next to the database file. Leaving them behind after deleting the database
// could bring old rows back into — or corrupt — the fresh one.
for (const suffix of ['', '-wal', '-shm', '-journal']) {
  await fs.rm(`${config.sqlitePath}${suffix}`, { force: true });
}
console.log(`Removed ${config.sqlitePath} (with its -wal/-shm files)`);
