// Fingerprint: computed locally from a repo tree (no git required).
//  - languages by file bytes (extension shares)
//  - path clusters (top-level dirs, by bytes)
//  - typical size (file count, median file bytes, derived typical footprint)
//
// match = 0.4·subsystem + 0.3·language + 0.2·label + 0.1·size-comfort (SPEC §6)

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { clamp, parseTimestamp, round4 } from './util.js';

export const FINGERPRINT_VERSION = 1;

// Always skipped regardless of .gitignore.
const ALWAYS_SKIP_DIRS = new Set(['.git', 'node_modules']);
const ALWAYS_SKIP_FILES = new Set(['.radar-cache.json']);

// Common extensions → GitHub language name (lowercased).
export const LANG_ALIASES = {
  typescript: ['ts', 'tsx', 'mts', 'cts'],
  javascript: ['js', 'jsx', 'mjs', 'cjs'],
  python: ['py', 'pyw', 'pyi'],
  rust: ['rs'],
  go: ['go'],
  java: ['java'],
  c: ['c', 'h'],
  cpp: ['cc', 'cpp', 'cxx', 'hpp', 'hh', 'hxx'],
  csharp: ['cs'],
  ruby: ['rb'],
  php: ['php'],
  swift: ['swift'],
  kotlin: ['kt', 'kts'],
  shell: ['sh', 'bash', 'zsh'],
  html: ['html', 'htm'],
  css: ['css'],
  scss: ['scss', 'sass'],
  markdown: ['md', 'markdown'],
  yaml: ['yml', 'yaml'],
  json: ['json'],
  toml: ['toml'],
  lua: ['lua'],
  haskell: ['hs'],
  elixir: ['ex', 'exs'],
  dart: ['dart'],
  scala: ['scala'],
  r: ['r'],
  julia: ['jl'],
  sql: ['sql'],
};

// v0 heuristic: a typical change touches ~2% of the repo's files (min 1).
export const FOOTPRINT_RATIO = 0.02;

// ---- minimal .gitignore ---------------------------------------------------

// Supports: comments, blanks, `dir/`, leading `/`, `*`, `?`, `**`, `!neg`.
export function parseGitignore(text) {
  const rules = [];
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const negated = line.startsWith('!');
    const pattern = negated ? line.slice(1) : line;
    if (!pattern) continue;
    const anchored = pattern.startsWith('/');
    const dirOnly = pattern.endsWith('/');
    const body = (anchored ? pattern.slice(1) : pattern).replace(/\/$/, '');
    let re = '';
    for (let i = 0; i < body.length; i++) {
      const ch = body[i];
      if (ch === '*') {
        if (body[i + 1] === '*') {
          re += '.*';
          i += 1;
          if (body[i + 1] === '/') i += 1; // `**/` → `**` consumes separator
        } else {
          re += '[^/]*';
        }
      } else if (ch === '?') {
        re += '[^/]';
      } else if ('.+^${}()|[]\\'.includes(ch)) {
        re += `\\${ch}`;
      } else {
        re += ch;
      }
    }
    // End-anchor with ($|/): without it, pattern `dist` also matched
    // "distribution.js" and "mydist/x". Gitignore semantics are exact-segment
    // matches — a bare name matches the file OR the directory at any depth
    // (children are covered by the directory match during the walk).
    const source = anchored ? `^${re}($|/)` : `(^|/)${re}($|/)`;
    rules.push({ negated, dirOnly, anchored, re: new RegExp(source) });
  }
  return rules;
}

export function gitignoreMatches(relPath, isDir, rules) {
  const path = relPath.split(sep).join('/');
  let ignored = false;
  for (const rule of rules) {
    if (rule.dirOnly && !isDir) continue;
    if (!rule.re.test(path)) continue;
    ignored = !rule.negated; // last matching rule wins (minimal negation support)
  }
  return ignored;
}

// ---- tree walk -------------------------------------------------------------

