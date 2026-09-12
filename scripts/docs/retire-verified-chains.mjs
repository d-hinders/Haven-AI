#!/usr/bin/env node
// Retire the #2637 `verified:` convention without losing its forensic record.
//
// `--write` is deliberately the only writer: it reads every raw block before
// stripping it, writes one deterministic archive, then compares the exact UTF-8
// bytes it read with the bytes embedded in that archive. The normal mode is the
// CI check: no live doc may reintroduce a block and the checked-in archive must
// have one distinct, hash-pinned block for every source path.

import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { REPO_ROOT, ROOT_DOCS, walk } from './validate-frontmatter.mjs'

export const ARCHIVE = 'docs/archive/last-verified-chains-2026-09.md'

const digest = (text) => createHash('sha256').update(text).digest('hex')

export function extractVerifiedBlock(raw) {
  const header = /^---\n([\s\S]*?)\n---/.exec(raw)
  if (!header) return null
  const front = header[1]
  const start = front.search(/^verified:\n/m)
  if (start === -1) return null
  const after = front.slice(start)
  const boundary = after.search(/\n(?=[A-Za-z0-9_-]+:)/)
  const end = boundary === -1 ? front.length : start + boundary
  const block = front.slice(start, end)
  // YAML list items may wrap across indented continuation lines. The archive
  // must preserve those raw bytes, not interpret their scalar shape.
  if (!/^verified:\n\s+-\s+/.test(block)) {
    throw new Error(`malformed verified block: ${JSON.stringify(block.slice(0, 120))}`)
  }
  return { start: header.index + 4 + start, end: header.index + 4 + end, block }
}

export function stripVerifiedBlock(raw) {
  const found = extractVerifiedBlock(raw)
  if (!found) return { text: raw, block: null }
  // The block begins after the preceding scalar's newline and is followed by
  // the front-matter closing fence's newline. Consume that latter separator so
  // the header is exactly the old header minus the block, not a new blank line.
  const suffix = raw[found.end] === '\n' ? found.end + 1 : found.end
  return { text: raw.slice(0, found.start) + raw.slice(suffix), block: found.block }
}

export function renderArchive(entries) {
  const sections = entries
    .slice()
    .sort((a, b) => a.path.localeCompare(b.path))
    .map(({ path, block }) => `## \`${path}\`\n\n<!-- sha256: ${digest(block)} -->\n\`\`\`yaml\n${block}\n\`\`\``)
  return `---\nowner: "@d-hinders"\nstatus: archived\ncovers: []  # historical verification records; no live code contract\nlast-verified: "2026-09-08"\n---\n\n# Archived last-verified chains\n\n#2681 retired the live \`verified:\` convention. This single file preserves every\nraw block exactly as the retirement script read it; use \`git log -p -- <doc>\` for\nthe surrounding historical diff. The script verifies both the SHA-256 marker and\nthe byte-for-byte archive payload before it strips a live block.\n\n${sections.join('\n\n')}\n`
}

export function parseArchive(raw) {
  const entries = []
  const re = /^## `([^`]+)`\n\n<!-- sha256: ([0-9a-f]{64}) -->\n```yaml\n([\s\S]*?)\n```$/gm
  for (const match of raw.matchAll(re)) entries.push({ path: match[1], hash: match[2], block: match[3] })
  return entries
}

async function sourcePaths() {
  const paths = (await walk(join(REPO_ROOT, 'docs')))
    .filter((path) => path.endsWith('.md'))
    .filter((path) => path !== ARCHIVE)
  paths.push(...ROOT_DOCS)
  return paths.sort()
}

async function readEntries() {
  const entries = []
  for (const path of await sourcePaths()) {
    const raw = await readFile(join(REPO_ROOT, path), 'utf8')
    const found = extractVerifiedBlock(raw)
    if (found) entries.push({ path, block: found.block, raw })
  }
  return entries
}

async function verify() {
  const archiveRaw = await readFile(join(REPO_ROOT, ARCHIVE), 'utf8')
  const archived = parseArchive(archiveRaw)
  const seen = new Set()
  for (const entry of archived) {
    if (seen.has(entry.path)) throw new Error(`archive duplicates ${entry.path}`)
    seen.add(entry.path)
    if (digest(entry.block) !== entry.hash) throw new Error(`archive hash does not match ${entry.path}`)
  }
  const live = await readEntries()
  if (live.length) throw new Error(`live verified block(s) remain: ${live.map((entry) => entry.path).join(', ')}`)
  if (archived.length === 0) throw new Error('archive has no verified blocks')
  console.log(`✓ ${ARCHIVE}: ${archived.length} archived blocks, all hashes valid; no live verified blocks remain.`)
}

async function write() {
  const entries = await readEntries()
  if (!entries.length) throw new Error('no live verified blocks found; refusing to overwrite the archive')
  const archive = renderArchive(entries)
  const parsed = parseArchive(archive)
  if (parsed.length !== entries.length) throw new Error(`archive rendered ${parsed.length} blocks for ${entries.length} sources`)
  for (const entry of entries) {
    const archived = parsed.find((candidate) => candidate.path === entry.path)
    if (!archived || !Buffer.from(archived.block).equals(Buffer.from(entry.block))) {
      throw new Error(`archive byte-equality failed for ${entry.path}`)
    }
  }
  for (const entry of entries) {
    const { text } = stripVerifiedBlock(entry.raw)
    await writeFile(join(REPO_ROOT, entry.path), text)
  }
  await writeFile(join(REPO_ROOT, ARCHIVE), archive)
  console.log(`✓ archived and stripped ${entries.length} verified blocks; byte equality asserted before write.`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.includes('--write')) await write()
    else await verify()
  } catch (error) {
    console.error(`✗ ${error.message}`)
    process.exitCode = 1
  }
}
