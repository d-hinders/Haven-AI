#!/usr/bin/env node
// `covers:` gap check (#2679, slice 1 of epic #2678).
//
// ## The defect this exists for
//
// The `covers:` mapping is **declared, not derived**. A doc can assert
// something about a file it never lists in its front-matter — and then nothing
// implicates it when that file changes. The coupling gate reads `covers:`, so
// its silence on such a file is not evidence of anything; it is the absence of
// a mapping.
//
// That is exactly how `CLAUDE.md`'s `remove_passkey` sentence stayed false for
// 24 days (#1199): `rails/hybrid-signer-actions.ts` was named in the body and
// absent from `covers:`, so every gate stayed green while the claim rotted.
//
// This check finds that shape: for each governed doc, the real tracked files
// its **body** names that its own `covers:` globs cannot reach.
//
// ## The two legitimate remedies, and why the message names both
//
// Epic #2678 is **net-reducing**: it exists to shrink the claim surface, not to
// grow the enforcement surface. A check that only ever pushed authors to append
// paths to `covers:` would work directly against that. So a gap has two equally
// valid answers and the failure message says so:
//
//   1. **Declare the path** — the doc genuinely describes that file, so put it
//      in `covers:` and let the coupling gate implicate it.
//   2. **Delete the claim** — the doc should not be asserting anything about
//      that file. Removing the sentence closes the gap and shrinks the corpus,
//      which is the outcome the epic prefers.
//
// ## What this does NOT catch
//
// Stated rather than discovered, because a baseline number implies a
// completeness the extraction does not have (the #2657 / #2671 lesson: a guard
// wrong in both directions shipped green). `covers-gaps.test.mjs` pins each of
// these as an explicit expectation, so none of them is an accident:
//
//   - **A path split across a hard wrap.** This repo's Markdown is
//     hard-wrapped; a path broken over a newline (`packages/backend/src/` then
//     `routes/x402.ts`) is two tokens, neither of which resolves. Unlike
//     `ui-gate-wording.mjs`, flattening whitespace is NOT the fix here — it
//     would weld `see packages/foo.ts and` into false paths. Missed, by design.
//   - **A path split by inline markup** — `packages/backend/**src**/x402.ts`.
//     Same reason.
//   - **A path outside the three prefixes.** Only `packages/`, `scripts/` and
//     `.github/` are scanned (the issue's definition). Root files
//     (`package.json`, `turbo.json`), `docs/**`, `.claude/**` and `.agents/**`
//     are invisible to this check even when named and even when tracked.
//   - **A path with no code extension**, or one outside `CODE_EXTENSIONS` —
//     `Dockerfile`, `packages/backend/src/rails/` (a directory), a `.md` or
//     `.png` file.
//   - **A path relative to somewhere other than the repo root** — `./src/x.ts`
//     inside a package README. A `./`- or `../`-prefixed path that still
//     contains one of the three prefixes IS caught, because matching is
//     substring-anchored on the prefix rather than on the start of the token.
//   - **A file that no longer exists.** The `git ls-files` intersection is what
//     keeps prose like "a `packages/foo/bar.ts` style path" from counting, and
//     the cost is that a doc naming a *deleted* file is silent here. That is
//     the other half of #1199 and is out of this slice's scope.
//
// Fenced code blocks ARE scanned, deliberately. A runbook whose command block
// says `node scripts/docs/chain-integrity.mjs` is asserting that file exists at
// that path, and goes stale when it moves — the same #1199 shape as prose.
// (`ui-gate-wording.mjs` blanks fences because an illustrative "before" snippet
// is a citation of retired wording; a path is never a citation of itself.)
//
// ## Residue
//
// Shrink-only baseline in the house style of `ui-gate-wording-baseline.json`:
// doc → gap count. Counts may fall, never rise. `--update` rewrites it, and is
// for a reviewed, intentional change only.
//
// Usage:
//   node scripts/docs/covers-gaps.mjs            # check (runs in docs:check)
//   node scripts/docs/covers-gaps.mjs --list     # print every (doc, file) pair
//   node scripts/docs/covers-gaps.mjs --update   # rewrite the baseline
//
// See docs/contributing/docs-quality-system.md.
import { readFile, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { REPO_ROOT, ROOT_DOCS, walk, parseFrontMatter, globToRegExp } from './validate-frontmatter.mjs'

export const BASELINE_PATH = join(REPO_ROOT, 'scripts', 'docs', 'covers-gaps-baseline.json')

/** Extensions that make a path-like token a *code* path worth coupling to. */
export const CODE_EXTENSIONS = [
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs',
  'json', 'yml', 'yaml', 'sql', 'sh', 'css', 'toml',
]

/**
 * Path-like tokens: one of the three source prefixes, then path characters,
 * then a code extension.
 *
 * Deliberately NOT anchored at a token boundary on the left, so a link target
 * (`](../../scripts/docs/new-doc.mjs)`) or a `./`-prefixed path yields the
 * repo-relative path from the prefix onward. It IS anchored on the right by
 * `\b` after the extension, so `x402.tsx` is not read as `x402.ts`.
 */
export const PATH_TOKEN_RE = new RegExp(
  `(?:packages|scripts|\\.github)/[A-Za-z0-9._/-]*\\.(?:${CODE_EXTENSIONS.join('|')})\\b`,
  'g',
)

/** Every tracked file, as a Set for O(1) "is this real?" tests. */
export function trackedFiles(root = REPO_ROOT) {
  const out = execFileSync('git', ['-C', root, 'ls-files', '-z'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  return new Set(out.split('\0').filter(Boolean))
}

/**
 * Blank the leading front-matter block, preserving byte offsets so line numbers
 * computed on the result still address the real file. Front-matter must not be
 * scanned: `covers:` itself lives there, and a `last-verified` chain quotes
 * paths from past PRs by design.
 */
export function blankFrontMatter(raw) {
  const m = raw.match(/^---\r?\n[\s\S]*?\r?\n---(\r?\n|$)/)
  if (!m) return raw
  return m[0].replace(/[^\n]/g, ' ') + raw.slice(m[0].length)
}

/** 1-based line number of `index` within `text`. */
export function lineOf(text, index) {
  let line = 1
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === '\n') line++
  return line
}

/**
 * The real tracked files a doc body names, with the line of the FIRST mention.
 * `{ file, line }[]`, one entry per distinct file.
 */
export function namedFiles(raw, tracked) {
  const body = blankFrontMatter(raw)
  const seen = new Map()
  for (const m of body.matchAll(PATH_TOKEN_RE)) {
    if (!tracked.has(m[0])) continue
    if (!seen.has(m[0])) seen.set(m[0], lineOf(body, m.index))
  }
  return [...seen].map(([file, line]) => ({ file, line }))
}

/**
 * Files named in the body that the doc's own `covers:` globs cannot reach.
 *
 * Glob-aware via `globToRegExp` — the same expansion the coupling gate uses, so
 * "uncovered here" means exactly "the coupling gate will not implicate this doc
 * when that file changes". A subtraction that compared `covers:` entries as
 * plain strings would count `packages/backend/src/modules/x402/handler.ts` as
 * uncovered under `packages/backend/src/modules/x402/**`, inflating the gap set
 * with pairs that are in fact enforced.
 */
export function uncovered(raw, tracked, covers) {
  const res = (covers ?? []).map(globToRegExp)
  return namedFiles(raw, tracked).filter(({ file }) => !res.some((re) => re.test(file)))
}

/** The governed doc surface: `docs/**` + the root gravity files, minus CASP shards. */
export async function governedDocs(root = REPO_ROOT) {
  const files = (await walk(join(root, 'docs')))
    .filter((p) => p.endsWith('.md'))
    // CASP changelog shards are fragments of their parent contract doc and
    // carry no front-matter — the same carve-out `validate-frontmatter.mjs`
    // applies when it defines the governed surface (#1366).
    .filter((p) => !(p.startsWith('docs/regulatory/casp-changelog/') && !p.endsWith('README.md')))
  for (const r of ROOT_DOCS) files.push(r)

  const out = []
  for (const rel of files.sort()) {
    const raw = await readFile(join(root, rel), 'utf8')
    const parsed = parseFrontMatter(raw)
    // Fail open on an unparseable doc: `validate-frontmatter.mjs` already fails
    // the build on it, and reporting a bogus gap set on top of that is noise.
    if (!parsed.ok) continue
    const { status } = parsed.data
    if (status === 'archived' || status === 'research') continue
    out.push({ file: rel, raw, data: parsed.data })
  }
  return out
}

/** `{ file, gaps: [{ file, line }], covers }[]` for every governed doc with a gap. */
export async function scan(root = REPO_ROOT) {
  const tracked = trackedFiles(root)
  const docs = await governedDocs(root)
  const results = []
  for (const doc of docs) {
    const gaps = uncovered(doc.raw, tracked, doc.data.covers)
    if (gaps.length > 0) results.push({ doc: doc.file, gaps, covers: doc.data.covers ?? [] })
  }
  return { results, docCount: docs.length }
}

/** `{ doc: count }` from a scan. */
export function countByDoc(results) {
  return Object.fromEntries(
    results
      .map((r) => [r.doc, r.gaps.length])
      .sort(([a], [b]) => a.localeCompare(b)),
  )
}

/** Docs whose gap count exceeds what the baseline allows. */
export function newGaps(counts, baseline) {
  const failures = []
  for (const [doc, count] of Object.entries(counts)) {
    const allowed = baseline?.[doc] ?? 0
    if (count > allowed) failures.push({ doc, count, allowed })
  }
  return failures.sort((a, b) => a.doc.localeCompare(b.doc))
}

/** True when any baselined count has fallen — the ratchet can be tightened. */
export function hasShrunk(counts, baseline) {
  for (const [doc, allowed] of Object.entries(baseline ?? {})) {
    if ((counts?.[doc] ?? 0) < allowed) return true
  }
  return false
}

async function readBaseline() {
  try {
    return JSON.parse(await readFile(BASELINE_PATH, 'utf8'))
  } catch (err) {
    if (err.code === 'ENOENT') return {}
    throw err
  }
}

async function main() {
  const update = process.argv.includes('--update')
  const list = process.argv.includes('--list')
  const { results, docCount } = await scan()
  const counts = countByDoc(results)
  const total = results.reduce((n, r) => n + r.gaps.length, 0)

  if (list) {
    for (const r of results) {
      for (const g of r.gaps) console.log(`${r.doc}:${g.line}\t${g.file}`)
    }
    console.log(
      `\n${total} (doc, uncovered file) pair(s) across ${results.length} of ${docCount} governed docs.`,
    )
    return
  }

  if (update) {
    await writeFile(BASELINE_PATH, `${JSON.stringify(counts, null, 2)}\n`)
    console.log(
      `covers-gaps: baseline written — ${total} gap(s) across ${results.length} of ` +
        `${docCount} governed docs ratcheted.`,
    )
    return
  }

  const baseline = await readBaseline()
  const failures = newGaps(counts, baseline)

  if (failures.length > 0) {
    console.error('✗ A governed doc names a tracked file its `covers:` cannot reach:\n')
    for (const f of failures) {
      const hit = results.find((r) => r.doc === f.doc)
      console.error(`  ${f.doc} — ${f.count} uncovered file(s), baseline allows ${f.allowed}`)
      for (const g of hit.gaps) console.error(`    ${f.doc}:${g.line}: ${g.file}`)
      console.error('')
    }
    console.error(
      'The doc asserts something about that file and nothing implicates the doc when the ' +
        'file changes — the #1199 shape, which kept a false `remove_passkey` sentence in ' +
        '`CLAUDE.md` green for 24 days.\n' +
        '\n' +
        'TWO remedies, and the second is the one epic #2678 prefers:\n' +
        '  1. DECLARE the path — add it to the doc\'s `covers:` front-matter, so the\n' +
        '     coupling gate implicates the doc the next time that file changes.\n' +
        '  2. DELETE the claim — remove the sentence, because the doc should not be\n' +
        '     asserting anything about that file. #2678 is net-reducing: shrinking the\n' +
        '     claim surface is a better outcome than growing the `covers:` list, and a\n' +
        '     check that only ever grew `covers:` would work against the epic.\n' +
        '\n' +
        '`node scripts/docs/covers-gaps.mjs --update` is for a reviewed, intentional ' +
        'change only; the baseline is shrink-only and never a way to accept a new gap.\n',
    )
    process.exit(1)
  }

  console.log(
    `✓ No new \`covers:\` gaps across ${docCount} governed doc(s) ` +
      `(${total} baselined pair(s) across ${results.length} doc(s) remain).` +
      (hasShrunk(counts, baseline)
        ? ' Residue shrank — run `node scripts/docs/covers-gaps.mjs --update` to tighten the ratchet.'
        : ''),
  )
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    // Fail closed: a broken gate that passes is the defect one layer up.
    console.error('covers-gaps error:', err)
    process.exit(1)
  })
}
