#!/bin/sh
# max-in-tg - one-command installer.
#
#   sh scripts/install.sh        (run from the repository root)
#
# Checks Docker, creates .env (asking only for the Telegram bot token), prepares
# the bind-mounted directories, builds and starts the container, then waits for
# the pairing code and prints what to do next.
#
# Safe to re-run: an existing .env is never overwritten, directories are only
# created if missing, and the bot token is never printed back to the terminal.
set -eu

TOTAL_STEPS=6
STEP=0
ECHO_OFF=0
TMP_ENV=''
CONTAINER_UID=10001
CONTAINER_GID=10001
WAIT_SECONDS=180

ESC=$(printf '\033')
CR=$(printf '\r')

info() { printf '      %s\n' "$*"; }
warn() { printf '      !  %s\n' "$*" >&2; }

step() {
  STEP=$((STEP + 1))
  printf '\n[%d/%d] %s\n' "$STEP" "$TOTAL_STEPS" "$*"
}

# die "headline" "hint" "hint"...
die() {
  printf '\nFAILED: %s\n' "$1" >&2
  shift
  for hint in "$@"; do printf '        %s\n' "$hint" >&2; done
  exit 1
}

cleanup() {
  if [ "$ECHO_OFF" = 1 ]; then stty echo 2>/dev/null || true; fi
  if [ -n "$TMP_ENV" ] && [ -f "$TMP_ENV" ]; then rm -f "$TMP_ENV"; fi
}
trap cleanup EXIT
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM

# pino-pretty colourises its output, and `docker compose logs --no-color` only
# strips compose's own prefix colours - the escape codes inside the log line
# survive and would break the greps below.
strip_ansi() { sed "s/${ESC}\[[0-9;]*[a-zA-Z]//g"; }

printf 'max-in-tg installer\n'
printf -- '-------------------\n'

# ---------------------------------------------------------------- 1. Docker --
step 'Checking Docker'

command -v docker >/dev/null 2>&1 || die \
  'Docker is not installed (or not on PATH).' \
  'Install it and re-run this script:' \
  '  https://docs.docker.com/engine/install/' \
  '  (Debian/Ubuntu shortcut: curl -fsSL https://get.docker.com | sh)'

docker compose version >/dev/null 2>&1 || die \
  "'docker compose' (Compose v2) is not available." \
  'The old standalone "docker-compose" v1 binary will not work here.' \
  'Install the plugin:' \
  '  sudo apt-get install docker-compose-plugin' \
  '  https://docs.docker.com/compose/install/'

docker info >/dev/null 2>&1 || die \
  'The Docker daemon is not reachable.' \
  'Start it:                sudo systemctl start docker' \
  'Permission denied?       sudo usermod -aG docker "$USER" && newgrp docker' \
  'or re-run this script with sudo.'

info 'docker + docker compose: ok'

