#!/usr/bin/env node
// Doc-health JSON for the ops console's doc-health panel (#3511, epic #3507).
//
//   node scripts/docs/doc-health.mjs [--out <path>] [--generated-at <ISO>]
//
// Without --out the JSON goes to stdout. The ops app's `prebuild` (#3515)
// writes it to a git-ignored path and imports it at build time; Vercel's
// "include files outside root directory" must stay on so `prebuild` can reach
// `../../docs` and `../../scripts` (#3517's runbook).
//
// It derives nothing the docs system does not already define:
// - the population is `listDocFiles()` from validate-frontmatter.mjs (CASP
//   changelog shards excluded, not flagged — they carry no front-matter by
//   design, #1366), minus `docs/archive/**`, plus the governed package docs
//   from package-docs.mjs;
// - front-matter is parsed by the validator's own `parseFrontMatter`.
//
// Deterministic: docs are sorted by path and every flag is computed against
// `generatedAt`, the only wall-clock value — so two runs with the same
// `--generated-at` on an unchanged tree are byte-identical.

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { REPO_ROOT, listDocFiles, parseFrontMatter } from './validate-frontmatter.mjs'
import { GOVERNED_PACKAGE_DOCS } from './package-docs.mjs'

export const UNVERIFIED_DAYS = 90
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const DAY_MS = 24 * 60 * 60 * 1000

/** Flags, in the order they are reported. */
export const FLAGS = ['no-front-matter', 'no-owner', 'empty-covers', 'unverified-90d']

// Read with the panel, so an empty `no-owner` / `no-front-matter` column is not
// mistaken for a broken instrument, and `unverified-90d` is not mistaken for
// the repo's commit-based staleness signal.
export const NOTES = [
  '`no-front-matter` and `no-owner` cannot fire on a governed doc: validate-frontmatter.mjs is a hard CI gate (docs:check), so an empty column is the expected state, not a broken instrument.',
  '`unverified-90d` is age only: `last-verified` more than 90 days before `generatedAt`, excluding `status: archived|research`. It is NOT the commit-based staleness signal (audit-staleness.mjs, the weekly "Docs staleness audit (weekly)" issue), which counts commits to a doc\'s `covers` since it was verified and cannot be computed at build time on a shallow clone.',
  '`empty-covers` is a doc with `covers: []`. The validator requires an inline reason for it, so it is a deliberately uncoupled doc that no coupling gate can implicate, not an error.',
]

/** True when `docs/archive/**` — the archive is a record, not a doc surface. */
export function isArchived(path) {
  return path.startsWith('docs/archive/')
}

/** Whole days from a `YYYY-MM-DD` date to `generatedAt` (UTC). */
function daysSince(date, generatedAt) {
  return Math.floor((Date.parse(generatedAt) - Date.parse(`${date}T00:00:00Z`)) / DAY_MS)
}

/**
 * One doc's entry. `fm` is either a parsed front-matter `data` object or null
 * (no parseable front-matter).
 */
export function docEntry(path, fm, generatedAt) {
  const flags = []
  if (!fm) {
    flags.push('no-front-matter')
    return { path, owner: null, status: null, lastVerified: null, flags }
  }
  const owner = fm.owner || null
  const status = fm.status || null
  const lastVerified = fm['last-verified'] || null
  if (!owner) flags.push('no-owner')
  if (Array.isArray(fm.covers) && fm.covers.length === 0) flags.push('empty-covers')
  if (
    status !== 'archived' &&
    status !== 'research' &&
    lastVerified &&
    DATE_RE.test(lastVerified) &&
    daysSince(lastVerified, generatedAt) > UNVERIFIED_DAYS
  ) {
    flags.push('unverified-90d')
  }
  return { path, owner, status, lastVerified, flags }
}

/**
 * The report from already-read inputs. Pure, so tests feed it fixtures.
 *
 * @param {{ docs: Array<{ path: string, raw: string }>, packageDocs: Array<{ doc: string, owner?: string, status?: string, covers?: string[], 'last-verified'?: string }>, generatedAt: string }} input
 */
export function buildDocHealth({ docs, packageDocs, generatedAt }) {
  if (Number.isNaN(Date.parse(generatedAt))) throw new Error(`generatedAt is not a date: ${generatedAt}`)
  const entries = []
  for (const { path, raw } of docs) {
    if (isArchived(path)) continue
    const parsed = parseFrontMatter(raw)
    entries.push(docEntry(path, parsed.ok ? parsed.data : null, generatedAt))
  }
  for (const p of packageDocs) entries.push(docEntry(p.doc, p, generatedAt))
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))

  const counts = Object.fromEntries(FLAGS.map((f) => [f, entries.filter((e) => e.flags.includes(f)).length]))
  return { generatedAt, unverifiedDays: UNVERIFIED_DAYS, notes: NOTES, total: entries.length, counts, docs: entries }
}

/** Read the live repository's population. */
export async function readRepoDocs() {
  const paths = (await listDocFiles()).filter((p) => !isArchived(p))
  const docs = []
  for (const path of paths) docs.push({ path, raw: await readFile(join(REPO_ROOT, path), 'utf8') })
  return docs
}

function parseArgs(argv) {
  const args = { out: null, generatedAt: null }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') args.out = argv[++i]
    else if (argv[i] === '--generated-at') args.generatedAt = argv[++i]
    else throw new Error(`unknown argument: ${argv[i]}`)
  }
  if (args.out === undefined) throw new Error('--out needs a path')
  if (args.generatedAt === undefined) throw new Error('--generated-at needs an ISO timestamp')
  return args
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const report = buildDocHealth({
    docs: await readRepoDocs(),
    packageDocs: GOVERNED_PACKAGE_DOCS,
    generatedAt: args.generatedAt ?? new Date().toISOString(),
  })
  const json = `${JSON.stringify(report, null, 2)}\n`
  if (args.out) {
    await writeFile(args.out, json)
    console.error(`doc-health: ${report.total} docs → ${args.out}`)
  } else {
    process.stdout.write(json)
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
