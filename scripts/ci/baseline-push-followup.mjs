#!/usr/bin/env node
// Baseline-regeneration follow-up (#1777, absorbing #1850) — the last step of
// .github/workflows/update-visual-baselines.yml.
//
// ## The defect this exists for
//
// The regeneration workflow checks out with
// `secrets.BASELINE_PUSH_TOKEN || github.token`. That secret is unset, so it
// always falls back, and the baseline commit is pushed as `github-actions[bot]`.
//
// What happens next was described two different ways on #1777/#1850, and only
// one of them is right. Verified against the API for bot commit `31003514`
// (regeneration run 32586643491):
//
//   GET /commits/31003514/check-runs        -> total_count: 0
//   GET /actions/runs?head_sha=31003514...  -> 5 runs, every one
//                                              event: pull_request,
//                                              conclusion: action_required,
//                                              triggering_actor github-actions[bot]
//
// Both are true, and they are not in tension. The `pull_request` events ARE
// delivered and runs ARE created; they are then PARKED pending approval because
// a bot pushed. No job executes, so no check run is ever attached to the SHA,
// and the PR sits at "Expected — waiting for status" with nothing to wait for.
//
// Repo-wide confirmation, `?status=action_required&per_page=100` (NOT a filter
// over the last 20 runs, which returns 0 and looks like a refutation): 15 parked
// runs, in three groups of five, on exactly three SHAs — all three authored by
// `github-actions[bot]`, two of them baseline pushes onto one branch.
//
// ## Two SHA CLASSES, and confusing them is the trap
//
// A regeneration involves two different commits, and only one of them shows the
// defect:
//
//   1. The DISPATCH RUN'S head — the branch tip when the workflow was dispatched.
//      A human pushed it, so it has a full set of check runs (23-24) and the
//      dispatch run reports `success`. Querying this SHA shows nothing wrong.
//   2. The commit the workflow PUSHED — the bot's baseline commit, which is the
//      CHILD of (1). This is the one with `total_count: 0` check runs and the
//      parked runs.
//
// Proof they are that pair: run 32586643491 has head_sha 9ab879fa, and 9ab879fa
// is the PARENT of the pushed commit 31003514. Any claim about this defect must
// name which class its SHA belongs to, or it is unfalsifiable.
//
// ## What this means for the recovery — the good news
//
// The distinction is not pedantry; it decides what a fix can be. "The event was
// never delivered" invites adding a `push` trigger, which would do nothing, and
// leaves pushing again as the only escape. Because the runs EXIST and are merely
// unapproved, the best recovery needs no push at all: a human clicks "Approve and
// run" on runs this script enumerates by URL, and the PR's required checks
// resolve. Approving needs the same write access that dispatching this workflow
// already needed, so the person who hit this can normally clear it themselves.
//
// Precisely: the script enumerates every run AWAITING APPROVAL on the commit,
// which is a superset of "the required checks" in principle and equal to it on
// today's topology. `selectParkedRuns` below carries the measurement and the
// condition under which the equivalence would break.
//
// The push-based escape stays documented as a fallback, and the reason it cannot
// be automated is worth stating so nobody re-derives it: the gate keys on WHO
// PUSHED, not on what was pushed. An empty commit pushed from inside this
// workflow carries the same `github-actions[bot]` actor through the same gate and
// parks identically. It works when a HUMAN does it only because their credentials
// are a different actor — `43ef06a7` on `dev` is a preserved instance of that
// repair (`--amend --reset-author` onto a real author, then force-push).
//
// ## Why a comment, and why the job goes red
//
// The workflow ALREADY warned about this at both ends — a comment on the
// checkout step and a `::warning::` on the commit step naming both remedies —
// and it still cost four sessions a step each, plus twice more during #1857.
// That is the transferable finding from #1850: a `::warning::` in a log nobody
// reads, while a PR sits at "waiting for status", is not a control. The
// condition has to surface where the person is actually looking, which is the
// pull request.
//
// And the run goes RED. A green run that leaves the PR unmergeable is the least
// useful of the three possible outcomes (#1850). The red is not a claim that the
// baselines are bad — they are committed and pushed BEFORE this step runs.
//
// ## What is deliberately NOT done here
//
//   - Refusing to run when the secret is absent. Linux-rendered baselines cannot
//     be produced on a contributor's macOS; this workflow is the only way to get
//     them. Refusing would remove the one working path to punish a missing
//     secret.
//   - Uploading baselines as an artifact instead of pushing. It never wedges a
//     PR, but it trades one manual step for a slower one on EVERY regeneration,
//     including the ones that go fine once the secret is set.
//   - Setting BASELINE_PUSH_TOKEN. That needs repo-settings access and is the
//     real fix; it is requested and out of this script's reach. When it lands,
//     `hasPushToken` flips true here and the whole path goes quiet with no
//     further change.
//
// The script never receives the secret's VALUE. The workflow passes only the
// boolean `${{ secrets.BASELINE_PUSH_TOKEN != '' }}`, so there is nothing here
// that could print or commit a token.

