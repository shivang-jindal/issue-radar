import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  actScore,
  computeRawSignals,
  extractPaths,
  footScore,
  freshScore,
  hasSizeLabel,
  nabandScore,
  ncompScore,
  parseIssue,
  parseIssueList,
  parseTimeline,
  reproScore,
  respScore,
  scopeParts,
  scopeScore,
} from '../src/signals.js';

const load = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const NOW = Date.parse('2026-10-20T12:00:00.000Z');
const DAY = 86_400_000;

const issuesByRepo = load('issues.json');
const timelinesByRepo = load('timelines.json');

// ---- parsing -------------------------------------------------------------

test('parseIssue normalizes REST issue fields', () => {
  const issue = parseIssue(issuesByRepo['acme/widgets'][0]);
  assert.equal(issue.number, 101);
  assert.deepEqual(issue.labels, ['good first issue', 'docs']);
  assert.equal(issue.author, 'newbie-nina');
  assert.equal(issue.createdAt, Date.parse('2026-10-15T12:00:00Z'));
  assert.match(issue.url, /issues\/101$/);
});

test('parseIssueList drops pull requests and non-matching labels', () => {
  const all = parseIssueList(issuesByRepo['acme/widgets'], {
    labels: ['good first issue', 'help wanted'],
  });
  assert.ok(all.length >= 7);
  assert.ok(!all.some((i) => i.number === 107), 'PR entries must be filtered out');
  assert.ok(all.every((i) => i.labels.some((l) => ['good first issue', 'help wanted'].includes(l))));

  const strict = parseIssueList(issuesByRepo['acme/widgets'], { labels: ['nonexistent'] });
  assert.equal(strict.length, 0);
  const noFilter = parseIssueList(issuesByRepo['acme/widgets'], { labels: [] });
  assert.equal(noFilter.length, 7, '8 entries minus the one pull request');
  assert.deepEqual(parseIssueList('garbage'), []);
});

test('parseTimeline: quick maintainer response (4h), author comments are not responses', () => {
  const issue = parseIssue(issuesByRepo['acme/widgets'][0]);
  const tl = parseTimeline(timelinesByRepo['acme/widgets']['101'], issue);
  assert.equal(tl.firstResponseMs, 4 * 3_600_000);
  assert.equal(tl.negativeClamped, false);
  assert.equal(tl.humanComments, 3); // both maintainer comments + 1 author comment
  assert.equal(tl.botComments, 0);
  assert.equal(tl.competingPrs, 0);
  assert.equal(tl.abandonedAttempts, 0);
});

test('parseTimeline: issue with no comments ever has no first response', () => {
  const issue = parseIssue(issuesByRepo['acme/widgets'].find((i) => i.number === 108));
  const tl = parseTimeline(timelinesByRepo['acme/widgets']['108'], issue);
  assert.equal(tl.firstResponseMs, null);
  assert.equal(tl.humanComments, 0);
  assert.equal(tl.botComments, 0);
});

test('parseTimeline: bot-only comments never count as activity or response', () => {
  const issue = parseIssue(issuesByRepo['acme/widgets'].find((i) => i.number === 104));
  const tl = parseTimeline(timelinesByRepo['acme/widgets']['104'], issue);
  assert.equal(tl.botComments, 3);
  assert.equal(tl.humanComments, 0);
  assert.equal(tl.firstResponseMs, null, 'stale bot noise is not a maintainer response');
});

test('parseTimeline: 2 competing open PRs, merged and own PRs excluded', () => {
  const issue = parseIssue(issuesByRepo['acme/widgets'].find((i) => i.number === 102));
  const tl = parseTimeline(timelinesByRepo['acme/widgets']['102'], issue);
  assert.equal(tl.competingPrs, 2);
  assert.equal(tl.abandonedAttempts, 0);
  assert.equal(tl.firstResponseMs, 24 * 3_600_000);
});

