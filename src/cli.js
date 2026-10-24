#!/usr/bin/env node
// issue-radar CLI: scan · why · fingerprint · stats
// Exit codes: 0 ok · 1 no matches · 2 usage · 3 api error (partial results)

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { ConfigError, DEFAULTS, loadConfig, mergeConfig } from './config.js';
import { resolveToken } from './github.js';
import { buildFixtureFetch } from './fixture.js';
import { buildFingerprint, loadFingerprint } from './fingerprint.js';
import { scan } from './scan.js';
import {
  renderFingerprint,
  renderJson,
  renderMd,
  renderStats,
  renderTable,
  renderWhy,
  renderWhyJson,
} from './render.js';
import { computeStats, loadAppliedLog } from './stats.js';
import { splitRepo } from './util.js';

export const VERSION = '0.1.0';

const FLAG_TYPES = {
  help: 'bool',
  version: 'bool',
  json: 'bool',
  refresh: 'bool',
  offline: 'bool',
  label: 'list',
  lang: 'list',
  'min-score': 'float',
  hours: 'float',
  limit: 'int',
  budget: 'int',
  format: 'str',
  config: 'str',
  cache: 'str',
  fingerprint: 'str',
  fixture: 'str',
  path: 'str',
  log: 'str',
  state: 'str',
  iterations: 'int',
  interval: 'int',
};
const FLAG_ALIASES = { h: 'help', v: 'version' };

class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
    this.usage = true;
  }
}

function coerce(name, type, raw) {
  if (type === 'int') {
    // Number('') is 0 — `--iterations ''` must be a usage error, not a
    // silent "run forever".
    if (String(raw).trim() === '') throw new UsageError(`--${name} expects an integer, got an empty value`);
    const n = Number(raw);
    if (!Number.isInteger(n)) throw new UsageError(`--${name} expects an integer, got "${raw}"`);
    return n;
  }
  if (type === 'float') {
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new UsageError(`--${name} expects a number, got "${raw}"`);
    return n;
  }
  if (type === 'list') {
    return String(raw)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return String(raw);
}

export function parseArgv(argv) {
  const flags = {};
  const args = [];
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === '--') {
      args.push(...argv.slice(i + 1));
      break;
    }
    if (tok.startsWith('--') || /^-(?![0-9])/.test(tok)) {
      let name = tok.replace(/^--?/, '');
      let inline = null;
      const eq = name.indexOf('=');
      if (eq !== -1) {
        inline = name.slice(eq + 1);
        name = name.slice(0, eq);
      }
      name = FLAG_ALIASES[name] ?? name;
      const type = FLAG_TYPES[name];
      if (!type) throw new UsageError(`unknown flag: ${tok}`);
      if (type === 'bool') {
        flags[name] = inline === null ? true : inline !== 'false';
      } else {
        let raw = inline;
        if (raw === null) {
          raw = argv[++i];
          if (raw === undefined) throw new UsageError(`flag ${tok} requires a value`);
        }
        flags[name] = coerce(name, type, raw);
      }
    } else {
      args.push(tok);
    }
  }
  return { flags, args };
}

const GENERAL_HELP = `issue-radar — find the issue you'll actually merge

Usage:
  radar scan [owner/repo…] [options]   rank open issues by merge probability
  radar why <owner/repo#n> [options]   full signal breakdown for one issue
  radar watch [owner/repo…] --state <file> --iterations <n>   poll; print only new/updated
  radar fingerprint [options]          build your local fingerprint (offline)
  radar stats [options]                your application/merge history
  radar --help [command] · radar --version

Options (scan/why):
  --label <list>        labels to scan (default: ${DEFAULTS.labels.join(',')})
  --min-score <f>       score threshold (default ${DEFAULTS.minScore})
  --limit <n>           max results (default ${DEFAULTS.limit})
  --hours <n>           only issues updated within the window
  --lang <list>          language filter (e.g. ts,typescript)
  --json | --format table|json|md
  --refresh             bypass cache TTLs
  --offline             cache only, never call the API (with --fixture: recorded responses)
  --budget <n>          max API calls per scan (default ${DEFAULTS.budget})
  --config <file>       radar.config.json path
  --cache <file>        cache file path (default ./.radar-cache.json)
  --fingerprint <file>  fingerprint file (default ~/.config/radar/fingerprint.json)
  --fixture <file>      serve responses from a recorded fixture (offline demo/tests)

Exit codes: 0 ok · 1 no matches · 2 usage · 3 api error (partial results)`;

