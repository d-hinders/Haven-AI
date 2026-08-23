// Measurement tool for the "fifth copy" question (#1899 → #1904).
//
// THIS IS NOT A GATE. It always exits 0 and raises no alarm. It exists so the
// measurement that CLOSED #1904 can be re-derived in one command instead of
// reinvented, and so its instrument can be shown to work before anyone trusts
// another negative result from it.
//
// The question it answers
// -----------------------
// #1899 sketched a general detector for prose copies of the money-path list:
// scan every tracked .md/.yml outside the known homes, count distinct
// perimeter basenames per file, fail above a threshold. #1904 measured it and
// found it cannot discriminate. This file is that measurement.
//
// Three candidate signals were measured on the tree at 345bb582. All three
// failed, in different ways:
//
//   1. count  — distinct perimeter basenames anywhere in the file.
//      Ordinary prose reaches 15 (CLAUDE.md, delegation-rail-security-model.md).
//      The real copies score 28-37. A window exists today, but it is two
//      documents wide and the suggested threshold of 8 fires on 14 ordinary
//      docs. Any new architecture doc closes it.
//
//   2. listCount — the same count restricted to markdown/YAML list-item lines,
//      on the theory that a copy is a list and prose is sentences. It is
//      WORSE: Haven's docs are written in bullets throughout, so SKILL.md (a
//      real copy) falls to 18 while CLAUDE.md (prose) sits at 13.
//
//   3. run — the longest run of consecutive lines each naming a perimeter
//      path, on the theory that an enumeration is contiguous and prose
//      interleaves. It INVERTS: docs/architecture/03-payment-sequence.md, a
//      mermaid sequence diagram and unambiguously not a restatement, scores
//      13 and outranks two of the three real copies. SKILL.md scores 8, tied
//      with an ordinary architecture doc.
//
// Why no threshold fixes this
// ---------------------------
// The deeper result, and the reason #1904 closed rather than narrowed: every
// one of these signals measures how much of the list a document REPRODUCES.
// That is a measure of the copy's FRESHNESS, not of its existence. So the
// detector is loudest about the copy that is perfectly maintained — the one
// that needs no guard — and goes quiet as the copy rots, which is the only
// state anyone cares about. Run `--mutate` to see it: a planted copy fires at
// 0% and 25% staleness, is one point over the prose ceiling at 50%, and is
// invisible at 75%.
//
// A guard whose sensitivity is inversely proportional to the severity of the
// fault is not mistuned. It is pointed the wrong way, and no threshold turns
// it around.
//
// What IS checkable — and what shipped instead
// --------------------------------------------
// Structured data that declares its own coupling. docs/regulatory/
// casp-risk-guardrails.md's `covers:` front matter says in writing that it is
// maintained against this list, and #1899 pinned it in money-path.test.mjs.
// That is the honest boundary Haven now holds: DECLARATIONS ARE CHECKED,
// PROSE IS NOT. A general `mirrors:` opt-in marker was considered and not
// built — today it would have exactly one adopter, which already has a better
// bespoke test, so it would be a framework with zero incremental coverage.
// Build it if a SECOND document ever legitimately enumerates the perimeter.
//
// Usage:
//   node scripts/ci/money-path-restatement-scan.mjs           # ranked report
//   node scripts/ci/money-path-restatement-scan.mjs --mutate  # instrument self-test

import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8')

/** The four places the money-path list legitimately lives (#1030, #1899). */
export const KNOWN_COPIES = Object.freeze([
  '.github/money-path-globs.json',
  '.github/labeler.yml',
  '.agents/skills/ship-next/SKILL.md',
  'docs/regulatory/casp-risk-guardrails.md',
])

export function allGlobs() {
  const json = JSON.parse(read('.github/money-path-globs.json'))
  return [...json.globs, ...json.controlGlobs]
}

/**
 * One matcher per distinct glob basename. `packages/backend/src/modules/x402/**`
 * becomes `x402`; `infra/delegate-*.ts` keeps its wildcard as a segment-local one.
 *
 * The boundary class deliberately allows `/` before the basename — prose and
 * front matter name these as paths (`routes/payments.ts`), so excluding `/`
 * silently scores almost every real copy at nearly zero. That was the first
 * form of this scan and it produced a confident, wrong negative.
 */
export function perimeterMatchers(globs = allGlobs()) {
  const basenames = [...new Set(globs.map((g) => g.replace(/\/\*\*$/, '').split('/').pop()))]
  return basenames.map((b) => ({
    basename: b,
    re: new RegExp(
      `(^|[^A-Za-z0-9_-])${b
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '[A-Za-z0-9_-]*')}($|[^A-Za-z0-9_-])`,
    ),
  }))
}

