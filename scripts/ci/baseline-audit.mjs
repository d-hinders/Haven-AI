#!/usr/bin/env node
// Baseline-change audit (#2218) — runs between "Regenerate baselines" and
// "Commit baselines to the branch" in .github/workflows/update-visual-baselines.yml.
//
// ## The defect this exists for
//
// The workflow ran Playwright with a hardcoded `--update-snapshots=all`. In the
// installed Playwright (1.60.0, `playwright/lib/matchers/expect.js`), `all`
// passes `expected: undefined` into `_expectScreenshot`, so NO comparison
// happens; the baseline is then rewritten whenever the bytes differ:
//
//     expectScreenshotOptions.expected = helper.updateSnapshots === 'all' ? void 0 : expected
//     ...
//     if (!errorMessage) {
//       if (helper.updateSnapshots === 'all' && actual && compareBuffersOrStrings(actual, expected)) {
//         return writeFiles(actual)          // <- byte difference, not a failure
//       }
//       return helper.handleMatching()
//     }
//
// So a dispatch aimed at ONE deliberately-changed baseline re-blesses every
// other baseline whose render happens to differ by a byte. Measured on PR #2217:
// `unmanaged-delegate-card-desktop.png` was rewritten with a max channel delta
// of 1 across a one-pixel column at x=0 — 180 px of 266,448 — while its test was
// passing and its fixture seeds `agents: []`, so the changed component never
// renders in it at all. It was caught only because someone diffed all 22 blob
// hashes by hand, and reverted in `02e3b719`.
//
// ## Why the flag change alone was not judged sufficient
//
// The workflow's default is now `--update-snapshots=changed`, which re-applies
// the spec's tolerance and rewrites only what actually FAILS comparison. That
// closes the measured instance directly and is the primary fix.
//
// But `all` cannot simply be deleted, and that is the whole reason this file
// exists. #1760 made `=all` load-bearing: `changed` refuses to rewrite drift
// that sits UNDER the gate's tolerance, which once made a 2,084-pixel stale
// TopBar band permanently un-refreshable — every regeneration anyone dispatched
// reported "Baselines unchanged" and committed nothing. A full refresh has to
// stay reachable, so the unsafe mode survives as a deliberate, declared act
// rather than as the default. Something has to watch that path, and "the author
// remembers to diff 22 blob hashes" is exactly the control that failed.
//
// Hence: the flag fixes the default, and this audit covers what the flag cannot
// — the `all` path, plus any dispatch where the author wants to state up front
// which baselines they came here to move.
//
// ## What it does, in one line each
//
//   - ALWAYS reports the blob-hash delta of every baseline the run touched, into
//     the job summary and the log. The audit that caught #2217, run every time,
//     by nobody in particular.
//   - When the dispatcher declared an `expected` set, FAILS the run if anything
//     outside it moved — before the commit step, so the undeclared change is
//     never pushed.
//   - Requires that declaration when mode is `all`, because `all` is the mode
//     that cannot tell an intended change from sub-threshold noise.
//
// ## What it deliberately does NOT do
//
//   - It does not block the default path. `mode=changed` with no `expected` is
//     one dispatch, no extra inputs, exit 0 — regenerating a genuinely-changed
//     baseline stays a single click. A guard that fires on every dispatch would
//     be routed around within a week, and routing around it means running
//     `--update-snapshots` locally, which is worse than where we started.
//   - It does not re-derive "was this baseline failing?" from the pixels. That
//     question is `changed`'s to answer, in Playwright, with the spec's own
//     comparator and tolerances. A second, approximate copy of the comparison
//     living here would drift against the real gate and be believed anyway.
//   - It does not fail when a DECLARED baseline did not move. That is worth
//     saying out loud (the dispatch achieved nothing you asked for), but
//     blocking on it would throw away the other, declared, safe changes in the
//     same run to punish an over-broad declaration.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'

/** The only tree this workflow is allowed to commit, and so the only tree audited. */
export const BASELINE_DIR = 'packages/frontend/e2e/__screenshots__'

/**
 * Read the workflow's `mode` input.
 *
 * FAIL-CLOSED, and the direction matters: anything that is not exactly `all`
 * reads as `changed`. A typo in the workflow wiring therefore yields the SAFE
 * mode, and its consequence is loud rather than silent — a full refresh that
 * quietly ran as `changed` reports "no baselines moved" instead of blessing
 * renders nobody compared.
 */
export function parseMode(raw) {
  return String(raw ?? '').trim().toLowerCase() === 'all' ? 'all' : 'changed'
}

/**
 * Read the workflow's `expected` input into a set of baseline file names.
 *
 * Accepts commas, newlines and spaces as separators, tolerates a full path or a
 * bare name, and tolerates a missing `.png`, because this is typed by a human
 * into a dispatch form under mild irritation. `*` is the wildcard: "I know this
 * moves an unknown set and I am accepting all of it" — the #1760 full-refresh
 * case, which is a real need and is now at least written down in the run's
 * inputs and in the commit message.
 *
 * Matching is on the BASE NAME. Two specs could in principle own baselines with
 * the same base name, and one declaration would then cover both; the names are
 * distinct today and a collision is visible in the report, which prints full
 * paths. The alternative — demanding the full path — buys a case we do not have
 * at the cost of the case we do.
 */
