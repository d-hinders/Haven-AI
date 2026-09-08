// Shared corpus reader for the #2678 measurement scripts.
//
// Dependency-free and read-only. Every figure in epic #2678 is derived from
// this one definition of "the governed corpus", so the four scripts cannot
// disagree with each other about what they are measuring.
//
// THE DOC SURFACE, stated precisely — the epic's § *How to re-run this
// measurement* said only "docs/**/*.md + the four root gravity files", and that
// under-specifies it by one carve-out:
//
//   - every `docs/**/*.md`, EXCEPT CASP changelog shards
//     (`docs/regulatory/casp-changelog/*` other than its `README.md`), which
//     carry no front-matter by design (#1366);
//   - plus `CLAUDE.md`, `AGENTS.md`, `README.md`, `ABOUT_HAVEN.md`.
//
// This is `validate-frontmatter.mjs`'s own governed set, imported rather than
// restated. GOVERNED = `status` is neither `archived` nor `research`.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { REPO_ROOT, ROOT_DOCS, walk, parseFrontMatter } from '../validate-frontmatter.mjs'

export { REPO_ROOT }

/** Count whitespace-delimited words. */
export const words = (s) => (s.trim() === '' ? 0 : s.trim().split(/\s+/).length)

/**
 * Split a doc into front-matter and body. #2681 retired the live verification
 * chain; `chain` remains an empty compatibility metric until #2678's measured
 * report no longer needs to show its reduction to zero.
 */
export function split(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/)
  const front = m ? m[1] : ''
  const body = m ? raw.slice(m[0].length) : raw
  return { front, body, chain: '' }
}

/** Every governed doc: `{ file, raw, data, front, body, chain }`. */
export async function governed(root = REPO_ROOT) {
  const files = (await walk(join(root, 'docs')))
    .filter((p) => p.endsWith('.md'))
    .filter((p) => !(p.startsWith('docs/regulatory/casp-changelog/') && !p.endsWith('README.md')))
  for (const r of ROOT_DOCS) files.push(r)

  const out = []
  for (const rel of files.sort()) {
    const raw = await readFile(join(root, rel), 'utf8')
    const parsed = parseFrontMatter(raw)
    if (!parsed.ok) continue
    if (parsed.data.status === 'archived' || parsed.data.status === 'research') continue
    out.push({ file: rel, raw, data: parsed.data, ...split(raw) })
  }
  return out
}

/** Print a `| label | value |` row, right-aligned value. */
export function row(label, value) {
  console.log(`  ${String(label).padEnd(52)} ${String(value).padStart(9)}`)
}

export function heading(text) {
  console.log(`\n${text}\n${'─'.repeat(64)}`)
}
