// Applied-issues log → stats (scans, applications, merges).
// Log format: JSON array of { repo, number, appliedAt, merged?, mergedAt? }.

import { existsSync, readFileSync } from 'node:fs';
import { parseTimestamp } from './util.js';

export function loadAppliedLog(file) {
  if (!file || !existsSync(file)) return { entries: [], missing: true, error: null };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    return { entries: [], missing: false, error: `invalid JSON in ${file}: ${err.message}` };
  }
  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.entries)
      ? parsed.entries
      : null;
  if (!list) {
    return { entries: [], missing: false, error: `${file} must be a JSON array of applications` };
  }
  const entries = [];
  for (const e of list) {
    if (!e || typeof e !== 'object' || !e.repo || !Number.isFinite(Number(e.number))) continue;
    entries.push({
      repo: String(e.repo),
      number: Number(e.number),
      appliedAt: parseTimestamp(e.appliedAt),
      merged: Boolean(e.merged),
      mergedAt: parseTimestamp(e.mergedAt),
    });
  }
  return { entries, missing: false, error: null };
}

function median(values) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const v = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return Math.round(v * 10) / 10;
}

export function computeStats(entries) {
  const applications = entries.length;
  const mergedEntries = entries.filter((e) => e.merged && Number.isFinite(e.appliedAt) && Number.isFinite(e.mergedAt));
  const merges = mergedEntries.length;
  const days = mergedEntries.map((e) => (e.mergedAt - e.appliedAt) / 86_400_000);

  const byRepoMap = new Map();
  for (const e of entries) {
    if (!byRepoMap.has(e.repo)) byRepoMap.set(e.repo, []);
    byRepoMap.get(e.repo).push(e);
  }
  const byRepo = [...byRepoMap.entries()]
    .map(([repo, list]) => {
      const m = list.filter((e) => e.merged && Number.isFinite(e.appliedAt) && Number.isFinite(e.mergedAt));
      return {
        repo,
        applications: list.length,
        merges: m.length,
        medianDaysToMerge: median(m.map((e) => (e.mergedAt - e.appliedAt) / 86_400_000)),
      };
    })
    .sort((a, b) => b.applications - a.applications || (a.repo < b.repo ? -1 : 1));

  return {
    applications,
    merges,
    mergeRate: applications ? Math.round((merges / applications) * 100) : 0,
    medianDaysToMerge: median(days),
    byRepo,
  };
}
