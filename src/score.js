// Scoring: per-repo robust normalization (p10/p90) → weighted sum →
// top-3 reason strings + full explainable breakdown.

import { DEFAULT_WEIGHTS, SIGNAL_ORDER } from './config.js';
import { computeRawSignals, scopeParts } from './signals.js';
import { compareResults, fmtDuration, plural, robustScale, round4 } from './util.js';

const NEUTRAL = 0.5; // fill for unknown values (timeline not fetched, no fingerprint)

// A one-line, non-insulting note per signal (SPEC §11 tone).
export function signalNote(id, raw, issue, ctx) {
  const timeline = ctx.timeline ?? null;
  switch (id) {
    case 'match':
      if (ctx.matchDetail) return `matches ${ctx.matchDetail}`;
      if (!ctx.fingerprint) return 'fingerprint not loaded — neutral match';
      return `matches ${ctx.matchDetail ?? 'your profile'}`;
    case 'resp':
      if (raw === null) return 'response time unknown (timeline not fetched)';
      if (timeline && timeline.firstResponseMs === null) return 'no maintainer response yet';
      if (timeline?.negativeClamped) return 'response timestamp clamped (clock skew)';
      if (raw === 0) return 'no maintainer response yet';
      if (!Number.isFinite(ctx.responseMs)) return 'maintainer responded';
      return `maintainer answers in ~${fmtDuration(ctx.responseMs)}`;
    case 'ncomp':
      if (raw === null) return 'competing PRs unknown (timeline not fetched)';
      return `${ctx.competing ?? 0} competing ${plural(ctx.competing ?? 0, 'PR')}`;
    case 'naband':
      if (raw === null) return 'abandoned attempts unknown (timeline not fetched)';
      if (!ctx.abandoned) return 'no abandoned attempts';
      return `${ctx.abandoned} abandoned ${plural(ctx.abandoned, 'attempt')}`;
    case 'scope': {
      const p = scopeParts(issue);
      const bits = [];
      if (p.checklist) bits.push('checklist');
      if (p.acceptance) bits.push('acceptance criteria');
      if (p.lengthSweet) bits.push('clear body length');
      if (p.sizeLabel) bits.push('size label');
      if (bits.length >= 2) return `clear scope (${bits.slice(0, 2).join(' + ')})`;
      if (bits.length === 1) return `partial scope (${bits[0]})`;
      return 'scope unclear from body';
    }
    case 'fresh': {
      const age = Math.max(0, ctx.nowMs - issue.updatedAt);
      if (age < 3_600_000) return 'updated just now';
      return `updated ${fmtDuration(age)} ago`;
    }
    case 'repro':
      return raw === 1 ? 'includes repro / stack trace' : 'no repro steps found';
    case 'foot':
      if (raw === null) return 'footprint unknown (no file paths in body)';
      return `touches ~${ctx.touched} ${plural(ctx.touched ?? 0, 'file')}`;
    case 'act': {
      const c = ctx.commentCount ?? 0;
      if (c === 0) return 'no comments yet';
      if (c > 12) return `busy thread (${c} comments)`;
      return `healthy discussion (${c} comments)`;
    }
    default:
      return '';
  }
}

function respReason(raw, timeline) {
  if (raw === null) return 'response time unknown';
  if (!timeline || timeline.firstResponseMs === null || raw === 0) {
    return 'no maintainer response yet';
  }
  return `maintainer answers in ~${fmtDuration(timeline.firstResponseMs)}`;
}

// Build exactly three reason strings from the top contributing signals.
export function buildReasons(order, contributions, ctx) {
  const picked = [];
  for (const id of order) {
    if (picked.length >= 3) break;
    const raw = ctx.raw[id];
    if (raw === null || raw === undefined) continue; // unknowns don't make reasons
    if (contributions[id] === undefined) continue;
    picked.push(reasonFor(id, raw, ctx));
  }
  return picked.map((r) => r);
}

