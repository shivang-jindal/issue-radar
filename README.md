# issue-radar — find the issue you'll actually merge

> **Issue discovery ranked by how likely *you* are to get it merged.**
> Not a label list. A merge-probability model with a feedback loop.

**Archetype:** CLI + GitHub App + VS Code ext · **Buzz:** 🔥🔥🔥🔥 · **Build speed:** Fast

---

## The problem

`good first issue` lists are static, stale, and dumb. They filter by label and
language — that's it. A contributor burns an evening on an issue nobody answered
in 9 months, or one with 4 abandoned PR attempts, or one the maintainer already
silently decided not to fix.

Meanwhile maintainers watch first-timers pick unwinnable issues and churn out of
the project forever. Nobody has data on why.

Existing tools (`good-first-issue`, `up-for-grabs`, `First Timers Only`) are
2015-era scrapers. They answer "what's labeled easy." Nobody answers **"what's
labeled easy *for me, right now, with a real shot at merging*?"**

## The idea

```bash
$ issue-radar --lang ts --hours 6
  1. vercel/next.js #61234  ★ 0.87  stale docs on route handlers
     maintainer: answers in ~4h · 0 competing PRs · touches 2 files
     matches your fingerprint: app router (14 commits), MDX (3 PRs merged)

  2. bun-lang/bun #9821    ★ 0.79  flaky test in test/js/node/net
     maintainer: answers in ~1d · 1 abandoned attempt (superseded)
     matches: test infra (6 PRs merged)

  …
$ issue-radar watch --notify slack
```

**Signals (v0, no ML needed):**
- maintainer median first-response time (GraphQL history)
- issue freshness, comment velocity, `stale` bot presence
- competing / abandoned PR attempts (linked + cross-referenced PRs)
- scope clarity: has acceptance criteria? has repro? labels vs. actual size
- code-touch footprint: files changed by similar past fixes
- **your fingerprint:** git log + merged-PR history → stack, subsystems, style

Output is always **ranked with reasons attached**, so it's inspectable — not a
black box score.

## Why it wins

- **The feedback loop is the moat.** Every time a radar-recommended issue leads
  to a merged PR, the model gets a labeled outcome. Nobody else has that data
  pipeline because nobody else closes the loop.
- **Two-sided.** Contributors get wins; maintainers get their easy issues *worked*
  instead of rotted. Maintainer adoption is a feature, not friction.
- **Local-first.** Token stays on your machine, fingerprint computed from your
  local git history. No account.
- **Notifications make it sticky.** A CLI you run occasionally is a toy; a digest
  that pings you Tuesday morning is a habit.

## Who wants it

New contributors (largest group, constantly searching), maintainers of mid-size
repos (1k–100k stars, real triage load), and companies running "hacktoberfest"
or onboarding programs who want to *measure* time-to-first-PR.

## Features

**v0 (weekend):** scan N repos for `good first issue`/`help wanted` → rank by
freshness + response time + competing PRs → pretty table + `--json`.
**v1:** your fingerprint from local git + GitHub merged PRs; `watch` daemon;
digest email/Slack; GitHub App that comments "this is a good fit for newcomers
because…" on freshly-labeled issues; VS Code panel.
**v2:** merge-probability model trained on public outcomes (logistic/GBM first,
not LLMs); org dashboard ("your good-first-issues rotted in 41 days median");
maintainer-side `radar triage` that suggests which issues to *label* for best
match rate.

## Architecture

```
GitHub GraphQL ──► ingest (issues, PRs, reviews, timelines)
                          │
        ┌─────────────────┼──────────────────┐
   repo signals      outcome labels      your fingerprint
   (response time,   (merged/closed      (local git log,
    attempts,         PR ↔ issue links)   merged PRs,
    scope cues)                             stack)
        └─────────────────┼──────────────────┘
                          ▼
               ranker (explainable weights → v2 ML)
                          ▼
        terminal · JSON · digest · VS Code · App comment
```

