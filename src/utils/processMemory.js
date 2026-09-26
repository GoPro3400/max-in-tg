import fsp from 'node:fs/promises';
import path from 'node:path';

// Memory held by a whole process tree (e.g. Chromium: browser, renderers, GPU
// and utility processes), read straight from /proc so it needs no extra
// dependency and works inside the container.
//
// Per process it prefers PSS (proportional set size, /proc/<pid>/smaps_rollup):
// Chromium's processes share most of their mapped pages, so summing plain RSS
// counts the same shared library and shared-memory pages once per process and
// overstates the tree 3-4x (measured: 809-898 MB of summed VmRSS against
// 204-287 MB of PSS for the same idle tree). Where smaps_rollup is missing
// (kernels < 4.14) the fallback is RssAnon + RssShmem, which lands at about
// 0.7-0.9x PSS — still the right order of magnitude, unlike VmRSS.
//
// Returns { bytes, processes, method, byType: { browser, renderer, gpu, other } }
// or null when /proc is unavailable (not Linux) or the root process is gone.
export async function measureProcessTreeMemory(rootPid, { procDir = '/proc' } = {}) {
  if (!Number.isInteger(rootPid) || rootPid <= 0) return null;

  let entries;
  try {
    entries = await fsp.readdir(procDir);
  } catch {
    return null;
  }

  const parentOf = new Map();
  await Promise.all(entries.filter((name) => /^\d+$/.test(name)).map(async (name) => {
    const ppid = await readParentPid(path.join(procDir, name, 'stat'));
    if (ppid !== null) parentOf.set(Number(name), ppid);
  }));
  if (!parentOf.has(rootPid)) return null;

  const childrenOf = new Map();
  for (const [pid, ppid] of parentOf) {
    if (!childrenOf.has(ppid)) childrenOf.set(ppid, []);
    childrenOf.get(ppid).push(pid);
  }
  const tree = [];
  const queue = [rootPid];
  const visited = new Set();
  while (queue.length) {
    const pid = queue.shift();
    if (visited.has(pid)) continue;
    visited.add(pid);
    tree.push(pid);
    queue.push(...(childrenOf.get(pid) || []));
  }

  let bytes = 0;
  let processes = 0;
  let method = 'pss';
  const byType = { browser: 0, renderer: 0, gpu: 0, other: 0 };
  for (const pid of tree) {
    const dir = path.join(procDir, String(pid));
    let used = await readKbField(path.join(dir, 'smaps_rollup'), 'Pss');
    if (used === null) {
      const status = await readText(path.join(dir, 'status'));
      if (status === null) continue; // exited meanwhile
      used = (kbField(status, 'RssAnon') ?? 0) + (kbField(status, 'RssShmem') ?? 0);
      method = 'anon+shmem';
    }
    const usedBytes = used * 1024;
    bytes += usedBytes;
    processes += 1;
    // Chromium rewrites its command line with spaces instead of NULs, so the
    // process type is matched anywhere in it.
    const type = pid === rootPid ? 'browser' : processType(await readText(path.join(dir, 'cmdline')));
    byType[type] += usedBytes;
  }
  if (!processes) return null;
  return { bytes, processes, method, byType };
}

const processType = (cmdline) => {
  const type = /--type=([\w-]+)/.exec(cmdline || '')?.[1];
  if (type === 'renderer') return 'renderer';
  if (type === 'gpu-process') return 'gpu';
  return 'other';
};

// /proc/<pid>/stat is "pid (comm) state ppid ...". comm may itself contain
// spaces and parentheses, so the fields are counted from the LAST ')'.
async function readParentPid(statPath) {
  const stat = await readText(statPath);
  if (stat === null) return null; // exited between readdir and read
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  const ppid = Number(fields[1]);
  return Number.isInteger(ppid) ? ppid : null;
}

async function readText(filePath) {
  try {
    return await fsp.readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}

const kbField = (text, field) => {
  const match = new RegExp(`^${field}:\\s+(\\d+)\\s+kB`, 'm').exec(text || '');
  return match ? Number(match[1]) : null;
};

async function readKbField(filePath, field) {
  const text = await readText(filePath);
  return text === null ? null : kbField(text, field);
}
