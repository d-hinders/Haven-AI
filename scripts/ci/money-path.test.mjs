// Drift guard for the money-path file list (#1030).
//
// The list existed in three places that DISAGREED. `.github/labeler.yml` — the
// thing that actually applies the `money-path` label, and therefore the thing
// that decides whether money.md and its characterization-test bar get loaded —
// was missing the entire delegation rail, the rail seam, and the SDK signer.
// Nobody noticed, because nothing compared them.
//
// A wrong money-path list is worse than none: it reads as coverage. So the
// copies are now checked against each other, and editing one without the
// others fails CI.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadMoneyPathGlobs, loadMoneyPathControlGlobs, matchesGlob } from './qa-freshness.mjs'
import { parseFrontMatter, globToRegExp } from '../docs/validate-frontmatter.mjs'
import {
  allGlobs,
  perimeterMatchers,
  plantedCopy,
  proseCeiling,
  scoreCount,
} from './money-path-restatement-scan.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8')

/** Every file git tracks. The index, not the worktree — CI checkouts are shallow. */
const trackedFiles = () =>
  execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)

/**
 * Pull the money-path globs out of labeler.yml without a YAML dependency.
 * The block is a fixed shape (`money-path:` → `changed-files:` →
 * `any-glob-to-any-file:` → a `- path` list), so a targeted reader is more
 * honest here than pretending to parse YAML generally: if the shape changes,
 * this returns nothing and the assertion below fails loudly.
 */
