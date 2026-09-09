#!/usr/bin/env node
// Shrink-only ratchet over the retired-rail prose phrase family (#2685).
//
// The Safe-rail retirement (epic #1440) left a family of prose phrases that
// keep reappearing in new and edited files: "remain(s) readable", "both
// rails", "import-only", and friends. Three manual sweeps (#2669, #2673,
// #2687) each found sites the previous sweep's grep was not pointed at —
// convergent-by-grep, not by construction. This ratchet makes the family
// shrink-only: a committed baseline records the current (file → phrase →
// count) debt, and any NEW occurrence, or growth of an existing one, fails.
//
// It is the same engine as lint:db-mocks (#1227) — it imports
// scripts/lib/ratchet.mjs rather than cloning it. The `key` dimension here is
// a phrase id, not a mock kind.
//
// WHAT IT CANNOT CATCH (stated, not implied away): a paraphrase using none of
// the listed phrases — "legacy accounts are still visible in Haven", "you can
// still see your old Safe". Both haven-doc-reviewer and haven-reviewer stated
// this limit verbatim on #2669 and #2673. The ratchet narrows the corridor; it
// does not close it.
//
// Each baselined (file, phrase) pair must carry a justification in
// packages/retired-rail-prose-justifications.json naming the legitimate
// category that makes the occurrence true. The self-test enforces lockstep
// between the two files, so a count without a justification fails.
//
//   node scripts/retired-rail-prose-ratchet.mjs            # check
//   node scripts/retired-rail-prose-ratchet.mjs --update   # tighten (refuses to raise)
import { readFile, readdir } from 'node:fs/promises'
import { join, dirname, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  newViolations,
  hasShrunk,
  writeBaseline,
  loadBaseline,
  updateRefusals,
  runGate,
} from './lib/ratchet.mjs'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const BASELINE_PATH = join(REPO_ROOT, 'packages', 'retired-rail-prose-baseline.json')
export const JUSTIFICATIONS_PATH = join(REPO_ROOT, 'packages', 'retired-rail-prose-justifications.json')
const SCAN_DIR = join(REPO_ROOT, 'packages')

// The phrase family (#2685). Case-insensitive; word-boundary where the phrase
// is a standalone term. `import-only` and `rail-conditional` are hyphenated
// identifiers, so they match literally.
export const PHRASES = {
  'remain-readable': /\bremain(?:s)?\s+readable\b/gi,
  'stays-readable': /\bstays?\s+readable\b/gi,
  'still-readable': /\bstill\s+readable\b/gi,
  'readable-here': /\breadable\s+here\b/gi,
  'readable-but': /\breadable\s+but\b/gi,
  'both-rails': /\bboth\s+rails\b/gi,
  'either-rail': /\beither\s+rail\b/gi,
  'rail-conditional': /\brail-conditional\b/gi,
  'import-only': /\bimport-only\b/gi,
  'read-only-record': /\bread-only\s+record\b/gi,
}

const SCAN_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|json|md|css|html)$/

/** Count the phrase family in one file's source; {} when it has no hits. */
export function scanSource(source) {
  const counts = {}
  for (const [id, re] of Object.entries(PHRASES)) {
    const n = source.match(re)?.length ?? 0
    if (n > 0) counts[id] = n
  }
  return counts
}

// The ratchet's own artifacts are excluded from the scan: the baseline and
// the justifications manifest both contain the phrase family (as keys and
// notes), so scanning them would be a self-referential loop that could never
// pass.
const SELF_ARTIFACTS = new Set([
  relative(REPO_ROOT, BASELINE_PATH).split(sep).join('/'),
  relative(REPO_ROOT, JUSTIFICATIONS_PATH).split(sep).join('/'),
])

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.next') continue
      yield* walk(p)
    } else if (SCAN_EXT.test(entry.name)) {
      yield p
    }
  }
}

export async function scanAll() {
  const counts = {}
  for await (const file of walk(SCAN_DIR)) {
    const rel = relative(REPO_ROOT, file).split(sep).join('/')
    if (SELF_ARTIFACTS.has(rel)) continue
    const fileCounts = scanSource(await readFile(file, 'utf8'))
    if (Object.keys(fileCounts).length > 0) counts[rel] = fileCounts
  }
  return counts
}

function totals(counts) {
  let hits = 0
  for (const keys of Object.values(counts)) for (const n of Object.values(keys)) hits += n
  return { hits, files: Object.keys(counts).length }
}

async function main() {
  const counts = await scanAll()
  const { baseline, firstRun } = loadBaseline(BASELINE_PATH)
  const t = totals(counts)
  console.log(`retired-rail prose gauge: ${t.hits} phrase hit(s) across ${t.files} file(s).`)

  if (process.argv.includes('--update')) {
    // #2728: see db-mock-ratchet -- an empty baseline is not a first run.
    const violations = updateRefusals(counts, baseline, { firstRun })
    if (violations.length > 0) {
      console.error('✗ --update refuses to RAISE the baseline. Grown:')
      for (const v of violations) console.error(`  ${v.file} [${v.key}]: ${v.allowed} → ${v.count}`)
      console.error(
        'Growth is a reviewed decision: remove the stale prose, or — if the occurrence is ' +
          'genuinely legitimate — hand-add it to BOTH the baseline and the justifications ' +
          'manifest (the self-test enforces lockstep).',
      )
      process.exit(1)
    }
    writeBaseline(BASELINE_PATH, counts)
    console.log(`✓ baseline written (${BASELINE_PATH}).`)
    return
  }

  const violations = newViolations(counts, baseline)
  if (violations.length > 0) {
    console.error('\n✗ retired-rail prose grew (shrink-only baseline, #2685):\n')
    for (const v of violations) {
      console.error(`  ${v.file} [${v.key}]: baseline ${v.allowed}, now ${v.count}`)
    }
    console.error(
      '\nRemove the stale phrase, or — if the occurrence is genuinely legitimate — hand-add ' +
        'it to BOTH packages/retired-rail-prose-baseline.json and ' +
        'packages/retired-rail-prose-justifications.json (the self-test enforces lockstep). ' +
        'If you legitimately REDUCED counts elsewhere, run: ' +
        'node scripts/retired-rail-prose-ratchet.mjs --update',
    )
    process.exit(1)
  }

  if (hasShrunk(counts, baseline)) {
    console.log(
      '  (counts are below the baseline — lock in the progress: node scripts/retired-rail-prose-ratchet.mjs --update)',
    )
  }
  console.log('✓ no new retired-rail prose.')
}

// Run only as a CLI (the pure scanner is imported by tests).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runGate('retired-rail-prose-ratchet', main)
}
