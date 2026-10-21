// Renderers: pretty table, markdown, frozen v1 JSON contract, `why`, `stats`,
// `fingerprint`. Pure string building — no ANSI codes (Windows-safe), no I/O.

import { SIGNAL_ORDER } from './config.js';
import { fmtDuration, plural } from './util.js';

export function renderJson(scanResult) {
  return `${JSON.stringify(
    {
      version: 1,
      generatedAt: scanResult.generatedAt,
      results: scanResult.results,
    },
    null,
    2,
  )}\n`;
}

function trunc(text, max) {
  const s = String(text ?? '');
  return s.length <= max ? s : `${s.slice(0, Math.max(1, max - 1))}…`;
}

function ageText(iso, generatedAt) {
  if (!iso) return 'unknown age';
  const ms = Date.parse(generatedAt) - Date.parse(iso);
  if (!Number.isFinite(ms)) return 'unknown age';
  if (ms < 3_600_000) return 'updated just now';
  return `updated ${fmtDuration(ms)} ago`;
}

export function renderTable(scanResult, { nowMs = null } = {}) {
  const { results, generatedAt, meta } = scanResult;
  const lines = [];
  const summary = `scanned ${generatedAt} · ${results.length} of ${meta.issuesSeen} issues from ${meta.reposLoaded}/${meta.reposConfigured} repos · ${meta.calls}/${meta.budget} API calls`;
  lines.push(`issue-radar — issues you can actually merge`);
  lines.push(summary);
  lines.push('');
  if (!results.length) {
    lines.push('  no matches (try lowering --min-score or widening --label).');
    return `${lines.join('\n')}\n`;
  }
  results.forEach((r, i) => {
    const rank = String(i + 1).padStart(2, ' ');
    lines.push(
      `${rank}. ★${r.score.toFixed(2)}  ${r.repo}#${r.number} — ${trunc(r.title, 64)}`,
    );
    lines.push(`      why:  ${r.reasons.join(' · ')}`);
    lines.push(
      `      meta: labels: ${r.labels.join(', ') || '(none)'} · ${ageText(r.updated_at, generatedAt)} · scanned just now`,
    );
    lines.push(`      url:  ${r.url}`);
  });
  if (meta.partial) {
    lines.push('');
    lines.push(partialSummary(meta));
  }
  return `${lines.join('\n')}\n`;
}

function partialSummary(meta) {
  const bits = [];
  if (meta.budgetHit) bits.push(`budget hit at ${meta.calls}/${meta.budget} calls (partial)`);
  if (meta.reposSkipped) bits.push(`${meta.reposSkipped} ${plural(meta.reposSkipped, 'repo')} skipped`);
  if (meta.dataErrors.length) bits.push(`${meta.dataErrors.length} API ${plural(meta.dataErrors.length, 'error')}`);
  return `  partial results: ${bits.join(' · ')}`;
}

export function renderMd(scanResult) {
  const { results, generatedAt } = scanResult;
  const lines = [
    `> issue-radar · scanned ${generatedAt}`,
    '',
    `| # | score | issue | reasons |`,
    `|---|-------|-------|---------|`,
  ];
  results.forEach((r, i) => {
    const title = String(r.title).replace(/\|/g, '\\|');
    lines.push(
      `| ${i + 1} | ${r.score.toFixed(2)} | [${r.repo}#${r.number}](${r.url}) — ${trunc(title, 60)} | ${r.reasons.join(' · ')} |`,
    );
  });
  if (!results.length) lines.push(`| — | — | no matches | — |`);
  return `${lines.join('\n')}\n`;
}

function fmtNum(x, digits = 3) {
  if (x === null || x === undefined) return '—';
  if (Number.isInteger(x)) return String(x);
  return x.toFixed(digits);
}

