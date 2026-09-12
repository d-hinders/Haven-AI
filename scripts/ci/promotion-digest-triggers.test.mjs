// Pins the TRIGGERS of `.github/workflows/promotion-digest.yml`.
//
// The digest reports how many commits sit on `dev` and not on `main`. It
// originally refreshed on a push to `main` plus a Monday cron, which fails in
// one specific and self-concealing way: a stalled promotion means no push to
// `main` by definition, so the issue keeps serving a stale count for up to a
// week — and the count it serves UNDERSTATES the backlog, so the failure reads
// as reassurance rather than as breakage. On 2026-09-11 the issue said 28 while
// `git rev-list --count origin/main..origin/dev` said 50.
//
// The fix is a push trigger on `dev`: the branch whose movement IS the number.
// That trigger cannot go quiet while the backlog grows, the way a cron can.
// `guard-freshness.yml` states the same principle for the same reason.
//
// This suite exists because the failure is invisible at runtime. Dropping `dev`
// from the trigger list breaks nothing, fails no build, and produces a workflow
// that still runs, still succeeds, and still posts — just not when it matters.
// No integration test would catch that; only pinning the trigger does.
//
// Dependency-free by design (no js-yaml), matching the sibling suites in this
// directory: the `on:` block is read by hand, and a missing shape fails loudly
// rather than passing vacuously. WORKFLOW_PATH allows a fixture override the
// same way `ci-config-gate.test.mjs` uses CI_YML_PATH (an env var, not argv —
// `node --test` owns argv).
//
// Run with: node --test scripts/ci/promotion-digest-triggers.test.mjs
// (also collected by the `ci_config_checks` job's `scripts/ci/*.test.mjs` glob)

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const WORKFLOW = process.env.WORKFLOW_PATH
  ? path.resolve(process.env.WORKFLOW_PATH)
  : path.join(ROOT, '.github/workflows/promotion-digest.yml')

const workflow = readFileSync(WORKFLOW, 'utf8')

/** Leading-whitespace width of a line. */
const indentOf = (line) => (line.match(/^ */) || [''])[0].length

/**
 * The digest step's `run:` block as text — from the `run: |` line through the
 * line before the next key at or above its indentation. Returns null instead of
 * silently reading nothing, so a caller can assert loudly on a reshaped file
 * rather than pass vacuously on an empty string.
 */
function digestRunBlock(text) {
  const lines = text.split('\n')
  const start = lines.findIndex((l) => /^\s*run:\s*\|/.test(l))
  if (start === -1) return null
  const bodyIndent = indentOf(lines[start]) + 1
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].trim() === '') continue
    if (indentOf(lines[i]) < bodyIndent) {
      end = i
      break
    }
  }
  const block = lines.slice(start + 1, end).join('\n')
  return block.trim() === '' ? null : block
}

/**
 * The same block with whole-line `#` comments removed, for assertions about
 * what the step DOES. Without this, a comment that quotes the defect it warns
 * against — as the `| head` warning in this very workflow does — reads as the
 * defect itself, and the guard fails on the fixed file.
 */
function digestRunCode(text) {
  const block = digestRunBlock(text)
  if (block === null) return null
  return block
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n')
}

/**
 * The top-level `on:` block as lines — from the `on:` key through the line
 * before the next top-level key. Returns null instead of silently reading
 * nothing, so a caller can assert loudly on a reshaped file.
 *
 * The key is matched quoted or bare: some YAML linters demand `"on":` because
 * YAML 1.1 reads a bare `on` as boolean true.
 */