import { execFileSync } from 'node:child_process'

/**
 * Stable sticky-comment key, same convention as the advisory-gate comments
 * (.github/actions/advisory-gate-comment). We do not reuse that composite
 * action: it is built for `pull_request` events (it needs an implicit PR
 * number) and it is explicitly "never fails the build", which is the opposite
 * of what this step must do.
 */
export const STICKY_MARKER = '<!-- haven:baseline-push-followup -->'

/**
 * Read the workflow's `${{ secrets.BASELINE_PUSH_TOKEN != '' }}` boolean.
 *
 * FAIL-CLOSED: anything that is not exactly the string `true` is read as
 * "no token". A typo in the workflow env wiring therefore produces the loud
 * path, not the silent one. The silent path is the defect.
 */
export function parseHasPushToken(raw) {
  return String(raw ?? '').trim().toLowerCase() === 'true'
}

/**
 * Decide the outcome. Pure, and every branch of THIS function is unit-tested.
 *
 * Scope that claim honestly, because over-reading it is a real risk: the pure
 * layer here (`classify`, `parseHasPushToken`, `buildComment`,
 * `renderParkedSection`, `selectParkedRuns`, `pollParkedRuns`,
 * `commentApiArgs`, `findStickyCommentId`) is covered and mutation-proven. The
 * thin IO wrappers below it (`gh`, `openPullRequests`, `fetchParkedRuns`,
 * `upsertComment`'s transport, `main`'s sequencing) are NOT unit-tested — they
 * were exercised only against a stubbed `gh` binary. A file whose whole thesis
 * is "untested glue survives being useless" should say where its own glue is.
 *
 * `openPrCount === 0` is genuinely NOT a deadlock, and that is not an
 * optimism: if a PR is opened on this branch later, the `pull_request`
 * `opened` event is attributed to whoever opens it. A human opener is a
 * trusted actor, so the checks run normally. Only an already-open PR is
 * stranded, because its head just moved under a bot's name.
 */
export function classify({ committed, hasPushToken, openPrCount }) {
  if (!committed) {
    return {
      outcome: 'no-commit',
      exitCode: 0,
      shouldComment: false,
      summary: 'Baselines unchanged — nothing was pushed, so nothing can be deadlocked.',
    }
  }
  if (hasPushToken) {
    return {
      outcome: 'trusted-actor',
      exitCode: 0,
      shouldComment: false,
      summary:
        'Pushed with BASELINE_PUSH_TOKEN — the push is attributed to a real actor, so PR checks run normally.',
    }
  }
  if (!openPrCount) {
    return {
      outcome: 'no-open-pr',
      exitCode: 0,
      shouldComment: false,
      summary:
        'Pushed with GITHUB_TOKEN, but no pull request is open on this branch. ' +
        'Opening one now is attributed to you, not to the bot, so its checks will run. ' +
        'If you push nothing further and open the PR, you are fine.',
    }
  }
  return {
    outcome: 'deadlocked',
    exitCode: 1,
    shouldComment: true,
    summary:
      'Pushed with GITHUB_TOKEN onto a branch with an open pull request. ' +
      'The PR head is now a bot commit: its workflow runs are created and then parked ' +
      'at `action_required`, so no check run ever attaches and every required check waits ' +
      'forever. Recovery is manual and must come from a real actor.',
  }
}

/**
 * The comment body. It has to carry everything the reader needs WITHOUT the
 * reader knowing this failure mode already, because not knowing it is the
 * entire cost being paid (#1777: four sessions, a step each).
 */