const SCAN_HELP = `radar scan [owner/repo…] — rank issues by how likely YOU are to get them merged

  --label <list>        comma-separated labels (default: "${DEFAULTS.labels.join('","')}"), see radar.config.json
  --min-score <f>       drop results below this score (default ${DEFAULTS.minScore})
  --limit <n>           stop after n results (default ${DEFAULTS.limit})
  --hours <n>           only issues updated in the last n hours
  --lang <list>          only repos whose primary language matches
  --json                print the frozen v1 JSON contract
  --format <fmt>        table (default) | json | md
  --refresh             ignore cache TTLs and re-fetch
  --offline             use cache only (zero API calls; for CI and planes)
  --budget <n>          max API calls this scan (default ${DEFAULTS.budget})
  --config <file>       config file (default ./radar.config.json if present)
  --cache <file>        cache file (default ./.radar-cache.json)
  --fingerprint <file>  fingerprint used for the match signal
  --fixture <file>      run fully offline from a recorded fixture

Exit codes: 0 ok · 1 no matches · 2 usage · 3 api error (partial results)`;

const WHY_HELP = `radar why <owner/repo#n> — per-signal values, contributions, and reason strings

  Same data flags as radar scan (--fixture, --offline, --refresh, --cache,
  --fingerprint, --config, --label, …). Always scores the named issue
  regardless of --min-score.`;

const WATCH_HELP = `radar watch [owner/repo…] — poll repeatedly, print only new/updated issues

  --state <file>        required; state file mapping owner/repo#number -> updatedAt
  --iterations <n>      required; number of passes (>= 1; 0 = run forever)
  --interval <seconds>  pause between passes (default 60; 0 = no pause)
  Same data flags as radar scan (--fixture, --offline, --refresh, --cache,
  --fingerprint, --config, --label, --min-score, --json/--format, …).

The first pass prints every match and writes the state file; later passes
print only issues that are new or carry a newer updatedAt, then rewrite
state. Nothing new prints "no new issues" and exits 0. A corrupt state
file is an honest error on stderr and exit 3.

Exit codes: 0 ok · 2 usage · 3 api/state error`;

const FINGERPRINT_HELP = `radar fingerprint — languages, path clusters, and typical size from a local tree

  --path <dir>          repo to walk (default: current directory)
  --fingerprint <file>  where to write it (default ~/.config/radar/fingerprint.json)
  --json                print machine-readable JSON
  --config <file>       config file (labels are recorded as interests)`;

const STATS_HELP = `radar stats — your applications and merges from the local applied-issues log

  --log <file>          applied-issues log (default ~/.config/radar/applied.json)
  --json                machine-readable output
  --config <file>       config file`;

function helpFor(command) {
  switch (command) {
    case 'scan':
      return SCAN_HELP;
    case 'why':
      return WHY_HELP;
    case 'watch':
      return WATCH_HELP;
    case 'fingerprint':
      return FINGERPRINT_HELP;
    case 'stats':
      return STATS_HELP;
    default:
      return GENERAL_HELP;
  }
}

