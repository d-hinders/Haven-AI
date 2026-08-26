#!/usr/bin/env node
// Validate documentation front-matter (Phase 1 of the docs-quality system).
//
// Every doc under docs/ plus the root gravity files carries a small YAML
// front-matter header that is the machine-readable join key between a doc and
// the code it describes:
//
//   ---
//   owner: "@handle"
//   status: current | research | archived
//   covers:
//     - packages/backend/src/routes/payments.ts
//   last-verified: "2026-06-28"
//   ---
//
// This script asserts that header is present and well-formed, and that every
// `covers` glob resolves to at least one real path. It is dependency-free
// (no js-yaml): it parses the limited schema by hand and matches globs against
// a walked file list, so it runs anywhere Node 24 runs.
//
// See docs/contributing/docs-quality-system.md for the schema and rationale.

import { readFile, readdir } from 'node:fs/promises'
import { join, dirname, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

const STATUSES = new Set(['current', 'research', 'archived'])
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

// Root-level docs that are part of the doc surface even though they live
// outside docs/. These are the "gravity files" agents read first.
export const ROOT_DOCS = ['CLAUDE.md', 'AGENTS.md', 'README.md', 'ABOUT_HAVEN.md']

// Directories never worth walking when resolving `covers` globs or finding docs.
const IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.next',
  'coverage',
  'out',
  '.turbo',
])

/** Recursively list every file under `root` as repo-relative posix paths. */
export async function walk(root) {
  const out = []
  async function recurse(dir) {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue
        await recurse(join(dir, entry.name))
      } else if (entry.isFile()) {
        out.push(relative(REPO_ROOT, join(dir, entry.name)).split(sep).join('/'))
      }
    }
  }
  await recurse(root)
  return out
}

/** Turn a glob (supporting **, *, ?) into an anchored RegExp. */
export function globToRegExp(glob) {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // `**/` matches any number of leading directories (including none);
        // a bare `**` matches anything.
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?'
          i += 2
        } else {
          re += '.*'
          i += 1
        }
      } else {
        re += '[^/]*'
      }
    } else if (c === '?') {
      re += '[^/]'
    } else if ('.+^${}()|[]\\'.includes(c)) {
      re += '\\' + c
    } else {
      re += c
    }
  }
  return new RegExp('^' + re + '$')
}

/**
 * The inline `# reason` on a literal `covers: []` line, or null.
 *
 * Read from the RAW front-matter rather than from `parseFrontMatter`, which
 * strips trailing comments by design (globs never contain `#`, so stripping is
 * correct for the glob list itself). The reason is metadata ABOUT the empty
 * list, not an item in it.
 *
 * ⚠️ Recognizes only the literal single-line `covers: []` form. Two other
 * spellings also parse to an EMPTY list — a `covers:` block header with no
 * `- ` items under it, and `covers: [ ]` — and this returns null for both even
 * if a reason is written there, so the caller blocks. That is fail-CLOSED
 * (never a silent pass) and the caller's message names the canonical syntax, so
 * the contributor's fix is to write the canonical form. Named here because a
 * reader would otherwise assume the coverage is total.
 */
export function emptyCoversNote(raw) {
  const block = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!block) return null
  const line = block[1].split(/\r?\n/).find((l) => /^covers:\s*\[\]/.test(l))
  if (!line) return null
  const note = line.replace(/^covers:\s*\[\]\s*/, '').replace(/^#\s*/, '').trim()
  return note.length > 0 ? note : null
}

/**
 * Parse the leading `---` front-matter block. Returns { ok, data, error }.
 * Deliberately minimal: handles scalar keys and a `covers` block-list or
 * inline `[]`, with `# comments` stripped from scalar lines.
 */
