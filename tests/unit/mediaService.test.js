import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import sharp from 'sharp';
import { MediaService, redactUrl, isPrivateAddress } from '../../src/services/mediaService.js';
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
    // No real DNS in unit tests: every host resolves to a public address
    // unless a test says otherwise.
    service = new MediaService(mediaDir, { lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]) });
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

    it("reclaims old per-message temp directories but never Chromium's downloads folder", async () => {
      const old = new Date(Date.now() - 2 * 3600 * 1000);
      for (const name of ['tg-abc123', 'doc-0123abcd', 'sticker-frames-xyz', 'downloads']) {
        const dir = path.join(mediaDir, name);
        await fsp.mkdir(dir);
        await fsp.writeFile(path.join(dir, 'f.bin'), 'x');
        await fsp.utimes(dir, old, old);
      }

      await service.cleanupOlderThan(3600 * 1000);

      expect(fs.existsSync(path.join(mediaDir, 'tg-abc123'))).toBe(false);
      expect(fs.existsSync(path.join(mediaDir, 'doc-0123abcd'))).toBe(false);
      expect(fs.existsSync(path.join(mediaDir, 'sticker-frames-xyz'))).toBe(false);
      expect(fs.existsSync(path.join(mediaDir, 'downloads', 'f.bin'))).toBe(true);
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

    it('refuses plain http and private or loopback hosts without fetching', async () => {
      const mockFetch = vi.fn();
      vi.stubGlobal('fetch', mockFetch);

      await expect(service.downloadUrl('http://example.com/a.jpg', 'x')).rejects.toThrow(/disallowed scheme/);
      await expect(service.downloadUrl('https://127.0.0.1:9222/json', 'x')).rejects.toThrow(/non-public/);
      await expect(service.downloadUrl('https://[::1]/x', 'x')).rejects.toThrow(/non-public/);
      service.lookup.mockResolvedValueOnce([{ address: '169.254.169.254', family: 4 }]);
      await expect(service.downloadUrl('https://metadata.internal/latest', 'x')).rejects.toThrow(/non-public/);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('checks every redirect hop, so a public URL cannot bounce to an internal one', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 302,
        statusText: 'Found',
        headers: { get: (name) => (name === 'location' ? 'https://10.0.0.5/secret' : null) },
        body: null
      });
      vi.stubGlobal('fetch', mockFetch);

      await expect(service.downloadUrl('https://cdn.example.com/a.jpg', 'x')).rejects.toThrow(/non-public/);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch.mock.calls[0][1].redirect).toBe('manual');
    });

    it('aborts a body that stalls after the headers arrived', async () => {
      vi.useFakeTimers();
      try {
        const { Readable } = await import('node:stream');
        const stalled = new Readable({ read() {} });
        stalled.push(Buffer.from('first bytes')); // ...and then nothing, forever
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
          ok: true, status: 200, headers: { get: () => null }, body: stalled
        }));

        const download = service.downloadUrl('https://cdn.example.com/slow.mp4', 'slow');
        const outcome = expect(download).rejects.toThrow(/stalled/);
        await vi.advanceTimersByTimeAsync(61 * 1000);
        await outcome;
        const leftovers = (await fsp.readdir(mediaDir)).filter((name) => name.includes('slow'));
        expect(leftovers).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('telegramFileToLocal', () => {
    const TOKEN = '7654321:AAFakeTokenForTests_abc-XYZ';
    const botWithFile = (filePath) => ({
      telegram: {
        getFileLink: vi.fn(async () => new URL(`https://api.telegram.org/file/bot${TOKEN}/${filePath}`))
      }
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("keeps the sender's file name, with no timestamp and no doubled extension", async () => {
      const { Readable } = await import('node:stream');
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true, status: 200, headers: { get: () => null }, body: Readable.from([Buffer.from('%PDF')])
      }));

      const target = await service.telegramFileToLocal(botWithFile('documents/file_7.pdf'), 'id', 'Договор.pdf');

      expect(path.basename(target)).toBe('Договор.pdf');
      expect(path.dirname(path.dirname(target))).toBe(path.resolve(mediaDir));
      expect(await fsp.readFile(target, 'utf8')).toBe('%PDF');
    });

    it('takes the extension from the file link for synthetic names', async () => {
      const { Readable } = await import('node:stream');
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true, status: 200, headers: { get: () => null }, body: Readable.from([Buffer.from('x')])
      }));

      const target = await service.telegramFileToLocal(botWithFile('stickers/file_3.tgs'), 'id', 'sticker');

      expect(path.basename(target)).toBe('sticker.tgs');
    });

    it('never puts the bot token into the error it throws', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: false, status: 404, statusText: 'Not Found', headers: { get: () => null }, body: null
      }));

      const error = await service.telegramFileToLocal(botWithFile('documents/file_7.pdf'), 'id', 'a.pdf').catch((e) => e);

      expect(error.message).toMatch(/404/);
      expect(error.message).not.toContain(TOKEN);
      expect(error.message).toContain('/bot<redacted>/');
    });
  });

  describe('redactUrl / isPrivateAddress', () => {
    it('masks bot tokens and drops signed query strings', () => {
      expect(redactUrl('https://api.telegram.org/file/bot123:AA-b_c/photos/x.jpg'))
        .toBe('https://api.telegram.org/file/bot<redacted>/photos/x.jpg');
      expect(redactUrl('https://i.oneme.ru/i?r=SIGNED&expires=1')).toBe('https://i.oneme.ru/i');
      expect(redactUrl('not a url')).toBe('<invalid url>');
    });

    it('classifies addresses', () => {
      for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) {
        expect(isPrivateAddress(ip)).toBe(true);
      }
      for (const ip of ['93.184.216.34', '172.32.0.1', '2606:4700::6810:85e5', '::ffff:8.8.8.8']) {
        expect(isPrivateAddress(ip)).toBe(false);
      }
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

  describe('framesDirToGif', () => {
    it('keeps the frames when encoding fails, so the first-frame fallback still has its file', async () => {
      // The bridge falls back to sending frame-000.png when the GIF encode
      // fails. Deleting the directory on failure made that fallback open a
      // missing file — which, sent as a raw stream, crashed the process.
      const dir = path.join(mediaDir, 'sticker-frames-bad');
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(path.join(dir, 'frame-000.png'), 'definitely not a png');

      await expect(service.framesDirToGif(dir, 20)).rejects.toThrow();

      expect(fs.existsSync(path.join(dir, 'frame-000.png'))).toBe(true);
    });

    it('drops the frames once the GIF is encoded', async () => {
      const dir = path.join(mediaDir, 'sticker-frames-ok');
      await fsp.mkdir(dir, { recursive: true });
      for (let i = 0; i < 3; i++) {
        await fsp.writeFile(path.join(dir, `frame-00${i}.png`), await gradientPng(16, 16, i % 2 === 0));
      }

      const gif = await service.framesDirToGif(dir, 10);

      expect(fs.existsSync(gif)).toBe(true);
      expect(fs.existsSync(dir)).toBe(false);
    });
  });
});

describe('MediaService: untrusted media for ffmpeg', () => {
  let dir;
  let service;

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'media-guard-'));
    service = new MediaService(dir, { lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]) });
  });

  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  // A "voice message" that is really a playlist would have ffmpeg read other
  // files (or reach the network) while converting it.
  it.each([
    ['HLS playlist', '#EXTM3U\n#EXTINF:1,\nfile:///etc/passwd\n'],
    ['concat script', 'ffconcat version 1.0\nfile /etc/passwd\n'],
    ['DASH manifest', '<?xml version="1.0"?>\n<MPD xmlns="urn:mpeg:dash:schema:mpd:2011"></MPD>\n'],
    ['SDP description', 'v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\nc=IN IP4 127.0.0.1\r\n']
  ])('refuses a %s posing as a voice message', async (_name, contents) => {
    const input = path.join(dir, 'voice.ogg');
    await fsp.writeFile(input, contents);
    await expect(service.convertAudio(input, 'mp3')).rejects.toThrow(/playlist\/manifest/);
    expect(fs.existsSync(path.join(dir, 'voice.mp3'))).toBe(false);
  });

  it('still converts real audio', async () => {
    const { default: ffmpegPath } = await import('ffmpeg-static');
    const { execFileSync } = await import('node:child_process');
    const input = path.join(dir, 'tone.wav');
    execFileSync(ffmpegPath, ['-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.3', input]);
    const output = await service.convertAudio(input, 'ogg');
    expect((await fsp.stat(output)).size).toBeGreaterThan(100);
  }, 30000);
});

