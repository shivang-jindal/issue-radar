import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createCache } from '../src/cache.js';

const NOW = Date.parse('2026-10-20T12:00:00.000Z');
const clock = () => new Date(NOW);

const ACTIVE_META = { pushed_at: '2026-10-19T09:00:00Z' }; // pushed yesterday → fresh TTL 15m
const IDLE_META = { pushed_at: '2026-04-01T12:00:00Z' }; // dormant → idle TTL 6h

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'radar-cache-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('fresh repos expire after 15 minutes, idle repos after 6 hours', () => {
  const cache = createCache({ now: clock });
  const entry = { savedAt: NOW, meta: ACTIVE_META, issues: [], timelines: {} };
  assert.equal(cache.isFresh(entry, ACTIVE_META), true);
  assert.equal(cache.isFresh({ ...entry, savedAt: NOW - 14 * 60_000 }, ACTIVE_META), true);
  assert.equal(cache.isFresh({ ...entry, savedAt: NOW - 16 * 60_000 }, ACTIVE_META), false);

  const idleEntry = { savedAt: NOW, meta: IDLE_META, issues: [], timelines: {} };
  assert.equal(cache.isFresh(idleEntry, IDLE_META), true);
  assert.equal(cache.isFresh({ ...idleEntry, savedAt: NOW - 5 * 3_600_000 }, IDLE_META), true);
  assert.equal(cache.isFresh({ ...idleEntry, savedAt: NOW - 7 * 3_600_000 }, IDLE_META), false);
  // pushed_at missing → treat as idle
  assert.equal(cache.isFresh({ ...idleEntry, savedAt: NOW - 5 * 3_600_000 }, {}), true);
});

test('ttlFor reports the configured budgets', () => {
  const cache = createCache({ now: clock });
  assert.equal(cache.ttlFor(ACTIVE_META), 15 * 60_000);
  assert.equal(cache.ttlFor(IDLE_META), 6 * 3_600_000);
});

test('save/load roundtrip and corrupt cache recovery', (t) => {
  const file = join(tempDir(t), 'sub', '.radar-cache.json');
  const cache = createCache({ path: file, now: clock });
  cache.set('acme/widgets', { meta: ACTIVE_META, issues: [{ number: 1 }], timelines: { 1: [] } });
  cache.save();
  assert.ok(existsSync(file));
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).entries['acme/widgets'].savedAt, NOW);

  const reopened = createCache({ path: file, now: clock });
  assert.equal(reopened.get('acme/widgets').issues[0].number, 1);

  writeFileSync(file, 'not-json{{{', 'utf8');
  const afterCorruption = createCache({ path: file, now: clock });
  assert.equal(afterCorruption.get('acme/widgets'), null);
  afterCorruption.set('a/b', { meta: {}, issues: [], timelines: {} });
  afterCorruption.save(); // must not throw and must overwrite the junk
  assert.ok(JSON.parse(readFileSync(file, 'utf8')).entries['a/b']);
});

test('memory-only cache (no path) never touches the filesystem', () => {
  const cache = createCache({ now: clock });
  assert.equal(cache.path, null);
  cache.set('a/b', { meta: {}, issues: [], timelines: {} });
  cache.save();
  assert.deepEqual(cache.get('a/b').meta, {});
  assert.equal(cache.get('missing/repo'), null);
});