function readJsonFile(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    throw new UsageError(`cannot read ${file}: ${err.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new UsageError(`invalid JSON in ${file}: ${err.message}`);
  }
}

function resolvePath(p, cwd) {
  if (!p) return null;
  return isAbsolute(p) ? p : resolve(cwd, p);
}

function defaultFingerprintPath() {
  return join(homedir(), '.config', 'radar', 'fingerprint.json');
}

function loadConfigMerged(flags, cwd) {
  const file = flags.config ? resolvePath(flags.config, cwd) : join(cwd, 'radar.config.json');
  const fileCfg = loadConfig(file);
  return mergeConfig(fileCfg, {
    labels: flags.label,
    minScore: flags['min-score'],
    limit: flags.limit,
    budget: flags.budget,
    cachePath: flags.cache,
    fingerprintPath: flags.fingerprint,
  });
}

// Resolve fetchFn / clock / token for a command. Fixture mode is fully offline
// and uses the fixture's clock (unless the caller injected one).
function makeDataEnv({ flags, ctx, cfg, err }) {
  let fetchFn = ctx.fetchFn ?? null;
  let now = ctx.now ?? (() => new Date());
  let fixtureRepos = null;
  let isFixture = false;
  if (flags.fixture) {
    isFixture = true;
    const file = resolvePath(flags.fixture, ctx.cwd);
    const fixture = readJsonFile(file);
    if (!fixture || typeof fixture !== 'object' || !fixture.repos) {
      throw new UsageError(`fixture ${file} must contain a "repos" object`);
    }
    fetchFn = buildFixtureFetch(fixture);
    if (fixture.clock && !ctx.now) now = () => new Date(fixture.clock);
    fixtureRepos = Object.keys(fixture.repos);
  }
  if (!fetchFn) fetchFn = (url, init) => globalThis.fetch(url, init);
  let token = null;
  if (!flags.offline && !isFixture && !ctx.fetchFn) {
    token = resolveToken({ env: ctx.env ?? process.env, warn: (m) => err(`${m}\n`) }).token;
  }
  return { fetchFn, now, fixtureRepos, isFixture, token };
}

function cachePathFor({ flags, cfg, cwd, isFixture }) {
  const raw = flags.cache ?? cfg.cachePath ?? null;
  if (!raw) return null;
  if (isFixture && !flags.cache) return null; // fixture runs stay side-effect free
  return resolvePath(raw, cwd);
}

function loadFingerprintFile({ flags, cfg, cwd, err }) {
  const raw = flags.fingerprint ?? cfg.fingerprintPath ?? defaultFingerprintPath();
  const file = resolvePath(raw, cwd);
  if (!existsSync(file)) {
    err(`warning: no fingerprint at ${file} — run \`radar fingerprint --path <repo>\` (match stays neutral)\n`);
    return null;
  }
  try {
    return loadFingerprint(readFileSync(file, 'utf8'));
  } catch (e) {
    err(`warning: unusable fingerprint at ${file}: ${e.message} (match stays neutral)\n`);
    return null;
  }
}

function validateRepos(repos) {
  for (const r of repos) {
    if (!splitRepo(r)) {
      throw new UsageError(`invalid repo "${r}" — expected owner/name`);
    }
  }
}

async function cmdScan({ flags, args, ctx, err }) {
  const cwd = ctx.cwd;
  const cfg = loadConfigMerged(flags, cwd);
  const data = makeDataEnv({ flags, ctx, cfg, err });

  const repos = args.length ? args : (cfg.repos?.length ? cfg.repos : data.fixtureRepos ?? []);
  if (!repos.length) {
    throw new UsageError(
      'no repos to scan — pass owner/repo… , set "repos" in radar.config.json, or use --fixture',
    );
  }
  validateRepos(repos);

  const format = flags.format ?? (flags.json ? 'json' : 'table');
  if (!['table', 'json', 'md'].includes(format)) {
    throw new UsageError(`--format must be table, json, or md (got "${format}")`);
  }

  const fingerprint = loadFingerprintFile({ flags, cfg, cwd, err });
  const out = await scan({
    repos,
    labels: cfg.labels,
    minScore: cfg.minScore,
    limit: cfg.limit,
    shortlist: cfg.shortlist,
    budget: cfg.budget,
    refresh: Boolean(flags.refresh),
    // --offline means "never hit the real API"; with --fixture the recorded
    // responses are already local, so the fixture keeps serving them.
    offline: Boolean(flags.offline) && !data.isFixture,
    hours: flags.hours ?? null,
    lang: flags.lang ?? null,
    fetchFn: data.fetchFn,
    now: data.now,
    cachePath: cachePathFor({ flags, cfg, cwd, isFixture: data.isFixture }),
    fingerprint,
    baseUrl: cfg.baseUrl,
    token: data.token,
    weights: cfg.weights,
    ttl: cfg.ttl,
    warn: (m) => err(`${m}\n`),
  });

  for (const e of out.meta.dataErrors) err(`error: ${e}\n`);
  if (out.meta.budgetHit) {
    err(`warning: budget exhausted after ${out.meta.calls}/${out.meta.budget} calls — results are partial\n`);
  }

  if (format === 'json') ctx.out(renderJson(out));
  else if (format === 'md') ctx.out(renderMd(out));
  else ctx.out(renderTable(out));

  if (out.meta.dataErrors.length) return 3;
  if (!out.results.length) return 1;
  return 0;
}

