import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { AppDatabase } from '../../src/storage/database.js';

// Tests for the message_deliveries legacy-FK rebuild in AppDatabase.migrate():
// the legacy table carried FOREIGN KEY(message_id) REFERENCES messages(id),
// which the current schema dropped. SQLite cannot remove a constraint in
// place, so migrate() renames the old table aside, creates the FK-less one,
// and copies the rows over — crash-safe across the rename/copy boundary.

const LEGACY_DELIVERIES_SQL = `
  CREATE TABLE %NAME% (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id TEXT NOT NULL,
    direction TEXT NOT NULL CHECK(direction IN ('max_to_tg', 'tg_to_max')),
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'sent', 'failed')),
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    FOREIGN KEY(message_id) REFERENCES messages(id) ON DELETE CASCADE
  )
`;

// Base tables a legacy database would already have. They must match the
// CREATE TABLE IF NOT EXISTS statements in migrate() closely enough for
// prepare() to work; the three ALTER-added messages columns are deliberately
// omitted to simulate a genuinely old file (migrate() adds them).
const LEGACY_BASE_SCHEMA = `
  CREATE TABLE chats (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    last_seen_at INTEGER,
    selected INTEGER NOT NULL DEFAULT 0,
    metadata TEXT NOT NULL DEFAULT '{}'
  );

  CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL,
    direction TEXT NOT NULL CHECK(direction IN ('max_to_tg', 'tg_to_max')),
    type TEXT NOT NULL,
    text TEXT,
    media_path TEXT,
    media_url TEXT,
    source_message_id TEXT,
    created_at INTEGER NOT NULL,
    metadata TEXT NOT NULL DEFAULT '{}',
    FOREIGN KEY(chat_id) REFERENCES chats(id) ON DELETE CASCADE
  );
`;

const LEGACY_ROWS = [
  { id: 1, message_id: 'm1', direction: 'max_to_tg', status: 'pending', attempts: 0, last_error: null, created_at: 1000, updated_at: 1000 },
  { id: 5, message_id: 'm2', direction: 'tg_to_max', status: 'sent', attempts: 1, last_error: null, created_at: 2000, updated_at: 2500 },
  { id: 9, message_id: 'm3', direction: 'max_to_tg', status: 'failed', attempts: 2, last_error: 'boom', created_at: 3000, updated_at: 3500 }
];

function seedBase(raw) {
  raw.exec(LEGACY_BASE_SCHEMA);
  raw.prepare("INSERT INTO chats (id, title) VALUES ('c1', 'Chat One')").run();
  const insertMessage = raw.prepare(
    "INSERT INTO messages (id, chat_id, direction, type, created_at) VALUES (?, 'c1', 'max_to_tg', 'text', 1000)"
  );
  for (const id of ['m1', 'm2', 'm3']) insertMessage.run(id);
}

function insertLegacyRows(raw, tableName) {
  const insert = raw.prepare(`
    INSERT INTO ${tableName} (id, message_id, direction, status, attempts, last_error, created_at, updated_at)
    VALUES (@id, @message_id, @direction, @status, @attempts, @last_error, @created_at, @updated_at)
  `);
  for (const row of LEGACY_ROWS) insert.run(row);
}

// Builds a pre-migration database file: base schema, three messages, and a
// message_deliveries table whose CREATE SQL still contains the FOREIGN KEY.
function buildLegacyDbFile(dbPath) {
  const raw = new Database(dbPath);
  try {
    seedBase(raw);
    raw.exec(LEGACY_DELIVERIES_SQL.replace('%NAME%', 'message_deliveries'));
    insertLegacyRows(raw, 'message_deliveries');
  } finally {
    raw.close();
  }
}

// Simulates a crash between the rename and the create: the file has
// message_deliveries_legacy (with rows) and NO message_deliveries at all.
function buildCrashedDbFile(dbPath) {
  const raw = new Database(dbPath);
  try {
    seedBase(raw);
    raw.exec(LEGACY_DELIVERIES_SQL.replace('%NAME%', 'message_deliveries_legacy'));
    insertLegacyRows(raw, 'message_deliveries_legacy');
  } finally {
    raw.close();
  }
}

const getTableSql = (db, name) =>
  db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(name);

const dumpDeliveries = (db) =>
  db.prepare('SELECT id, message_id, direction, status, attempts, last_error, created_at, updated_at FROM message_deliveries ORDER BY id').all();