describe('isPrivateAddress: IPv6 forms that carry an IPv4 address', () => {
  it('sees through mapped, compatible, NAT64 and 6to4 forms', () => {
    for (const ip of ['::ffff:7f00:1', '[::ffff:7f00:1]', '0:0:0:0:0:ffff:7f00:1', '::7f00:1', '64:ff9b::a00:1', '2002:c0a8:101::1', 'fe80::1%eth0', '2001:db8::1', '1::2::3']) {
      expect(isPrivateAddress(ip)).toBe(true);
    }
    for (const ip of ['64:ff9b::808:808', '2002:808:808::1', '2a00:1450:4010:c05::66']) {
      expect(isPrivateAddress(ip)).toBe(false);
    }
  });
});

describe('MediaService.cleanupOlderThan: Chromium download folder', () => {
  it('removes old copies the browser saved in downloads/, keeps fresh ones', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'media-dl-'));
    try {
      const service = new MediaService(dir);
      const downloads = path.join(dir, 'downloads');
      await fsp.mkdir(downloads, { recursive: true });
      const old = path.join(downloads, 'Отчёт.pdf');
      const partial = path.join(downloads, 'x.pdf.crdownload');
      const fresh = path.join(downloads, 'new.pdf');
      for (const file of [old, partial, fresh]) await fsp.writeFile(file, 'x');
      const hourAgo = new Date(Date.now() - 2 * 3600000);
      await fsp.utimes(old, hourAgo, hourAgo);
      await fsp.utimes(partial, hourAgo, hourAgo);

      await service.cleanupOlderThan(3600000);

      expect(fs.existsSync(old)).toBe(false);
      expect(fs.existsSync(partial)).toBe(false);
      expect(fs.existsSync(fresh)).toBe(true);
      expect(fs.existsSync(downloads)).toBe(true);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});