export function walkTree(root, rules = []) {
  const files = [];
  function walk(dirAbs) {
    let entries;
    try {
      entries = readdirSync(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = join(dirAbs, entry.name);
      const rel = relative(root, abs);
      if (entry.isDirectory()) {
        if (ALWAYS_SKIP_DIRS.has(entry.name)) continue;
        if (gitignoreMatches(rel, true, rules)) continue;
        walk(abs);
      } else if (entry.isFile()) {
        if (ALWAYS_SKIP_FILES.has(entry.name)) continue;
        if (gitignoreMatches(rel, false, rules)) continue;
        let size = 0;
        try {
          size = statSync(abs).size;
        } catch {
          continue;
        }
        files.push({ rel: rel.split(sep).join('/'), bytes: size });
      }
    }
  }
  walk(root);
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return files;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

export function buildFingerprint({ root, now = () => new Date() }) {
  if (!existsSync(root)) {
    const err = new Error(`path not found: ${root}`);
    err.usage = true;
    throw err;
  }
  const giPath = join(root, '.gitignore');
  const rules = existsSync(giPath) ? parseGitignore(readFileSync(giPath, 'utf8')) : [];
  const files = walkTree(root, rules);

  const bytesByExt = new Map();
  const bytesByTop = new Map();
  const sizes = [];
  for (const f of files) {
    sizes.push(f.bytes);
    const dot = f.rel.lastIndexOf('.');
    const ext = dot > 0 ? f.rel.slice(dot + 1).toLowerCase() : '';
    if (ext) bytesByExt.set(ext, (bytesByExt.get(ext) ?? 0) + f.bytes);
    const top = f.rel.includes('/') ? f.rel.slice(0, f.rel.indexOf('/')) : '.';
    bytesByTop.set(top, (bytesByTop.get(top) ?? 0) + f.bytes);
  }
  const totalBytes = files.reduce((s, f) => s + f.bytes, 0) || 1;

  const languages = {};
  for (const [ext, bytes] of [...bytesByExt].sort((a, b) => b[1] - a[1])) {
    languages[ext] = round4(bytes / totalBytes);
  }
  const clusters = {};
  for (const [top, bytes] of [...bytesByTop].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
    if (top === '.') continue;
    clusters[top] = round4(bytes / totalBytes);
  }

  const fileCount = files.length;
  const typical = {
    fileCount,
    medianFileBytes: median(sizes),
    footprintFiles: Math.max(1, Math.round(fileCount * FOOTPRINT_RATIO)),
  };

  return {
    version: FINGERPRINT_VERSION,
    generatedAt: now().toISOString(),
    root,
    languages,
    clusters,
    typical,
    labels: [],
  };
}

// ---- match ----------------------------------------------------------------

export function normalizeLanguageName(name) {
  return String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9+#]/g, '');
}

// `--lang` matching: accepts names ("TypeScript") or extensions ("ts").
export function languageMatches(repoLanguage, wantedList) {
  const actual = normalizeLanguageName(repoLanguage);
  if (!actual) return true; // unknown language — don't filter out
  const wanted = wantedList.map(normalizeLanguageName);
  if (wanted.includes(actual)) return true;
  const actualExts = LANG_ALIASES[actual] ?? [];
  for (const w of wanted) {
    if ((LANG_ALIASES[w] ?? []).includes(actual)) return true;
    if (actualExts.includes(w)) return true;
  }
  return false;
}

export function languageShare(fingerprint, repoLanguage) {
  if (!fingerprint?.languages || !repoLanguage) return null;
  const lang = normalizeLanguageName(repoLanguage);
  const direct = fingerprint.languages[lang];
  if (direct !== undefined) return direct;
  const aliases = LANG_ALIASES[lang];
  if (aliases) {
    let sum = 0;
    for (const ext of aliases) sum += fingerprint.languages[ext] ?? 0;
    return sum > 0 ? sum : null;
  }
  return null;
}

// subsystem: fraction of issue file paths whose top dir is a known cluster;
// neutral 0.5 when the body carries no paths.
export function subsystemAffinity(paths, fingerprint) {
  const clusters = fingerprint?.clusters ?? {};
  const keys = Object.keys(clusters);
  if (!paths || paths.length === 0 || keys.length === 0) return { value: 0.5, hits: 0, total: 0 };
  let hits = 0;
  for (const p of paths) {
    const top = p.includes('/') ? p.slice(0, p.indexOf('/')) : p;
    if (keys.includes(top)) hits += 1;
  }
  return { value: hits / paths.length, hits, total: paths.length };
}

export function labelAffinity(issueLabels, fingerprint) {
  const wanted = fingerprint?.labels ?? [];
  if (!wanted.length) return 0.5; // no configured interests → neutral
  const set = new Set(wanted.map((l) => String(l).toLowerCase()));
  const hits = issueLabels.filter((l) => set.has(String(l).toLowerCase())).length;
  if (hits === 0) return 0;
  return Math.min(1, 0.5 + 0.25 * hits); // 1 hit 0.75, 2+ → 1.0
}

// est. footprint vs the fingerprint's typical change size (doubling per step).
export function sizeComfort(touched, fingerprint) {
  if (touched === null || touched === undefined || !fingerprint?.typical) return 0.5;
  const typical = fingerprint.typical.footprintFiles ?? 1;
  const ratio = (touched + 1) / (typical + 1);
  return clamp(1 - Math.abs(Math.log2(ratio)) / 4);
}

export function matchScore({ paths = [], labels = [], touched = null, repoLanguage = null }, fingerprint) {
  if (!fingerprint) {
    return { total: 0.5, parts: { subsystem: 0.5, language: 0.5, label: 0.5, sizeComfort: 0.5 }, detail: null };
  }
  const sub = subsystemAffinity(paths, fingerprint);
  const share = languageShare(fingerprint, repoLanguage);
  const lang = share === null ? 0.5 : Math.min(1, share * 2); // ≥50% of your bytes → 1.0
  const label = labelAffinity(labels, fingerprint);
  const comfort = sizeComfort(touched, fingerprint);
  const total = 0.4 * sub.value + 0.3 * lang + 0.2 * label + 0.1 * comfort;

  const langName = repoLanguage ? String(repoLanguage).toLowerCase() : null;
  let detail = null;
  if (sub.value >= 0.5 && sub.hits > 0) {
    // Object.hasOwn, not `in`: a top-level dir named "constructor" or
    // "toString" would hit Object.prototype and fake a cluster hit.
    const clusters = fingerprint.clusters ?? {};
    const top = paths.find((p) => Object.hasOwn(clusters, p.includes('/') ? p.slice(0, p.indexOf('/')) : p));
    detail = `your ${top ? top.split('/').slice(0, 2).join('/') : 'known'} work`;
  } else if (langName && share !== null && share > 0) {
    detail = `your ${langName} work`;
  }

  return {
    total: round4(total),
    parts: {
      subsystem: round4(sub.value),
      language: round4(lang),
      label: round4(label),
      sizeComfort: round4(comfort),
    },
    detail,
  };
}

export function loadFingerprint(text) {
  const parsed = typeof text === 'string' ? JSON.parse(text) : text;
  if (!parsed || typeof parsed !== 'object' || !parsed.languages || !parsed.clusters || !parsed.typical) {
    throw new Error('invalid fingerprint file');
  }
  return parsed;
}

export function fingerprintTimestamp(fingerprint) {
  return parseTimestamp(fingerprint?.generatedAt);
}
