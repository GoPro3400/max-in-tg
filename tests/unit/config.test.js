import { describe, it, expect, beforeEach, afterEach } from 'vitest';

/**
 * config.js exports `config` which calls required() at import time.
 * We test the helper logic (bool, int, required) by dynamically importing
 * the module with environment variables set appropriately.
 */

describe('config helpers', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Minimal env so config.js can be imported without throwing
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    process.env.TELEGRAM_OWNER_ID = '12345';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe('bool parsing', () => {
    it('parses "1" as true', async () => {
      process.env.TELEGRAM_USE_TOPICS = '1';
      const { config } = await import('../../src/config.js?' + Date.now() + 'a');
      expect(config.telegram.useTopics).toBe(true);
    });

    it('parses "true" as true', async () => {
      process.env.TELEGRAM_USE_TOPICS = 'true';
      const { config } = await import('../../src/config.js?' + Date.now() + 'b');
      expect(config.telegram.useTopics).toBe(true);
    });

    it('parses "yes" as true', async () => {
      process.env.TELEGRAM_USE_TOPICS = 'yes';
      const { config } = await import('../../src/config.js?' + Date.now() + 'c');
      expect(config.telegram.useTopics).toBe(true);
    });

    it('parses "on" as true', async () => {
      process.env.TELEGRAM_USE_TOPICS = 'on';
      const { config } = await import('../../src/config.js?' + Date.now() + 'd');
      expect(config.telegram.useTopics).toBe(true);
    });

    it('parses "0" as false', async () => {
      process.env.TELEGRAM_USE_TOPICS = '0';
      const { config } = await import('../../src/config.js?' + Date.now() + 'e');
      expect(config.telegram.useTopics).toBe(false);
    });

    it('parses "false" as false', async () => {
      process.env.TELEGRAM_USE_TOPICS = 'false';
      const { config } = await import('../../src/config.js?' + Date.now() + 'f');
      expect(config.telegram.useTopics).toBe(false);
    });

    it('falls back to default when empty', async () => {
      delete process.env.TELEGRAM_USE_TOPICS;
      const { config } = await import('../../src/config.js?' + Date.now() + 'g');
      // Default for useTopics is true
      expect(config.telegram.useTopics).toBe(true);
    });

    it('is case-insensitive', async () => {
      process.env.TELEGRAM_USE_TOPICS = 'TRUE';
      const { config } = await import('../../src/config.js?' + Date.now() + 'h');
      expect(config.telegram.useTopics).toBe(true);
    });
  });

  describe('int parsing', () => {
    it('parses valid integer', async () => {
      process.env.POLL_INTERVAL_MS = '1000';
      const { config } = await import('../../src/config.js?' + Date.now() + 'i');
      expect(config.pollIntervalMs).toBe(1000);
    });

    it('falls back to default on non-numeric value', async () => {
      process.env.POLL_INTERVAL_MS = 'abc';
      const { config } = await import('../../src/config.js?' + Date.now() + 'j');
      expect(config.pollIntervalMs).toBe(650); // default
    });

    it('falls back to default when not set', async () => {
      delete process.env.POLL_INTERVAL_MS;
      const { config } = await import('../../src/config.js?' + Date.now() + 'k');
      expect(config.pollIntervalMs).toBe(650);
    });

    it('parses negative integers', async () => {
      process.env.POLL_INTERVAL_MS = '-100';
      const { config } = await import('../../src/config.js?' + Date.now() + 'l');
      expect(config.pollIntervalMs).toBe(-100);
    });

    it('falls back on float string (parseInt behavior)', async () => {
      process.env.HISTORY_LIMIT = '3.14';
      const { config } = await import('../../src/config.js?' + Date.now() + 'm');
      // parseInt('3.14') === 3
      expect(config.historyLimit).toBe(3);
    });
  });

  describe('required()', () => {
    it('throws when required env var is missing', async () => {
      delete process.env.TELEGRAM_BOT_TOKEN;
      await expect(
        import('../../src/config.js?' + Date.now() + 'n')
      ).rejects.toThrow('Missing required environment variable: TELEGRAM_BOT_TOKEN');
    });

    it('throws when required env var is empty string', async () => {
      process.env.TELEGRAM_BOT_TOKEN = '';
      await expect(
        import('../../src/config.js?' + Date.now() + 'o')
      ).rejects.toThrow('Missing required environment variable: TELEGRAM_BOT_TOKEN');
    });
  });

  describe('config structure', () => {
    it('has correct default values', async () => {
      delete process.env.NODE_ENV;
      delete process.env.LOG_LEVEL;
      const { config } = await import('../../src/config.js?' + Date.now() + 'p');
      expect(config.env).toBe('development');
      expect(config.logLevel).toBe('info');
      expect(config.telegram.token).toBe('test-token');
      expect(config.telegram.ownerId).toBe(12345);
    });

    it('resolves paths from cwd', async () => {
      const { config } = await import('../../src/config.js?' + Date.now() + 'q');
      expect(config.sqlitePath).toContain('max-in-tg.sqlite');
      expect(config.mediaDir).toContain('media');
    });

    it('reads MAX_WEB_URL with fallback', async () => {
      delete process.env.MAX_WEB_URL;
      const { config } = await import('../../src/config.js?' + Date.now() + 'r');
      expect(config.max.webUrl).toBe('https://web.max.ru/');
    });

    it('uses custom MAX_WEB_URL when set', async () => {
      process.env.MAX_WEB_URL = 'https://custom.max.ru/';
      const { config } = await import('../../src/config.js?' + Date.now() + 's');
      expect(config.max.webUrl).toBe('https://custom.max.ru/');
    });
  });

  describe('values that cannot be read as meant', () => {
    it('keeps the default for a misspelled boolean and says so', async () => {
      process.env.TELEGRAM_USE_TOPICS = 'ture';
      const { config, configWarnings } = await import('../../src/config.js?' + Date.now() + 'w1');
      expect(config.telegram.useTopics).toBe(true);
      expect(configWarnings.some((warning) => warning.startsWith('TELEGRAM_USE_TOPICS=ture'))).toBe(true);
    });

    it('warns about a number with a unit', async () => {
      process.env.POLL_INTERVAL_MS = '1s';
      const { config, configWarnings } = await import('../../src/config.js?' + Date.now() + 'w2');
      expect(config.pollIntervalMs).toBe(1);
      expect(configWarnings.some((warning) => warning.includes('POLL_INTERVAL_MS=1s'))).toBe(true);
    });

    it('stays quiet for clean values', async () => {
      process.env.POLL_INTERVAL_MS = '800';
      process.env.TELEGRAM_USE_TOPICS = 'off';
      const { configWarnings } = await import('../../src/config.js?' + Date.now() + 'w3');
      expect(configWarnings).toEqual([]);
    });
  });
});
