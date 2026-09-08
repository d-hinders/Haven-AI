#!/usr/bin/env node
// Refuse a `pg_constraint` lookup in a migration that is not scoped to one
// relation or schema (#2702).
//
// ## The defect this exists for
//
// `pg_constraint.conname` is NOT unique across schemas. A migration that asks
//
//   IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'x') THEN …
//
// is answered by ANY schema's copy, so once one schema holds the name every
// schema migrated afterwards skips its own. Measured before the fix: 185 worker
// schemas held `user_safes` and none held two of its constraints; 193 held
// `machine_payment_evidence` and none held its XOR check. The tests were
// certifying behaviour against schemas weaker than production, silently.
//
// ## Why a script and not a review habit
//
// Five sites had the defect and a hand-written grep found four. The fifth
// (`018_machine_payment_approval_evidence_refs.ts`) spreads the same query over
// four lines, so a line-oriented search could not see it — and that grep was
// cited as evidence, in a regulatory changelog shard, that zero remained.
//
// The repair migration also HIDES the defect from the test suite: once the
// constraints are re-added, a migration that skips creating them still passes,
// because something else already put them there. So the qualification half of
// the fix has no runtime signal at all. This gate is that signal.
//
// ## What counts as scoped
//
// Either predicate is sufficient, and both are correct under any `search_path`:
//
//   c.conrelid = 'some_table'::regclass    ← anchors on the RELATION (preferred)
//   n.nspname = current_schema()           ← anchors on the schema
//
// `conrelid` is preferred because `current_schema()` is the first EXISTING
// schema on `search_path`, while `ALTER TABLE t` resolves to the first schema
// CONTAINING `t`. Those diverge on a multi-element `search_path`, and a guard
// that answers about schema A while the DDL acts on schema B fails loudly with
// 42710 rather than doing the right thing.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = fileURLToPath(new URL('../packages/backend/src/db/migrations/', import.meta.url))

/** Every `pg_constraint` query in `source`, with the text of its predicate. */
export function constraintLookups(source) {
  const out = []
  // Whitespace-insensitive on purpose: the site this gate was written for is
  // spread over four lines, and a line-anchored pattern is what missed it.
  const re = /FROM\s+pg_constraint\b([\s\S]*?)(?:\)\s*THEN|\)\s*;|\n\s*\)\s)/gi
  for (const m of source.matchAll(re)) out.push({ index: m.index, body: m[1] })
  return out
}

/** True when a lookup is anchored to one relation or one schema. */
export function isScoped(body) {
  return /conrelid\s*=/i.test(body) || /nspname\s*=\s*current_schema\(\)/i.test(body)
}

function lineOf(source, index) {
  return source.slice(0, index).split('\n').length
}

function main() {
  const files = readdirSync(DIR).filter((f) => /^\d+_.*\.ts$/.test(f)).sort()
  const failures = []
  let checked = 0
  for (const file of files) {
    const source = readFileSync(join(DIR, file), 'utf8')
    for (const { index, body } of constraintLookups(source)) {
      checked += 1
      if (!isScoped(body)) failures.push(`${file}:${lineOf(source, index)}`)
    }
  }

  // POSITIVE CONTROL. A gate that silently matched nothing would report a clean
  // repo forever — the exact false zero this file exists because of. If the
  // scan finds no lookups at all, the pattern has drifted from the SQL.
  if (checked === 0) {
    console.error(
      'lint:migration-constraint-scope: found ZERO pg_constraint lookups across ' +
        `${files.length} migration(s). That is not credible — the migrations use them. ` +
        'The pattern has drifted from the SQL and this gate is reporting on nothing.',
    )
    process.exit(1)
  }

  if (failures.length > 0) {
    console.error(
      `✗ ${failures.length} unscoped pg_constraint lookup(s) in migrations:\n` +
        failures.map((f) => `    ${f}`).join('\n') +
        '\n\n`conname` is not unique across schemas, so this lookup is answered by ANY\n' +
        "schema's copy and the constraint is skipped in the one being migrated.\n" +
        "Anchor it: `c.conrelid = '<table>'::regclass` (preferred), or\n" +
        '`n.nspname = current_schema()` with a pg_namespace join.\n',
    )
    process.exit(1)
  }
  console.log(
    `✓ all ${checked} pg_constraint lookup(s) across ${files.length} migration(s) are schema- or relation-scoped.`,
  )
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
