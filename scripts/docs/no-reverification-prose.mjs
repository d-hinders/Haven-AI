#!/usr/bin/env node
// Census and guard for re-verification prose in the docs tree (#4613, #4614,
// epic #4610).
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
// Two modes, one rule:
//
//   --census   prints the counts the epic's figures were measured with
//              (#4613). It reads the whole file, front matter included, and
//              reports every status; it never refuses.
//   (default)  the guard (#4614): walks the validator's doc population
//              (`listDocFiles()`), reads each doc's front-matter block with
//              `parseFrontMatter`, and refuses an opener in the BODY of a
//              governed doc — `status: current`, or no status at all, since a
//              missing field is a broken doc and not an exemption. `record`,
//              `archived` and `research` are reported by the census and never
//              refused. It prints `file:line` per hit and exits 1 on any.
//
// The re-verification record is the `last-verified` bump after a real re-read,
// the `Re-verified-unchanged:` commit trailer, the version-literal partition
// or the release shard (#4612) — never a body paragraph (#2681).
//
// Neither mode reads git history: `docs.yml` checks out shallow for that
// reason.

import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { REPO_ROOT, listDocFiles, parseFrontMatter, walk } from './validate-frontmatter.mjs'

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

/**
 * The index of the first BODY line: just past the leading front-matter block's
 * closing fence, or 0 when there is no such block.
 *
 * The guard scans the body only, so a `last-verified` chain entry or a `covers`
 * comment that happens to carry one of the words is not a finding — the same
 * precedent `ui-gate-wording.mjs` set (#2657). An unterminated block returns 0,
 * which scans everything: fail-closed, and `validate-frontmatter.mjs` refuses
 * the doc anyway.
 */
export function bodyStart(lines) {
  if (lines[0]?.trim() !== '---') return 0
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === '---') return i + 1
  }
  return 0
}

/**
 * Whether a doc's `status` puts it under the guard.
 *
 * `current` and an absent status are governed; `record`, `archived` and
 * `research` are not (#2638, #4459). Written as an exemption list rather than
 * `status === 'current' || status === undefined` so an empty or unknown status
 * is governed too — a broken field is not an exemption.
 */
export function isGoverned(status) {
  return !EXEMPT_STATUSES.has(status)
}

/** The statuses the guard never refuses. */
export const EXEMPT_STATUSES = new Set(['record', 'archived', 'research'])

/** Every opener in a doc's BODY, as 1-based line numbers in the file. */
export function bodyOpeners(lines) {
  const start = bodyStart(lines)
  return findOpeners(lines.slice(start)).map((n) => n + start)
}

/**
 * The guard over `[{ path, raw }]`: every opener in a governed doc's body, plus
 * how many docs were governed (so a walker pointed at the wrong root cannot
 * report a clean scan over zero files).
 */
export function guard(docs) {
  const hits = []
  let scanned = 0
  for (const { path, raw } of docs) {
    const parsed = parseFrontMatter(raw)
    const status = parsed.ok ? parsed.data.status : undefined
    if (!isGoverned(status)) continue
    scanned += 1
    for (const line of bodyOpeners(raw.split('\n'))) hits.push({ path, line })
  }
  return { hits, scanned }
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

/** The validator's doc population, read from the working tree. */
async function guardDocs() {
  const paths = (await listDocFiles()).sort()
  const docs = []
  for (const path of paths) docs.push({ path, raw: await readFile(join(REPO_ROOT, path), 'utf8') })
  return docs
}

const USAGE = 'usage: node scripts/docs/no-reverification-prose.mjs [--census [--rev <sha>]]'

async function main() {
  const args = process.argv.slice(2)
  const revIndex = args.indexOf('--rev')
  const rev = revIndex === -1 ? null : args[revIndex + 1]
  if (revIndex !== -1 && !rev) throw new Error('--rev needs a revision')
  const censusMode = args.includes('--census')
  const consumed = new Set()
  if (censusMode) consumed.add(args.indexOf('--census'))
  if (revIndex !== -1) {
    consumed.add(revIndex)
    consumed.add(revIndex + 1)
  }
  const unknown = args.filter((_, i) => !consumed.has(i))
  if (unknown.length) {
    console.error(`unknown argument(s): ${unknown.join(' ')}\n${USAGE}`)
    process.exit(2)
  }
  if (censusMode) {
    const docs = rev ? revisionDocs(rev) : await workingTreeDocs()
    printCensus(census(docs))
    return
  }
  if (rev) {
    console.error(`--rev is only meaningful with --census\n${USAGE}`)
    process.exit(2)
  }
  const { hits, scanned } = guard(await guardDocs())
  if (hits.length === 0) {
    console.log(`✓ no re-verification prose in a governed doc (${scanned} docs scanned)`)
    return
  }
  console.error(`✗ Re-verification prose in a governed doc (${hits.length} opener(s)):`)
  for (const hit of hits) console.error(`${hit.path}:${hit.line}`)
  console.error(
    'The re-verification record is the `last-verified` bump after a real re-read, the\n' +
      '`Re-verified-unchanged:` commit trailer, the version-literal partition or the\n' +
      'release shard — never a body paragraph (#2681, #4614).',
  )
  process.exit(1)
}

// True only when this file is the process's entry point, so importing it (a
// self-test, a build config) never runs the CLI. Both paths are resolved
// before they are compared: Node resolves symlinks for a module's own URL and
// not for `process.argv[1]`, so an unresolved comparison is false through any
// symlink, and the script would exit 0 without running (#4776).
function isEntryPoint() {
  if (!process.argv[1]) return false
  try {
    const { realpathSync } = process.getBuiltinModule('node:fs')
    const { fileURLToPath } = process.getBuiltinModule('node:url')
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isEntryPoint()) {
  try {
    await main()
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
}
