import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import sharp from 'sharp';
import { MediaService } from '../../src/services/mediaService.js';
import { hammingHex } from '../../src/services/bridge.js';

// Builds a PNG buffer with a horizontal or vertical grayscale gradient.
// A horizontal gradient makes every dHash bit "left < right" (all ones); a
// vertical gradient makes adjacent horizontal pixels equal (all zeros).
function gradientPng(width, height, horizontal) {
  const channels = 3;
  const data = Buffer.alloc(width * height * channels);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = horizontal
        ? Math.floor((255 * x) / (width - 1))
        : Math.floor((255 * y) / (height - 1));
      const i = (y * width + x) * channels;
      data[i] = v; data[i + 1] = v; data[i + 2] = v;
    }
  }
  return sharp(data, { raw: { width, height, channels } }).png().toBuffer();
}

describe('MediaService', () => {
  let mediaDir;
  let service;

  beforeEach(() => {
    mediaDir = path.join(os.tmpdir(), `media-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    service = new MediaService(mediaDir);
  });

  afterEach(async () => {
    await fsp.rm(mediaDir, { recursive: true, force: true });
  });

  describe('constructor', () => {
    it('creates the media directory', () => {
      expect(fs.existsSync(mediaDir)).toBe(true);
    });

    it('handles existing directory', () => {
      const service2 = new MediaService(mediaDir);
      expect(fs.existsSync(mediaDir)).toBe(true);
    });
  });

  describe('safeFilename', () => {
    it('replaces special characters with underscores', () => {
      expect(service.safeFilename('file name!@#$.jpg')).toBe('file_name_.jpg');
    });

    it('preserves dots and hyphens', () => {
      expect(service.safeFilename('my-file.test.jpg')).toBe('my-file.test.jpg');
    });

    it('truncates long names to 180 chars', () => {
      const longName = 'a'.repeat(200) + '.jpg';
      const result = service.safeFilename(longName);
      expect(result.length).toBeLessThanOrEqual(180);
    });

    it('handles empty string', () => {
      expect(service.safeFilename('')).toBe('file');
    });

    it('collapses consecutive special chars', () => {
      expect(service.safeFilename('a   b   c.txt')).toBe('a_b_c.txt');
    });

    it('preserves underscores', () => {
      expect(service.safeFilename('my_file_name.txt')).toBe('my_file_name.txt');
    });
  });

  describe('inferMime', () => {
    it('returns correct mime for jpg', () => {
      expect(service.inferMime('photo.jpg')).toBe('image/jpeg');
    });

    it('returns correct mime for png', () => {
      expect(service.inferMime('image.png')).toBe('image/png');
    });

    it('returns correct mime for mp4', () => {
      expect(service.inferMime('video.mp4')).toBe('video/mp4');
    });

    it('returns correct mime for ogg', () => {
      expect(service.inferMime('voice.ogg')).toBe('audio/ogg');
    });

    it('returns correct mime for pdf', () => {
      expect(service.inferMime('document.pdf')).toBe('application/pdf');
    });

    it('returns octet-stream for unknown extensions', () => {
      expect(service.inferMime('file.xyz123')).toBe('application/octet-stream');
    });

    it('handles paths with directories', () => {
      expect(service.inferMime('/tmp/media/photo.jpg')).toBe('image/jpeg');
    });
  });

  describe('ensureMaxCompatible', () => {
    it('returns input path for voice type', async () => {
      const result = await service.ensureMaxCompatible('/tmp/voice.ogg', 'voice');
      expect(result).toBe('/tmp/voice.ogg');
    });

    it('returns input path for unknown type', async () => {
      const result = await service.ensureMaxCompatible('/tmp/file.bin', 'document');
      expect(result).toBe('/tmp/file.bin');
    });
  });

  describe('ensureTelegramCompatible', () => {
    it('returns input path for photo type', async () => {
      const result = await service.ensureTelegramCompatible('/tmp/photo.jpg', 'photo');
      expect(result).toBe('/tmp/photo.jpg');
    });

    it('returns input path for document type', async () => {
      const result = await service.ensureTelegramCompatible('/tmp/doc.pdf', 'document');
      expect(result).toBe('/tmp/doc.pdf');
    });

    it('returns input path for text type', async () => {
      const result = await service.ensureTelegramCompatible('/tmp/file.txt', 'text');
      expect(result).toBe('/tmp/file.txt');
    });
  });

  describe('cleanupOlderThan', () => {
    it('removes files older than maxAgeMs', async () => {
      const oldFile = path.join(mediaDir, 'old.txt');
      await fsp.writeFile(oldFile, 'old');
      // Set mtime to 2 hours ago
      const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000);
      await fsp.utimes(oldFile, twoHoursAgo, twoHoursAgo);

      const newFile = path.join(mediaDir, 'new.txt');
      await fsp.writeFile(newFile, 'new');

      await service.cleanupOlderThan(3600 * 1000); // 1 hour

      expect(fs.existsSync(oldFile)).toBe(false);
      expect(fs.existsSync(newFile)).toBe(true);
    });

    it('keeps files newer than maxAgeMs', async () => {
      const recentFile = path.join(mediaDir, 'recent.txt');
      await fsp.writeFile(recentFile, 'recent');

      await service.cleanupOlderThan(3600 * 1000);
      expect(fs.existsSync(recentFile)).toBe(true);
    });

    it('handles empty directory', async () => {
      await expect(service.cleanupOlderThan(1000)).resolves.toBeUndefined();
    });

    it('ignores subdirectories', async () => {
      const subDir = path.join(mediaDir, 'subdir');
      await fsp.mkdir(subDir);
      // Should not throw
      await expect(service.cleanupOlderThan(0)).resolves.toBeUndefined();
      expect(fs.existsSync(subDir)).toBe(true);
    });
  });

  describe('downloadUrl', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('downloads into mediaDir, naming the file from preferredName and the URL extension', async () => {
      const { Readable } = await import('node:stream');
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        headers: { get: () => null },
        // A Node Readable (no getReader) exercises the non-web-stream branch.
        body: Readable.from([Buffer.from('hello-bytes')])
      }));

      const target = await service.downloadUrl('https://example.com/photo.jpg?r=token', 'test-photo');

      expect(path.dirname(target)).toBe(path.resolve(mediaDir));
      expect(path.basename(target)).toContain('test-photo');
      expect(target.endsWith('.jpg')).toBe(true);
      expect(await fsp.readFile(target, 'utf8')).toBe('hello-bytes');
    });

    it('rejects non-http(s) URLs without calling fetch', async () => {
      const mockFetch = vi.fn();
      vi.stubGlobal('fetch', mockFetch);

      await expect(service.downloadUrl('file:///etc/passwd', 'x')).rejects.toThrow(/disallowed scheme/);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('throws on a non-OK response and leaves no file behind', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        statusText: 'Forbidden',
        headers: { get: () => null },
        body: null
      }));

      await expect(service.downloadUrl('https://example.com/gone.jpg', 'gone')).rejects.toThrow(/403/);
      const leftovers = (await fsp.readdir(mediaDir)).filter((name) => name.includes('gone'));
      expect(leftovers).toEqual([]);
    });
  });

  describe('imageDHash', () => {
    it('returns a 16-char hex hash', async () => {
      const hash = await service.imageDHash(await gradientPng(64, 64, true));
      expect(hash).toMatch(/^[0-9a-f]{16}$/);
    });

    it('is resolution-independent for the same image', async () => {
      const full = await service.imageDHash(await gradientPng(512, 512, true));
      const thumb = await service.imageDHash(await gradientPng(90, 90, true));
      expect(hammingHex(full, thumb)).toBeLessThanOrEqual(4);
    });

    it('differs sharply for different images', async () => {
      const horizontal = await service.imageDHash(await gradientPng(256, 256, true));
      const vertical = await service.imageDHash(await gradientPng(256, 256, false));
      expect(hammingHex(horizontal, vertical)).toBeGreaterThanOrEqual(16);
    });
  });

  // Identity for media that has no perceptual hash (voice, video, documents).
  // MAX regenerates its signed CDN URLs on every page load, so without a stable
  // hash these types were re-forwarded to Telegram after every restart — the
  // photo-only version of this guard is what left them unprotected.
  describe('fileContentHash', () => {
    it('is identical for identical bytes and differs for different bytes', async () => {
      const a = path.join(mediaDir, 'a.ogg');
      const b = path.join(mediaDir, 'b.ogg');
      const c = path.join(mediaDir, 'c.ogg');
      await fsp.writeFile(a, Buffer.from('voice-payload'));
      await fsp.writeFile(b, Buffer.from('voice-payload'));
      await fsp.writeFile(c, Buffer.from('different-payload'));

      const hashA = await service.fileContentHash(a);
      expect(hashA).toMatch(/^[0-9a-f]{32}$/);
      expect(await service.fileContentHash(b)).toBe(hashA);
      expect(await service.fileContentHash(c)).not.toBe(hashA);
    });

    it('returns null for a directory, a missing path, or no path', async () => {
      const dir = path.join(mediaDir, 'sticker-frames-1');
      await fsp.mkdir(dir, { recursive: true });
      expect(await service.fileContentHash(dir)).toBeNull();
      expect(await service.fileContentHash(path.join(mediaDir, 'nope.bin'))).toBeNull();
      expect(await service.fileContentHash(null)).toBeNull();
    });
  });
});
