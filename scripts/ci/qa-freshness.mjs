#!/usr/bin/env node
// Money-flow QA freshness gate (#1030) — the `qa-freshness` job in
// .github/workflows/dev-gate.yml.
//
// ## What this gate is for
//
// #1024 removed the in-session money-path approval pause. THIS is what replaced
// it: the last automatic thing standing between unverified money-path code and
// production. .github/CODEOWNERS and docs/contributing/autonomous-pr-loop.md
// both record that the money-path safety model depends on it.
//
// ## What it used to prove, and why that was not enough
//
// The original inline-bash version asked one question: "is there A green qa-dev
// run on `dev`, less than FRESHNESS_HOURS old?" Two silent gaps (#1030):
//
//   1. TIME-BASED, NOT SHA-BOUND. It took the newest green run regardless of
//      which commit it ran against. Money-path commits merged AFTER that run
//      still promoted inside the same window — with a nightly schedule and a
//      30h window, a full day of money-path merges could ride out on a run that
//      predated every one of them.
//   2. hotfix/* NOT COVERED AT ALL. The `gate` job deliberately permits
//      hotfix/* -> main, but this check queried --branch dev, and a hotfix
//      branch has by construction never been on dev. A green dev run is
//      evidence about entirely different code, so a money-path hotfix reached
//      production with zero QA of itself while the gate reported green. This
//      was the more dangerous of the two: hotfixes are exactly when people move
//      fast, and it was the branch with no coverage.
//
// Gap 1 is closed by binding to the SHA. Gap 2 CANNOT be closed automatically,
// and saying so is the point:
//
//   qa-dev.yml is a BLACK-BOX harness against a DEPLOYED backend
//   (QA_HAVEN_API_URL). Triggering it on `hotfix/x` runs the harness CODE from
//   that branch against the DEV DEPLOYMENT -- which does not contain the
//   hotfix. A hotfix is deployed nowhere until it merges to main. So "a green
//   run exists on the hotfix branch" is NOT evidence about the hotfix, and a
//   gate that accepted it would be the same lie in a new costume.
//
// So a money-path hotfix BLOCKS, and clearing it is an explicit, logged human
// decision (`qa-override` with a stated reason) rather than a green check that
// proves nothing. Refusing to fake the evidence is the honest option; an
// overstated net is worse than a known-partial one, because nobody compensates
// for a gap they believe is closed.
//
// The gate therefore proves: "for a dev promotion, a green money-flow run
// covered the money-path code being promoted; for a money-path hotfix, a human
// accepted the risk on the record."
//
// ## Which runs count as evidence (#2404)
//
// The query used to be `gh run list --workflow qa-dev.yml --branch dev
// --status success --limit 1`. "On dev" was the right INTENT — a green run on
// any other branch exercised different code — but `--branch` is the wrong
// PREDICATE for it, and #2273 made that visible. #2273 rebuilt the post-deploy
// trigger on GitHub's `deployment_status` event: Railway's GitHub integration
// creates a real Deployment for every dev backend deploy (`railway-app[bot]`,
// environment `Haven AI / dev`), and the run it fires checks out and tests
// EXACTLY the deployed commit — for this event GitHub documents GITHUB_SHA as
// "commit to be deployed", the coverage this gate was designed around.
// Railway creates those Deployments against a BARE SHA (`ref == sha` on every
// one read from the Deployments API on 2026-09-02), and for that case GitHub
// documents GITHUB_REF as "empty if commit" — so #2404 was written predicting
// the run would carry no `headBranch` and that a `--branch dev` filter would
// exclude the best evidence the workflow produces. MEASURED FALSE on
// 2026-09-02 (#2427): the three `deployment_status` runs on deployment
// 6218620498 (`5d4e849c`) — 33609807445, 33609836970, 33609965305 — all
// report `headBranch: dev`. The filter stays gone for the reason that was
// always the real one: a branch name says nothing about which commit the
// harness exercised, and on that very deployment `--branch dev --status
// success --limit 1` would have returned 33609836970 — a run whose `gate` job
// skipped the harness (money-flow: skipped, run-level `success`) — while
// 33609965305, the run that actually exercised the deployed commit, sat
// behind it. Rules 3 and 4 below are the predicate "on dev" was reaching for.
//
// So the query no longer filters on branch. It fetches a window of green runs
// and `selectGreenRun` — pure, tested — admits a run only when ALL of:
//
//   1. its event is `deployment_status`, `schedule` or `workflow_dispatch`.
//      Anything else is refused — `repository_dispatch` in particular, which
//      #2273 removed from the workflow because it was the one route a curl
//      could use to fabricate a post-deploy-looking run (#2271);
//   2. for `schedule` and `workflow_dispatch` — the two branch-TRIGGERED
//      events — `headBranch` is still `dev`, exactly as before. Nothing
//      widened on those legs. `deployment_status` is deliberately not on this
//      list even though its runs report `headBranch: dev` (measured, #2427):
//      the field says which branch the deploy was cut from, not which commit
//      the harness exercised, so rules 3 and 4 answer for it;
//   3. its `headSha` is an ANCESTOR of the promotion head (`git merge-base
//      --is-ancestor`). This is what "on dev" was trying to say, stated
//      directly: the run's commit is in the history being promoted. It is
//      strictly stronger than the branch label, it does not depend on the
//      label at all, and it is checked for EVERY event — a
//      `workflow_dispatch` on a feature branch, or a `deployment_status` for a
//      Deployment of something that never reached dev, both fail here;
//   4. its `money-flow` JOB concluded `success`, read from the jobs API. A
//      run's own conclusion is NOT enough: #2273's workflow gates the
//      money-flow job behind a cheap `gate` job that skips the harness for
//      `in_progress` and duplicated `success` statuses, and a run whose jobs
//      are {gate: success, money-flow: skipped} has run-level conclusion
//      `success` (measured on three ci.yml runs on 2026-09-02: jobs
//      `skipped=7,success=7` -> `success`). `--status success` alone would
//      therefore hand this gate a "green" run at the deployed SHA in which no
//      harness ran, and the promotion would ride on it. Unreadable jobs refuse
//      the run — fail closed, never "assume it ran".
//
// Deliberately NOT a rule: the Deployment's creator (#2271 asked for
// `railway-app[bot]`). `gh run list` rows do not carry it — it lives on the
// Deployment, which #2273's `gate` job already checks BEFORE the money-flow
// job is allowed to run, and which `guard-freshness.mjs` reads from the
// Deployments API for its own question. For THIS gate, rules 3 and 4 together
// are the stronger statement: the commit is in the promoted history AND the
// harness actually ran green there. A Deployment a human creates by hand
// through the API at a dev commit either never reaches the harness (#2273's
// gate refuses the creator) or, if it did, produced exactly the evidence a
// `workflow_dispatch` at that commit would — which this gate has always
// accepted. Re-checking a bot login here would be a second copy of #2273's
// check with nothing new behind it.
//
// Newest admitted run wins. Among admitted runs at the SAME commit, event
// provenance breaks the tie: `deployment_status` over `schedule` over
// `workflow_dispatch`, because the first is the only one whose `headSha` is
// the deployed commit by construction. That preference is deliberately a
// TIE-BREAK and not an override: a manual dispatch on dev is legitimate
// coverage (agent-qa.md says so, and re-dispatching after a fix lands is the
// documented way a red qa-failure gets cleared), and a gate that preferred an
// older post-deploy run over a newer manual one would refuse exactly that
// route and make `qa-override` the standing way through — the #2164 lesson,
// one gate over.
//
// KNOWN LIMIT on the dev path, stated rather than papered over: for a
// `schedule` or `workflow_dispatch` run the `headSha` is the branch tip when
// the run was TRIGGERED, not necessarily the SHA deployed to dev, so a lagging
// or failed dev deploy makes it overstate what was exercised. A
// `deployment_status` run does NOT have this limit — its `headSha` IS the
// deployed commit — which is why admitting it matters.
//
// MEASURED LEG (#2427), replacing the "unverified leg" #2404 named here so
// nobody would quote a prediction as a measurement: as of 2026-09-02 08:40Z
// three `deployment_status` runs exist (deployment 6218620498, `5d4e849c`)
// and every one reports `headBranch: dev` — the "empty if commit" prediction
// did not hold on this repository. Rules 1-4 never depended on it: a
// `deployment_status` run is admitted by ancestry and job conclusion whether
// the field is `dev`, empty or absent, and the test suite keeps all three
// shapes. Evidence, the dedupe and the provenance rule are in
// docs/operations/agent-qa.md § "Post-deploy trigger".
//
// ## What it still does NOT cover — by design, do not "fix" these
//
// The `qa-override` label, the QA_FRESHNESS_HOURS repo variable, and admin
// merge all remain. An escape hatch that is NAMED and LOGGED is a feature; the
// two gaps above were different because they were silent and the gate reported
// green while proving nothing.
//
// ## Shape
//
// `evaluate()` is pure — all IO (gh, git) happens in the CLI wrapper at the
// bottom, so every branch is unit-testable without a network or a repo. That
// split is the point: this file is the money-path safety net, and a safety net
// nobody can test is a safety net nobody knows is broken.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const GLOBS_FILE = '.github/money-path-globs.json'

