import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildFixtureFetch } from '../src/fixture.js';
import { scan } from '../src/scan.js';
import { renderJson } from '../src/render.js';

const load = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

const fixture = load('sample-scan.json');
const fingerprint = load('fingerprint.json');
const CLOCK = Date.parse(fixture.clock);
const now = () => new Date(CLOCK);
const REPOS = Object.keys(fixture.repos);

function countingFetch(fx = fixture) {
  const inner = buildFixtureFetch(fx);
  const counter = { calls: 0, urls: [] };
  return {
    counter,
    fetchFn: async (url, init) => {
      counter.calls += 1;
      counter.urls.push(url);
      return inner(url, init);
    },
  };
}

function runScan(opts = {}) {
  const { fetchFn, counter } = countingFetch();
  return scan({
    repos: REPOS,
    fetchFn,
    now,
    fingerprint,
    minScore: 0.4,
    limit: 20,
    shortlist: 20,
    budget: 60,
    ...opts,
  }).then((out) => ({ out, counter }));
}

test('fixture scan: scenarios produce the expected shape and ranking', async () => {
  const { out } = await runScan();
  assert.equal(out.version, 1);
  assert.equal(out.generatedAt, fixture.clock);

  const ids = out.results.map((r) => `${r.repo}#${r.number}`);
  assert.equal(ids[0], 'acme/widgets#101', 'fresh issue with 4h maintainer response ranks first');
  assert.ok(!ids.includes('acme/widgets#104'), 'stale bot noise falls below --min-score');
  assert.ok(!ids.includes('acme/widgets#107'), 'pull requests are never results');

  const byId = Object.fromEntries(out.results.map((r) => [`${r.repo}#${r.number}`, r]));
  assert.equal(byId['acme/widgets#102'].signals.ncomp, 0, '2 competing PRs → ncomp scaled to 0 in repo');
  assert.equal(byId['acme/widgets#103'].signals.naband, 0, 'abandoned attempts hurt');
  assert.ok(byId['acme/widgets#101'].reasons.length === 3);
  assert.match(byId['acme/widgets#101'].reasons.join(' '), /4h/);
  for (const r of out.results) {
    assert.deepEqual(
      Object.keys(r),
      ['repo', 'number', 'url', 'title', 'score', 'reasons', 'signals', 'labels', 'updated_at', 'scanned_at'],
      'frozen v1 JSON contract keys',
    );
    assert.equal(r.scanned_at, fixture.clock);
    for (const s of Object.values(r.signals)) {
      assert.ok(s >= 0 && s <= 1);
    }
  }
  assert.equal(out.breakdowns['acme/widgets#107'], undefined, 'PR never enters breakdowns');
  assert.equal(out.meta.dataErrors.length, 0);
  assert.equal(out.meta.budgetHit, false);
  // 2 repos × (meta + issues) + 7 acme timelines + 2 beta timelines
  assert.equal(out.meta.calls, 13);
});

test('golden --json snapshot for the fixture scan (sorted, stable)', async () => {
  const { out } = await runScan();
  const actual = renderJson(out);
  const goldenPath = new URL('./fixtures/golden-scan.json', import.meta.url);
  const golden = readFileSync(goldenPath, 'utf8');
  assert.equal(actual, golden, 'scan output changed — regenerate fixtures/golden-scan.json consciously');
});

test('determinism: same fixtures + fixed clock → byte-identical output', async () => {
  const a = await runScan();
  const b = await runScan();
  assert.equal(renderJson(a.out), renderJson(b.out));
  assert.equal(a.counter.calls, b.counter.calls);
});

test('results are sorted by score desc with deterministic tie-breaks', async () => {
  const { out } = await runScan();
  for (let i = 1; i < out.results.length; i++) {
    const prev = out.results[i - 1];
    const cur = out.results[i];
    assert.ok(prev.score >= cur.score, `${prev.repo}#${prev.number} >= ${cur.repo}#${cur.number}`);
    if (prev.score === cur.score) {
      assert.ok(`${prev.repo}#${prev.number}` <= `${cur.repo}#${cur.number}`);
    }
  }
  assert.ok(out.results.length <= 20, 'default limit 20');
});