export function parseFrontMatter(raw) {
  if (!raw.startsWith('---')) {
    return { ok: false, error: 'missing front-matter (file must start with `---`)' }
  }
  const lines = raw.split(/\r?\n/)
  if (lines[0].trim() !== '---') {
    return { ok: false, error: 'malformed opening front-matter fence' }
  }
  let end = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      end = i
      break
    }
  }
  if (end === -1) {
    return { ok: false, error: 'unterminated front-matter block (no closing `---`)' }
  }

  const data = {}
  let i = 1
  while (i < end) {
    const line = lines[i]
    if (line.trim() === '' || line.trim().startsWith('#')) {
      i++
      continue
    }
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/)
    if (!m) {
      return { ok: false, error: `unparseable front-matter line: "${line}"` }
    }
    const key = m[1]
    let rest = m[2]
    if (key === 'covers' || key === 'satisfied-by') {
      // Strip a trailing `# comment` (globs never contain `#`).
      const hashIdx = rest.indexOf(' #')
      if (hashIdx !== -1) rest = rest.slice(0, hashIdx)
      const inline = rest.trim()
      if (inline === '[]' || inline === '') {
        const items = []
        // Block list form: subsequent `  - item` lines, each with its own
        // trailing `# comment` stripped (same as scalars and the inline form).
        let j = i + 1
        while (j < end && /^\s*-\s+/.test(lines[j])) {
          let item = lines[j].replace(/^\s*-\s+/, '')
          const h = item.indexOf(' #')
          if (h !== -1) item = item.slice(0, h)
          items.push(item.trim().replace(/^["']|["']$/g, ''))
          j++
        }
        // Literal `covers: []` means "narrative, no items": consume just that
        // line. (Following `- ` lines, if any, are malformed and the main loop
        // reports them loudly rather than silently dropping them.) Empty inline
        // (`covers:`) takes the block list that follows.
        data[key] = inline === '[]' ? [] : items
        i = inline === '[]' ? i + 1 : j
        continue
      }
      // Inline `[a, b]` form.
      const body = inline.replace(/^\[/, '').replace(/\]$/, '')
      data[key] = body
        .split(',')
        .map((s) => s.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean)
      i++
      continue
    }
    // Scalar: strip a trailing comment and surrounding quotes.
    const hash = rest.indexOf(' #')
    if (hash !== -1) rest = rest.slice(0, hash)
    data[key] = rest.trim().replace(/^["']|["']$/g, '')
    i++
  }
  return { ok: true, data }
}

async function main() {
  const docFiles = (await walk(join(REPO_ROOT, 'docs')))
    .filter((p) => p.endsWith('.md'))
    // #1366: CASP changelog shards are FRAGMENTS of the parent contract doc
    // (one per-issue verification entry each), not standalone docs — requiring
    // owner/status/covers/last-verified on every one-paragraph shard would
    // recreate the very per-PR boilerplate the sharding removes. The dir's
    // README.md keeps full front-matter and documents the convention.
    .filter((p) => !(p.startsWith('docs/regulatory/casp-changelog/') && !p.endsWith('README.md')))
  for (const root of ROOT_DOCS) docFiles.push(root)

  const allFiles = await walk(REPO_ROOT)
  const errors = []

  for (const rel of docFiles.sort()) {
    const raw = await readFile(join(REPO_ROOT, rel), 'utf8')
    const parsed = parseFrontMatter(raw)
    if (!parsed.ok) {
      errors.push(`${rel}: ${parsed.error}`)
      continue
    }
    const { owner, status, covers, 'last-verified': lastVerified } = parsed.data

    if (!owner) errors.push(`${rel}: missing required key \`owner\``)
    if (!status) {
      errors.push(`${rel}: missing required key \`status\``)
    } else if (!STATUSES.has(status)) {
      errors.push(`${rel}: invalid status "${status}" (expected ${[...STATUSES].join(' | ')})`)
    }
    if (!lastVerified) {
      errors.push(`${rel}: missing required key \`last-verified\``)
    } else if (!DATE_RE.test(lastVerified)) {
      errors.push(`${rel}: \`last-verified\` must be YYYY-MM-DD, got "${lastVerified}"`)
    }
    if (covers === undefined) {
      errors.push(`${rel}: missing required key \`covers\` (use \`covers: []\` for narrative docs)`)
      continue
    }
    // An EMPTY `covers:` must say why (#1993).
    //
    // A doc with front-matter and `covers: []` looks governed — it is in the
    // inventory, it has an owner and a `last-verified` — while no coupling gate
    // can ever implicate it, because an empty glob list matches nothing. That is
    // strictly more dangerous than a doc with no front-matter at all, which is
    // at least VISIBLY outside the system. It bit for real: ABOUT_HAVEN.md, the
    // designated first-read mental-model doc, contradicted five merged
    // retirement slices and nothing mechanical could have said so (#1992).
    //
    // The fix is not to forbid `covers: []` — narrative docs and process
    // playbooks genuinely have no code mirror. It is to make the DECISION
    // explicit, so an audit can tell "deliberately uncoupled, here is why" from
    // "nobody ever decided". The convention already existed by hand on 20 of the
    // 22 empty-covers docs; this makes it mechanical.
    //
    // Scope, stated so the green is not over-read: this only reaches the files
    // `docFiles` enumerates — `docs/**` plus the four root gravity files. A
    // Markdown file under `packages/**` has no front-matter at all and is
    // outside the docs-quality system entirely; that is a separate, visible gap
    // (#2078), not one this rule closes.
    if (covers.length === 0 && !emptyCoversNote(raw)) {
      errors.push(
        `${rel}: \`covers: []\` needs an inline reason — write ` +
          '`covers: []  # <why this doc has no code mirror>`. An empty `covers` ' +
          'can never be implicated by the coupling gate, so an unexplained one is ' +
          'indistinguishable from a doc nobody decided about (#1993).',
      )
    }
    for (const glob of covers) {
      const re = globToRegExp(glob)
      if (!allFiles.some((f) => re.test(f))) {
        errors.push(`${rel}: \`covers\` glob "${glob}" resolves to no files`)
      }
    }

    // Soft structural rules: archive/ and research/ status must match folder.
    if (rel.startsWith('docs/archive/') && status !== 'archived') {
      errors.push(`${rel}: docs under archive/ must have status: archived`)
    }
    if (rel.startsWith('docs/research/') && !['research', 'archived'].includes(status)) {
      errors.push(`${rel}: docs under research/ must have status: research (or archived)`)
    }
  }

  if (errors.length) {
    console.error(`\n✗ Front-matter validation failed (${errors.length} issue(s)):\n`)
    for (const e of errors) console.error(`  - ${e}`)
    console.error('\nSee docs/contributing/docs-quality-system.md for the schema.\n')
    process.exit(1)
  }
  console.log(`✓ Front-matter valid across ${docFiles.length} docs.`)
}

// Only run the CLI when executed directly (`node validate-frontmatter.mjs`),
// not when imported by the test file.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
