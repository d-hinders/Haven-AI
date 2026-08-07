#!/usr/bin/env node
// Dependency-boundary lint: enforce the module-boundary rules from
// docs/architecture/10-module-boundaries.md against packages/backend and the
// shared kernel packages/core.
//
// ABSOLUTE since #999 (epic #980's closing issue): the ratcheting baseline is
// retired — the linter simply passes or fails. The only escape hatch is an
// inline waiver comment on (or directly above) the offending import:
//
//   // dep-lint-exempt: <concrete reason>
//   import pool from '../db.js'
//
// The reason must be concrete ("bootstraps the pool before repositories
// exist"), not "legacy" or "TODO" — reasons under 20 characters are rejected.
// `no-circular` can never be waived: a cycle is a defect regardless of intent.
//
// The rules themselves live in .dependency-cruiser.cjs, which is authoritative
// over the prose in the architecture doc.
//
//   node scripts/dep-lint.mjs

import { readdir, readFile } from 'node:fs/promises'
import { join, dirname, relative, sep, posix } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { cruise } from 'dependency-cruiser'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
// Roots the gate polices. `core` is here so `core-stays-pure` can actually fire
// — a rule whose source tree is never scanned reports zero forever (#982's
// chain-SDK lesson).
const SCAN_ROOTS = [
  join(REPO_ROOT, 'packages', 'backend', 'src'),
  join(REPO_ROOT, 'packages', 'core', 'src'),
]
const CONFIG_PATH = join(REPO_ROOT, '.dependency-cruiser.cjs')

/** The one rule an inline waiver can never silence. */
const UNWAIVABLE_RULES = new Set(['no-circular'])

/** A waiver reason must say something; shorter than this reads as "TODO". */
export const MIN_EXEMPT_REASON_LENGTH = 20

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
 * Pure core: fold dependency-cruiser's violation list into per-edge details.
 * Returns [{file, rule, to, comment}] — one entry per reported edge, so the
 * same edge reported twice (two imports of `ethers` in one route) appears
 * twice.
 */
export function foldViolations(violations) {
  return violations.map((v) => ({
    file: v.from,
    rule: v.rule.name,
    to: v.to,
    comment: v.rule.comment,
  }))
}

// ── Inline waivers ──────────────────────────────────────────────────────────

/**
 * Parse `// dep-lint-exempt: <reason>` waivers out of one source file. The
 * marker binds to the import whose specifier appears on the SAME line or on
 * one of the next few lines (so a multi-line `import { … } from '…'` under a
 * comment-above still resolves). Returns [{specifier, reason}].
 */
