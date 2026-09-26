import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import zlib from 'node:zlib';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import ffmpegPath from 'ffmpeg-static';
import ffmpeg from 'fluent-ffmpeg';
import mime from 'mime-types';
import sharp from 'sharp';
import { logger } from '../logger.js';
import { replaceExtension, safeDisplayName, safeName } from '../utils/fileHelpers.js';

// FFMPEG_PATH wins over the bundled binary. Two reasons to use it: a distro
// ffmpeg is often better optimised for the host, and — the licensing one —
// ffmpeg-static ships a GPL-3.0 build, so anyone who wants to REDISTRIBUTE a
// built image without taking on GPL obligations can drop that dependency and
// point here instead (see THIRD_PARTY_LICENSES.md).
const resolvedFfmpegPath = process.env.FFMPEG_PATH || ffmpegPath;
if (resolvedFfmpegPath) {
  ffmpeg.setFfmpegPath(resolvedFfmpegPath);
  if (process.env.FFMPEG_PATH) {
    logger.info({ ffmpegPath: resolvedFfmpegPath }, 'Using ffmpeg from FFMPEG_PATH');
  }
}

// ffmpeg can hang forever on a malformed or adversarial input: neither 'end'
// nor 'error' ever fires, so the awaiting promise never settles. Every
// conversion here runs inside the bridge's single global maxLock, and
// AsyncLock chains the next task off that same promise — one hung ffmpeg
// therefore wedges polling AND both send directions permanently, with no
// crash and nothing in the logs. Always bound the run and kill the process.
const FFMPEG_TIMEOUT_MS = 120000;

const runFfmpeg = (command, label) => new Promise((resolve, reject) => {
  let settled = false;
  const finish = (error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (error) reject(error); else resolve();
  };
  const timer = setTimeout(() => {
    if (settled) return;
    // Kill first so the child process cannot outlive the rejected promise and
    // keep holding CPU/file handles in a memory-capped container.
    try { command.kill('SIGKILL'); } catch { /* already exited */ }
    finish(new Error(`ffmpeg timed out after ${FFMPEG_TIMEOUT_MS}ms (${label})`));
  }, FFMPEG_TIMEOUT_MS);
  command.on('end', () => finish()).on('error', (error) => finish(error));
});

export class MediaService {
  constructor(mediaDir, { lookup = dns.lookup } = {}) {
    this.mediaDir = mediaDir;
    this.lookup = lookup;
    fs.mkdirSync(mediaDir, { recursive: true });
  }

  // The file lands under its own name in a directory of its own: sendFile
  // uploads the basename, so the basename is exactly what the MAX contact
  // sees. It used to be "<timestamp>-<name><ext>" run through the ASCII-only
  // safeName — "Договор.pdf" arrived as "1790429360882-_.pdf.pdf".
  async telegramFileToLocal(bot, fileId, preferredName = 'telegram-file') {
    const link = await bot.telegram.getFileLink(fileId);
    const extension = path.extname(preferredName) ? '' : path.extname(link.pathname);
    const dir = await fsp.mkdtemp(path.join(this.mediaDir, TELEGRAM_UPLOAD_DIR_PREFIX));
    const target = path.join(dir, safeDisplayName(`${preferredName}${extension}`));
    // The file link carries the bot token in its path: downloadToFile quotes
    // URLs only through redactUrl, so a failure cannot leak it.
    await downloadToFile(link.href, target);
    return target;
  }

  // URLs taken from the MAX page (media bubbles, reply thumbnails). Whoever
  // writes into a MAX chat has some say over those, so only public https hosts
  // are fetched — no http, no loopback/private/link-local addresses (cloud
  // metadata, the container's own CDP port) — and every redirect hop is
  // checked the same way.
  async downloadUrl(url, preferredName = 'max-file') {
    const parsed = await this.assertPublicHttpsUrl(url);
    const extension = path.extname(parsed.pathname) || '';
    const filename = this.safeFilename(`${Date.now()}-${preferredName}${extension}`);
    const target = path.join(this.mediaDir, filename);
    await downloadToFile(url, target, { validateUrl: (next) => this.assertPublicHttpsUrl(next) });
    return target;
  }