function parseTarget(token) {
  const m = /^(?:https?:\/\/github\.com\/)?([^/\s#]+)\/([^/\s#]+)#(\d+)$/.exec(String(token ?? ''));
  if (!m) throw new UsageError(`expected <owner/repo#n>, got "${token}"`);
  return { repo: `${m[1]}/${m[2]}`, number: Number(m[3]) };
}

async function cmdWhy({ flags, args, ctx, err }) {
  if (!args.length) throw new UsageError('usage: radar why <owner/repo#n>');
  const target = parseTarget(args[0]);
  const cwd = ctx.cwd;
  const cfg = loadConfigMerged(flags, cwd);
  const data = makeDataEnv({ flags, ctx, cfg, err });
  const fingerprint = loadFingerprintFile({ flags, cfg, cwd, err });

  const out = await scan({
    repos: [target.repo],
    labels: cfg.labels,
    minScore: 0,
    limit: 10_000,
    shortlist: cfg.shortlist,
    budget: cfg.budget,
    refresh: Boolean(flags.refresh),
    offline: Boolean(flags.offline) && !data.isFixture,
    fetchFn: data.fetchFn,
    now: data.now,
    cachePath: cachePathFor({ flags, cfg, cwd, isFixture: data.isFixture }),
    fingerprint,
    baseUrl: cfg.baseUrl,
    token: data.token,
    weights: cfg.weights,
    ttl: cfg.ttl,
    forceTimelines: [target.number],
    warn: (m) => err(`${m}\n`),
  });

  for (const e of out.meta.dataErrors) err(`error: ${e}\n`);
  const key = `${target.repo}#${target.number}`;
  const breakdown = out.breakdowns[key];
  if (!breakdown) {
    err(
      `error: ${key} not found — is it open and labeled "${cfg.labels.join('" / "')}"?\n`,
    );
    return out.meta.dataErrors.length ? 3 : 1;
  }
  breakdown.title = out.results.find((r) => r.repo === target.repo && r.number === target.number)?.title ?? '';
  if (flags.json || flags.format === 'json') {
    ctx.out(renderWhyJson(breakdown, { ...target, scannedAt: out.generatedAt }));
  } else {
    ctx.out(renderWhy(breakdown, target));
  }
  if (out.meta.dataErrors.length) return 3;
  return 0;
}

function writeJsonAtomic(file, data) {
  mkdirSync(dirname(file), { recursive: true });
  const body = `${JSON.stringify(data, null, 2)}\n`;
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, body, 'utf8');
    renameSync(tmp, file); // overwrites on Windows too
  } catch {
    writeFileSync(file, body, 'utf8');
    try {
      if (existsSync(tmp)) rmSync(tmp, { force: true });
    } catch {
      /* ignore cleanup errors */
    }
  }
}

