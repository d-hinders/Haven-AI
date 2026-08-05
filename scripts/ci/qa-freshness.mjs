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
// KNOWN LIMIT on the dev path, stated rather than papered over: the run's
// `headSha` is the branch tip when the run was TRIGGERED, not necessarily the
// SHA deployed to dev. For the `repository_dispatch: dev-deployed` trigger they
// coincide; for the nightly cron a lagging or failed dev deploy makes the run's
// headSha overstate what was exercised.
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
 * The exact `gh run list` query the gate trusts (#1047 wiring test): always
 * dev's runs — a hotfix has no valid evidence of its own — always this
 * workflow, only successes, newest one.
 */
export function greenRunQueryArgs(repo) {
  return [
    'run',
    'list',
    '--repo',
    repo,
    '--workflow',
    'qa-dev.yml',
    '--branch',
    'dev',
    '--status',
    'success',
    '--limit',
    '1',
    '--json',
    'createdAt,headSha,databaseId',
  ]
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

function latestGreenRunFor(repo) {
  const out = gh(greenRunQueryArgs(repo))
  const rows = JSON.parse(out || '[]')
  return rows.length ? rows[0] : null
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

  // Always dev's runs — the decision lives in greenRunQueryArgs, pinned by test.
  let latestGreenRun = null
  try {
    latestGreenRun = latestGreenRunFor(repo)
    if (latestGreenRun?.databaseId) {
      try {
        const jobsOut = gh([
          'api',
          `repos/${repo}/actions/runs/${latestGreenRun.databaseId}/jobs`,
          '--jq',
          '{jobs: [.jobs[] | {steps: [.steps[] | {name, conclusion}]}]}',
        ])
        const warning = completenessWarningFromJobs(JSON.parse(jobsOut || '{}').jobs)
        if (warning) console.log(`::warning::${warning}`)
      } catch {
        // Advisory only — a jobs-API hiccup must not fail the gate.
      }
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
  const changedMoneyPathFiles = changed === null ? null : moneyPathFiles(changed, globs)

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