/**
 * Runtime money-path code — what the deployed QA harness can actually exercise.
 * This is what the freshness gate reasons about.
 */
export function loadMoneyPathGlobs(root = ROOT) {
  const raw = JSON.parse(readFileSync(path.join(root, GLOBS_FILE), 'utf8'))
  if (!Array.isArray(raw.globs) || raw.globs.length === 0) {
    throw new Error(`${GLOBS_FILE}: "globs" must be a non-empty array`)
  }
  return raw.globs
}

/**
 * The safeguard's own control surface. LABELLED money-path (a PR weakening the
 * gate needs the playbook and a human), but deliberately NOT part of the
 * freshness check: re-running the money-flow harness proves nothing about a CI
 * config change, so requiring it would be friction with no evidence attached.
 */
export function loadMoneyPathControlGlobs(root = ROOT) {
  const raw = JSON.parse(readFileSync(path.join(root, GLOBS_FILE), 'utf8'))
  return Array.isArray(raw.controlGlobs) ? raw.controlGlobs : []
}

/**
 * Match a repo-root-relative path against one glob. Supports the two forms the
 * list actually uses — a trailing `/**` directory prefix and a single `*`
 * within one segment — and nothing else, deliberately: an over-clever matcher
 * on the money path is a liability, and an unsupported form should be obvious
 * rather than silently matching nothing.
 */
