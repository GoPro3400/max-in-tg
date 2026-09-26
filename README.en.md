<div align="center">

# Max Messenger <-> Telegram Bridge

<p>
  <a href="https://github.com/GoPro3400/max-in-tg/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/GoPro3400/max-in-tg/ci.yml?branch=main&style=for-the-badge&logo=githubactions&logoColor=white&label=CI" alt="CI" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-3DA639?style=for-the-badge" alt="MIT License" /></a>
  <img src="https://img.shields.io/badge/Node.js-22-339933?style=for-the-badge&logo=node.js&logoColor=white" alt="Node.js 22" />
  <img src="https://img.shields.io/badge/Telegram-Bot_API-2CA5E0?style=for-the-badge&logo=telegram&logoColor=white" alt="Telegram Bot API" />
  <img src="https://img.shields.io/badge/Docker-Compose-2496ED?style=for-the-badge&logo=docker&logoColor=white" alt="Docker" />
</p>

<p><strong>Two-way bridge between a personal Max Messenger Web session and Telegram.</strong></p>

<p>Max stays open on a server in Chromium while you chat through Telegram Topics — like any regular messenger.</p>

**English (this page)** · [Краткая русская](README.md) · [Полная русская](README.ru.md)

</div>

---

> **Read this first.** This is unofficial automation — there is no MAX API, so the bridge
> drives the real web.max.ru client in a real Chromium on **your own** server, signed in to
> **your own** MAX account, using a stealth plugin whose job is to keep the web client from
> recognising it as a bot. That means **(a)** a MAX front-end change can break it at any
> time, **(b)** the sign-in QR links a device to your account — treat it as a password,
> **(c)** it relays to Telegram and stores in a local database the messages of everyone you
> talk to, who have not consented to that, and **(d)** automating the MAX web client may
> violate its ToS and can get the account suspended. Not affiliated with, or endorsed by,
> MAX, VK or Telegram. See [Disclaimer](#disclaimer).

---

## Table of Contents

- [User Experience](#user-experience)
- [Implemented Features](#implemented-features)
- [Architecture](#architecture)
- [Quick Start](#quick-start-on-vps)
- [Supported Systems](#supported-systems)
- [Telegram Commands](#telegram-commands)
- [Security](#security)
- [Limitations](#known-limitations)
- [Roadmap](#roadmap)
- [License](#license)
- [Disclaimer](#disclaimer)

---

## User Experience

The primary UI is a private Telegram supergroup with Topics enabled:

```
MAX Relay
├── Ivan Petrov         ← personal chat
├── Work Chat           ← group
├── Family              ← group
└── Maria               ← new contact (auto-created)
```

**How it works:**

1. Open a topic with the contact's name
2. Send text, photos, voice messages, videos, or documents
3. The message goes to the corresponding Max chat
4. Incoming Max messages appear in the same topic

> No commands needed for daily messaging. Commands like `/status`, `/check` are only for maintenance.

---

## Implemented Features

### Message Types

| Type | Max → Telegram | Telegram → Max | Notes |
|------|:--------------:|:--------------:|-------|
| Text | :white_check_mark: | :white_check_mark: | |
| Replies (quote) | :warning: | :warning: | MAX→TG: replies to text and media messages arrive as a quoted reply in Telegram (media matched by perceptual image hash and/or CDN token, best-effort). TG→MAX: replying to a **text or media** original that was forwarded from MAX sends a genuine MAX reply — the bot locates the matching bubble in MAX Web (by author/time/text fingerprint, or by CDN token for media) and clicks "Reply". Replying to your own previously Telegram-sent **text** message also works, using a fingerprint captured right after that message was sent into MAX. Replying to your own photo or file sent from Telegram finds it in MAX too (by its CDN token). All of this is best-effort — if the original bubble can't be found or the Reply UI doesn't engage, the message is still sent, just without a quote. |
| Photos / files | :white_check_mark: | :white_check_mark: | TG→MAX via MAX's attach menu ("Photo or video" / "File") + delivery verification. [Details](docs/MEDIA_PIPELINE.md) |
| Voice messages | :white_check_mark: | :warning: | MAX→TG: a real voice message (click play → network intercept → .ogg/.opus/.mp3). TG→MAX: uploaded through MAX's "File" menu, so it lands as an attached audio file, not a playable voice bubble |
| Video notes (circles) | :white_check_mark: | :warning: | MAX→TG: a real video note (roundVideo/videoCanvas detection). TG→MAX: uploaded through "Photo or video" — arrives as an ordinary inline video, not a round one |
| Documents (PDF/DOCX/ZIP) | :white_check_mark: | :white_check_mark: | File forwarding, with the file's name. From MAX, a file over 50 MB (Telegram's limit for bots) is not downloaded — a notice with its name and size arrives instead; one deleted in MAX gets a notice too |
| Stickers | :white_check_mark: | :white_check_mark: | MAX→TG as real Telegram stickers (animated: VP9 `.webm` video sticker; static: `.webp`; fallback GIF/photo). TG→MAX: `.webp` → PNG, `.tgs`/`.webm` → animated GIF with transparency. [Details](docs/MEDIA_PIPELINE.md) |
| Reactions | :white_check_mark: | :white_check_mark: | MAX→TG: the contact's reaction shows as the bot's reaction on that message (nearest one bots may set: 😂 → 🤣). TG→MAX: your reaction is set in MAX as yours; removing it removes it. `SYNC_REACTIONS=false` turns it off. |
| Emoji in text | :white_check_mark: | :white_check_mark: | MAX emoji and animoji arrive as text (they used to vanish, and the message went out as a "photo" of the emoji) |
| Typing | :white_check_mark: | — | While the contact types in MAX (or records a voice message, picks a sticker…), their topic shows the bot "typing…". `SYNC_TYPING=false` turns it off |
| Group chats | :white_check_mark: | :white_check_mark: | The author's name in bold above each group message |

> :bulb: Media & stickers: how TG→MAX photo/file sending works through MAX's attach
> menu, and how stickers become real Telegram stickers (and back) — see [docs/MEDIA_PIPELINE.md](docs/MEDIA_PIPELINE.md).

### Infrastructure

| Feature | Description |
|---------|-------------|
| **Telegram Topics** | Auto-creation of topics for new Max chats |
| **Intro cards** | Pinned message with chat name and ID in each topic |
| **Delivery state** | `message_deliveries` table (pending/sent/failed) |
| **Session validation** | Max Web URL check + auto-restart on expired session |
| **Browser lock** | `AsyncLock` — polling and sending cannot switch chats simultaneously |
| **Active chat verify** | Title check before sending — prevents sending to wrong recipient |
| **Startup priming** | On the first run all existing Max history is marked as seen and never forwarded to Telegram; later starts skip priming, so messages that arrived while the bridge was down are still delivered |
| **Diagnostics** | Screenshot + HTML snapshots in `logs/diagnostics` |
| **Media conversion** | ffmpeg-static + fluent-ffmpeg + sharp |
| **`/merge` / `/unmerge`** | Merge duplicate chats into one topic |
| **Telegram-driven setup** | `/pair` instead of looking up your user id, MAX sign-in by QR right in the chat with the bot, relay group detected automatically when the bot is added |
| **Docker** | `docker-compose.yml` (what the installer runs: memory cap, log rotation) plus the hardened `docker-compose.prod.yml`; the image ships a HEALTHCHECK, so `docker compose ps` shows `Up (healthy)` |
| **Tests** | Unit and integration tests (vitest): messages, asyncLock, fileHelpers, networkCapture, config, database, mediaService, onboarding, and every delivery path over a real in-memory SQLite |

---

## Architecture

### Overall Flow

```
┌─────────────────┐         ┌──────────────────────────────┐         ┌─────────────────┐
│   Max Messenger │◄────────│       max-in-tg Bridge       │────────►│    Telegram     │
│   (Web Client)  │ Puppeteer│                              │ Bot API │  (Topics Group) │
└─────────────────┘         │  ┌────────┐  ┌───────────┐  │         └─────────────────┘
                            │  │ SQLite │  │ AsyncLock │  │
                            │  └────────┘  └───────────┘  │
                            └──────────────────────────────┘
```

### Telegram → Max (Sending)

```
1. User writes in a Telegram topic
2. Bridge resolves: telegram_chat_id + telegram_thread_id → max_chat_id
3. Max Web client acquires browser lock
4. Puppeteer opens the target Max chat
5. Active chat title is verified
6. If verified → message is sent to Max
7. delivery_state: pending → sent (or failed)
```

### Max → Telegram (Receiving)

```
1. Puppeteer reads Max chat list every ~650ms
2. Unread chats are prioritized
3. New messages are extracted (MAX_CHATS_PER_POLL=4 per cycle)
4. If no topic exists → bridge creates one
5. If topic creation fails → fail closed (does NOT send to main group)
6. Message is sent to the Telegram topic
7. SQLite stores processed message IDs (deduplication)
```

### Database Tables

| Table | Purpose |
|-------|---------|
| `chats` | Max chat list |
| `chat_mappings` | Max chat ID ↔ Telegram topic ID mapping |
| `messages` | All forwarded messages (both directions) |
| `message_deliveries` | Delivery status (pending/sent/failed) |
| `settings` | Key-value settings |

---

## Quick Start On VPS

> The whole setup happens in Telegram: no user-id lookups, no chat-id hunting, and no
> shell on the server after the install. The bot token is the only value you type in.

### Requirements

- **What it costs**: an always-on Linux VPS with 2 GB RAM and ~10 GB disk (typically
  €5–10/month). A laptop that sleeps will not do. No cron job is needed any more: the
  bridge relaunches Chromium by itself when it grows (see
  [Known Limitations](#known-limitations) and SETUP_GUIDE §11.1)
- **Server**: Debian 12/13 VPS with Docker + Docker Compose v2
- **Telegram**: a bot token from [@BotFather](https://t.me/BotFather); a private group
  with Topics is optional and detected automatically
- **Max**: an account on web.max.ru + the MAX app on your phone (sign-in is by QR)

### Supported Systems

The bot runs entirely in Docker: the image is built from `node:22-bookworm-slim`, with Chromium, Xvfb, ffmpeg and all required libraries installed inside the container. Docker isolates the runtime from the host OS, so the host barely matters.

| Requirement | Status |
|---|---|
| Docker Engine + Docker Compose v2 | **The only real requirement** — anything that can run those can run this bot |
| Debian (Bookworm), x86_64/amd64 | Tested in production |
| Ubuntu | Should run the same way (Debian-based, highest confidence); host OS doesn't matter — the container is always Debian Bookworm |
| Other Linux distros with Docker (Fedora, etc.) | Should run the same way |
| arm64 CPU | Should work (the base image and the `chromium` apt package are available for arm64), but is **not yet verified** in practice |
| RAM | **2 GB minimum** (`mem_limit: 2048m`, `shm_size: 1gb`). On 1 GB the build dies with `Killed` / `exit code: 137` — better-sqlite3 is compiled inside the container and Chromium runs there |
| Disk | ~10 GB free, minimum, for the image and data |
| Windows / macOS | Fine for development/testing via Docker Desktop; a Linux server is recommended for production (uptime, resources) |
| Native install without Docker | Possible on Debian/Ubuntu (needs Node 22, Chromium, Xvfb, ffmpeg), but this is not the officially supported path |

### Step 1: Install

```bash
git clone https://github.com/GoPro3400/max-in-tg.git
cd max-in-tg
sh scripts/install.sh
```

The installer asks for your bot token — create a bot in
[@BotFather](https://t.me/BotFather) with `/newbot` and paste what it gives you. That
token is the only value you have to provide: the owner's user id and the relay group id
are discovered at runtime and remembered in the bridge's own database (the `settings`
table), so a restart never asks again.

Everything else it does for you: check Docker and Compose v2, write `.env` (the token is
never echoed back to the terminal), prepare `data/ tmp/ logs/`, build the image and start
the container. The bridge prints the pairing code from the next step into its log.
Re-running it is safe — an existing `.env` is never overwritten.

### Step 2: Claim the bot with `/pair`

The installer prints a ready-to-copy `Send exactly:   /pair <code>` line at the end of
its output — that is the easiest place to take the code from.

Open a private chat with your bot, press **Start** (the bot deliberately stays silent:
until it has an owner it runs nothing but `/pair`) and send the code:

```
/pair k3Jq7Rr2_bA
```

The bot confirms that you now own this bridge. Until an owner exists, it executes no
other command from anyone — `/pair` in a private chat is the only thing that gets
through, and a wrong code is logged as a rejected attempt. After five wrong attempts
that Telegram account is locked out of `/pair` for 10 minutes; the code itself stays the
same, so a stranger guessing at it cannot keep you from pairing.

Why the code is long and random (8 random bytes in base64url, like `k3Jq7Rr2_bA`): an
unclaimed bot accepts `/pair` from anyone, and a bot's @username is globally searchable
— a short numeric code could be brute-forced, and the prize would be the QR that signs
in to your MAX account.

Lost the code? Read the latest one back from the log (production logs are JSON, so the
code lives in the `pairingCode` field, not in the message text; run it from the project
directory):

```bash
docker compose logs --no-color | grep -o '"pairingCode":"[^"]*"' | tail -n 1
```

If the bot stays silent on `/pair` too, the bridge is already claimed by a different
Telegram account (it ignores everyone else completely). Get your numeric id from
@userinfobot, put `TELEGRAM_OWNER_ID=…` into `.env` and run
`docker compose up -d --force-recreate` (recreate, not `restart`: `restart` does not
re-read `.env`).

### Step 3: Sign in to MAX with a QR code

Next the bridge opens web.max.ru in Chromium on the server. If there is no live session,
the bot sends you a QR code in your private chat. You scan it with your phone's camera
from the MAX app, so keep Telegram open on a computer — one phone cannot scan itself.
On your phone: **MAX → Settings → Devices → Link device** → scan the code.

- **The QR does not arrive instantly — give it 1–3 minutes.** The bridge re-checks the
  sign-in screen several times (up to 45 seconds) before capturing anything: first a
  "🔐 Нужен вход в MAX" text arrives, then the picture.
- A code is good for about 2 minutes. MAX does **not** re-issue it on its own: it blurs
  the code, says "QR code has expired" and waits for a refresh click. The bot clicks for
  you and replaces the picture in the same message, so no dead codes pile up.
- Once you are signed in, the QR message is deleted, the bot confirms MAX is connected,
  and the bridge starts.
- There is no deadline: until MAX is signed in the bridge has nothing else to do, so it
  keeps the QR fresh for as long as it takes and nudges you at most once every 30
  minutes. Deleted the QR message? Send `/login` — the bot posts a fresh picture as a
  new message.
- A Telegram message sent while MAX is not connected yet is not silently dropped: the
  bot answers "⏳ MAX ещё не подключён — сообщение НЕ отправлено" ("MAX is not connected
  yet — the message was NOT sent"), so just send it again once MAX is connected.
- The same path handles a dropped session later on: the bot sends a new QR instead of
  restarting Chromium in a loop that cannot fix a signed-out account.

> :warning: **The QR is a credential.** Whoever scans it links a device to your MAX
> account. That is why it goes **only to the owner's private chat** — never to the relay
> group, which can have other members — and is deleted as soon as the sign-in succeeds.
> Do not forward it to anyone.

### Step 4: Relay group with Topics (recommended)

1. Create a private group and turn **Topics** on — **before** adding the bot: enabling
   Topics changes the group's internal id, and auto-detection fires exactly once, when
   the bot is added or its rights change
2. Add the bot and promote it to admin. The promote screen needs exactly one right:
   - :white_check_mark: **Manage Topics** — required: without it no topic is created and
     nothing from MAX is delivered at all
   - :white_check_mark: **Pin Messages** — nice to have: without it the intro card is
     simply not pinned, the bridge keeps working
   - There are no **Send Messages** / **Send Media** toggles on that screen and you do
     not need them: a group admin can always post and send media
3. Nothing to configure: the bot picks the group up on its own and says so in the group

Either order works, but the answer lands in different places: if the bot was added to the
group before `/pair`, the group is remembered and adopted right after pairing — but only
once the bot has verified that the freshly paired owner really is a member of that group,
so nobody can pre-plant a group of their own. In that case the bot says nothing in the
group itself; the result (and any complaint about Topics or admin rights) arrives as a
reply to `/pair` in your private chat.

If Topics are off or the bot is not an admin, it explains what to fix and does not adopt
the group; if you granted the rights later, remove the bot from the group and add it
again — Telegram never resends that event. If auto-detection picked the wrong group, send
`/relay` in the right one and the bridge moves there (topics already created stay in the
old group). Without a group the bridge only half works: every MAX chat lands in your
private chat as one stream, and **everything you type there goes to a single selected MAX
chat**, no matter which message you are replying to (`/chats`, `/select <number>`, the
current target shows up in `/status` as `Fallback selected:`).

### Step 5: Verify

In Telegram: `/status` for bridge state, `/chats` for the MAX chats and their routes,
`/check` for the Max Web selectors.

Right after setup the group is empty — by design: on the first run all existing MAX
history is marked as seen, and topics appear as new messages arrive. `/sync` creates
topics for every current chat.

> Full step-by-step guide: **[docs/SETUP_GUIDE.md](docs/SETUP_GUIDE.md)**

---

## Telegram Commands

| Command | Description |
|---------|-------------|
| `/pair <code>` | First run: claim the bridge as its owner. Private chat only, and only while no owner is set; the code is printed in the container log |
| `/login` | Send a QR code to sign in to MAX — after a dropped session, or if the QR message was deleted. The QR always arrives in the owner's private chat |
| `/relay` | Send it inside a private supergroup that has Topics on and the bot as admin — that group becomes the relay. It also works once a relay is already set (owner only), so this is how you move the bridge to another group |
| `/status` | Bridge status (chats, routes, poll failures) |
| `/check` | Verify key Max Web selectors |
| `/diagnostics` | Send latest diagnostic files |
| `/sync` | Force refresh chats and topics |
| `/chats` | List Max chats and routes |
| `/history` | Recent messages in current topic |
| `/deliveries` | Delivery stats (sent/failed/pending) |
| `/merge <name>` | Merge a duplicate chat into current topic |
| `/unmerge <name>` | Undo a merge |
| `/mute <name>` | Stop forwarding a chat (MAX ad/service feeds) |
| `/unmute <name>` | Resume forwarding without dumping the backlog |
| `/select <N>` | Only when no relay group is connected: pick which MAX chat receives what you write in the private chat (number from `/chats`) |

---

## Security

### What's protected

- `.env` is never committed to Git
- `data/chrome-profile` is never committed — it's a live Max session
- Production SQLite DB is never committed
- Telegram access is restricted to the owner (`/pair` or `TELEGRAM_OWNER_ID`) and the relay group
- Before an owner is claimed the bot accepts exactly one command — `/pair <code>` in a
  private chat — so an unclaimed instance cannot be driven by whoever finds it
- The MAX login QR is sent **only** to the owner's private chat (never to the relay
  group) and is deleted right after a successful sign-in
- While the MAX sign-in screen is showing, diagnostic capture takes **no screenshot**, and
  SVG contents are stripped from every diagnostic HTML dump — even with
  `DIAGNOSTIC_REDACT_TEXT=false`. MAX draws the login QR as inline SVG, and
  `/diagnostics` uploads dumps into whatever chat asked for them, including the relay group
- Everything else about a diagnostic capture is **not** anonymised: outside the sign-in
  screen the screenshot shows the MAX window as-is, including the conversation that happens
  to be open, and `/diagnostics` uploads it into the chat that asked — the relay group
  included. `DIAGNOSTIC_REDACT_TEXT=true` redacts the HTML dumps only. Run `/diagnostics`
  from your private chat and delete the files when you are done
- The container runs as **non-root** (uid 10001) in both configurations;
  `docker-compose.yml` (what the installer brings up) caps memory and rotates logs
- The hardened `docker-compose.prod.yml` adds `no-new-privileges`, `cap_drop: ALL`, a
  read-only root fs, `pids_limit` and tmpfs `/tmp`; run it explicitly with
  `docker compose -f docker-compose.prod.yml up -d --build`

### Routing safety principles

- If a topic can't be created → **fail closed** (don't send to main group)
- Active Max chat must be verified before sending
- If verification fails → message is **not sent**
- Browser lock prevents race conditions during chat switching

---

## Known Limitations

| # | Limitation | Details |
|---|-----------|---------|
| 1 | **Max Web DOM** | Project depends on DOM selectors. Max Web updates may break things. Use `/check` for diagnostics |
| 2 | **Stickers** | Network intercept of the Lottie/sticker asset, then a canvas screenshot; if neither works the message arrives as the text `[Стикер]` |
| 3 | **Chromium memory** | The leak that grew the renderer to ~2 GB in ~3 hours is fixed. As a safety net the bridge reloads the MAX tab above 900 MB and relaunches Chromium above 1300 MB or every 6 hours, between poll cycles (`MAX_PAGE_RELOAD_MEMORY_MB`, `MAX_BROWSER_MEMORY_LIMIT_MB`, `MAX_BROWSER_RECYCLE_MINUTES`); the Telegram bot stays online and no cron job is needed — [SETUP_GUIDE §11.1](docs/SETUP_GUIDE.md) |
| 4 | **At-least-once** | Possible duplicates if process crashes between send and SQLite write |
| 5 | **Chat identity** | By title/index — same-named chats may be confused |
| 6 | **Single user** | Self-hosted for one Max account |
| 7 | **No retry policy** | Failed deliveries are not automatically retried |
| 8 | **Media reply matching accuracy** | Best-effort: photos match by dHash (most reliable), other types only when a CDN token for the original is available; messages forwarded before this update have no hash and won't be matched retroactively; if matching isn't confident, no quote is attached |
| 9 | **Telegram→MAX replies** | Works for replies to text and media MAX originals, and to your own previously Telegram-sent text messages; replies to your own non-text messages (photos etc.) aren't resolved yet. Always best-effort: if the bot can't locate the target bubble in MAX Web, the message is sent without a quote rather than failing |
| 10 | **Reactions** | A Telegram bot can set only one reaction, from Telegram's list — the most used one (or its nearest stand-in) is shown. Reactions work on messages that are on screen in MAX Web; the reaction markup is taken from MAX Web's own code — if it changes, see `/diagnostics` and the reaction `MAX_SELECTORS_*` |

---

## Roadmap

### P1 (Priority)

- [ ] **`/new <phone|name>`** — start a new Max chat from Telegram with candidate confirmation
- [ ] **Extended contact card** — avatar, phone, username, metadata
- [ ] **Chat fingerprint** — stronger identification (avatar hash instead of title)

### P2 (After P1)

- [ ] Retry policy for failed deliveries
- [ ] Integration Puppeteer fixture tests (selector checks against a mock DOM)
- [ ] Admin/status Mini App

> Full roadmap: **[docs/ROADMAP.md](docs/ROADMAP.md)**

---

## Project Structure

```
max-in-tg/
├── src/
│   ├── index.js              # Entry point
│   ├── config.js             # Configuration from .env
│   ├── logger.js             # Pino logger
│   ├── adapters/
│   │   ├── maxWebClient.js   # Puppeteer + Max Web automation
│   │   └── telegramBot.js    # Telegraf bot + commands
│   ├── services/
│   │   ├── bridge.js         # Core routing logic
│   │   ├── mediaService.js   # Media conversion
│   │   └── asyncLock.js      # Browser operation lock
│   ├── storage/
│   │   └── database.js       # SQLite (chats, mappings, messages)
│   ├── domain/
│   │   └── messages.js       # Message types, directions
│   ├── utils/
│   │   ├── fileHelpers.js    # safeName, saveBuffer, listFilesByMtime
│   │   └── networkCapture.js # findNewestCapture
│   └── scripts/
│       └── resetDatabase.js  # DB reset
├── tests/                    # Unit and integration tests (vitest)
├── docs/                     # Documentation
├── scripts/
│   ├── install.sh            # Install: asks for the bot token, brings the container up
│   ├── start.sh              # In-container entrypoint (Xvfb + Chromium)
│   └── devtools-repl.js      # Live-browser debugging over CDP
├── Dockerfile                # Production image
├── docker-compose.yml        # what install.sh runs (memory cap + log rotation)
└── docker-compose.prod.yml   # same plus hardening (read-only fs, cap_drop, pids_limit)
```

---

## License

Released under the **MIT License** — see the [LICENSE](LICENSE) file.

Building the Docker image pulls in third-party components under other licences (ffmpeg,
libvips) — see [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md). The image is meant to be
built locally on your own server, not redistributed.

## Disclaimer

Status: a one-person hobby project. Support is best-effort and backwards compatibility is not guaranteed.

This software is provided "as is", without warranty of any kind (see [LICENSE](LICENSE)).

It is intended for personal and educational use. You are solely responsible for complying with the Terms of Service of MAX and with the laws applicable in your jurisdiction. Automating the MAX web client may violate its ToS and can result in your account being suspended.

This bridge copies conversations — including messages written by people other than you, who have not consented to their messages being relayed to Telegram or stored in a local database. Depending on your jurisdiction that may carry data-protection obligations. Do not run it on shared, work, or group accounts without the participants' knowledge.

This project is not affiliated with, or endorsed by, MAX, VK, or Telegram.
