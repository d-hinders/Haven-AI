#!/usr/bin/env node
/**
 * Design-system drift gate (#855, epic #859).
 *
 * Fails CI when a PR introduces NEW violations in src/{app,components}:
 *   1. raw-palette   — Tailwind palette colour classes (text-amber-500, …)
 *                      instead of var(--v2-…) tokens
 *   2. hex-color     — hardcoded hex colours outside components/brand and
 *                      components/marketing
 *   3. micro-font    — new text-[10px] / text-[11px]
 *
 * A committed baseline (design-lint-baseline.json) ratchets: existing debt
 * passes, counts may only shrink. Growing a count, or violations in a file
 * not in the baseline, fails with file:line output and a pointer to
 * /design-system.
 *
 *   node scripts/design-lint.mjs            # check against the baseline
 *   node scripts/design-lint.mjs --update   # rewrite the baseline (shrink or
 *                                           # intentional, reviewed growth)
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BASELINE_PATH = path.join(ROOT, 'design-lint-baseline.json')
const SCAN_DIRS = ['src/app', 'src/components']
const DOC_POINTER = 'See /design-system (Colour tokens · How to use this page).'

// Tailwind palette families — white/black/transparent stay legal.
const PALETTE =
  'gray|slate|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose'
const UTILITIES =
  'text|bg|border|ring|divide|from|to|via|fill|stroke|outline|decoration|shadow|accent|caret|placeholder'

export const RULES = [
  {
    id: 'raw-palette',
    describe: 'raw Tailwind palette class — use a var(--v2-…) token',
    regex: new RegExp(`\\b(?:${UTILITIES})-(?:${PALETTE})-\\d{2,3}\\b`, 'g'),
    exempt: () => false,
  },
  {
    id: 'hex-color',
    describe: 'hardcoded hex colour — use a var(--v2-…) token',
    // 3/4-char forms must contain a letter: all-digit short matches are far
    // more often issue references (#857) than colours, and any real colour
    // also exists in its 6-digit form. Line comments are skipped in scanSource.
    regex:
      /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|(?=[0-9a-fA-F]{0,3}[a-fA-F])[0-9a-fA-F]{4}|(?=[0-9a-fA-F]{0,2}[a-fA-F])[0-9a-fA-F]{3})\b/g,
    exempt: (file) =>
      file.includes('components/brand/') || file.includes('components/marketing/'),
  },
  {
    id: 'micro-font',
    describe: 'micro font size — use the typography ramp (v2-text-*)',
    regex: /text-\[1[01]px\]/g,
    exempt: () => false,
  },
]

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const p = path.join(dir, entry)
    const st = statSync(p)
    if (st.isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules') continue
      yield* walk(p)
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      yield p
    }
  }
}

/** Scan one file's source; returns [{rule, line, match}] (pure — testable). */
export function scanSource(relFile, source) {
  const hits = []
  const lines = source.split('\n')
  for (const rule of RULES) {
    if (rule.exempt(relFile)) continue
    lines.forEach((raw, i) => {
      if (raw.includes('design-lint-disable-line')) return
      // Strip line-comment content — issue refs (#857) and colour names in
      // comments are prose, not styles. Block-comment bodies starting with *
      // are skipped the same way.
      const text = raw.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '')
      for (const m of text.matchAll(rule.regex)) {
        hits.push({ rule: rule.id, line: i + 1, match: m[0] })
      }
    })
  }
  return hits
}

function scanAll() {
  /** @type {Record<string, Record<string, number>>} file → rule → count */
  const counts = {}
  const details = []
  for (const dir of SCAN_DIRS) {
    const abs = path.join(ROOT, dir)
    if (!existsSync(abs)) continue
    for (const file of walk(abs)) {
      const rel = path.relative(ROOT, file)
      const hits = scanSource(rel, readFileSync(file, 'utf8'))
      for (const h of hits) {
        counts[rel] ??= {}
        counts[rel][h.rule] = (counts[rel][h.rule] ?? 0) + 1
        details.push({ file: rel, ...h })
      }
    }
  }
  return { counts, details }
}

function main() {
  const update = process.argv.includes('--update')
  const { counts, details } = scanAll()

  if (update) {
    const sorted = Object.fromEntries(
      Object.keys(counts)
        .sort()
        .map((f) => [f, Object.fromEntries(Object.entries(counts[f]).sort())]),
    )
    writeFileSync(BASELINE_PATH, JSON.stringify(sorted, null, 2) + '\n')
    const total = details.length
    console.log(`design-lint: baseline written (${total} existing violations ratcheted).`)
    return
  }

  const baseline = existsSync(BASELINE_PATH)
    ? JSON.parse(readFileSync(BASELINE_PATH, 'utf8'))
    : {}

  const failures = []
  for (const [file, rules] of Object.entries(counts)) {
    for (const [rule, count] of Object.entries(rules)) {
      const allowed = baseline[file]?.[rule] ?? 0
      if (count > allowed) failures.push({ file, rule, count, allowed })
    }
  }

  if (failures.length === 0) {
    // Shrink-only nudge: if debt went down, invite tightening the ratchet.
    let shrunk = false
    for (const [file, rules] of Object.entries(baseline)) {
      for (const [rule, allowed] of Object.entries(rules)) {
        if ((counts[file]?.[rule] ?? 0) < allowed) shrunk = true
      }
    }
    console.log(
      `design-lint: OK (${details.length} baselined violations remain).` +
        (shrunk
          ? ' Debt shrank — run `npm run design:lint:update -w packages/frontend` to tighten the ratchet.'
          : ''),
    )
    return
  }

  console.error('design-lint: NEW design-system drift detected.\n')
  for (const f of failures) {
    const rule = RULES.find((r) => r.id === f.rule)
    console.error(
      `  ${f.file} — ${f.rule}: ${f.count} found, baseline allows ${f.allowed} (${rule.describe})`,
    )
    for (const d of details.filter((d) => d.file === f.file && d.rule === f.rule)) {
      console.error(`    ${f.file}:${d.line}  ${d.match}`)
    }
  }
  console.error(`\n${DOC_POINTER}`)
  console.error(
    'Fix the new violations (route colours through var(--v2-…) tokens, use the type ramp), ' +
      'or — only for a reviewed, intentional exception — run `npm run design:lint:update -w packages/frontend`.',
  )
  process.exit(1)
}

// Run only as a CLI (the pure scanner is imported by tests).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