function reasonFor(id, raw, ctx) {
  const { issue, timeline } = ctx;
  switch (id) {
    case 'resp':
      return respReason(raw, timeline);
    case 'ncomp': {
      const n = timeline?.competingPrs ?? 0;
      return n === 0 ? '0 competing PRs' : `${n} competing ${plural(n, 'PR')}`;
    }
    case 'naband': {
      const n = timeline?.abandonedAttempts ?? 0;
      return n === 0 ? 'no abandoned attempts' : `${n} abandoned ${plural(n, 'attempt')}`;
    }
    case 'match':
      if (ctx.matchDetail) return `matches ${ctx.matchDetail}`;
      if (!ctx.fingerprint) return 'fingerprint not loaded';
      return 'matches your fingerprint';
    default:
      return signalNote(id, raw, issue, ctx);
  }
}

// Score a set of issues that belong to ONE repo.
// `items`: { issue, timeline|null, match:{total,parts,detail}|null }
export function scoreRepo(items, { nowMs, weights = DEFAULT_WEIGHTS, fingerprint = null } = {}) {
  const contexts = items.map((item) => {
    const match = item.match ? item.match.total : NEUTRAL;
    const raw = computeRawSignals(item.issue, {
      nowMs,
      timeline: item.timeline,
      match,
    });
    return { item, raw };
  });

  // Gather per-signal raw arrays (nulls excluded from percentiles).
  const perSignal = SIGNAL_ORDER.map((id) => contexts.map((c) => c.raw[id]));

  const normalized = perSignal.map((values) => robustScale(values));

  const results = [];
  for (let i = 0; i < contexts.length; i++) {
    const { item, raw } = contexts[i];
    const issue = item.issue;
    const timeline = item.timeline;
    const signals = {};
    const contributions = {};
    let score = 0;
    for (let s = 0; s < SIGNAL_ORDER.length; s++) {
      const id = SIGNAL_ORDER[s];
      const value = normalized[s].scaled[i];
      const filled = value === null ? NEUTRAL : value;
      signals[id] = round4(filled);
      const w = weights[id] ?? 0;
      contributions[id] = round4(w * filled);
      score += (weights[id] ?? 0) * filled;
    }
    const ctx = {
      issue,
      timeline,
      raw,
      signals,
      nowMs,
      fingerprint,
      touched: raw._touched,
      touchedPaths: raw._touchedPaths,
      commentCount: raw._commentCount,
      competing: timeline?.competingPrs ?? null,
      abandoned: timeline?.abandonedAttempts ?? null,
      responseMs: timeline?.firstResponseMs ?? null,
      matchDetail: item.match?.detail ?? null,
    };
    // Order by contribution desc, tie-break by fixed signal order.
    const order = SIGNAL_ORDER.slice().sort((a, b) => {
      const d = (contributions[b] ?? 0) - (contributions[a] ?? 0);
      if (d !== 0) return d;
      return SIGNAL_ORDER.indexOf(a) - SIGNAL_ORDER.indexOf(b);
    });
    const reasons = buildReasons(order, contributions, ctx);
    const notes = {};
    for (const id of SIGNAL_ORDER) {
      notes[id] = raw[id] === null ? signalNote(id, null, issue, ctx) : signalNote(id, raw[id], issue, ctx);
    }
    results.push({
      issue,
      timeline,
      score: round4(score),
      signals,
      raw: { ...raw },
      weights,
      contributions,
      order,
      reasons,
      notes,
      matchParts: item.match?.parts ?? null,
      normalization: Object.fromEntries(
        SIGNAL_ORDER.map((id, s) => [id, { p10: normalized[s].p10, p90: normalized[s].p90, flat: normalized[s].flat }]),
      ),
    });
  }
  results.sort(compareScored);
  return results;
}

function compareScored(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  if (a.issue.number !== b.issue.number) return a.issue.number - b.issue.number;
  return 0;
}

export { compareResults };