# Compose derives the project name from the DIRECTORY name, and container names
# from the project. So a second copy of this project in a directory that happens
# to share a name with an existing one silently ADOPTS that instance's
# containers: `up -d` recreates them against the new directory's volumes, and
# the original bridge stops without a word. That is not hypothetical: it has
# happened on a real server, where a second checkout in a directory of the same
# basename adopted the first one's containers. Refuse instead, and name the way
# out.
PROJECT_NAME=${COMPOSE_PROJECT_NAME:-$(basename "$PWD" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9_-')}
OTHER_DIR=$(docker ps -a \
  --filter "label=com.docker.compose.project=$PROJECT_NAME" \
  --format '{{.Label "com.docker.compose.project.working_dir"}}' 2>/dev/null | head -n 1)

if [ -n "$OTHER_DIR" ] && [ "$OTHER_DIR" != "$PWD" ]; then
  die \
    "Another copy of this project already runs under the name '$PROJECT_NAME'." \
    "It lives in:  $OTHER_DIR" \
    "You are in:   $PWD" \
    'Continuing would take over ITS containers and stop that bridge.' \
    '' \
    'Pick one:' \
    "  - run this copy under its own name:  COMPOSE_PROJECT_NAME=${PROJECT_NAME}2 sh scripts/install.sh" \
    '  - or rename this directory to something unique and re-run.' \
    '' \
    'Remember the name afterwards - every docker compose command for this' \
    'copy needs it:  docker compose -p <name> logs -f'
fi

# ------------------------------------------------------------- 2. Repo root --
step 'Checking that this is the max-in-tg repository root'

[ -f package.json ] || die \
  'No package.json in the current directory.' \
  'Run this from the repository root:' \
  '  cd /path/to/max-in-tg && sh scripts/install.sh'

grep -q '"name"[[:space:]]*:[[:space:]]*"max-in-tg"' package.json || die \
  'This package.json is not max-in-tg.' \
  'Run this from the max-in-tg repository root.'

info "repository root: $(pwd)"

# ------------------------------------------------------------------ 3. .env --
step 'Preparing .env'

ENV_CREATED=0
if [ ! -f .env ]; then
  [ -f .env.example ] || die \
    'Neither .env nor .env.example exists.' \
    'The repository looks incomplete - re-clone it and try again.'
  cp .env.example .env
  chmod 600 .env
  ENV_CREATED=1
  info 'created .env from .env.example (mode 600)'
else
  chmod 600 .env 2>/dev/null || true
  info 'found an existing .env - keeping it as is'
  # A CRLF .env makes every value end in \r inside the container; the bot token
  # then fails Telegram auth for no visible reason.
  CR_COUNT=$(tr -cd "$CR" < .env | wc -c | tr -d ' ')
  if [ "${CR_COUNT:-0}" -gt 0 ]; then
    warn '.env has Windows (CRLF) line endings - values will carry a stray \r'
    info "fix it with:  sed -i 's/\\r\$//' .env"
  fi
fi

# Does .env already carry a usable token? (Never read into a variable that gets
# printed; only tested.)
NEEDS_TOKEN=1
if grep -Eq '^TELEGRAM_BOT_TOKEN=[^[:space:]]+' .env \
   && ! grep -Eq '^TELEGRAM_BOT_TOKEN=.*replace-me' .env; then
  NEEDS_TOKEN=0
fi

BOT_TOKEN=''
if [ "$NEEDS_TOKEN" = 1 ]; then
  if [ ! -t 0 ]; then
    die \
      'TELEGRAM_BOT_TOKEN is not set and there is no terminal to ask on.' \
      'Open .env, put the token from @BotFather on this line:' \
      '  TELEGRAM_BOT_TOKEN=123456789:AA...' \
      'then re-run: sh scripts/install.sh'
  fi
  printf '\n      Talk to @BotFather in Telegram, create a bot, copy its token.\n'
  # Echo is switched off before the prompt is drawn, so the label only promises
  # hidden input when it is actually hidden.
  PROMPT_TAIL=''
  if command -v stty >/dev/null 2>&1 && stty -echo 2>/dev/null; then
    ECHO_OFF=1
    PROMPT_TAIL=' (input hidden)'
  fi
  printf '      Bot token%s: ' "$PROMPT_TAIL"
  if ! read -r BOT_TOKEN; then
    die 'Could not read the token from the terminal.'
  fi
  if [ "$ECHO_OFF" = 1 ]; then stty echo 2>/dev/null || true; ECHO_OFF=0; fi
  printf '\n'

  # Shape check only - piped, never passed as an argument, so it cannot show up
  # in `ps` output or shell history.
  if ! printf '%s' "$BOT_TOKEN" | grep -Eq '^[0-9]{5,}:[A-Za-z0-9_-]{25,}$'; then
    die \
      'That does not look like a Telegram bot token.' \
      'Expected <digits>:<letters, digits, _ or ->, e.g. 123456789:AA...' \
      'Copy it exactly as @BotFather sent it, then re-run: sh scripts/install.sh'
  fi
fi

# Rewrite .env line by line: sed on a user-supplied value could mangle the file
# (and put the token in a command line), a full rewrite cannot.
if [ "$NEEDS_TOKEN" = 1 ] || [ "$ENV_CREATED" = 1 ]; then
  TMP_ENV=".env.install.$$"
  (umask 077; : > "$TMP_ENV")
  ENV_HAS_TOKEN=0
  LINE=''
  while IFS= read -r LINE || [ -n "$LINE" ]; do
    # A repository cloned on Windows (core.autocrlf) carries CRLF line endings;
    # docker compose would then read "info\r" as a value. Normalise to LF.
    LINE=${LINE%"$CR"}
    case "$LINE" in
      TELEGRAM_BOT_TOKEN=*)
        ENV_HAS_TOKEN=1
        if [ "$NEEDS_TOKEN" = 1 ]; then
          printf 'TELEGRAM_BOT_TOKEN=%s\n' "$BOT_TOKEN"
        else
          printf '%s\n' "$LINE"
        fi
        ;;
      # Owner and relay group are discovered at runtime (/pair + the bot being
      # added to the group), so a fresh .env must leave them empty. An .env the
      # operator already had is left untouched.
      TELEGRAM_OWNER_ID=*)
        if [ "$ENV_CREATED" = 1 ]; then printf 'TELEGRAM_OWNER_ID=\n'; else printf '%s\n' "$LINE"; fi
        ;;
      TELEGRAM_RELAY_CHAT_ID=*)
        if [ "$ENV_CREATED" = 1 ]; then printf 'TELEGRAM_RELAY_CHAT_ID=\n'; else printf '%s\n' "$LINE"; fi
        ;;
      *)
        printf '%s\n' "$LINE"
        ;;
    esac
  done < .env >> "$TMP_ENV"
  if [ "$ENV_HAS_TOKEN" = 0 ] && [ "$NEEDS_TOKEN" = 1 ]; then
    printf 'TELEGRAM_BOT_TOKEN=%s\n' "$BOT_TOKEN" >> "$TMP_ENV"
  fi
  mv "$TMP_ENV" .env
  chmod 600 .env
  TMP_ENV=''
