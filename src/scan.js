// Scan orchestration: cache → fetch (budgeted) → parse → match → score →
// ranked, explainable results. All I/O is injected (fetchFn, clock, cache path).

import { ApiError, BudgetExhausted, createClient } from './github.js';
import { createCache } from './cache.js';
import { DEFAULTS, DEFAULT_WEIGHTS, SIGNAL_ORDER } from './config.js';
import { languageMatches, matchScore } from './fingerprint.js';
import { scoreRepo } from './score.js';
import { computeRawSignals, extractPaths, parseIssueList, parseTimeline } from './signals.js';
import { compareResults, round4, splitRepo } from './util.js';

const CHEAP_SIGNALS = ['match', 'scope', 'fresh', 'repro', 'foot', 'act'];

function isoOrNull(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

// Partial ranking used to choose which issues get a timeline call.
function cheapRank(items, weights) {
  let denom = 0;
  for (const id of CHEAP_SIGNALS) denom += weights[id] ?? 0;
  const scored = items.map((item) => {
    const raw = computeRawSignals(item.issue, {
      nowMs: item.nowMs,
      timeline: null,
      match: item.match ? item.match.total : 0.5,
    });
    let sum = 0;
    for (const id of CHEAP_SIGNALS) {
      const v = raw[id] === null ? 0.5 : raw[id];
      sum += (weights[id] ?? 0) * v;
    }
    return { issue: item.issue, partial: denom ? sum / denom : 0 };
  });
  scored.sort((a, b) => {
    if (b.partial !== a.partial) return b.partial - a.partial;
    return a.issue.number - b.issue.number;
  });
  return scored;
}

export async function scan(opts) {
  const {
    repos = [],
    labels = DEFAULTS.labels,
    minScore = DEFAULTS.minScore,
    limit = DEFAULTS.limit,
    shortlist = DEFAULTS.shortlist,
    budget = DEFAULTS.budget,
    refresh = false,
    offline = false,
    hours = null,
    lang = null,
    fetchFn,
    now = () => new Date(),
    cachePath = null,
    fingerprint = null,
    baseUrl = DEFAULTS.baseUrl,
    token = null,
    weights = DEFAULT_WEIGHTS,
    forceTimelines = [],
    ttl = DEFAULTS.ttl,
    warn = () => {},
  } = opts;

  const warnings = [];
  const dataErrors = [];
  const skipped = [];
  const note = (msg) => {
    warnings.push(msg);
    try {
      warn(msg);
    } catch {
      /* warnings must never break a scan */
    }
  };

  const nowDate = now();
  const nowMs = nowDate.getTime();
  const generatedAt = nowDate.toISOString();

  const api = createClient({
    fetchFn: fetchFn ?? (async () => {
      throw new Error('scan requires fetchFn (or --offline with a warm cache)');
    }),
    baseUrl,
    token,
    budget,
  });
  const cache = createCache({ path: cachePath, now, ttl });

  let budgetHit = false;
  let timelinesFetched = 0;
  let cachedRepos = 0;
  let issuesSeen = 0;

  // ---- Phase A: repo meta + issues lists ---------------------------------
  const loaded = [];
  for (let i = 0; i < repos.length; i++) {
    const repo = repos[i];
    const parts = splitRepo(repo);
    if (!parts) {
      dataErrors.push(`invalid repo "${repo}" (expected owner/name)`);
      continue;
    }
    const [owner, name] = parts;
    let entry = cache.get(repo);

    const needFetch = !offline && (refresh || !entry || !cache.isFresh(entry));
    if (offline) {
      if (!entry) {
        dataErrors.push(`offline: no cached data for ${repo}`);
        continue;
      }
      cachedRepos += 1;
    } else if (!needFetch) {
      cachedRepos += 1;
    }

    if (needFetch) {
      try {
        const meta = await api.getRepo(owner, name);
        const rawIssues = await api.listIssues(owner, name, labels);
        const keptTimelines = refresh ? {} : (entry?.timelines ?? {});
        entry = { ...(entry ?? {}), meta, issues: rawIssues, timelines: keptTimelines };
        cache.set(repo, entry);
      } catch (err) {
        if (err instanceof BudgetExhausted) {
          budgetHit = true;
          skipped.push(...repos.slice(i));
          break;
        }
        if (err instanceof ApiError) {
          if (entry) {
            // Degrade to stale cache rather than dropping the repo.
            note(`warning: ${repo}: ${err.message} — using stale cache`);
            cachedRepos += 1;
          } else {
            dataErrors.push(`${repo}: ${err.message}`);
            continue;
          }
        } else {
          dataErrors.push(`${repo}: ${err.message}`);
          continue;
        }
      }
    }

    if (!entry) continue;
    if (lang && lang.length && !languageMatches(entry.meta?.language ?? '', lang)) continue;
    const parsed = parseIssueList(entry.issues, { labels });
    issuesSeen += parsed.length;
    loaded.push({ repo, owner, name, entry, parsed, fetched: needFetch });
  }

  // ---- Phase B: timelines for shortlisted issues (cost-allocated) ---------
  const forceSet = new Set(forceTimelines.map(Number));
  for (let i = 0; i < loaded.length; i++) {
    const { repo, owner, name, entry, parsed } = loaded[i];
    const items = parsed.map((issue) => {
      const raw = computeRawSignals(issue, { nowMs, timeline: null, match: 0.5 });
      return {
        issue,
        nowMs,
        touched: raw._touched,
        paths: raw._touchedPaths,
        match: matchScore(
          {
            paths: raw._touchedPaths,
            labels: issue.labels,
            touched: raw._touched,
            repoLanguage: entry.meta?.language ?? null,
          },
          fingerprint,
        ),
      };
    });
    const ranked = cheapRank(items, weights);
    const reposLeft = loaded.length - i;
    const allowance = offline ? Number.MAX_SAFE_INTEGER : Math.floor(api.remaining / reposLeft);
    const take = Math.min(shortlist, Math.max(0, allowance));
    const shortlistNumbers = ranked.slice(0, take).map((r) => r.issue.number);
    if (take < Math.min(shortlist, ranked.length)) budgetHit = true;
    for (const n of forceSet) {
      if (parsed.some((issue) => issue.number === n) && !shortlistNumbers.includes(n)) {
        if (offline || api.remaining > 0) shortlistNumbers.push(n);
      }
    }

    const timelines = { ...(entry.timelines ?? {}) };
    for (const num of shortlistNumbers) {
      if (Object.prototype.hasOwnProperty.call(timelines, num)) continue;
      if (offline) continue;
      if (api.remaining <= 0) {
        budgetHit = true;
        break;
      }
      try {
        timelines[num] = await api.getTimeline(owner, name, num);
        timelinesFetched += 1;
      } catch (err) {
        if (err instanceof BudgetExhausted) {
          budgetHit = true;
          break;
        }
        if (err instanceof ApiError) {
          dataErrors.push(`${repo}#${num}: ${err.message}`);
        } else {
          dataErrors.push(`${repo}#${num}: ${err.message}`);
        }
      }
    }
    entry.timelines = timelines;
    cache.set(repo, entry);
  }

  cache.save();

  // ---- Phase C: full signals + scoring -----------------------------------
  const all = [];
  const breakdowns = {};
  for (const { repo, entry, parsed } of loaded) {
    const repoLanguage = entry.meta?.language ?? null;
    const items = parsed.map((issue) => {
      const raw = computeRawSignals(issue, { nowMs, timeline: null, match: 0.5 });
      const tlEvents = entry.timelines?.[issue.number];
      const timeline = Array.isArray(tlEvents) ? parseTimeline(tlEvents, issue) : null;
      return {
        issue,
        timeline,
        match: matchScore(
          {
            paths: raw._touchedPaths,
            labels: issue.labels,
            touched: raw._touched,
            repoLanguage,
          },
          fingerprint,
        ),
      };
    });
    const scored = scoreRepo(items, { nowMs, weights, fingerprint });
    for (const s of scored) {
      const issue = s.issue;
      if (hours !== null) {
        const age = nowMs - issue.updatedAt;
        if (!(age <= hours * 3_600_000)) continue;
      }
      breakdowns[`${repo}#${issue.number}`] = {
        repo,
        number: issue.number,
        score: s.score,
        raw: s.raw,
        signals: s.signals,
        contributions: s.contributions,
        weights: s.weights,
        order: s.order,
        reasons: s.reasons,
        notes: s.notes,
        normalization: s.normalization,
        matchParts: s.matchParts,
        timeline: s.timeline
          ? {
              firstResponseMs: s.timeline.firstResponseMs,
              negativeClamped: s.timeline.negativeClamped,
              humanComments: s.timeline.humanComments,
              botComments: s.timeline.botComments,
              competingPrs: s.timeline.competingPrs,
              abandonedAttempts: s.timeline.abandonedAttempts,
            }
          : null,
        bodyFeatures: {
          touched: extractPaths(issue.body).length || null,
          comments: s.raw._commentCount,
        },
      };
      if (round4(s.score) < minScore) continue;
      all.push({
        repo,
        number: issue.number,
        url: issue.url,
        title: issue.title,
        score: s.score,
        reasons: s.reasons,
        signals: s.signals,
        labels: issue.labels,
        updated_at: isoOrNull(issue.updatedAt),
        scanned_at: generatedAt,
      });
    }
  }

  all.sort(compareResults);
  const results = all.slice(0, Math.max(0, limit));

  return {
    version: 1,
    generatedAt,
    results,
    meta: {
      reposConfigured: repos.length,
      reposLoaded: loaded.length,
      reposSkipped: skipped.length,
      issuesSeen,
      timelinesFetched,
      calls: api.calls,
      budget,
      cachedRepos,
      offline,
      refresh,
      fingerprintLoaded: Boolean(fingerprint),
      labels: [...labels],
      minScore,
      limit,
      warnings,
      dataErrors,
      skipped,
      budgetHit,
      partial: dataErrors.length > 0 || budgetHit || skipped.length > 0,
    },
    breakdowns,
  };
}
