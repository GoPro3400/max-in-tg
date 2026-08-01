import fs from 'node:fs';
import { config } from './config.js';
import { logger } from './logger.js';
import { MaxWebClient } from './adapters/maxWebClient.js';
import { TelegramBotAdapter } from './adapters/telegramBot.js';
import { AppDatabase } from './storage/database.js';
import { MediaService } from './services/mediaService.js';
import { BridgeService } from './services/bridge.js';

fs.mkdirSync(config.mediaDir, { recursive: true });
fs.mkdirSync(config.diagnosticDir, { recursive: true });

const db = new AppDatabase(config.sqlitePath);
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
const shutdown = async (signal) => {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, 'Shutting down');
  const forceExit = setTimeout(() => process.exit(1), 10000);
  try {
    await bridge.stop(signal);
  } catch (error) {
    logger.error({ err: error }, 'Shutdown failed');
  }
  clearTimeout(forceExit);
  process.exit(0);
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('unhandledRejection', (error) => {
  logger.error({ err: error }, 'Unhandled promise rejection');
});

try {
  await bridge.start();
} catch (error) {
  logger.error({ err: error }, 'Startup failed');
  await bridge.stop('startup-error').catch(() => {});
  process.exit(1);
}
