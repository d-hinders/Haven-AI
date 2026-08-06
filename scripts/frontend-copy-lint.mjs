#!/usr/bin/env node
// Frontend-copy lint: flag banned technical terms from
// docs/product/copy-guidelines.md in user-facing frontend source, so the copy
// guidelines reach the UI code (not just docs/product, where Vale stops).
//
// Deliberately CONSERVATIVE: only unambiguous **multi-word** phrases, never bare
// words like "safe"/"owner"/"deploy", so false positives stay ~zero. Add
// `// copy-lint-ignore` on the offending line (or the line above) for a
// legitimate advanced/developer-facing surface.
//
// BLOCKING, ratcheting baseline (#902, epic #904): existing debt is captured in
// packages/frontend/copy-lint-baseline.json (file → phrase → count); counts may
// only SHRINK. A NEW banned term — or growth of an existing count — fails the
// build with file:line:col. This is the same treatment design-lint got in #855.
//
//   node scripts/frontend-copy-lint.mjs            # check against the baseline
//   node scripts/frontend-copy-lint.mjs --update   # rewrite the baseline (shrink
//                                                   # or a reviewed, intentional add)

import { readFile, readdir } from 'node:fs/promises'
import { join, dirname, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { newViolations, hasShrunk, writeBaseline, readBaseline } from './lib/ratchet.mjs'
import { isEscaped } from './lib/lint-escapes.mjs'

// Re-exported so tests and any future consumer use the SHARED ratchet engine
// (scripts/lib/ratchet.mjs) — the same implementation design-lint uses.
export { newViolations }

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BASELINE_PATH = join(REPO_ROOT, 'packages', 'frontend', 'copy-lint-baseline.json')
// Scan where user-facing copy lives — pages and components — not lib/hooks
// utilities, where these technical terms are legitimate code (e.g.
// safePasskeySigner.ts referring to a "passkey signer"). This keeps the lint
// high-signal; add a path here if real UI copy lives elsewhere.
const SCAN_DIRS = [
  join(REPO_ROOT, 'packages', 'frontend', 'src', 'app'),
  join(REPO_ROOT, 'packages', 'frontend', 'src', 'components'),
]

// Multi-word banned phrases (from copy-guidelines.md's terminology mapping +
// the Vale Haven.Terminology list). Each maps to the preferred user-facing term.
export const BANNED = [
  ['spending policies', 'agent rules'],
  ['spending policy', 'agent rule'],
  ['policy engine', 'agent rules'],
  ['allowance module', 'rules / budget controls'],
  ['session keys', 'agent credentials'],
  ['session key', 'agent credential'],
  ['smart contract wallet', 'Haven account'],
  ['smart account', 'Haven account'],
  ['smart wallet', 'Haven wallet'],
  ['transaction hash', "context-specific copy (e.g. 'Setup transaction', or a 'View on explorer' link)"],
  ['passkey-backed signer', 'secure passkey'],
  ['passkey signer', 'secure passkey'],
  ['enroll signer', 'save your sign-in method'],
  ['webauthn credential', 'secure passkey'],
]

const IGNORE = 'copy-lint-ignore'

/**
 * Pure core: find banned phrases in `text`. Returns
 * [{ line, col, phrase, suggestion }]. A line carrying `copy-lint-ignore`
 * (itself or the line above) is skipped.
 */
export function findCopyIssues(text) {
  const lines = text.split(/\r?\n/)
  const out = []
  // Longest phrases first so a longer match claims its span before a shorter
  // substring can re-report it (e.g. "session keys" must not also fire
  // "session key" at the same column).
  const ordered = [...BANNED].sort((a, b) => b[0].length - a[0].length)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (isEscaped(lines, i, IGNORE)) continue
    const lower = line.toLowerCase()
    const claimed = [] // [start, end) spans already reported on this line
    for (const [phrase, suggestion] of ordered) {
      let from = 0
      let col
      while ((col = lower.indexOf(phrase, from)) !== -1) {
        const start = col
        const end = col + phrase.length
        if (!claimed.some(([s, e]) => start < e && end > s)) {
          out.push({ line: i + 1, col: start + 1, phrase, suggestion })
          claimed.push([start, end])
        }
        from = end
      }
    }
  }
  out.sort((a, b) => a.line - b.line || a.col - b.col)
  return out
}

async function walk(dir, out = []) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      await walk(join(dir, e.name), out)
    } else if (/\.(ts|tsx)$/.test(e.name) && !/\.(test|spec|stories)\./.test(e.name)) {
      out.push(join(dir, e.name))
    }
  }
  return out
}

// Scan the tree → { counts: {file: {phrase: n}}, details: [{file,line,col,phrase,suggestion}] }.
async function scanAll() {
  const files = []
  for (const dir of SCAN_DIRS) await walk(dir, files)
  const counts = {}
  const details = []
  for (const file of files.sort()) {
    const rel = relative(REPO_ROOT, file).split(sep).join('/')
    for (const x of findCopyIssues(await readFile(file, 'utf8'))) {
      counts[rel] ??= {}
      counts[rel][x.phrase] = (counts[rel][x.phrase] ?? 0) + 1
      details.push({ file: rel, ...x })
    }
  }
  return { counts, details, fileCount: files.length }
}

async function main() {
  const update = process.argv.includes('--update')
  const { counts, details, fileCount } = await scanAll()

  if (update) {
    writeBaseline(BASELINE_PATH, counts)
    console.log(`copy-lint: baseline written (${details.length} existing occurrence(s) ratcheted).`)
    return
  }

  const baseline = readBaseline(BASELINE_PATH)
  const failures = newViolations(counts, baseline)

  if (failures.length > 0) {
    console.log('✗ NEW banned product-copy terms (beyond the ratcheting baseline):\n')
    for (const f of failures) {
      const suggestion = BANNED.find(([p]) => p === f.key)?.[1] ?? ''
      console.log(
        `  ${f.file} — "${f.key}": ${f.count} found, baseline allows ${f.allowed}` +
          (suggestion ? ` → prefer "${suggestion}"` : ''),
      )
      for (const d of details.filter((d) => d.file === f.file && d.phrase === f.key)) {
        console.log(`    ${f.file}:${d.line}:${d.col}`)
      }
    }
    console.log(
      `\nSee docs/product/copy-guidelines.md; add \`// ${IGNORE}\` for a legitimate advanced ` +
        `surface, or — only for a reviewed, intentional change — run ` +
        `\`npm run lint:copy:update\` to rewrite the baseline.`,
    )
    process.exit(1)
  }

  console.log(
    `✓ No new banned product-copy terms in ${fileCount} frontend source files ` +
      `(${details.length} baselined occurrence(s) remain).` +
      (hasShrunk(counts, baseline)
        ? ' Debt shrank — run `npm run lint:copy:update` to tighten the ratchet.'
        : ''),
  )
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
