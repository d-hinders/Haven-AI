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
// says `node scripts/docs/retire-verified-chains.mjs` is asserting that file exists at
// that path, and goes stale when it moves — the same #1199 shape as prose.
// (`ui-gate-wording.mjs` blanks fences because an illustrative "before" snippet
// is a citation of retired wording; a path is never a citation of itself.)
//
// ## Residue
//
// Shrink-only baseline: doc → the gap FILES. It was doc → COUNT first, in the
// house style of `ui-gate-wording-baseline.json`, and a review proved a count
// cannot do this job: a doc could close one gap and open a different one in the
// same edit, and the run stayed green — totals unchanged, no shrink hint, a
// brand-new false claim accepted in silence. The #1199 shape, walking through
// the check built for it. `covers-gaps.test.mjs` pins that swap case.
//
// ## What the RATCHET does not catch
//
// Separate from the extraction limits above, and listed because the section
// above covers only what the scan misses:
//
//   - **A path inside an illustrative fenced `covers:` example** is counted as
//     a claim — a false POSITIVE, and the one class the "does NOT catch" list
//     above lacked. `docs/contributing/docs-quality-system.md`'s own schema
//     block names `packages/backend/src/routes/payments.ts` as a placeholder,
//     and it is in the baseline. The "a path is never a citation of itself"
//     reasoning under the fence decision is false in exactly this case.
//   - **`status: archived` is an unguarded bypass.** Nothing constrains that
//     value outside `docs/archive/` (`docs/operations/session-rail-vendor-ops.md`
//     is a live precedent), so one word in a doc's front matter removes it and
//     every gap it carries. Not silent: `departed()` names any doc carrying
//     that status outside the archive folders — baselined or not — and such
//     docs are excluded from the shrink hint, so it is never reported as
//     progress. An earlier version of this bullet read the BASELINE alone,
//     which made the claim false for the 33 of 73 governed docs that have no
//     baseline entry: for those the flip printed nothing at all.
//   - **An over-broad `covers:` glob was the same bypass through a wider door,
//     and it is now REFUSED** (`tooBroadCovers()`), not merely disclosed.
//     `packages/**` + `scripts/**` + `.github/**` closes every gap a doc has
//     or will ever have, and because closing gaps looks like progress the run
//     reported "residue shrank" and invited an `--update` locking it in —
//     strictly worse than the archived flip, which at least gets a line.
//     Refusing was free: 0 of 73 governed docs declare one today, against 33
//     that use some `**` glob. `packages/backend/**` stays legal.
//   - **The governed set is THIS script's definition.** `validate-frontmatter.mjs`
//     governs 97 docs and applies no status filter; the archived/research
//     carve-out on `governedDocs()` below is ours, and is what makes it 73.
//
// Usage:
//   node scripts/docs/covers-gaps.mjs                      # check (docs:check)
//   node scripts/docs/covers-gaps.mjs --list               # every (doc, file) pair
//   node scripts/docs/covers-gaps.mjs --update             # tighten the baseline
//   node scripts/docs/covers-gaps.mjs --update --accept-new  # accept new gaps
//
// See docs/contributing/docs-quality-system.md.
import { readFile, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { REPO_ROOT, ROOT_DOCS, walk, parseFrontMatter, globToRegExp } from './validate-frontmatter.mjs'

// Overridable so the CLI's own guards can be tested against a throwaway file
// (#2690 review): the `--update` rise refusal and the legacy-format error live
// only in `main()`, and both survived mutation green because nothing invoked
// it. A guard with no test is the defect this repo cares most about, and these
// two were added BY a review that raised exactly that class.
export const BASELINE_PATH =
  process.env.HAVEN_COVERS_GAPS_BASELINE ??
  join(REPO_ROOT, 'scripts', 'docs', 'covers-gaps-baseline.json')

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
/**
 * The three directory prefixes this check scans, as ONE definition.
 *
 * Used by the path regex below and by `tooBroadCovers()`. They were written
 * out twice before and the second copy would have been the interesting one:
 * a prefix added to the scan but not to the breadth guard is a new bypass
 * that arrives silently. (#2625 spent a session on exactly that shape in the
 * test harness — one schema name computed in two places, and the guard went
 * quiet when they diverged.)
 */
export const SCAN_PREFIXES = ['packages/', 'scripts/', '.github/']

export const PATH_TOKEN_RE = new RegExp(
  `(?:${SCAN_PREFIXES.map((p) => p.slice(0, -1).replace('.', '\\.')).join('|')})/` +
    `[A-Za-z0-9._/-]*\\.(?:${CODE_EXTENSIONS.join('|')})\\b`,
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
 * scanned: `covers:` itself lives there, and front-matter metadata is not a
 * body-level claim about a source file.
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
  const dropped = []
  for (const rel of files.sort()) {
    const raw = await readFile(join(root, rel), 'utf8')
    const parsed = parseFrontMatter(raw)
    // Fail open on an unparseable doc: `validate-frontmatter.mjs` already fails
    // the build on it, and reporting a bogus gap set on top of that is noise.
    if (!parsed.ok) continue
    const { status } = parsed.data
    // Recorded, not merely skipped (#2690 review): a doc that leaves the
    // governed set has to be nameable even when it was never in the baseline,
    // and 33 of the 73 governed docs are not.
    if (status === 'archived' || status === 'research') {
      dropped.push(rel)
      continue
    }
    out.push({ file: rel, raw, data: parsed.data })
  }
  return { governed: out, dropped }
}

/**
 * `{ results, docCount, governed }` — gaps per doc, plus the FULL governed doc
 * list. `governed` is what lets the caller tell "this gap was fixed" from "this
 * doc left the governed set", which the count-only baseline could not.
 */
export async function scan(root = REPO_ROOT) {
  const tracked = trackedFiles(root)
  const { governed: docs, dropped } = await governedDocs(root)
  const results = []
  const tooBroad = []
  for (const doc of docs) {
    const broad = tooBroadCovers(doc.data.covers)
    if (broad.length > 0) tooBroad.push({ doc: doc.file, globs: broad })
    const gaps = uncovered(doc.raw, tracked, doc.data.covers)
    if (gaps.length > 0) results.push({ doc: doc.file, gaps, covers: doc.data.covers ?? [] })
  }
  return {
    results,
    docCount: docs.length,
    governed: docs.map((d) => d.file),
    dropped,
    tooBroad,
  }
}

/**
 * `{ doc: [file, ...] }` from a scan — the baseline's shape.
 *
 * The gap FILES, sorted. Line numbers are deliberately not stored: moving a
 * sentence is not a new claim, and a line-keyed baseline would redden on every
 * unrelated edit above it.
 *
 * In practice this is a SET, not a multiset: `namedFiles()` reports each file
 * once, at its first mention, so a doc naming one file on three lines yields
 * one entry. An earlier version of this comment claimed duplicates were kept
 * because "each mention is its own claim" — that was a new false claim
 * introduced while correcting another one, and the pipeline above discards
 * exactly what it described. `surplus()` is still written multiset-safe, but
 * as defensiveness against a future `namedFiles()` that reports every mention,
 * not as a property this code has today.
 *
 * This was `{ doc: count }` until the review of #2690, and a count is not
 * enough. Gap identity was nowhere in the baseline, so a doc could CLOSE one
 * gap and OPEN a different one in the same edit and stay green — totals
 * unchanged, no shrink hint, a brand-new false claim about a file the doc had
 * never mentioned, accepted silently. That is the #1199 shape this check exists
 * to catch, walking straight through it. Reproduced on
 * `docs/architecture/03-payment-sequence.md` before the fix.
 */
export function gapsByDoc(results) {
  return Object.fromEntries(
    results
      .map((r) => [r.doc, r.gaps.map((g) => g.file).sort()])
      .sort(([a], [b]) => a.localeCompare(b)),
  )
}

/**
 * `covers:` globs so broad they cover every path this check can extract.
 *
 * The second bypass, and strictly worse than `status: archived` (#2690
 * review). Nothing constrains glob BREADTH, so adding `packages/**`,
 * `scripts/**` and `.github/**` to a doc's `covers:` closes every gap it has
 * or will ever have — and because closing gaps is what a shrink looks like,
 * the run reported `exit 0`, "Residue shrank", and invited an `--update` that
 * would lock the loss in. Reproduced with two brand-new false claims added in
 * the same edit: both admitted, announced as a win.
 *
 * Refused rather than merely disclosed, because it is free: no governed doc
 * declares one today (0 of 73, against 33 that use some `**` glob, so the
 * measurement is not a broken instrument). `covers: packages/backend/**` stays
 * perfectly legal — this catches only the bare scan prefixes, which are not a
 * description of what a doc covers but an opt-out written as one.
 */
export function tooBroadCovers(covers) {
  const bare = new Set(['**', '**/*', ...SCAN_PREFIXES.map((p) => `${p}**`)])
  return (covers ?? []).map((c) => c.trim()).filter((c) => bare.has(c))
}

/**
 * Multiset difference `a - b`.
 *
 * Multiset rather than set only so that a duplicate could never slip through
 * if `namedFiles()` ever stopped deduping; today it dedupes, so no real input
 * distinguishes the two. Do not read this as evidence that duplicates occur.
 */
function surplus(a, b) {
  const remaining = [...(b ?? [])]
  const extra = []
  for (const file of a ?? []) {
    const i = remaining.indexOf(file)
    if (i === -1) extra.push(file)
    else remaining.splice(i, 1)
  }
  return { extra, absent: remaining }
}

/** Docs naming an uncovered file the baseline does not already allow. */
export function newGaps(current, baseline) {
  const failures = []
  for (const [doc, files] of Object.entries(current)) {
    const { extra } = surplus(files, baseline?.[doc])
    if (extra.length > 0) {
      failures.push({ doc, files: extra, count: files.length, allowed: (baseline?.[doc] ?? []).length })
    }
  }
  return failures.sort((a, b) => a.doc.localeCompare(b.doc))
}

/**
 * True when a baselined gap is gone from a doc that is STILL governed — the
 * ratchet can be tightened.
 *
 * The governed-doc guard is the point (found by the review of #2690): flipping
 * a doc's front-matter to `status: archived` drops it from the governed set,
 * and every gap it carried disappears. That is a scope reduction, not progress,
 * and the old version reported it as a shrink and recommended an `--update`
 * that would have discarded those gaps permanently. A doc that left the
 * governed set is reported by `departed()` instead, which says what actually
 * happened.
 */
export function hasShrunk(current, baseline, governed) {
  const stillGoverned = governed ? new Set(governed) : null
  for (const [doc, files] of Object.entries(baseline ?? {})) {
    if (stillGoverned && !stillGoverned.has(doc)) continue
    if (surplus(files, current?.[doc]).extra.length > 0) return true
  }
  return false
}

/**
 * Docs that are no longer in the governed set — renamed, deleted, or flipped
 * to `status: archived`/`research`.
 *
 * Reported rather than silently forgiven: their gaps did not get fixed, they
 * stopped being looked at. Also clears the stale-entry nag, where a baseline
 * key for a deleted doc made the shrink hint print forever with nothing to
 * tighten.
 *
 * Takes `dropped` — the docs `governedDocs()` filtered out — as well as the
 * baseline's keys, because the first version read the baseline ALONE and 33 of
 * the 73 governed docs are not in it. For those, flipping `status: archived`
 * printed nothing at all, so the disclosure saying the bypass "is not silent"
 * was false for the larger half of the corpus (#2690 review). A doc that
 * leaves is now named whether or not it ever had a baselined gap.
 *
 * `dropped` is narrowed to docs OUTSIDE `docs/archive/` and `docs/research/`.
 * A doc living in those folders is archived by definition and always will be —
 * naming all 24 of them on every clean run is noise, and a line printed
 * unconditionally is a line nobody reads. What is left is exactly the anomaly:
 * a doc carrying `status: archived` while sitting somewhere else, which is the
 * bypass shape (`docs/operations/session-rail-vendor-ops.md` is the one
 * standing instance). Baselined docs are still reported wherever they live,
 * since a baselined doc leaving is a change by construction.
 */
export function departed(baseline, governed, dropped) {
  const stillGoverned = new Set(governed ?? [])
  const unexpected = (dropped ?? []).filter(
    (doc) => !doc.startsWith('docs/archive/') && !doc.startsWith('docs/research/'),
  )
  return [...new Set([...Object.keys(baseline ?? {}), ...unexpected])]
    .filter((doc) => !stillGoverned.has(doc))
    .sort()
}

async function readBaseline() {
  let parsed
  try {
    parsed = JSON.parse(await readFile(BASELINE_PATH, 'utf8'))
  } catch (err) {
    if (err.code === 'ENOENT') return {}
    throw err
  }
  // The baseline was `{ doc: count }` before the review of #2690 and is now
  // `{ doc: [file, ...] }`. Say so in one sentence rather than letting a number
  // reach the multiset code and surface as `(b ?? []) is not iterable`, which
  // names nothing a reader can act on.
  const numeric = Object.entries(parsed).filter(([, v]) => !Array.isArray(v))
  if (numeric.length > 0) {
    throw new Error(
      `covers-gaps: ${BASELINE_PATH} is in the old count-only format ` +
        `(e.g. "${numeric[0][0]}": ${JSON.stringify(numeric[0][1])}). The baseline now stores ` +
        'the gap FILES, because a count cannot tell a closed gap from a swapped one. ' +
        'Regenerate it with `node scripts/docs/covers-gaps.mjs --update --accept-new` ' +
        'and review the diff.',
    )
  }
  return parsed
}

async function main() {
  const update = process.argv.includes('--update')
  const list = process.argv.includes('--list')
  const { results, docCount, governed, dropped, tooBroad } = await scan()
  const current = gapsByDoc(results)
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

  // `--accept-new` is the deliberate override, and it is also the ONE path that
  // must work when the existing baseline cannot be read at all — a format
  // migration, or a hand-corrupted file. Reading it would only be to check for
  // rises we are being told to accept.
  const acceptNew = process.argv.includes('--accept-new')
  const baseline = update && acceptNew ? {} : await readBaseline()

  if (update) {
    // `--update` used to write unconditionally while printing "ratcheted",
    // so it happily recorded a LOOSENING under the word for a tightening
    // (found by the review of #2690). A rise is now refused: closing a gap is
    // routine, accepting a new one is a decision, and the two must not share
    // a command that reports them identically.
    const rises = newGaps(current, baseline)
    if (rises.length > 0 && !acceptNew) {
      console.error(
        '✗ `--update` would ACCEPT new gaps, not tighten the ratchet:\n',
      )
      for (const r of rises) {
        console.error(`  ${r.doc} — ${r.files.length} new:`)
        for (const f of r.files) console.error(`    ${f}`)
      }
      console.error(
        '\nThe baseline is shrink-only. Close these gaps (declare the path, or ' +
          'delete the claim), or re-run with `--accept-new` if accepting them is ' +
          'the reviewed, intentional decision.\n',
      )
      process.exit(1)
    }
    await writeFile(BASELINE_PATH, `${JSON.stringify(current, null, 2)}\n`)
    console.log(
      `covers-gaps: baseline written — ${total} gap(s) across ${results.length} of ` +
        `${docCount} governed docs recorded.`,
    )
    return
  }

  if (tooBroad.length > 0) {
    console.error('\u2717 A governed doc declares a `covers:` glob broad enough to cover everything:\n')
    for (const t of tooBroad) console.error(`  ${t.doc} — ${t.globs.join(', ')}`)
    console.error(
      '\nThat is not a description of what the doc covers, it is an opt-out written as one:' +
        ' it closes every gap the doc has or will ever have, and this check would report it as' +
        ' RESIDUE SHRANK and invite an `--update` locking the loss in. Name the directories the' +
        ' doc actually describes (`packages/backend/**` is fine), or delete the claims instead.\n',
    )
    process.exit(1)
  }

  const failures = newGaps(current, baseline)

  if (failures.length > 0) {
    console.error('✗ A governed doc names a tracked file its `covers:` cannot reach:\n')
    for (const f of failures) {
      const hit = results.find((r) => r.doc === f.doc)
      console.error(
        `  ${f.doc} — ${f.count} uncovered file(s), baseline allows ${f.allowed}` +
          `, ${f.files.length} not baselined`,
      )
      for (const g of hit.gaps) {
        console.error(`    ${f.files.includes(g.file) ? 'NEW ' : '    '}${f.doc}:${g.line}: ${g.file}`)
      }
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

  const gone = departed(baseline, governed, dropped)
  console.log(
    `✓ No new \`covers:\` gaps across ${docCount} governed doc(s) ` +
      `(${total} baselined pair(s) across ${results.length} doc(s) remain).` +
      (hasShrunk(current, baseline, governed)
        ? ' Residue shrank — run `node scripts/docs/covers-gaps.mjs --update` to tighten the ratchet.'
        : ''),
  )
  if (gone.length > 0) {
    // Not a failure — a doc may be legitimately renamed or archived — but never
    // silent, and never counted as a shrink. Their gaps were not fixed; they
    // stopped being looked at.
    console.log(
      `\n  ${gone.length} doc(s) are outside the governed set (renamed, deleted, or ` +
        'carrying `status: archived`/`research` outside the archive folders). ' +
        'Their claims are no longer checked:',
    )
    for (const doc of gone) console.log(`    ${doc}`)
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    // Fail closed: a broken gate that passes is the defect one layer up.
    console.error('covers-gaps error:', err)
    process.exit(1)
  })
}
