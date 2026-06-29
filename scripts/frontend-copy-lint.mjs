#!/usr/bin/env node
// Advisory frontend-copy lint: flag banned technical terms from
// docs/product/copy-guidelines.md in user-facing frontend source, so the copy
// guidelines reach the UI code (not just docs/product, where Vale stops).
//
// Deliberately CONSERVATIVE: only unambiguous **multi-word** phrases, never bare
// words like "safe"/"owner"/"deploy", so false positives stay ~zero. Add
// `// copy-lint-ignore` on the offending line (or the line above) for a
// legitimate advanced/developer-facing surface.
//
// Advisory: prints findings and exits 1 so `npm run lint:copy` is visible
// locally, but the CI job runs it continue-on-error and never blocks a merge.

import { readFile, readdir } from 'node:fs/promises'
import { join, dirname, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
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
  ['transaction hash', 'setup transaction'],
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
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.includes(IGNORE)) continue
    if (i > 0 && lines[i - 1].includes(IGNORE)) continue
    const lower = line.toLowerCase()
    for (const [phrase, suggestion] of BANNED) {
      const col = lower.indexOf(phrase)
      if (col !== -1) out.push({ line: i + 1, col: col + 1, phrase, suggestion })
    }
  }
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

async function main() {
  const files = []
  for (const dir of SCAN_DIRS) await walk(dir, files)
  let count = 0
  for (const file of files.sort()) {
    const rel = relative(REPO_ROOT, file).split(sep).join('/')
    const issues = findCopyIssues(await readFile(file, 'utf8'))
    for (const x of issues) {
      console.log(`${rel}:${x.line}:${x.col}  "${x.phrase}" → prefer "${x.suggestion}"`)
      count++
    }
  }
  if (count > 0) {
    console.log(
      `\n✗ ${count} banned-term occurrence(s) in frontend copy. ` +
        `See docs/product/copy-guidelines.md; add \`// ${IGNORE}\` for a legitimate advanced surface.`,
    )
    process.exit(1)
  }
  console.log(`✓ No banned product-copy terms in ${files.length} frontend source files.`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
