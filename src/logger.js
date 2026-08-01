import pino from 'pino';
import { config } from './config.js';

export const logger = pino({
  level: config.logLevel,
  transport: config.env === 'development'
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname'
        }
      }
    : undefined
});