test('parseTimeline: closed-unlinked PRs count as abandoned; merged ones do not', () => {
  const issue = parseIssue(issuesByRepo['acme/widgets'].find((i) => i.number === 103));
  const tl = parseTimeline(timelinesByRepo['acme/widgets']['103'], issue);
  assert.equal(tl.abandonedAttempts, 2); // #450 + #499; merged #410 excluded
  assert.equal(tl.competingPrs, 0);
  assert.equal(tl.firstResponseMs, 5 * 86_400_000);
});

test('parseTimeline: an open PR authored by the issue author is not "competing"', () => {
  const issue = { number: 10, author: 'alice' };
  const events = [
    {
      event: 'cross-referenced',
      created_at: '2026-10-01T00:00:00Z',
      source: {
        issue: {
          number: 99,
          state: 'open',
          user: { login: 'alice' },
          pull_request: { url: 'x' },
        },
      },
    },
  ];
  const tl = parseTimeline(events, issue);
  assert.equal(tl.competingPrs, 0);
});

test('parseTimeline: negative first-response delta is clamped and flagged', () => {
  const issue = { number: 1, author: 'alice', createdAt: Date.parse('2026-10-10T12:00:00Z') };
  const events = [
    { event: 'commented', created_at: '2026-10-10T11:00:00Z', user: { login: 'bob', type: 'User' } },
  ];
  const tl = parseTimeline(events, issue);
  assert.equal(tl.firstResponseMs, 0);
  assert.equal(tl.negativeClamped, true);
  assert.equal(respScore(tl.firstResponseMs), 1);
});

test('parseTimeline tolerates junk input', () => {
  const tl = parseTimeline(null, { number: 1, author: null });
  assert.equal(tl.firstResponseMs, null);
  assert.equal(tl.humanComments, 0);
  const tl2 = parseTimeline([{ event: 'commented', created_at: 'nope', user: null }], {
    number: 1,
    author: 'x',
  });
  assert.equal(tl2.humanComments, 1);
  assert.equal(tl2.firstResponseMs, null);
});

// ---- signal edge cases ----------------------------------------------------

test('fresh: exponential decay with a 30-day half-life, future timestamps clamp', () => {
  assert.equal(freshScore(NOW, NOW), 1);
  assert.equal(freshScore(NOW - 30 * DAY, NOW), 0.5);
  assert.equal(freshScore(NOW - 60 * DAY, NOW), 0.25);
  assert.ok(Math.abs(freshScore(NOW + 3 * DAY, NOW) - 1) < 1e-12); // clock skew
  assert.equal(freshScore(null, NOW), 0);
});

test('resp: 1 − clamp(hours / 168)', () => {
  assert.equal(respScore(null), 0, 'no response ever scores 0');
  assert.equal(respScore(0), 1);
  assert.ok(Math.abs(respScore(4 * 3_600_000) - (1 - 4 / 168)) < 1e-12);
  assert.equal(respScore(168 * 3_600_000), 0);
  assert.equal(respScore(500 * 3_600_000), 0);
});

test('ncomp: 1 − clamp(competitors / 3)', () => {
  assert.equal(ncompScore(0), 1);
  assert.equal(ncompScore(2), 1 - 2 / 3);
  assert.equal(ncompScore(3), 0);
  assert.equal(ncompScore(5), 0, '5 competing PRs clamp to 0');
});

test('naband: 1 − clamp(abandoned / 2)', () => {
  assert.equal(nabandScore(0), 1);
  assert.equal(nabandScore(1), 0.5);
  assert.equal(nabandScore(2), 0);
  assert.equal(nabandScore(4), 0);
});

test('scope: body length sweet spot + checklist + acceptance + size label', () => {
  const base = { labels: [], body: '' };
  assert.equal(scopeScore(base), 0);

  const sweet = scopeScore({ ...base, body: 'x'.repeat(80) });
  assert.equal(sweet, 0.4, '80 chars is inclusive lower bound');

  const withChecklist = scopeScore({ ...base, body: `${'x'.repeat(79)}\n- [ ] one` });
  assert.ok(withChecklist > 0.4);

  const full = scopeScore({
    labels: ['size: S'],
    body: `${'x'.repeat(200)}\nAcceptance criteria:\n- [ ] done\n- [ ] tested`,
  });
  assert.equal(full, 1);

  const tooLong = scopeScore({ labels: [], body: 'x'.repeat(1201) });
  assert.equal(tooLong, 0, '1201 chars leaves the sweet spot');

  const parts = scopeParts({ labels: ['good first issue'], body: 'Expected behavior: it works' });
  assert.deepEqual(parts, {
    lengthSweet: false,
    checklist: false,
    acceptance: true,
    sizeLabel: false,
  });
});

