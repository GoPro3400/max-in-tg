#!/usr/bin/env node
// Runs the conversions the bridge does on media — a voice message, a video
// note, animated stickers both ways — through its own MediaService and the
// ffmpeg of this machine, on files it makes itself, and checks what comes out.
//
//   node scripts/smoke-media.mjs
//
// scripts/smoke-image.sh runs it inside the Docker image, where ffmpeg is the
// distribution's package: a codec, a filter or an option that ffmpeg lacks fails
// here, not on the first voice message of someone who has just updated. No
// network is used and nothing but a temporary folder is written.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The configuration wants a token to load; nothing connects.
process.env.TELEGRAM_BOT_TOKEN ??= '123456789:smoke-test-token-not-real';
process.env.LOG_LEVEL ??= 'warn';

const { MediaService, LOCAL_FILES_ONLY } = await import('../src/services/mediaService.js');
const { default: ffmpegStatic } = await import('ffmpeg-static');
const { default: sharp } = await import('sharp');

const ffmpeg = process.env.FFMPEG_PATH || ffmpegStatic;
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-media-'));
const media = new MediaService(path.join(work, 'media'));
const at = (name) => path.join(work, name);

// ffmpeg's own report of a file (its streams), and whether it decodes to the end.
const run = (args) => spawnSync(ffmpeg, ['-hide_banner', ...args], { encoding: 'utf8' });
const streams = (file) => run(['-i', file]).stderr;
const mustSucceed = (args) => {
  const result = run(args);
  if (result.status !== 0) throw new Error(`ffmpeg ${args.join(' ')}\n${result.stderr.trim().split('\n').slice(-6).join('\n')}`);
};
// A VP9 file with alpha is decoded by libvpx (ffmpeg's own VP9 decoder drops
// the alpha channel), which is what MediaService does with it too.
const decodesCleanly = (file) => {
  const decoder = file.endsWith('.webm') ? ['-c:v', 'libvpx-vp9'] : [];
  const result = run(['-v', 'error', ...decoder, '-i', file, '-f', 'null', '-']);
  if (result.status !== 0 || result.stderr.trim()) {
    throw new Error(`${path.basename(file)} does not decode cleanly:\n${result.stderr.trim().slice(-500)}`);
  }
};
const expect = (condition, message) => {
  if (!condition) throw new Error(message);
};

// PNG frames of a disc that moves across a transparent square: what a sticker
// capture leaves in a frames directory (frame-000.png ...).
const makeFrames = async (name, count = 12, side = 128) => {
  const directory = at(name);
  fs.mkdirSync(directory, { recursive: true });
  for (let index = 0; index < count; index += 1) {
    const x = 30 + Math.round((index * (side - 60)) / (count - 1));
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${side}" height="${side}"><circle cx="${x}" cy="${side / 2}" r="26" fill="#e8422f"/></svg>`;
    await sharp(Buffer.from(svg)).png().toFile(path.join(directory, `frame-${String(index).padStart(3, '0')}.png`));
  }
  return directory;
};

