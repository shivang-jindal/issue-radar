import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ApiError, BudgetExhausted, createClient, resolveToken } from '../src/github.js';

function okResponse(body) {
  return { ok: true, status: 200, headers: { get: () => null }, json: async () => body };
}

test('client requests the three endpoints through the injected fetchFn', async () => {
  const seen = [];
  const fetchFn = async (url, init) => {
    seen.push({ url, init });
    return okResponse({ path: url });
  };
  const api = createClient({ fetchFn, baseUrl: 'https://api.example.test', token: 'tkn', budget: 10 });

  await api.getRepo('o', 'r');
  await api.listIssues('o', 'r', ['good first issue', 'help wanted']);
  await api.getTimeline('o', 'r', 7);

  assert.equal(seen.length, 3);
  assert.equal(seen[0].url, 'https://api.example.test/repos/o/r');
  assert.match(seen[1].url, /\/repos\/o\/r\/issues\?/);
  assert.match(seen[1].url, /labels=good\+first\+issue%2Chelp\+wanted/);
  assert.match(seen[2].url, /\/repos\/o\/r\/issues\/7\/timeline/);
  assert.equal(seen[0].init.headers.authorization, 'Bearer tkn');
  assert.equal(seen[0].init.headers.accept, 'application/vnd.github+json');
  assert.equal(api.calls, 3);
  assert.equal(api.remaining, 7);
});

test('no Authorization header when token is null (anonymous)', async () => {
  let init;
  const api = createClient({
    fetchFn: async (url, i) => {
      init = i;
      return okResponse({});
    },
  });
  await api.getRepo('o', 'r');
  assert.equal(init.headers.authorization, undefined);
});

test('budget stops gracefully with BudgetExhausted and never over-fetches', async () => {
  let calls = 0;
  const api = createClient({
    fetchFn: async () => {
      calls += 1;
      return okResponse({});
    },
    budget: 3,
  });
  await api.getRepo('o', 'r');
  await api.getRepo('o', 'r');
  await api.getRepo('o', 'r');
  await assert.rejects(() => api.getRepo('o', 'r'), (err) => {
    assert.ok(err instanceof BudgetExhausted);
    assert.match(err.message, /budget of 3/);
    return true;
  });
  assert.equal(calls, 3);
  assert.equal(api.calls, 3);
  assert.equal(api.remaining, 0);
});

test('non-2xx responses become ApiError with status', async () => {
  const api = createClient({
    fetchFn: async () => ({ ok: false, status: 403, headers: { get: () => null }, json: async () => ({}) }),
  });
  await assert.rejects(() => api.getRepo('o', 'r'), (err) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.status, 403);
    assert.match(err.message, /rate limited/);
    return true;
  });
  // the failed call still consumed budget
  assert.equal(api.calls, 1);
});

test('network failures and bad JSON become ApiError', async () => {
  const thrower = createClient({
    fetchFn: async () => {
      throw new Error('ECONNRESET');
    },
  });
  await assert.rejects(() => thrower.getRepo('o', 'r'), (err) => {
    assert.ok(err instanceof ApiError);
    assert.match(err.message, /network error/);
    return true;
  });

  const badJson = createClient({
    fetchFn: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => {
        throw new SyntaxError('bad');
      },
    }),
  });
  await assert.rejects(() => badJson.getRepo('o', 'r'), (err) => {
    assert.ok(err instanceof ApiError);
    assert.match(err.message, /invalid JSON/);
    return true;
  });
});

test('resolveToken prefers env over gh', () => {
  const warnings = [];
  const { token, source } = resolveToken({
    env: { GITHUB_TOKEN: 'from-env' },
    runGh: () => 'from-gh',
    warn: (m) => warnings.push(m),
  });
  assert.equal(token, 'from-env');
  assert.equal(source, 'env');
  assert.equal(warnings.length, 0);
});

test('resolveToken falls back to `gh auth token`', () => {
  const { token, source } = resolveToken({
    env: {},
    runGh: () => 'gh-token\n',
    warn: () => {
      throw new Error('should not warn');
    },
  });
  assert.equal(token, 'gh-token');
  assert.equal(source, 'gh');
});

test('resolveToken degrades to anonymous with a warning', () => {
  const warnings = [];
  const { token, source } = resolveToken({
    env: {},
    runGh: () => {
      throw new Error('gh not installed');
    },
    warn: (m) => warnings.push(m),
  });
  assert.equal(token, null);
  assert.equal(source, 'anonymous');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /anonymous/);
  assert.match(warnings[0], /60 requests\/hour/);
});
