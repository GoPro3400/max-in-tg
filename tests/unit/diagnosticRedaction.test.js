import { describe, it, expect } from 'vitest';
import { sanitizeDiagnosticHtml } from '../../src/adapters/maxWebClient.js';

// A diagnostic dump is a full capture of the live MAX page: it holds the user's
// private conversations, including messages from people who never agreed to
// this bridge existing. Those files are written to the VPS disk and can be sent
// into Telegram via /diagnostics, so nothing but DOM structure may survive.
// The fixture below mirrors the SHAPE of a real dump, but every human-
// readable value in it is invented: a test for a privacy feature must not
// itself carry anyone's name or messages.
const SAMPLE = `
<html><head><style>.bubble { color: red }</style></head>
<body>
  <button type="button" aria-label="Open Иван Петров's profile" class="main"></button>
  <div data-bubbles-variant="incoming">
    <div class="bubble svelte-1htnb3l">
      <div class="bubbleContent">
        <span class="text svelte-1htnb3l">Строка сообщения для теста</span>
      </div>
    </div>
  </div>
  <div data-testid="composer">
    <button aria-label="Upload file"></button>
    <input type="file" hidden multiple>
    <div contenteditable role="textbox" placeholder="Message"></div>
    <button aria-label="Send message"><svg><use href="#icon_send"></use></svg></button>
  </div>
  <img alt="Вложение.jpg" src="https://i.oneme.ru/i?r=TOKEN">
</body></html>`;

describe('sanitizeDiagnosticHtml', () => {
  it('removes conversation text but keeps the DOM structure debugging needs', () => {
    const out = sanitizeDiagnosticHtml(SAMPLE);

    // Private content must not survive in any form.
    expect(out).not.toContain('Строка сообщения');
    expect(out).not.toContain('Петров');
    expect(out).not.toContain('Вложение.jpg');

    // Structure used to locate elements must survive untouched.
    expect(out).toContain('data-testid="composer"');
    expect(out).toContain('aria-label="Send message"');
    expect(out).toContain('aria-label="Upload file"');
    expect(out).toContain('data-bubbles-variant="incoming"');
    expect(out).toContain('class="bubble svelte-1htnb3l"');
    expect(out).toContain('<input type="file" hidden multiple>');
  });

  it('marks redacted spots with their original length', () => {
    const out = sanitizeDiagnosticHtml(SAMPLE);
    expect(out).toMatch(/\[redacted \d+ chars\]/);
  });

  it('redacts label attributes that are not known MAX UI labels', () => {
    const out = sanitizeDiagnosticHtml('<img alt="Документ.pdf"><b title="Подпись">x</b>');
    expect(out).not.toContain('Документ');
    expect(out).not.toContain('Подпись');
  });

  it('drops the signed query of media URLs, which would let anyone fetch the private file', () => {
    const out = sanitizeDiagnosticHtml(
      '<img src="https://i.oneme.ru/i?r=SIGNED_TOKEN&fn=w_1280">'
      + '<a href="https://fs.oneme.ru/getfile?sig=SECRET&expires=99" download>x</a>'
      + '<div style="background-image: url(https://i.oneme.ru/i?r=BG_TOKEN)"></div>'
      + '<input value="черновик сообщения">'
    );
    expect(out).not.toContain('SIGNED_TOKEN');
    expect(out).not.toContain('SECRET');
    expect(out).not.toContain('BG_TOKEN');
    expect(out).not.toContain('черновик');
    // Where each element points still shows.
    expect(out).toContain('src="https://i.oneme.ru/i?[redacted]"');
    expect(out).toContain('href="https://fs.oneme.ru/getfile?[redacted]"');
    // Fragment-only references are structure, not secrets.
    expect(sanitizeDiagnosticHtml('<use href="#icon_send"></use>')).toContain('href="#icon_send"');
  });

  it('still strips scripts and inline handlers', () => {
    const out = sanitizeDiagnosticHtml('<div onclick="steal()"><script>evil()</script>hi</div>');
    expect(out).not.toContain('evil()');
    expect(out).not.toContain('onclick');
  });

  it('leaves the dump intact when redaction is explicitly disabled', () => {
    const out = sanitizeDiagnosticHtml(SAMPLE, { redactText: false });
    expect(out).toContain('Строка сообщения для теста');
    // Scripts/handlers are still stripped even with redaction off.
    expect(out).not.toContain('onclick');
  });
});
