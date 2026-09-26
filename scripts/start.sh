#!/bin/sh
set -eu

# Production entrypoint. MAX Web runs under a virtual X display (Xvfb) instead of
# headless Chromium: headless does not reliably paint MAX's sticker canvas, so
# animated stickers came through inconsistently. Set MAX_HEADLESS=false so
# Puppeteer launches Chromium against this display.
export DISPLAY="${DISPLAY:-:99}"
DISP_NUM=$(printf '%s' "$DISPLAY" | tr -d ':')

rm -f "/tmp/.X${DISP_NUM}-lock" "/tmp/.X11-unix/X${DISP_NUM}" 2>/dev/null || true
mkdir -p /tmp/.X11-unix 2>/dev/null || true

Xvfb "$DISPLAY" -screen 0 1440x980x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &

# Wait for the X socket so Chromium does not race the display.
i=0
while [ "$i" -lt 30 ]; do
  [ -e "/tmp/.X11-unix/X${DISP_NUM}" ] && break
  i=$((i + 1))
  sleep 0.2
done

# exec so node replaces this shell as tini's direct child (see the Dockerfile's
# ENTRYPOINT) and receives the SIGTERM tini forwards, for a graceful shutdown.
exec node src/index.js
