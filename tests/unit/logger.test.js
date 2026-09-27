import { describe, it, expect } from 'vitest';
import { serializeError } from '../../src/logger.js';

// Telegraf attaches the whole API request to its errors. Logged as-is, a
// failed QR update put the login QR's PNG bytes into the container log, and a
// failed forward the private message text.
describe('serializeError', () => {
  it('keeps what debugging needs and drops the attached request payload', () => {
    const error = Object.assign(new Error('400: Bad Request: message to edit not found'), {
      response: { error_code: 400, description: 'Bad Request: message to edit not found', parameters: { retry_after: 3 } },
      on: { method: 'editMessageMedia', payload: { media: { source: Buffer.from('QR-PNG-BYTES') }, text: 'private words' } }
    });
    Object.defineProperty(error, 'code', { get() { return this.response.error_code; } });

    const out = serializeError(error);

    expect(out).toMatchObject({ type: 'Error', message: '400: Bad Request: message to edit not found', code: 400, retryAfter: 3 });
    const json = JSON.stringify(out);
    expect(json).not.toContain('QR-PNG-BYTES');
    expect(json).not.toContain('private words');
    expect(json).not.toContain('payload');
  });

  it('keeps the cause chain (e.g. fetch failed -> ECONNRESET) and passes non-errors through', () => {
    const error = new TypeError('fetch failed', { cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) });
    expect(serializeError(error).cause).toMatchObject({ message: 'socket hang up', code: 'ECONNRESET' });
    expect(serializeError('plain message')).toBe('plain message');
    expect(serializeError(null)).toBeNull();
  });
});
