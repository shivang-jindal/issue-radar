import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_WEIGHTS, SIGNAL_ORDER } from '../src/config.js';
import { scoreRepo } from '../src/score.js';

const NOW = Date.parse('2026-10-20T12:00:00.000Z');
const DAY = 86_400_000;

const mkIssue = (over = {}) => ({
  number: 1,
  title: 'Issue',
  body: 'A body with enough characters to be in the sweet spot for scope. ' + 'x'.repeat(60),
  labels: ['good first issue'],
  comments: 3,
  author: 'alice',
  createdAt: NOW - 5 * DAY,
  updatedAt: NOW - DAY,
  url: 'https://github.com/o/r/issues/1',
  ...over,
});

const mkTimeline = (over = {}) => ({
  firstResponseMs: null,
  negativeClamped: false,
  humanComments: 0,
  botComments: 0,
  competingPrs: 0,
  abandonedAttempts: 0,
  ...over,
});

test('v0 weights sum to exactly 1 and cover every signal', () => {
  const sum = Object.values(DEFAULT_WEIGHTS).reduce((a, b) => a + b, 0);
  assert.equal(Math.round(sum * 1000) / 1000, 1);
  assert.deepEqual(Object.keys(DEFAULT_WEIGHTS).sort(), [...SIGNAL_ORDER].sort());
});

test('scoreRepo ranks a fresh, responsive issue above a dead one', () => {
  const results = scoreRepo(
    [
      {
        issue: mkIssue({ number: 1 }),
        timeline: mkTimeline({ firstResponseMs: 4 * 3_600_000, humanComments: 3 }),
        match: { total: 0.9, parts: {}, detail: 'your src work' },
      },
      {
        issue: mkIssue({ number: 2, updatedAt: NOW - 200 * DAY, comments: 0, body: 'short' }),
        timeline: mkTimeline({ competingPrs: 2, abandonedAttempts: 1 }),
        match: { total: 0.1, parts: {}, detail: null },
      },
    ],
    { nowMs: NOW },
  );
  assert.equal(results.length, 2);
  assert.equal(results[0].issue.number, 1);
  assert.ok(results[0].score > results[1].score);
  assert.ok(results[1].score < 0.6, 'dead issue should not look good');
});

test('score: weighted sum of signals equals the reported score', () => {
  const [top] = scoreRepo(
    [
      {
        issue: mkIssue(),
        timeline: mkTimeline({ firstResponseMs: 3_600_000, humanComments: 5 }),
        match: { total: 0.7, parts: {}, detail: null },
      },
    ],
    { nowMs: NOW },
  );
  let sum = 0;
  for (const id of SIGNAL_ORDER) {
    assert.ok(top.signals[id] >= 0 && top.signals[id] <= 1, `${id} in [0,1]`);
    assert.ok(Math.abs(top.contributions[id] - DEFAULT_WEIGHTS[id] * top.signals[id]) < 1e-4);
    sum += top.contributions[id];
  }
  assert.ok(Math.abs(sum - top.score) < 1e-3, `contributions ${sum} ≈ score ${top.score}`);
});

test('unknown timeline fills response signals neutrally at 0.5', () => {
  const [r] = scoreRepo([{ issue: mkIssue(), timeline: null, match: null }], { nowMs: NOW });
  assert.equal(r.raw.resp, null);
  assert.equal(r.signals.resp, 0.5);
  assert.equal(r.signals.ncomp, 0.5);
  assert.equal(r.signals.naband, 0.5);
  assert.equal(r.signals.match, 0.5, 'missing fingerprint → neutral match');
  assert.equal(r.raw.match, 0.5);
});

test('every issue gets exactly three reason strings, none about unknowns', () => {
  const results = scoreRepo(
    [
      { issue: mkIssue({ number: 1 }), timeline: mkTimeline({ firstResponseMs: 3_600_000 }), match: { total: 0.8, parts: {}, detail: 'your ts work' } },
      { issue: mkIssue({ number: 2 }), timeline: null, match: null },
    ],
    { nowMs: NOW },
  );
  for (const r of results) {
    assert.equal(r.reasons.length, 3);
    for (const reason of r.reasons) {
      assert.equal(typeof reason, 'string');
      assert.ok(reason.length > 0);
      assert.ok(!/unknown \(timeline/.test(reason), 'unknowns never become reasons');
    }
  }
  // notes exist for ALL signals regardless of knowability
  const noTl = results.find((r) => r.issue.number === 2);
  for (const id of SIGNAL_ORDER) assert.equal(typeof noTl.notes[id], 'string');
  assert.match(noTl.notes.resp, /unknown/);
});

test('reasons pick the three highest-contributing signals', () => {
  const [r] = scoreRepo(
    [
      {
        issue: mkIssue(),
        timeline: mkTimeline({ firstResponseMs: 0, humanComments: 4 }),
        match: { total: 1, parts: {}, detail: 'your src work' },
      },
    ],
    { nowMs: NOW },
  );
  const expected = SIGNAL_ORDER.slice()
    .sort((a, b) => r.contributions[b] - r.contributions[a] || SIGNAL_ORDER.indexOf(a) - SIGNAL_ORDER.indexOf(b))
    .slice(0, 3);
  assert.equal(r.reasons[0], 'matches your src work');
  assert.deepEqual(
    expected.map((id) => r.notes[id]),
    r.reasons,
  );
});

test('determinism: identical inputs produce identical scores', () => {
  const build = () =>
    scoreRepo(
      [
        { issue: mkIssue({ number: 1 }), timeline: mkTimeline({ firstResponseMs: 3_600_000, humanComments: 3, competingPrs: 1 }), match: { total: 0.66, parts: {}, detail: null } },
        { issue: mkIssue({ number: 2, updatedAt: NOW - 40 * DAY }), timeline: mkTimeline({ firstResponseMs: 90 * 3_600_000, abandonedAttempts: 2 }), match: { total: 0.42, parts: {}, detail: null } },
        { issue: mkIssue({ number: 3, comments: 0 }), timeline: null, match: { total: 0.5, parts: {}, detail: null } },
      ],
      { nowMs: NOW },
    );
  const a = build();
  const b = build();
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test('bot-only comments lower act while human activity stays healthy', () => {
  const bot = scoreRepo(
    [
      { issue: mkIssue({ number: 1, comments: 6 }), timeline: mkTimeline({ humanComments: 0, botComments: 6 }), match: null },
      { issue: mkIssue({ number: 2, comments: 6 }), timeline: mkTimeline({ humanComments: 6, botComments: 0 }), match: null },
    ],
    { nowMs: NOW },
  );
  const botItem = bot.find((r) => r.issue.number === 1);
  const humanItem = bot.find((r) => r.issue.number === 2);
  assert.equal(botItem.raw.act, 0);
  assert.equal(humanItem.raw.act, 1);
  assert.ok(botItem.score < humanItem.score);
});
