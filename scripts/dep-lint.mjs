#!/usr/bin/env node
// Dependency-boundary lint: enforce the module-boundary rules from
// docs/architecture/10-module-boundaries.md against packages/backend.
//
// BLOCKING, ratcheting baseline (#982, epic #980): existing debt is captured in
// packages/backend/dep-lint-baseline.json (file → rule → count); counts may only
// SHRINK. A NEW boundary violation — or growth of an existing count — fails the
// build with the offending edge. Same treatment design-lint got in #855 and
// copy-lint in #902, using the SHARED ratchet engine those two share.
//
// The rules themselves live in .dependency-cruiser.cjs, which is authoritative
// over the prose in the architecture doc.
//
//   node scripts/dep-lint.mjs            # check against the baseline
//   node scripts/dep-lint.mjs --update   # rewrite the baseline (shrink, or a
//                                        # reviewed, intentional add)

import { readdir } from 'node:fs/promises'
import { join, dirname, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { cruise } from 'dependency-cruiser'
import { newViolations, hasShrunk, writeBaseline, readBaseline } from './lib/ratchet.mjs'

// Re-exported so tests use the SHARED ratchet engine (scripts/lib/ratchet.mjs),
// the same implementation design-lint and copy-lint use.
export { newViolations, hasShrunk }

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BASELINE_PATH = join(REPO_ROOT, 'packages', 'backend', 'dep-lint-baseline.json')
const SCAN_ROOT = join(REPO_ROOT, 'packages', 'backend', 'src')
const CONFIG_PATH = join(REPO_ROOT, '.dependency-cruiser.cjs')

/** The ruleset, loaded once. Also the source of the scan's exclude pattern. */
export const ruleSet = createRequire(import.meta.url)(CONFIG_PATH)

// DERIVED from options.exclude rather than restated, so the file list we hand
// dependency-cruiser can never drift from the paths it would itself ignore.
// Tests legitimately reach past production boundaries (integration tests touch
// the pool directly), so the rules describe PRODUCTION structure only.
export const EXCLUDED = new RegExp(ruleSet.options.exclude.path)

async function walk(dir, out = []) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const full = join(dir, e.name)
    if (e.isDirectory()) await walk(full, out)
    else if (/\.ts$/.test(e.name) && !EXCLUDED.test(full.split(sep).join('/'))) out.push(full)
  }
  return out
}

/**
 * Pure core: fold dependency-cruiser's violation list into the ratchet shape.
 * Returns { counts: {file: {rule: n}}, details: [{file, rule, to, comment}] }.
 *
 * Keyed by the SOURCE file and rule name — the same edge reported twice (two
 * imports of `ethers` in one route) counts twice, so removing one of them
 * genuinely shrinks the baseline.
 */
export function foldViolations(violations) {
  const counts = {}
  const details = []
  for (const v of violations) {
    const file = v.from
    const rule = v.rule.name
    counts[file] ??= {}
    counts[file][rule] = (counts[file][rule] ?? 0) + 1
    details.push({ file, rule, to: v.to, comment: v.rule.comment })
  }
  return { counts, details }
}

/**
 * Run dependency-cruiser over the backend source tree.
 *
 * The ruleset is required in directly rather than passed as `config.fileName`:
 * the programmatic API expects the resolved ruleset inline (only the CLI loads
 * a config file), and handing it a filename silently yields an undefined
 * ruleset and a crash inside validation. Requiring it keeps
 * .dependency-cruiser.cjs the single source of truth for both entry points.
 */
export async function scanAll() {
  const files = (await walk(SCAN_ROOT)).sort()
  const rel = files.map((f) => relative(REPO_ROOT, f).split(sep).join('/'))
  const { output } = await cruise(rel, {
    ...ruleSet.options,
    ruleSet: { forbidden: ruleSet.forbidden },
    outputType: 'json',
    validate: true,
  })
  const report = typeof output === 'string' ? JSON.parse(output) : output
  return { ...foldViolations(report.summary.violations), fileCount: rel.length }
}

async function main() {
  const update = process.argv.includes('--update')
  const { counts, details, fileCount } = await scanAll()

  if (update) {
    writeBaseline(BASELINE_PATH, counts)
    console.log(`dep-lint: baseline written (${details.length} existing violation(s) ratcheted).`)
    return
  }

  const baseline = readBaseline(BASELINE_PATH)
  const failures = newViolations(counts, baseline)

  if (failures.length > 0) {
    console.log('✗ NEW dependency-boundary violations (beyond the ratcheting baseline):\n')
    for (const f of failures) {
      console.log(`  ${f.file} — ${f.key}: ${f.count} found, baseline allows ${f.allowed}`)
      for (const d of details.filter((d) => d.file === f.file && d.rule === f.key)) {
        console.log(`    → ${d.to}`)
      }
      const comment = details.find((d) => d.rule === f.key)?.comment
      if (comment) console.log(`    ${comment}`)
    }
    console.log(
      '\nSee docs/architecture/10-module-boundaries.md. The baseline is SHRINK-ONLY: ' +
        'fix the boundary rather than running `npm run lint:deps:update`, which is ' +
        'only for a reviewed, intentional change.',
    )
    process.exit(1)
  }

  console.log(
    `✓ No new dependency-boundary violations across ${fileCount} backend source files ` +
      `(${details.length} baselined violation(s) remain).` +
      (hasShrunk(counts, baseline)
        ? ' Debt shrank — run `npm run lint:deps:update` to tighten the ratchet.'
        : ''),
  )
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
