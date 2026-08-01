import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { safeName, listFilesByMtime, saveBuffer, replaceExtension } from '../../src/utils/fileHelpers.js';

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
