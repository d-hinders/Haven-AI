#!/usr/bin/env node
// #2678 measurement 3 of 4 — the `covers:` holes, the epic's LEADING indicator.
//
// Read-only, dependency-free. A thin reporting front-end over the check that
// `docs:check` runs, so the measurement and the gate can never disagree about
// what a gap is — there is one implementation, in `scripts/docs/covers-gaps.mjs`.
//
// ## The epic's 227 does not reproduce, and where it diverges is knowable
//
// The epic reports 227 (doc, uncovered file) pairs across 46 of 74 governed
// docs, and singles out two docs: `04-x402-payment-sequence.md` naming 26 real
// files of which 25 are uncovered, and `casp-risk-guardrails.md` at 15 of 15.
//
// The EXTRACTION half reproduces almost exactly — this instrument finds 26 real
// tracked files named by the first doc (the epic's own 26) and 16 by the second
// (the epic's 15). The SUBTRACTION half does not: 7 uncovered of 26, and 7 of
// 16. `casp-risk-guardrails.md` declares 61 `covers:` entries including 19
// globs; "15 of 15 uncovered" is only reachable if almost none of them were
// applied.
//
// Three readings of the subtraction were measured repo-wide:
//
//   | subtraction                         | pairs | docs |
//   |-------------------------------------|------:|-----:|
//   | none (every named tracked file)     |   285 |   52 |
//   | `covers:` entries as plain strings  |   178 |   45 |
//   | glob-expanded (what the gate does)  |   129 |   40 |
//
// 227 sits between the first two and matches none. Glob-expansion is the only
// reading that means anything operationally: "uncovered" has to mean "the
// coupling gate will not implicate this doc when that file changes", and the
// coupling gate expands globs. So this ships the third row, and #2678's body
// was corrected to 129 / 40 rather than the instrument fitted to 227.
import { scan } from '../covers-gaps.mjs'
import { row, heading } from './corpus.mjs'

const { results, docCount } = await scan()
const total = results.reduce((n, r) => n + r.gaps.length, 0)

heading('#2678 measurement 3/4 — `covers:` holes (the #1199 shape, counted)')
row('governed docs', docCount)
row('docs naming a file their `covers:` cannot reach', results.length)
row('total (doc, uncovered file) pairs', total)
row('epic body states', '227 / 46 of 74')

console.log('\n  Worst offenders:')
for (const r of [...results].sort((a, b) => b.gaps.length - a.gaps.length).slice(0, 8)) {
  console.log(`    ${String(r.gaps.length).padStart(3)}  ${r.doc}  (${r.covers.length} covers entries)`)
}
console.log(
  '\n  Every pair names a specific doc and a specific tracked file — run\n' +
    '  `node scripts/docs/covers-gaps.mjs --list` to see all of them. This is the\n' +
    '  figure that carries the epic: unlike an entry count, a pair is checkable.\n' +
    '  What the extraction does NOT catch is listed in covers-gaps.mjs and pinned\n' +
    '  by covers-gaps.test.mjs; the count is a floor, not an inventory.\n',
)
