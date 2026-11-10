#!/usr/bin/env node
// Shrink-only line ceiling on LARGE backend route files (#4762, epic #4759
// slice 3).
//
// Slices 1 and 2 (#4760, #4761) moved the payments lifecycle out of
// `routes/payments.ts`, which fell from 1572 lines to 291. Nothing stopped it —
// or any other route — from growing back, so this gate freezes the large ones.
//
// THE DESIGN, and why it is shaped this way:
//
//   - A route file at or under THRESHOLD lines counts as ZERO and needs no
//     baseline entry. A new, small route file therefore passes with no
//     ceremony, and a file that shrinks under the threshold simply disappears
//     from the baseline on `--update`.
//   - A file over the threshold counts as its line count, one baseline entry
//     per file. The shared engine's rules then do the work: a count above its
//     entry fails, a file over the threshold with no entry fails (allowance 0),
//     and `--update` lowers entries and refuses to raise or add one.
//   - The escape hatch is a reviewed hand edit of the baseline JSON, defended
//     in the PR that needs it — the same contract
//     `packages/backend/dep-lint-callsite-ceiling.json` records in
//     docs/architecture/10-module-boundaries.md. A net-additive fix to a large
//     route, a security fix included, is therefore never blocked; it is made
//     visible.
//
// It is its OWN script rather than a mode of `scripts/dep-lint.mjs`: that gate
// does not use the ratchet engine and keeps a differently shaped file.
//
// Why a line ceiling and not boundary rule 5: rule 5 (routes import module
// entry points only) is recorded as waiting for a top-level `http/` directory,
// and the 50 route files import `../infra/repositories/` 90 times and
// `../rails/` 33 times today — a rule that fires on all of them needs its own
// epic. A line ceiling holds the gain from slices 1 and 2 now, and also makes
// growth of the three large routes the epic leaves out of scope a reviewed act.
//
//   node scripts/lint-route-line-ceiling.mjs            # check against the baseline
//   node scripts/lint-route-line-ceiling.mjs --update   # tighten after a reduction
//                                                       # (refuses to ratchet upward)
//
// `--root=<dir>` points the scan and the baseline at another tree; the
// self-test uses it to drive the real CLI over fixtures rather than a copy.
import { readFile, readdir } from 'node:fs/promises'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  newViolations,
  hasShrunk,
  writeBaseline,
  loadBaseline,
  updateRefusals,
  zeroScanEntries,
  ACCEPT_NEW_BASELINE_FLAG,
  firstRunRefusalMessage,
  runGate,
} from './lib/ratchet.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
export const DEFAULT_ROOT = join(HERE, '..')
/** The one directory this gate polices, repo-root-relative. */
export const ROUTES_DIR = 'packages/backend/src/routes'
/** The committed baseline, repo-root-relative. */
export const BASELINE_REL = 'packages/backend/route-line-ceiling.json'
/** A route file at or under this many lines counts as zero. */
export const THRESHOLD = 400
/** The engine's per-file key dimension: this gate counts one thing per file. */
export const KEY = 'lines'

/**
 * Line count with `wc -l` semantics — the measure the issue and the doc's
 * "Largest route" row are stated in, so the baseline and a hand `wc -l` agree.
 *
 * `source.split('\n').length` is NOT that measure: it reports one extra for
 * every file that ends with a newline, which is every file in this repo. A
 * baseline written with the off-by-one would disagree with the number a reader
 * measures by hand, and the disagreement would look like a violation.
 */
export function countLines(source) {
  if (source === '') return 0
  let newlines = 0
  for (let i = 0; i < source.length; i++) if (source.charCodeAt(i) === 10) newlines++
  return source.endsWith('\n') ? newlines : newlines + 1
}

/**
 * Scan the route directory and return `{ counts, fileCount }`.
 *
 * `counts` holds ONLY files over the threshold, keyed by repo-root-relative
 * path — that is what makes a small file free and a shrunk file's entry
 * disappear on `--update`. `fileCount` is the census the zero-scan refusal
 * reads (#3230): a moved or deleted routes directory would otherwise read as
 * "0 files over the ceiling" and print a clean verdict.
 *
 * Direct children only, `.ts` only, `.test.ts` excluded — the issue's scope is
 * "a non-test `.ts` file directly under `packages/backend/src/routes/`".
 */
