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
// ── WHAT IS SCANNED, AND WHY IT IS NOT EVERYTHING (#2317) ────────────────────
//
// Two inputs: whole directories (SCAN_DIRS) and an explicit file allowlist
// (SCAN_FILES). Read both before adding copy anywhere else.
//
// `src/lib` and `src/hooks` are scanned by DIRECTORY not at all, on purpose:
// they are where the banned phrases are legitimate CODE rather than copy
// (`delegationPasskeySigner.ts` genuinely refers to a "passkey signer";
// `allowance-module.ts` genuinely refers to the allowance module). Widening
// SCAN_DIRS to all of `src/lib` would bury a high-signal blocking check in
// false positives from real identifiers, so the exclusion stays.
//
// The exclusion's premise — "lib is utilities" — is FALSE for a growing
// handful of files that hold nothing but user-facing prose, and for those the
// gate went green while looking at nothing in them (#2317, found on PR #2311,
// which added six lines of new downloadable prose to `agent-skill-bundle.ts`).
// SCAN_FILES is the narrow answer: name the prose-bearing files individually
// instead of widening the directory rule.
//
// **If you add a prose file under `src/lib` (or any other unscanned path), this
// gate will not see it until you add it to SCAN_FILES.** A green
// "Banned product-copy terms" on a PR that only touched such a file says
// nothing about that file. Entries must resolve to real files: a path that
// matches nothing FAILS the run loudly rather than passing quietly — an
// allowlist entry pointing at a moved or deleted file is the same silent-hole
// defect one level up.
//
//   node scripts/frontend-copy-lint.mjs            # check against the baseline
//   node scripts/frontend-copy-lint.mjs --update   # rewrite the baseline (shrink
//                                                   # or a reviewed, intentional add)

import { readFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { newViolations, hasShrunk, writeBaseline, readBaseline } from './lib/ratchet.mjs'
import { isEscaped } from './lib/lint-escapes.mjs'

// Re-exported so tests and any future consumer use the SHARED ratchet engine
// (scripts/lib/ratchet.mjs) — the same implementation design-lint uses.
export { newViolations }

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BASELINE_PATH = join(REPO_ROOT, 'packages', 'frontend', 'copy-lint-baseline.json')
// Whole directories where user-facing copy lives — pages and components. NOT
// lib/hooks, where these technical terms are legitimate code; see the header's
// "WHAT IS SCANNED" note for that exclusion and for SCAN_FILES, the escape
// hatch for prose that lives outside these two trees.
const SCAN_DIRS = [
  join(REPO_ROOT, 'packages', 'frontend', 'src', 'app'),
  join(REPO_ROOT, 'packages', 'frontend', 'src', 'components'),
]

// Individual prose-bearing files OUTSIDE those directories (#2317). The bar is
// "a human reads or downloads this text as product copy", not "this file
// contains strings" — a utility with user-visible identifiers stays out.
// Repo-root-relative POSIX paths; each MUST exist (see missingTargets below).
export const SCAN_FILES = [
  // Downloaded verbatim from the connect-agent success screen's "Download the
  // skill" button (SetupStates.tsx) as `haven-pay/SKILL.md`, then read by an
  // agent as instructions. The originating case for this allowlist.
  'packages/frontend/src/lib/agent-skill-bundle.ts',
  // The other artifact of that same download flow: `buildHandoff` /
  // `buildDotenv` become README.md and .env.example inside the SDK-starter zip.
  'packages/frontend/src/lib/agent-handoff.ts',
  // Single-sentence UI copy modules, extracted out of `components/` so two
  // surfaces say one fact identically (#2195, #2230). The extraction is what
  // moved them out of the scanned tree; the copy is as user-facing as it was.
  'packages/frontend/src/lib/agent-pause-copy.ts',
  'packages/frontend/src/lib/stranded-funds-copy.ts',
  // The CANONICAL copy of the skill above, byte-pinned to the frontend inline
  // copy by a parity test. It is not a frontend file, but it is the copy the
  // connector auto-installs — i.e. the PRIMARY delivery path, of which the
  // frontend download is the fallback. Covering only the fallback would be
  // this issue's own defect one package over.
  'packages/sdk/src/skill-content.ts',
]

/**
 * Pure core of the allowlist self-check: which of `entries` does `exists` say
 * is not there. An entry resolving to no file makes the gate silently narrower
 * than it reads, so the caller fails the run on a non-empty result.
 */
export function missingTargets(entries, exists) {
  return entries.filter((e) => !exists(e))
}

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
  for (const dir of SCAN_DIRS) {
    const before = files.length
    await walk(dir, files)
    // `walk` swallows a missing directory and returns []. A SCAN_DIR that
    // contributes nothing means the gate is scanning less than it claims —
    // say so instead of reporting a clean run over a smaller tree.
    if (files.length === before) {
      throw new Error(
        `copy-lint: SCAN_DIRS entry matched no source files: ${relative(REPO_ROOT, dir)}\n` +
          'The directory moved or is empty — repoint it, do not leave it matching nothing.',
      )
    }
  }

  // An emptied allowlist reads as "nothing to allowlist" and scans strictly
  // less than yesterday. There IS prose outside SCAN_DIRS, so zero is wrong by
  // construction — fail here rather than leaning on the sibling test job.
  if (SCAN_FILES.length === 0) {
    throw new Error(
      'copy-lint: SCAN_FILES is empty. Prose-bearing files outside SCAN_DIRS exist ' +
        '(see the header note) — an empty allowlist silently narrows the gate.',
    )
  }

  const missing = missingTargets(SCAN_FILES, (rel) => existsSync(join(REPO_ROOT, rel)))
  if (missing.length > 0) {
    throw new Error(
      `copy-lint: SCAN_FILES allowlist entries do not exist:\n${missing.map((m) => `  ${m}`).join('\n')}\n` +
        'A prose file that moved leaves the gate silently narrower than it reads — ' +
        'repoint the entry (or remove it if the prose is gone).',
    )
  }
  for (const rel of SCAN_FILES) files.push(join(REPO_ROOT, rel))

  const counts = {}
  const details = []
  for (const file of [...new Set(files)].sort()) {
    const rel = relative(REPO_ROOT, file).split(sep).join('/')
    for (const x of findCopyIssues(await readFile(file, 'utf8'))) {
      counts[rel] ??= {}
      counts[rel][x.phrase] = (counts[rel][x.phrase] ?? 0) + 1
      details.push({ file: rel, ...x })
    }
  }
  return { counts, details, fileCount: new Set(files).size }
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
    `✓ No new banned product-copy terms in ${fileCount} source files ` +
      `(${SCAN_DIRS.length} scanned dirs + ${SCAN_FILES.length} allowlisted prose files) ` +
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