  async assertPublicHttpsUrl(url) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') {
      throw new Error(`Refused to download URL with disallowed scheme: ${parsed.protocol}`);
    }
    const host = parsed.hostname.replace(/^\[|\]$/g, '');
    const addresses = net.isIP(host)
      ? [{ address: host }]
      : await this.lookup(host, { all: true, verbatim: true });
    if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
      throw new Error(`Refused to download from a non-public address: ${redactUrl(url)}`);
    }
    return parsed;
  }

  // Computes a 64-bit difference hash (dHash) of an image, returned as 16 hex
  // chars. Resolution-independent (the image is downscaled to 9x8 grayscale
  // first), so a small thumbnail and the full-size original of the same picture
  // produce near-identical hashes — used to match a reply-to-media to its source.
  // Content digest for media that has no perceptual hash (voice, video, video
  // notes, documents). MAX regenerates its signed CDN URLs on every page load,
  // so a URL can never identify a bubble across restarts — but the bytes behind
  // it are identical when re-downloaded, which makes a plain digest an exact
  // identity for exactly the re-forward-duplicate case photos solve with
  // imageDHash. Returns null for anything that is not a readable file (e.g. a
  // sticker frames directory) so callers can simply skip the guard.
  async fileContentHash(filePath) {
    if (!filePath) return null;
    const stat = await fsp.stat(filePath).catch(() => null);
    if (!stat || !stat.isFile()) return null;
    const hash = crypto.createHash('sha256');
    await pipeline(fs.createReadStream(filePath), hash);
    return hash.digest('hex').slice(0, 32);
  }

  async imageDHash(input) {
    const { data } = await sharp(input, { animated: false })
      .grayscale()
      .resize(9, 8, { fit: 'fill' })
      .raw()
      .toBuffer({ resolveWithObject: true });
    let bits = '';
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        const left = data[row * 9 + col];
        const right = data[row * 9 + col + 1];
        bits += left < right ? '1' : '0';
      }
    }
    let hex = '';
    for (let i = 0; i < 64; i += 4) {
      hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
    }
    return hex;
  }

  async ensureMaxCompatible(inputPath, type) {
    if (type === 'voice') return inputPath;
    if (type === 'video_note') return this.convertVideo(inputPath, 'mp4');
    if (type === 'photo') return this.convertImage(inputPath, 'jpg');
    if (type === 'sticker') {
      // PNG, not JPEG: a sticker is mostly transparency, which JPEG turned
      // into a black square.
      try {
        return await this.convertImage(inputPath, 'png');
      } catch (error) {
        logger.warn({ inputPath, err: error?.message || String(error) }, 'Sticker image conversion failed; sending original file');
        return inputPath;
      }
    }
    return inputPath;
  }

  async ensureTelegramCompatible(inputPath, type) {
    if (type === 'voice') return this.convertAudio(inputPath, 'ogg');
    if (type === 'video_note') return this.convertVideo(inputPath, 'mp4');
    return inputPath;
  }

  async convertAudio(inputPath, targetExtension) {
    const outputPath = replaceExtension(inputPath, targetExtension);
    if (inputPath === outputPath && fs.existsSync(outputPath)) return outputPath;

    let audioCommand = ffmpeg(inputPath).output(outputPath);
    if (targetExtension === 'ogg') {
      audioCommand = audioCommand.audioCodec('libopus').format('ogg');
    }
    if (targetExtension === 'mp3') {
      audioCommand = audioCommand.audioCodec('libmp3lame').format('mp3');
    }
    const audioDone = runFfmpeg(audioCommand, `convertAudio ${targetExtension}`);
    audioCommand.run();
    await audioDone;

    logger.debug({ inputPath, outputPath }, 'Converted audio');
    return outputPath;
  }

  async convertImage(inputPath, targetExtension) {
    const outputPath = replaceExtension(inputPath, targetExtension);
    if (inputPath === outputPath && fs.existsSync(outputPath)) return outputPath;

    const image = sharp(inputPath, { animated: false }).rotate();
    if (targetExtension === 'jpg' || targetExtension === 'jpeg') {
      // JPEG has no alpha: without flattening, transparent pixels come out black.
      await image.flatten({ background: '#ffffff' }).jpeg({ quality: 90 }).toFile(outputPath);
    } else if (targetExtension === 'png') {
      await image.png().toFile(outputPath);
    } else {
      await image.toFile(outputPath);
    }

    logger.debug({ inputPath, outputPath }, 'Converted image');
    return outputPath;
  }

  async convertVideo(inputPath, targetExtension) {
    const outputPath = replaceExtension(inputPath, targetExtension);
    if (inputPath === outputPath && fs.existsSync(outputPath)) return outputPath;

    let videoCommand = ffmpeg(inputPath).output(outputPath);
    if (targetExtension === 'mp4') {
      videoCommand = videoCommand.videoCodec('libx264').audioCodec('aac').format('mp4');
    }
    const videoDone = runFfmpeg(videoCommand, `convertVideo ${targetExtension}`);
    videoCommand.run();
    await videoDone;

    logger.debug({ inputPath, outputPath }, 'Converted video');
    return outputPath;
  }

  // A static sticker the way Telegram's sendSticker wants it: WEBP, 512 px on
  // the longer side, transparency kept — shown as a real sticker instead of a
  // photo on a white (or black) background.
  async toWebpSticker(inputPath) {
    const outputPath = path.join(path.dirname(inputPath), `${path.basename(inputPath, path.extname(inputPath))}-tg-sticker.webp`);
    await sharp(inputPath, { animated: false })
      .resize(STICKER_SIDE, STICKER_SIDE, { fit: 'inside' })
      .webp({ quality: 90, alphaQuality: 100 })
      .toFile(outputPath);
    return outputPath;
  }

  // Encode a directory of PNG frames (frame-000.png …) into a Telegram video
  // sticker, within Telegram's limits for them: VP9 WEBM with alpha, 512 px
  // on the longer side, at most 3 s, at most 30 fps, no audio, at most 256 KB.
  // A longer animation is played faster rather than cut short. Telegram
  // requires VP9 alpha, which libvpx-vp9 only produces correctly with
  // `-auto-alt-ref 0` — without it the upload silently becomes a document.
  // The frames are left in place: if Telegram refuses the sticker, the caller
  // falls back to a GIF made from the same frames.
  async framesDirToWebmSticker(framesDir, fps = 20) {
    const frameCount = (await fsp.readdir(framesDir)).filter((name) => /^frame-\d+\.png$/.test(name)).length;
    if (frameCount < 2) throw new Error(`Not enough frames for a video sticker: ${frameCount}`);
    let inputFps = Math.min(STICKER_MAX_FPS, Math.max(1, Number(fps) || 20));
    if (frameCount / inputFps > STICKER_MAX_SECONDS) inputFps = frameCount / STICKER_MAX_SECONDS;
    const durationSec = frameCount / inputFps;
    const outputPath = path.join(this.mediaDir, `sticker-${path.basename(framesDir)}.webm`);

    // Quality first, then a bitrate that fits 256 KB if the first pass is too big.
    const attempts = [
      ['-crf', '32', '-b:v', '0'],
      ['-b:v', `${Math.floor((STICKER_MAX_BYTES * 8 * 0.9) / durationSec / 1000)}k`]
    ];
    for (const [index, rateOptions] of attempts.entries()) {
      const webmCommand = ffmpeg()
        .input(path.join(framesDir, 'frame-%03d.png'))
        .inputFPS(inputFps)
        .videoCodec('libvpx-vp9')
        .videoFilters([
          `scale=${STICKER_SIDE}:${STICKER_SIDE}:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos`,
          `fps=${Math.min(STICKER_MAX_FPS, Math.ceil(inputFps))}`
        ])
        .outputOptions([
          '-pix_fmt', 'yuva420p',
          '-an',
          '-auto-alt-ref', '0',
          '-cpu-used', '5',
          '-deadline', 'realtime',
          '-t', String(STICKER_MAX_SECONDS),
          ...rateOptions
        ])
        .format('webm');
      const webmDone = runFfmpeg(webmCommand, 'framesDirToWebmSticker');
      webmCommand.save(outputPath);
      await webmDone;
      const { size } = await fsp.stat(outputPath);
      logger.debug({ framesDir, outputPath, size, durationSec, pass: index + 1 }, 'Encoded animated sticker webm');
      if (size <= STICKER_MAX_BYTES) return outputPath;
    }
    throw new Error(`Video sticker is larger than ${STICKER_MAX_BYTES} bytes even at a reduced bitrate`);
  }

  // Telegram's video sticker (VP9 WEBM with alpha) as an animated GIF with
  // transparency, for MAX. The alpha channel is only decoded by libvpx, not by
  // ffmpeg's native VP9 decoder, hence the explicit input codec.
  async videoStickerToGif(inputPath, fps = 20) {
    const outputPath = path.join(path.dirname(inputPath), `${path.basename(inputPath, path.extname(inputPath))}.gif`);
    const gifCommand = ffmpeg()
      .input(inputPath)
      .inputOptions(['-c:v', 'libvpx-vp9'])
      .complexFilter([
        { filter: 'fps', options: String(fps), inputs: '0:v', outputs: 'timed' },
        { filter: 'scale', options: `${STICKER_SIDE}:-2:flags=lanczos`, inputs: 'timed', outputs: 'scaled' },
        { filter: 'split', inputs: 'scaled', outputs: ['s0', 's1'] },
        { filter: 'palettegen', options: 'reserve_transparent=1', inputs: 's0', outputs: 'pal' },
        { filter: 'paletteuse', options: 'alpha_threshold=128', inputs: ['s1', 'pal'], outputs: 'out' }
      ], 'out')
      .outputOptions(['-loop', '0'])
      .format('gif');
    const gifDone = runFfmpeg(gifCommand, 'videoStickerToGif');
    gifCommand.save(outputPath);
    await gifDone;
    return outputPath;
  }

  // Encode PNG frames into an animated GIF (with transparency) for sendAnimation.
  // Telegram autoplays it inline instead of showing a downloadable file.
  async framesDirToGif(framesDir, fps = 20) {
    // fps comes from real capture timing / Lottie duration; clamp to a sane,
    // GIF-friendly range and round so playback matches the sticker's real speed.
    const safeFps = Math.min(30, Math.max(5, Math.round(Number(fps) || 20)));
    const outputPath = path.join(this.mediaDir, `sticker-${path.basename(framesDir)}.gif`);
    const gifCommand = ffmpeg()
      .input(path.join(framesDir, 'frame-%03d.png'))
      .inputFPS(safeFps)
      .complexFilter([
        { filter: 'scale', options: '512:512:flags=lanczos', inputs: '0:v', outputs: 'scaled' },
        { filter: 'split', inputs: 'scaled', outputs: ['s0', 's1'] },
        { filter: 'palettegen', options: 'reserve_transparent=1', inputs: 's0', outputs: 'pal' },
        { filter: 'paletteuse', options: 'alpha_threshold=128', inputs: ['s1', 'pal'], outputs: 'out' }
      ], 'out')
      .outputOptions(['-loop', '0'])
      .format('gif');
    const gifDone = runFfmpeg(gifCommand, 'framesDirToGif');
    gifCommand.save(outputPath);
    await gifDone;
    // Only on success — see framesDirToWebmSticker.
    await fsp.rm(framesDir, { recursive: true, force: true }).catch(() => {});
    logger.debug({ framesDir, outputPath }, 'Encoded animated sticker gif');
    return outputPath;
  }

  // A Telegram animated sticker (.tgs) is gzipped Lottie JSON. MAX serves the
  // Lottie either raw or already gzipped — detect via the gzip magic bytes and
  // gzip only when needed.
  async lottieToTgs(lottiePath) {
    const buffer = await fsp.readFile(lottiePath);
    const isGzip = buffer.length > 1 && buffer[0] === 0x1f && buffer[1] === 0x8b;
    const tgs = isGzip ? buffer : zlib.gzipSync(buffer);
    const outputPath = replaceExtension(lottiePath, 'tgs');
    await fsp.writeFile(outputPath, tgs);
    logger.debug({ lottiePath, outputPath, wasGzipped: isGzip, size: tgs.length }, 'Built .tgs sticker from Lottie');
    return outputPath;
  }

  inferMime(filePath) {
    return mime.lookup(filePath) || 'application/octet-stream';
  }

  safeFilename(name) {
    return safeName(name);
  }

  async cleanupOlderThan(maxAgeMs) {
    const now = Date.now();
    const entries = await fsp.readdir(this.mediaDir, { withFileTypes: true });
    // Loose files, plus the per-message temporary directories this code
    // creates (Telegram uploads, MAX documents, sticker frames). Any other
    // directory — notably downloads/, Chromium's configured download folder —
    // is left alone.
    await Promise.all(entries
      .filter((entry) => entry.isFile()
        || (entry.isDirectory() && TEMP_DIR_PREFIXES.some((prefix) => entry.name.startsWith(prefix))))
      .map(async (entry) => {
        const filePath = path.join(this.mediaDir, entry.name);
        try {
          const stat = await fsp.stat(filePath);
          if (now - stat.mtimeMs > maxAgeMs) {
            await fsp.rm(filePath, { recursive: true, force: true });
          }
        } catch (error) {
          if (error.code !== 'ENOENT') {
            logger.warn({ err: error, filePath }, 'Failed to clean up media file');
          }
        }
      }));
  }
}