export function matchesGlob(file, glob) {
  if (glob.endsWith('/**')) return file.startsWith(glob.slice(0, -2))
  const escaped = glob.replace(/[.+^${}()|[\]\\?]/g, '\\$&').replace(/\*/g, '[^/]*')
  return new RegExp(`^${escaped}$`).test(file)
}

export function moneyPathFiles(files, globs) {
  return files.filter((f) => globs.some((g) => matchesGlob(f, g)))
}

/**
 * Semver as `scripts/release-bump.mjs` writes it, including the `-alpha.N`
 * prerelease form every Haven release has used. No capture groups — the shapes
 * below number their own.
 */
const SEMVER = String.raw`\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?`

/**
 * The `export const <NAME>_VERSION` constants `release-bump.mjs` writes into a
 * file this gate reasons about. Today that is exactly two: its
 * SOURCE_VERSION_CONSTANTS list writes SIGNER_VERSION into
 * packages/signer/src/server.ts and HOSTED_SERVER_VERSION into
 * packages/mcp-server/src/server.ts — the second joined when #2300 put
 * packages/mcp-server/src/** on the perimeter, which is exactly the
 * intersection this comment says to re-derive. The other three (MCP_VERSION in
 * packages/mcp/src/server.ts, CONNECTOR_VERSION in packages/connect/,
 * CLI_VERSION in packages/cli/) land in packages that are on no glob.
 *
 * Named literally rather than matched as `[A-Z0-9_]*_VERSION`, because a
 * generic pattern would be wider than the writer it claims to be derived from —
 * unforced widening on a safety gate. If release-bump ever writes another
 * constant into a money-path file, this gate fires until someone adds it here.
 * That is the intended friction: re-derive by intersecting release-bump.mjs's
 * SOURCE_VERSION_CONSTANTS with the `globs` in .github/money-path-globs.json.
 */
const RELEASE_BUMP_VERSION_CONSTANTS = ['SIGNER_VERSION', 'HOSTED_SERVER_VERSION']

/**
 * The ONLY line shapes a release bump writes into a money-path file, each
 * paired with the SYMBOL it addresses. The symbol is what makes this a check
 * for a version *bump* rather than for a version-*shaped* line — see
 * `isVersionOnlyDiff`.
 */
const VERSION_ONLY_LINE_SHAPES = [
  {
    // export const SIGNER_VERSION = '0.1.31-alpha.0'
    re: new RegExp(
      String.raw`^\s*export const (${RELEASE_BUMP_VERSION_CONSTANTS.join('|')})\s*=\s*(['"])${SEMVER}\2;?\s*$`,
    ),
    symbol: (m) => `const:${m[1]}`,
  },
  {
    //   "version": "0.1.31-alpha.0",
    re: new RegExp(String.raw`^\s*"version":\s*"${SEMVER}",?\s*$`),
    symbol: () => 'pkg:version',
  },
  {
    //     "@haven_ai/sdk": "0.1.31-alpha.0",
    re: new RegExp(String.raw`^\s*"(@haven_ai/[a-z0-9-]+)":\s*"${SEMVER}",?\s*$`),
    symbol: (m) => `dep:${m[1]}`,
  },
]

/** The symbol a changed line addresses, or null if it is not a version line. */
function versionLineSymbol(line) {
  for (const shape of VERSION_ONLY_LINE_SHAPES) {
    const m = shape.re.exec(line)
    if (m) return shape.symbol(m)
  }
  return null
}

/**
 * Does a single file's unified diff consist of NOTHING but a release-bump
 * rewriting version strings in place?
 *
 * ## Why this exists (#2164)
 *
 * Every release bump rewrites `SIGNER_VERSION` into
 * `packages/signer/src/server.ts` and the version field in
 * `packages/signer/package.json` — both money-path files. That write always
 * lands AFTER the last green money-flow run, so the freshness gate refused
 * every release promotion by construction, and the only way through was
 * `qa-override`. A named escape hatch used on every release stops being an
 * escape hatch and becomes the route; the gate would then be off on exactly the
 * promotions that ship new signing code. See the `0.1.31-alpha.0` cut.
 *
 * ## Why shape alone is NOT enough (review finding on this issue)
 *
 * A first version of this checked only that every changed line LOOKED like a
 * version assignment. That answers "are these lines version-shaped", not "is
 * this a version bump", and three behavioural edits slipped through it: a
 * deletion of the constant with nothing replacing it; a dependency identity
 * swap (`"@haven_ai/sdk"` removed, `"@haven_ai/mcp"` added) which retargets what
 * the signer depends on; and a rename of the constant itself. Each line was
 * independently well-shaped, so per-line matching excused all three.
 *
 * So the rule is PAIRING, not shape: every changed line must address a known
 * symbol, and WITHIN EACH HUNK the multiset of symbols removed must equal the
 * multiset added. An in-place bump satisfies that by construction (same symbol
 * on both sides of the same hunk); a deletion, an addition, a rename and a swap
 * all fail it, because a symbol appears on one side only. Per-hunk rather than
 * per-file because a symbol moved between two locations nets to zero across the
 * file while being a real change at both ends.
 *
 * ## Fail-closed
 *
 * Excusing by PATH (`packages/signer/**`) or by author/branch/commit message
 * would be the permissive direction. One unrecognised line, one unpaired
 * symbol, an empty diff, or an unreadable one, and the answer is false: this
 * function may only ever answer "provably an in-place version bump".
 *
 * Deliberately blind to diff METADATA — `diff --git`, `index`, `old mode`,
 * `rename from/to`, `similarity index` — since none of those start with `+`/`-`.
 * A real rename surfaces the whole file as added content, which fails the
 * pairing check anyway; a mode flip is not something release-bump does.
 */