export function parseExpected(raw) {
  const parts = String(raw ?? '')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
  const out = []
  for (const part of parts) {
    if (part === '*') {
      out.push('*')
      continue
    }
    const base = part.split('/').pop()
    out.push(base.toLowerCase().endsWith('.png') ? base : `${base}.png`)
  }
  return [...new Set(out)]
}

/** The base name a declaration is matched against. */
export function baselineName(path) {
  return String(path).split('/').pop()
}

/**
 * Decide the run's outcome. Pure; every branch is unit-tested.
 *
 * `changes` is `[{ path, status, before, after }]` — status one of
 * `modified` | `added` | `deleted`, `before`/`after` short blob hashes (`null`
 * for an add's before and a delete's after).
 */
export function auditBaselines({ mode, expected, changes }) {
  const moved = [...changes].sort((a, b) => a.path.localeCompare(b.path))
  const declared = expected ?? []
  const wildcard = declared.includes('*')

  if (!moved.length) {
    return {
      outcome: 'no-change',
      exitCode: 0,
      moved,
      undeclared: [],
      missing: declared.filter((d) => d !== '*'),
      summary:
        'No baseline moved. Nothing will be committed. ' +
        (mode === 'changed'
          ? 'Under `changed` that means every baseline still matches within the spec tolerance — ' +
            'if you came here to refresh sub-tolerance drift, re-dispatch with mode `all`.'
          : 'Under `all` that means every baseline is byte-identical to its render.'),
    }
  }

  // `all` blesses whatever rendered without comparing anything, so it must not
  // run without the dispatcher saying what they came for. The message hands
  // back the exact list, so satisfying this is a paste, not a research task.
  if (mode === 'all' && !declared.length) {
    return {
      outcome: 'undeclared-full-refresh',
      exitCode: 1,
      moved,
      undeclared: moved,
      missing: [],
      summary:
        `Mode \`all\` rewrites a baseline on ANY byte difference, without comparing it against the ` +
        `spec's tolerance — that is the #2218 defect, and it is why this mode requires you to say ` +
        `what you expect to move. ${moved.length} baseline(s) moved and nothing was declared, so ` +
        `nothing was committed. Re-dispatch with \`expected\` set to the names below (or \`*\` if a ` +
        `full refresh is genuinely what you want), or with mode \`changed\`, which only rewrites ` +
        `baselines that actually fail comparison:\n` +
        moved.map((c) => `  ${baselineName(c.path)}`).join('\n'),
    }
  }

  const missing = declared.filter((d) => d !== '*' && !moved.some((c) => baselineName(c.path) === d))

  if (!declared.length) {
    // The default path: `changed` with no declaration. Playwright already
    // refused to touch anything that passed comparison, so this is a report.
    return {
      outcome: 'reported',
      exitCode: 0,
      moved,
      undeclared: [],
      missing,
      summary:
        `${moved.length} baseline(s) failed comparison and were regenerated. ` +
        `Every one of them is listed above with its before/after blob hash — check that the list is ` +
        `the list you expected before you approve the commit.`,
    }
  }

  const undeclared = wildcard ? [] : moved.filter((c) => !declared.includes(baselineName(c.path)))

  if (undeclared.length) {
    return {
      outcome: 'undeclared-change',
      exitCode: 1,
      moved,
      undeclared,
      missing,
      summary:
        `${undeclared.length} baseline(s) moved that you did not declare. Nothing was committed.\n` +
        undeclared.map((c) => `  ${baselineName(c.path)}  ${c.before ?? '(new)'} -> ${c.after ?? '(deleted)'}`).join('\n') +
        `\n\nThis is the #2218 failure mode caught before it lands: a baseline you did not ask about, ` +
        `re-stamped as the new truth. Diff it against its previous blob before deciding — if the change ` +
        `is real, add it to \`expected\` and re-dispatch; if it is sub-threshold noise, re-dispatch with ` +
        `mode \`changed\`, which will leave it alone.`,
    }
  }

  return {
    outcome: wildcard ? 'declared-wildcard' : 'declared',
    exitCode: 0,
    moved,
    undeclared: [],
    missing,
    summary: wildcard
      ? `Full refresh accepted by an explicit \`*\`: ${moved.length} baseline(s) moved, all of them blessed ` +
        `without comparison. This is the #1760 escape hatch — the run's inputs and the commit message ` +
        `record that it was a deliberate choice.`
      : `${moved.length} baseline(s) moved, all of them declared.`,
  }
}