export function buildComment({ repo, branch, sha, runUrl, parked = [] }) {
  const short = String(sha ?? '').slice(0, 9) || '(unknown)'
  return `${STICKY_MARKER}
### ⚠️ Baselines were regenerated, but this PR's checks are parked, not running

The Linux-rendered \`/design-system\` baselines are **correct and already pushed** as \`${short}\`. Nothing about the images is wrong. What is wrong is that **this PR's checks will never start on their own**, so every required check will sit at *"Expected — waiting for status"* indefinitely.

**Why — and the precise version matters, because the imprecise one sends you to the wrong repair.** \`BASELINE_PUSH_TOKEN\` is unset, so [*Update visual baselines*](${runUrl}) pushed as \`github-actions[bot]\`. It is **not** that the push failed to trigger anything. The \`pull_request\` events *are* delivered and the runs *are* created; GitHub then **parks them at \`conclusion: action_required\`**, awaiting approval, because a bot pushed. No job executes, so no check run attaches to the head SHA — which is why the SHA looks empty:

\`\`\`bash
gh api repos/${repo}/commits/${short}/check-runs                 # total_count: 0
gh api "repos/${repo}/actions/runs?head_sha=${sha}&status=action_required"   # the parked runs
\`\`\`

**This is expected, not a fault in your branch.** The dispatch run is red for the same reason this comment exists — a green run that leaves a PR unmergeable is worse than a red one. **Do not re-dispatch**; the baselines are already pushed, and regeneration runs \`--update-snapshots=all\` again.

#### Recovery — approve, don't push

${renderParkedSection({ repo, sha, parked })}

<details><summary>If you cannot approve them, push from your own credentials instead</summary>

The approval gate keys on **who pushed**, not on what was pushed, so a second push *from this workflow* would park identically. It has to come from a real actor:

\`\`\`bash
git fetch origin ${branch}
git checkout ${branch} && git reset --hard origin/${branch}
git commit --amend --reset-author --no-edit   # re-author the bot's commit as you
git diff ${short} HEAD --stat                 # MUST be empty: same tree, new author
git push --force-with-lease origin ${branch}
\`\`\`

If you would rather not force-push, \`git commit --allow-empty -m "chore: trigger CI" && git push\` also works and leaves an empty commit behind.

</details>

**The permanent fix** is setting the \`BASELINE_PUSH_TOKEN\` secret (a PAT or App token with \`contents: write\`) — requested on #1777. The workflow already reads it; when it is set this comment stops appearing and the run goes green, with no further change.

#### While you are here — did you diagnose before you dispatched?

Regeneration runs with \`--update-snapshots=all\`, which **blesses whatever renders without comparing anything**. If you dispatched this before diagnosing a failing visual diff, it has just made a possibly-broken render the expected state (this happened on #1772). Scan the diff PNG by row before you trust it: a clean horizontal cut or a size-mismatch line is a **height change** — a real defect — while a continuous colour difference at unchanged dimensions is drift.

<sub>Posted by \`scripts/ci/baseline-push-followup.mjs\` (#1777).</sub>`
}

/**
 * The runs GitHub created for the bot's push and then parked.
 *
 * This query is the whole reason the mechanism had to be nailed down. If the
 * push had genuinely NOT triggered anything, there would be nothing to name and
 * the only recovery would be another push. Because the runs exist and are
 * merely awaiting approval, a maintainer can approve them and the PR's required
 * checks resolve with NO push at all — and anyone who could dispatch this
 * workflow already has the write access that approving needs.
 */
export function parkedRunsQueryArgs(repo, sha) {
  return ['api', `repos/${repo}/actions/runs?head_sha=${sha}&status=action_required&per_page=100`]
}

/**
 * Pure: every run on this commit that is AWAITING APPROVAL. Not "every required
 * check" — say what it is, because the comment built from it makes a claim.
 *
 * ## The unstated invariant, now stated
 *
 * On today's repo topology these two sets coincide: all 15 required contexts on
 * `dev` are declared by jobs inside the five workflows that park, so approving
 * every parked run clears every required check. Measured, not assumed
 * (`gh api repos/<o>/<r>/rules/branches/dev` — the *rules* endpoint is readable
 * without admin; *protection* 404s).
 *
 * The coincidence holds only because every OTHER `pull_request`-triggered
 * workflow here is required. The one workflow that is advisory — `labeler.yml`
 * — uses `pull_request_target`, which is NOT subject to the bot-actor approval
 * gate, so it structurally cannot park and cannot land in this list.
 *
 * IF YOU ADD an advisory `pull_request` workflow, that breaks: it will park,
 * be swept in here, and be presented for approval alongside the required ones.
 * That is not harmful — approving an advisory run is fine — but the comment's
 * wording is deliberately "every run awaiting approval, which on today's
 * topology is exactly the required set" rather than "these ARE the required
 * checks". Keep it that way, or re-derive the equivalence.
 *
 * Deliberately NOT an allowlist of required contexts: a hardcoded list would
 * drift silently against the ruleset, which is a worse failure than a slightly
 * over-broad list of things to approve.
 */