function cmdFingerprint({ flags, ctx, cwd, err }) {
  const cfg = loadConfigMerged(flags, cwd);
  const root = resolvePath(flags.path ?? cwd, cwd);
  const now = ctx.now ?? (() => new Date());
  let fp;
  try {
    fp = buildFingerprint({ root, now });
  } catch (e) {
    throw new UsageError(e.message);
  }
  if (cfg.labels?.length) fp.labels = [...cfg.labels];
  const outRaw = flags.fingerprint ?? cfg.fingerprintPath ?? defaultFingerprintPath();
  const outFile = resolvePath(outRaw, cwd);
  try {
    writeJsonAtomic(outFile, fp);
  } catch (e) {
    err(`error: cannot write fingerprint to ${outFile}: ${e.message}\n`);
    return 2;
  }
  if (flags.json || flags.format === 'json') ctx.out(`${JSON.stringify(fp, null, 2)}\n`);
  else ctx.out(renderFingerprint(fp, { savedTo: outFile }));
  return 0;
}

// Watch state: { <issue number>: <updatedAt> }. Missing file → start empty;
// anything unreadable/malformed is an honest exit-3 error, never a silent reset.
function loadWatchState(file) {
  if (!existsSync(file)) return {};
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    throw new Error(`corrupt state file ${file}: ${e.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`corrupt state file ${file}: ${e.message}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`corrupt state file ${file}: expected an object mapping issue numbers to updatedAt`);
  }
  const state = {};
  for (const [key, value] of Object.entries(parsed)) {
    if ((typeof value !== 'string' || value === '') && typeof value !== 'number') {
      throw new Error(`corrupt state file ${file}: entry ${JSON.stringify(key)} must map to an updatedAt value`);
    }
    state[key] = value;
  }
  return state;
}

function isUpdatedSince(prev, updatedAt) {
  if (prev === undefined || prev === null) return true; // never seen → new
  const prevMs = typeof prev === 'number' ? prev : Date.parse(prev);
  const curMs = updatedAt ? Date.parse(updatedAt) : NaN;
  return Number.isFinite(curMs) && Number.isFinite(prevMs) && curMs > prevMs;
}

async function cmdWatch({ flags, args, ctx, err }) {
  if (!flags.state) throw new UsageError('radar watch requires --state <file>');
  if (flags.iterations === undefined) throw new UsageError('radar watch requires --iterations <n>');
  if (flags.iterations < 0) throw new UsageError('--iterations must be >= 0 (0 = run forever)');

  const cwd = ctx.cwd;
  const cfg = loadConfigMerged(flags, cwd);
  const data = makeDataEnv({ flags, ctx, cfg, err });

  const repos = args.length ? args : (cfg.repos?.length ? cfg.repos : data.fixtureRepos ?? []);
  if (!repos.length) {
    throw new UsageError(
      'no repos to watch — pass owner/repo… , set "repos" in radar.config.json, or use --fixture',
    );
  }
  validateRepos(repos);

  const format = flags.format ?? (flags.json ? 'json' : 'table');
  if (!['table', 'json', 'md'].includes(format)) {
    throw new UsageError(`--format must be table, json, or md (got "${format}")`);
  }

  const stateFile = resolvePath(flags.state, cwd);
  let state;
  try {
    state = loadWatchState(stateFile);
  } catch (e) {
    err(`error: ${e.message}\n`);
    return 3;
  }

  const fingerprint = loadFingerprintFile({ flags, cfg, cwd, err });

  const iterations = flags.iterations;
  const intervalSec = flags.interval ?? 60;
  if (intervalSec < 0) throw new UsageError('--interval must be >= 0 seconds (0 = no pause between passes)');
  // injectable for tests (ctx.sleep); default real timer
  const sleep = ctx.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  for (let i = 0; iterations === 0 || i < iterations; i++) {
    const out = await scan({
      repos,
      labels: cfg.labels,
      minScore: cfg.minScore,
      limit: cfg.limit,
      shortlist: cfg.shortlist,
      budget: cfg.budget,
      refresh: Boolean(flags.refresh),
      offline: Boolean(flags.offline) && !data.isFixture,
      hours: flags.hours ?? null,
      lang: flags.lang ?? null,
      fetchFn: data.fetchFn,
      now: data.now,
      cachePath: cachePathFor({ flags, cfg, cwd, isFixture: data.isFixture }),
      fingerprint,
      baseUrl: cfg.baseUrl,
      token: data.token,
      weights: cfg.weights,
      ttl: cfg.ttl,
      warn: (m) => err(`${m}\n`),
    });

    for (const e of out.meta.dataErrors) err(`error: ${e}\n`);
    if (out.meta.budgetHit) {
      err(`warning: budget exhausted after ${out.meta.calls}/${out.meta.budget} calls — results are partial\n`);
    }

    // New or freshly-updated issues only (an empty/absent state prints all).
    // Keyed `owner/repo#number`: bare issue numbers collide across repos
    // (#42 in two watched repos would mask each other's updates).
    const fresh = out.results.filter((r) => isUpdatedSince(state[`${r.repo}#${r.number}`], r.updated_at));
    if (fresh.length === 0) {
      ctx.out('no new issues\n');
    } else {
      const filtered = { ...out, results: fresh };
      if (format === 'json') ctx.out(renderJson(filtered));
      else if (format === 'md') ctx.out(renderMd(filtered));
      else ctx.out(renderTable(filtered));
    }

    // Rewrite state from this pass's snapshot, then decide the exit code.
    const next = {};
    for (const r of out.results) next[`${r.repo}#${r.number}`] = r.updated_at ?? null;
    state = next;
    writeJsonAtomic(stateFile, state);

    if (out.meta.dataErrors.length) return 3;
    // Pause between passes — polling back-to-back hammers the API and burns
    // a core. No sleep after the final pass of a bounded run.
    const lastPass = iterations !== 0 && i + 1 >= iterations;
    if (!lastPass && intervalSec > 0) await sleep(intervalSec * 1000);
  }
  return 0;
}