function onBlock(text) {
  const lines = text.split('\n')
  const start = lines.findIndex((l) => /^["']?on["']?:\s*$/.test(l))
  if (start === -1) return null
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    // A non-blank, non-comment line at column 0 ends the block.
    if (lines[i].trim() === '' || lines[i].trimStart().startsWith('#')) continue
    if (indentOf(lines[i]) === 0) {
      end = i
      break
    }
  }
  return lines.slice(start, end)
}

/**
 * Lines belonging to `key:` within `block` — the key's line excluded, its
 * deeper-indented children included, stopping at the next sibling or shallower
 * key. Scoping matters: reading the first `branches:` anywhere in the `on:`
 * block would silently pick up a `pull_request:` trigger's list instead.
 */
function childLines(block, key) {
  const i = block.findIndex((l) => new RegExp(`^\\s*${key}:\\s*$`).test(l))
  if (i === -1) return null
  const depth = indentOf(block[i])
  const out = []
  for (let j = i + 1; j < block.length; j++) {
    if (block[j].trim() === '') continue
    if (indentOf(block[j]) <= depth) break
    out.push(block[j])
  }
  return out
}

/**
 * The branch names under `push:`, accepting BOTH YAML sequence forms — the
 * inline flow `branches: [main, dev]` and the block form with `- main` on its
 * own line. Reading only one of them would red-light a correct workflow the
 * first time anyone reformats it, and a guard that fails for the wrong reason
 * is a guard that gets deleted rather than fixed.
 */
function pushBranches(block) {
  const push = childLines(block, 'push')
  if (!push) return null

  const inline = push.find((l) => /^\s*branches:\s*\[/.test(l))
  if (inline) {
    return inline
      .slice(inline.indexOf('[') + 1, inline.indexOf(']'))
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  }

  const seq = childLines(push, 'branches')
  if (!seq) return null
  return seq
    .filter((l) => /^\s*-\s*\S/.test(l))
    .map((l) => l.replace(/^\s*-\s*/, '').replace(/#.*$/, '').trim())
    .filter(Boolean)
}

/** Every `- cron: '...'` value under `schedule:`. */
function cronExpressions(block) {
  return block
    .filter((l) => /^\s*-\s*cron:/.test(l))
    .map((l) => {
      const m = l.match(/cron:\s*'([^']+)'/)
      return m ? m[1] : null
    })
    .filter(Boolean)
}

describe('promotion-digest.yml triggers', () => {
  const block = onBlock(workflow)

  test('the workflow has a parseable top-level on: block', () => {
    assert.notEqual(block, null, 'no top-level `on:` block found — the file was reshaped')
  })

  test('push covers dev — the branch whose movement IS the pending count', () => {
    const branches = pushBranches(block)
    assert.notEqual(branches, null, 'no `branches: [...]` list found under push:')
    // This is THE regression. Without `dev`, the digest only refreshes when a
    // promotion happens, so a stalled promotion serves a stale, understated
    // count indefinitely — the exact failure this trigger closes.
    assert.ok(
      branches.includes('dev'),
      `push must fire on dev, got [${branches.join(', ')}] — a stalled promotion would leave the count stale`,
    )
  })

  test('push still covers main — a landed promotion must clear the digest', () => {
    const branches = pushBranches(block)
    assert.notEqual(branches, null, 'no branch list found under push:')
    // The complementary direction: after a promotion the issue over-claims,
    // listing commits that have already shipped.
    assert.ok(
      branches.includes('main'),
      `push must fire on main, got [${branches.join(', ')}] — the digest would over-claim after a promotion`,
    )
  })

  test('the cron runs at least daily, because the trailing-7-day figures age with time', () => {
    const crons = cronExpressions(block)
    assert.ok(crons.length > 0, 'no cron schedule found — the quiet-period floor is gone')
    // The filing-bar figures (#2767) are computed over a trailing window, so
    // they age even when nothing is pushed, and on a day with no pushes the
    // cron is the only trigger that fires. Weekly let them drift a week stale.
    //
    // This pin is narrower in intent than the `dev` one above: the *regression*
    // is the push trigger, and this is a cadence judgement. If you are here
    // because you want a weekly floor again, that is a legitimate change —
    // decide it on the trailing-window argument and edit this test with it,
    // rather than working around the assertion.
    for (const expr of crons) {
      const fields = expr.trim().split(/\s+/)
      assert.equal(fields.length, 5, `cron '${expr}' is not a 5-field expression`)
      const [, , dayOfMonth, month, dayOfWeek] = fields
      assert.equal(dayOfWeek, '*', `cron '${expr}' is restricted to a weekday — it must run daily`)
      assert.equal(dayOfMonth, '*', `cron '${expr}' is restricted to a day of month — it must run daily`)
      assert.equal(month, '*', `cron '${expr}' is restricted to a month — it must run daily`)
    }
  })

  test('workflow_dispatch stays, so the digest can be forced by hand', () => {
    assert.ok(
      block.some((l) => /^\s*workflow_dispatch:/.test(l)),
      'workflow_dispatch was removed — there is no manual recovery path',
    )
  })

  test('the commit list is capped with `git log -n`, never by piping into `head`', () => {
    // 2026-09-12: this workflow failed for the first time, with exit 141, on
    // the push of the 0.1.37-alpha.0 release merge. Exit 141 is 128 + 13,
    // SIGPIPE. The step read:
    //
    //   list=$(git log --first-parent --pretty='- %s' origin/main..origin/dev | head -100)
    //
    // under `set -euo pipefail`. Once the first-parent count passes the cap,
    // `head` exits at its hundredth line and `git log` is killed on its next
    // write; `pipefail` promotes that to the step's exit status. The count was
    // 102.
    //
    // The comment above that line existed to explain that the cap prevents the
    // digest failing "exactly in the extreme case it exists to report" — a
    // stalled promotion. The cap was the thing that failed, in exactly that
    // case, and it self-conceals: the next promotion resets the count to 0 and
    // the workflow goes green, so the evidence disappears until `dev` next
    // passes the cap.
    //
    // It is a race, and the workflow comment carries the measured rates. What
    // matters here is that no pass rate makes the pipeline safe, so this guard
    // pins the shape rather than any observed behaviour.
    //
    // Scoped to the whole `run:` block, not just the assignment line: a `head`
    // one line further down would be the same defect.
    const runBlock = digestRunCode(workflow)
    assert.ok(
      runBlock,
      'the digest step’s `run:` block could not be located — re-point this guard',
    )
    assert.doesNotMatch(
      runBlock,
      /\|\s*head\b/,
      'the digest step must not pipe into `head`: under `set -euo pipefail` that ' +
        'exits 141 (SIGPIPE) once the output exceeds what `head` consumes. Use `git log -n <cap>`.',
    )

    const listAssignment = runBlock
      .split('\n')
      .find((l) => /^\s*list=\$\(git log\b/.test(l))
    assert.ok(
      listAssignment,
      'the `list=$(git log …)` assignment was renamed or reshaped — re-point this guard',
    )
    // Accepts a literal (`-n 100`) or an indirection (`-n "$CAP"`): a correct
    // reformat must not turn this red. `pushBranches` above takes the same
    // posture for the same reason — a guard that fails for the wrong reason is
    // a guard that gets deleted rather than fixed.
    assert.match(
      listAssignment,
      /\s-n\s+("?\$\{?\w+\}?"?|\d+)/,
      'the commit list must still be capped, with `git log -n <cap>` — an uncapped ' +
        'list can exceed GitHub’s 65,536-character issue-body limit and 422 the step',
    )
  })

  test('the `-n` cap and the "…and N more" arithmetic use the same number', () => {
    // The cap appears three times — `git log -n <cap>`, `[ "$count" -gt <cap> ]`
    // and `$((count - <cap>))` — as three independent literals. Raising only the
    // first (say to 100000) is silently accepted by the guard above while
    // breaking both things the cap exists for: the body becomes unbounded, and
    // the remainder line under-reports, since the list would carry more than
    // <cap> entries while N is still computed against 100.
    //
    // Measured: the full first-parent list on this repo is ~136 kB, over twice
    // GitHub's 65,536-character limit, so an unbounded body is a real 422 and
    // not a theoretical one.
    //
    // Skipped when the cap is an indirection rather than a literal: a single
    // `CAP=` variable threaded through all three sites is strictly better than
    // what is here, and this guard must not stand in its way.
    const runBlock = digestRunCode(workflow)
    assert.ok(runBlock, 'the digest step’s `run:` block could not be located')

    const logCap = runBlock.match(/list=\$\(git log\b[^\n]*?\s-n\s+(\d+)/)
    if (!logCap) return // indirection, or reshaped — covered by the test above

    const gtCap = runBlock.match(/\[\s*"\$count"\s*-gt\s*(\d+)\s*\]/)
    const subCap = runBlock.match(/\$\(\(\s*count\s*-\s*(\d+)\s*\)\)/)
    assert.ok(gtCap, 'the `[ "$count" -gt <cap> ]` branch was reshaped — re-point this guard')
    assert.ok(subCap, 'the `$((count - <cap>))` remainder was reshaped — re-point this guard')

    assert.equal(
      gtCap[1],
      logCap[1],
      `the \`-gt\` threshold (${gtCap[1]}) must equal the \`git log -n\` cap (${logCap[1]}), ` +
        'or the remainder line is computed against a cap the list does not use',
    )
    assert.equal(
      subCap[1],
      logCap[1],
      `the \`count - N\` remainder (${subCap[1]}) must equal the \`git log -n\` cap (${logCap[1]})`,
    )
  })

  test('concurrency still collapses bursts — dev merges arrive in clusters', () => {
    // With `dev` in the trigger list this workflow fires on every merge, which
    // on this repo can be 20+ times a day and sometimes twice within a minute.
    // cancel-in-progress is what keeps that from queueing redundant upserts.
    //
    // Asserted as two independent matches rather than one regex spanning both
    // lines: swapping the two mapping keys is valid YAML with identical
    // semantics, and should not turn this red.
    assert.match(
      workflow,
      /concurrency:\s*\n(?:\s*\S+:.*\n)*?\s*group:\s*promotion-digest\b/,
      'the concurrency group must be named promotion-digest',
    )
    assert.match(
      workflow,
      /concurrency:\s*\n(?:\s*\S+:.*\n)*?\s*cancel-in-progress:\s*true\b/,
      'concurrency must cancel in progress, or clustered dev merges queue redundant runs',
    )
  })
})