export function selectParkedRuns(payload) {
  return (payload?.workflow_runs ?? [])
    .filter((r) => r?.conclusion === 'action_required')
    .map((r) => ({ name: r.name, id: r.id, url: r.html_url }))
}

/**
 * Poll for them. The runs are created a few seconds AFTER the push (measured:
 * push at 17:06:59Z, runs at 17:07:05Z), so a single immediate query races and
 * usually loses. Deps are injected so the retry behaviour is unit-tested rather
 * than trusted — an un-failing wait is this repo's signature defect.
 *
 * Budget with the defaults: `attempts` FETCHES separated by `attempts - 1`
 * sleeps, so 6 x 10s is **50 seconds** of waiting, not 60. Stated precisely
 * because getting the loop's own arithmetic wrong, in the file whose thesis is
 * precision about mechanism, would be the joke writing itself. The cost is paid
 * only on the deadlock path, inside a job that has already failed.
 */
export async function pollParkedRuns({ fetchParked, sleep, attempts = 6, delayMs = 10_000 }) {
  for (let i = 0; i < attempts; i += 1) {
    const found = fetchParked()
    if (found.length) return found
    if (i < attempts - 1) await sleep(delayMs)
  }
  return []
}

/**
 * Render the approve-these block, or an honest fallback. Returning prose that
 * merely ASSERTS parked runs exist, when we could not enumerate them, would
 * send the reader hunting — so the empty case says what to look for instead of
 * pretending to a list.
 */
export function renderParkedSection({ repo, sha, parked }) {
  if (parked.length) {
    const rows = parked.map((r) => `- [${r.name}](${r.url}) — run \`${r.id}\``).join('\n')
    return `**Approve these ${parked.length} parked runs** (one click each, "Approve and run" on the run page). Approving needs the same write access dispatching this workflow already needed, so if you dispatched it you can almost certainly do this yourself:

${rows}

That is **every run awaiting approval on this commit** — which on this repo's current topology is exactly this PR's required checks, so approving them clears the PR **without any push**. (If a run above looks advisory rather than required, approving it is still harmless.)`
  }
  return `**Approve the parked runs.** They were not enumerable when this ran (they are created a few seconds after the push, so this may simply have looked too early). Find them with:

\`\`\`bash
gh api "repos/${repo}/actions/runs?head_sha=${sha}&status=action_required" \\
  --jq '.workflow_runs[] | "\\(.name)\\t\\(.html_url)"'
\`\`\`

Open each and click **Approve and run**. That resolves this PR's required checks without any push.`
}

/**
 * Pure: the `gh api` argv for creating or updating the sticky comment.
 *
 * Extracted from the transport so the POST-vs-PATCH choice is testable. Getting
 * it backwards is silent and ugly — a PATCH against a comment id that is not
 * ours, or a POST that piles a fresh copy onto every regeneration.
 *
 * `-f` (not `-F`) is deliberate: `-F` would interpret a leading `@` as a
 * filename. And argv is passed to execFileSync without a shell, so backticks,
 * `$(...)` and newlines in the body are literal.
 */
export function commentApiArgs({ repo, prNumber, existingId, body }) {
  return existingId
    ? ['api', '--method', 'PATCH', `repos/${repo}/issues/comments/${existingId}`, '-f', `body=${body}`]
    : ['api', '--method', 'POST', `repos/${repo}/issues/${prNumber}/comments`, '-f', `body=${body}`]
}

/** Find this script's existing sticky comment, if it has already posted one. */
export function findStickyCommentId(comments) {
  const hit = (comments ?? []).find((c) => String(c?.body ?? '').includes(STICKY_MARKER))
  return hit ? hit.id : null
}

// ---------------------------------------------------------------------------
// IO — thin, and kept out of the tested surface above on purpose.
// ---------------------------------------------------------------------------

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).trim()
}