export function isVersionOnlyDiff(diffText) {
  if (typeof diffText !== 'string' || diffText.trim() === '') return false

  // Split into hunks. Pairing is checked WITHIN each hunk, never across the
  // file: two unrelated hunks whose symbols happen to net to zero are not a
  // bump. The case that forced this (review, round two) is a dependency moved
  // between sections — `"@haven_ai/sdk"` removed from `dependencies` in one
  // hunk and added to `devDependencies` in another. File-wide multiset equality
  // excuses it; per-hunk equality refuses it. That move changes what ships when
  // the signer is installed, and `release-bump.mjs` never produces it — its
  // dep-pin writer edits a value in place inside whichever section already
  // holds the key.
  const hunks = []
  let current = null
  for (const line of diffText.split('\n')) {
    if (line.startsWith('@@')) {
      current = []
      hunks.push(current)
      continue
    }
    if (current === null) continue // file headers ahead of the first hunk
    current.push(line)
  }
  if (hunks.length === 0) return false

  let changedLines = 0
  for (const hunk of hunks) {
    const removed = []
    const added = []
    for (const line of hunk) {
      // Drop file headers (`+++ b/x`, `--- a/x`); everything else starting with
      // a single +/- is a real changed line.
      if (!(line.startsWith('+') || line.startsWith('-'))) continue
      if (line.startsWith('+++') || line.startsWith('---')) continue
      const symbol = versionLineSymbol(line.slice(1))
      if (symbol === null) return false
      ;(line.startsWith('-') ? removed : added).push(symbol)
    }
    changedLines += removed.length + added.length

    // Multiset equality within the hunk: an in-place bump rewrites the same
    // symbols on both sides. A pure delete, a pure add, a rename, a dependency
    // swap, or a move to another part of the file each leave a symbol unmatched.
    if (removed.length !== added.length) return false
    const sortedRemoved = [...removed].sort()
    const sortedAdded = [...added].sort()
    if (!sortedRemoved.every((sym, i) => sym === sortedAdded[i])) return false
  }

  return changedLines > 0
}

/**
 * Split money-path files into the ones that carry behaviour and the ones whose
 * whole diff is a release-bump version string. `diffFor` returns a file's
 * unified diff, or null when git cannot answer — null is treated as behavioural,
 * so an uncomputable diff can never excuse a file.
 */
export function partitionVersionOnly(files, diffFor) {
  const behavioural = []
  const versionOnly = []
  for (const file of files) {
    let diffText = null
    try {
      diffText = diffFor(file)
    } catch {
      diffText = null
    }
    if (isVersionOnlyDiff(diffText)) versionOnly.push(file)
    else behavioural.push(file)
  }
  return { behavioural, versionOnly }
}

/**
 * Decide whether a promotion may proceed.
 *
 * Fails CLOSED on anything it cannot establish: a missing run, an unparseable
 * timestamp, an unknown source branch. The whole point is that the gate must
 * not report green while proving nothing — that was gap 1 and gap 2.
 *
 * @param {object} input
 * @param {string} input.sourceBranch    PR head ref ('dev' or 'hotfix/...')
 * @param {?object} input.latestGreenRun `{ createdAt, headSha }` or null
 * @param {?string[]} input.changedMoneyPathFiles money-path files between the
 *        run's SHA and the promotion head; null when it could not be computed
 * @param {number} input.nowMs
 * @param {number} input.freshnessHours
 * @returns {{ok: boolean, code: string, message: string}}
 */
