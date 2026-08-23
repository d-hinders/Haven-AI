// Drift guard for the money-path file list (#1030).
//
// The list existed in three places that DISAGREED. `.github/labeler.yml` — the
// thing that actually applies the `money-path` label, and therefore the thing
// that decides whether money.md and its characterization-test bar get loaded —
// was missing the entire delegation rail, the rail seam, and the SDK signer.
// Nobody noticed, because nothing compared them.
//
// A wrong money-path list is worse than none: it reads as coverage. So the
// copies are now checked against each other, and editing one without the
// others fails CI.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadMoneyPathGlobs, loadMoneyPathControlGlobs } from './qa-freshness.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8')

/**
 * Pull the money-path globs out of labeler.yml without a YAML dependency.
 * The block is a fixed shape (`money-path:` → `changed-files:` →
 * `any-glob-to-any-file:` → a `- path` list), so a targeted reader is more
 * honest here than pretending to parse YAML generally: if the shape changes,
 * this returns nothing and the assertion below fails loudly.
 */
function labelerMoneyPathGlobs() {
  const lines = read('.github/labeler.yml').split('\n')
  const start = lines.findIndex((l) => /^["']?money-path["']?:/.test(l))
  assert.notEqual(start, -1, 'labeler.yml has no `money-path:` key')
  const globs = []
  let inList = false
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break // next top-level key
    if (/any-glob-to-any-file:/.test(line)) { inList = true; continue }
    if (!inList) continue
    const m = line.match(/^\s*-\s*(?:["']?)([^"'\s]+)(?:["']?)\s*$/)
    if (m) globs.push(m[1])
    else if (line.trim() && !line.trim().startsWith('#')) break
  }
  return globs
}

/**
 * The Merge Gate's annotated file list, WITHOUT the prose that frames it.
 *
 * Scoped deliberately. The surrounding prose legitimately names source files
 * while talking *about* the mechanism (`scripts/ci/money-path.test.mjs`,
 * `index.ts`), and a token scan over the whole section would read those as
 * perimeter claims and fail on a sentence. The bullet list between the
 * "Classify" line and the "The label matters" line is the list itself.
 */
function mergeGateFileList(skill) {
  const gate = skill.slice(skill.indexOf('## Merge Gate'), skill.indexOf('Route the merge:'))
  assert.ok(gate.length > 200, 'could not locate the Merge Gate section in SKILL.md')
  const start = gate.indexOf('Classify a change as money-path')
  const end = gate.indexOf('The label matters because')
  assert.ok(start !== -1 && end > start, 'could not locate the Merge Gate file list boundaries')
  return gate.slice(start, end)
}

/** Backticked, path-shaped tokens (anything containing a `/`). */
function listedTokens(list) {
  return [...list.matchAll(/`([^`]+)`/g)]
    .map((m) => m[1])
    .filter((t) => t.includes('/'))
}

/**
 * Does a backend-relative prose token name this repo-root-relative glob?
 * Suffix match, with `*` treated as a single path segment's wildcard so
 * `rails/delegation-*.ts` covers `packages/backend/src/rails/delegation-*.ts`.
 */
function tokenNamesGlob(token, glob) {
  const needle = token.replace(/\/$/, '')
  const stripped = glob.replace(/\/\*\*$/, '')
  if (stripped.endsWith(needle) || glob.endsWith(needle)) return true
  if (!needle.includes('*')) return false
  const pattern = needle.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')
  return new RegExp(`(?:^|/)${pattern}$`).test(stripped)
}

describe('money-path list stays in one piece', () => {
  test('labeler.yml matches the UNION of globs + controlGlobs', () => {
    // labeler.yml labels BOTH lists: runtime money-path code, and the
    // safeguard's own control surface. The freshness gate uses `globs` only.
    const canonical = [...loadMoneyPathGlobs(), ...loadMoneyPathControlGlobs()]
    const labeler = labelerMoneyPathGlobs()
    assert.ok(labeler.length > 0, 'read no globs out of labeler.yml — the block shape changed')
    assert.deepEqual(
      [...labeler].sort(),
      [...canonical].sort(),
      'labeler.yml and money-path-globs.json disagree. The JSON is the source of truth: ' +
        'update labeler.yml to match. A glob missing from labeler.yml means PRs touching ' +
        'that file never get the money-path label, so they never load money.md.',
    )
  })

  test('every money-path file named in the SKILL.md Merge Gate is in the canonical list', () => {
    // Direction 1: someone documents a new money-path file in the prose
    // everyone reads, and the machinery never learns about it.
    //
    // The Merge Gate prose describes CLASSIFICATION (which diffs are
    // money-path), and classification is the UNION — controlGlobs are
    // labelled money-path too, they just skip the QA-freshness re-run. A
    // file named in the prose is "known to the machinery" if either list
    // has it (#1045 moved release-bump/publish.yml to controlGlobs, which
    // is where this distinction first bit).
    const globs = [...loadMoneyPathGlobs(), ...loadMoneyPathControlGlobs()]
    const tokens = listedTokens(mergeGateFileList(read('.agents/skills/ship-next/SKILL.md')))

    assert.ok(tokens.length >= 10, `expected the Merge Gate to name many files, saw ${tokens.length}`)

    const missing = tokens.filter((token) => !globs.some((g) => tokenNamesGlob(token, g)))

    assert.deepEqual(
      missing,
      [],
      'SKILL.md names money-path files absent from .github/money-path-globs.json. ' +
        'Add them to the JSON and to labeler.yml — prose that the machinery does not ' +
        'know about is the exact drift #1030 closed.',
    )
  })

  test('every canonical glob is named in the SKILL.md Merge Gate', () => {
    // Direction 2, and the one that actually bit (#1892).
    //
    // Direction 1 above called itself "the dangerous direction" and guarded
    // only SKILL.md ⊆ JSON. But SKILL.md is the file an agent reads WHILE
    // classifying its own diff, so a glob the JSON has and the prose lacks is
    // a perimeter the human half of the process cannot see. Seven runtime
    // globs and five control globs had accumulated in exactly that state, and
    // the Merge Gate still described routes/x402.ts and routes/machine-payments.ts
    // as "dissolved" while both were registered in index.ts and listed here.
    //
    // Subset in one direction is not agreement. Both directions, or neither.
    const skill = read('.agents/skills/ship-next/SKILL.md')
    const tokens = listedTokens(mergeGateFileList(skill))
    const globs = [...loadMoneyPathGlobs(), ...loadMoneyPathControlGlobs()]

    const unnamed = globs.filter((g) => !tokens.some((token) => tokenNamesGlob(token, g)))

    assert.deepEqual(
      unnamed,
      [],
      'the canonical money-path list has globs the SKILL.md Merge Gate never names. ' +
        'Add them to the Merge Gate list — an agent classifying its own diff reads ' +
        'that prose, not this JSON, so a perimeter missing from it is a perimeter ' +
        'the human half of the union cannot apply (#1892).',
    )
  })

  test('the two lists are disjoint — a glob belongs to exactly one', () => {
    const runtime = new Set(loadMoneyPathGlobs())
    const overlap = loadMoneyPathControlGlobs().filter((g) => runtime.has(g))
    assert.deepEqual(overlap, [], 'a glob in both lists would make the split meaningless')
  })

  test('the gate\'s own control surface is labelled money-path', () => {
    // A PR that weakens the last automatic money-path safeguard must not slip
    // through as an ordinary CI tweak.
    const control = loadMoneyPathControlGlobs()
    for (const f of ['scripts/ci/qa-freshness.mjs', '.github/workflows/dev-gate.yml']) {
      assert.ok(control.includes(f), `${f} must be a money-path control file`)
    }
  })

  test('the canonical file is well-formed and non-empty', () => {
    // The Merge Gate prose describes CLASSIFICATION (which diffs are
    // money-path), and classification is the UNION — controlGlobs are
    // labelled money-path too, they just skip the QA-freshness re-run. A
    // file named in the prose is "known to the machinery" if either list
    // has it (#1045 moved release-bump/publish.yml to controlGlobs, which
    // is where this distinction first bit).
    const globs = [...loadMoneyPathGlobs(), ...loadMoneyPathControlGlobs()]
    assert.ok(globs.length >= 15, `expected the full money-path list, saw ${globs.length}`)
    for (const g of globs) {
      assert.ok(!g.startsWith('/'), `glob must be repo-root-relative, not absolute: ${g}`)
      assert.ok(!g.includes('\\'), `glob must use forward slashes: ${g}`)
    }
    assert.equal(new Set(globs).size, globs.length, 'duplicate globs')
  })
})
