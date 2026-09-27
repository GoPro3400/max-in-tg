import pino from 'pino';
import { config } from './config.js';

// Errors are logged with a fixed set of fields. pino's default serializer
// copies every enumerable property, and Telegraf attaches the whole request to
// its errors (`on.payload`): a failed QR edit wrote the login QR's PNG bytes
// into the log, and a failed forward the private message text — in container
// logs that people paste into bug reports.
export const serializeError = (error) => {
  if (!error || typeof error !== 'object') return error;
  const out = {
    type: error.name || error.constructor?.name || 'Error',
    message: error.message,
    stack: error.stack
  };
  if (error.code !== undefined) out.code = error.code;
  const retryAfter = error.parameters?.retry_after ?? error.response?.parameters?.retry_after;
  if (retryAfter !== undefined) out.retryAfter = retryAfter;
  if (error.cause && error.cause !== error) out.cause = serializeError(error.cause);
  return out;
};

export const logger = pino({
  level: config.logLevel,
  serializers: { err: serializeError },
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
