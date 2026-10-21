# issue-radar — technical specification

> Companion to [`README.md`](./README.md). Build document: data model, ingestion,
> signal definitions, scoring (v0 linear + v2 ML), fingerprinting, CLI/App
> surface, rate-limit strategy, and tests.

---

## 1. Design invariants

1. **Explainable by default.** Every score ships with the top contributing
   signals and a one-line reason string. An unexplainable recommendation is a
   bug.
2. **Local-first.** The personal fingerprint never leaves the machine unless
   the user explicitly opts into anonymized outcome sharing.
3. **Cheap on the API.** Aggressive caching + cursor-based incremental sync.
   A scan must not blow a user's GraphQL budget.
4. **Honest about staleness.** Every recommendation shows data-freshness
   ("scanned 4m ago"). Stale data presented as fresh is how trust dies.
5. **Outcomes over activity.** The model learns from *merged PRs*, not comment
   volume. Bots and noise are filtered at ingestion.

## 2. CLI surface

```
radar scan [repo…]              scan configured or explicit repos
  --lang <list>                 language filter
  --label <list>                default: "good first issue","help wanted"
  --hours <n>                   issues active/updated within window
  --min-score <f>               threshold (default 0.4)
  --limit <n>                   default 20
  --json / --format table|json|md
  --refresh                     force re-sync (ignore cache TTL)

radar why <repo#n>              full signal breakdown for one issue
radar apply <repo#n>            clone/fetch + branch + link; prints next steps
radar fingerprint               show what we know about you
  --rebuild                     recompute from local git + GitHub history
  --export / --import <file>    share across machines (never auto-uploaded)
radar watch                     background daemon; notify on new matches
  --notify terminal|slack|email|webhook
radar digest                    build the weekly digest for a language/org
radar stats                     your history: scans, applications, merges
radar config                    repos, labels, exclusions, TTLs
radar init                      write ~/.config/radar/config.toml + cron hint
```

Exit codes: `0` ok · `1` no matches (useful in scripts) · `2` usage · `3` API
error (partial results printed).

## 3. Storage

Local SQLite (`~/.local/share/radar/radar.db`), WAL mode. Core schema:

```sql
CREATE TABLE repos (
  id INTEGER PRIMARY KEY, full_name TEXT UNIQUE NOT NULL,
  default_branch TEXT, lang TEXT, last_synced_at INTEGER, sync_cursor TEXT
);

CREATE TABLE issues (
  id INTEGER PRIMARY KEY, repo_id INTEGER NOT NULL REFERENCES repos(id),
  number INTEGER NOT NULL, title TEXT NOT NULL, state TEXT NOT NULL,
  author TEXT, created_at INTEGER, updated_at INTEGER,
  labels TEXT,               -- JSON array
  comments INTEGER, body TEXT,
  first_response_ms INTEGER, -- NULL = none yet
  competing_prs INTEGER DEFAULT 0, abandoned_attempts INTEGER DEFAULT 0,
  has_repro INTEGER, has_checklist INTEGER, has_acceptance INTEGER,
  touched_files INTEGER,     -- est. footprint
  score REAL, score_reasons TEXT,  -- JSON: signal → value → contribution
  scored_at INTEGER,
  UNIQUE(repo_id, number)
);
CREATE INDEX idx_issues_score ON issues(score DESC);

CREATE TABLE prs (
  id INTEGER PRIMARY KEY, repo_id INTEGER, number INTEGER,
  author TEXT, merged INTEGER, merged_at INTEGER, additions INTEGER,
  deletions INTEGER, files TEXT, issue_ids TEXT      -- JSON links
);

CREATE TABLE outcomes (                -- the learning signal
  id INTEGER PRIMARY KEY, issue_id INTEGER, user_key TEXT,
  applied_at INTEGER, merged INTEGER, merged_at INTEGER, days_to_merge INTEGER
);

CREATE TABLE sync_log (repo_id INTEGER, kind TEXT, at INTEGER, cost INTEGER);
```

`user_key` is a local opaque hash. Opt-in contribution uploads only ever send
`(issue_id, merged, days_to_merge)` — never fingerprint data.

## 4. Ingestion

**GraphQL (v4) queries**, cost-budgeted per repo:

- issues: `labels, updatedAt, createdAt, comments(first: 5)` (first-comment
  author/timestamp gives first response), `timelineItems` cross-referenced PRs
- PRs: `linkedIssues`, `closingIssuesReferences`, state/merged, files (first 100)
- repo: default branch, primary language, `CONTRIBUTING`, stale-bot config
  (`.github/stale.yml`, workflows referencing `actions/stale`)

Strategy:
- **Cursor pagination** with `updatedAt > cursor` for incremental sync.
- **Cost ledger** per scan: query costs recorded in `sync_log`; scan aborts the
  repo list gracefully when the budget is exhausted (reports what's left).
- **TTLs:** issues 15 min (active repos), 6 h (idle), 24 h (dormant > 30 days).
  `--refresh` bypasses.
- **Webhook mode** (App tier): GitHub App receives `issues`/`pull_request`
  events and updates the store in near-real-time for installed repos.
- **Auth:** `gh` CLI token if present, else `GITHUB_TOKEN`, else anonymous
  (heavily rate-limited, warn loudly).

## 5. Signal definitions (v0)

All signals normalize to [0,1] per repo (robust scaling using p10/p90 to resist
outliers), then combine linearly. Weights are config-overridable and printed by
`radar why`.

| ID | Signal | Definition |
|----|--------|------------|
| `fresh` | freshness | exp-decay on `updated_at`, half-life 30 days |
| `resp` | maintainer responsiveness | 1 − clamp(median first-response hours / 168) |
| `ncomp` | no competition | 1 − clamp(competing open PRs / 3) |
| `naband` | no abandoned attempts | 1 − clamp(abandoned / 2) |
| `scope` | scope clarity | checklist + acceptance criteria + labeled size + body length sweet spot (80–1200 chars) |
| `repro` | has repro | issue body contains runnable repro/stack trace |
| `foot` | small footprint | 1 − clamp(est. touched files / 8) |
| `act` | healthy activity | comment count in [1, 12] — dead issues and war zones both score low |
| `match` | fingerprint match | see §6 |
| `novel` | novelty | penalize issues that already have a linked *unmerged* PR from someone else |

v0 default weights:

```
score = .18·match + .14·resp + .12·ncomp + .12·naband
      + .12·scope + .10·fresh + .08·repro + .08·foot + .06·act
```

`radar why` prints each term, its raw value, and its contribution, plus a
generated reason string from the top three:

> "answers in ~4h · 0 competing PRs · matches your app-router work (14 commits)"

## 6. Fingerprinting

Computed locally from:

1. **Local git history** (default: current repo; `--all` for all local repos):
   languages by committed bytes, path clusters (subsystem affinity), file-type
   affinity, typical PR size, commit hygiene.
2. **GitHub merged PRs** (if authed): repos, labels touched, review
   interactions, time-to-merge.
3. **Configured interests:** languages, path globs, topics, excluded repos.

`match` = weighted Jaccard between issue feature vector
(`repo, labels, area paths, language, est. footprint`) and fingerprint:

```
match = 0.4·subsystem_affinity + 0.3·language_affinity
      + 0.2·label_affinity + 0.1·size_comfort
```

`size_comfort` = how the estimated footprint compares to the user's historical
merged PR sizes (a 40-file issue scores low for someone whose median PR is 3
files). This single signal eliminates most doomed contributions.

## 7. v2 model

- **Task:** binary classification — *will a first-time contributor's PR on this
  issue merge within 90 days?*
- **Labels:** the `outcomes` table (from opt-in contributions + public
  issue→PR linkage heuristics across the fleet).
- **Model:** gradient-boosted trees (LightGBM) over the v0 signals + raw
  features (repo activity, maintainer bus factor, label churn, day-of-week).
  Log-linear baseline kept for comparison; the model ships only if it beats
  baseline by ≥5 points AUC on held-out repos.
- **Calibration:** Platt scaling so 0.87 means what it says.
- **Explainability preserved:** SHAP values feed the same `why` renderer.
- **Anti-gaming:** train/evaluate split by *repo*, not by issue — otherwise
  the model memorizes per-repo priors and generalizes badly.
- **Privacy:** only opt-in, only outcome tuples, aggregated at ≥ 50 samples
  per repo before upload.

## 8. App & integrations

- **GitHub App** (`radar-app`): installed per repo; comment on newly labeled
  `good first issue` explaining why it's newcomer-friendly (or nudging the
  maintainer when it *isn't* — e.g., no response in 30 days).
- **VS Code extension:** side panel listing `radar scan` results for the open
  repo; `radar apply` creates the branch in-editor.
- **Digest:** markdown email/Slack message, top 5 per language, each with a
  one-line reason. Generated by `radar digest --lang ts --format md`.
- **firstday integration:** `radar scan --json` is a stable contract (see §9).

## 9. JSON contract (v1 frozen)

```jsonc
{
  "version": 1,
  "generatedAt": "2026-10-20T12:00:00Z",
  "results": [
    {
      "repo": "vercel/next.js",
      "number": 61234,
      "url": "https://github.com/vercel/next.js/issues/61234",
      "title": "…",
      "score": 0.87,
      "reasons": ["maintainer answers in ~4h", "0 competing PRs", "matches app router"],
      "signals": { "match": 0.91, "resp": 0.95, "ncomp": 1.0 },
      "labels": ["good first issue", "docs"],
      "updated_at": "…",
      "scanned_at": "…"
    }
  ]
}
```

`firstday` and third parties consume this. Breaking changes require a version
bump and a 6-month deprecation window.

## 10. Rate limits & caching

- Per-repo cost budget (default 2,000 GraphQL points/scan; configurable).
- Respect `rateLimit { remaining, resetAt }` inline fragments; proactive pause
  at 10% remaining.
- Parallelism capped at 3 repos (authenticated) to avoid secondary limits.
- Local cache with per-repo TTLs; `--refresh` forces.
- Offline mode: `radar scan --offline` works purely from cache (useful in CI
  and on planes); every result labeled with staleness.

## 11. Ethics & privacy

- Fingerprint stored locally; `--export` is explicit and manual.
- Opt-in fleet learning sends outcome tuples only, aggregated.
- No scraping of private data; only API-visible public info.
- Reason strings must never be insulting ("bad issue" → "low maintainer
  activity — consider pinging or picking another"). Tone is a product decision.
- Maintainer metrics are reported to the maintainer, never publicly shamed by
  default.

## 12. Test strategy

1. **Recorded GraphQL fixtures.** VCR-style: real query responses committed as
   JSON; the client is tested against them. No live network in unit/CI tests.
2. **Signal unit tests.** Each signal has hand-built edge cases (no comments
   ever, bot-only comments, stale bot present, 5 competing PRs…).
3. **Scoring snapshots.** `radar why` output snapshot-tested; weight changes
   must update snapshots consciously.
4. **Deterministic clock.** All time-based signals take an injected clock.
5. **Model eval harness.** Script that splits by repo, trains, reports
   AUC/calibration; runs in CI as a regression gate on a committed dataset.
6. **E2E (manual, pre-release):** scan 50 real repos, assert no API errors and
   plausible top-10 lists — reviewed by a human before each minor release.

## 13. Performance budgets

| Scenario | Budget |
|----------|--------|
| Warm scan, 50 repos | < 15 s |
| Cold scan, 50 repos | bounded by API, ~3–6 min |
| `radar why` | < 200 ms (cache) |
| DB size after 10k issues | < 60 MB |
| Fingerprint rebuild, 5 repos | < 5 s |

## 14. Failure modes

| Failure | Behavior |
|---------|----------|
| Rate limited mid-scan | finish current repo, report partial + resume cursor |
| Repo renamed/archived | mark, skip, notify once |
| Issue transferred | follow `transfer` timeline item or re-key by ID |
| No auth | warn, scan public only, lower parallelism |
| Clock skew / bad timestamps | clamp negatives, flag in `why` |
| Label removed post-scan | `--refresh` on next run; score invalidated |

## 15. v1 → v2 cut line

v1: 30 curated repos, v0 scoring, fingerprint, `why`/`apply`/`watch`, JSON
contract frozen, digest, App comments.

v2: outcome-sharing opt-in, trained model + calibration, VS Code extension,
maintainer dashboard, org fleet mode.