test('budget: scan stops gracefully at the call ceiling and reports partial', async () => {
  const { out, counter } = await runScan({ budget: 4 });
  assert.equal(counter.calls, 4, 'never exceeds the budget');
  assert.equal(out.meta.calls, 4);
  assert.equal(out.meta.budgetHit, true);
  assert.equal(out.meta.partial, true);
  assert.equal(out.meta.dataErrors.length, 0, 'budget stop is not an API error');
  assert.ok(out.results.length > 0, 'still scores what it fetched');

  const starved = await runScan({ budget: 1 });
  assert.equal(starved.counter.calls, 1);
  assert.equal(starved.out.meta.reposSkipped, 2, 'remaining repos are skipped, not crashed on');
  assert.equal(starved.out.results.length, 0);
  assert.equal(starved.out.meta.budgetHit, true);
  assert.ok(starved.out.meta.skipped.includes('beta/kit'));
});

test('cache: warm scan makes zero fetch calls; --refresh forces; --offline never fetches', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'radar-scan-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cachePath = join(dir, '.radar-cache.json');

  const first = await runScan({ cachePath });
  assert.ok(first.counter.calls > 0, 'cold scan fetches');
  assert.ok(existsSync(cachePath));

  const second = await runScan({ cachePath });
  assert.equal(second.counter.calls, 0, 'warm scan fetches nothing');
  assert.equal(second.out.meta.cachedRepos, 2);
  assert.equal(renderJson(second.out), renderJson(first.out), 'cached results are identical');

  const refreshed = await runScan({ cachePath, refresh: true });
  assert.equal(refreshed.counter.calls, first.counter.calls, '--refresh re-fetches everything');
  assert.equal(refreshed.out.meta.refresh, true);

  const bomb = async () => {
    throw new Error('offline mode must never call fetch');
  };
  const offline = await scan({
    repos: REPOS,
    fetchFn: bomb,
    now,
    fingerprint,
    cachePath,
    offline: true,
    minScore: 0.4,
  });
  assert.equal(offline.meta.calls, 0);
  assert.equal(offline.meta.dataErrors.length, 0);
  assert.equal(renderJson(offline), renderJson(first.out));
});

test('offline with a cold cache reports data errors instead of fetching', async () => {
  const out = await scan({
    repos: REPOS,
    fetchFn: async () => {
      throw new Error('must not fetch');
    },
    now,
    offline: true,
    minScore: 0.4,
  });
  assert.equal(out.meta.calls, 0);
  assert.equal(out.results.length, 0);
  assert.equal(out.meta.dataErrors.length, 2);
  assert.match(out.meta.dataErrors[0], /offline: no cached data/);
  assert.equal(out.meta.partial, true);
});

test('API errors degrade to partial results with the healthy repo still scored', async () => {
  const inner = buildFixtureFetch(fixture);
  const out = await scan({
    repos: ['ghost/nope', 'acme/widgets'],
    fetchFn: async (url) => {
      if (url.includes('/repos/ghost/nope')) {
        return { ok: false, status: 404, headers: { get: () => null }, json: async () => ({ message: 'Not Found' }) };
      }
      return inner(url);
    },
    now,
    fingerprint,
    minScore: 0.4,
  });
  assert.equal(out.meta.dataErrors.length, 1);
  assert.match(out.meta.dataErrors[0], /^ghost\/nope: HTTP 404/);
  assert.equal(out.meta.partial, true);
  assert.ok(out.results.some((r) => r.repo === 'acme/widgets'), 'partial results are still printed');
});

test('--lang and --hours filters narrow the result set', async () => {
  const tsOnly = await runScan({ lang: ['ts'] });
  assert.equal(tsOnly.out.meta.reposLoaded, 1, 'Python repo filtered out');
  assert.ok(tsOnly.out.results.every((r) => r.repo === 'acme/widgets'));

  const recent = await runScan({ hours: 48 });
  const ids = recent.out.results.map((r) => `${r.repo}#${r.number}`).sort();
  assert.deepEqual(ids, ['acme/widgets#101', 'acme/widgets#106', 'beta/kit#201'], 'only issues updated within 48h');
});

test('missing fingerprint keeps scans working with a neutral match', async () => {
  const { out } = await runScan({ fingerprint: null });
  assert.equal(out.meta.fingerprintLoaded, false);
  assert.ok(out.results.length > 0, 'cold start still ranks (README: graceful fallback)');
  assert.ok(out.results.every((r) => typeof r.signals.match === 'number'));
});