export async function scan(root = DEFAULT_ROOT) {
  const dir = join(root, ROUTES_DIR)
  const counts = {}
  let fileCount = 0
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    entries = [] // an unreadable dir yields nothing; main's census refuses the run
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue
    const lines = countLines(await readFile(join(dir, entry.name), 'utf8'))
    fileCount += 1
    if (lines > THRESHOLD) counts[`${ROUTES_DIR}/${entry.name}`] = { [KEY]: lines }
  }
  return { counts, fileCount }
}

const REMEDY =
  `A backend route file over ${THRESHOLD} lines may not grow. Move the new code into a\n` +
  'module under packages/backend/src/modules/** and import it from the route.\n' +
  '\n' +
  'If the growth is genuinely net-additive and reviewed — a security fix, say —\n' +
  `hand-edit ${BASELINE_REL} to the new count and defend that in the PR.\n` +
  '`--update` will not raise an entry for you; that is the point.'

async function main() {
  const args = process.argv.slice(2)
  const rootFlag = args.find((a) => a.startsWith('--root='))
  const root = rootFlag ? rootFlag.slice('--root='.length) : DEFAULT_ROOT
  const baselinePath = join(root, BASELINE_REL)

  const { counts, fileCount } = await scan(root)

  // The zero-scan refusal (#3230): a routes directory matching no files means
  // the gate is scanning less than it claims, and over an emptied tree it would
  // print a clean verdict and advise `--update` — which would lock the zero in
  // as the baseline.
  const zeroDirs = zeroScanEntries([ROUTES_DIR], new Map([[ROUTES_DIR, fileCount]]))
  if (zeroDirs.length > 0) {
    console.error(`✗ lint-route-line-ceiling — ${ROUTES_DIR} matched no source files.`)
    console.error(
      '\nThe gate read no route files — a moved or deleted directory is a defect, not a\n' +
        'pending one, and the verdict (or --update write) over an empty scan would hide it.\n' +
        'Repoint ROUTES_DIR; do not leave the gate scanning nothing.',
    )
    process.exit(1)
  }

  const { baseline, firstRun } = loadBaseline(baselinePath)
  const acceptNew = args.includes(ACCEPT_NEW_BASELINE_FLAG)
  const over = Object.keys(counts).length
  console.log(
    `route-line ceiling: ${over} route file(s) over ${THRESHOLD} lines, ${fileCount} route file(s) read.`,
  )

  if (args.includes('--update')) {
    const violations = updateRefusals(counts, baseline, { firstRun, acceptNew })
    if (violations.length > 0) {
      console.error('✗ --update refuses to RAISE the baseline. Grown or new:')
      for (const v of violations) console.error(`  ${v.file} [${v.key}]: ${v.allowed} → ${v.count}`)
      if (firstRun) console.error(firstRunRefusalMessage(firstRun))
      console.error(`\n${REMEDY}`)
      process.exit(1)
    }
    writeBaseline(baselinePath, counts)
    console.log(`✓ baseline written (${relative(process.cwd(), baselinePath) || baselinePath}) from ${fileCount} route file(s).`)
    return
  }

  const violations = newViolations(counts, baseline)
  if (violations.length > 0) {
    console.error(`\n✗ backend route files grew past their shrink-only line ceiling (#4762):\n`)
    for (const v of violations) {
      console.error(`  ${v.file} [${v.key}]: baseline ${v.allowed}, now ${v.count}`)
    }
    console.error(`\n${REMEDY}`)
    console.error(
      '\nIf you legitimately REDUCED a route elsewhere, run:\n' +
        '  node scripts/lint-route-line-ceiling.mjs --update',
    )
    process.exit(1)
  }

  if (hasShrunk(counts, baseline)) {
    console.log(
      '  (a route fell below its ceiling — lock in the progress: node scripts/lint-route-line-ceiling.mjs --update)',
    )
  }
  console.log(`✓ no backend route file grew past its ceiling (${over} over ${THRESHOLD} lines, ${fileCount} read).`)
}

// Run only as a CLI (the scanner is imported by the self-test).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runGate('lint-route-line-ceiling', main)
}
