import fs from 'node:fs';
import { config, configWarnings } from './config.js';
import { logger } from './logger.js';
import { MaxWebClient } from './adapters/maxWebClient.js';
import { TelegramBotAdapter } from './adapters/telegramBot.js';
import { AppDatabase } from './storage/database.js';
import { MediaService } from './services/mediaService.js';
import { BridgeService } from './services/bridge.js';
import { APP_VERSION } from './version.js';

for (const warning of configWarnings) logger.warn(`Configuration: ${warning}`);

fs.mkdirSync(config.mediaDir, { recursive: true });
fs.mkdirSync(config.diagnosticDir, { recursive: true });

logger.info({ version: APP_VERSION }, 'Starting max-in-tg');
const db = new AppDatabase(config.sqlitePath, { appVersion: APP_VERSION });
const mediaService = new MediaService(config.mediaDir);
const maxClient = new MaxWebClient(config.max, {
  diagnosticDir: config.diagnosticDir,
  diagnosticRetentionFiles: config.diagnosticRetentionFiles,
  diagnosticRedactText: config.diagnosticRedactText,
  mediaDir: config.mediaDir
});
const telegramBot = new TelegramBotAdapter(config.telegram, mediaService);
const bridge = new BridgeService({
  db,
  maxClient,
  telegramBot,
  mediaService,
  config
});

let stopping = false;
const shutdown = async (signal, exitCode = 0) => {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, 'Shutting down');
  // bridge.stop() may spend up to 8 s draining in-flight browser work and up
  // to 15 s closing Chromium; the compose files give the container 30 s.
  const forceExit = setTimeout(() => process.exit(exitCode || 1), 25000);
  try {
    await bridge.stop(signal);
  } catch (error) {
    logger.error({ err: error }, 'Shutdown failed');
  }
  clearTimeout(forceExit);
  process.exit(exitCode);
};

// Failures the process cannot recover from by itself end it with a non-zero
// code, so the container's restart policy brings up a fresh one instead of
// leaving a live-looking process that no longer bridges anything.
const fatal = (reason) => (error) => {
  logger.fatal({ err: error, reason }, 'Unrecoverable failure — exiting so the container is restarted');
  shutdown(reason, 1);
};
bridge.onFatal = fatal('max-browser-launch');
telegramBot.onFatal(fatal('telegram-polling-stopped'));

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
// Chromium no longer dies with us by itself (see MaxWebClient.start): close it
// on a hang-up too, e.g. when the terminal of a bare `npm start` goes away.
process.on('SIGHUP', () => shutdown('SIGHUP'));

process.on('unhandledRejection', (error) => {
  logger.error({ err: error }, 'Unhandled promise rejection');
});
process.on('uncaughtException', fatal('uncaught-exception'));

try {
  await bridge.start();
} catch (error) {
  // A SIGTERM during startup (e.g. while waiting for /pair or the QR scan)
  // makes start() fail too; the shutdown already under way owns the exit.
  if (!stopping) {
    logger.error({ err: error }, 'Startup failed');
    await shutdown('startup-error', 1);
  }
}