export function parseExemptions(source) {
  const lines = source.split('\n')
  const found = []
  const SPECIFIER_RE = /(?:from\s+|^\s*import\s+|require\(\s*)['"]([^'"]+)['"]/
  for (let i = 0; i < lines.length; i++) {
    const marker = lines[i].match(/dep-lint-exempt:\s*(.*\S)?/)
    if (!marker) continue
    const reason = (marker[1] ?? '').trim()
    for (let j = i; j < Math.min(i + 10, lines.length); j++) {
      const m = lines[j].match(SPECIFIER_RE)
      if (m) {
        found.push({ specifier: m[1], reason })
        break
      }
    }
  }
  return found
}

/**
 * Does `specifier`, written in `fromFile` (repo-relative posix path), resolve
 * to the violation's `to` path? Relative specifiers resolve against the file
 * (with the ESM `.js` → source `.ts` mapping and index resolution); bare
 * specifiers match the resolved `node_modules/<pkg>/` prefix.
 */
export function specifierMatchesTarget(specifier, fromFile, target) {
  if (specifier.startsWith('.')) {
    const resolved = posix.normalize(posix.join(posix.dirname(fromFile), specifier))
    const candidates = [
      resolved,
      resolved.replace(/\.js$/, '.ts'),
      `${resolved}.ts`,
      `${resolved}/index.ts`,
    ]
    return candidates.includes(target)
  }
  const pkg = specifier.startsWith('@')
    ? specifier.split('/').slice(0, 2).join('/')
    : specifier.split('/')[0]
  return target.startsWith(`node_modules/${pkg}/`)
}

/**
 * Split violations into waived and firing, reading each offending file's
 * inline waivers at most once. A waiver with a reason shorter than
 * `MIN_EXEMPT_REASON_LENGTH` does NOT waive — it fails with its own message,
 * so "// dep-lint-exempt: TODO" can never ship. `no-circular` is unwaivable.
 */
export async function applyExemptions(details, readFileImpl = readFile) {
  const cache = new Map()
  const waived = []
  const firing = []
  const badReasons = []
  for (const d of details) {
    if (UNWAIVABLE_RULES.has(d.rule)) {
      firing.push(d)
      continue
    }
    if (!cache.has(d.file)) {
      let source = ''
      try {
        source = await readFileImpl(join(REPO_ROOT, d.file), 'utf8')
      } catch {
        // Unreadable file → no waivers; the violation fires.
      }
      cache.set(d.file, parseExemptions(source))
    }
    const match = cache
      .get(d.file)
      .find((e) => specifierMatchesTarget(e.specifier, d.file, d.to))
    if (!match) {
      firing.push(d)
    } else if (match.reason.length < MIN_EXEMPT_REASON_LENGTH) {
      badReasons.push({ ...d, reason: match.reason })
    } else {
      waived.push({ ...d, reason: match.reason })
    }
  }
  return { waived, firing, badReasons }
}

// ── The inline-SQL call-site gauge ──────────────────────────────────────────

/**
 * Count `.query(` / `.query<T>(` call sites in packages/backend/src OUTSIDE
 * db/, db.ts and infra/repositories/ (production code only — the scan already
 * excludes tests). This is the INTENSITY gauge #999 added when it retired the
 * file-edge ratchet: the edge count sat flat at 66 files while call sites
 * grew 256 → 344 (+34%), because a file that already imported the pool could
 * grow inline SQL forever without moving any metric. Edges see presence;
 * this sees growth. It is printed, not enforced — the number in CI logs is
 * the trend line.
 */
export function countInlineSqlCallSites(files) {
  let callSites = 0
  let fileCount = 0
  for (const { path, source } of files) {
    if (!path.startsWith('packages/backend/src/')) continue
    if (
      path.startsWith('packages/backend/src/db/') ||
      path === 'packages/backend/src/db.ts' ||
      path.startsWith('packages/backend/src/infra/repositories/')
    ) {
      continue
    }
    const matches = source.match(/\.query[(<]/g)
    if (matches && matches.length > 0) {
      callSites += matches.length
      fileCount += 1
    }
  }
  return { callSites, fileCount }
}

// ── Scan ────────────────────────────────────────────────────────────────────

/**
 * Run dependency-cruiser over the scanned source roots.
 *
 * The ruleset is required in directly rather than passed as `config.fileName`:
 * the programmatic API expects the resolved ruleset inline (only the CLI loads
 * a config file), and handing it a filename silently yields an undefined
 * ruleset and a crash inside validation. Requiring it keeps
 * .dependency-cruiser.cjs the single source of truth for both entry points.
 */
export async function scanAll() {
  const files = []
  for (const root of SCAN_ROOTS) await walk(root, files)
  files.sort()
  const rel = files.map((f) => relative(REPO_ROOT, f).split(sep).join('/'))
  const { output } = await cruise(rel, {
    ...ruleSet.options,
    ruleSet: { forbidden: ruleSet.forbidden },
    outputType: 'json',
    validate: true,
  })
  const report = typeof output === 'string' ? JSON.parse(output) : output
  // `scannedFiles` is returned so callers can assert the scan actually reached
  // a given root — a rule whose tree is never walked reports zero forever.
  return { details: foldViolations(report.summary.violations), fileCount: rel.length, scannedFiles: rel }
}

async function main() {
  const { details, fileCount, scannedFiles } = await scanAll()
  const { waived, firing, badReasons } = await applyExemptions(details)

  // The gauge prints on every run — pass or fail — so CI logs always carry it.
  const sources = await Promise.all(
    scannedFiles.map(async (path) => ({ path, source: await readFile(join(REPO_ROOT, path), 'utf8') })),
  )
  const gauge = countInlineSqlCallSites(sources)
  console.log(
    `inline-SQL gauge: ${gauge.callSites} .query( call site(s) across ${gauge.fileCount} file(s) ` +
      'outside infra/repositories/ (packages/backend/src, production code; trend only, not enforced).',
  )

  let failed = false
  if (badReasons.length > 0) {
    failed = true
    console.log('\n✗ dep-lint-exempt comments with non-reasons (a waiver must say WHY, concretely):\n')
    for (const b of badReasons) {
      console.log(`  ${b.file} — ${b.rule}: "${b.reason}" is too short (< ${MIN_EXEMPT_REASON_LENGTH} chars)`)
    }
  }

  if (firing.length > 0) {
    failed = true
    console.log('\n✗ Dependency-boundary violations:\n')
    for (const f of firing) {
      console.log(`  ${f.file} — ${f.rule}: → ${f.to}`)
      if (f.comment) console.log(`    ${f.comment}`)
    }
    console.log(
      '\nSee docs/architecture/10-module-boundaries.md. Fix the boundary, or — for a ' +
        'reviewed, deliberate exception — add `// dep-lint-exempt: <concrete reason>` on ' +
        'the offending import (`no-circular` can never be waived).',
    )
  }

  if (failed) process.exit(1)

  console.log(
    `✓ No dependency-boundary violations across ${fileCount} source files ` +
      `(${waived.length} import edge(s) waived by dep-lint-exempt).`,
  )
  for (const w of waived) console.log(`  waived: ${w.file} — ${w.rule}: ${w.reason}`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