fi
BOT_TOKEN=''
unset BOT_TOKEN

if [ "$NEEDS_TOKEN" = 1 ]; then
  info 'bot token written to .env (mode 600, never printed)'
else
  info 'TELEGRAM_BOT_TOKEN is already set in .env'
fi
if [ "$ENV_CREATED" = 1 ]; then
  info 'TELEGRAM_OWNER_ID / TELEGRAM_RELAY_CHAT_ID left empty - discovered at runtime'
fi

# ----------------------------------------------------------- 4. Directories --
step 'Preparing data/ tmp/ logs/'

mkdir -p data tmp logs

OWNERSHIP_OK=0
CURRENT_UID=$(id -u)
if [ "$CURRENT_UID" = "$CONTAINER_UID" ]; then
  OWNERSHIP_OK=1
  info "already running as uid $CONTAINER_UID - nothing to chown"
elif [ "$CURRENT_UID" = 0 ]; then
  if chown -R "$CONTAINER_UID:$CONTAINER_GID" data tmp logs 2>/dev/null; then
    OWNERSHIP_OK=1
  fi
elif command -v sudo >/dev/null 2>&1; then
  if sudo -n chown -R "$CONTAINER_UID:$CONTAINER_GID" data tmp logs 2>/dev/null; then
    OWNERSHIP_OK=1
  elif [ -t 0 ]; then
    info "sudo password needed to give data/ tmp/ logs/ to uid $CONTAINER_UID"
    if sudo chown -R "$CONTAINER_UID:$CONTAINER_GID" data tmp logs; then
      OWNERSHIP_OK=1
    fi
  fi
fi

if [ "$OWNERSHIP_OK" = 1 ]; then
  info "data/ tmp/ logs/ owned by uid $CONTAINER_UID"
else
  info "cannot chown directly - will do it through docker after the build"
fi

# ------------------------------------------------------- 5. Build and start --
step 'Building the image and starting the container (first build takes minutes)'

if ! docker compose build; then
  die \
    'docker compose build failed - the reason is in the output above.' \
    'Usual suspects: no disk space, or no network access for apt/npm.'
fi

if [ "$OWNERSHIP_OK" != 1 ]; then
  # Neither root nor passwordless sudo, which is the normal case for a plain
  # user account. But anyone who can run `docker compose` can already act as
  # root through it, so borrow exactly that: a throwaway root container with
  # the compose file's own bind mounts. Without this the bridge dies on its
  # first mkdir with EACCES, which is what a fresh install used to do.
  SERVICE=$(docker compose config --services 2>/dev/null | head -n 1)
  if [ -n "$SERVICE" ] && docker compose run --rm --user 0:0 --entrypoint sh "$SERVICE" \
      -c "chown -R $CONTAINER_UID:$CONTAINER_GID /app/data /app/tmp /app/logs" >/dev/null 2>&1; then
    OWNERSHIP_OK=1
    info "data/ tmp/ logs/ handed to uid $CONTAINER_UID via docker"
  fi
fi

