import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { measureProcessTreeMemory } from '../../src/utils/processMemory.js';

// measureProcessTreeMemory reads /proc; these tests point it at a fake /proc
// tree so the parent/child walk and the PSS/RSS parsing are checked exactly.

let procDir;

function fakeProcess(pid, { ppid, comm = 'chrome', pssKb = null, rssKb = null }) {
  const dir = path.join(procDir, String(pid));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'stat'), `${pid} (${comm}) S ${ppid} ${pid} ${pid} 0 -1 4194560\n`);
  if (pssKb !== null) {
    fs.writeFileSync(path.join(dir, 'smaps_rollup'), [
      '00400000-7ffd0000 ---p 00000000 00:00 0                          [rollup]',
      `Rss:              ${(rssKb ?? pssKb) + 1000} kB`,
      `Pss:              ${pssKb} kB`,
      'Shared_Clean:      2048 kB'
    ].join('\n'));
  }
  if (rssKb !== null) {
    fs.writeFileSync(path.join(dir, 'status'), `Name:\t${comm}\nVmPeak:\t 999999 kB\nVmRSS:\t ${rssKb} kB\n`);
  }
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
    fakeProcess(101, { ppid: 100, pssKb: 50000 }); // zygote
    fakeProcess(102, { ppid: 101, comm: 'chrome renderer', pssKb: 700000 }); // grandchild
    fakeProcess(103, { ppid: 100, pssKb: 30000 }); // gpu
    fakeProcess(200, { ppid: 1, comm: 'Xvfb', pssKb: 40000 }); // sibling, not in the tree

    const usage = await measureProcessTreeMemory(100, { procDir });

    expect(usage).toEqual({ bytes: (200000 + 50000 + 700000 + 30000) * 1024, processes: 4, method: 'pss' });
  });

  it('parses a comm containing spaces and parentheses', async () => {
    fakeProcess(100, { ppid: 1, pssKb: 1000 });
    fakeProcess(101, { ppid: 100, comm: 'chrome (x) ) weird', pssKb: 2000 });

    const usage = await measureProcessTreeMemory(100, { procDir });

    expect(usage.bytes).toBe(3000 * 1024);
    expect(usage.processes).toBe(2);
  });

  it('falls back to VmRSS where smaps_rollup is missing', async () => {
    fakeProcess(100, { ppid: 1, pssKb: 1000 });
    fakeProcess(101, { ppid: 100, rssKb: 5000 });

    const usage = await measureProcessTreeMemory(100, { procDir });

    expect(usage).toEqual({ bytes: 6000 * 1024, processes: 2, method: 'rss' });
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
