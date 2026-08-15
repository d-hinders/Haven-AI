#!/usr/bin/env node
// Shrink-only ratchet on hand-written wire-shape types in the frontend
// (#1447, epic #1442).
//
// `packages/core/src/api-types.ts` is generated from `openapi/spec.ts` and
// CI-gated — but a generated type proves nothing while the code that renders
// keeps its own hand-written copy of the same shape. #1445 migrated the ones
// the spec covers; this freezes the remainder so the pattern cannot regrow,
// and so a NEW hook cannot quietly hand-roll a type the spec could provide.
//
// WHAT COUNTS AS A WIRE SHAPE. The honest signal in this codebase is the
// casing: the API speaks snake_case (`api_key_prefix`, `reset_period_min`)
// and the UI speaks camelCase (`hasStranded`, `tokenSymbol`). So a declaration
// in hooks/ or types/ counts when it declares at least one snake_case
// property. That is deliberately narrower than "every interface not marked
// ui-local": a gate that demands a marker on every ordinary props interface
// trains people to add markers without reading them, and a marker nobody
// reads is worse than no gate at all.
//
// It follows that the gate MISSES a wire shape that does not speak snake_case:
// a single-word one (`{ id: string; name: string }`), or a surface that simply
// uses a different convention. `useAccounting.ts`'s `ReconcileItem` is a live
// example — `/accounting/reconcile` really does return `paymentId`/`txHash`
// (`modules/accounting/reconcile.ts`), so this counter does not see it. That is
// a stated hole, not an oversight; the backstop is #1443's route-coverage gate
// plus review, not this counter. Do not "fix" it by counting every interface —
// see the paragraph above for why that trade is worse.
//
// NOT counted:
//   - anything derived from `ApiSchema<'…'>` — that IS the generated type
//   - a declaration carrying `// ui-local: <reason of at least 20 chars>`
//     on the line above it (same shape as db-mock-exempt / design-lint)
//   - test files
//
//   node scripts/lint-wire-types.mjs            # check against the baseline
//   node scripts/lint-wire-types.mjs --update   # tighten after a reduction
//                                               # (refuses to ratchet upward)
import { readFile, readdir } from 'node:fs/promises'
import { join, dirname, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { newViolations, hasShrunk, writeBaseline, readBaseline } from './lib/ratchet.mjs'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const BASELINE_PATH = join(REPO_ROOT, 'packages', 'frontend', 'wire-type-baseline.json')
const SCAN_DIRS = [
  join(REPO_ROOT, 'packages', 'frontend', 'src', 'hooks'),
  join(REPO_ROOT, 'packages', 'frontend', 'src', 'types'),
]

/** `interface X {` or `type X = {` at the start of a line (export optional). */
const DECL_RE = /^(?:export\s+)?(?:interface\s+([A-Za-z0-9_]+)\s*(?:extends[^{]*)?\{|type\s+([A-Za-z0-9_]+)\s*=\s*\{)/gm
/** A snake_case property key: `api_key_prefix:` or `'api_key_prefix':`. */
const SNAKE_PROP_RE = /(?:^|[{;,\s])'?([a-z][a-z0-9]*(?:_[a-z0-9]+)+)'?\??\s*:/
const EXEMPT_RE = /\/\/ ui-local: .{20,}/

/**
 * Read the balanced `{…}` block starting at `openIndex`, ignoring braces
 * inside strings and template literals. Returns the body text.
 *
 * A regex cannot do this: a nested object property (`connector: { … }`) would
 * end the match at the first `}`, and the wire shapes here nest routinely.
 */
export function readBlock(source, openIndex) {
  let depth = 0
  let i = openIndex
  let quote = null
  for (; i < source.length; i++) {
    const c = source[i]
    if (quote) {
      if (c === '\\') i++
      else if (c === quote) quote = null
      continue
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue }
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return source.slice(openIndex, i + 1)
    }
  }
  return source.slice(openIndex) // unbalanced — treat the rest as the body
}

/** Count hand-written wire shapes in one file's source. */
export function scanSource(source) {
  const counts = {}
  const lines = source.split('\n')
  for (const match of source.matchAll(DECL_RE)) {
    const name = match[1] ?? match[2]
    const openIndex = source.indexOf('{', match.index)
    if (openIndex === -1) continue

    // The line above the declaration carries the exemption, matching how
    // db-mock-exempt and design-lint markers are placed.
    const lineNo = source.slice(0, match.index).split('\n').length - 1
    const preceding = lines.slice(Math.max(0, lineNo - 3), lineNo).join('\n')
    if (EXEMPT_RE.test(preceding)) continue

    const body = readBlock(source, openIndex)
    if (!SNAKE_PROP_RE.test(body)) continue
    counts[name] = (counts[name] ?? 0) + 1
  }
  return counts
}

async function* walk(dir) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return // a scan dir that does not exist yet is not an error
  }
  for (const entry of entries) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '__tests__') continue
      yield* walk(p)
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      yield p
    }
  }
}

