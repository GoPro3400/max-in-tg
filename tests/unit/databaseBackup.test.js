import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppDatabase } from '../../src/storage/database.js';

// The first start of another version of the bridge copies the database first
// (data/backups/), so a failed update can be rolled back from that copy.

describe('database copy before an upgrade', () => {
  let dir;
  let file;
  const opened = [];
  // For the tests where the copy is meant to fail: the failure is not printed.
  const quiet = { info() {}, warn() {}, error() {} };
  const open = (appVersion, logger) => {
    const db = new AppDatabase(file, appVersion === undefined ? {} : { appVersion, ...(logger ? { logger } : {}) });
    opened.push(db);
    return db;
  };
  // A copy already in the folder, made like the bridge names them, with the
  // database as it is now (closed first, so the file is whole).
  const putCopy = (from, to, stamp) => {
    fs.mkdirSync(path.join(dir, 'backups'), { recursive: true });
    const name = `max-in-tg-${from}-to-${to}-${stamp}.sqlite`;
    fs.copyFileSync(file, path.join(dir, 'backups', name));
    return name;
  };
  const stampNow = () => new Date().toISOString().replace(/[-:.]/g, '');
  const backups = () => {
    const directory = path.join(dir, 'backups');
    return fs.existsSync(directory) ? fs.readdirSync(directory).sort() : [];
  };
  const rowsIn = (name, table = 'chats') => {
    const copy = new Database(path.join(dir, 'backups', name), { readonly: true });
    try {
      return copy.prepare(`SELECT id FROM ${table} ORDER BY id`).all().map((row) => row.id);
    } finally {
      copy.close();
    }
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'max-in-tg-backup-'));
    file = path.join(dir, 'max-in-tg.sqlite');
  });
  afterEach(() => {
    for (const db of opened.splice(0)) {
      try { db.close(); } catch { /* already closed */ }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('makes no copy of a new database, and records the version', () => {
    const db = open('0.2.0');
    expect(backups()).toEqual([]);
    expect(db.getSetting('app_version')).toBe('0.2.0');
    expect(db.storedAppVersion()).toBe('0.2.0');
  });

  it('makes no copy when the version has not changed (an ordinary restart)', () => {
    open('0.2.0').upsertChat({ id: 'Иван', title: 'Иван', metadata: {} });
    opened.pop().close();
    open('0.2.0');
    expect(backups()).toEqual([]);
  });

  it('copies the database, with what it holds, when the version changes', () => {
    const before = open('0.1.0');
    before.upsertChat({ id: 'Иван', title: 'Иван', metadata: {} });
    before.upsertChat({ id: 'Работа', title: 'Работа', metadata: {} });
    before.close();

    const after = open('0.2.0');

    const [name, ...rest] = backups();
    expect(rest).toEqual([]);
    expect(name).toMatch(/^max-in-tg-0\.1\.0-to-0\.2\.0-\d{8}T\d+Z\.sqlite$/);
    expect(rowsIn(name)).toEqual(['Иван', 'Работа']);
    // The copy is what the database was, not what it became.
    const copy = new Database(path.join(dir, 'backups', name), { readonly: true });
    expect(copy.prepare("SELECT value FROM settings WHERE key = 'app_version'").get().value).toBe('"0.1.0"');
    copy.close();
    expect(after.getSetting('app_version')).toBe('0.2.0');
    expect(after.listChats().map((chat) => chat.id)).toEqual(expect.arrayContaining(['Иван', 'Работа']));
  });

  it('copies a database from before versions were recorded, as "unknown"', () => {
    const old = open();
    old.upsertChat({ id: 'Иван', title: 'Иван', metadata: {} });
    old.close();

    open('0.2.0');

    const [name] = backups();
    expect(name).toMatch(/^max-in-tg-unknown-to-0\.2\.0-/);
    expect(rowsIn(name)).toEqual(['Иван']);
  });

  it('copies the newest rows too, even those still in the write-ahead log', () => {
    const first = open('0.1.0');
    first.upsertChat({ id: 'Только что', title: 'Только что', metadata: {} });
    // Not closed, not checkpointed: the row lives in the -wal file, and a plain
    // copy of the .sqlite file would not have it.
    expect(fs.statSync(`${file}-wal`).size).toBeGreaterThan(0);

    open('0.2.0');

    expect(rowsIn(backups()[0])).toEqual(['Только что']);
  });

  it('keeps the newest three copies', () => {
    for (const version of ['0.1.0', '0.2.0', '0.3.0', '0.4.0', '0.5.0', '0.6.0']) {
      open(version).close();
      opened.pop();
    }
    const names = backups();
    expect(names).toHaveLength(3);
    // 0.1.0 was new (no copy); 0.2.0–0.6.0 each made one. The oldest two went.
    expect(names.map((name) => /-(\d\.\d\.\d)-to-(\d\.\d\.\d)-/.exec(name).slice(1, 3).join('>')).sort())
      .toEqual(['0.3.0>0.4.0', '0.4.0>0.5.0', '0.5.0>0.6.0']);
  });

  it('never removes what it did not make, even a copy named much like its own', () => {
    fs.mkdirSync(path.join(dir, 'backups'));
    const byHand = ['my-own-notes.txt', 'max-in-tg-before-my-experiment.sqlite', 'max-in-tg-0.1.0-to-0.2.0.sqlite', 'other-0.1.0-to-0.2.0-20200101T000000000Z.sqlite'];
    for (const name of byHand) fs.writeFileSync(path.join(dir, 'backups', name), 'keep');
    for (const version of ['0.1.0', '0.2.0', '0.3.0', '0.4.0', '0.5.0', '0.6.0']) {
      open(version).close();
      opened.pop();
    }
    expect(backups()).toEqual(expect.arrayContaining(byHand));
    // ... while its own are still kept to three.
    expect(backups().filter((name) => /^max-in-tg-0\.\d\.0-to-0\.\d\.0-\d{8}T\d+Z\.sqlite$/.test(name))).toHaveLength(3);
  });

  it('keeps the first copy of an upgrade whose start keeps failing (a crash loop restarts it and restarts it)', () => {
    const before = open('0.1.0');
    before.upsertChat({ id: 'Иван', title: 'Иван', metadata: {} });
    before.close();
    opened.pop();

    const migrate = vi.spyOn(AppDatabase.prototype, 'migrate').mockImplementation(() => {
      throw new Error('migration failed');
    });
    try {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        expect(() => new AppDatabase(file, { appVersion: '0.2.0' })).toThrow('migration failed');
      }
    } finally {
      migrate.mockRestore();
    }

    // One copy, the first: five would have pushed it out (three are kept).
    const names = backups();
    expect(names).toHaveLength(1);
    expect(rowsIn(names[0])).toEqual(['Иван']);
  });

  it('copies again for the same upgrade after a way back in between (the database has changed since)', () => {
    for (const version of ['0.1.0', '0.2.0', '0.1.0', '0.2.0']) {
      open(version).close();
      opened.pop();
    }
    // 0.1.0→0.2.0, 0.2.0→0.1.0, 0.1.0→0.2.0 again.
    expect(backups().map((name) => /-(\d\.\d\.\d)-to-(\d\.\d\.\d)-/.exec(name).slice(1, 3).join('>')).sort())
      .toEqual(['0.1.0>0.2.0', '0.1.0>0.2.0', '0.2.0>0.1.0']);
  });

  it('starts all the same when the copy cannot be made, and keeps the reason for the owner', () => {
    open('0.1.0').close();
    opened.pop();
    // `backups` is a file, so the folder cannot be made.
    fs.writeFileSync(path.join(dir, 'backups'), 'not a folder');

    let db;
    expect(() => { db = open('0.2.0', quiet); }).not.toThrow();
    expect(db.getSetting('app_version')).toBe('0.2.0');
    expect(db.backupProblem).toEqual(expect.any(String));
  });

  it('never leaves a half-made copy under a name a restore would trust', () => {
    open('0.1.0').close();
    opened.pop();

    // The copy is written, and the move to its name fails (as a kill or a full
    // disk would stop it a step earlier or later).
    const rename = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw new Error('no more room');
    });
    let db;
    try {
      expect(() => { db = open('0.2.0', quiet); }).not.toThrow();
    } finally {
      rename.mockRestore();
    }

    expect(backups()).toEqual([]);
    expect(db.backupProblem).toBe('no more room');
    expect(db.getSetting('app_version')).toBe('0.2.0');
  });

  it('does not keep a copy that came out empty', () => {
    open('0.1.0').close();
    opened.pop();
    const stat = fs.statSync;
    const empty = vi.spyOn(fs, 'statSync').mockImplementation((target, ...rest) => (
      String(target).endsWith('.partial') ? { size: 0 } : stat(target, ...rest)
    ));
    let db;
    try {
      db = open('0.2.0', quiet);
    } finally {
      empty.mockRestore();
    }
    expect(backups()).toEqual([]);
    expect(db.backupProblem).toMatch(/came out empty/);
  });

  it('removes what an earlier try left half done, and an empty copy, and copies', () => {
    const before = open('0.1.0');
    before.upsertChat({ id: 'Иван', title: 'Иван', metadata: {} });
    before.close();
    opened.pop();
    fs.mkdirSync(path.join(dir, 'backups'));
    // A copy that was killed midway, its journal, and an empty copy of this very upgrade.
    fs.writeFileSync(path.join(dir, 'backups', 'max-in-tg-0.1.0-to-0.2.0-20260101T000000000Z.sqlite.partial'), 'half');
    fs.writeFileSync(path.join(dir, 'backups', 'max-in-tg-0.1.0-to-0.2.0-20260101T000000000Z.sqlite.partial-journal'), 'half');
    fs.writeFileSync(path.join(dir, 'backups', `max-in-tg-0.1.0-to-0.2.0-${stampNow()}.sqlite`), '');

    open('0.2.0');

    // The empty one did not count as "already copied": a whole copy was made.
    const names = backups();
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^max-in-tg-0\.1\.0-to-0\.2\.0-\d{8}T\d+Z\.sqlite$/);
    expect(rowsIn(names[0])).toEqual(['Иван']);
  });

  it('copies nothing when there is no room for a copy, and says why', () => {
    open('0.1.0').close();
    opened.pop();
    const statfs = vi.spyOn(fs, 'statfsSync').mockReturnValue({ bavail: 10, bfree: 10, blocks: 100000, bsize: 1024 });
    let db;
    try {
      db = open('0.2.0', quiet);
    } finally {
      statfs.mockRestore();
    }
    expect(backups()).toEqual([]);
    expect(db.backupProblem).toMatch(/not enough free space/);
    expect(db.getSetting('app_version')).toBe('0.2.0');
  });

  it('is not put off by a system that does not say how much room there is', () => {
    open('0.1.0').close();
    opened.pop();
    const statfs = vi.spyOn(fs, 'statfsSync').mockImplementation(() => {
      throw new Error('not supported here');
    });
    try {
      open('0.2.0');
    } finally {
      statfs.mockRestore();
    }
    expect(backups()).toHaveLength(1);
  });

  // A start that fails in its migration, with the connection it leaves open
  // handed back, so that a test can close it before it puts files about.
  const failingStarts = (times, version = '0.2.0') => {
    const leftOpen = [];
    const migrate = vi.spyOn(AppDatabase.prototype, 'migrate').mockImplementation(function failing() {
      leftOpen.push(this);
      throw new Error('migration failed');
    });
    try {
      for (let attempt = 0; attempt < times; attempt += 1) {
        expect(() => new AppDatabase(file, { appVersion: version, logger: quiet })).toThrow('migration failed');
      }
    } finally {
      migrate.mockRestore();
    }
    return { close: () => leftOpen.forEach((db) => db.db.close()) };
  };
  const noteInDatabase = () => {
    const raw = new Database(file, { readonly: true });
    try {
      const row = raw.prepare("SELECT value FROM settings WHERE key = 'upgrade_backup'").get();
      return row ? JSON.parse(row.value) : null;
    } finally {
      raw.close();
    }
  };

  it('does not copy an upgrade again while its start keeps failing, however long that goes on', () => {
    const before = open('0.1.0');
    before.upsertChat({ id: 'Иван', title: 'Иван', metadata: {} });
    before.close();
    opened.pop();

    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const day = 24 * 60 * 60 * 1000;
      const failed = failingStarts(2);
      // Days on (nobody at the server; the container restarts and restarts):
      // still the first copy, which has the database as it was.
      for (let days = 1; days <= 6; days += 1) {
        vi.setSystemTime(Date.now() + day);
        failingStarts(1).close();
      }
      failed.close();
    } finally {
      vi.useRealTimers();
    }

    const names = backups();
    expect(names).toHaveLength(1);
    expect(rowsIn(names[0])).toEqual(['Иван']);
  });

  it('keeps a note of the copy in the database while the upgrade is not through, and drops it when it is', () => {
    open('0.1.0').close();
    opened.pop();

    failingStarts(1).close();
    const [name] = backups();
    expect(noteInDatabase()).toEqual({ from: '0.1.0', to: '0.2.0', file: name });
    // The copy was made before the note, so it does not have it.
    const copy = new Database(path.join(dir, 'backups', name), { readonly: true });
    expect(copy.prepare("SELECT 1 FROM settings WHERE key = 'upgrade_backup'").get()).toBeUndefined();
    copy.close();

    open('0.2.0');
    expect(noteInDatabase()).toBeNull();
  });

  it('copies the same upgrade afresh when the database has been put back from its copy', async () => {
    const before = open('0.1.0');
    before.upsertChat({ id: 'Иван', title: 'Иван', metadata: {} });
    before.close();
    opened.pop();

    const failed = failingStarts(1);
    failed.close();
    const [first] = backups();
    // The documented way back: the copy over the database, its -wal and -shm gone.
    fs.rmSync(`${file}-wal`, { force: true });
    fs.rmSync(`${file}-shm`, { force: true });
    fs.copyFileSync(path.join(dir, 'backups', first), file);
    await new Promise((resolve) => { setTimeout(resolve, 5); });

    // The old version ran on it, and the upgrade is tried again: the database
    // is not what the first copy has, and this copy has to be made.
    open('0.2.0');

    const names = backups();
    expect(names).toHaveLength(2);
    expect(names).toContain(first);
  });

  it('copies another upgrade, even while the first is not through', () => {
    open('0.1.0').close();
    opened.pop();

    failingStarts(1).close();
    // Not 0.2.0 after all: 0.3.0 is tried on the same database.
    open('0.3.0');

    expect(backups().map((name) => /-(\d\.\d\.\d)-to-(\d\.\d\.\d)-/.exec(name).slice(1, 3).join('>')).sort())
      .toEqual(['0.1.0>0.2.0', '0.1.0>0.3.0']);
  });

  it('does not take a note that could not be made for a copy that could not be made', () => {
    open('0.1.0').close();
    opened.pop();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const note = vi.spyOn(AppDatabase.prototype, 'rememberUpgradeBackup').mockImplementation(() => {
      throw new Error('database is locked');
    });
    let db;
    try {
      db = open('0.2.0', logger);
    } finally {
      note.mockRestore();
    }
    expect(backups()).toHaveLength(1);
    expect(db.backupProblem).toBeNull();
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('copies the same upgrade again when the earlier copy is gone', () => {
    open('0.1.0').close();
    opened.pop();

    failingStarts(1).close();
    for (const name of backups()) fs.rmSync(path.join(dir, 'backups', name));
    failingStarts(1).close();

    expect(backups()).toHaveLength(1);
  });

  it('keeps the copy it has just made, even when the clock has been set back', () => {
    open('0.1.0').close();
    opened.pop();
    // Three copies that say they are from the far future.
    const future = ['20990101T000000000Z', '20990102T000000000Z', '20990103T000000000Z'].map((stamp) => putCopy('0.0.1', '0.0.2', stamp));

    const db = open('0.2.0');

    const names = backups();
    expect(names).toHaveLength(3);
    expect(names.some((name) => /-0\.1\.0-to-0\.2\.0-/.test(name))).toBe(true);
    expect(names).toEqual(expect.arrayContaining(future.slice(1)));
    expect(db.backupProblem).toBeNull();
  });

  it('does not name a copy that does not check out', () => {
    open('0.1.0').close();
    opened.pop();
    const pragma = Database.prototype.pragma;
    const garbled = vi.spyOn(Database.prototype, 'pragma').mockImplementation(function check(source, options) {
      return String(source).startsWith('quick_check') ? '*** in database main ***\nPage 3: never used' : pragma.call(this, source, options);
    });
    let db;
    try {
      db = open('0.2.0', quiet);
    } finally {
      garbled.mockRestore();
    }
    expect(backups()).toEqual([]);
    expect(db.backupProblem).toMatch(/does not check out/);
    expect(db.getSetting('app_version')).toBe('0.2.0');
  });

  it('puts the copy on the disk before it names it', () => {
    open('0.1.0').close();
    opened.pop();
    const sync = vi.spyOn(fs, 'fsyncSync');
    let syncs;
    try {
      open('0.2.0');
      syncs = sync.mock.calls.length;
    } finally {
      sync.mockRestore();
    }
    // The copy itself and, after the rename, the folder.
    expect(syncs).toBeGreaterThanOrEqual(2);
  });

  it('is not put off by a file system that reports no sizes at all, but is by one that is full', () => {
    open('0.1.0').close();
    opened.pop();
    const zeros = vi.spyOn(fs, 'statfsSync').mockReturnValue({ bavail: 0, bfree: 0, blocks: 0, bsize: 4096 });
    try {
      open('0.2.0');
    } finally {
      zeros.mockRestore();
    }
    expect(backups()).toHaveLength(1);

    opened.pop().close();
    open('0.3.0').close();
    opened.pop();
    const full = vi.spyOn(fs, 'statfsSync').mockReturnValue({ bavail: 0, bfree: 0, blocks: 1000, bsize: 4096 });
    let db;
    try {
      db = open('0.4.0', quiet);
    } finally {
      full.mockRestore();
    }
    expect(db.backupProblem).toMatch(/not enough free space/);
  });

  it('logs through the logger it is given', () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    open('0.1.0', logger).close();
    opened.pop();
    open('0.2.0', logger);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ from: '0.1.0', to: '0.2.0', backup: expect.stringContaining('backups') }),
      'Backed up the database before the upgrade'
    );
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('does nothing for an in-memory database', () => {
    const db = new AppDatabase(':memory:', { appVersion: '0.2.0' });
    expect(db.getSetting('app_version')).toBe('0.2.0');
    db.close();
    expect(backups()).toEqual([]);
  });

  it('records no version, and makes no copy, when none is given (tests, scripts)', () => {
    open().upsertChat({ id: 'Иван', title: 'Иван', metadata: {} });
    opened.pop().close();
    const db = open();
    expect(db.getSetting('app_version')).toBeNull();
    expect(backups()).toEqual([]);
  });
});