// Telegram's limits for stickers sent with sendSticker.
const STICKER_SIDE = 512;
const STICKER_MAX_SECONDS = 2.9; // "up to 3 seconds", with a margin
const STICKER_MAX_FPS = 30;
const STICKER_MAX_BYTES = 256 * 1024;

// Hard cap on any single download. Media comes from remote sources (MAX's CDN
// and Telegram) and lands on the container's small bind-mounted volume, which
// also holds the SQLite DB, the Chromium profile and the logs — a single
// oversized file could fill it and take all of those down together. Telegram
// itself refuses documents over 50 MB, so nothing legitimate is lost here.
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;
// Downloads run inside the bridge's global maxLock (forwardMaxMessage is
// called from the poll), so a stalled transfer wedges polling AND both send
// directions. No byte for this long — headers included — aborts it...
const DOWNLOAD_IDLE_TIMEOUT_MS = 60 * 1000;
// ...and so does a transfer that trickles along but never finishes. The old
// single 60 s timer was cleared as soon as the headers arrived, leaving the
// body with no deadline at all.
const DOWNLOAD_TOTAL_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_DOWNLOAD_REDIRECTS = 5;

// Per-file directories created by telegramFileToLocal, reclaimed by
// cleanupOlderThan together with the other known temporary directories.
const TELEGRAM_UPLOAD_DIR_PREFIX = 'tg-';
const TEMP_DIR_PREFIXES = [TELEGRAM_UPLOAD_DIR_PREFIX, 'doc-', 'sticker-frames-'];

