import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { REPO_ROOT, walk } from './validate-frontmatter.mjs'
import { census, censusPaths, findOpeners, frontMatterStatus } from './no-reverification-prose.mjs'

/**
 * Verifier for the #4613 re-verification archive.
 *
 * The archive is the forensic record of every re-verification note the census
 * (`no-reverification-prose.mjs --census`) found in a `status: current` doc.
 * Each section pins its payload with a SHA-256 marker in the shape
 * `retire-verified-chains.mjs` uses for the `verified:` chains (#2681), so a
 * single changed byte in the archive fails this test — the same guarantee the
 * chain archive has.
 */

export const ARCHIVE = 'docs/archive/re-verification-notes-2026-11.md'

const digest = (text) => createHash('sha256').update(text).digest('hex')

/** Every `## \`path\`` section, its hash marker and its payload. */
export function parseArchive(raw) {
  const entries = []
  const re = /^## `([^`]+)`\n\n<!-- sha256: ([0-9a-f]{64}) -->\n```markdown\n([\s\S]*?)\n```$/gm
  for (const match of raw.matchAll(re)) entries.push({ path: match[1], hash: match[2], payload: match[3] })
  return entries
}

/** Parse and hash-check the archive; throws on a duplicate or a mismatch. */
export function verifyArchive(raw) {
  const entries = parseArchive(raw)
  if (entries.length === 0) throw new Error('archive has no sections')
  const seen = new Set()
  for (const entry of entries) {
    if (seen.has(entry.path)) throw new Error(`archive duplicates ${entry.path}`)
    seen.add(entry.path)
    if (digest(entry.payload) !== entry.hash) throw new Error(`archive hash does not match ${entry.path}`)
  }
  return entries
}

const root = fileURLToPath(new URL('../../', import.meta.url))

async function currentDocs() {
  const paths = censusPaths(await walk(join(REPO_ROOT, 'docs')))
  const docs = []
  for (const path of paths) docs.push({ path, lines: readFileSync(join(REPO_ROOT, path), 'utf8').split('\n') })
  return docs
}

test('#4613: the checked-in archive has one hash-pinned section per source doc', async () => {
  const entries = verifyArchive(readFileSync(join(root, ARCHIVE), 'utf8'))
  assert.equal(entries.length, 49)
  const docs = await currentDocs()
  const byPath = new Map(docs.map((doc) => [doc.path, doc]))
  for (const entry of entries) {
    const doc = byPath.get(entry.path)
    assert.ok(doc, `${entry.path} is not a doc the census reads`)
    assert.equal(frontMatterStatus(doc.lines), 'current', `${entry.path} is not status: current`)
    const links = doc.lines.filter((line) => line.includes('(../archive/re-verification-notes-2026-11.md)'))
    assert.equal(links.length, 1, `${entry.path} must link the archive exactly once`)
  }
})

test('#4613: no status: current doc carries a re-verification opener', async () => {
  const result = census(await currentDocs())
  assert.equal(result.byStatus.current ?? 0, 0)
  assert.equal(result.byStatus.record, 25)
  assert.equal(result.current.size, 0)
})

test('#4613: the verifier goes red when one archived byte changes', () => {
  const raw = readFileSync(join(root, ARCHIVE), 'utf8')
  assert.doesNotThrow(() => verifyArchive(raw))
  const marker = raw.indexOf('<!-- sha256: ')
  const payloadStart = raw.indexOf('```markdown\n', marker) + '```markdown\n'.length
  const mutated = `${raw.slice(0, payloadStart)}X${raw.slice(payloadStart + 1)}`
  assert.throws(() => verifyArchive(mutated), /archive hash does not match/)
})

test('#4613: the archive is status: archived with an explained empty covers', () => {
  const raw = readFileSync(join(root, ARCHIVE), 'utf8')
  assert.match(raw, /^---\nowner: "@d-hinders"\nstatus: archived\ncovers: \[\]  # historical verification records; no live code contract\nlast-verified: "\d{4}-\d{2}-\d{2}"\n---\n/)
})
