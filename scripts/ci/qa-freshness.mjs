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
// Both are closed below. The gate now proves: "a green money-flow run covered
// the money-path code being promoted."
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

export function loadMoneyPathGlobs(root = ROOT) {
  const raw = JSON.parse(readFileSync(path.join(root, GLOBS_FILE), 'utf8'))
  if (!Array.isArray(raw.globs) || raw.globs.length === 0) {
    throw new Error(`${GLOBS_FILE}: "globs" must be a non-empty array`)
  }
  return raw.globs
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
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')
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

  // --- Gap 2: hotfix/* -------------------------------------------------------
  // A hotfix has never been on `dev`, so a green dev run says nothing about it.
  // Only money-path hotfixes need their own run: gating every hotfix on a QA
  // cycle would defeat the purpose of having a hotfix path at all, and a
  // hotfix touching no money-path file is not what this gate protects.
  if (isHotfix) {
    if (changedMoneyPathFiles === null) {
      return {
        ok: false,
        code: 'hotfix_diff_unknown',
        message:
          `Could not determine whether this hotfix touches money-path files. ` +
          `Failing closed — a hotfix reaches production without ever being on 'dev'. ${RERUN}`,
      }
    }
    if (changedMoneyPathFiles.length === 0) {
      return {
        ok: true,
        code: 'hotfix_no_money_path',
        message:
          'Hotfix touches no money-path files — the dev-based money-flow gate does not apply.',
      }
    }
    if (!latestGreenRun) {
      return {
        ok: false,
        code: 'hotfix_no_run',
        message:
          `This hotfix touches money-path files (${changedMoneyPathFiles.join(', ')}) and has ` +
          `NO green money-flow QA run of its own. A green run on 'dev' is evidence about ` +
          `different code. Run the money-flow QA against this branch, or add 'qa-override' ` +
          `with a stated reason.`,
      }
    }
    // fall through to the staleness check below, against the hotfix's own run
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
        `money-flow QA against the current dev deploy before promoting, or add 'qa-override'.`,
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

// ---------------------------------------------------------------------------
// CLI — the IO shell. Everything above is pure and tested.
// ---------------------------------------------------------------------------

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trim()
}

function latestGreenRunFor(repo, branch) {
  const out = gh([
    'run',
    'list',
    '--repo',
    repo,
    '--workflow',
    'qa-dev.yml',
    '--branch',
    branch,
    '--status',
    'success',
    '--limit',
    '1',
    '--json',
    'createdAt,headSha',
  ])
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
  // A hotfix is judged against its OWN runs; `dev` against dev's.
  const queryBranch = sourceBranch.startsWith('hotfix/') ? sourceBranch : 'dev'
  let latestGreenRun = null
  try {
    latestGreenRun = latestGreenRunFor(repo, queryBranch)
  } catch (err) {
    console.error(`::error::qa-freshness: could not query workflow runs: ${err.message}`)
    process.exit(1)
  }

  // For a hotfix with no run of its own we still need the diff, to decide
  // whether it touches the money path at all. Compare against `origin/main` —
  // what the hotfix would change in production.
  const base = sourceBranch.startsWith('hotfix/')
    ? (latestGreenRun?.headSha ?? 'origin/main')
    : latestGreenRun?.headSha
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
