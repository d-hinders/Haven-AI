// Derives the `docs:check` step count from its script definition in
// package.json and asserts every count the docs-quality-system doc states
// about that set against the derivation, so the next validator addition
// reddens here instead of drifting in three hand-maintained numbers (#2666,
// closing the class #2533 and #2657 each patched by hand).
//
// The doc may reword its sentences freely: any count sentence that is absent
// is skipped (a conscious edit), but every count sentence that IS present must
// match the derived number. Run with: npm run docs:test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))

const pkg = JSON.parse(readFileSync(`${repoRoot}package.json`, 'utf8'))
const doc = readFileSync(`${repoRoot}docs/contributing/docs-quality-system.md`, 'utf8')

// Count claims live in the body; front matter is unscanned, matching the
// ui-gate-wording guard's precedent (#2657), so a `last-verified` chain entry
// QUOTING a stale count sentence is history, not a finding.
const fmMatch = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(doc)
const body = fmMatch ? doc.slice(fmMatch[0].length) : doc

// package.json is the source of truth for what `docs:check` runs, in order.
const docsCheck = pkg.scripts['docs:check']
assert.ok(docsCheck, 'package.json defines a docs:check script')
const parts = docsCheck.split('&&').map((s) => s.trim())
const steps = parts.map((p) => (/\bnode\s+(scripts\/docs\/[\w.-]+\.mjs)/.exec(p) || [])[1])
assert.ok(steps.length > 0, `docs:check is a chain of docs validators, got: ${docsCheck}`)
assert.ok(
  steps.every((s) => typeof s === 'string'),
  `every docs:check part is a scripts/docs/*.mjs invocation: ${docsCheck}`,
)
// No surprise operators: the parts must reassemble into the whole script.
assert.equal(parts.join(' && '), docsCheck, 'docs:check is exactly its parts joined by &&')
// Positive control for the count's domain: a number derived from names that
// do not exist would guard nothing.
for (const s of steps) {
  assert.ok(existsSync(`${repoRoot}${s}`), `${s} exists in the repo`)
}

const WORD_NUMBERS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8,
}
const wordToNumber = (w) => {
  const n = WORD_NUMBERS[w.toLowerCase()]
  assert.ok(n !== undefined, `test vocabulary knows the ordinal "${w}" — extend WORD_NUMBERS`)
  return n
}

/** Derive a validator's 1-based position in the docs:check chain. */
const stepIndexOf = (name) => {
  const i = steps.findIndex((s) => s.endsWith(`/${name}.mjs`))
  assert.ok(i !== -1, `${name}.mjs is a docs:check step`)
  return i + 1
}

test('docs:check count: the doc states no stale total of blocking scripts', () => {
  const m = /All (one|two|three|four|five|six|seven|eight) blocking scripts/.exec(body)
  if (!m) return // sentence consciously reworded or removed; nothing to derive
  assert.equal(
    wordToNumber(m[1]),
    steps.length,
    `"All ${m[1]} blocking scripts" vs ${steps.length} steps in package.json docs:check (${steps.join(', ')})`,
  )
})

test('docs:check count: every step appears in the check-inventory table', () => {
  const rows = body.split('\n').filter((l) => /^\|\s/.test(l))
  for (const s of steps) {
    const name = s.split('/').pop()
    assert.ok(
      rows.some((r) => r.includes(`scripts/docs/${name}`) || r.includes(`scripts/docs/\`${name}\``)),
      `check-inventory table names scripts/docs/${name}`,
    )
  }
})

test('docs:check order: package.json runs the validators in the documented order', () => {
  // The documented teaching order; the guard pins the exact prefix so a
  // reorder or unaccounted validator is a conscious edit, not drift.
  const prefix = [
    'validate-frontmatter.mjs',
    'validate-agent-skills.mjs',
    'validate-readme-agent-section.mjs',
    'ui-gate-wording.mjs',
    'covers-gaps.mjs',
  ]
  const names = steps.map((s) => s.split('/').pop())
  assert.deepEqual(names, prefix, 'docs:check order')
})
