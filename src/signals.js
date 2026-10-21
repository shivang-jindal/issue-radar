// Parsing (REST issues + timeline events) and raw signal computation.
// All signals are goodness-oriented: higher raw = better. Raw values are
// normalized per repo later (p10/p90) by score.js.

import { clamp, isBot, parseTimestamp } from './util.js';

export const HALF_LIFE_MS = 30 * 86_400_000;
export const RESPONSE_WINDOW_MS = 168 * 3_600_000; // 7 days
export const COMPETITION_CAP = 3;
export const ABANDONED_CAP = 2;
export const FOOTPRINT_CAP = 8;
export const ACTIVITY_OPTIMAL_MAX = 12;

// ---- parsing -------------------------------------------------------------

export function parseIssue(raw) {
  return {
    number: raw.number,
    title: raw.title ?? '',
    body: typeof raw.body === 'string' ? raw.body : '',
    labels: Array.isArray(raw.labels)
      ? raw.labels.map((l) => (typeof l === 'string' ? l : l?.name)).filter(Boolean)
      : [],
    comments: Number.isFinite(raw.comments) ? raw.comments : 0,
    author: raw.user?.login ?? null,
    createdAt: parseTimestamp(raw.created_at),
    updatedAt: parseTimestamp(raw.updated_at),
    url: raw.html_url ?? `https://github.com/issue/${raw.number}`,
  };
}

// Keep real issues only (drop pull_request entries) and require at least one
// requested label — same OR semantics the API uses.
export function parseIssueList(rawList, { labels = [] } = {}) {
  if (!Array.isArray(rawList)) return [];
  const wanted = labels.map((l) => l.toLowerCase());
  const out = [];
  for (const raw of rawList) {
    if (!raw || typeof raw !== 'object') continue;
    if (raw.pull_request) continue; // the issues endpoint also returns PRs
    const issue = parseIssue(raw);
    if (wanted.length && !issue.labels.some((l) => wanted.includes(l.toLowerCase()))) continue;
    out.push(issue);
  }
  return out;
}

// Timeline → first human non-author response, competing/abandoned PRs,
// human comment counts. `event.user` (comments) or `event.actor` (other events).
function actorOf(ev) {
  return ev.user ?? ev.actor ?? null;
}

export function parseTimeline(events, issue) {
  const list = Array.isArray(events) ? events : [];
  let firstResponseAt = null;
  let negativeClamped = false;
  let humanComments = 0;
  let botComments = 0;
  let competingPrs = 0;
  let abandonedAttempts = 0;

  for (const ev of list) {
    if (!ev || typeof ev !== 'object') continue;
    if (ev.event === 'commented') {
      const user = actorOf(ev);
      if (isBot(user)) {
        botComments += 1;
        continue;
      }
      // Human comments (author included) count as activity, but only a
      // non-author human counts as a maintainer *response*.
      humanComments += 1;
      const ts = parseTimestamp(ev.created_at);
      const isAuthor = user?.login && issue.author && user.login === issue.author;
      if (!isAuthor && ts !== null && (firstResponseAt === null || ts < firstResponseAt)) firstResponseAt = ts;
    } else if (ev.event === 'cross-referenced') {
      const src = ev.source?.issue;
      if (!src || !src.pull_request) continue; // only cross-referenced PRs
      if (src.number === issue.number) continue;
      const merged =
        src.pull_request.merged_at != null ||
        src.merged_at != null ||
        src.state === 'merged';
      if (src.state === 'open') {
        const own = src.user?.login && issue.author && src.user.login === issue.author;
        if (!own) competingPrs += 1;
      } else if (src.state === 'closed' && !merged) {
        abandonedAttempts += 1; // closed without merging: a dead attempt
      }
    }
  }

  let firstResponseMs = null;
  if (firstResponseAt !== null) {
    const delta = firstResponseAt - (issue.createdAt ?? firstResponseAt);
    if (delta < 0) {
      // Clock skew / bad timestamp: clamp negatives, flag for `why`.
      negativeClamped = true;
      firstResponseMs = 0;
    } else {
      firstResponseMs = delta;
    }
  }

  return { firstResponseMs, negativeClamped, humanComments, botComments, competingPrs, abandonedAttempts };
}

// ---- body feature extraction --------------------------------------------

const URL_RE = /https?:\/\/\S+/g;
const PATH_RE = /(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,6}/g;