/** The job-summary / log body. Pure so its shape is asserted rather than eyeballed. */
export function renderReport({ mode, expected, result }) {
  const declared = expected?.length ? expected.join(', ') : '(none)'
  const lines = [
    `### Baseline change audit (#2218)`,
    ``,
    `- mode: \`${mode}\``,
    `- declared \`expected\`: \`${declared}\``,
    `- baselines moved: **${result.moved.length}**`,
    ``,
  ]
  if (result.moved.length) {
    lines.push(`| baseline | change | before | after |`, `| --- | --- | --- | --- |`)
    for (const c of result.moved) {
      const flag = result.undeclared.some((u) => u.path === c.path) ? ' ⚠️ undeclared' : ''
      lines.push(`| \`${c.path}\` | ${c.status}${flag} | \`${c.before ?? '—'}\` | \`${c.after ?? '—'}\` |`)
    }
    lines.push(``)
  }
  if (result.missing.length) {
    lines.push(
      `> ⚠️ Declared but did NOT move: ${result.missing.map((m) => `\`${m}\``).join(', ')}. ` +
        `Not a failure — but the dispatch did not do the thing you asked for, so check the render ` +
        `before assuming the baseline is now current.`,
      ``,
    )
  }
  lines.push(result.exitCode === 0 ? `✅ ${result.summary}` : `❌ ${result.summary}`)
  return lines.join('\n')
}

/** One line for the commit message trailer, so the delta survives in git history. */
export function commitTrailer({ mode, result }) {
  return `Regenerated with --update-snapshots=${mode}; baselines moved: ${
    result.moved.map((c) => baselineName(c.path)).join(', ') || '(none)'
  }`
}

// ---------------------------------------------------------------------------
// IO — thin, and kept out of the tested surface above on purpose.
// ---------------------------------------------------------------------------

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
}

function shortHash(value) {
  return value ? value.slice(0, 9) : null
}

function blobInHead(path) {
  try {
    return shortHash(git(['rev-parse', `HEAD:${path}`]).trim())
  } catch {
    return null // not in HEAD -> an added baseline
  }
}

function blobOnDisk(path) {
  if (!fs.existsSync(path)) return null
  return shortHash(git(['hash-object', path]).trim())
}

/**
 * Parse `git status --porcelain=v1 -z` into `[{ code, path }]`.
 *
 * Pure, and split out from the IO for one reason found in review: the `-z`
 * stream is NOT one record per NUL. A rename or copy emits TWO fields —
 * `"R  new/path\0old/path\0"` — and the second carries no `XY ` prefix. A loop
 * that slices `(0,2)` and `(3)` off every field reads the first two characters
 * of the ORIGINAL path as a status code and chops three characters off its
 * front, manufacturing a phantom entry that still ends in `.png` and is then
 * audited as a change nobody made.
 *
 * That is unreachable in this workflow today (the audit runs before any
 * `git add`, and git only pairs a rename into the two-field form once it is
 * STAGED), which is exactly why it would have sat here untested until a step
 * reorder made it live. It fails toward a false "undeclared baseline moved" —
 * a blocked commit on nothing — which is the crying-wolf outcome this whole
 * design is trying to avoid, so it is handled rather than noted.
 */
export function parseStatusZ(raw) {
  const fields = String(raw ?? '').split('\0')
  const out = []
  for (let i = 0; i < fields.length; i += 1) {
    const entry = fields[i]
    if (!entry) continue
    const code = entry.slice(0, 2)
    out.push({ code, path: entry.slice(3) })
    // R (rename) and C (copy) consume the following field as the source path.
    // It is not a change of its own and must not be re-parsed as one.
    if (code.includes('R') || code.includes('C')) i += 1
  }
  return out
}

/**
 * Every baseline the regeneration touched, read from git rather than from a
 * hash map we captured ourselves. A content hash proves the file; git proves
 * what the repository will actually commit, which is the thing being audited.
 *
 * `-uall` matters: without it a brand-new baseline inside a brand-new spec
 * directory is reported as the DIRECTORY, and the audit would report one
 * "change" whose name is a folder.
 */
export function collectChanges(dir = BASELINE_DIR) {
  const changes = []
  for (const { code, path } of parseStatusZ(git(['status', '--porcelain=v1', '-z', '-uall', '--', dir]))) {
    if (!path.endsWith('.png')) continue
    const added = code.includes('?') || code.includes('A')
    const deleted = code.includes('D')
    changes.push({
      path,
      status: added ? 'added' : deleted ? 'deleted' : 'modified',
      before: added ? null : blobInHead(path),
      after: deleted ? null : blobOnDisk(path),
    })
  }
  return changes
}

function main() {
  const mode = parseMode(process.env.UPDATE_MODE)
  const expected = parseExpected(process.env.EXPECTED_BASELINES)
  const result = auditBaselines({ mode, expected, changes: collectChanges() })
  const report = renderReport({ mode, expected, result })

  console.log(report)
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`)
  }
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(
      process.env.GITHUB_OUTPUT,
      `trailer=${commitTrailer({ mode, result })}\n`,
    )
  }
  if (result.exitCode !== 0) {
    console.log(`::error::Baseline audit blocked the commit (${result.outcome}). See the job summary.`)
  }
  // NOT process.exit(): stdout is a pipe under Actions, and exiting immediately
  // can truncate the report this step exists to emit.
  process.exitCode = result.exitCode
}

if (process.argv[1] && process.argv[1].endsWith('baseline-audit.mjs')) {
  try {
    main()
  } catch (err) {
    console.log(`::error::baseline-audit crashed: ${err.stack ?? err.message}`)
    process.exitCode = 1
  }
}