Everything is cached in a local SQLite file; a scan of 50 repos is a background
job, not a blocking call.

## Growth loop

1. Contributor finds a merged PR via radar → tells the maintainer → maintainer
   installs the App. Organic two-sided loop.
2. `radar badge` for repos: `🎯 6 issues ready for you` (per-visitor GitHub OAuth
   version later; anonymous count first).
3. Hacktoberfest-season launch. Every October, this is a search trend.
4. Digest is inherently shareable ("this week's best 5 issues" per language).

## Competitors & wedge

| Existing | Gap you exploit |
|----------|-----------------|
| `good-first-issue` (VS Code) | Label scrape only, no ranking, no personalization |
| `up-for-grabs.net` | Same — a directory, not an engine |
| GitHub's own "recommended issues" | Shallow, opaque, closed |
| Search + `is:issue label:"good first issue"` | You still do all the judgment work |

**Wedge:** merge-probability + personal fingerprint + maintainer-side metrics.

## 48-hour MVP

1. Day 1 AM: GraphQL fetch of 30 curated repos → issues + their PR links +
   comment timestamps. Cache in SQLite.
2. Day 1 PM: scoring function (weights, no ML) + table output + `--json`.
3. Day 2 AM: fingerprint = your last 200 merged commits' paths + languages.
4. Day 2 PM: run it for 5 real contributors, get quotes, write the Show HN post
   with the actual top-10 list for TypeScript.

## Monetization (open core)

- Free: CLI, local fingerprint, JSON, unlimited public repos.
- **Maintainer tier:** triage dashboard, rotted-issue alerts, "label suggestion"
  bot, time-to-first-PR analytics, private repos.
- **Org tier:** internal-repo radar across a company's repos, onboarding program
  metrics.

## Risks

- **Cold start on fingerprint** for brand-new contributors → fall back to
  language + popularity priors, still useful.
- **GraphQL rate limits** → per-user tokens, heavy caching, background sync.
- **Maintainers game the metrics** → measure outcomes (merged PRs), not activity.

## Build & test

Zero runtime dependencies - Node >= 20 only. No `npm install`, no lockfile.

```bash
# run from the issue-radar directory (bin name: radar)
node src/cli.js --help
node src/cli.js scan <owner/repo> --offline --fixture recorded.json   # replay a recorded API payload
node src/cli.js why <owner/repo>#42 --fixture recorded.json          # full signal breakdown
node src/cli.js fingerprint                                          # build the local fingerprint (offline)
node src/cli.js stats                                                # your application/merge history
node --test test/                                                    # 93 tests
```

## v0 status

**Shipped, covered by 93 passing tests:**

- **Scan**: ranks issues by merge probability from transparent, per-signal
  scoring - reproduction quality, freshness, maintainer response time,
  competing PRs, abandonment, scope/size labels, reporter footprint, comment
  activity, and fingerprint match; `--min-score`, `--label`, `--lang`,
  `--hours`, `--limit`, and `--budget` (a hard API-call cap)
- **Why**: the full signal-by-signal breakdown for one issue, with weights
- **Fingerprint/stats**: a local, offline model of the issues you actually
  merged, plus application history computed from cached data
- **Honesty rails**: `--offline` never touches the network (with `--fixture`,
  recorded responses replay exactly), cache TTLs with `--refresh`, and budget
  exhaustion is reported rather than silently truncating results
- **Output**: terminal table, `--json`, `--format md`
- **Tests**: scoring math with fixed clocks, signal parsing against recorded
  GitHub payloads, cache TTL/refresh behavior, budget enforcement,
  offline/fixture replay, fingerprint cold start, determinism (two scans,
  identical JSON), CLI exit codes

**Deferred (v1+, documented, not silently dropped):** `radar watch`, the
GitHub Action + PR badge, org-wide radar, time-to-first-PR analytics, and a
learned model over the outcome corpus (v0's explicit signal weights are the
transparent, gameable-on-purpose baseline).