function labelerMoneyPathGlobs() {
  const lines = read('.github/labeler.yml').split('\n')
  const start = lines.findIndex((l) => /^["']?money-path["']?:/.test(l))
  assert.notEqual(start, -1, 'labeler.yml has no `money-path:` key')
  const globs = []
  let inList = false
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break // next top-level key
    if (/any-glob-to-any-file:/.test(line)) { inList = true; continue }
    if (!inList) continue
    const m = line.match(/^\s*-\s*(?:["']?)([^"'\s]+)(?:["']?)\s*$/)
    if (m) globs.push(m[1])
    else if (line.trim() && !line.trim().startsWith('#')) break
  }
  return globs
}

/**
 * The Merge Gate's annotated file list, WITHOUT the prose that frames it.
 *
 * Scoped deliberately. The surrounding prose legitimately names source files
 * while talking *about* the mechanism (`scripts/ci/money-path.test.mjs`,
 * `index.ts`), and a token scan over the whole section would read those as
 * perimeter claims and fail on a sentence. The bullet list between the
 * "Classify" line and the "The label matters" line is the list itself.
 */
function mergeGateFileList(skill) {
  const gate = skill.slice(skill.indexOf('## Merge Gate'), skill.indexOf('Route the merge:'))
  assert.ok(gate.length > 200, 'could not locate the Merge Gate section in SKILL.md')
  const start = gate.indexOf('Classify a change as money-path')
  const end = gate.indexOf('The label matters because')
  assert.ok(start !== -1 && end > start, 'could not locate the Merge Gate file list boundaries')
  return gate.slice(start, end)
}

/** Backticked, path-shaped tokens (anything containing a `/`). */
function listedTokens(list) {
  return [...list.matchAll(/`([^`]+)`/g)]
    .map((m) => m[1])
    .filter((t) => t.includes('/'))
}

/**
 * Placeholder for `**` while `*` is being translated, so the two-star form is
 * not eaten by the one-star rule. It must be a character no glob contains.
 *
 * Written as an escape ON PURPOSE (#1897). It was a literal NUL byte in the
 * source until now, which worked at runtime and broke everything that reads the
 * file as text: git marked this file binary and showed `Bin 10325 -> 16418
 * bytes` instead of a diff — so the drift guard for the money path was the one
 * file in the repository nobody could review in a pull request — and plain
 * `grep` skipped it silently rather than reporting no match. Same byte at
 * runtime, same behaviour; only the encoding of the source changed.
 */
const NUL = '\u0000'

/**
 * Does a backend-relative prose token name this repo-root-relative glob?
 * Suffix match, with `*` treated as a single path segment's wildcard so
 * `rails/delegation-*.ts` covers `packages/backend/src/rails/delegation-*.ts`.
 */
function tokenNamesGlob(token, glob) {
  const needle = token.replace(/\/$/, '')
  const stripped = glob.replace(/\/\*\*$/, '')
  // Anchor every match at a path boundary. A bare `endsWith` would let a token
  // satisfy any glob merely ENDING in those characters, so two canonical globs
  // sharing a trailing segment in different directories could both be marked
  // "named" when the prose names one. No such collision exists today; this
  // keeps it from becoming exploitable later.
  const boundedEnd = (haystack) => haystack === needle || haystack.endsWith(`/${needle}`)
  if (boundedEnd(stripped) || boundedEnd(glob)) return true

  // Wildcards on the TOKEN side: prose says `rails/delegation-*.ts`, the
  // canonical glob is the same pattern under packages/backend/src/.
  if (needle.includes('*')) {
    const pattern = needle.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')
    if (new RegExp(`(?:^|/)${pattern}$`).test(stripped)) return true
  }

  // Wildcards on the GLOB side: prose may name a concrete file that only a
  // pattern covers — `infra/relayer-balance-monitor.ts` is matched solely by
  // `infra/relayer*.ts`. Without this the forward assertion rejects a file
  // that IS on the perimeter, which is a false alarm in the direction that
  // teaches people to edit the guard rather than the list.
  if (glob.includes('*')) {
    const rx = new RegExp(
      `^${glob
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*/g, NUL)
        .replace(/\*/g, '[^/]*')
        .replace(new RegExp(NUL, 'g'), '.*')}$`,
    )
    return rx.test(needle) || rx.test(`packages/backend/src/${needle}`)
  }
  return false
}

describe('money-path list stays in one piece', () => {
  test('labeler.yml matches the UNION of globs + controlGlobs', () => {
    // labeler.yml labels BOTH lists: runtime money-path code, and the
    // safeguard's own control surface. The freshness gate uses `globs` only.
    const canonical = [...loadMoneyPathGlobs(), ...loadMoneyPathControlGlobs()]
    const labeler = labelerMoneyPathGlobs()
    assert.ok(labeler.length > 0, 'read no globs out of labeler.yml — the block shape changed')
    assert.deepEqual(
      [...labeler].sort(),
      [...canonical].sort(),
      'labeler.yml and money-path-globs.json disagree. The JSON is the source of truth: ' +
        'update labeler.yml to match. A glob missing from labeler.yml means PRs touching ' +
        'that file never get the money-path label, so they never load money.md.',
    )
  })

  test('every money-path file named in the SKILL.md Merge Gate is in the canonical list', () => {
    // Direction 1: someone documents a new money-path file in the prose
    // everyone reads, and the machinery never learns about it.
    //
    // The Merge Gate prose describes CLASSIFICATION (which diffs are
    // money-path), and classification is the UNION — controlGlobs are
    // labelled money-path too, they just skip the QA-freshness re-run. A
    // file named in the prose is "known to the machinery" if either list
    // has it (#1045 moved release-bump/publish.yml to controlGlobs, which
    // is where this distinction first bit).
    const globs = [...loadMoneyPathGlobs(), ...loadMoneyPathControlGlobs()]
    const tokens = listedTokens(mergeGateFileList(read('.agents/skills/ship-next/SKILL.md')))

    assert.ok(tokens.length >= 10, `expected the Merge Gate to name many files, saw ${tokens.length}`)

    const missing = tokens.filter((token) => !globs.some((g) => tokenNamesGlob(token, g)))

    assert.deepEqual(
      missing,
      [],
      'SKILL.md names money-path files absent from .github/money-path-globs.json. ' +
        'Add them to the JSON and to labeler.yml — prose that the machinery does not ' +
        'know about is the exact drift #1030 closed.',
    )
  })

  test('every canonical glob is named in the SKILL.md Merge Gate', () => {
    // Direction 2, and the one that actually bit (#1892).
    //
    // Direction 1 above called itself "the dangerous direction" and guarded
    // only SKILL.md ⊆ JSON. But SKILL.md is the file an agent reads WHILE
    // classifying its own diff, so a glob the JSON has and the prose lacks is
    // a perimeter the human half of the process cannot see. Seven runtime
    // globs and five control globs had accumulated in exactly that state, and
    // the Merge Gate still described routes/x402.ts and routes/machine-payments.ts
    // as "dissolved" while both were registered in index.ts and listed here.
    //
    // Subset in one direction is not agreement. Both directions, or neither.
    const skill = read('.agents/skills/ship-next/SKILL.md')
    const tokens = listedTokens(mergeGateFileList(skill))
    const globs = [...loadMoneyPathGlobs(), ...loadMoneyPathControlGlobs()]

    const unnamed = globs.filter((g) => !tokens.some((token) => tokenNamesGlob(token, g)))

    assert.deepEqual(
      unnamed,
      [],
      'the canonical money-path list has globs the SKILL.md Merge Gate never names. ' +
        'Add them to the Merge Gate list — an agent classifying its own diff reads ' +
        'that prose, not this JSON, so a perimeter missing from it is a perimeter ' +
        'the human half of the union cannot apply (#1892).',
    )
  })

  test('the two lists are disjoint — a glob belongs to exactly one', () => {
    const runtime = new Set(loadMoneyPathGlobs())
    const overlap = loadMoneyPathControlGlobs().filter((g) => runtime.has(g))
    assert.deepEqual(overlap, [], 'a glob in both lists would make the split meaningless')
  })

  test('the gate\'s own control surface is labelled money-path', () => {
    // A PR that weakens the last automatic money-path safeguard must not slip
    // through as an ordinary CI tweak.
    const control = loadMoneyPathControlGlobs()
    for (const f of ['scripts/ci/qa-freshness.mjs', '.github/workflows/dev-gate.yml']) {
      assert.ok(control.includes(f), `${f} must be a money-path control file`)
    }
  })

  // Globs deliberately added BEFORE the code they anticipate. Empty is the
  // healthy state, and it is empty today.
  //
  // #1158 did exactly this — it added `modules/machine-payments/**` ahead of the
  // #997 split, which was a reasonable act. The split then landed as
  // `modules/mpp/`, the anticipated directory was never created, and the entry
  // sat matching nothing for a year (#1897). The escape exists so that a
  // legitimate pre-emptive add has a sanctioned way to say so — the alternative
  // is a contributor hitting a red check for doing the right thing, and a false
  // rejection is what teaches people to edit the guard instead of the list
  // (#1892). Add the glob here WITH its issue number, and take it out when the
  // code lands.
  const PRE_EMPTIVE_GLOBS = Object.freeze([])

  test('no phantom globs — every glob names code that exists', () => {
    // The enumeration in #1892 compares the JSON against SKILL.md and never
    // against the code, so it cannot see a glob that matches nothing. That is
    // how a pre-emptive entry for a directory that was never created survived
    // from #1158 to #1897, making the perimeter read as though it covered a
    // module layout the repository has never had.
    //
    // This closes ONE direction of that blind spot: the JSON may not claim code
    // that does not exist. The other direction — money-shaped code absent from
    // BOTH the JSON and the prose — stays open, and deliberately: #1892 measured
    // it. A narrow money-verb scan matches 29 of 266 backend files but misses 30
    // of the 48 already listed; a vocabulary wide enough to catch them matches
    // 149, 56% of the backend, and stops discriminating. There is no derivation
    // to check against, so the list stays hand-written and this test guards the
    // half that IS mechanically decidable.
    const files = trackedFiles()
    const all = [...loadMoneyPathGlobs(), ...loadMoneyPathControlGlobs()]
    const phantom = all
      .filter((g) => !PRE_EMPTIVE_GLOBS.includes(g))
      .filter((g) => !files.some((f) => matchesGlob(f, g)))

    assert.deepEqual(
      phantom,
      [],
      'money-path globs that match no tracked file. Either the code moved — in ' +
        'which case REPOINT the glob, never just delete it, or the perimeter ' +
        'shrinks — or the glob was added ahead of code that never arrived, in ' +
        'which case retire it and note it in the $comment block. If the code is ' +
        'genuinely still coming, add the glob to PRE_EMPTIVE_GLOBS in this file ' +
        'with its issue number (#1897).',
    )
  })

  test('no over-read — curated non-money fixtures never trip the gate', () => {
    // The PRE-EMPTIVE twin of the phantom check (#1905/#1903 cross-session
    // review). The phantom check proves the list is not UNDER-reading (every
    // glob names real code); this one proves it is not OVER-reading either:
    // a list that matches everything is coverage theater, the exact failure
    // mode #1030 started out in. Add real, tracked non-money files here as the
    // perimeter grows; if a broadened glob starts tripping one of them, the
    // sweep fails and the glob must be scoped down, not the fixture deleted.
    const fixtures = [
      'packages/frontend/src/app/how-it-works/page.tsx',
      'packages/frontend/src/components/sidebar/Sidebar.tsx',
      'packages/frontend/src/lib/formatTokenAmount.ts',
      'packages/backend/src/routes/health.ts',
      'packages/core/src/api-types.ts',
      'docs/README.md',
      'packages/frontend/src/app/page.tsx',
    ]
    const all = [...loadMoneyPathGlobs(), ...loadMoneyPathControlGlobs()]
    const trips = fixtures.filter((f) => all.some((g) => matchesGlob(f, g)))
    assert.deepEqual(
      trips,
      [],
      'non-money fixtures matched by the money-path list: ' + trips.join(', '),
    )
  })

  test('the CASP perimeter doc covers the money-path list', () => {
    // The FOURTH copy (#1899).
    //
    // docs/regulatory/casp-risk-guardrails.md's `covers:` front matter is a
    // restatement of this perimeter, and unlike the prose copies it says so
    // itself, under "What `covers:` must span (#1736)":
    //
    //   "The list is therefore maintained against one reference: the money-path
    //    file list in ship-next's Merge Gate. [...] Adding a file to that list
    //    without adding it here re-opens this hole."
    //
    // Nothing checked it. It is a `contract: true` doc, so a money-path file
    // missing from `covers:` is never asked the perimeter question at all, and
    // the absence is invisible in exactly the way #1736 describes: the gate is
    // green because nothing was analysed, not because the analysis passed.
    //
    // Scoped to runtime `globs`. controlGlobs are CI configuration, and the doc
    // reasons about those individually rather than wholesale (#1739 pulled
    // release-bump.mjs and publish.yml in on the "it analyses the wrong event"
    // argument, and both are in `covers:` today).
    const EXEMPT = new Map([
      // Widening a `contract: true` doc's `covers:` across a whole layer makes
      // every future PR touching it owe a CASP shard. For these two that is a
      // real friction decision for the doc's owner, not a drift fix an agent
      // should make on its own; filed rather than assumed. Everything else on
      // the runtime list is required below.
      ['packages/backend/src/infra/chain/**', '11 files; owner decision, see #1899'],
      ['packages/backend/src/infra/repositories/**', '49 files; owner decision, see #1899'],
    ])

    const doc = 'docs/regulatory/casp-risk-guardrails.md'
    const parsed = parseFrontMatter(read(doc))
    assert.ok(parsed.ok, `${doc}: front matter did not parse — ${parsed.error}`)
    const covers = parsed.data.covers || []
    assert.ok(covers.length > 10, `${doc}: read ${covers.length} covers entries — the shape changed`)

    const coversRe = covers.map(globToRegExp)
    const files = trackedFiles()
    const uncovered = []
    for (const glob of loadMoneyPathGlobs()) {
      if (EXEMPT.has(glob)) continue
      const matched = files.filter((f) => matchesGlob(f, glob))
      const missed = matched.filter((f) => !coversRe.some((re) => re.test(f)))
      if (missed.length) uncovered.push(`${glob} (e.g. ${missed[0]})`)
    }

    assert.deepEqual(
      uncovered,
      [],
      `${doc}'s \`covers:\` is missing money-path files. That doc declares itself ` +
        'maintained against this list ("adding a file to that list without adding ' +
        'it here re-opens this hole"), and it is the gate that decides whether a ' +
        'change is asked the CASP perimeter question at all. Add the path to its ' +
        '`covers:`, or — if spanning the whole layer is a friction decision rather ' +
        'than a drift fix — add it to EXEMPT here with a reason and an issue (#1899).',
    )
  })

  test('a count-based fifth-copy detector is pointed the wrong way (#1904)', () => {
    // The FIFTH copy — the one that does not exist yet, and the reason #1904
    // closed without shipping a gate.
    //
    // #1899 sketched a general detector: count distinct perimeter basenames per
    // tracked .md/.yml, fail above a threshold ("start high — say 8"). #1904
    // measured three variants of that idea and all three failed; the reasoning,
    // the numbers and the re-derivation command live in the header of
    // money-path-restatement-scan.mjs, which is a REPORTING tool and never fails.
    //
    // This test is not a threshold and does not guard the tree. It is the
    // positive control plus the finding, expressed as an invariant so the next
    // person to propose the detector meets the measurement instead of
    // re-deriving it a third time. Two assertions:
    //
    //   1. The instrument can return a POSITIVE. A negative result from a
    //      broken tool terminates an investigation while feeling like rigour,
    //      so a planted fresh copy must score above ordinary prose. If this
    //      fails, every negative conclusion downstream of it is void.
    //
    //   2. The instrument is loudest when the copy is CORRECT. A copy that has
    //      rotted to a quarter of the list — the only state anyone cares about
    //      — scores BELOW ordinary prose and is invisible. That is not a
    //      tuning problem: the signal measures the copy's freshness, so its
    //      sensitivity runs inversely to the severity of the fault.
    //
    // Deliberately relative to the live prose ceiling rather than to the
    // absolute numbers (prose 15, copies 28-37 at 345bb582). Pinning the
    // absolutes would go red the day someone writes a new architecture doc,
    // and a false rejection is what teaches people to edit the guard instead
    // of the list (#1892).
    const globs = allGlobs()
    const m = perimeterMatchers(globs)
    const ceiling = proseCeiling(m)
    assert.ok(ceiling > 0, 'scored no prose at all — the scan is broken, not the tree clean')

    const fresh = scoreCount(plantedCopy(globs), m)
    assert.ok(
      fresh > ceiling,
      `the instrument no longer fires on a planted fresh copy (${fresh} vs prose ceiling ${ceiling}). ` +
        'Two causes, and they are opposite. Either the scan broke — fix it before trusting ' +
        'any negative result from it, because a false negative here reads exactly like ' +
        '"no fifth copy exists" — or a document was added that names so much of the ' +
        'perimeter it pulled the ceiling up into the real-copy range, in which case run ' +
        '`node scripts/ci/money-path-restatement-scan.mjs` and read the top of the ranking: ' +
        'that document is itself the fifth copy this issue was about.',
    )

    const rotten = scoreCount(plantedCopy(globs, Math.round(globs.length * 0.25)), m)
    assert.ok(
      rotten < ceiling,
      `a copy carrying only a quarter of the list now scores ${rotten}, at or above the prose ` +
        `ceiling of ${ceiling}. That would be news: #1904 closed because a count-based detector ` +
        'is silent on exactly the stale copies it exists to catch. If this assertion fails, the ' +
        'populations have separated and the detector is worth measuring again.',
    )
  })

  test('the canonical file is well-formed and non-empty', () => {
    // The Merge Gate prose describes CLASSIFICATION (which diffs are
    // money-path), and classification is the UNION — controlGlobs are
    // labelled money-path too, they just skip the QA-freshness re-run. A
    // file named in the prose is "known to the machinery" if either list
    // has it (#1045 moved release-bump/publish.yml to controlGlobs, which
    // is where this distinction first bit).
    const globs = [...loadMoneyPathGlobs(), ...loadMoneyPathControlGlobs()]
    assert.ok(globs.length >= 15, `expected the full money-path list, saw ${globs.length}`)
    for (const g of globs) {
      assert.ok(!g.startsWith('/'), `glob must be repo-root-relative, not absolute: ${g}`)
      assert.ok(!g.includes('\\'), `glob must use forward slashes: ${g}`)
    }
    assert.equal(new Set(globs).size, globs.length, 'duplicate globs')
  })
})
