// Tests for the claim-protocol parser (`claim-assignee.mjs`).
//
// Every CLAIM and RELEASE string below is real — copied from #1289 and from
// the issues themselves — because the protocol as practised has more shapes
// than AGENTS.md documents, and a parser written against the documentation
// would miss most of a year's releases and leave assignees stale.
//
// Run with: node --test scripts/ci/claim-assignee.test.mjs
// (also collected by the `ci_config_checks` job's `scripts/ci/*.test.mjs` glob)

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { parse } from './claim-assignee.mjs'

const on1289 = (body) => parse({ body, onIssue: 1289 })

describe('claims, as actually written', () => {
  test('the current canonical form', () => {
    const r = on1289('🔒 CLAIM #2947 — branch `feat/2947-analytics-page-shell` — touches: packages/frontend/…')
    assert.deepEqual(r.claim, [2947])
    assert.deepEqual(r.release, [])
  })

  test('parenthesised subject after the number', () => {
    const r = on1289('🔒 CLAIM #2988 (demo merchant: invoice counter seed collision after restart; scan B8) — branch `fix/2988-invoice-seed`')
    assert.deepEqual(r.claim, [2988])
  })

  test('several issues claimed at once, but not the epic named in the aside', () => {
    // Real: an owner directive to finish a whole epic in one session. The four
    // numbers before the parenthesis are the claim; #1408 is the epic they
    // belong to, mentioned as context, and must not be assigned.
    const r = on1289('🔒 CLAIM #1404 + #1411 + #1418 + #1393 (hela resten av connect-epicen #1408)')
    assert.deepEqual(r.claim, [1404, 1411, 1418, 1393])
  })

  test('a number cited in the DESCRIPTION is not claimed', () => {
    // Real, and the bug the corpus replay caught: this line claimed #4 as well
    // as #2044, because 'Red Line #4' is prose about the work.
    const r = on1289('🔒 CLAIM #2044 — branch `chore/2044-vacuous-red-line-4-spies` — removing the three unfalsifiable spies from the Red Line #4 regulatory suite.')
    assert.deepEqual(r.claim, [2044])
  })

  test('the historical bold form with the number after the session name', () => {
    const r = on1289("**CLAIM** (Antonio's session): #1348 — reduce avoidable round trips in guided catalog purchases")
    assert.deepEqual(r.claim, [1348])
  })

  test('a bare claim on its own issue falls back to that issue', () => {
    const r = parse({ body: '🔒 CLAIM — branch `feat/x` — touches: packages/frontend/', onIssue: 2947 })
    assert.deepEqual(r.claim, [2947])
  })

  test('a bare claim on the coordination thread assigns nothing', () => {
    // #1289 is the channel, not work. Falling back to it would assign the
    // standing thread to whoever posted.
    assert.deepEqual(on1289('🔒 CLAIM — branch `feat/x`').claim, [])
  })

  test('the coordination thread is never assigned even when named', () => {
    assert.deepEqual(on1289('🔒 CLAIM #1289 — housekeeping').claim, [])
  })
})

describe('releases, matched generously because a stale assignee misleads', () => {
  const cases = [
    ['open padlock', '🔓 RELEASE #2945 — landed as PR #2955 (squash 5d8215ff)', 2945],
    ['bold Released with colon', '**Released:** #2960 (party model — `parties { treasury_account, delegate }`)', 2960],
    ['plain Released', 'Released: #2988 (scan finding B8) via PR #2990 → dev `a1e6aaa2`.', 2988],
    ['historical bold form', "**RELEASE** (Antonio's session): #1328 shipped — PR #1339 merged", 1328],
    ['number first, keyword later', '#2680 (epic #2678 slice 2): **RELEASE** — PR #2754 opened', 2680],
  ]
  for (const [name, body, expected] of cases) {
    test(name, () => {
      const r = on1289(body)
      assert.ok(r.release.includes(expected), `expected #${expected} released, got ${JSON.stringify(r)}`)
      assert.deepEqual(r.claim, [], 'a release must not also claim')
    })
  }
})

