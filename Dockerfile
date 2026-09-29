# Node 22 LTS: Node 20 reached end of life in April 2026 (no security fixes).
FROM node:22-bookworm-slim

ENV NODE_ENV=production
ENV PUPPETEER_SKIP_DOWNLOAD=true
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    chromium \
    ffmpeg \
    g++ \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnss3 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    make \
    python3 \
    tini \
    xdg-utils \
    xvfb \
  && rm -rf /var/lib/apt/lists/*

# ffmpeg is Debian's package (above), not the build that the ffmpeg-static npm
# package downloads during `npm ci`: that is a GPL static binary from a third
# party's site, which nothing here would ever update (ffmpeg reads media that
# strangers send), and which a published image would carry without its licence
# text or source. Debian's package brings its licence texts
# (/usr/share/doc/ffmpeg/copyright), its source (`apt-get source ffmpeg`) and
# its security fixes with every rebuild. FFMPEG_BIN makes ffmpeg-static use it
# and skip the download; it stays set at run time, which is how the bridge
# finds ffmpeg. scripts/smoke-media.mjs checks that the conversions work with it.
ENV FFMPEG_BIN=/usr/bin/ffmpeg

COPY package*.json ./
# npm ci = reproducible install pinned by package-lock.json (fails loudly if
# the lockfile and package.json ever drift apart).
RUN npm ci --omit=dev

COPY . .
# Only the data directories belong to the runtime user. `chown -R /app` used
# to copy all of node_modules into one more layer (doubling the image) and
# let the bridge rewrite its own code.
RUN groupadd --system --gid 10001 app \
  && useradd --system --uid 10001 --gid app --home-dir /app app \
  && mkdir -p /app/data /app/tmp/media /app/logs \
  && chown -R app:app /app/data /app/tmp /app/logs

USER app

ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV XDG_CONFIG_HOME=/app/data/.config
ENV XDG_CACHE_HOME=/app/data/.cache

# Liveness only — deliberately not a claim about the bridge being healthy.
#
# The bridge serves no HTTP port and writes no heartbeat, so there is no
# in-band signal to probe without changing the app. What this checks:
#   1. The Node bridge process is alive. The [.] keeps the pattern from matching
#      the cmdline of the grep (and of the shell running this check) itself.
#   2. The SQLite file is there, i.e. storage opened at boot and the data
#      volume is really mounted — the most common broken-deploy shape, and the
#      one that otherwise only shows up as silently lost history.
# What it deliberately does NOT check: that polling is still progressing. A
# wedged bridge (e.g. a stalled browser lock) keeps its event loop and its
# database file, so it will still report healthy here. Use /status or /check in
# Telegram for that. Do not tighten this into an mtime freshness test: an idle
# bridge legitimately writes nothing for hours, and false "unhealthy" restarts
# would be worse than no signal at all.
HEALTHCHECK --interval=60s --timeout=10s --start-period=180s --retries=3 \
  CMD grep -qsa 'src/index[.]js' /proc/[0-9]*/cmdline && [ -f "${SQLITE_PATH:-./data/max-in-tg.sqlite}" ]

# tini as PID 1 reaps orphaned Chromium processes. Nothing else would: Node
# does not wait() on children it did not spawn, so every renderer or zygote
# left behind by a browser relaunch stayed a zombie until the container was
# restarted — harmless while an external cron restarted it every 2 hours, but
# the bridge now recycles Chromium in-process and the container runs for weeks
# (docker-compose.prod.yml also caps it at 512 pids). tini forwards SIGTERM to
# node, which still shuts down gracefully.
ENTRYPOINT ["/usr/bin/tini", "--"]

# Runs MAX under a virtual X display (Xvfb) — see scripts/start.sh. Requires
# MAX_HEADLESS=false so Chromium launches against the display.
CMD ["sh", "scripts/start.sh"]
