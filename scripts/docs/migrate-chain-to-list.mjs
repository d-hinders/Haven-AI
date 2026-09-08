#!/usr/bin/env node
// One-shot migration (#2637): rewrite every governed doc's single-line
// `last-verified` chain into a `verified:` block list, one entry per line.
//
// WHY THE SHAPE CHANGES. The chain was one front-matter comment line that
// every PR touching the doc prepended to. That single line is the reason for
// most of the machinery around it: two concurrent PRs both prepending to the
// same line conflict by construction, about nothing (#1496 — three such
// resolutions in one day, each pure ceremony); hand-resolving those conflicts
// is how entries got dropped (#1843) and rewritten (#2504); and an unbounded
// line needed a byte ceiling and a compaction ritual (#2477, #2562). One entry
// per line makes a concurrent verification an ordinary line insertion, which
// git merges without asking anyone.
//
// WHAT THIS SCRIPT GUARANTEES. It is a pure re-shaping: every entry's text
// survives byte-identically, in order. The script refuses to write a file
// whose round-trip does not reproduce the exact entry list it read — so a
// migration that would lose or mangle an entry fails loudly instead of
// shipping. Run with --check to verify without writing.
//
// Usage:
//   node scripts/docs/migrate-chain-to-list.mjs          # rewrite in place
//   node scripts/docs/migrate-chain-to-list.mjs --check   # report only, exit 1 if work remains
import { readFile, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { lastVerifiedLine, chainEntries } from './chain-integrity.mjs'
import { parseFrontMatter, quoteEntry, unquoteEntry } from './validate-frontmatter.mjs'

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const CHECK = process.argv.includes('--check')

function tracked() {
  return execFileSync('git', ['ls-files', '*.md'], { cwd: REPO_ROOT, encoding: 'utf8' })
    .trim()
    .split('\n')
    .filter(Boolean)
}

/**
 * Build the replacement front-matter block for one doc.
 *
 * The `last-verified:` scalar keeps its date and loses its comment; the entries
 * become a `verified:` list directly beneath it, newest first — the same order
 * they were already in, since the old chain read newest-first by convention.
 */
export function migrateRaw(raw) {
  const line = lastVerifiedLine(raw)
  if (!line) return null
  const entries = chainEntries(line)
  if (entries.length === 0) return null
  const date = (line.match(/^last-verified:\s*"([^"]*)"/) || [])[1]
  if (!date) return null

  const block = [`last-verified: "${date}"`, 'verified:']
    .concat(entries.map((e) => `  - ${quoteEntry(e)}`))
    .join('\n')
  // `$` is not safe in a string replacement: `String.replace` interprets `$&`,
  // `$\'` and `` $` `` in the REPLACEMENT argument, and real entries contain
  // `$` (regex fragments quoted from code — `^(0|[0-9]+\\.[0-9]{2,6})$` is in
  // the corpus twice). A function replacement is returned verbatim, so it is
  // the only correct form here. Found by this script's own round-trip guard,
  // which is the reason that guard exists.
  const out = raw.replace(line, () => block)

  // Refuse to write anything we cannot read back identically. A migration that
  // silently drops or mangles an entry is the one failure that matters here,
  // and it is cheap to make impossible rather than to review for.
  const back = parseFrontMatter(out)
  if (!back.ok) return { error: `front-matter unparseable after rewrite: ${back.error}` }
  const got = (back.data.verified || []).map(String)
  if (got.length !== entries.length) {
    return { error: `entry count changed: ${entries.length} -> ${got.length}` }
  }
  for (let i = 0; i < entries.length; i++) {
    if (got[i] !== entries[i]) {
      return { error: `entry ${i + 1} did not round-trip\n    was: ${entries[i].slice(0, 120)}\n    got: ${got[i].slice(0, 120)}` }
    }
  }
  return { out, count: entries.length }
}

// Only run when invoked directly. `migrateRaw` is exported for the unit tests,
// and an import that migrates the repository as a side effect is a trap — it
// rewrote 77 files the first time this module was imported for inspection.
const INVOKED_DIRECTLY = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (!INVOKED_DIRECTLY) {
  // eslint-disable-next-line no-undef
} else {
await main()
}

async function main() {
const files = tracked()
let migrated = 0
let already = 0
let skipped = 0
let entriesMoved = 0
const errors = []

for (const rel of files) {
  const abs = join(REPO_ROOT, rel)
  const raw = await readFile(abs, 'utf8')
  const parsed = parseFrontMatter(raw)
  if (parsed.ok && Array.isArray(parsed.data.verified)) {
    already++
    continue
  }
  const r = migrateRaw(raw)
  if (r === null) {
    skipped++
    continue
  }
  if (r.error) {
    errors.push(`${rel}: ${r.error}`)
    continue
  }
  entriesMoved += r.count
  migrated++
  if (!CHECK) await writeFile(abs, r.out, 'utf8')
}

console.log(
  `chain migration: ${migrated} doc(s) ${CHECK ? 'would move' : 'moved'} to the list shape ` +
    `(${entriesMoved} entries), ${already} already migrated, ${skipped} with no chain.`,
)
if (errors.length) {
  console.error(`\n✗ ${errors.length} doc(s) failed the round-trip check — nothing written for them:\n`)
  for (const e of errors) console.error(`  - ${e}`)
  process.exit(1)
}
if (CHECK && migrated > 0) process.exit(1)
}
