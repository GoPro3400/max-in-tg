import { logger } from '../logger.js';

// Tells the owner, once, when a newer release of the bridge is out. Once a day
// it asks GitHub for the latest release (one request to api.github.com, nothing
// else is sent); UPDATE_CHECK=false turns it off.

const DAY_MS = 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10 * 1000;
const STATE_KEY = 'update_check';

// "v1.2.3", "1.2.3", "1.2.3-rc.1" → { numbers: [1, 2, 3], prerelease: 'rc.1' | null }; null for anything else.
export const parseVersion = (value) => {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(value ?? '').trim());
  if (!match) return null;
  return { numbers: match.slice(1, 4).map(Number), prerelease: match[4] || null };
};

// > 0 when `a` is the newer version, < 0 when `b` is, 0 when they are the same
// (null when either is not a version). A pre-release is older than the release
// it leads up to: 1.2.0-rc.1 < 1.2.0.
export const compareVersions = (a, b) => {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return null;
  for (let index = 0; index < 3; index += 1) {
    if (left.numbers[index] !== right.numbers[index]) return left.numbers[index] > right.numbers[index] ? 1 : -1;
  }
  if (left.prerelease === right.prerelease) return 0;
  if (!left.prerelease) return 1;
  if (!right.prerelease) return -1;
  return left.prerelease > right.prerelease ? 1 : -1;
};

export class UpdateChecker {
  // notify(text) → true once the owner has been told.
  constructor({
    db,
    notify,
    currentVersion,
    repo,
    enabled = false,
    fetchImpl = globalThis.fetch,
    now = () => Date.now(),
    intervalMs = DAY_MS
  }) {
    this.db = db;
    this.notify = notify;
    this.currentVersion = currentVersion;
    this.repo = repo;
    this.enabled = Boolean(enabled);
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.intervalMs = intervalMs;
    this.timer = null;
  }

  readState() {
    const state = this.db.getSetting(STATE_KEY, null);
    return state && typeof state === 'object' ? state : {};
  }

  // The newest release known from the last check, when it is newer than this
  // version — for /status. Nothing is fetched.
  available() {
    if (!this.enabled) return null;
    const { latest } = this.readState();
    return latest && compareVersions(latest.version, this.currentVersion) > 0 ? latest : null;
  }

  // One step: fetch when the last successful check is older than the interval,
  // and tell the owner about a newer release they have not been told of yet.
  // A failed fetch is tried again at the next step (the bridge takes one an
  // hour); a failed message likewise, without fetching again.
  async check() {
    if (!this.enabled) return { state: 'disabled' };
    if (!parseVersion(this.currentVersion)) return { state: 'unknown-version' };

    let state = this.readState();
    if (!state.checkedAt || this.now() - state.checkedAt >= this.intervalMs) {
      let latest;
      try {
        latest = await this.fetchLatest();
      } catch (error) {
        logger.debug({ err: error?.message || String(error) }, 'Update check failed, will try again');
        return { state: 'failed' };
      }
      state = { ...state, checkedAt: this.now(), latest };
      this.db.setSetting(STATE_KEY, state);
    }
    return this.announce(state);
  }

  async announce(state) {
    const latest = state.latest;
    if (!latest || compareVersions(latest.version, this.currentVersion) <= 0) return { state: 'current', latest: latest || null };
    if (state.notified === latest.version) return { state: 'available', latest, notified: false };

    let told = false;
    try {
      told = Boolean(await this.notify(this.message(latest)));
    } catch (error) {
      logger.warn({ err: error?.message || String(error) }, 'Could not tell the owner about the new version');
    }
    if (told) this.db.setSetting(STATE_KEY, { ...state, notified: latest.version });
    return { state: 'available', latest, notified: told };
  }

  // The latest stable release: { version, url }, or null when there is none.
  async fetchLatest() {
    const response = await this.fetchImpl(`https://api.github.com/repos/${this.repo}/releases/latest`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': `max-in-tg/${this.currentVersion}`
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    if (response.status === 404) return null; // no release yet
    if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
    const release = await response.json();
    if (release?.draft || release?.prerelease) return null;
    const parsed = parseVersion(release?.tag_name);
    if (!parsed || parsed.prerelease) return null;
    // The address is made here, from the tag (which parseVersion has checked),
    // rather than taken from the answer.
    return {
      version: parsed.numbers.join('.'),
      url: `https://github.com/${this.repo}/releases/tag/${release.tag_name}`
    };
  }

  message(latest) {
    return [
      `🆕 Вышла новая версия max-in-tg: ${latest.version} (сейчас ${this.currentVersion}).`,
      `Что нового: ${latest.url}`,
      '',
      'Обновить — на сервере, в папке проекта:',
      'docker compose pull',
      'docker compose up -d',
      '',
      'Проверка идёт раз в сутки и состоит из одного запроса к api.github.com за номером последней версии. Отключить: UPDATE_CHECK=false в .env.'
    ].join('\n');
  }

  // Checks shortly after the bridge starts, then every `tickMs`. The timer
  // never keeps the process alive.
  start({ firstDelayMs = 2 * 60 * 1000, tickMs = 60 * 60 * 1000 } = {}) {
    if (!this.enabled || this.timer) return;
    const schedule = (delay) => {
      this.timer = setTimeout(async () => {
        try {
          await this.check();
        } catch (error) {
          logger.debug({ err: error?.message || String(error) }, 'Update check step failed');
        }
        if (this.timer) schedule(tickMs);
      }, delay);
      if (this.timer.unref) this.timer.unref();
    };
    schedule(firstDelayMs);
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