// URLs end up in logs and in error replies posted to Telegram. A Telegram
// file link carries the BOT TOKEN in its path (/file/bot<token>/…) and MAX's
// media URLs carry signed access tokens in the query, so errors quote only
// origin + path, with any bot token masked.
export const redactUrl = (url) => {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname.replace(/\/bot\d+:[\w-]+/g, '/bot<redacted>')}`;
  } catch {
    return '<invalid url>';
  }
};

// Loopback, private, link-local, CGNAT, multicast and reserved ranges, IPv4
// and IPv6 (including IPv4-mapped IPv6).
export const isPrivateAddress = (address) => {
  const ip = String(address || '').toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  if (mapped) return isPrivateAddress(mapped[1]);
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 198 && (b === 18 || b === 19));
  }
  if (net.isIPv6(ip)) {
    return ip === '::' || ip === '::1'
      || /^f[cd]/.test(ip) // fc00::/7 unique local
      || /^fe[89ab]/.test(ip) // fe80::/10 link-local
      || /^ff/.test(ip); // multicast
  }
  return true; // not an IP at all: refuse rather than guess
};

const downloadToFile = async (url, target, { validateUrl = null } = {}) => {
  const controller = new AbortController();
  let failure = null;
  const abort = (message) => {
    if (controller.signal.aborted) return;
    failure = new Error(message);
    controller.abort(failure);
  };
  const totalTimer = setTimeout(() => abort(`Download of ${redactUrl(url)} did not finish within ${DOWNLOAD_TOTAL_TIMEOUT_MS / 1000}s`), DOWNLOAD_TOTAL_TIMEOUT_MS);
  let idleTimer = null;
  const armIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => abort(`Download of ${redactUrl(url)} stalled for ${DOWNLOAD_IDLE_TIMEOUT_MS / 1000}s`), DOWNLOAD_IDLE_TIMEOUT_MS);
  };

  try {
    armIdle();
    let current = url;
    let response;
    for (let hop = 0; ; hop++) {
      response = await fetch(current, { signal: controller.signal, redirect: validateUrl ? 'manual' : 'follow' });
      const location = response.status >= 300 && response.status < 400 ? response.headers.get('location') : null;
      if (!validateUrl || !location) break;
      if (hop >= MAX_DOWNLOAD_REDIRECTS) throw new Error(`Too many redirects downloading ${redactUrl(url)}`);
      current = new URL(location, current).href;
      await validateUrl(current);
    }
    if (!response.ok || !response.body) {
      throw new Error(`Failed to download ${redactUrl(current)}: ${response.status} ${response.statusText}`);
    }

    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_DOWNLOAD_BYTES) {
      throw new Error(`Refusing to download ${redactUrl(current)}: ${declared} bytes exceeds the ${MAX_DOWNLOAD_BYTES} byte limit`);
    }

    const body = typeof response.body.getReader === 'function'
      ? Readable.fromWeb(response.body)
      : response.body;

    // Content-Length can be absent or lie, so enforce the cap on the actual
    // stream too and abort mid-flight rather than after the disk is already full.
    let received = 0;
    body.on('data', (chunk) => {
      armIdle();
      received += chunk.length;
      if (received > MAX_DOWNLOAD_BYTES) {
        body.destroy(new Error(`Download of ${redactUrl(current)} exceeded the ${MAX_DOWNLOAD_BYTES} byte limit`));
      }
    });
    if (controller.signal.aborted) throw failure || new Error('Download aborted');
    controller.signal.addEventListener('abort', () => body.destroy(failure || new Error('Download aborted')), { once: true });

    try {
      await pipeline(body, fs.createWriteStream(target));
    } catch (error) {
      // Never leave a partial file behind: it would be forwarded as a corrupt
      // attachment, and cleanupOlderThan would not remove it for an hour.
      await fsp.rm(target, { force: true }).catch(() => {});
      throw failure || error;
    }
  } catch (error) {
    // fetch's own errors (DNS, reset, abort) never embed the URL, but an abort
    // must surface as the timeout that caused it, not as "This operation was aborted".
    throw failure || error;
  } finally {
    clearTimeout(totalTimer);
    clearTimeout(idleTimer);
  }
};


