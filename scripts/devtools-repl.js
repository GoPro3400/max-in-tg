#!/usr/bin/env node
// Attaches to the ALREADY-RUNNING production Puppeteer browser via CDP
// (see the --remote-debugging-port flag in maxWebClient.js — 9222 unless
// MAX_REMOTE_DEBUGGING_PORT says otherwise) and
// evaluates a JS expression in the live MAX Web page. This exists so DOM
// exploration (finding selectors, testing interactions) doesn't require
// deploying probe code into the app and rebuilding/restarting the container
// on every iteration — just `docker exec` this script from the host.
//
// Usage (from the VPS host, via SSH):
//   docker exec <container> node scripts/devtools-repl.js "document.title"
//   docker exec <container> node scripts/devtools-repl.js "[...document.querySelectorAll('button')].map(b => b.textContent)"
//
// Connects read/write to the live page — anything the expression does
// (clicks, typing) happens for real. Never calls browser.close() or
// page.close(): this only observes/drives the existing session, it must
// never terminate it.
//
// DANGER, learned the hard way: puppeteer.connect() defaults `defaultViewport`
// to 800x600 and applies it to every page it attaches to. The override outlives
// the disconnect, so merely *observing* the live page silently resized MAX Web
// from the 1440x980 the app sets at launch down to 800x600. At that width MAX
// collapses to its narrow layout, the chat list stops rendering the rows
// selectChat() looks for, and the bridge fails every single chat with
// "Max chat not found" until the container is restarted. `defaultViewport: null`
// keeps the page exactly as the app left it — never remove it.

import puppeteer from 'puppeteer';

const expression = process.argv[2];
if (!expression) {
  console.error('Usage: node devtools-repl.js "<js expression to evaluate in the page>"');
  process.exit(1);
}

const port = Number(process.env.MAX_REMOTE_DEBUGGING_PORT) || 9222;
const browser = await puppeteer.connect({
  browserURL: `http://127.0.0.1:${port}`,
  // Never impose a viewport on the running app — see the DANGER note above.
  defaultViewport: null,
});
try {
  const pages = await browser.pages();
  const page = pages.find((p) => p.url().includes('max.ru')) || pages[0];
  if (!page) throw new Error('No open page found on the connected browser');

  const result = await page.evaluate(new Function(`return (${expression});`));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.disconnect();
}