export async function scanAll() {
  const counts = {}
  for (const dir of SCAN_DIRS) {
    for await (const file of walk(dir)) {
      const rel = relative(REPO_ROOT, file).split(sep).join('/')
      const fileCounts = scanSource(await readFile(file, 'utf8'))
      if (Object.keys(fileCounts).length > 0) counts[rel] = fileCounts
    }
  }
  return counts
}

function total(counts) {
  let n = 0
  for (const keys of Object.values(counts)) n += Object.values(keys).reduce((a, b) => a + b, 0)
  return { types: n, files: Object.keys(counts).length }
}

const REMEDY =
  'A response shape the spec describes should be imported, not restated:\n' +
  "  import type { ApiSchema } from '@haven_ai/core'\n" +
  "  export type Thing = ApiSchema<'Thing'>\n" +
  'If the route is not in the spec yet, document it there first (#1446 tracks\n' +
  'the backfill). If the type is genuinely UI-side and merely happens to carry\n' +
  'a snake_case field, mark it:\n' +
  '  // ui-local: <why this is not a wire shape, at least 20 chars>'

async function main() {
  const counts = await scanAll()
  const baseline = readBaseline(BASELINE_PATH)
  const t = total(counts)
  console.log(
    `wire-type gauge: ${t.types} hand-written wire shape(s) across ${t.files} file(s).`,
  )

  if (process.argv.includes('--update')) {
    const violations = newViolations(counts, baseline)
    if (Object.keys(baseline).length > 0 && violations.length > 0) {
      console.error('✗ --update refuses to RAISE the baseline. Grown:')
      for (const v of violations) console.error(`  ${v.file} [${v.key}]: ${v.allowed} → ${v.count}`)
      console.error(`\n${REMEDY}`)
      process.exit(1)
    }
    writeBaseline(BASELINE_PATH, counts)
    console.log(`✓ baseline written (${BASELINE_PATH}).`)
    return
  }

  const violations = newViolations(counts, baseline)
  if (violations.length > 0) {
    console.error('\n✗ hand-written wire shapes grew (shrink-only baseline, #1447):\n')
    for (const v of violations) {
      console.error(`  ${v.file} [${v.key}]: baseline ${v.allowed}, now ${v.count}`)
    }
    console.error(`\n${REMEDY}`)
    console.error(
      '\nIf you legitimately REDUCED counts elsewhere, run:\n' +
        '  node scripts/lint-wire-types.mjs --update',
    )
    process.exit(1)
  }

  if (hasShrunk(counts, baseline)) {
    console.log(
      '  (counts are below the baseline — lock in the progress: node scripts/lint-wire-types.mjs --update)',
    )
  }
  console.log('✓ no new hand-written wire shapes.')
}

// Run only as a CLI (the pure scanner is imported by tests).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main()
}