function cmdStats({ flags, ctx, cwd, err }) {
  const cfg = loadConfigMerged(flags, cwd);
  const raw = flags.log ?? cfg.logPath ?? join(homedir(), '.config', 'radar', 'applied.json');
  const file = resolvePath(raw, cwd);
  const { entries, error } = loadAppliedLog(file);
  if (error) {
    err(`error: ${error}\n`);
    return 2;
  }
  const stats = computeStats(entries);
  const format = flags.json || flags.format === 'json' ? 'json' : 'table';
  ctx.out(renderStats(stats, { format, path: file }));
  return 0;
}

export async function main(argv, ctx = {}) {
  const cwd = ctx.cwd ?? process.cwd();
  const out = ctx.out ?? ((s) => process.stdout.write(s));
  const err = ctx.err ?? ((s) => process.stderr.write(s));
  const envCtx = { ...ctx, cwd, out, err };

  let parsed;
  try {
    parsed = parseArgv(argv);
  } catch (e) {
    err(`error: ${e.message}\n\n${GENERAL_HELP}\n`);
    return 2;
  }
  const { flags, args } = parsed;

  if (flags.version) {
    out(`issue-radar ${VERSION}\n`);
    return 0;
  }

  const command = args[0] ?? null;
  const rest = args.slice(1);

  if (flags.help || command === 'help') {
    out(`${helpFor(command === 'help' ? rest[0] : command)}\n`);
    return 0;
  }
  if (!command) {
    err(`${GENERAL_HELP}\n`);
    return 2;
  }

  try {
    switch (command) {
      case 'scan':
        return await cmdScan({ flags, args: rest, ctx: envCtx, err });
      case 'why':
        return await cmdWhy({ flags, args: rest, ctx: envCtx, err });
      case 'watch':
        return await cmdWatch({ flags, args: rest, ctx: envCtx, err });
      case 'fingerprint':
        return cmdFingerprint({ flags, ctx: envCtx, cwd, err });
      case 'stats':
        return cmdStats({ flags, ctx: envCtx, cwd, err });
      default:
        err(`error: unknown command "${command}"\n\n${GENERAL_HELP}\n`);
        return 2;
    }
  } catch (e) {
    if (e instanceof UsageError || e instanceof ConfigError || e.usage) {
      err(`error: ${e.message}\n`);
      return 2;
    }
    err(`error: ${e.message}\n`);
    return 3;
  }
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
