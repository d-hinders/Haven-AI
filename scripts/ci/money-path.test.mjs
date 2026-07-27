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
import { loadMoneyPathGlobs } from './qa-freshness.mjs'

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

describe('money-path list stays in one piece', () => {
  test('labeler.yml matches .github/money-path-globs.json exactly', () => {
    const canonical = loadMoneyPathGlobs()
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
    // This is the dangerous direction: someone documents a new money-path file
    // in the prose everyone reads, and the machinery never learns about it.
    const skill = read('.agents/skills/ship-next/SKILL.md')
    const gate = skill.slice(skill.indexOf('## Merge Gate'), skill.indexOf('Route the merge:'))
    assert.ok(gate.length > 200, 'could not locate the Merge Gate file list in SKILL.md')

    const globs = loadMoneyPathGlobs()
    // Backticked tokens that look like source paths. The prose uses
    // backend-relative shorthand (`routes/x402.ts`, `db/migrations/`), so match
    // by suffix against the repo-root-relative canonical globs.
    const tokens = [...gate.matchAll(/`([^`]+)`/g)]
      .map((m) => m[1])
      .filter((t) => /\.(ts|mjs|yml)$|\/$/.test(t))
      .filter((t) => !t.startsWith('.github/CODEOWNERS'))

    assert.ok(tokens.length >= 10, `expected the Merge Gate to name many files, saw ${tokens.length}`)

    const missing = tokens.filter((token) => {
      const needle = token.replace(/\/$/, '')
      return !globs.some((g) => {
        const stripped = g.replace(/\/\*\*$/, '')
        return stripped.endsWith(needle) || g.endsWith(needle)
      })
    })

    assert.deepEqual(
      missing,
      [],
      'SKILL.md names money-path files absent from .github/money-path-globs.json. ' +
        'Add them to the JSON and to labeler.yml — prose that the machinery does not ' +
        'know about is the exact drift #1030 closed.',
    )
  })

  test('the canonical file is well-formed and non-empty', () => {
    const globs = loadMoneyPathGlobs()
    assert.ok(globs.length >= 15, `expected the full money-path list, saw ${globs.length}`)
    for (const g of globs) {
      assert.ok(!g.startsWith('/'), `glob must be repo-root-relative, not absolute: ${g}`)
      assert.ok(!g.includes('\\'), `glob must use forward slashes: ${g}`)
    }
    assert.equal(new Set(globs).size, globs.length, 'duplicate globs')
  })
})