function openPullRequests(repo, branch) {
  try {
    return JSON.parse(gh(['pr', 'list', '--repo', repo, '--head', branch, '--state', 'open', '--json', 'number']))
  } catch (err) {
    // Fail LOUD: if we cannot tell whether a PR is open, assume the worst case
    // (one is) rather than exiting green on an unanswered question.
    console.log(`::warning::Could not list pull requests for ${branch}: ${err.message}`)
    return [{ number: null }]
  }
}

function upsertComment(repo, prNumber, body) {
  let existing = null
  try {
    const comments = JSON.parse(gh(['api', '--paginate', `repos/${repo}/issues/${prNumber}/comments`]))
    existing = findStickyCommentId(comments)
  } catch (err) {
    console.log(`::warning::Could not read comments on #${prNumber}: ${err.message}`)
  }
  gh(commentApiArgs({ repo, prNumber, existingId: existing, body }))
  return existing ? 'updated' : 'created'
}

function fetchParkedRuns(repo, sha) {
  try {
    return selectParkedRuns(JSON.parse(gh(parkedRunsQueryArgs(repo, sha))))
  } catch (err) {
    console.log(`::warning::Could not list parked runs for ${sha}: ${err.message}`)
    return []
  }
}

async function main() {
  const repo = process.env.GITHUB_REPOSITORY ?? ''
  const branch = process.env.GITHUB_REF_NAME ?? ''
  const sha = process.env.PUSHED_SHA ?? ''
  const runUrl = `${process.env.GITHUB_SERVER_URL ?? 'https://github.com'}/${repo}/actions/runs/${process.env.GITHUB_RUN_ID ?? ''}`
  const committed = String(process.env.BASELINES_COMMITTED ?? '').trim() === 'true'
  const hasPushToken = parseHasPushToken(process.env.HAS_PUSH_TOKEN)

  const prs = committed && !hasPushToken ? openPullRequests(repo, branch) : []
  const result = classify({ committed, hasPushToken, openPrCount: prs.length })

  let posted = 0
  if (result.shouldComment) {
    const parked = await pollParkedRuns({
      fetchParked: () => fetchParkedRuns(repo, sha),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    })
    console.log(`Parked runs found: ${parked.length}`)
    const body = buildComment({ repo, branch, sha, runUrl, parked })
    for (const pr of prs) {
      if (pr.number == null) continue
      try {
        console.log(`Sticky comment ${upsertComment(repo, pr.number, body)} on #${pr.number}.`)
        posted += 1
      } catch (err) {
        // NOT the fork-PR read-only-token case: this is `workflow_dispatch`,
        // a trusted event whose token scopes come from this workflow's own
        // `permissions:` block, and its branch selector cannot target a fork
        // ref anyway. The catch is for the ordinary reasons an API call fails
        // — transient 5xx, rate limit, a PR closed between lookup and post.
        // Whatever the cause, losing the comment must not lose the FAILURE:
        // the red check is the part that cannot be optional.
        console.log(`::warning::Could not comment on #${pr.number}: ${err.message}`)
      }
    }
  }

  // Do not promise a comment we did not manage to post. On a fork PR, or when
  // the PR lookup itself failed, the log IS the only channel left — so it has
  // to carry the recovery rather than point at a comment that is not there.
  const line = `[${result.outcome}] ${result.summary}`
  if (result.exitCode === 0) {
    console.log(line)
  } else if (posted > 0) {
    console.log(`::error::${line} See the sticky comment posted on the pull request for the recovery.`)
  } else {
    console.log(
      `::error::${line} NOTE: no PR comment could be posted (read-only token, or the PR lookup failed), ` +
        `so this log is the only notice. Recover by re-authoring the bot commit from your own credentials: ` +
        `git commit --amend --reset-author --no-edit && git push --force-with-lease origin ${branch}`,
    )
  }
  // NOT process.exit(): on Linux a pipe (which is what Actions gives us) makes
  // stdout async, and exiting immediately can truncate the write above — the
  // very message the no-comment fallback exists to guarantee. Setting exitCode
  // lets Node drain and exit with the same status.
  process.exitCode = result.exitCode
}

if (process.argv[1] && process.argv[1].endsWith('baseline-push-followup.mjs')) {
  main().catch((err) => {
    // An unhandled throw here would exit 1 anyway, but silently and without
    // saying why. Never let the loud path degrade into an unexplained red.
    console.log(`::error::baseline-push-followup crashed: ${err.stack ?? err.message}`)
    process.exitCode = 1
  })
}