export function extractPaths(body) {
  if (typeof body !== 'string' || !body) return [];
  const text = body.replace(URL_RE, ' ');
  const found = text.match(PATH_RE) ?? [];
  const seen = new Set();
  const out = [];
  for (const p of found) {
    const key = p.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
    if (out.length >= 20) break;
  }
  return out;
}

const SIZE_LABEL_RE =
  /^(?:size|effort|complexity|difficulty)\s*[:=-]?\s*(?:xs|s|small|1|low|easy|trivial)$|^(?:xs|small|easy|trivial|beginner)$/i;

export function hasSizeLabel(labels) {
  return labels.some((l) => SIZE_LABEL_RE.test(l));
}

export function scopeParts(issue) {
  const body = issue.body ?? '';
  const lengthSweet = body.length >= 80 && body.length <= 1200;
  const checklist = /(?:^|\n)\s*[-*]\s*\[[ xX]\]/.test(body);
  const acceptance =
    /acceptance criteria|expected (?:result|results|behavior|outcome)|definition of done/i.test(body);
  const sizeLabel = hasSizeLabel(issue.labels);
  return { lengthSweet, checklist, acceptance, sizeLabel };
}

export function reproScore(body) {
  if (typeof body !== 'string' || !body) return 0;
  const hasStack =
    /stack ?trace|traceback \(most recent call last\)|uncaught (?:exception|error)|^ERROR:|panic:/im.test(
      body,
    ) || /(?:^|\n)\s*at\s+\S+.*:\d+:\d+/.test(body);
  const hasRepro =
    /reproduc\w+|steps to repro|repro(?:duce)?\s*(?:steps|example|instructions)|^\s*\d+\.\s+(?:run|install|clone|open|start|go to|navigate)/im.test(
      body,
    );
  return hasStack || hasRepro ? 1 : 0;
}

// ---- raw signals ---------------------------------------------------------

export function freshScore(updatedAt, nowMs) {
  if (!Number.isFinite(updatedAt)) return 0;
  const age = Math.max(0, nowMs - updatedAt);
  return 0.5 ** (age / HALF_LIFE_MS);
}

export function respScore(firstResponseMs) {
  if (firstResponseMs === null || firstResponseMs === undefined) return 0;
  return 1 - clamp(firstResponseMs / RESPONSE_WINDOW_MS);
}

export function ncompScore(competing) {
  return 1 - clamp(competing / COMPETITION_CAP);
}

export function nabandScore(abandoned) {
  return 1 - clamp(abandoned / ABANDONED_CAP);
}

export function scopeScore(issue) {
  const p = scopeParts(issue);
  return 0.4 * (p.lengthSweet ? 1 : 0) + 0.25 * (p.checklist ? 1 : 0) + 0.25 * (p.acceptance ? 1 : 0) + 0.1 * (p.sizeLabel ? 1 : 0);
}

export function footScore(touched) {
  if (touched === null || touched === undefined) return null; // unknown → neutral fill
  return 1 - clamp(touched / FOOTPRINT_CAP);
}

export function actScore(commentCount) {
  const c = Math.max(0, commentCount ?? 0);
  if (c === 0) return 0;
  if (c <= ACTIVITY_OPTIMAL_MAX) return 1;
  return clamp(1 - (c - ACTIVITY_OPTIMAL_MAX) / ACTIVITY_OPTIMAL_MAX);
}

// Raw signal map for one issue. `timeline` null = not fetched (unknown → null).
export function computeRawSignals(issue, { nowMs, timeline, match = 0.5 }) {
  const touchedPaths = extractPaths(issue.body);
  const touched = touchedPaths.length ? touchedPaths.length : null;
  const commentCount = timeline ? timeline.humanComments : issue.comments;
  return {
    match,
    resp: timeline ? respScore(timeline.firstResponseMs) : null,
    ncomp: timeline ? ncompScore(timeline.competingPrs) : null,
    naband: timeline ? nabandScore(timeline.abandonedAttempts) : null,
    scope: scopeScore(issue),
    fresh: freshScore(issue.updatedAt, nowMs),
    repro: reproScore(issue.body),
    foot: footScore(touched),
    act: actScore(commentCount),
    _touched: touched,
    _touchedPaths: touchedPaths,
    _commentCount: commentCount,
  };
}