export function evaluate({
  sourceBranch,
  latestGreenRun,
  changedMoneyPathFiles,
  nowMs,
  freshnessHours,
}) {
  const RERUN =
    "Trigger it (Actions → 'QA — money-flow (dev)' → Run workflow) and re-run this check, " +
    "or add the 'qa-override' label to bypass. See docs/operations/agent-qa.md → Automation & gating."

  const isHotfix = sourceBranch.startsWith('hotfix/')

  // --- Source branch must be one we know how to reason about -----------------
  // `gate` already restricts promotion to dev/hotfix, but this function must not
  // depend on another job for its own correctness — and its docstring promises
  // it fails closed on an unknown branch, so make that true rather than claim it.
  if (sourceBranch !== 'dev' && !isHotfix) {
    return {
      ok: false,
      code: 'unknown_branch',
      message:
        `Unrecognised promotion source branch '${sourceBranch}'. Only 'dev' and 'hotfix/*' ` +
        `may merge to main (see the 'gate' job). Failing closed rather than guessing which ` +
        `evidence applies.`,
    }
  }

  // --- FRESHNESS_HOURS must be a real bound ----------------------------------
  // QA_FRESHNESS_HOURS is a repo variable, editable without code review. A
  // non-numeric value makes `ageH > NaN` false, silently disabling the staleness
  // rule while the job prints a green checkmark. The old bash had the same hole
  // but at least logged a shell error; a green "within NaNh" is strictly worse.
  if (!Number.isFinite(freshnessHours) || freshnessHours <= 0) {
    return {
      ok: false,
      code: 'bad_freshness_hours',
      message:
        `QA_FRESHNESS_HOURS is not a positive number (got '${freshnessHours}'). Refusing to ` +
        `run with no staleness bound — an unbounded window is not a gate. Fix the repo variable.`,
    }
  }

  // --- Gap 2: hotfix/* — cannot be verified, so it BLOCKS --------------------
  // qa-dev.yml is a black-box harness against a DEPLOYED backend. A run
  // triggered on a hotfix branch exercises the DEV deployment, which does not
  // contain the hotfix — so no automatic evidence about a hotfix can exist. The
  // gate refuses to manufacture some. A hotfix touching no money-path file is
  // simply not what this gate protects, and passes.
  if (isHotfix) {
    if (changedMoneyPathFiles === null) {
      return {
        ok: false,
        code: 'hotfix_diff_unknown',
        message:
          `Could not determine whether this hotfix touches money-path files. Failing closed — ` +
          `a hotfix reaches production without ever being on 'dev'. ${RERUN}`,
      }
    }
    if (changedMoneyPathFiles.length === 0) {
      return {
        ok: true,
        code: 'hotfix_no_money_path',
        message:
          'Hotfix touches no money-path files — the money-flow gate does not apply to it.',
      }
    }
    return {
      ok: false,
      code: 'hotfix_money_path',
      message:
        `This hotfix changes money-path code:\n` +
        changedMoneyPathFiles.map((f) => `  - ${f}`).join('\n') +
        `\nIt CANNOT be verified automatically: the money-flow QA harness runs against a ` +
        `DEPLOYED backend, and a hotfix is deployed nowhere until it merges to main — so a ` +
        `green qa-dev run on any branch exercised different code. Promoting this is a human ` +
        `decision: add the 'qa-override' label WITH a comment stating what you verified and ` +
        `why the risk is acceptable. The label emits a warning and is the audit record.`,
    }
  }

  // --- Original behaviour: a green run must exist ----------------------------
  if (!latestGreenRun) {
    return {
      ok: false,
      code: 'no_run',
      message: `No successful 'QA — money-flow (dev)' run found on dev. ${RERUN}`,
    }
  }

  const runMs = Date.parse(latestGreenRun.createdAt)
  if (Number.isNaN(runMs)) {
    return {
      ok: false,
      code: 'unparseable_timestamp',
      message:
        `Could not parse the QA run timestamp ('${latestGreenRun.createdAt}'). ` +
        `Failing closed rather than assuming it is recent. ${RERUN}`,
    }
  }

  // --- Original behaviour: it must be recent ---------------------------------
  const ageH = Math.floor((nowMs - runMs) / 3_600_000)
  if (ageH > freshnessHours) {
    return {
      ok: false,
      code: 'stale',
      message:
        `Latest green qa-dev run is ${ageH}h old (> ${freshnessHours}h). Re-run the ` +
        `money-flow QA against the current dev deploy before promoting, or add the 'qa-override' label.`,
    }
  }

  // --- Gap 1: the run must have covered the money-path code being promoted ---
  // Recent is not the same as relevant. Ordinary promotions with no money-path
  // commits since the run stay cheap — this only bites when the promotion
  // actually carries money-path code the run never saw.
  if (changedMoneyPathFiles === null) {
    return {
      ok: false,
      code: 'diff_unknown',
      message:
        `Could not compute which files changed since the QA run (${latestGreenRun.headSha}). ` +
        `Failing closed — an uncomputable diff cannot show the run covered this code. ${RERUN}`,
    }
  }
  if (changedMoneyPathFiles.length > 0) {
    return {
      ok: false,
      code: 'money_path_after_run',
      message:
        `Money-path files changed AFTER the latest green QA run (${latestGreenRun.headSha}), ` +
        `so that run never exercised them:\n` +
        changedMoneyPathFiles.map((f) => `  - ${f}`).join('\n') +
        `\nThe run is ${ageH}h old and within the window, but recency is not coverage. ${RERUN}`,
    }
  }

  return {
    ok: true,
    code: 'ok',
    message:
      `Money-flow QA green ${ageH}h ago (within ${freshnessHours}h) at ${latestGreenRun.headSha}, ` +
      `and no money-path files changed since.`,
  }
}

/**
 * #1044: was the covering green run green-with-SKIPS? The qa-dev workflow's
 * "Coverage completeness" step fails (under continue-on-error) when any
 * scenario leg was skipped, so a green run's PARTIALITY is visible in its
 * jobs. This inspects those step conclusions and returns a warning string,
 * or null for full coverage.
 *
 * Deliberately a WARNING, not a failure: the skipping leg is optional until
 * its identity is provisioned, and blocking promotion on an unprovisioned
 * optional leg would over-claim in the opposite direction. The strict flip
 * is QA_REQUIRE_ALL_LEGS=1 on the qa-dev side, which makes skips fail the
 * run itself — at which point this code path never sees them.
 */
