import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { safeName, safeDisplayName, cleanDisplayName, documentDisplayName, listFilesByMtime, saveBuffer, replaceExtension } from '../../src/utils/fileHelpers.js';

describe('safeName', () => {
  it('replaces non-word characters with underscores', () => {
    expect(safeName('hello world/foo:bar')).toBe('hello_world_foo_bar');
  });

  it('uses default when value is empty', () => {
    expect(safeName('')).toBe('file');
    expect(safeName(null)).toBe('file');
  });

  it('truncates to maxLength', () => {
    const long = 'a'.repeat(300);
    expect(safeName(long, 80).length).toBe(80);
  });

  it('preserves dots and hyphens', () => {
    expect(safeName('my-file.2024.png')).toBe('my-file.2024.png');
  });
});

describe('safeDisplayName', () => {
  it('keeps Cyrillic and other scripts instead of collapsing them to "_"', () => {
    expect(safeDisplayName('Договор.pdf')).toBe('Договор.pdf');
    expect(safeDisplayName('Счёт на оплату.pdf')).toBe('Счёт_на_оплату.pdf');
    expect(safeDisplayName('報告書.docx')).toBe('報告書.docx');
    // Two different names must stay different (safeName made both "_.pdf").
    expect(safeDisplayName('Договор.pdf')).not.toBe(safeDisplayName('Счёт.pdf'));
  });

  it('cannot escape its directory or hide the real extension', () => {
    expect(safeDisplayName('../../etc/passwd')).toBe('etc_passwd');
    expect(safeDisplayName('..\\..\\win.ini')).toBe('win.ini');
    expect(safeDisplayName('.env')).toBe('env');
    // U+202E RIGHT-TO-LEFT OVERRIDE makes "invoice<RLO>fdp.exe" display as "invoiceexe.pdf".
    expect(safeDisplayName('invoice\u202Efdp.exe')).toBe('invoicefdp.exe');
  });

  it('falls back to "file" for empty or punctuation-only names', () => {
    expect(safeDisplayName('')).toBe('file');
    expect(safeDisplayName(null)).toBe('file');
    expect(safeDisplayName('...')).toBe('file');
    expect(safeDisplayName('!!!')).toBe('file');
  });

  it('shortens long names by bytes, keeping the extension', () => {
    const name = safeDisplayName(`${'Я'.repeat(300)}.pdf`);
    expect(name.endsWith('.pdf')).toBe(true);
    expect(Buffer.byteLength(name)).toBeLessThanOrEqual(200);
    expect(safeDisplayName(`${'a'.repeat(300)}.jpg`, 80)).toHaveLength(80);
  });
});

describe('document display names (MAX -> Telegram)', () => {
  it('drops the invisible bidi characters web UIs wrap names in, so the extension is seen again', () => {
    // "\u2068Договор.pdf\u2069" ends in ".pdf\u2069": Telegram clients did
    // not recognise the extension and appended it: "Договор.pdf.pdf".
    expect(cleanDisplayName('\u2068Договор.pdf\u2069')).toBe('Договор.pdf');
    expect(cleanDisplayName('Отчёт.pdf\u200e')).toBe('Отчёт.pdf');
  });

  it('reduces an already doubled extension to one', () => {
    expect(cleanDisplayName('Счёт.pdf.pdf')).toBe('Счёт.pdf');
    expect(cleanDisplayName('photo.JPG.jpg')).toBe('photo.JPG');
    expect(cleanDisplayName('archive.tar.gz')).toBe('archive.tar.gz');
  });

  it('adds the real extension to a bare name and falls back to the file name', () => {
    expect(documentDisplayName('Договор', '/tmp/doc-1/document.pdf')).toBe('Договор.pdf');
    expect(documentDisplayName('  ', '/tmp/x/1790-max-document.docx')).toBe('1790-max-document.docx');
    expect(documentDisplayName(null, '')).toBe('file');
    expect(documentDisplayName('Договор.pdf', '/tmp/x/1790-max-document')).toBe('Договор.pdf');
  });
});

describe('replaceExtension', () => {
  // path.format emits platform separators, so normalize the expectations —
  // these tests run both in the Linux container and on Windows checkouts.
  it('replaces extension', () => {
    expect(replaceExtension('/tmp/file.ogg', 'mp3')).toBe(path.normalize('/tmp/file.mp3'));
  });

  it('handles dot prefix', () => {
    expect(replaceExtension('/tmp/file.ogg', '.mp3')).toBe(path.normalize('/tmp/file.mp3'));
  });

  it('adds extension to file without one', () => {
    expect(replaceExtension('/tmp/file', 'png')).toBe(path.normalize('/tmp/file.png'));
  });
});

describe('saveBuffer', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-save-'));
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it('writes buffer and returns path', () => {
    const buf = Buffer.from('hello');
    const result = saveBuffer(tmpDir, 'test.txt', buf);
    expect(result).toBe(path.join(tmpDir, 'test.txt'));
    expect(fs.readFileSync(result, 'utf8')).toBe('hello');
  });

  it('creates nested directories', () => {
    const nested = path.join(tmpDir, 'sub');
    const buf = Buffer.from('data');
    const result = saveBuffer(nested, 'file.bin', buf);
    expect(fs.existsSync(result)).toBe(true);
  });
});

describe('listFilesByMtime', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-list-'));
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns files sorted by mtime descending', async () => {
    fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'a');
    await new Promise((r) => setTimeout(r, 50));
    fs.writeFileSync(path.join(tmpDir, 'b.txt'), 'b');

    const files = await listFilesByMtime(tmpDir);
    expect(files.length).toBe(2);
    expect(files[0].name).toBe('b.txt');
    expect(files[1].name).toBe('a.txt');
  });

  it('returns empty array for non-existent directory', async () => {
    const files = await listFilesByMtime('/nonexistent-dir-xyz');
    expect(files).toEqual([]);
  });
});
