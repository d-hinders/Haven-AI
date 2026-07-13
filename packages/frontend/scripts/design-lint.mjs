#!/usr/bin/env node
/**
 * Design-system drift gate (#855, epic #859).
 *
 * Fails CI when a PR introduces NEW violations in src/{app,components}.
 *
 * Token rules — a value bypassed the design tokens:
 *   1. raw-palette   — Tailwind palette colour classes (text-amber-500, …)
 *                      instead of var(--v2-…) tokens
 *   2. hex-color     — hardcoded hex colours
 *   3. micro-font    — new text-[10px] / text-[11px]
 *
 * Structural rules (#899) — a COMPONENT was re-hand-rolled instead of using the
 * shared primitive (the exact debt epic #859 cleaned; token rules can't see it):
 *   4. header-band       — a grey header band (border-b + --v2-surface fill)
 *                          hand-rolled instead of Card.Header
 *   5. raw-table         — a raw <table> instead of the Table primitive
 *   6. raw-svg           — an inline <svg> instead of Icon + a lucide glyph
 *   7. address-truncation — a hand-rolled `${a.slice(0,6)}…${a.slice(-4)}`
 *                          instead of <Address> (or lib/format truncate)
 * Each structural rule exempts its own primitive's home file (Table.tsx,
 * Card.tsx, Address.tsx) so the canonical implementation is never self-flagged.
 *
 * Marketing/landing surfaces are exempt from ALL rules (#874, owner decision
 * 2026-07-12): they are intentionally bespoke and do not count against the
 * baseline. Product-app surfaces and /design-system stay fully gated.
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
import { readFileSync, readdirSync, statSync, existsSync } from 'fs'
import { newViolations, hasShrunk, writeBaseline, readBaseline } from '../../../scripts/lib/ratchet.mjs'
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

// Marketing/landing surfaces — intentionally bespoke, exempt from every rule
// (#874). Everything else in src/{app,components} stays gated.
const MARKETING_SURFACES = [
  'components/brand/',
  'components/marketing/',
  'src/app/page.tsx',
  'src/app/protocols/',
  'src/app/investor-briefing/',
  'src/app/how-it-works/',
]
export function isMarketingSurface(file) {
  return MARKETING_SURFACES.some((m) =>
    m.endsWith('.tsx') ? file.endsWith(m) : file.includes(m),
  )
}

export const RULES = [
  {
    id: 'raw-palette',
    describe: 'raw Tailwind palette class — use a var(--v2-…) token',
    regex: new RegExp(`\\b(?:${UTILITIES})-(?:${PALETTE})-\\d{2,3}\\b`, 'g'),
    exempt: isMarketingSurface,
  },
  {
    id: 'hex-color',
    describe: 'hardcoded hex colour — use a var(--v2-…) token',
    // 3/4-char forms must contain a letter: all-digit short matches are far
    // more often issue references (#857) than colours, and any real colour
    // also exists in its 6-digit form. Line comments are skipped in scanSource.
    regex:
      /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|(?=[0-9a-fA-F]{0,3}[a-fA-F])[0-9a-fA-F]{4}|(?=[0-9a-fA-F]{0,2}[a-fA-F])[0-9a-fA-F]{3})\b/g,
    exempt: isMarketingSurface,
  },
  {
    id: 'micro-font',
    describe: 'micro font size — use the typography ramp (v2-text-*)',
    regex: /text-\[1[01]px\]/g,
    exempt: isMarketingSurface,
  },
  // ── Structural rules (#899): catch COMPONENT bypass — re-hand-rolling the
  // exact debt epic #859 cleaned. The token rules above can't see these.
  {
    id: 'header-band',
    describe: 'hand-rolled grey header band — use the Card.Header primitive',
    // A border-b co-occurring with the surface fill inside one className.
    // `border-b` is boundary-guarded: it must not match inside `border-black`
    // (a letter follows) but must still match `border-b` and `border-b-2`.
    regex:
      /(border-b(?![a-zA-Z])[^"'`]*bg-\[var\(--v2-surface\)\]|bg-\[var\(--v2-surface\)\][^"'`]*border-b(?![a-zA-Z]))/g,
    exempt: (file) => isMarketingSurface(file) || file.includes('components/ui/Card.tsx'),
  },
  {
    id: 'raw-table',
    describe: 'raw <table> — use the Table primitive (components/ui/Table)',
    regex: /<table[\s>]/g,
    exempt: (file) => isMarketingSurface(file) || file.includes('components/ui/Table.tsx'),
  },
  {
    id: 'raw-svg',
    describe: 'inline <svg> — use Icon + a lucide glyph',
    regex: /<svg[\s>]/g,
    // brand/marketing already exempt via isMarketingSurface; nothing else.
    exempt: isMarketingSurface,
  },
  {
    id: 'address-truncation',
    describe: 'hand-rolled address slice — use <Address> (or lib/format truncate)',
    // The PAIRED idiom only: `…slice(0, 6)…slice(-4)…` on one line. A lone
    // slice(0, 6) is usually an array preview (agents.slice(0, 6)) and a lone
    // slice(-4) a generic suffix — neither is address truncation, and matching
    // them separately also double-counted every real occurrence.
    regex: /\.slice\(\s*0,\s*6\s*\)[^\n]*\.slice\(\s*-4\s*\)/g,
    exempt: (file) => isMarketingSurface(file) || file.includes('components/haven/Address.tsx'),
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
    writeBaseline(BASELINE_PATH, counts)
    console.log(`design-lint: baseline written (${details.length} existing violations ratcheted).`)
    return
  }

  const baseline = readBaseline(BASELINE_PATH)
  const failures = newViolations(counts, baseline)

  if (failures.length === 0) {
    console.log(
      `design-lint: OK (${details.length} baselined violations remain).` +
        (hasShrunk(counts, baseline)
          ? ' Debt shrank — run `npm run design:lint:update -w packages/frontend` to tighten the ratchet.'
          : ''),
    )
    return
  }

  console.error('design-lint: NEW design-system drift detected.\n')
  for (const f of failures) {
    const rule = RULES.find((r) => r.id === f.key)
    console.error(
      `  ${f.file} — ${f.key}: ${f.count} found, baseline allows ${f.allowed} (${rule.describe})`,
    )
    for (const d of details.filter((d) => d.file === f.file && d.rule === f.key)) {
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
