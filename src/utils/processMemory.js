import fsp from 'node:fs/promises';
import path from 'node:path';

// Memory held by a whole process tree (e.g. Chromium: browser, renderers, GPU
// and utility processes), read straight from /proc so it needs no extra
// dependency and works inside the container.
//
// Per process it prefers PSS (proportional set size, /proc/<pid>/smaps_rollup):
// Chromium's processes share most of their mapped pages, so summing plain RSS
// counts the same shared library and shared-memory pages once per process and
// overstates the tree several times over. PSS splits every shared page between
// the processes that map it, so the sum is what the tree really costs the
// cgroup. VmRSS is the fallback for kernels without smaps_rollup (< 4.14).
//
// Returns { bytes, processes, method } or null when /proc is unavailable (not
// Linux) or the root process is already gone.
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
  for (const pid of tree) {
    const pss = await readKbField(path.join(procDir, String(pid), 'smaps_rollup'), 'Pss');
    if (pss !== null) {
      bytes += pss * 1024;
      processes += 1;
      continue;
    }
    const rss = await readKbField(path.join(procDir, String(pid), 'status'), 'VmRSS');
    if (rss !== null) {
      bytes += rss * 1024;
      processes += 1;
      method = 'rss';
    }
  }
  if (!processes) return null;
  return { bytes, processes, method };
}

// /proc/<pid>/stat is "pid (comm) state ppid ...". comm may itself contain
// spaces and parentheses, so the fields are counted from the LAST ')'.
async function readParentPid(statPath) {
  try {
    const stat = await fsp.readFile(statPath, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const ppid = Number(fields[1]);
    return Number.isInteger(ppid) ? ppid : null;
  } catch {
    // The process exited between readdir and read — just skip it.
    return null;
  }
}

async function readKbField(filePath, field) {
  try {
    const text = await fsp.readFile(filePath, 'utf8');
    const match = new RegExp(`^${field}:\\s+(\\d+)\\s+kB`, 'm').exec(text);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}