export function completenessWarningFromJobs(jobs) {
  for (const job of jobs ?? []) {
    for (const step of job.steps ?? []) {
      if (step.name === 'Coverage completeness' && step.conclusion === 'failure') {
        return (
          'the covering QA run is GREEN-WITH-SKIPS: at least one money-flow leg never ran ' +
          '(#1044). The freshness gate still passes — the skipped leg is optional until its ' +
          'identity is provisioned — but the coverage this gate certifies is partial. ' +
          'See the run\u2019s "Coverage completeness" step for which legs.'
        )
      }
    }
  }
  return null
}

/**
 * The events whose runs may count as coverage evidence, in PROVENANCE order
 * (best first). Used both to admit a run and to break ties between admitted
 * runs at the same commit — see `selectGreenRun`.
 */
export const EVIDENCE_EVENTS = ['deployment_status', 'schedule', 'workflow_dispatch']

/**
 * The events that carry a branch label GitHub fills in. For these the run
 * must still be on `dev` by label, exactly as before #2404; a
 * `deployment_status` run is expected to carry no label at all (Railway
 * deploys a bare SHA) and is admitted on ancestry alone.
 */
export const BRANCH_LABELLED_EVENTS = ['schedule', 'workflow_dispatch']

/** The qa-dev.yml job that actually moves money. Pinned to the workflow by name. */
export const MONEY_FLOW_JOB = 'money-flow'

/**
 * How many green runs the query fetches before the selector gives up. A
 * busy day dispatches qa-dev.yml a dozen times; #2273's gate-skipped
 * deployment_status runs add two or three `success`-conclusion rows per
 * deploy that rule 4 refuses. 30 comfortably spans a day of both.
 */
export const GREEN_RUN_WINDOW = 30

/**
 * The exact `gh run list` query the gate trusts (#1047 wiring test): always
 * this workflow, only successes, newest first, a bounded window — and NO
 * branch filter (#2404). "On dev" is decided by `selectGreenRun` on the run's
 * SHA, because a branch name says nothing about which commit the harness
 * exercised — a `deployment_status` run does report `headBranch: dev`
 * (measured, #2427) and the selector ignores it for that event.
 * `event` and `headBranch` are in the projection because the selector
 * fails closed without them: a row with no `event` is refused, never assumed.
 */
export function greenRunQueryArgs(repo) {
  return [
    'run',
    'list',
    '--repo',
    repo,
    '--workflow',
    'qa-dev.yml',
    '--status',
    'success',
    '--limit',
    String(GREEN_RUN_WINDOW),
    '--json',
    'createdAt,headSha,databaseId,event,headBranch',
  ]
}

/**
 * The conclusion of the money-flow job in a run's job list, or null when the
 * job is absent or the list is unreadable. Null is refused by the selector.
 */
export function moneyFlowJobConclusion(jobs) {
  if (!Array.isArray(jobs)) return null
  const job = jobs.find((j) => j?.name === MONEY_FLOW_JOB)
  return typeof job?.conclusion === 'string' ? job.conclusion : null
}

/**
 * Pick the run the gate anchors to, from a window of `--status success`
 * rows, newest first (#2404). Pure: ancestry and the jobs API come in as
 * thunks so every refusal is unit-testable.
 *
 * Returns `{ run, jobs, refused }` — `run` is the admitted row or null,
 * `jobs` its job list (so the caller's completeness warning does not fetch
 * it twice), and `refused` names every row that was passed over and why, so
 * the job log says which candidates existed rather than only "no run".
 *
 * Every rule fails CLOSED: a missing field, an ancestry check that errored
 * (null, distinct from false), or an unreadable job list refuses the row. The
 * selector may only ever answer "provably a green money-flow run on a commit
 * in the promoted history".
 *
 * @param {Array<object>} rows  `gh run list --json createdAt,headSha,databaseId,event,headBranch`
 * @param {object} io
 * @param {(sha: string) => boolean|null} io.isAncestorOfHead  true / false / null (could not tell)
 * @param {(databaseId: number|string) => Array<object>|null} io.jobsFor  the run's jobs, or null
 */
