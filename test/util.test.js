import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  clamp,
  compareResults,
  fmtDuration,
  isBot,
  parseTimestamp,
  percentile,
  plural,
  robustScale,
  round4,
  splitRepo,
} from '../src/util.js';

test('clamp bounds and rejects non-finite input', () => {
  assert.equal(clamp(0.5), 0.5);
  assert.equal(clamp(-1), 0);
  assert.equal(clamp(2), 1);
  assert.equal(clamp(NaN), 0);
  assert.equal(clamp(5, 0, 3), 3);
});

test('round4 rounds half away from zero to 4 decimals', () => {
  assert.equal(round4(0.12345), 0.1235);
  assert.equal(round4(1), 1);
  assert.equal(round4(0.1 + 0.2), 0.3);
});

test('percentile interpolates linearly', () => {
  const sorted = [10, 20, 30, 40, 50];
  assert.equal(percentile(sorted, 0), 10);
  assert.equal(percentile(sorted, 1), 50);
  assert.equal(percentile(sorted, 0.5), 30);
  assert.equal(percentile(sorted, 0.25), 20);
  assert.equal(percentile([], 0.5), null);
  assert.equal(percentile([7], 0.9), 7);
});

test('robustScale maps p10..p90 onto 0..1 and clamps outside', () => {
  const { scaled, p10, p90 } = robustScale([0, 5, 10, 15, 20]);
  assert.equal(p10, 2); // idx 0.4 between 0 and 5
  assert.equal(p90, 18); // idx 3.6 between 15 and 20
  assert.deepEqual(scaled, [0, 0.1875, 0.5, 0.8125, 1]);
});

test('robustScale passes values through when p10 == p90', () => {
  const { scaled, flat } = robustScale([0.7, 0.7, 0.7]);
  assert.equal(flat, true);
  assert.deepEqual(scaled, [0.7, 0.7, 0.7]);
});

test('robustScale keeps nulls as null and excludes them from percentiles', () => {
  const { scaled, p10, p90 } = robustScale([0.2, null, 0.6, null]);
  assert.ok(Math.abs(p10 - 0.24) < 1e-12); // 0.2 + 0.1·(0.6−0.2)
  assert.ok(Math.abs(p90 - 0.56) < 1e-12); // 0.2 + 0.9·(0.6−0.2)
  assert.deepEqual(scaled, [0, null, 1, null]);
});

test('robustScale with all nulls yields all nulls', () => {
  const { scaled, p10, flat } = robustScale([null, null]);
  assert.deepEqual(scaled, [null, null]);
  assert.equal(p10, null);
  assert.equal(flat, true);
});

test('fmtDuration formats minutes, hours, days, months', () => {
  assert.equal(fmtDuration(4 * 60_000), '4m');
  assert.equal(fmtDuration(4 * 3_600_000), '4h');
  assert.equal(fmtDuration(3 * 86_400_000), '3d');
  assert.equal(fmtDuration(90 * 86_400_000), '3mo');
  assert.equal(fmtDuration(-5), '1m'); // clamped
});

test('isBot detects Bot type and [bot] logins', () => {
  assert.equal(isBot({ login: 'x', type: 'Bot' }), true);
  assert.equal(isBot({ login: 'dependabot[bot]', type: 'User' }), true);
  assert.equal(isBot({ login: 'human', type: 'User' }), false);
  assert.equal(isBot(null), false);
});

test('parseTimestamp handles good and bad input', () => {
  assert.equal(parseTimestamp('2026-10-20T12:00:00Z'), Date.parse('2026-10-20T12:00:00Z'));
  assert.equal(parseTimestamp(undefined), null);
  assert.equal(parseTimestamp('not a date'), null);
});

test('splitRepo validates owner/name', () => {
  assert.deepEqual(splitRepo('acme/widgets'), ['acme', 'widgets']);
  assert.equal(splitRepo('nope'), null);
  assert.equal(splitRepo('/leading'), null);
  assert.equal(splitRepo('trailing/'), null);
});

test('plural picks singular or plural', () => {
  assert.equal(plural(1, 'attempt'), 'attempt');
  assert.equal(plural(2, 'attempt'), 'attempts');
});

test('compareResults sorts by score desc, repo asc, number asc', () => {
  const rows = [
    { repo: 'b/r', number: 1, score: 0.5 },
    { repo: 'a/r', number: 2, score: 0.9 },
    { repo: 'a/r', number: 1, score: 0.9 },
    { repo: 'a/r', number: 3, score: 0.1 },
  ];
  rows.sort(compareResults);
  assert.deepEqual(
    rows.map((r) => `${r.repo}#${r.number}`),
    ['a/r#1', 'a/r#2', 'b/r#1', 'a/r#3'],
  );
});
