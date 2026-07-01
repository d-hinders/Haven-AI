#!/usr/bin/env node
// Scaffold a new documentation file with valid front-matter (docs-quality system).
//
// New docs need the machine-readable front-matter header that joins a doc to the
// code it describes (owner / status / covers / last-verified). Authors and agents
// keep getting it wrong on the first try, so this makes the right thing the easy
// thing: emit a correct header, infer `status` from the path, and stamp today's
// date — then the author only fills in `covers` and the body.
//
//   npm run docs:new -- docs/operations/new-thing.md
//   npm run docs:new -- docs/research/idea.md --owner "@someone" --title "Big Idea"
//
// It refuses to overwrite an existing file, and its output is designed to pass
// `npm run docs:check`. Dependency-free (no js-yaml), like the sibling tools.
//
// See docs/contributing/docs-quality-system.md for the schema and rationale.

import { mkdir, writeFile, access } from 'node:fs/promises'
import { join, dirname, relative, sep, isAbsolute, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

const DEFAULT_OWNER = '@d-hinders'

/** Today's date as an YYYY-MM-DD string in the local timezone. */
export function todayIso(date = new Date()) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/**
 * Infer `status` from the doc's repo-relative path, matching the structural
 * rules validate-frontmatter enforces: docs/archive/** → archived,
 * docs/research/** → research, everything else → current.
 */
export function inferStatus(relPath) {
  const posix = relPath.split(sep).join('/')
  if (posix.startsWith('docs/archive/')) return 'archived'
  if (posix.startsWith('docs/research/')) return 'research'
  return 'current'
}

/** Derive a Title Case heading from a file path's base name. */
export function titleFromPath(relPath) {
  const stem = basename(relPath).replace(/\.md$/i, '')
  const words = stem
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
  return words.join(' ') || 'Untitled'
}

/**
 * Build the full contents of a new doc: a valid front-matter block followed by
 * an H1 heading and a placeholder line. `covers` is empty with the narrative
 * hint comment that validate-frontmatter accepts.
 */
export function buildDoc({ relPath, owner, title, today = todayIso() } = {}) {
  // Fall back on empty/whitespace too, not just `undefined` — an explicit
  // `--owner ""` must not write an `owner:` the validator would then reject.
  const resolvedOwner = (owner ?? '').trim() || DEFAULT_OWNER
  const heading = (title ?? '').trim() || titleFromPath(relPath)
  const status = inferStatus(relPath)
  return [
    '---',
    `owner: "${resolvedOwner}"`,
    `status: ${status}`,
    'covers: []  # narrative — list the code paths this doc describes, one per line',
    `last-verified: "${today}"`,
    '---',
    '',
    `# ${heading}`,
    '',
    '<!-- Replace this line with the doc body. -->',
    '',
  ].join('\n')
}

/** Resolve a user-supplied path to { abs, rel } against the repo root. */
export function resolveTarget(inputPath, repoRoot = REPO_ROOT) {
  const abs = isAbsolute(inputPath) ? inputPath : join(repoRoot, inputPath)
  const rel = relative(repoRoot, abs).split(sep).join('/')
  return { abs, rel }
}

/** True when a path exists (used to refuse overwrites). */
async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/**
 * Create the scaffolded doc on disk. Throws if the file already exists (never
 * overwrites) or if the path is not a Markdown file. Returns the written
 * repo-relative path.
 */
export async function createDoc({ inputPath, owner, title, today, repoRoot = REPO_ROOT } = {}) {
  if (!inputPath) {
    throw new Error('a target path is required, e.g. `npm run docs:new -- docs/area/thing.md`')
  }
  const { abs, rel } = resolveTarget(inputPath, repoRoot)
  if (!rel.endsWith('.md')) {
    throw new Error(`target must be a Markdown file (got "${rel}")`)
  }
  if (rel.startsWith('..')) {
    throw new Error(`target must live inside the repository (got "${inputPath}")`)
  }
  if (await exists(abs)) {
    throw new Error(`refusing to overwrite existing file: ${rel}`)
  }
  await mkdir(dirname(abs), { recursive: true })
  await writeFile(abs, buildDoc({ relPath: rel, owner, title, today }), { flag: 'wx' })
  return rel
}

/** Parse `<path> [--owner X] [--title Y]` into an options object. */
export function parseArgs(argv) {
  const opts = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--owner') {
      opts.owner = argv[++i]
    } else if (arg === '--title') {
      opts.title = argv[++i]
    } else if (arg.startsWith('--owner=')) {
      opts.owner = arg.slice('--owner='.length)
    } else if (arg.startsWith('--title=')) {
      opts.title = arg.slice('--title='.length)
    } else if (!opts.inputPath) {
      opts.inputPath = arg
    }
  }
  return opts
}

async function main() {
  try {
    const rel = await createDoc(parseArgs(process.argv.slice(2)))
    console.log(`✓ Scaffolded ${rel} — fill in \`covers\` and the body.`)
  } catch (err) {
    console.error(`✗ ${err.message}`)
    process.exit(1)
  }
}

// Only run the CLI when executed directly, not when imported by the test file.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main()
}
