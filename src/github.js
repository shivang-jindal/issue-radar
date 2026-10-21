// Minimal GitHub REST client. Everything is injected: fetchFn, budget.
// No global fetch is ever called by this module directly.

import { spawnSync } from 'node:child_process';

export class ApiError extends Error {
  constructor(message, { status = 0, url = '', cause } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.url = url;
    this.isApiError = true;
    if (cause) this.cause = cause;
  }
}

export class BudgetExhausted extends Error {
  constructor(budget) {
    super(`API budget of ${budget} calls exhausted — stopping gracefully with partial results`);
    this.name = 'BudgetExhausted';
    this.budget = budget;
    this.isBudget = true;
  }
}

const USER_AGENT = 'issue-radar/0.1.0';

export function createClient({
  fetchFn,
  baseUrl = 'https://api.github.com',
  token = null,
  budget = 60,
} = {}) {
  if (typeof fetchFn !== 'function') {
    throw new TypeError('createClient requires an injected fetchFn');
  }
  let calls = 0;
  const root = String(baseUrl).replace(/\/+$/, '');

  async function request(path) {
    if (calls >= budget) throw new BudgetExhausted(budget);
    calls += 1;
    const url = path.startsWith('http') ? path : `${root}${path}`;
    const headers = {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': USER_AGENT,
    };
    if (token) headers.authorization = `Bearer ${token}`;
    let res;
    try {
      res = await fetchFn(url, { headers });
    } catch (err) {
      throw new ApiError(`network error requesting ${path}: ${err.message}`, { url, cause: err });
    }
    if (!res || !res.ok) {
      const status = res ? res.status : 0;
      const rate = status === 403 || status === 429;
      throw new ApiError(
        rate
          ? `rate limited (HTTP ${status}) on ${path}`
          : `HTTP ${status} on ${path}`,
        { status, url },
      );
    }
    try {
      return await res.json();
    } catch (err) {
      throw new ApiError(`invalid JSON from ${path}`, { status: res.status, url, cause: err });
    }
  }

  return {
    get calls() {
      return calls;
    },
    get budget() {
      return budget;
    },
    get remaining() {
      return Math.max(0, budget - calls);
    },
    request,
    getRepo(owner, repo) {
      return request(`/repos/${owner}/${repo}`);
    },
    listIssues(owner, repo, labels) {
      const q = new URLSearchParams({ state: 'open', per_page: '100' });
      if (labels && labels.length) q.set('labels', labels.join(','));
      return request(`/repos/${owner}/${repo}/issues?${q}`);
    },
    getTimeline(owner, repo, number) {
      return request(`/repos/${owner}/${repo}/issues/${number}/timeline?per_page=100`);
    },
  };
}

function defaultRunGh() {
  const res = spawnSync('gh', ['auth', 'token'], {
    encoding: 'utf8',
    timeout: 3000,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (res && res.status === 0 && res.stdout && res.stdout.trim()) {
    return res.stdout.trim();
  }
  return null;
}

// Token order: GITHUB_TOKEN / GH_TOKEN env → `gh auth token` → anonymous (warn).
export function resolveToken({ env = process.env, runGh = defaultRunGh, warn = () => {} } = {}) {
  const fromEnv = env.GITHUB_TOKEN || env.GH_TOKEN;
  if (fromEnv && String(fromEnv).trim()) {
    return { token: String(fromEnv).trim(), source: 'env' };
  }
  try {
    const fromGh = runGh();
    if (fromGh && String(fromGh).trim()) {
      return { token: String(fromGh).trim(), source: 'gh' };
    }
  } catch {
    // gh missing or not logged in — fall through to anonymous.
  }
  warn(
    'warning: no GitHub token found (set GITHUB_TOKEN or run `gh auth token`); ' +
      'scanning anonymously with a 60 requests/hour limit',
  );
  return { token: null, source: 'anonymous' };
}