// A GIF that kept its transparency: the corner is clear, the middle of the
// disc is not. (Losing the alpha channel is what a wrong VP9 decoder or a
// wrong palette option does; the picture would still "convert".)
const expectTransparentGif = async (file) => {
  const { data, info } = await sharp(file, { animated: false }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const alphaAt = (x, y) => data[(y * info.width + x) * info.channels + (info.channels - 1)];
  expect(alphaAt(2, 2) === 0, `${path.basename(file)}: the corner is not transparent (alpha ${alphaAt(2, 2)})`);
  const { pages } = await sharp(file, { animated: true }).metadata();
  expect(pages > 1, `${path.basename(file)}: not animated (${pages} frame)`);
  // Somewhere on the row through the disc's middle there is solid colour.
  const middle = Math.floor(info.height / 2);
  const solid = Array.from({ length: info.width }, (_, x) => alphaAt(x, middle)).some((alpha) => alpha === 255);
  expect(solid, `${path.basename(file)}: nothing solid in the picture`);
};

const cases = [
  ['a voice message becomes Opus in Ogg (Telegram voice)', async () => {
    mustSucceed(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', at('voice.wav')]);
    const out = await media.convertAudio(at('voice.wav'), 'ogg');
    expect(/Audio: opus/.test(streams(out)), `not Opus:\n${streams(out)}`);
    decodesCleanly(out);
  }],

  ['audio becomes MP3', async () => {
    const out = await media.convertAudio(at('voice.wav'), 'mp3');
    expect(/Audio: mp3/.test(streams(out)), `not MP3:\n${streams(out)}`);
    decodesCleanly(out);
  }],

  ['a video note becomes H.264 and AAC in MP4', async () => {
    // Native encoders only, so what is tested is the conversion, not the input.
    mustSucceed([
      '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=15:duration=1',
      '-f', 'lavfi', '-i', 'sine=frequency=330:duration=1',
      '-c:v', 'mpeg4', '-c:a', 'aac', '-shortest', at('note.mov')
    ]);
    const out = await media.convertVideo(at('note.mov'), 'mp4');
    const report = streams(out);
    expect(/Video: h264/.test(report) && /Audio: aac/.test(report), `not H.264 + AAC:\n${report}`);
    decodesCleanly(out);
  }],

  ['a sticker made of frames becomes a VP9 WebM with alpha, within Telegram\'s limits', async () => {
    const frames = await makeFrames('frames-webm');
    const out = await media.framesDirToWebmSticker(frames, 20);
    expect(fs.statSync(out).size <= 256 * 1024, `bigger than 256 KB: ${fs.statSync(out).size}`);
    expect(/Video: vp9/.test(streams(out)), `not VP9:\n${streams(out)}`);
    fs.copyFileSync(out, at('sticker.webm'));
    decodesCleanly(at('sticker.webm'));
  }],

  ['a video sticker (VP9 with alpha) becomes a GIF that keeps its transparency', async () => {
    const out = await media.videoStickerToGif(at('sticker.webm'), 20);
    await expectTransparentGif(out);
  }],

  ['a sticker made of frames becomes an animated GIF that keeps its transparency', async () => {
    const frames = await makeFrames('frames-gif');
    const out = await media.framesDirToGif(frames, 20);
    await expectTransparentGif(out);
  }],

  ['a playlist cannot make ffmpeg fetch from the network', async () => {
    // A file that is a playlist rather than media, as someone in a chat could
    // send it under any name. MediaService refuses it by its first bytes ...
    fs.writeFileSync(at('evil.m3u8'), '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:1\n#EXTINF:1.0,\nhttp://127.0.0.1:9/segment.ts\n#EXT-X-ENDLIST\n');
    await media.convertAudio(at('evil.m3u8'), 'mp3').then(
      () => { throw new Error('a playlist was converted'); },
      (error) => expect(/playlist/i.test(error.message), `refused for another reason: ${error.message}`)
    );
    // ... and, should that ever miss, ffmpeg itself must not follow it, given
    // the options MediaService gives every input.
    const result = run([...LOCAL_FILES_ONLY, '-i', at('evil.m3u8'), '-f', 'null', '-']);
    expect(result.status !== 0 && /Protocol 'http' not on whitelist 'file'!/.test(result.stderr), `ffmpeg went for the network:\n${result.stderr.slice(-400)}`);
  }]
];

const version = /^ffmpeg version (\S+)/m.exec(run(['-version']).stdout)?.[1] || 'unknown';
console.log(`ffmpeg ${version} (${ffmpeg})`);

let failed = 0;
for (const [name, body] of cases) {
  try {
    await body();
    console.log(`ok    ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL  ${name}\n        ${String(error?.message || error).split('\n').join('\n        ')}`);
  }
}
fs.rmSync(work, { recursive: true, force: true });
if (failed) {
  console.log(`\n${failed} of ${cases.length} media checks failed`);
  process.exit(1);
}
console.log(`\nAll ${cases.length} media checks passed`);
