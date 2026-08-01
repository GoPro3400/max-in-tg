import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import ffmpegPath from 'ffmpeg-static';
import ffmpeg from 'fluent-ffmpeg';
import mime from 'mime-types';
import sharp from 'sharp';
import { logger } from '../logger.js';
import { replaceExtension, safeName } from '../utils/fileHelpers.js';

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
  constructor(mediaDir) {
    this.mediaDir = mediaDir;
    fs.mkdirSync(mediaDir, { recursive: true });
  }

  async telegramFileToLocal(bot, fileId, preferredName = 'telegram-file') {
    const link = await bot.telegram.getFileLink(fileId);
    const extension = path.extname(link.pathname) || path.extname(preferredName) || '';
    const filename = this.safeFilename(`${Date.now()}-${preferredName}${extension}`);
    const target = path.join(this.mediaDir, filename);
    await downloadToFile(link.href, target);
    return target;
  }

  async downloadUrl(url, preferredName = 'max-file') {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new Error(`Refused to download URL with disallowed scheme: ${parsed.protocol}`);
    }
    const extension = path.extname(parsed.pathname) || '';
    const filename = this.safeFilename(`${Date.now()}-${preferredName}${extension}`);
    const target = path.join(this.mediaDir, filename);
    await downloadToFile(url, target);
    return target;
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
      try {
        return await this.convertImage(inputPath, 'jpg');
      } catch (error) {
        logger.warn({ inputPath, error }, 'Sticker image conversion failed; sending original file');
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
      await image.jpeg({ quality: 90 }).toFile(outputPath);
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

  // Encode a directory of PNG frames (frame-000.png …) into a Telegram video
  // sticker: VP9 .webm, 512x512, <3s, no audio, transparent. Telegram requires
  // VP9 alpha, which libvpx-vp9 only produces correctly with `-auto-alt-ref 0`
  // — without it Telegram silently treats the upload as a plain document.
  async framesDirToWebmSticker(framesDir, fps = 20) {
    const outputPath = path.join(this.mediaDir, `sticker-${path.basename(framesDir)}.webm`);
    const webmCommand = ffmpeg()
      .input(path.join(framesDir, 'frame-%03d.png'))
      .inputFPS(fps)
      .videoCodec('libvpx-vp9')
      .videoFilters('scale=512:512:flags=lanczos')
      .outputOptions([
        '-pix_fmt', 'yuva420p',
        '-an',
        '-auto-alt-ref', '0',
        '-cpu-used', '5',
        '-deadline', 'realtime'
      ])
      .videoBitrate('400k')
      .format('webm');
    const webmDone = runFfmpeg(webmCommand, 'framesDirToWebmSticker');
    webmCommand.save(outputPath);
    try {
      await webmDone;
    } finally {
      // Also drop the frames on failure/timeout: cleanupOlderThan only unlinks
      // files, never directories, so a leaked frames dir is never reclaimed.
      await fsp.rm(framesDir, { recursive: true, force: true }).catch(() => {});
    }
    logger.debug({ framesDir, outputPath }, 'Encoded animated sticker webm');
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
    try {
      await gifDone;
    } finally {
      // See framesDirToWebmSticker: cleanupOlderThan never removes directories,
      // so the frames must be dropped here even when encoding fails.
      await fsp.rm(framesDir, { recursive: true, force: true }).catch(() => {});
    }
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
    await Promise.all(entries
      .filter((entry) => entry.isFile())
      .map(async (entry) => {
        const filePath = path.join(this.mediaDir, entry.name);
        try {
          const stat = await fsp.stat(filePath);
          if (now - stat.mtimeMs > maxAgeMs) {
            await fsp.unlink(filePath);
          }
        } catch (error) {
          if (error.code !== 'ENOENT') {
            logger.warn({ err: error, filePath }, 'Failed to clean up media file');
          }
        }
      }));
  }
}

// Hard cap on any single download. Media comes from remote sources (MAX's CDN
// and Telegram) and lands on the container's small bind-mounted volume, which
// also holds the SQLite DB, the Chromium profile and the logs — a single
// oversized file could fill it and take all of those down together. Telegram
// itself refuses documents over 50 MB, so nothing legitimate is lost here.
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;

const downloadToFile = async (url, target) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);
  let response;
  try { response = await fetch(url, { signal: controller.signal }); } finally { clearTimeout(timeout); }
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
  }

  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_DOWNLOAD_BYTES) {
    throw new Error(`Refusing to download ${url}: ${declared} bytes exceeds the ${MAX_DOWNLOAD_BYTES} byte limit`);
  }

  const body = typeof response.body.getReader === 'function'
    ? Readable.fromWeb(response.body)
    : response.body;

  // Content-Length can be absent or lie, so enforce the cap on the actual
  // stream too and abort mid-flight rather than after the disk is already full.
  let received = 0;
  body.on('data', (chunk) => {
    received += chunk.length;
    if (received > MAX_DOWNLOAD_BYTES) {
      body.destroy(new Error(`Download of ${url} exceeded the ${MAX_DOWNLOAD_BYTES} byte limit`));
    }
  });

  try {
    await pipeline(body, fs.createWriteStream(target));
  } catch (error) {
    // Never leave a partial file behind: it would be forwarded as a corrupt
    // attachment, and cleanupOlderThan would not remove it for an hour.
    await fsp.rm(target, { force: true }).catch(() => {});
    throw error;
  }
};