if [ "$OWNERSHIP_OK" != 1 ]; then
  warn "could not give data/ tmp/ logs/ to uid $CONTAINER_UID"
  info 'The container runs as an unprivileged user (uid 10001) and writes the'
  info 'database, media and logs into those directories. If it starts and then'
  info 'dies with EACCES / "permission denied", run:'
  info "    sudo chown -R $CONTAINER_UID:$CONTAINER_GID data tmp logs"
  info 'On Docker Desktop (macOS/Windows) this warning is expected and harmless -'
  info 'bind-mount ownership is remapped for you.'
fi

if ! docker compose up -d; then
  die \
    'docker compose up failed - the reason is in the output above.' \
    'Usual suspects: no disk space, or a stray quote in .env.'
fi
info 'container started'

# ----------------------------------------------------------- 6. Pairing code --
step "Waiting for the bridge to report in (up to ${WAIT_SECONDS}s)"

CID=$(docker compose ps -q 2>/dev/null | head -n 1)
if [ -z "$CID" ]; then
  die \
    'The container is not running right after "docker compose up -d".' \
    'Look at the logs:  docker compose logs --tail=50'
fi

DEADLINE=$(( $(date +%s) + WAIT_SECONDS ))
OUTCOME=timeout
PAIRED=0
PAIRING_CODE=''

printf '      '
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  CSTATE=$(docker inspect -f '{{.State.Status}}' "$CID" 2>/dev/null || printf 'unknown')
  if [ "$CSTATE" != running ]; then
    OUTCOME=crashed
    break
  fi

  LOGS=$(docker compose logs --no-color --tail=500 2>/dev/null | strip_ansi || true)

  # Line numbers, so the newest marker wins: the container keeps its log across
  # in-place restarts, and a pairing code from an earlier boot is dead.
  L_CODE=$(printf '%s\n' "$LOGS" | grep -n 'pairingCode' | tail -n 1 | cut -d: -f1)
  L_OWNER=$(printf '%s\n' "$LOGS" | grep -nE 'Owner paired|Restored Telegram owner' | tail -n 1 | cut -d: -f1)
  L_READY=$(printf '%s\n' "$LOGS" | grep -nE 'Bridge started|Max Web client ready' | tail -n 1 | cut -d: -f1)
  L_QR=$(printf '%s\n' "$LOGS" | grep -n 'needs a sign-in' | tail -n 1 | cut -d: -f1)
  L_FAIL=$(printf '%s\n' "$LOGS" | grep -n 'Startup failed' | tail -n 1 | cut -d: -f1)

  if [ "${L_OWNER:-0}" -gt 0 ]; then PAIRED=1; fi

  if [ "${L_FAIL:-0}" -gt "${L_CODE:-0}" ] && [ "${L_FAIL:-0}" -gt "${L_OWNER:-0}" ]; then
    OUTCOME=startup-failed
    break
  fi
  if [ "${L_CODE:-0}" -gt "${L_OWNER:-0}" ]; then
    # The code is 8 random bytes in base64url (letters, digits, - and _), not
    # digits: it has to resist guessing, because an unclaimed bot accepts /pair
    # Read the code out of either log format: structured JSON
    # ("pairingCode":"<code>") in production, or pino-pretty's coloured
    # `pairingCode: "<code>"` when NODE_ENV=development. Colour codes are
    # stripped first — otherwise the escape sequences sit between the key and
    # the value and nothing matches, which looked exactly like the bridge
    # having failed to start.
    PAIRING_CODE=$(printf '%s\n' "$LOGS" \
      | sed -E "s/${ESC}\[[0-9;]*m//g" \
      | sed -n 's/.*pairingCode"\{0,1\}[[:space:]]*:[[:space:]]*"\([A-Za-z0-9_-]\{1,\}\)".*/\1/p' \
      | tail -n 1)
    if [ -n "$PAIRING_CODE" ]; then
      OUTCOME=pairing
      break
    fi
  fi
  if [ "${L_READY:-0}" -gt 0 ]; then
    OUTCOME=running
    break
  fi
  if [ "${L_QR:-0}" -gt 0 ] && [ "${L_QR:-0}" -gt "${L_OWNER:-0}" ]; then
    OUTCOME=login
    break
  fi

  printf '.'
  sleep 3
done
printf '\n'

if [ "$OUTCOME" = timeout ] && [ "$PAIRED" = 1 ]; then
  OUTCOME=starting