export function selectGreenRun(rows, { isAncestorOfHead, jobsFor }) {
  const refused = []
  const refuse = (row, reason) => {
    refused.push({ databaseId: row?.databaseId ?? null, event: row?.event ?? null, headSha: row?.headSha ?? null, reason })
  }

  const stamp = (row) => {
    const t = Date.parse(row?.createdAt ?? '')
    return Number.isNaN(t) ? -Infinity : t
  }
  const rank = (row) => EVIDENCE_EVENTS.indexOf(row?.event)

  // Apply rules 1-4 to one row; the admitted row's jobs come back with it.
  const admit = (row) => {
    // 1. Event allow-list. `repository_dispatch` lands here on purpose.
    if (!EVIDENCE_EVENTS.includes(row?.event)) {
      refuse(row, `event '${row?.event ?? 'missing'}' is not coverage evidence`)
      return null
    }
    // 2. Branch-labelled events must still be on dev by label — unchanged
    //    from the pre-#2404 rule for those events. Checked before ancestry
    //    because it is free and ancestry is a git call.
    if (BRANCH_LABELLED_EVENTS.includes(row.event) && row.headBranch !== 'dev') {
      refuse(row, `${row.event} run is on '${row.headBranch ?? ''}', not dev`)
      return null
    }
    // 3. The commit must be in the promoted history — for every event.
    if (typeof row.headSha !== 'string' || row.headSha === '') {
      refuse(row, 'no headSha')
      return null
    }
    const ancestor = isAncestorOfHead(row.headSha)
    if (ancestor !== true) {
      refuse(row, ancestor === false ? `${row.headSha} is not an ancestor of the promotion head` : `could not establish whether ${row.headSha} is in the promoted history`)
      return null
    }
    // 4. The money-flow job must have run and passed. A run whose gate
    //    skipped the harness has run-level conclusion `success`.
    let jobs = null
    try {
      jobs = jobsFor(row.databaseId)
    } catch {
      jobs = null
    }
    const conclusion = moneyFlowJobConclusion(jobs)
    if (conclusion !== 'success') {
      refuse(row, conclusion === null ? `could not read the '${MONEY_FLOW_JOB}' job` : `'${MONEY_FLOW_JOB}' job concluded '${conclusion}', not success`)
      return null
    }
    return { run: row, jobs }
  }

  // Newest first. WHICH COMMIT anchors the diff is decided by the newest
  // ADMITTED row alone — rows that fail a rule are recorded and skipped, and
  // never influence the ordering. (A first version ranked commits by the
  // newest row AT each SHA, refused rows included, so a refused
  // repository_dispatch at an old commit could drag that commit ahead of a
  // newer one with real evidence — review finding; the failure direction was
  // safe, a spurious block, but it contradicted this comment's own promise.)
  const ordered = [...(Array.isArray(rows) ? rows : [])].sort((a, b) => stamp(b) - stamp(a))
  for (let i = 0; i < ordered.length; i += 1) {
    const first = admit(ordered[i])
    if (!first) continue
    // Tie-break, and ONLY a tie-break: among OTHER admissible rows at the
    // SAME commit, better provenance wins — deployment_status over schedule
    // over workflow_dispatch — because the first is the only event whose
    // headSha is the deployed commit by construction. A manual re-dispatch at
    // a commit Railway also deployed then anchors to the post-deploy run.
    // This never changes which commit: candidates must share `first`'s SHA,
    // and each must itself pass every rule before it can replace `first`.
    let best = first
    for (let j = i + 1; j < ordered.length; j += 1) {
      const row = ordered[j]
      if (row?.headSha !== first.run.headSha) continue
      if (!(rank(row) !== -1 && rank(row) < rank(best.run))) continue
      const better = admit(row)
      if (better) best = better
    }
    return { ...best, refused }
  }
  return { run: null, jobs: null, refused }
}

/**
 * Which SHA the coverage diff is anchored to (#1047 wiring test): a hotfix
 * diffs against its merge-base with main (two-dot against main's tip would
 * blame it for every money-path change main gained since it branched); every
 * other branch diffs against the newest green run's commit. `null` when the
 * anchor cannot be established — the caller fails closed on null.
 * `resolveMergeBaseWithMain` is a thunk so the git call only happens on the
 * hotfix path.
 */
export function selectDiffBase({ sourceBranch, latestGreenRun, resolveMergeBaseWithMain }) {
  if (sourceBranch.startsWith('hotfix/')) return resolveMergeBaseWithMain()
  return latestGreenRun?.headSha ?? null
}

// ---------------------------------------------------------------------------
// CLI — the IO shell. Everything above is pure and tested.
// ---------------------------------------------------------------------------

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trim()
}

function greenRunWindowFor(repo) {
  const out = gh(greenRunQueryArgs(repo))
  return JSON.parse(out || '[]')
}

/**
 * The run's jobs with their names, conclusions and step conclusions — one
 * call serves both the money-flow-job rule and the #1044 completeness
 * warning. Returns null when the API cannot answer; the selector refuses on
 * null.
 */
function jobsForRun(repo, databaseId) {
  try {
    // One page of up to 100 jobs. qa-dev.yml has two (`gate`, `money-flow`);
    // if it ever grows past 100 the money-flow job could fall off this page,
    // at which point `moneyFlowJobConclusion` returns null and the run is
    // REFUSED — the safe direction, and loud enough to notice.
    const out = gh([
      'api',
      `repos/${repo}/actions/runs/${databaseId}/jobs`,
      '-F',
      'per_page=100',
      '--jq',
      '{jobs: [.jobs[] | {name, conclusion, steps: [.steps[] | {name, conclusion}]}]}',
    ])
    const parsed = JSON.parse(out || '{}')
    return Array.isArray(parsed.jobs) ? parsed.jobs : null
  } catch (err) {
    console.error(`qa-freshness: could not read jobs for run ${databaseId}: ${err.message}`)
    return null
  }
}

/**
 * `git merge-base --is-ancestor <sha> <head>`: exit 0 is true, exit 1 is
 * false, anything else (unknown object, shallow clone) is null — which the
 * selector treats as "refuse", never as either answer.
 */