/** Signal 1: distinct perimeter basenames named anywhere in the text. */
export const scoreCount = (text, m) => m.filter(({ re }) => re.test(text)).length

/** Signal 2: the same, restricted to markdown/YAML list-item lines. */
export const scoreListCount = (text, m) =>
  scoreCount(
    text
      .split('\n')
      .filter((l) => /^\s*[-*+]\s/.test(l))
      .join('\n'),
    m,
  )

/** Signal 3: longest run of consecutive lines each naming a perimeter path. */
export function scoreRun(text, m) {
  let best = 0
  let cur = 0
  for (const line of text.split('\n')) {
    cur = m.some(({ re }) => re.test(line)) ? cur + 1 : 0
    if (cur > best) best = cur
  }
  return best
}

export const trackedProse = () =>
  execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .map((s) => s.trim())
    .filter((f) => /\.(md|ya?ml)$/.test(f))

/** Every tracked .md/.yml OUTSIDE the four known homes, scored on all signals. */
export function scoreTree(m = perimeterMatchers()) {
  return trackedProse()
    .filter((f) => !KNOWN_COPIES.includes(f))
    .map((f) => {
      const text = read(f)
      return { file: f, count: scoreCount(text, m), list: scoreListCount(text, m), run: scoreRun(text, m) }
    })
    .sort((a, b) => b.count - a.count)
}

/** The highest score ordinary prose reaches — the floor any threshold must clear. */
export const proseCeiling = (m = perimeterMatchers()) =>
  scoreTree(m).reduce((max, r) => Math.max(max, r.count), 0)

/**
 * A plausible fifth copy: a doc that restates the perimeter as a bullet list.
 * `keep` is how many entries it still carries — fewer means staler.
 */
export function plantedCopy(globs, keep = globs.length) {
  return [
    '# Money-path surfaces',
    '',
    'The following backend surfaces are on the money path and require the',
    'characterization-test bar before any behavioural change:',
    '',
    ...globs.slice(0, keep).map((g) => `- \`${g}\``),
    '',
    'Changes elsewhere do not need the money-path playbook.',
  ].join('\n')
}

function main() {
  const globs = allGlobs()
  const m = perimeterMatchers(globs)
  const tree = scoreTree(m)
  const ceiling = tree[0]

  console.log('money-path restatement scan — REPORTING ONLY, never fails (#1904)\n')
  console.log(`${m.length} distinct perimeter basenames from ${globs.length} globs\n`)

  console.log('The four known homes of the list:')
  for (const f of KNOWN_COPIES) {
    const text = read(f)
    console.log(`  count=${String(scoreCount(text, m)).padStart(3)}  ${f}`)
  }

  console.log('\nEverything else, ranked by `count` (top 12):')
  console.log('  count  list   run   file')
  for (const r of tree.slice(0, 12)) {
    console.log(
      `  ${String(r.count).padStart(5)}  ${String(r.list).padStart(4)}  ${String(r.run).padStart(4)}   ${r.file}`,
    )
  }

  console.log(`\nProse ceiling: ${ceiling.count} (${ceiling.file})`)
  for (const t of [8, 12, 16, 20]) {
    console.log(`  a threshold of ${String(t).padStart(2)} fires on ${tree.filter((r) => r.count >= t).length} ordinary docs`)
  }

  if (process.argv.includes('--mutate')) {
    console.log('\n--- instrument self-test: a PLANTED fifth copy, at four staleness levels ---')
    console.log(`(prose ceiling is count=${ceiling.count}, so "fires" means count > ${ceiling.count})\n`)
    console.log('  stale  entries  count   run   verdict')
    for (const pct of [0, 25, 50, 75]) {
      const keep = Math.round(globs.length * (1 - pct / 100))
      const text = plantedCopy(globs, keep)
      const c = scoreCount(text, m)
      console.log(
        `  ${String(pct + '%').padStart(5)}  ${String(keep).padStart(7)}  ${String(c).padStart(5)}  ${String(scoreRun(text, m)).padStart(4)}   ${c > ceiling.count ? 'FIRES' : 'SILENT — a copy this rotten hides in the prose population'}`,
      )
    }
    console.log(
      '\nThe instrument works — it fires on a fresh planted copy, so a negative\n' +
        'result from it is trustworthy. And that is exactly the problem: it is\n' +
        'loudest when the copy is CORRECT and silent when the copy has rotted.',
    )
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