fi

printf '\n'
case "$OUTCOME" in
  pairing)
    printf 'Almost there. Finish it in Telegram:\n\n'
    printf '  1. Open a private chat with your bot (the @username @BotFather gave you)\n'
    printf '     and press Start.\n'
    printf '  2. Send exactly:   /pair %s\n' "$PAIRING_CODE"
    printf '  3. The bot answers with a QR code for MAX. On your phone:\n'
    printf '     MAX -> Settings -> Devices -> link a device -> scan it.\n'
    printf '     That QR is a credential: it binds a device to your MAX account.\n'
    printf '     Never forward it to anyone.\n'
    printf '     A code lasts about 2 minutes. MAX does not renew it by itself -\n'
    printf '     the bot replaces the picture inside the same message, so always\n'
    printf '     scan the latest version of it.\n'
    printf '  4. Turn Topics ON in a private group FIRST, then add the bot as an\n'
    printf '     admin with "Manage Topics". The bot picks the group up by itself;\n'
    printf '     every MAX chat becomes a topic. Already added it? Send /relay there.\n\n'
    printf 'The code stays valid until the container restarts. Lost it?\n'
    printf "  docker compose logs --no-color | grep -o '\"pairingCode\":\"[^\"]*\"' | tail -n 1\n"
    ;;
  login)
    printf 'This bridge is already paired to an owner.\n\n'
    printf 'MAX needs a sign-in and the bot has just sent a QR code to your private\n'
    printf 'chat with it:  MAX -> Settings -> Devices -> link a device -> scan it.\n'
    printf 'A code lasts about 2 minutes; the bot refreshes the picture inside that\n'
    printf 'same message, so scan the latest version. The message disappears once the\n'
    printf 'sign-in lands. Never forward that QR to anyone.\n'
    printf 'Deleted the message by accident? Send /login to the bot.\n'
    ;;
  running)
    printf 'Up and running - MAX is connected and the bridge is polling.\n\n'
    printf '  Send /status to the bot to see what it thinks.\n'
    printf '  Relay group missing? Create a private group with Topics on and add\n'
    printf '  the bot as an admin - it detects the group by itself.\n'
    ;;
  starting)
    printf 'Already paired; still starting up (MAX/Chromium takes a while).\n\n'
    printf '  Watch it:   docker compose logs -f\n'
    printf '  If MAX asks for a sign-in, the QR arrives in your private chat with\n'
    printf '  the bot; you can also request one with /login.\n'
    ;;
  crashed | startup-failed)
    printf 'The container did not stay up. Last 30 log lines:\n\n'
    docker compose logs --no-color --tail=30 || true
    printf '\nMost common causes:\n'
    printf '  - wrong TELEGRAM_BOT_TOKEN in .env (401 from Telegram)\n'
    printf '  - data/ tmp/ logs/ not writable by uid %s (see step 4)\n' "$CONTAINER_UID"
    printf '  - another copy of this bot already polling the same token\n\n'
    printf 'Fix, then re-run: sh scripts/install.sh\n'
    exit 1
    ;;
  *)
    printf 'The container is running, but no pairing code appeared within %ss.\n\n' "$WAIT_SECONDS"
    printf '  Follow the logs:   docker compose logs -f\n'
    printf '  Look for the code: docker compose logs | grep pairingCode\n'
    printf '  Start over:        docker compose down && sh scripts/install.sh\n'
    exit 1
    ;;
esac

printf '\nHandy afterwards:\n'
if [ -n "${COMPOSE_PROJECT_NAME:-}" ]; then
  # This copy does not use the default project name, so every compose command
  # needs -p or it talks to a different instance (or to nothing at all).
  printf '  (this copy runs as project "%s" - keep the -p flag)\n' "$COMPOSE_PROJECT_NAME"
  printf '  docker compose -p %s logs -f      follow the bridge\n' "$COMPOSE_PROJECT_NAME"
  printf '  docker compose -p %s restart      restart it\n' "$COMPOSE_PROJECT_NAME"
  printf '  docker compose -p %s down         stop it (data/ is kept)\n' "$COMPOSE_PROJECT_NAME"
else
  printf '  docker compose logs -f      follow the bridge\n'
  printf '  docker compose restart      restart it\n'
  printf '  docker compose down         stop it (data/ is kept)\n'
fi
