// Shared pure helpers. No I/O, no network — safe to use anywhere.

export function clamp(x, lo = 0, hi = 1) {
  if (!Number.isFinite(x)) return lo;
  return Math.min(hi, Math.max(lo, x));
}

export function round4(x) {
  return Math.round(x * 10000) / 10000;
}

// Linear-interpolation percentile over an ASCENDING sorted array (p in [0,1]).
export function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0];
  const idx = (sorted.length - 1) * clamp(p, 0, 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

// Robust per-repo normalization: map raw values onto [0,1] using p10/p90.
// `null` values are unknowns: they scale to null and are excluded from the
// percentile computation (callers fill them with a neutral 0.5).
export function robustScale(values) {
  const known = values
    .filter((v) => typeof v === 'number' && Number.isFinite(v))
    .slice()
    .sort((a, b) => a - b);
  if (known.length === 0) {
    return { scaled: values.map(() => null), p10: null, p90: null, flat: true };
  }
  const p10 = percentile(known, 0.1);
  const p90 = percentile(known, 0.9);
  const flat = !(p90 - p10 > 1e-9);
  const scaled = values.map((v) => {
    if (typeof v !== 'number' || !Number.isFinite(v)) return null;
    if (flat) return clamp(v);
    return clamp((v - p10) / (p90 - p10));
  });
  return { scaled, p10, p90, flat };
}

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

// Compact human duration for reason strings: 4m / 4h / 3d / 42d
export function fmtDuration(ms) {
  const v = Math.max(0, ms);
  if (v < HOUR) return `${Math.max(1, Math.round(v / MIN))}m`;
  if (v < DAY) return `${Math.round(v / HOUR)}h`;
  if (v < 60 * DAY) return `${Math.round(v / DAY)}d`;
  return `${Math.round(v / (30 * DAY))}mo`;
}

// GitHub bot detection: Bot account type or suffixed login (e.g. `x[bot]`).
export function isBot(user) {
  if (!user) return false;
  if (user.type === 'Bot') return true;
  const login = typeof user === 'string' ? user : user.login;
  return typeof login === 'string' && /\[bot\]$/.test(login);
}

export function parseTimestamp(iso) {
  const ms = Date.parse(iso ?? '');
  return Number.isFinite(ms) ? ms : null;
}

export function splitRepo(repo) {
  const idx = String(repo).indexOf('/');
  if (idx <= 0 || idx === String(repo).length - 1) return null;
  return [String(repo).slice(0, idx), String(repo).slice(idx + 1)];
}

export function plural(n, one, many = `${one}s`) {
  return n === 1 ? one : many;
}

// Deterministic ordering: score desc, then repo asc, then number asc.
export function compareResults(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  if (a.repo !== b.repo) return a.repo < b.repo ? -1 : 1;
  return a.number - b.number;
}
