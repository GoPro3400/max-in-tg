#!/usr/bin/env bash
# Checks a built Docker image the way people will use it, before it is
# published:
#
#   scripts/smoke-image.sh <image> [platform] [expected-version]
#
#   scripts/smoke-image.sh max-in-tg:smoke
#   scripts/smoke-image.sh max-in-tg:smoke linux/arm64 0.2.0
#
# Every check prints ok or FAIL; the exit code says whether any failed. The
# image workflow (.github/workflows/image.yml) runs it for amd64 and, under
# emulation, arm64.
# The single quotes around the sh -c scripts below are on purpose: the shell
# inside the container expands what is in them, not this one.
# shellcheck disable=SC2016
set -uo pipefail

image=${1:?usage: smoke-image.sh <image> [platform] [expected-version]}
platform=${2:-}
expected=${3:-}

run=(docker run --rm)
if [ -n "$platform" ]; then run+=(--platform "$platform"); fi

# Runs a command inside the image (through its entrypoint, tini, like the app).
in_image() { "${run[@]}" "$image" "$@"; }

failed=0
check() {
  local name=$1
  shift
  local output
  if output=$("$@" 2>&1); then
    printf 'ok    %s\n' "$name"
  else
    printf 'FAIL  %s\n' "$name"
    printf '%s\n' "$output" | tail -n 15 | sed 's/^/        /'
    failed=1
  fi
}

check 'Node 22' \
  in_image node -e 'if (process.versions.node.split(".")[0] !== "22") { console.error(process.version); process.exit(1); }'

check 'runs as an unprivileged user (uid 10001)' \
  in_image sh -c 'test "$(id -u)" = 10001'

check 'SQLite and image processing work (better-sqlite3, sharp)' \
  in_image node --input-type=module -e "
    const { default: Database } = await import('better-sqlite3');
    new Database(':memory:').prepare('select 1').get();
    const { default: sharp } = await import('sharp');
    await sharp({ create: { width: 2, height: 2, channels: 3, background: '#ffffff' } }).png().toBuffer();
  "

# The ffmpeg the bridge runs is the distribution's (see the Dockerfile), and
# there is no second, downloaded copy of it left in node_modules.
check 'ffmpeg is the distribution'"'"'s package' \
  in_image node --input-type=module -e "
    const { default: ffmpegPath } = await import('ffmpeg-static');
    const { existsSync } = await import('node:fs');
    const { execFileSync } = await import('node:child_process');
    if (ffmpegPath !== '/usr/bin/ffmpeg') throw new Error('the bridge would run ' + ffmpegPath);
    if (existsSync('node_modules/ffmpeg-static/ffmpeg')) throw new Error('ffmpeg-static downloaded a build of its own');
    console.log(execFileSync(ffmpegPath, ['-version']).toString().split('\n')[0]);
  "

# Real files through the bridge's own MediaService: what a voice message, a
# video note and the stickers go through, with this ffmpeg.
check 'voice, video and stickers convert (scripts/smoke-media.mjs)' \
  in_image node scripts/smoke-media.mjs

check 'Chromium, Xvfb and tini are there' \
  in_image sh -c 'chromium --version && command -v Xvfb && command -v tini'

# The token is only there to satisfy the configuration; nothing connects.
check 'the bridge loads (all its modules and dependencies resolve)' \
  in_image env TELEGRAM_BOT_TOKEN=123456789:smoke-test-token-not-real node --input-type=module -e "
    for (const file of [
      './src/storage/database.js',
      './src/services/bridge.js',
      './src/adapters/telegramBot.js',
      './src/adapters/maxWebClient.js',
      './src/services/mediaService.js'
    ]) await import(file);
  "

check 'no secrets or runtime state inside' \
  in_image sh -c '
    found=$(find /app -path /app/node_modules -prune -o \( -name ".env" -o -name ".env.*" -o -name "*.sqlite*" -o -name "*.pem" -o -name "*.key" -o -name "cookies.json" \) -print | grep -v "^/app/\.env\.example$" || true)
    if [ -n "$found" ]; then echo "found:"; echo "$found"; exit 1; fi
    if [ -e /app/.git ]; then echo "/app/.git is in the image"; exit 1; fi
    files=$(find /app/data /app/tmp /app/logs -type f)
    if [ -n "$files" ]; then echo "files in the data folders:"; echo "$files"; exit 1; fi
  '

check 'the app user can write its folders (data, tmp, logs)' \
  in_image sh -c 'for d in data tmp logs; do touch "/app/$d/.write-test" && rm "/app/$d/.write-test"; done'

check 'the version is one (package.json = what the bridge reports)' \
  in_image node --input-type=module -e "
    const { readFileSync } = await import('node:fs');
    const { APP_VERSION } = await import('./src/version.js');
    const packageVersion = JSON.parse(readFileSync('package.json', 'utf8')).version;
    if (APP_VERSION !== packageVersion) throw new Error(APP_VERSION + ' != ' + packageVersion);
    const expected = process.argv[1];
    if (expected && expected !== packageVersion) throw new Error('expected ' + expected + ', the image has ' + packageVersion);
    console.log(packageVersion);
  " "$expected"

if [ "$failed" -ne 0 ]; then
  printf '\nSmoke test FAILED for %s%s\n' "$image" "${platform:+ ($platform)}"
  exit 1
fi
printf '\nSmoke test passed for %s%s\n' "$image" "${platform:+ ($platform)}"
