import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { measureProcessTreeMemory } from '../../src/utils/processMemory.js';

// measureProcessTreeMemory reads /proc; these tests point it at a fake /proc
// tree so the parent/child walk and the PSS/RSS parsing are checked exactly.

let procDir;

function fakeProcess(pid, { ppid, comm = 'chrome', pssKb = null, anonKb = null, shmemKb = 0, type = null }) {
  const dir = path.join(procDir, String(pid));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'stat'), `${pid} (${comm}) S ${ppid} ${pid} ${pid} 0 -1 4194560\n`);
  // Chromium rewrites its argv with spaces, not NULs.
  fs.writeFileSync(path.join(dir, 'cmdline'), `/usr/lib/chromium/chromium${type ? ` --type=${type}` : ''} --no-sandbox`);
  if (pssKb !== null) {
    fs.writeFileSync(path.join(dir, 'smaps_rollup'), [
      '00400000-7ffd0000 ---p 00000000 00:00 0                          [rollup]',
      `Rss:              ${pssKb * 3} kB`,
      `Pss:              ${pssKb} kB`,
      'Shared_Clean:      2048 kB'
    ].join('\n'));
  }
  fs.writeFileSync(path.join(dir, 'status'), [
    `Name:\t${comm}`,
    'VmPeak:\t 999999 kB',
    `VmRSS:\t ${(anonKb ?? pssKb ?? 0) * 3 + shmemKb} kB`,
    `RssAnon:\t ${anonKb ?? 0} kB`,
    `RssShmem:\t ${shmemKb} kB`
  ].join('\n'));
}

describe('measureProcessTreeMemory', () => {
  beforeEach(() => {
    procDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-proc-'));
    // Non-process entries live in /proc too and must be ignored.
    fs.writeFileSync(path.join(procDir, 'meminfo'), 'MemTotal: 1 kB\n');
    fs.mkdirSync(path.join(procDir, 'self'));
  });

  afterEach(() => {
    fs.rmSync(procDir, { recursive: true, force: true });
  });

  it('sums PSS over the root and all of its descendants, and nothing else', async () => {
    fakeProcess(1, { ppid: 0, comm: 'node', pssKb: 90000 });
    fakeProcess(100, { ppid: 1, pssKb: 200000 }); // browser
    fakeProcess(101, { ppid: 100, pssKb: 50000, type: 'zygote' });
    fakeProcess(102, { ppid: 101, comm: 'chrome renderer', pssKb: 700000, type: 'renderer' }); // grandchild
    fakeProcess(103, { ppid: 100, pssKb: 30000, type: 'gpu-process' });
    fakeProcess(200, { ppid: 1, comm: 'Xvfb', pssKb: 40000 }); // sibling, not in the tree

    const usage = await measureProcessTreeMemory(100, { procDir });

    expect(usage).toEqual({
      bytes: (200000 + 50000 + 700000 + 30000) * 1024,
      processes: 4,
      method: 'pss',
      byType: { browser: 200000 * 1024, renderer: 700000 * 1024, gpu: 30000 * 1024, other: 50000 * 1024 }
    });
  });

  it('parses a comm containing spaces and parentheses', async () => {
    fakeProcess(100, { ppid: 1, pssKb: 1000 });
    fakeProcess(101, { ppid: 100, comm: 'chrome (x) ) weird', pssKb: 2000 });

    const usage = await measureProcessTreeMemory(100, { procDir });

    expect(usage.bytes).toBe(3000 * 1024);
    expect(usage.processes).toBe(2);
  });

  it('falls back to RssAnon + RssShmem (not VmRSS, which counts shared pages per process) without smaps_rollup', async () => {
    fakeProcess(100, { ppid: 1, pssKb: 1000 });
    fakeProcess(101, { ppid: 100, anonKb: 4000, shmemKb: 1000, type: 'renderer' });

    const usage = await measureProcessTreeMemory(100, { procDir });

    expect(usage.bytes).toBe(6000 * 1024);
    expect(usage.method).toBe('anon+shmem');
    expect(usage.byType.renderer).toBe(5000 * 1024);
  });

  it('returns null when the root process is gone or the pid is not a pid', async () => {
    fakeProcess(100, { ppid: 1, pssKb: 1000 });

    await expect(measureProcessTreeMemory(4242, { procDir })).resolves.toBeNull();
    await expect(measureProcessTreeMemory(undefined, { procDir })).resolves.toBeNull();
    await expect(measureProcessTreeMemory(0, { procDir })).resolves.toBeNull();
  });

  it('returns null where there is no /proc at all', async () => {
    await expect(measureProcessTreeMemory(100, { procDir: path.join(procDir, 'missing') })).resolves.toBeNull();
  });

  it('measures a real process on this machine', async () => {
    if (process.platform !== 'linux') return;
    const usage = await measureProcessTreeMemory(process.pid);
    expect(usage.bytes).toBeGreaterThan(1024 * 1024);
    expect(usage.processes).toBeGreaterThanOrEqual(1);
  });
});