test('size labels: matches size/effort markers only', () => {
  assert.equal(hasSizeLabel(['size: S']), true);
  assert.equal(hasSizeLabel(['effort: low']), true);
  assert.equal(hasSizeLabel(['small']), true);
  assert.equal(hasSizeLabel(['good first issue']), false);
  assert.equal(hasSizeLabel(['difficulty: medium']), false);
});

test('repro: stack traces and repro steps score 1, vague bodies 0', () => {
  assert.equal(reproScore(''), 0);
  assert.equal(reproScore('The badge alt text is wrong.'), 0);
  assert.equal(
    reproScore('```js\nTypeError: x is not a function\n    at run (index.js:3:1)\n```'),
    1,
    'inline stack frames count',
  );
  assert.equal(reproScore('Stack trace:\n  at handler (a.ts:1:1)'), 1);
  assert.equal(reproScore('Steps to reproduce:\n1. run it'), 1);
  assert.equal(reproScore('Reproducible on main.'), 1);
  assert.equal(reproScore('1. Run the failing command'), 1, 'numbered run-step heuristic');
  assert.equal(reproScore('panic: runtime error: index out of range'), 1);
});

test('foot: estimated from body file paths, null when unknown', () => {
  assert.equal(footScore(null), null, 'no paths → unknown, not 1');
  assert.equal(footScore(0), 1);
  assert.equal(footScore(4), 0.5);
  assert.equal(footScore(8), 0);
  assert.equal(footScore(42), 0);
});

test('extractPaths: ignores URLs, dedupes, keeps real file paths', () => {
  const body = [
    'See https://github.com/acme/widgets/issues/1 and src/app/route.ts',
    'also `src/app/route.ts` (dup) and test/unit/route.test.js',
    'emails like foo@bar.com and docs/guide.md',
  ].join('\n');
  const paths = extractPaths(body);
  assert.deepEqual(paths, ['src/app/route.ts', 'test/unit/route.test.js', 'docs/guide.md']);
  assert.deepEqual(extractPaths(''), []);
  assert.deepEqual(extractPaths('no paths here at all'), []);
  assert.equal(extractPaths(Array.from({ length: 30 }, (_, i) => `f${i}/a.ts`).join('\n')).length, 20);
});

test('act: comment count in [1,12] is healthy; dead and war zones score low', () => {
  assert.equal(actScore(0), 0);
  assert.equal(actScore(1), 1);
  assert.equal(actScore(12), 1);
  assert.equal(actScore(18), 0.5);
  assert.equal(actScore(24), 0);
  assert.equal(actScore(30), 0);
  assert.equal(actScore(undefined), 0);
});

test('computeRawSignals: timeline missing → response signals are null', () => {
  const issue = parseIssue(issuesByRepo['acme/widgets'][0]);
  const raw = computeRawSignals(issue, { nowMs: NOW, timeline: null });
  assert.equal(raw.resp, null);
  assert.equal(raw.ncomp, null);
  assert.equal(raw.naband, null);
  assert.ok(raw.fresh > 0.9);
  assert.equal(raw.repro, 1);
  assert.equal(raw.match, 0.5);
  assert.equal(raw._touched, 3, 'three distinct file paths in the body');
  assert.equal(raw.foot, 1 - 3 / 8);

  const botIssue = parseIssue(issuesByRepo['acme/widgets'].find((i) => i.number === 104));
  const botTl = parseTimeline(timelinesByRepo['acme/widgets']['104'], botIssue);
  const rawBot = computeRawSignals(botIssue, { nowMs: NOW, timeline: botTl });
  assert.equal(rawBot.act, 0, 'bot-only thread is not healthy activity');
  assert.equal(rawBot.resp, 0, 'bot-only thread has no maintainer response');
});
