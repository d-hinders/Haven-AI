#!/usr/bin/env node
/**
 * Classify a change's files against the money-path perimeter — and PROVE the
 * classifier works before believing its answer (#2423).
 *
 * A reporting tool, never a gate, on the same footing as
 * `money-path-restatement-scan.mjs`. It exists because every money-path pull
 * request states a classification in its body and in its CASP shard, and until
 * now that statement was produced by an ad-hoc snippet that left no artifact:
 * the next person could read the conclusion but could not re-derive it, and a
 * "no" from an instrument nobody has seen say "yes" is not evidence.
 *
 *   node scripts/ci/money-path-classify.mjs [<base-ref>]
 *
 * `<base-ref>` defaults to `origin/dev`. The diff is taken THREE-DOT
 * (`<base>...HEAD`), i.e. from the merge base, so a base that has moved since
 * you branched does not report other people's commits as your own.
 *
 * Two things it does that a hand-rolled snippet reliably forgets:
 *
 *   1. **It self-tests first.** Six files that MUST classify as money-path and
 *      six that MUST NOT are run through the real matcher. If any control
 *      disagrees, the tool exits non-zero and refuses to print a
 *      classification at all, because the classification would be worthless.
 *   2. **It uses `qa-freshness.mjs`'s own `matchesGlob`**, not a
 *      re-implementation. The gate that actually blocks promotion and the
 *      report that tells a human what to expect must not be two different
 *      matchers.
 *
 * Exit codes: 0 = self-test passed and classification printed (whatever it
 * found); 1 = the instrument is broken. Finding money-path files is NOT a
 * failure — it is the answer.
 */

import { execFileSync } from 'node:child_process'
import {
  loadMoneyPathGlobs,
  loadMoneyPathControlGlobs,
  matchesGlob,
} from './qa-freshness.mjs'

/**
 * Controls. Each is a real path pattern the perimeter is known to cover (or
 * known not to), chosen to exercise DIFFERENT globs rather than six variations
 * of one — a self-test that only proves a single glob works is barely a
 * self-test. Keep them in sync with `.github/money-path-globs.json`; if one of
 * these ever legitimately changes side, that is a perimeter change and belongs
 * in a reviewed diff, not in a silent edit here.
 */
const MUST_BE_MONEY_PATH = [
  'packages/backend/src/rails/sweep.ts',              // a named runtime file
  'packages/signer/**/anything.ts',                   // a package-wide glob
  'packages/mcp-server/src/tools.ts',                 // a src/** glob
  'packages/backend/src/db/migrations/060_example.sql', // a directory glob
  'scripts/ci/qa-freshness.mjs',                      // a control glob
  'scripts/release-bump.mjs',                         // a control glob
]

const MUST_NOT_BE_MONEY_PATH = [
  'packages/frontend/src/components/connect-agent/setup-copy.ts',
  'docs/operations/hosted-mcp.md',
  'README.md',
  'packages/cli/src/commands.ts',
  'packages/sdk/src/types.ts',
  'scripts/release-channel.mjs',
]

function classify(file, globs, controlGlobs) {
  return {
    runtime: globs.filter((g) => matchesGlob(file, g)),
    control: controlGlobs.filter((g) => matchesGlob(file, g)),
  }
}

const isMoneyPath = (c) => c.runtime.length > 0 || c.control.length > 0

function main() {
  const base = process.argv[2] ?? 'origin/dev'
  const globs = loadMoneyPathGlobs()
  const controlGlobs = loadMoneyPathControlGlobs()

  // ── 1. Self-test. Nothing below is trustworthy until this passes. ────────
  const failures = []
  for (const f of MUST_BE_MONEY_PATH) {
    if (!isMoneyPath(classify(f, globs, controlGlobs))) failures.push(`${f} should be money-path but is not`)
  }
  for (const f of MUST_NOT_BE_MONEY_PATH) {
    if (isMoneyPath(classify(f, globs, controlGlobs))) failures.push(`${f} should NOT be money-path but is`)
  }

  console.log('=== SELF-TEST — the classifier must be able to say YES and NO ===')
  for (const f of MUST_BE_MONEY_PATH) {
    const c = classify(f, globs, controlGlobs)
    console.log(`  ${isMoneyPath(c) ? 'YES ' : 'no  '} ${f.padEnd(54)} ${JSON.stringify([...c.runtime, ...c.control])}`)
  }
  for (const f of MUST_NOT_BE_MONEY_PATH) {
    console.log(`  ${isMoneyPath(classify(f, globs, controlGlobs)) ? 'YES ' : 'no  '} ${f}`)
  }
  if (failures.length > 0) {
    console.error('\n✗ SELF-TEST FAILED — refusing to classify, because the answer would be meaningless:')
    for (const f of failures) console.error(`    ${f}`)
    process.exit(1)
  }
  console.log(`=== SELF-TEST PASSED (${MUST_BE_MONEY_PATH.length} positive, ${MUST_NOT_BE_MONEY_PATH.length} negative) ===\n`)

  // ── 2. Classify the actual change. Three-dot: from the MERGE BASE. ───────
  const nameStatus = execFileSync('git', ['diff', '--name-status', `${base}...HEAD`], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [status, ...rest] = line.split('\t')
      return { status: status[0], file: rest[rest.length - 1] }
    })

  const counts = nameStatus.reduce((acc, { status }) => ({ ...acc, [status]: (acc[status] ?? 0) + 1 }), {})
  const runtime = []
  const control = []
  for (const { file } of nameStatus) {
    const c = classify(file, globs, controlGlobs)
    if (c.runtime.length > 0) runtime.push([file, c.runtime])
    else if (c.control.length > 0) control.push([file, c.control])
  }

  const mergeBase = execFileSync('git', ['merge-base', 'HEAD', base], { encoding: 'utf8' }).trim()
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()

  console.log(`=== CHANGE: ${base}...HEAD ===`)
  console.log(`  merge base : ${mergeBase}`)
  console.log(`  head       : ${head}`)
  console.log(`  files      : ${nameStatus.length}  (${Object.entries(counts).sort().map(([s, n]) => `${n} ${s}`).join(', ')})`)
  console.log('')
  for (const [file, g] of runtime) console.log(`  MONEY-PATH (globs)        ${file.padEnd(54)} ${JSON.stringify(g)}`)
  for (const [file, g] of control) console.log(`  MONEY-PATH (controlGlobs) ${file.padEnd(54)} ${JSON.stringify(g)}`)
  console.log('')
  console.log(`  ${runtime.length} runtime-glob + ${control.length} control-glob = ${runtime.length + control.length} of ${nameStatus.length} on the perimeter`)
  console.log(
    runtime.length > 0
      ? '  => MONEY-PATH. A runtime glob is matched, so a dev -> main promotion needs a\n' +
        '     covering green money-flow QA run. A CASP shard is required.'
      : control.length > 0
        ? '  => MONEY-PATH (control surface only). Labelled and read by a human; no QA\n' +
          '     re-run is implied, because the harness cannot exercise a CI control change.'
        : '  => not money-path by the file half. The LABEL half is a separate question:\n' +
          '     the rule is label OR file, never label AND file.',
  )
}

main()
