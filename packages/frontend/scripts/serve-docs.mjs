#!/usr/bin/env node
// Serve the product docs as Markdown at stable frontend paths (#2532, A5 of
// the agent-first epic #2519).
//
// ## Why this exists
//
// `llms.txt` used to point at `docs.haven.xyz` — a host nobody owns — and
// #2520 replaced that with a link to the public GitHub repo, explicitly as a
// placeholder until these paths existed. An agent reading a Markdown manifest
// should not have to leave the origin it is reading to find the product docs.
//
// ## Why it GENERATES rather than duplicating
//
// A hand-copied doc is a doc that goes stale silently. The served copy is
// built from the source on every build, is gitignored, and carries a header
// naming the file it came from — so there is exactly one editable copy and it
// is the one the docs-quality coupling gate already governs.
//
// ## The allowlist is the control
//
// Only the files named below are served. `docs/contributing/` and
// `docs/operations/` are deliberately absent: they are addressed to people who
// work on Haven, and they carry internal URLs, runbook steps and operator
// state. Adding a doc here is a decision someone makes on purpose.

import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join, dirname, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const FRONTEND = dirname(dirname(fileURLToPath(import.meta.url)))
export const REPO_ROOT = dirname(dirname(FRONTEND))
export const OUT_DIR = join(FRONTEND, 'public', 'docs')

/** The public URL prefix these files are served under. */
export const SERVED_PREFIX = '/docs'

/**
 * Repository blob root for a doc we do NOT serve. The repo is public, so a
 * link out is a working link — which is the whole point: the alternative to
 * rewriting is publishing a relative path that 404s on this origin.
 */
const REPO_BLOB = 'https://github.com/d-hinders/Haven-AI/blob/dev'

/** source: repo-relative path. served: filename under `/docs/`. */
export const ALLOWLIST = [
  { source: 'docs/product/account-recovery.md', served: 'account-recovery.md' },
  { source: 'docs/product/agent-key-rotation.md', served: 'agent-key-rotation.md' },
  { source: 'docs/product/agent-passport.md', served: 'agent-passport.md' },
  { source: 'docs/security/delegation-rail-security-model.md', served: 'security-model.md' },
]

class ServeDocsError extends Error {}

/**
 * Split YAML front matter from the body.
 *
 * Deliberately strict about the opening delimiter: a doc without front matter
 * is a doc the quality system does not govern, and serving it would publish an
 * ungoverned page under a path that looks governed.
 */
export function splitFrontMatter(raw, source) {
  if (!raw.startsWith('---\n')) {
    throw new ServeDocsError(`${source}: no front matter — every served doc must be governed by the docs-quality system.`)
  }
  const end = raw.indexOf('\n---\n', 3)
  if (end === -1) {
    throw new ServeDocsError(`${source}: front matter is never closed.`)
  }
  return { frontMatter: raw.slice(4, end + 1), body: raw.slice(end + 5) }
}

/** The `status:` value, or null. */
export function readStatus(frontMatter) {
  const match = frontMatter.match(/^status:\s*"?([A-Za-z0-9_-]+)"?\s*$/m)
  return match ? match[1] : null
}

/**
 * The `last-verified` DATE only.
 *
 * The real line carries the whole chained verification note behind a `#`,
 * which is thousands of characters and addressed to contributors. The served
 * header wants the date and nothing else.
 */
export function readLastVerified(frontMatter) {
  const match = frontMatter.match(/^last-verified:\s*"?(\d{4}-\d{2}-\d{2})"?/m)
  return match ? match[1] : null
}

/**
 * Rewrite every relative Markdown link so it resolves from the served copy.
 *
 * This is the part that is easy to skip and wrong to skip. Each of the four
 * sources links to siblings by relative path; most of those targets are NOT
 * served. Copying verbatim publishes `](../regulatory/casp-risk-guardrails.md)`
 * to an agent, which resolves against this origin and 404s — the same class of
 * defect #2520 removed from these very artifacts.
 *
 * A link to another served doc becomes its served path. Everything else
 * becomes a repository URL, which works because the repository is public.
 * Absolute URLs, anchors and mailto: are left exactly as they are.
 */
export function rewriteLinks(body, source) {
  const servedBySource = new Map(ALLOWLIST.map((e) => [e.source, `${SERVED_PREFIX}/${e.served}`]))
  const sourceDir = dirname(source)
  return body.replace(/\]\(([^)\s]+)(\s+"[^"]*")?\)/g, (whole, target, title = '') => {
    if (/^([a-z][a-z0-9+.-]*:|\/\/|#|\/)/i.test(target)) return whole
    const [path, hash = ''] = target.split(/(#.*)$/)
    if (!path) return whole
    const repoPath = relative(REPO_ROOT, resolve(REPO_ROOT, sourceDir, path)).split('\\').join('/')
    const served = servedBySource.get(repoPath)
    const next = served ? `${served}${hash}` : `${REPO_BLOB}/${repoPath}${hash}`
    return `](${next}${title})`
  })
}

/** The generated file's content, header included. */
export function renderServedDoc(raw, source) {
  const { frontMatter, body } = splitFrontMatter(raw, source)
  const status = readStatus(frontMatter)
  if (status !== 'current') {
    throw new ServeDocsError(
      `${source}: status is ${status ?? '(absent)'}, not "current". ` +
        'A doc that is superseded or draft must not be served as the product answer — ' +
        'either restore it to current or remove it from the allowlist in ' +
        'packages/frontend/scripts/serve-docs.mjs.',
    )
  }
  const lastVerified = readLastVerified(frontMatter)
  if (!lastVerified) {
    throw new ServeDocsError(`${source}: no last-verified date to stamp on the served copy.`)
  }
  const header = `Source: ${source}, last-verified ${lastVerified}. Generated — edit the source, not this file.`
  return `${header}\n\n${rewriteLinks(body, source).replace(/^\n+/, '')}`
}

export function generate({ repoRoot = REPO_ROOT, outDir = OUT_DIR } = {}) {
  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })
  const written = []
  for (const entry of ALLOWLIST) {
    const raw = readFileSync(join(repoRoot, entry.source), 'utf8')
    writeFileSync(join(outDir, entry.served), renderServedDoc(raw, entry.source), 'utf8')
    written.push(`${SERVED_PREFIX}/${entry.served}`)
  }
  return written
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (invokedDirectly) {
  try {
    const written = generate()
    console.log(`serve-docs: wrote ${written.length} served doc(s): ${written.join(', ')}`)
  } catch (err) {
    console.error(`serve-docs: FAILED — ${err.message}`)
    process.exit(1)
  }
}
