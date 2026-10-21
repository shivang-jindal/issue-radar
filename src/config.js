// Configuration: defaults + optional radar.config.json merge.
// Zero-dependency JSON config (no comments allowed).

import { existsSync, readFileSync } from 'node:fs';

// v0 weights from SPEC §5 (sum = 1.00).
export const DEFAULT_WEIGHTS = {
  match: 0.18,
  resp: 0.14,
  ncomp: 0.12,
  naband: 0.12,
  scope: 0.12,
  fresh: 0.1,
  repro: 0.08,
  foot: 0.08,
  act: 0.06,
};

// Fixed order used for tie-breaking and `why` tables.
export const SIGNAL_ORDER = ['match', 'resp', 'ncomp', 'naband', 'scope', 'fresh', 'repro', 'foot', 'act'];

export const DEFAULTS = {
  repos: [],
  labels: ['good first issue', 'help wanted'],
  minScore: 0.4,
  limit: 20,
  shortlist: 20,
  budget: 60,
  baseUrl: 'https://api.github.com',
  // Per-repo cache TTLs: fresh (active) 15m / idle 6h.
  ttl: { freshMs: 15 * 60_000, idleMs: 6 * 3_600_000, dormantDays: 30 },
  weights: DEFAULT_WEIGHTS,
  cachePath: '.radar-cache.json',
  fingerprintPath: null,
  logPath: null,
};

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
    this.usage = true;
  }
}

export function loadConfig(file) {
  if (!file || !existsSync(file)) return {};
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    throw new ConfigError(`cannot read config ${file}: ${err.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new ConfigError(`invalid JSON in config ${file}: ${err.message}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ConfigError(`config ${file} must be a JSON object`);
  }
  return parsed;
}

// flags win over file config, file config wins over defaults.
export function mergeConfig(fileConfig, flags = {}) {
  const cfg = {
    ...DEFAULTS,
    ttl: { ...DEFAULTS.ttl, ...(fileConfig.ttl ?? {}) },
    weights: { ...DEFAULTS.weights, ...(fileConfig.weights ?? {}) },
    ...fileConfig,
  };
  if (flags.repos) cfg.repos = flags.repos;
  if (flags.labels) cfg.labels = flags.labels;
  if (flags.minScore !== undefined) cfg.minScore = flags.minScore;
  if (flags.limit !== undefined) cfg.limit = flags.limit;
  if (flags.budget !== undefined) cfg.budget = flags.budget;
  if (flags.cachePath !== undefined) cfg.cachePath = flags.cachePath;
  if (flags.fingerprintPath !== undefined) cfg.fingerprintPath = flags.fingerprintPath;
  if (flags.baseUrl !== undefined) cfg.baseUrl = flags.baseUrl;
  return cfg;
}
