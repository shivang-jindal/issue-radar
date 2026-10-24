// File cache: `.radar-cache.json`, per-repo entries with TTLs.
// TTL depends on repo activity (pushed_at): fresh repos 15m, idle repos 6h.
// All writes go through a temp file + rename (Windows-safe overwrite).

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const CACHE_VERSION = 1;

export function createCache({ path: cachePath = null, now = () => new Date(), ttl = {} } = {}) {
  const freshMs = ttl.freshMs ?? 15 * 60_000;
  const idleMs = ttl.idleMs ?? 6 * 3_600_000;
  const dormantDays = ttl.dormantDays ?? 30;
  let data = { version: CACHE_VERSION, entries: {} };
  let loaded = false;
  let dirty = false;

  function load() {
    if (loaded) return;
    loaded = true;
    if (!cachePath || !existsSync(cachePath)) return;
    try {
      const parsed = JSON.parse(readFileSync(cachePath, 'utf8'));
      if (parsed && typeof parsed === 'object' && parsed.entries && typeof parsed.entries === 'object') {
        data = { version: CACHE_VERSION, entries: parsed.entries };
      }
    } catch {
      // Corrupt cache is not fatal — start clean and overwrite on save.
      data = { version: CACHE_VERSION, entries: {} };
    }
  }

  function ttlFor(meta) {
    const pushed = Date.parse(meta?.pushed_at ?? '');
    const active =
      Number.isFinite(pushed) && now().getTime() - pushed < dormantDays * 86_400_000;
    return active ? freshMs : idleMs;
  }

  return {
    path: cachePath,
    load,
    get(repo) {
      load();
      return data.entries[repo] ?? null;
    },
    ttlFor,
    isFresh(entry, meta) {
      if (!entry || !Number.isFinite(entry.savedAt)) return false;
      const age = now().getTime() - entry.savedAt;
      return age < ttlFor(meta ?? entry.meta);
    },
    set(repo, entry) {
      load();
      data.entries[repo] = { ...entry, savedAt: now().getTime() };
      dirty = true;
    },
    save() {
      if (!cachePath || !dirty) return;
      load();
      const body = `${JSON.stringify(data, null, 2)}\n`;
      mkdirSync(dirname(cachePath), { recursive: true });
      const tmp = `${cachePath}.tmp-${process.pid}`;
      try {
        writeFileSync(tmp, body, 'utf8');
        renameSync(tmp, cachePath);
      } catch {
        // rename can fail if the destination is locked — fall back to direct write
        let wrote = false;
        try {
          writeFileSync(cachePath, body, 'utf8');
          wrote = true;
        } finally {
          try {
            if (existsSync(tmp)) {
              // Success → drop the tmp (the old unconditional rename to `.old`
              // accumulated junk next to the cache on every locked rename).
              // Both writes failed → keep one `.old` as recovery data.
              if (wrote) rmSync(tmp, { force: true });
              else renameSync(tmp, `${tmp}.old`);
            }
          } catch {
            /* ignore cleanup errors */
          }
        }
      }
      dirty = false;
    },
  };
}
