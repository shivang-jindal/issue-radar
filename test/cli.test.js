import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BASE = resolve(fileURLToPath(new URL('..', import.meta.url)));
const CLI = join(BASE, 'src', 'cli.js');
const FIXTURE = join(BASE, 'test', 'fixtures', 'sample-scan.json');
const FINGERPRINT = join(BASE, 'test', 'fixtures', 'fingerprint.json');
const APPLIED = join(BASE, 'test', 'fixtures', 'applied-log.json');

function run(args, opts = {}) {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    cwd: opts.cwd ?? BASE,
    env: { ...process.env, GITHUB_TOKEN: '', GH_TOKEN: '', ...(opts.env ?? {}) },
    timeout: 30_000,
  });
  return { code: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

test('radar --help exits 0 with usage', () => {
  const { code, stdout } = run(['--help']);
  assert.equal(code, 0);
  assert.match(stdout, /Usage:/);
  assert.match(stdout, /radar scan/);
  assert.match(stdout, /Exit codes: 0 ok · 1 no matches · 2 usage · 3 api error/);
});

test('radar scan --help exits 0 with scan-specific flags', () => {
  const { code, stdout } = run(['scan', '--help']);
  assert.equal(code, 0);
  assert.match(stdout, /--min-score/);
  assert.match(stdout, /--offline/);
});

test('radar --version exits 0', () => {
  const { code, stdout } = run(['--version']);
  assert.equal(code, 0);
  assert.equal(stdout.trim(), 'issue-radar 0.1.0');
});

test('usage errors exit 2', () => {
  assert.equal(run([]).code, 2, 'no command');
  assert.equal(run(['nope']).code, 2, 'unknown command');
  assert.equal(run(['scan', '--bogus']).code, 2, 'unknown flag');
  assert.equal(run(['scan', '--limit']).code, 2, 'missing flag value');
  assert.equal(run(['scan', '--limit', 'many']).code, 2, 'bad number');
  assert.equal(run(['scan', '--format', 'yaml']).code, 2, 'bad format');
  assert.equal(run(['scan', 'not-a-repo']).code, 2, 'bad repo');
  assert.equal(run(['why']).code, 2, 'missing target');
  assert.equal(run(['why', 'wrong']).code, 2, 'malformed target');
  const noRepos = run(['scan']);
  assert.equal(noRepos.code, 2, 'no repos configured');
  assert.match(noRepos.stderr, /no repos to scan/);
});

test('fixture scan prints a real table and exits 0', () => {
  const { code, stdout, stderr } = run([
    'scan',
    '--fixture',
    FIXTURE,
    '--fingerprint',
    FINGERPRINT,
  ]);
  assert.equal(code, 0, stderr);
  assert.match(stdout, /acme\/widgets#101/);
  assert.match(stdout, /★0\.9\d/);
  assert.match(stdout, /why: {2}/);
  assert.match(stdout, /scanned 2026-10-20T12:00:00\.000Z/);
});

test('fixture scan --json emits the frozen v1 contract', () => {
  const { code, stdout } = run([
    'scan',
    '--fixture',
    FIXTURE,
    '--fingerprint',
    FINGERPRINT,
    '--json',
  ]);
  assert.equal(code, 0);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.version, 1);
  assert.equal(parsed.generatedAt, '2026-10-20T12:00:00.000Z');
  assert.ok(Array.isArray(parsed.results));
  assert.ok(parsed.results.length >= 5);
  assert.equal(parsed.results[0].repo, 'acme/widgets');
  assert.equal(parsed.results[0].number, 101);
  assert.equal(parsed.results[0].reasons.length, 3);
});

test('no matches exits 1', () => {
  const { code, stdout } = run([
    'scan',
    '--fixture',
    FIXTURE,
    '--min-score',
    '0.99',
    '--json',
  ]);
  assert.equal(code, 1);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.results.length, 0);
});

test('API errors exit 3 with partial results still printed', () => {
  const { code, stdout, stderr } = run([
    'scan',
    'ghost/nope',
    'acme/widgets',
    '--fixture',
    FIXTURE,
    '--fingerprint',
    FINGERPRINT,
    '--json',
  ]);
  assert.equal(code, 3, stderr);
  assert.match(stderr, /error: ghost\/nope: HTTP 404/);
  const parsed = JSON.parse(stdout);
  assert.ok(parsed.results.some((r) => r.repo === 'acme/widgets'), 'partial results are printed');
});