function isAncestorOf(sha, head) {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', sha, head], { cwd: ROOT, stdio: 'ignore' })
    return true
  } catch (err) {
    if (err?.status === 1) return false
    console.error(`qa-freshness: could not test ancestry of ${sha}: ${err.message}`)
    return null
  }
}

/**
 * Files changed between the QA run's commit and the promotion head. Returns
 * null when git cannot answer — the caller fails closed on null, so a shallow
 * clone or an unreachable SHA can never be read as "nothing changed".
 */
function changedFilesSince(runSha, headSha) {
  if (!runSha) return null
  try {
    const out = execFileSync('git', ['diff', '--name-only', `${runSha}..${headSha}`], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    })
    return out.split('\n').filter(Boolean)
  } catch (err) {
    console.error(`qa-freshness: could not diff ${runSha}..${headSha}: ${err.message}`)
    return null
  }
}

/**
 * One money-path file's unified diff between the QA run's commit and the head.
 * `--unified=0` keeps context lines out of the answer, so `isVersionOnlyDiff`
 * only ever sees genuinely changed lines. Returns null when git cannot answer;
 * the caller treats null as behavioural.
 */
function fileDiffSince(runSha, headSha, file) {
  if (!runSha) return null
  try {
    return execFileSync('git', ['diff', '--unified=0', `${runSha}..${headSha}`, '--', file], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    })
  } catch (err) {
    console.error(`qa-freshness: could not diff ${file}: ${err.message}`)
    return null
  }
}

function mergeBase(a, b) {
  try {
    return execFileSync('git', ['merge-base', a, b], { cwd: ROOT, encoding: 'utf8' }).trim()
  } catch (err) {
    console.error(`qa-freshness: could not find merge-base ${a}..${b}: ${err.message}`)
    return null // -> changedFilesSince(null) -> null -> fails closed
  }
}

function main() {
  const repo = process.env.GITHUB_REPOSITORY
  const sourceBranch = process.env.SOURCE_BRANCH || ''
  const headSha = process.env.HEAD_SHA || 'HEAD'
  const freshnessHours = Number(process.env.FRESHNESS_HOURS || '30')

  if (!repo || !sourceBranch) {
    console.error('::error::qa-freshness: GITHUB_REPOSITORY and SOURCE_BRANCH are required.')
    process.exit(1)
  }

  const globs = loadMoneyPathGlobs()

  // Which run counts is decided by selectGreenRun on the run's SHA and jobs,
  // pinned by test (#2404); the query itself is pinned by greenRunQueryArgs.
  let latestGreenRun = null
  try {
    const { run, jobs, refused } = selectGreenRun(greenRunWindowFor(repo), {
      isAncestorOfHead: (sha) => isAncestorOf(sha, headSha),
      jobsFor: (databaseId) => jobsForRun(repo, databaseId),
    })
    for (const r of refused) {
      console.log(`qa-freshness: passed over run ${r.databaseId ?? '?'} (${r.event ?? '?'} at ${r.headSha ?? '?'}): ${r.reason}`)
    }
    latestGreenRun = run
    if (run) {
      console.log(`qa-freshness: anchoring to run ${run.databaseId} (${run.event} at ${run.headSha}, ${run.createdAt})`)
      const warning = completenessWarningFromJobs(jobs)
      if (warning) console.log(`::warning::${warning}`)
    }
  } catch (err) {
    console.error(`::error::qa-freshness: could not query workflow runs: ${err.message}`)
    process.exit(1)
  }

  // For a hotfix the question is only "does it touch money-path code at all",
  // asked against the MERGE BASE with main. A two-dot diff would blame the
  // hotfix for every money-path change main gained since it branched, naming
  // files it never touched — which trains operators to reach for qa-override on
  // exactly the branch type with the weakest coverage.
  const base = selectDiffBase({
    sourceBranch,
    latestGreenRun,
    resolveMergeBaseWithMain: () => mergeBase('origin/main', headSha),
  })
  const changed = changedFilesSince(base, headSha)
  let changedMoneyPathFiles = changed === null ? null : moneyPathFiles(changed, globs)

  // #2164: a money-path file whose entire diff is a release-bump version string
  // carries no behaviour, so it cannot make a green run stale. Reported rather
  // than silently dropped — an exclusion nobody can see is how a gate quietly
  // stops meaning what its name says.
  if (changedMoneyPathFiles !== null && changedMoneyPathFiles.length > 0) {
    const { behavioural, versionOnly } = partitionVersionOnly(
      changedMoneyPathFiles,
      (file) => fileDiffSince(base, headSha, file),
    )
    if (versionOnly.length > 0) {
      console.log(
        `qa-freshness: ${versionOnly.length} money-path file(s) changed only a release-bump ` +
          `version string and are not treated as uncovered (#2164):\n` +
          versionOnly.map((f) => `  - ${f}`).join('\n'),
      )
    }
    changedMoneyPathFiles = behavioural
  }

  const result = evaluate({
    sourceBranch,
    latestGreenRun,
    changedMoneyPathFiles,
    nowMs: Date.now(),
    freshnessHours,
  })

  if (!result.ok) {
    console.error(`::error::${result.message}`)
    process.exit(1)
  }
  console.log(`✅ ${result.message}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main()
}