export function renderWhy(breakdown, { repo, number }) {
  const lines = [];
  const title = breakdown.title ?? '';
  lines.push(`why ${repo}#${number}${title ? ` — "${title}"` : ''}`);
  lines.push(`score ${breakdown.score.toFixed(4)} · v0 weights · per-repo p10/p90 normalization`);
  lines.push('');
  const head = ['SIGNAL', 'RAW', 'SCALED', 'WEIGHT', 'CONTRIB', 'NOTE'];
  const rows = SIGNAL_ORDER.map((id) => [
    id,
    fmtNum(breakdown.raw[id]),
    fmtNum(breakdown.signals[id]),
    fmtNum(breakdown.weights[id], 2),
    fmtNum(breakdown.contributions[id]),
    breakdown.notes[id] ?? '',
  ]);
  const widths = head.map((h, c) => Math.max(h.length, ...rows.map((r) => String(r[c]).length)));
  const line = (cells) =>
    cells.map((c, i) => String(c).padEnd(widths[i])).join('  ').trimEnd();
  lines.push(`  ${line(head)}`);
  lines.push(`  ${line(widths.map((w) => '-'.repeat(w)))}`);
  for (const row of rows) lines.push(`  ${line(row)}`);
  lines.push('');
  lines.push(`  total: ${breakdown.score.toFixed(4)} = Σ weight × scaled`);
  lines.push('  reasons:');
  for (const r of breakdown.reasons) lines.push(`    · ${r}`);
  if (breakdown.timeline) {
    const t = breakdown.timeline;
    lines.push(
      `  timeline: ${t.humanComments} human / ${t.botComments} bot comments · ` +
        `${t.competingPrs} competing PRs · ${t.abandonedAttempts} abandoned attempts`,
    );
    if (t.negativeClamped) {
      lines.push('  ⚠ first-response timestamp was negative (clock skew) — clamped to 0');
    }
  } else {
    lines.push('  timeline: not fetched (response/competition signals neutral)');
  }
  return `${lines.join('\n')}\n`;
}

export function renderWhyJson(breakdown, { repo, number, scannedAt }) {
  return `${JSON.stringify(
    {
      version: 1,
      repo,
      number,
      score: breakdown.score,
      reasons: breakdown.reasons,
      signals: breakdown.signals,
      raw: Object.fromEntries(
        SIGNAL_ORDER.map((id) => [id, breakdown.raw[id]]),
      ),
      contributions: breakdown.contributions,
      weights: breakdown.weights,
      notes: breakdown.notes,
      scannedAt: scannedAt ?? null,
    },
    null,
    2,
  )}\n`;
}

function pct(v) {
  return `${(v * 100).toFixed(1)}%`;
}

export function renderFingerprint(fp, { savedTo = null } = {}) {
  const lines = [];
  lines.push(`fingerprint of ${fp.root}`);
  const langs = Object.entries(fp.languages)
    .slice(0, 8)
    .map(([k, v]) => `${k} ${pct(v)}`);
  const clusters = Object.entries(fp.clusters)
    .slice(0, 8)
    .map(([k, v]) => `${k} ${pct(v)}`);
  lines.push(`  languages: ${langs.length ? langs.join(' · ') : '(no known extensions)'}`);
  lines.push(`  clusters:  ${clusters.length ? clusters.join(' · ') : '(no subdirectories)'}`);
  lines.push(
    `  typical:   ${fp.typical.fileCount} files · median file ${fp.typical.medianFileBytes} B · ` +
      `typical change ~${fp.typical.footprintFiles} ${plural(fp.typical.footprintFiles, 'file')}`,
  );
  if (savedTo) lines.push(`  saved to:  ${savedTo}`);
  return `${lines.join('\n')}\n`;
}

export function renderStats(stats, { format = 'table', path = '' } = {}) {
  if (format === 'json') {
    return `${JSON.stringify(stats, null, 2)}\n`;
  }
  const lines = [];
  lines.push(`applied-issues log${path ? ` (${path})` : ''}`);
  lines.push(
    `  applications: ${stats.applications} · merged: ${stats.merges} · merge rate: ${stats.mergeRate}%`,
  );
  lines.push(
    `  median days to merge: ${stats.medianDaysToMerge === null ? 'n/a' : stats.medianDaysToMerge}`,
  );
  if (!stats.applications) {
    lines.push('  (log is empty — record applications to build your feedback loop)');
    return `${lines.join('\n')}\n`;
  }
  lines.push('');
  const head = ['REPO', 'APPLIED', 'MERGED', 'MEDIAN DAYS'];
  const rows = stats.byRepo.map((r) => [
    r.repo,
    String(r.applications),
    String(r.merges),
    r.medianDaysToMerge === null ? '—' : String(r.medianDaysToMerge),
  ]);
  const widths = head.map((h, c) => Math.max(h.length, ...rows.map((r) => r[c].length)));
  const line = (cells) => cells.map((c, i) => String(c).padEnd(widths[i])).join('  ').trimEnd();
  lines.push(`  ${line(head)}`);
  lines.push(`  ${line(widths.map((w) => '-'.repeat(w)))}`);
  for (const row of rows) lines.push(`  ${line(row)}`);
  return `${lines.join('\n')}\n`;
}
