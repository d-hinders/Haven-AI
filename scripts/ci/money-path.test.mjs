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
import { loadMoneyPathGlobs, loadMoneyPathControlGlobs, matchesGlob, moneyPathFiles } from './qa-freshness.mjs'
import { parseFrontMatter, globToRegExp } from '../docs/validate-frontmatter.mjs'
import {
  KNOWN_COPIES,
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
 * The annotated perimeter, `.agents/skills/ship-next/references/money-path-perimeter.md`
 * (#4177), read under its own line grammar.
 *
 * Only a line of exactly the form ``- `<path>` `` is an entry. A backticked path
 * anywhere else (a sentence, a heading, a parenthetical) is prose and is not read.
 * The list used to live in ship-next's Merge Gate section, mixed with that prose, and this
 * file matched backticked prose tokens against the END of a glob. That matcher was
 * a class of blind spots: `src/**` named six of the eight SDK globs and a file that
 * does not exist (#4122, PR #4131), and a suffix (`routes/payments.ts`) or a
 * concrete file a pattern covers (`infra/relayer-balance-monitor.ts`) stood in for
 * a glob. With one exact path per line the sections are compared for EQUALITY.
 *
 * `## ` headings switch the section; `### ` group headings do not. Every list
 * item (`-`, `*`, `+`, `1.` or `1)`, indented or inside a `>` blockquote) must be
 * an entry: a list item that names a path and then explains it is a near miss,
 * reported as `malformed` so the test fails on it instead of skipping a line a
 * human reads as perimeter. Code fences are not special: an entry inside one
 * counts and a `## ` line inside one switches the section, so a fence can only
 * add a finding, never hide one.
 */
const PERIMETER_DOC = '.agents/skills/ship-next/references/money-path-perimeter.md'
const RUNTIME_HEADING = '## Runtime perimeter: `globs`'
const CONTROL_HEADING = '## Control surface: `controlGlobs`'

function perimeterEntries(text) {
  const out = { runtime: [], control: [], outside: [], malformed: [], headings: { runtime: 0, control: 0 } }
  let section = null
  for (const [i, line] of text.split('\n').entries()) {
    if (line.startsWith('## ')) {
      section = line === RUNTIME_HEADING ? 'runtime' : line === CONTROL_HEADING ? 'control' : null
      if (section) out.headings[section] += 1
      continue
    }
    const entry = line.match(/^- `([^`\s]+)`$/)
    if (entry) (section ? out[section] : out.outside).push(entry[1])
    else if (/^\s*(?:>\s*)*(?:[-*+]|\d+[.)])\s/.test(line)) out.malformed.push(`${i + 1}: ${line}`)
  }
  return out
}

/** A path listed more than once in one section, sorted. */
const duplicates = (list) => [...new Set(list.filter((p, i) => list.indexOf(p) !== i))].sort()

/** Set difference both ways, sorted, for a failure message that names the paths. */
const setDiff = (listed, canonical) => ({
  missing: canonical.filter((g) => !listed.includes(g)).sort(),
  extra: listed.filter((p) => !canonical.includes(p)).sort(),
})

/**
 * Everything the two live tests below assert, computed once so the fixture test
 * can drive the same code. Per group, never the union: qa-freshness reads
 * `globs` alone, so a runtime path under the control heading is wrong even when
 * the union is unchanged.
 */
function perimeterFindings(text, globs, controlGlobs) {
  const parsed = perimeterEntries(text)
  return {
    headings: parsed.headings,
    malformed: parsed.malformed,
    outside: parsed.outside,
    duplicates: { runtime: duplicates(parsed.runtime), control: duplicates(parsed.control) },
    runtime: setDiff(parsed.runtime, globs),
    control: setDiff(parsed.control, controlGlobs),
  }
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

  test('the perimeter reference parses: both sections once, every list item an entry, nothing outside a section', () => {
    const parsed = perimeterFindings(read(PERIMETER_DOC), loadMoneyPathGlobs(), loadMoneyPathControlGlobs())
    assert.deepEqual(parsed.headings, { runtime: 1, control: 1 }, `${PERIMETER_DOC} must carry each section heading exactly once`)
    assert.deepEqual(
      parsed.malformed,
      [],
      `${PERIMETER_DOC} has list items that are not entries. Only a line of the form - \`<path>\` counts; ` +
        'move the explanation into the prose above the entries (#4177).',
    )
    assert.deepEqual(parsed.outside, [], `${PERIMETER_DOC} has entries outside the runtime and control sections`)
    assert.deepEqual(parsed.duplicates, { runtime: [], control: [] }, `${PERIMETER_DOC}: a path is listed twice`)
  })

  test('the perimeter reference lists exactly `globs` and exactly `controlGlobs` (#1030, #1892, #4177)', () => {
    // Both directions, as one equality per group. Direction 1 (#1030): a path
    // documented in the file everyone reads that the machinery never learns
    // about. Direction 2 (#1892), the one that bit: a glob the JSON has and the
    // annotated list lacks is a perimeter an agent classifying its own diff
    // cannot see — seven runtime and five control globs had accumulated in that
    // state. Equality is also what membership was not (#4177): a suffix
    // (`routes/payments.ts`) or a concrete file a pattern covers
    // (`packages/backend/src/infra/relayer-balance-monitor.ts`) passed the old
    // suffix matcher and is an `extra` here. Per group, because qa-freshness
    // reads `globs` alone: a runtime path listed under control is wrong even
    // though the labeler's union would not notice.
    const parsed = perimeterFindings(read(PERIMETER_DOC), loadMoneyPathGlobs(), loadMoneyPathControlGlobs())
    assert.deepEqual(
      parsed.runtime,
      { missing: [], extra: [] },
      `${PERIMETER_DOC}'s runtime section and \`globs\` in .github/money-path-globs.json disagree. ` +
        'Write each glob exactly as the JSON does, one per line. An extra path that IS money-path ' +
        'belongs in the JSON and labeler.yml first; a missing one is a perimeter the reader cannot see (#1892).',
    )
    assert.deepEqual(
      parsed.control,
      { missing: [], extra: [] },
      `${PERIMETER_DOC}'s control section and \`controlGlobs\` in .github/money-path-globs.json disagree. ` +
        'Write each glob exactly as the JSON does, one per line, in the section its JSON list names.',
    )
  })

  test('the perimeter line grammar: only a list item that is one backticked path counts, a near miss is reported, prose is not read (#4177)', () => {
    // The parser's own controls. Mutations: widen the entry regex to accept
    // trailing text and the parenthetical line becomes an entry; drop the
    // malformed branch and the near miss is silently skipped.
    const fixture = [
      '# Title naming `packages/backend/src/routes/health.ts`',
      'Prose naming `packages/sdk/src/client.ts` is not read.',
      '- `outside/a-section.ts`',
      RUNTIME_HEADING,
      '### A group heading naming `packages/backend/src/rails/sweep.ts`',
      'A sentence naming `src/**` and `routes/payments.ts` (a parenthetical with `infra/x.ts`).',
      '- `packages/backend/src/routes/x402.ts`',
      '- `packages/backend/src/routes/payments.ts` (a near miss: an entry with an explanation)',
      '  - `packages/backend/src/indented.ts`',
      '* `packages/backend/src/star.ts`',
      '1. `packages/backend/src/ordered.ts`',
      '> - `packages/backend/src/quoted.ts`',
      CONTROL_HEADING,
      '- `scripts/ci/qa-freshness.mjs`',
      '## Another section',
      '- `after/the-control-section.ts`',
    ].join('\n')
    const parsed = perimeterEntries(fixture)
    assert.deepEqual(parsed.runtime, ['packages/backend/src/routes/x402.ts'])
    assert.deepEqual(parsed.control, ['scripts/ci/qa-freshness.mjs'])
    assert.deepEqual(parsed.outside, ['outside/a-section.ts', 'after/the-control-section.ts'])
    assert.deepEqual(parsed.malformed, [
      '8: - `packages/backend/src/routes/payments.ts` (a near miss: an entry with an explanation)',
      '9:   - `packages/backend/src/indented.ts`',
      '10: * `packages/backend/src/star.ts`',
      '11: 1. `packages/backend/src/ordered.ts`',
      '12: > - `packages/backend/src/quoted.ts`',
    ])
    assert.deepEqual(parsed.headings, { runtime: 1, control: 1 })
  })

  test('the perimeter comparison is per group, and a duplicate is reported (#4177)', () => {
    // Fixture controls for perimeterFindings. Mutations: compare each section
    // with the union of both lists and the moved-path case goes green; drop the
    // duplicates computation and the doubled entry goes unreported.
    const globs = ['packages/a/runtime.ts', 'packages/a/moved.ts']
    const controlGlobs = ['scripts/control.mjs']
    const moved = [
      RUNTIME_HEADING,
      '- `packages/a/runtime.ts`',
      CONTROL_HEADING,
      '- `scripts/control.mjs`',
      '- `packages/a/moved.ts`',
    ].join('\n')
    const m = perimeterFindings(moved, globs, controlGlobs)
    assert.deepEqual(m.runtime, { missing: ['packages/a/moved.ts'], extra: [] })
    assert.deepEqual(m.control, { missing: [], extra: ['packages/a/moved.ts'] })

    const doubled = [
      RUNTIME_HEADING,
      '- `packages/a/runtime.ts`',
      '- `packages/a/moved.ts`',
      '- `packages/a/runtime.ts`',
      CONTROL_HEADING,
      '- `scripts/control.mjs`',
    ].join('\n')
    const d = perimeterFindings(doubled, globs, controlGlobs)
    assert.deepEqual(d.runtime, { missing: [], extra: [] }, 'set equality alone cannot see a duplicate')
    assert.deepEqual(d.duplicates, { runtime: ['packages/a/runtime.ts'], control: [] })
  })

  test('the ship-next Merge Gate section points at the perimeter reference (#4177)', () => {
    // The list left the Merge Gate; the pointer is what sends a reader to it.
    // Mutation: delete the pointer link and this fails.
    const skill = read('.agents/skills/ship-next/SKILL.md')
    const start = skill.indexOf('\n## Merge Gate\n')
    assert.notEqual(start, -1, 'SKILL.md has no Merge Gate section')
    const next = skill.indexOf('\n## ', start + 1)
    const gate = skill.slice(start, next === -1 ? undefined : next)
    assert.ok(
      gate.includes('](references/money-path-perimeter.md)'),
      'the Merge Gate section of ship-next/SKILL.md no longer links references/money-path-perimeter.md',
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
    // The enumeration in #1892 compares the JSON against the annotated perimeter
    // (references/money-path-perimeter.md since #4177) and never against the code, so it cannot see a glob that matches nothing. That is
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

  test('the hosted MCP decision surface is RUNTIME money-path — a change to it gates promotion (#2300)', () => {
    // The positive twin of the over-read sweep above, for the one addition
    // that was argued rather than derived. packages/mcp-server/src/tools.ts
    // decides whether a funding userop is relayed and in what order (#2282),
    // and four money defects shipped from it with no money-path label by the
    // file half. It must match a RUNTIME glob — not merely the union — because
    // qa-freshness.mjs reasons about `globs` alone: a control-glob entry would
    // label the PR and still let a tools.ts change promote on a green run that
    // never exercised it. Mutation: remove packages/mcp-server/src/** from the
    // JSON and this fails by name, before the labeler-union test does.
    const runtime = loadMoneyPathGlobs()
    for (const f of ['packages/mcp-server/src/tools.ts', 'packages/mcp-server/src/server.ts']) {
      assert.ok(
        moneyPathFiles([f], runtime).length === 1,
        `${f} must be matched by a RUNTIME money-path glob — it is the hosted MCP ` +
          'decision surface the deployed money-flow harness exercises (#2300)',
      )
    }

    // The scoping half: the package's build and prose plumbing stays OUT.
    // Measured before choosing src/** over the whole package: 3 of 113 first-parent
    // commits in 90 days (git log --first-parent --since=2026-06-04 -- packages/mcp-server)
    // touched only these files, and a whole-package glob would have
    // forced casp-risk-guardrails.md's `covers:` to widen to a Dockerfile.
    const plumbing = ['packages/mcp-server/README.md', 'packages/mcp-server/Dockerfile', 'packages/mcp-server/package.json']
    const all = [...runtime, ...loadMoneyPathControlGlobs()]
    assert.deepEqual(
      moneyPathFiles(plumbing, all),
      [],
      'mcp-server build/prose plumbing must stay off the perimeter — the glob is src/**, not the package (#2300)',
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
    //    file list, annotated in ship-next's perimeter reference [...]. Adding a
    //    file to that list without adding it here re-opens this hole."
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

  test('the demo merchant\'s settlement file is RUNTIME money-path — a change to it gates promotion (#3098)', () => {
    // The #2300 shape, one package over. packages/demo-merchant-mcp/src/x402.ts
    // verifies the buyer's authorization and SUBMITS it on-chain (settleOnce),
    // and the prod instance runs on Base mainnet (#1458). Two settlement-
    // semantics changes shipped through the gap: #2969 (PR #2977, the zero-hash
    // sentinel) with no money-path label, so no shard was required and
    // qa-freshness did not count it; #2979 (PR #2982, settlement readiness)
    // labelled only because it also touched mcp-server/src/**. The file was
    // outside every glob while the CASP guardrails doc's `covers:` had listed
    // it since #650. Runtime, not
    // control: the demo merchant deploys from `dev` on Railway and the
    // money-flow harness pays it through QA_DEMO_MERCHANT_URL, so a green run
    // really does cover it — with the redeploy-race caveat recorded in the JSON
    // note. Mutation: remove packages/demo-merchant-mcp/src/**
    // from the JSON and this fails by name.
    const runtime = loadMoneyPathGlobs()
    for (const f of ['packages/demo-merchant-mcp/src/x402.ts', 'packages/demo-merchant-mcp/src/server.ts']) {
      assert.ok(
        moneyPathFiles([f], runtime).length === 1,
        `${f} must be matched by a RUNTIME money-path glob — it settles the buyer's ` +
          'authorization on-chain and the money-flow harness exercises it (#3098)',
      )
    }
    const plumbing = ['packages/demo-merchant-mcp/README.md', 'packages/demo-merchant-mcp/package.json']
    assert.deepEqual(
      moneyPathFiles(plumbing, [...runtime, ...loadMoneyPathControlGlobs()]),
      [],
      'demo-merchant build/prose plumbing must stay off the perimeter — the glob is src/**, not the package (#3098)',
    )
  })

  test('the budget-scope period pre-check is RUNTIME money-path — a change to it gates promotion (#3649)', () => {
    // The #1892 shape inside the backend. The #2099 fail-open period pre-check
    // lived inline in modules/x402/delegation-authorize.ts (matched by
    // modules/x402/**) until #3616 created modules/budget-scope/ and #3617
    // deleted the inline copy. PR #3622 (#3616) then touched only the new
    // module and carried no money-path label. Runtime, not control: both x402
    // authorize legs and POST /payments decide through it inside the deployed
    // backend, so a green money-flow run does exercise it. The labeler reads
    // the UNION of both lists, and the perimeter reference follows whichever
    // list the JSON names, so without this test the glob could drift into
    // controlGlobs silently. Mutation: move the glob to
    // controlGlobs (or drop it) and this fails by name.
    const runtime = loadMoneyPathGlobs()
    for (const f of ['packages/backend/src/modules/budget-scope/precheck.ts', 'packages/backend/src/modules/budget-scope/resolver.ts']) {
      assert.ok(
        moneyPathFiles([f], runtime).length === 1,
        `${f} must be matched by a RUNTIME money-path glob — it decides whether a payment ` +
          'fits the remaining budget, and the money-flow harness exercises it (#3649)',
      )
    }
  })

  test('the task-budget and sub-budget families, their SDK guards and the three payments decision files are RUNTIME money-path (#3661)', () => {
    // The question #3649 left open. These BUILD child delegations (the task
    // child, the sub-budget parent-child and the A→B grant that hands spend
    // authority to another agent), run the pre-sign refusals, build the exact
    // bytes the local signer signs for a direct payment, settle the fate of a
    // submitted payment whose UserOp may have landed, decide whether a
    // confirmed x402 payment may be re-signed (agent-payment-status.ts), and
    // check budget children before the local signer signs (the SDK guards,
    // the #3283 rule). Mutation: move any of the ten globs to controlGlobs (or
    // drop it) and this fails by name.
    const runtime = loadMoneyPathGlobs()
    for (const f of [
      'packages/backend/src/modules/task-budgets/task-budget-delegation.ts',
      'packages/backend/src/modules/task-budgets/task-budget-cap.ts',
      'packages/backend/src/modules/sub-budgets/sub-budget-delegation.ts',
      'packages/backend/src/modules/sub-budgets/sub-budget-service.ts',
      'packages/backend/src/routes/task-budgets.ts',
      'packages/backend/src/routes/sub-budgets.ts',
      'packages/backend/src/routes/agent-sub-budgets.ts',
      'packages/backend/src/modules/payments/direct-sign-context.ts',
      'packages/backend/src/modules/payments/submission-reconciler.ts',
      'packages/backend/src/modules/payments/agent-payment-status.ts',
      'packages/sdk/src/task-budget-guards.ts',
      'packages/sdk/src/sub-budget-guards.ts',
    ]) {
      assert.ok(
        moneyPathFiles([f], runtime).length === 1,
        `${f} must be matched by a RUNTIME money-path glob — it builds or decides spend ` +
          'authority and the money-flow harness exercises it (#3661)',
      )
    }
  })

  test('the SDK merchant-answer decision is RUNTIME money-path — a change to it gates promotion (#4122)', () => {
    // MerchantCompletion.retryRequest makes the paid retry after the funding
    // leg has moved USDC, acts on the answer (the merchant accepted, or the
    // payment is a rejection after funding; the decision itself is
    // merchant-answer.ts since #4120) and reports the settlement hash Haven
    // records. It matched no
    // glob: of the 17 commits that touched it since the facade refactor
    // 399b1c00f, three touched no perimeter file and went unlabelled
    // (4e52d4b35, fefd9dc45, 98e1c9cc8). Runtime, not control: qa-dev's
    // x402-delegation-3009 and x402-delegation-3009-grace-resume legs drive
    // retryRequest through client.fetch / resumeX402Payment. The labeler reads
    // the UNION of both lists, and the perimeter reference follows whichever
    // list the JSON names, so without this test the glob could drift into
    // controlGlobs silently. Mutation: move the glob to
    // controlGlobs (or drop it) and this fails by name.
    const f = 'packages/sdk/src/merchant-completion.ts'
    assert.ok(trackedFiles().includes(f), `${f} no longer exists — repoint this pin`)
    assert.ok(
      moneyPathFiles([f], loadMoneyPathGlobs()).length === 1,
      `${f} must be matched by a RUNTIME money-path glob — it acts on a funded payment's ` +
        'merchant outcome, and the money-flow harness exercises it (#4122)',
    )
  })

  test('the shared post-funding merchant-answer decision is RUNTIME money-path — a change to it gates promotion (#4120)', () => {
    // The #4122 shape, one hop over: #4120 moved the accepted/rejected-after-
    // funding decision OUT of the listed merchant-completion.ts into the new
    // packages/sdk/src/merchant-answer.ts (owner decision 2 on #4120 — the
    // module is tracked by its own issue), shared by the hosted
    // completeX402MerchantCall and the local MerchantCompletion.retryRequest.
    // Without this pin the move would have taken the decision off the
    // perimeter silently. Runtime, not control: qa-dev's x402-delegation-3009
    // legs drive the local path through client.fetch / resumeX402Payment and
    // the hosted legs drive completeX402MerchantCall through the deployed
    // server. Mutation: move the glob to controlGlobs (or drop it) and this
    // fails by name.
    const f = 'packages/sdk/src/merchant-answer.ts'
    assert.ok(trackedFiles().includes(f), `${f} no longer exists — repoint this pin`)
    assert.ok(
      moneyPathFiles([f], loadMoneyPathGlobs()).length === 1,
      `${f} must be matched by a RUNTIME money-path glob — it decides a funded payment's ` +
        'merchant outcome and which settlement hash Haven records (#4120)',
    )
  })

  test('the SDK client stays off the money-path list — it only wires the guards in (#3283, #4122)', () => {
    // A deliberate decision, recorded by #3283 and re-taken by the owner on
    // #4120 (2026-10-20): client.ts calls the listed guards and
    // merchant-completion.ts, and listing it would put every SDK transport
    // change on the runtime list. If it starts deciding spend itself, list the
    // deciding code as its own file; do not delete this pin to list client.ts.
    // Mutation: add packages/sdk/src/client.ts to `globs` and this fails.
    const f = 'packages/sdk/src/client.ts'
    assert.ok(trackedFiles().includes(f), `${f} no longer exists — drop this pin`)
    const all = [...loadMoneyPathGlobs(), ...loadMoneyPathControlGlobs()]
    assert.equal(
      moneyPathFiles([f], all).length,
      0,
      `a money-path glob now matches ${f}, which #3283 and #4122 deliberately left off the list`,
    )
  })

  test('the deliberately off-list neighbours stay off — scope a glob down, do not widen to the module (#3661)', () => {
    // #3661 chose FILE-level globs for modules/payments/: the rest of the
    // module is the refusal record (which by design cannot change the
    // refusal it records, #2945/#3053), receipt assembly and prepare-failure
    // reporting, and
    // routes/agent-task-budgets.ts is GET only. A `modules/payments/**`
    // glob would also put each of these in the CASP doc's `covers:` via the
    // #1899 pin, so every edit would owe a shard. If one of them starts
    // deciding spend, move it onto the list here with its reason; do not
    // delete the entry to make a wider glob pass.
    const all = [...loadMoneyPathGlobs(), ...loadMoneyPathControlGlobs()]
    const offList = [
      'packages/backend/src/routes/agent-task-budgets.ts',
      'packages/backend/src/modules/payments/refuse.ts',
      'packages/backend/src/modules/payments/refusal-ledger.ts',
      'packages/backend/src/modules/payments/receipt.ts',
      'packages/backend/src/modules/payments/prepare-failure.ts',
    ]
    const tracked = new Set(trackedFiles())
    for (const f of offList) assert.ok(tracked.has(f), `${f} no longer exists — drop it from this list`)
    assert.deepEqual(
      offList.filter((f) => moneyPathFiles([f], all).length > 0),
      [],
      'a money-path glob now matches a file #3661 deliberately left off the list (#3661)',
    )
  })

  test('every package-wide glob in the CASP perimeter doc is on the money-path list, or named here as doc-only (#3098)', () => {
    // The FOURTH copy, read in the OTHER direction. The test above this
    // block's #1899 twin asks "is every money-path file in `covers:`?" and
    // nothing asked "is every package `covers:` spans on the money-path
    // list?" — so the guardrails doc could name a whole package as perimeter
    // that the classifier, the labeler and qa-freshness had never heard of.
    // It did: packages/demo-merchant-mcp/src/** was in `covers:` and on no
    // glob, and the file that settles on-chain shipped two semantic changes
    // unlabelled (#3098). A package the doc calls money-path and the machinery
    // does not is the #1030 shape with the copies swapped.
    //
    // Scoped to package-wide globs (`packages/<pkg>/**`, `packages/<pkg>/src/**`)
    // ONLY — those are the entries that claim a whole package as perimeter.
    // Sub-package wildcards (`packages/backend/src/modules/accounting/**`,
    // `rails/**`, the frontend accounting/reporting routes) and named files are
    // knowingly outside this check: the doc argues them individually, and
    // narrowing the check is safe. A doc-only package is ALLOWED — the doc reasons
    // about client packages the deployed harness never runs — but it is named
    // here with its reason, never silent.
    const DOC_ONLY = new Map([
      // cli / connect / mcp: client-side packages that run inside the agent's
      // or the user's own process, not deployed by Haven, so the money-flow
      // harness's "did the green run cover this?" has no answer for them.
      // sdk: the harness DOES build and drive it (qa-agent depends on it), but
      // only packages/sdk/src/signer.ts (the signing schemes), the #3271
      // binding check (userop-binding) and the signing-surface guard moved in
      // by #3283 (delegate-account, direct-payment-guard, redemption-guard,
      // settlement-child), joined by the task/sub-budget guards (#3661), are
      // spend authority, merchant-completion (#4122) decides a funded
      // payment's merchant outcome, and merchant-answer.ts (#4120) is the one
      // shared copy of that decision; those ten files ARE on the runtime list.
      // The rest is transport — client.ts among it, pinned off above.
      // The doc covers all four because the CASP perimeter question (does
      // Haven hold or move funds?) still applies to what they ship. Widening
      // any of these to `globs` is an owner decision: every SDK/connector/CLI/
      // local-runtime PR would then owe a covering QA run.
      // A DOC_ONLY entry whose files are ALL on the list is stale and fails
      // below — an exclusion must exclude something.
      ['packages/sdk/src/**', 'client library; only signer.ts, userop-binding.ts, the #3283 signing guard, the #3661 budget guards, merchant-completion.ts (#4122) and merchant-answer.ts (#4120) are on the runtime list — see #3098'],
      ['packages/cli/src/**', 'client CLI; not deployed by Haven — see #3098'],
      ['packages/connect/src/**', 'the dashboard\'s connector, runs on the user\'s machine — see #3098'],
      ['packages/mcp/src/**', 'the local MCP runtime, runs in the agent\'s process — see #3098'],
    ])

    const doc = 'docs/regulatory/casp-risk-guardrails.md'
    const parsed = parseFrontMatter(read(doc))
    assert.ok(parsed.ok, `${doc}: front matter did not parse — ${parsed.error}`)
    const packageWide = (parsed.data.covers || []).filter((g) => /^packages\/[^/]+\/(src\/)?\*\*$/.test(g))
    assert.ok(packageWide.length >= 5, `${doc}: read ${packageWide.length} package-wide covers entries — the shape changed`)

    const all = [...loadMoneyPathGlobs(), ...loadMoneyPathControlGlobs()]
    const files = trackedFiles()
    const offList = []
    for (const glob of packageWide) {
      const matched = files.filter((f) => matchesGlob(f, glob))
      assert.ok(matched.length > 0, `${doc}: ${glob} matches no tracked file`)
      const unlisted = matched.filter((f) => moneyPathFiles([f], all).length === 0)
      if (DOC_ONLY.has(glob)) {
        assert.ok(unlisted.length > 0, `DOC_ONLY names ${glob}, but every file it matches is on the money-path list — the exclusion is stale, drop it`)
        continue
      }
      if (unlisted.length) offList.push(`${glob} (e.g. ${unlisted[0]})`)
    }
    assert.deepEqual(
      offList,
      [],
      `${doc} spans packages the money-path list does not: the doc asks the CASP ` +
        'perimeter question of them while the classifier, the labeler and qa-freshness ' +
        'never will. Add the glob to .github/money-path-globs.json (and labeler.yml and ' +
        `${PERIMETER_DOC}), or name it in DOC_ONLY here with the reason it stays ` +
        'doc-only (#3098).',
    )

    // The named exclusions must still be real entries — a DOC_ONLY line for a
    // glob the doc no longer carries is the phantom shape (#1897) in reverse.
    for (const glob of DOC_ONLY.keys()) {
      assert.ok(packageWide.includes(glob), `DOC_ONLY names ${glob}, which ${doc} no longer covers — drop the entry`)
    }
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

  test('KNOWN_COPIES names the perimeter reference and not SKILL.md (#1904, #4177)', () => {
    // The #1904 test above scores everything OUTSIDE KNOWN_COPIES. The annotated
    // list moved out of ship-next's Merge Gate section into
    // references/money-path-perimeter.md, so the reference is a known home and
    // SKILL.md is ordinary prose: a full copy pasted back into SKILL.md must be
    // scored, and leaving SKILL.md in KNOWN_COPIES would hide it. Mutations:
    // drop the reference from KNOWN_COPIES, or add SKILL.md, and this fails.
    assert.ok(KNOWN_COPIES.includes(PERIMETER_DOC), `KNOWN_COPIES must name ${PERIMETER_DOC}`)
    assert.ok(
      !KNOWN_COPIES.includes('.agents/skills/ship-next/SKILL.md'),
      'KNOWN_COPIES must not name .agents/skills/ship-next/SKILL.md: the list no longer lives there, ' +
        'and a known home is never scored, so a copy pasted back would be invisible',
    )
  })

  test('the canonical file is well-formed and non-empty', () => {
    // Both lists, because both label money-path; they differ only in whether
    // the QA-freshness re-run counts them (#1045 moved release-bump/publish.yml
    // to controlGlobs, which is where that distinction first bit).
    const globs = [...loadMoneyPathGlobs(), ...loadMoneyPathControlGlobs()]
    assert.ok(globs.length >= 15, `expected the full money-path list, saw ${globs.length}`)
    for (const g of globs) {
      assert.ok(!g.startsWith('/'), `glob must be repo-root-relative, not absolute: ${g}`)
      assert.ok(!g.includes('\\'), `glob must use forward slashes: ${g}`)
    }
    assert.equal(new Set(globs).size, globs.length, 'duplicate globs')
  })
})
