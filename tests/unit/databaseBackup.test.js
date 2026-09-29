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
  const open = (appVersion) => {
    const db = new AppDatabase(file, appVersion === undefined ? {} : { appVersion });
    opened.push(db);
    return db;
  };
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

  it('starts all the same when the copy cannot be made', () => {
    open('0.1.0').close();
    opened.pop();
    // `backups` is a file, so the folder cannot be made.
    fs.writeFileSync(path.join(dir, 'backups'), 'not a folder');

    let db;
    expect(() => { db = open('0.2.0'); }).not.toThrow();
    expect(db.getSetting('app_version')).toBe('0.2.0');
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
