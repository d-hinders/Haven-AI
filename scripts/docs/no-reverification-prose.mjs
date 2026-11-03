#!/usr/bin/env node
// Census for re-verification prose in the docs tree (#4613, epic #4610).
//
// "Every shape" is defined by an instrument, not a list. A regex over
// `Re-(verified|checked)` misses `> **Re-verification (#N, …):**`,
// `> **Recent re-verification (#N):**`, `#N re-verification`,
// `> **Re-read, not rubber-stamped:**` and `> **Re-verified, …`; a
// paragraph-start rule misses paragraphs after a bare `>` line inside a
// blockquote run. So the rule is:
//
//   a paragraph-opening line — after a blank line or a bare `>` line, a
//   heading line, or the first line of a blockquote run — outside fenced
//   code, whose first 70 characters contain `re-verif`, `re-check`,
//   `re-read` or `rubber-stamp` (case-insensitive, hyphen optional).
//
// `--census` prints the counts the epic's figures were measured with. The
// guard mode that fails a live doc carrying an opener is slice 3 (#4614);
// this file is shared with it, so the rule lives here once.

import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { REPO_ROOT, walk } from './validate-frontmatter.mjs'

/** The four words, hyphen optional, case-insensitive, on a word boundary. */
export const WORD = /(^|[^a-z])(re-?verif|re-?check|re-?read|rubber-stamp)/i

/** Only the first 70 characters of the opening line are inspected. */
export const OPENER_WINDOW = 70

/** `#{1,6}` followed by whitespace (or end of line) — a wrapped `#NNNN …` body line is not a heading. */
export const HEADING = /^\s*#{1,6}(\s|$)/

/** A fenced-code delimiter. */
export const FENCE = /^\s*```/

/** A bare `>` line: a blockquote paragraph separator. */
export const isBareQuote = (line) => line.trim() === '>'

/** Any blockquote line. */
export const isQuote = (line) => line.trimStart().startsWith('>')

/** The `status:` scalar of the leading front-matter block, or `none`. */
export function frontMatterStatus(lines) {
  let fences = 0
  for (const line of lines) {
    if (line.trim() === '---') {
      fences += 1
      continue
    }
    if (fences === 1 && line.startsWith('status:')) return line.split(':', 2)[1].trim()
    if (fences >= 2) break
  }
  return 'none'
}

/**
 * Every opener in `lines`, as 1-based line numbers.
 *
 * `prev` is the previous non-fence line, so a paragraph after a blank line, a
 * bare `>` line, a heading line, or the first line of a blockquote run opens.
 */
export function findOpeners(lines) {
  const openers = []
  let fence = false
  let prev = ''
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (FENCE.test(line)) {
      fence = !fence
      prev = line
      continue
    }
    if (fence) {
      prev = line
      continue
    }
    const opens =
      prev.trim() === '' ||
      prev.trim() === '>' ||
      (isQuote(line) && !isQuote(prev)) ||
      HEADING.test(line)
    if (opens && WORD.test(line.slice(0, OPENER_WINDOW))) openers.push(i + 1)
    prev = line
  }
  return openers
}

/** The bytes an opener's paragraph occupies, opener to the next blank line. */
export function paragraphBytes(lines, openers) {
  const taken = new Set()
  for (const opener of openers) {
    let j = opener - 1
    while (j < lines.length && lines[j].trim() !== '') {
      taken.add(j)
      j += 1
    }
  }
  // The epic's figures were measured with Python's `len(line) + 1`, i.e. code
  // points plus the newline. `.length` matches that for this tree (no astral
  // characters in the notes); the figure is a size proxy, not a byte count.
  let bytes = 0
  for (const j of taken) bytes += lines[j].length + 1
  return bytes
}

/** The doc population the census reads: every Markdown file under docs/, minus docs/archive/. */
export function censusPaths(paths) {
  return paths
    .filter((path) => path.endsWith('.md'))
    .filter((path) => !path.startsWith('docs/archive/'))
    .sort()
}

async function workingTreeDocs() {
  const paths = censusPaths(await walk(join(REPO_ROOT, 'docs')))
  const docs = []
  for (const path of paths) docs.push({ path, lines: (await readFile(join(REPO_ROOT, path), 'utf8')).split('\n') })
  return docs
}

function revisionDocs(rev) {
  const paths = censusPaths(
    execFileSync('git', ['ls-tree', '-r', '--name-only', rev, '--', 'docs'], { cwd: REPO_ROOT, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean),
  )
  return paths.map((path) => ({
    path,
    lines: execFileSync('git', ['show', `${rev}:${path}`], { cwd: REPO_ROOT, encoding: 'utf8' }).split('\n'),
  }))
}

/** Count openers by status, plus the per-doc figures the epic quotes. */
export function census(docs) {
  const byStatus = {}
  const current = new Map()
  const bytes = new Map()
  let couplingNotes = 0
  for (const { path, lines } of docs) {
    const status = frontMatterStatus(lines)
    const openers = findOpeners(lines)
    byStatus[status] = (byStatus[status] ?? 0) + openers.length
    if (status !== 'current' || openers.length === 0) continue
    current.set(path, openers.length)
    bytes.set(path, paragraphBytes(lines, openers))
    for (const opener of openers) {
      if (lines[opener - 1].includes('Re-verified unchanged')) couplingNotes += 1
    }
  }
  const totalBytes = [...bytes.values()].reduce((sum, n) => sum + n, 0)
  return { byStatus, current, bytes, totalBytes, couplingNotes }
}

function printCensus(result) {
  const ordered = Object.fromEntries(
    ['current', 'record', 'archived', 'none', 'research']
      .filter((status) => status in result.byStatus)
      .map((status) => [status, result.byStatus[status]]),
  )
  for (const status of Object.keys(result.byStatus)) if (!(status in ordered)) ordered[status] = result.byStatus[status]
  console.log(`openers by status: ${JSON.stringify(ordered).replace(/"/g, "'").replace(/:/g, ': ').replace(/,/g, ', ')}`)
  console.log(`current docs: ${result.current.size} bytes: ${result.totalBytes}`)
  const top = [...result.current.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)
  console.log(`top: ${top.map(([path, n]) => `${path} ${n}`).join(', ')}`)
  console.log(`coupling notes: ${result.couplingNotes}`)
  console.log(`security model bytes: ${result.bytes.get('docs/security/delegation-rail-security-model.md') ?? 0}`)
}

async function main() {
  const args = process.argv.slice(2)
  const revIndex = args.indexOf('--rev')
  const rev = revIndex === -1 ? null : args[revIndex + 1]
  if (revIndex !== -1 && !rev) throw new Error('--rev needs a revision')
  if (!args.includes('--census')) {
    console.error('usage: node scripts/docs/no-reverification-prose.mjs --census [--rev <sha>]')
    process.exit(2)
  }
  const docs = rev ? revisionDocs(rev) : await workingTreeDocs()
  printCensus(census(docs))
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    await main()
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
}
