import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { computeStats, loadAppliedLog } from '../src/stats.js';
import { fileURLToPath } from 'node:url';

const fixturePath = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

test('loadAppliedLog reads the fixture log and normalizes entries', () => {
  const { entries, error, missing } = loadAppliedLog(fixturePath('applied-log.json'));
  assert.equal(error, null);
  assert.equal(missing, false);
  assert.equal(entries.length, 4);
  assert.equal(entries[0].repo, 'acme/widgets');
  assert.equal(entries[0].merged, true);
  assert.ok(Number.isFinite(entries[0].appliedAt));
  assert.equal(entries[1].merged, false);
});

test('loadAppliedLog: missing file is not an error; junk file is', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'radar-stats-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const absent = loadAppliedLog(join(dir, 'nope.json'));
  assert.equal(absent.missing, true);
  assert.equal(absent.entries.length, 0);

  const junk = join(dir, 'junk.json');
  writeFileSync(junk, '{not json', 'utf8');
  const bad = loadAppliedLog(junk);
  assert.match(bad.error, /invalid JSON/);

  writeFileSync(junk, '{"nope": true}', 'utf8');
  assert.match(loadAppliedLog(junk).error, /must be a JSON array/);

  writeFileSync(junk, JSON.stringify([{ repo: 'a/b', number: 1 }, 'garbage', null]), 'utf8');
  assert.equal(loadAppliedLog(junk).entries.length, 1, 'malformed rows are skipped');
});

test('computeStats: merge rate and median days to merge', () => {
  const { entries } = loadAppliedLog(fixturePath('applied-log.json'));
  const stats = computeStats(entries);
  assert.equal(stats.applications, 4);
  assert.equal(stats.merges, 2);
  assert.equal(stats.mergeRate, 50);
  // merged spans: 3 days and 12 days → median 7.5
  assert.equal(stats.medianDaysToMerge, 7.5);
  assert.equal(stats.byRepo.length, 2);
  assert.deepEqual(stats.byRepo.map((r) => r.repo), ['acme/widgets', 'beta/kit'], 'sorted by applications');
  assert.equal(stats.byRepo[0].medianDaysToMerge, 3);
  assert.equal(stats.byRepo[1].medianDaysToMerge, 12);
});

test('computeStats handles empty and unmerged-only logs', () => {
  const empty = computeStats([]);
  assert.equal(empty.applications, 0);
  assert.equal(empty.mergeRate, 0);
  assert.equal(empty.medianDaysToMerge, null);
  assert.deepEqual(empty.byRepo, []);

  const noMerges = computeStats([
    { repo: 'a/b', number: 1, appliedAt: 1000, merged: false, mergedAt: null },
  ]);
  assert.equal(noMerges.mergeRate, 0);
  assert.equal(noMerges.medianDaysToMerge, null, 'unmerged rows contribute no duration');
});
