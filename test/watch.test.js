// radar watch — state-file polling that prints only new/updated issues.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.js';

const CLOCK = '2026-10-20T12:00:00.000Z';
const REPO = 'acme/widgets';

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'radar-watch-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function issue(number, updatedAt) {
  return {
    number,
    title: `Fix widget ${number}`,
    state: 'open',
    user: { login: 'newbie-nina', type: 'User' },
    labels: [{ name: 'good first issue' }],
    comments: 2,
    created_at: '2026-10-01T00:00:00Z',
    updated_at: updatedAt,
    html_url: `https://github.com/${REPO}/issues/${number}`,
    body: 'Widget is broken.\n\nSteps to reproduce:\n1. Use the widget\n\nSuspect `src/core/engine.js`.',
  };
}

function fixtureFile(dir, name, issues) {
  const file = join(dir, name);
  writeFileSync(
    file,
    JSON.stringify({
      clock: CLOCK,
      repos: { [REPO]: { meta: { language: 'javascript' }, issues, timelines: {} } },
    }),
    'utf8',
  );
  return file;
}

function io(cwd) {
  const out = { stdout: '', stderr: '' };
  return {
    out,
    ctx: {
      cwd,
      out: (s) => {
        out.stdout += s;
      },
      err: (s) => {
        out.stderr += s;
      },
      now: () => new Date(CLOCK), // injected clock keeps "now" deterministic
    },
  };
}

function watchArgs(fixture, stateFile, extra = []) {
  return ['watch', REPO, '--fixture', fixture, '--state', stateFile, '--iterations', '1', '--min-score', '0', ...extra];
}

test('watch iteration 1 prints every match and writes {number: updatedAt} state', async (t) => {
  const dir = scratch(t);
  const fixture = fixtureFile(dir, 'a.json', [
    issue(3, '2026-10-10T09:00:00Z'),
    issue(5, '2026-10-12T10:00:00Z'),
  ]);
  const stateFile = join(dir, 'state.json');
  const env = io(dir);

  const code = await main(watchArgs(fixture, stateFile), env.ctx);
  assert.equal(code, 0, env.out.stderr);
  assert.match(env.out.stdout, /acme\/widgets#3/);
  assert.match(env.out.stdout, /acme\/widgets#5/);

  const state = JSON.parse(readFileSync(stateFile, 'utf8'));
  assert.deepEqual(state, {
    '3': '2026-10-10T09:00:00.000Z',
    '5': '2026-10-12T10:00:00.000Z',
  });
});

test('replay: iteration 2 prints only new issue #7; identical replay says no new issues', async (t) => {
  const dir = scratch(t);
  const fixtureA = fixtureFile(dir, 'a.json', [
    issue(3, '2026-10-10T09:00:00Z'),
    issue(5, '2026-10-12T10:00:00Z'),
  ]);
  const fixtureB = fixtureFile(dir, 'b.json', [
    issue(3, '2026-10-10T09:00:00Z'),
    issue(5, '2026-10-12T10:00:00Z'),
    issue(7, '2026-10-19T11:00:00Z'), // new issue with a newer updatedAt
  ]);
  const stateFile = join(dir, 'state.json');

  const first = io(dir);
  assert.equal(await main(watchArgs(fixtureA, stateFile), first.ctx), 0, first.out.stderr);

  const second = io(dir);
  assert.equal(await main(watchArgs(fixtureB, stateFile), second.ctx), 0, second.out.stderr);
  assert.match(second.out.stdout, /acme\/widgets#7/);
  assert.doesNotMatch(second.out.stdout, /acme\/widgets#3/);
  assert.doesNotMatch(second.out.stdout, /acme\/widgets#5/);
  assert.deepEqual(JSON.parse(readFileSync(stateFile, 'utf8')), {
    '3': '2026-10-10T09:00:00.000Z',
    '5': '2026-10-12T10:00:00.000Z',
    '7': '2026-10-19T11:00:00.000Z',
  });

  const third = io(dir);
  assert.equal(await main(watchArgs(fixtureB, stateFile), third.ctx), 0, third.out.stderr);
  assert.equal(third.out.stdout, 'no new issues\n');
});

test('--iterations 2 in one invocation: first pass prints all, second pass finds nothing new', async (t) => {
  const dir = scratch(t);
  const fixture = fixtureFile(dir, 'a.json', [
    issue(3, '2026-10-10T09:00:00Z'),
    issue(5, '2026-10-12T10:00:00Z'),
  ]);
  const stateFile = join(dir, 'state.json');
  const env = io(dir);

  const args = [
    'watch',
    REPO,
    '--fixture',
    fixture,
    '--state',
    stateFile,
    '--iterations',
    '2',
    '--min-score',
    '0',
  ];
  const code = await main(args, env.ctx);
  assert.equal(code, 0, env.out.stderr);
  assert.match(env.out.stdout, /acme\/widgets#3/);
  assert.match(env.out.stdout, /acme\/widgets#5/);
  assert.ok(env.out.stdout.includes('no new issues'), 'second pass reports nothing new');
  assert.deepEqual(JSON.parse(readFileSync(stateFile, 'utf8')), {
    '3': '2026-10-10T09:00:00.000Z',
    '5': '2026-10-12T10:00:00.000Z',
  });
});

test('corrupt state file exits 3 with an honest stderr error', async (t) => {
  const dir = scratch(t);
  const fixture = fixtureFile(dir, 'a.json', [issue(3, '2026-10-10T09:00:00Z')]);
  const stateFile = join(dir, 'state.json');
  writeFileSync(stateFile, '{ not json', 'utf8');

  const env = io(dir);
  const code = await main(watchArgs(fixture, stateFile), env.ctx);
  assert.equal(code, 3);
  assert.equal(env.out.stdout, '');
  assert.match(env.out.stderr, /corrupt state file/);

  // A well-formed JSON file of the wrong shape is also corrupt, never a reset.
  writeFileSync(stateFile, '[1, 2, 3]', 'utf8');
  const env2 = io(dir);
  assert.equal(await main(watchArgs(fixture, stateFile), env2.ctx), 3);
  assert.match(env2.out.stderr, /corrupt state file/);
});

test('watch requires --state and --iterations (usage exit 2)', async (t) => {
  const dir = scratch(t);
  const fixture = fixtureFile(dir, 'a.json', [issue(3, '2026-10-10T09:00:00Z')]);

  const missingState = io(dir);
  const codeA = await main(
    ['watch', REPO, '--fixture', fixture, '--iterations', '1'],
    missingState.ctx,
  );
  assert.equal(codeA, 2);
  assert.match(missingState.out.stderr, /--state/);

  const missingIterations = io(dir);
  const codeB = await main(
    ['watch', REPO, '--fixture', fixture, '--state', join(dir, 's.json')],
    missingIterations.ctx,
  );
  assert.equal(codeB, 2);
  assert.match(missingIterations.out.stderr, /--iterations/);

  const negative = io(dir);
  const codeC = await main(
    ['watch', REPO, '--fixture', fixture, '--state', join(dir, 's.json'), '--iterations', '-1'],
    negative.ctx,
  );
  assert.equal(codeC, 2);
  assert.match(negative.out.stderr, /--iterations must be >= 0/);
});