describe('AppDatabase.migrate — message_deliveries legacy-FK rebuild', () => {
  let tmpDir;
  let dbPath;
  let handles;

  const open = (Ctor, ...args) => {
    const handle = new Ctor(...args);
    handles.push(handle);
    return handle;
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-'));
    dbPath = path.join(tmpDir, 'bridge.sqlite');
    handles = [];
  });

  afterEach(() => {
    for (const handle of handles) {
      try {
        handle.close();
      } catch {
        // already closed by the test
      }
    }
    // Windows keeps -wal/-shm locks around briefly; retry the removal.
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('rebuilds a legacy FK table, preserving every row, id, status and attempt count', () => {
    buildLegacyDbFile(dbPath);

    const app = open(AppDatabase, dbPath);

    expect(dumpDeliveries(app.db)).toEqual(LEGACY_ROWS);

    const master = getTableSql(app.db, 'message_deliveries');
    expect(master).toBeTruthy();
    expect(master.sql).not.toContain('FOREIGN KEY');

    expect(getTableSql(app.db, 'message_deliveries_legacy')).toBeUndefined();
  });

  it('gives the rebuilt table its indexes back (the renamed legacy table kept their names)', () => {
    buildLegacyDbFile(dbPath);
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE INDEX idx_deliveries_status ON message_deliveries(status);
      CREATE INDEX idx_deliveries_message ON message_deliveries(message_id);
    `);
    raw.close();

    const app = open(AppDatabase, dbPath);

    const indexes = app.db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='message_deliveries'").all().map((row) => row.name);
    expect(indexes).toEqual(expect.arrayContaining(['idx_deliveries_status', 'idx_deliveries_message']));
    expect(dumpDeliveries(app.db)).toEqual(LEGACY_ROWS);
  });

  it('continues AUTOINCREMENT strictly above the max preserved id after the rebuild', () => {
    buildLegacyDbFile(dbPath);

    const app = open(AppDatabase, dbPath);
    const newId = app.createDelivery('m1', 'max_to_tg');

    expect(newId).toBeGreaterThan(9);
    const row = app.db.prepare('SELECT message_id, status, attempts FROM message_deliveries WHERE id = ?').get(newId);
    expect(row).toEqual({ message_id: 'm1', status: 'pending', attempts: 0 });
    // The preserved rows are still all there alongside the new one.
    expect(app.db.prepare('SELECT COUNT(*) AS n FROM message_deliveries').get().n).toBe(LEGACY_ROWS.length + 1);
  });

  it('leaves a modern FK-less table untouched on reopen (no rename, rows unchanged)', () => {
    const first = open(AppDatabase, dbPath);
    const idA = first.createDelivery('m-a', 'max_to_tg');
    const idB = first.createDelivery('m-b', 'tg_to_max');
    first.updateDeliveryStatus(idB, 'sent');
    const before = dumpDeliveries(first.db);
    expect(before).toHaveLength(2);
    // rootpage identifies the physical b-tree: a rebuild (rename+create+copy)
    // allocates a new one, a plain reopen never touches it. This is what
    // actually proves "no rename happened" — the rebuild itself is lossless,
    // so row equality alone would pass even if migrate() rebuilt every boot.
    const rootpageBefore = first.db
      .prepare("SELECT rootpage FROM sqlite_master WHERE type='table' AND name='message_deliveries'").get().rootpage;
    first.close();

    const second = open(AppDatabase, dbPath);
    expect(dumpDeliveries(second.db)).toEqual(before);
    expect(getTableSql(second.db, 'message_deliveries_legacy')).toBeUndefined();
    expect(getTableSql(second.db, 'message_deliveries').sql).not.toContain('FOREIGN KEY');
    expect(
      second.db.prepare("SELECT rootpage FROM sqlite_master WHERE type='table' AND name='message_deliveries'").get().rootpage
    ).toBe(rootpageBefore);

    // Delivery stats still see exactly the original rows: one pending, one sent.
    const stats = Object.fromEntries(second.getDeliveryStats().map((r) => [r.status, r.count]));
    expect(stats).toEqual({ pending: 1, sent: 1 });
    // Sanity: the ids created before the reopen were the ones preserved.
    expect(before.map((r) => r.id)).toEqual([idA, idB]);
  });

  it('resumes the copy when a crash left only message_deliveries_legacy behind', () => {
    buildCrashedDbFile(dbPath);

    const app = open(AppDatabase, dbPath);

    expect(dumpDeliveries(app.db)).toEqual(LEGACY_ROWS);
    expect(getTableSql(app.db, 'message_deliveries_legacy')).toBeUndefined();
    expect(getTableSql(app.db, 'message_deliveries').sql).not.toContain('FOREIGN KEY');
  });

  it('is idempotent: a second open over an already-migrated file changes nothing', () => {
    buildLegacyDbFile(dbPath);

    const first = open(AppDatabase, dbPath);
    const rowsAfterFirst = dumpDeliveries(first.db);
    const sqlAfterFirst = getTableSql(first.db, 'message_deliveries').sql;
    expect(rowsAfterFirst).toEqual(LEGACY_ROWS);
    first.close();

    const second = open(AppDatabase, dbPath);
    expect(dumpDeliveries(second.db)).toEqual(rowsAfterFirst);
    expect(getTableSql(second.db, 'message_deliveries').sql).toBe(sqlAfterFirst);
    expect(getTableSql(second.db, 'message_deliveries_legacy')).toBeUndefined();
    // And the AUTOINCREMENT counter survived both opens.
    expect(second.createDelivery('m2', 'tg_to_max')).toBeGreaterThan(9);
  });
});