test('radar why prints the full signal breakdown', () => {
  const { code, stdout } = run([
    'why',
    'acme/widgets#101',
    '--fixture',
    FIXTURE,
    '--fingerprint',
    FINGERPRINT,
  ]);
  assert.equal(code, 0);
  assert.match(stdout, /why acme\/widgets#101/);
  assert.match(stdout, /SIGNAL/);
  assert.match(stdout, /match\s+0\.92/);
  assert.match(stdout, /CONTRIB/);
  assert.match(stdout, /reasons:/);
  assert.match(stdout, /maintainer answers in ~4h/);
  assert.match(stdout, /timeline: 3 human \/ 0 bot comments/);
});

test('radar why --json exposes raw values and contributions', () => {
  const { code, stdout } = run([
    'why',
    'acme/widgets#103',
    '--fixture',
    FIXTURE,
    '--fingerprint',
    FINGERPRINT,
    '--json',
  ]);
  assert.equal(code, 0);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.repo, 'acme/widgets');
  assert.equal(parsed.number, 103);
  assert.equal(Object.keys(parsed.raw).length, 9);
  assert.equal(typeof parsed.contributions.match, 'number');
  assert.equal(parsed.signals.naband, 0, 'two abandoned attempts scale to 0');
});

test('radar why on a missing issue exits 3 when the API errored, 1 otherwise', () => {
  const missing = run(['why', 'acme/widgets#404', '--fixture', FIXTURE]);
  assert.equal(missing.code, 1, missing.stderr);
  assert.match(missing.stderr, /not found/);

  const ghost = run(['why', 'ghost/nope#1', '--fixture', FIXTURE]);
  assert.equal(ghost.code, 3);
  assert.match(ghost.stderr, /error: ghost\/nope: HTTP 404/);
});

test('radar stats reads the applied-issues log', () => {
  const { code, stdout } = run(['stats', '--log', APPLIED]);
  assert.equal(code, 0);
  assert.match(stdout, /applications: 4/);
  assert.match(stdout, /merge rate: 50%/);
  assert.match(stdout, /median days to merge: 7\.5/);
  assert.match(stdout, /acme\/widgets/);

  const json = run(['stats', '--log', APPLIED, '--json']);
  assert.equal(json.code, 0);
  assert.equal(JSON.parse(json.stdout).applications, 4);

  const missing = run(['stats', '--log', join(BASE, 'nope', 'missing.json')]);
  assert.equal(missing.code, 0, 'empty stats is still ok');
  assert.match(missing.stdout, /log is empty/);
});

test('radar fingerprint builds and writes a fingerprint', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'radar-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const out = join(dir, 'fp.json');
  const repo = join(dir, 'repo');
  mkdirSync(join(repo, 'lib'), { recursive: true });
  writeFileSync(join(repo, 'lib', 'main.py'), 'print("hi")\n'.repeat(50), 'utf8');
  writeFileSync(join(repo, 'README.md'), '# hi\n', 'utf8');

  const { code, stdout } = run(['fingerprint', '--path', repo, '--fingerprint', out]);
  assert.equal(code, 0, stdout);
  assert.match(stdout, /fingerprint of/);
  assert.match(stdout, /saved to:/);
  assert.ok(existsSync(out));
  const fp = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(fp.version, 1);
  assert.ok(fp.languages.py > 0.5);
  assert.ok(fp.clusters.lib > 0.9);
  assert.equal(typeof fp.typical.fileCount, 'number');

  const bad = run(['fingerprint', '--path', join(dir, 'does-not-exist'), '--fingerprint', out]);
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /path not found/);
});

test('radar scan honors radar.config.json via --config', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'radar-cfg-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cfg = join(dir, 'radar.config.json');
  writeFileSync(
    cfg,
    JSON.stringify({ repos: ['acme/widgets'], labels: ['docs'], minScore: 0, limit: 5 }),
    'utf8',
  );
  const { code, stdout } = run([
    'scan',
    '--config',
    cfg,
    '--fixture',
    FIXTURE,
    '--fingerprint',
    FINGERPRINT,
    '--json',
  ]);
  assert.equal(code, 0);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.results.length, 1, 'only issues labeled "docs"');
  assert.equal(parsed.results[0].number, 101);
});

test('fixture runs have no network access and need no token', () => {
  // Fixture mode builds its own fetch, so an empty GITHUB_TOKEN (and no `gh`)
  // must not matter: --offline + --fixture is a fully local demo run.
  const { code } = run(['scan', '--fixture', FIXTURE, '--json', '--offline']);
  assert.equal(code, 0, 'offline fixture scan works without any environment');
});