describe('reported claims must not be stolen', () => {
  // THE case. Philip's overlap FYI quotes Antonio's claim on #2970 while making
  // no claim of his own. A parser scanning the whole body would have assigned
  // Antonio's work to Philip on the strength of Philip describing it.
  const FYI = [
    '📣 FYI (informational, not a directive) — coverage overlap: our live claim #2968 vs #2970 / PR #2971',
    '',
    '- Ours: 🔒 CLAIM #2968 2026-09-14T12:25:07Z, branch `feat/2968-settle-confirmation-guard` — the erc7710 guard.',
    '- Theirs: 🔒 CLAIM #2970 2026-09-14T13:28:54Z, PR #2971 (draft, MERGEABLE, unmerged).',
  ].join('\n')

  test('neither quoted claim is taken as a claim', () => {
    const r = on1289(FYI)
    assert.deepEqual(r.claim, [], 'a claim reported inside a bullet is not a claim being made')
    assert.deepEqual(r.release, [])
  })

  test('a claim quoted inside prose is not a claim', () => {
    const r = on1289('For context, PhilipEriksson posted 🔒 CLAIM #2947 yesterday morning.')
    assert.deepEqual(r.claim, [])
  })

  test('but a real claim on the next line still registers', () => {
    const r = on1289(`${FYI}\n🔒 CLAIM #2999 — branch \`feat/2999-x\` — touches: packages/core/`)
    assert.deepEqual(r.claim, [2999])
  })
})

describe('mixed and ambiguous comments', () => {
  test('a comment that releases one issue and claims another does both', () => {
    const r = on1289('🔓 RELEASE #2945 — landed as PR #2955\n🔒 CLAIM #2947 — branch `feat/2947-shell`')
    assert.deepEqual(r.release, [2945])
    assert.deepEqual(r.claim, [2947])
  })

  test('an issue on BOTH sides resolves to release — the safe direction', () => {
    // Unassigning something still in flight costs a re-read of the thread.
    // Leaving a finished issue assigned misleads every reader and every tool.
    const r = on1289('🔒 CLAIM #2947 — restating\n🔓 RELEASE #2947 — actually landed as PR #3000')
    assert.deepEqual(r.claim, [])
    assert.deepEqual(r.release, [2947])
  })

  test('a status note re-asserting a live claim is a no-op', () => {
    // Real: "🔒 claim LIVE — #2949 (Cortana ledger note, not a release)". The
    // word between the keyword and the number breaks the leading run, so
    // nothing is extracted — and that is the right outcome. The note says it is
    // not a release, and the original CLAIM already assigned the issue, so
    // acting on it could only duplicate an assignment that already holds.
    const r = on1289('🔒 claim LIVE — #2949 (Cortana ledger note, not a release)')
    assert.deepEqual(r.release, [], 'a note that says it is not a release must not release')
    assert.deepEqual(r.claim, [])
  })
})

describe('comments that say nothing about claims', () => {
  const quiet = [
    '## Overlap avoided — #2105 stood down, not double-built',
    'Filed build card t_8f39877c (juice) + review card t_cb27598a (payo) — pipeline tracking.',
    'Dependency-gate re-check (run 176): #2947 still ours.',
    '📣 FYI — release 0.1.21 promoting tonight; #2900 and #2901 ride it.',
    '',
    'LGTM',
  ]
  for (const body of quiet) {
    test(`no-op: ${JSON.stringify(body.slice(0, 44))}`, () => {
      const r = on1289(body)
      assert.deepEqual(r.claim, [])
      assert.deepEqual(r.release, [])
    })
  }

  test('null and undefined bodies do not throw', () => {
    for (const body of [null, undefined]) {
      assert.deepEqual(parse({ body, onIssue: 1 }), { claim: [], release: [] })
    }
  })
})

describe('reference extraction', () => {
  test('a number is taken only from the line that carries the marker', () => {
    const r = on1289('🔒 CLAIM #2947 — branch feat/2947\nUnrelated prose mentioning #9999.')
    assert.deepEqual(r.claim, [2947])
  })

  test('duplicates on one line collapse', () => {
    assert.deepEqual(on1289('🔒 CLAIM #2947 — see #2947 for detail').claim, [2947])
  })

  test('a long digit run is not a reference', () => {
    // Timestamps and card ids appear in these comments constantly.
    assert.deepEqual(on1289('🔒 CLAIM #12345678 — card t_8f39877c').claim, [])
  })
})
