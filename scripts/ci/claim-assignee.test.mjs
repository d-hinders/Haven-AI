// Tests for the claim-protocol parser (`claim-assignee.mjs`) and, from #3178, the
// collision decision that sits behind it (`claim-collision.mjs`).
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
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from './claim-assignee.mjs'
import { CHANNEL_ISSUE } from './coordination-channel.mjs'
import { decideClaim, holderClaim, branchOf, ageText, mentionsIssue, sameLogin, fetchClaimState, applyClaim, LIVE_CLAIM_MS, TRUSTED_ASSOCIATIONS } from './claim-collision.mjs'

const CLI = fileURLToPath(new URL('./claim-assignee.mjs', import.meta.url))

const onChannel = (body) => parse({ body, onIssue: CHANNEL_ISSUE })

describe('claims, as actually written', () => {
  test('the current canonical form', () => {
    const r = onChannel('🔒 CLAIM #2947 — branch `feat/2947-analytics-page-shell` — touches: packages/frontend/…')
    assert.deepEqual(r.claim, [2947])
    assert.deepEqual(r.release, [])
  })

  test('parenthesised subject after the number', () => {
    const r = onChannel('🔒 CLAIM #2988 (demo merchant: invoice counter seed collision after restart; scan B8) — branch `fix/2988-invoice-seed`')
    assert.deepEqual(r.claim, [2988])
  })

  test('several issues claimed at once, but not the epic named in the aside', () => {
    // Real: an owner directive to finish a whole epic in one session. The four
    // numbers before the parenthesis are the claim; #1408 is the epic they
    // belong to, mentioned as context, and must not be assigned.
    const r = onChannel('🔒 CLAIM #1404 + #1411 + #1418 + #1393 (hela resten av connect-epicen #1408)')
    assert.deepEqual(r.claim, [1404, 1411, 1418, 1393])
  })

  test('a number cited in the DESCRIPTION is not claimed', () => {
    // Real, and the bug the corpus replay caught: this line claimed #4 as well
    // as #2044, because 'Red Line #4' is prose about the work.
    const r = onChannel('🔒 CLAIM #2044 — branch `chore/2044-vacuous-red-line-4-spies` — removing the three unfalsifiable spies from the Red Line #4 regulatory suite.')
    assert.deepEqual(r.claim, [2044])
  })

  test('the historical bold form with the number after the session name', () => {
    const r = onChannel("**CLAIM** (Antonio's session): #1348 — reduce avoidable round trips in guided catalog purchases")
    assert.deepEqual(r.claim, [1348])
  })

  test('a bare claim on its own issue falls back to that issue', () => {
    const r = parse({ body: '🔒 CLAIM — branch `feat/x` — touches: packages/frontend/', onIssue: 2947 })
    assert.deepEqual(r.claim, [2947])
  })

  test('a bare claim on the coordination thread assigns nothing', () => {
    // The channel (`CHANNEL_ISSUE`) is where claims are posted, not work. Falling back to it would assign the
    // standing thread to whoever posted.
    assert.deepEqual(onChannel('🔒 CLAIM — branch `feat/x`').claim, [])
  })

  test('the coordination thread is never assigned even when named', () => {
    assert.deepEqual(onChannel(`🔒 CLAIM #${CHANNEL_ISSUE} — housekeeping`).claim, [])
  })
})

describe('releases, matched generously because a stale assignee misleads', () => {
  const cases = [
    ['open padlock', '🔓 RELEASE #2945 — landed as PR #2955 (squash 5d8215ff)', 2945],
    ['bold Released with colon', '**Released:** #2960 (party model — `parties { treasury_account, delegate }`)', 2960],
    ['plain Released', 'Released: #2988 (scan finding B8) via PR #2990 → dev `a1e6aaa2`.', 2988],
    ['historical bold form', "**RELEASE** (Antonio's session): #1328 shipped — PR #1339 merged", 1328],
    ['number first, keyword later', '#2680 (epic #2678 slice 2): **RELEASE** — PR #2754 opened', 2680],
    // `↩️ WITHDRAWN` is a release (#3182). The three shapes are verbatim from the
    // channel (2026-08-27, 2026-09-15 ×2); before #3182 none of them unassigned.
    ['withdrawn, number after the word', "↩️ WITHDRAWN #3005 — my claim at 12:51Z collided with @PhilipEriksson's at 11:35Z (same issue, same branch name).", 3005],
    ['withdrawn, superseded by a PR', "↩️ WITHDRAWN #3015 — superseded by @d-hinders's PR #3022 (merged 13:41Z, closes #3015, no claim posted here; my claim stood from 13:03Z).", 3015],
    ['withdrawn with a warning sign, number after RELEASE', '⚠️ WITHDRAWN — RELEASE #2117 (PR #2134) closed as superseded by #2135 (merged `a0fffaf0`).', 2117],
    ['padlock release that says withdrawn mid-line', '🔓 RELEASE #2780 — claim **WITHDRAWN AS SUPERSEDED** (duplicate claim, nothing built).', 2780],
    // The reason prose after the number may say "release(d)"; the number is
    // still read after WITHDRAWN (review of #3182 measured these three as []).
    ['withdrawn, reason says released', '↩️ WITHDRAWN #3005 — Philip already released this one', 3005],
    ['withdrawn, superseded and released the branch', '↩️ WITHDRAWN #3005 — superseded by PR #3010, released the branch', 3005],
    ['withdrawn, holder will release later', '↩️ WITHDRAWN #3005 — collided with @philip; he will release when done', 3005],
    ['withdrawn without the presentation selector', '↩ WITHDRAWN #3005 — same marker, plain arrow', 3005],
  ]
  for (const [name, body, expected] of cases) {
    test(name, () => {
      const r = onChannel(body)
      // deepEqual, not includes: two of these lines name the PR that carried
      // the work, and the whole point of dropping `PR #n` is that the PR number
      // must NOT also be released. `includes` would pass either way.
      assert.deepEqual(r.release, [expected], `got ${JSON.stringify(r)}`)
      assert.deepEqual(r.claim, [], 'a release must not also claim')
    })
  }

  test('a withdrawal posted on its own issue may omit the number, like 🔓 (#3182)', () => {
    assert.deepEqual(parse({ body: '↩️ WITHDRAWN — collided with Philip, standing down', onIssue: 3005 }), { claim: [], release: [3005] })
    assert.deepEqual(parse({ body: '↩ WITHDRAWN — standing down (plain arrow)', onIssue: 3005 }), { claim: [], release: [3005] })
  })

  test('a line that leads with the issue and then says WITHDRAWN is not a marker (deliberate; RELEASE has that arm)', () => {
    assert.deepEqual(onChannel('#3005 — WITHDRAWN, collided'), { claim: [], release: [] })
  })

  test('the word withdrawn mid-sentence is prose, not a marker', () => {
    // Mutation: widen `withdrawnLine` to /withdrawn\b/i anywhere on the line →
    // the number after the colon reads as a release and this goes red.
    assert.deepEqual(onChannel("Note: Philip's claim was withdrawn: #3005 is free again."), { claim: [], release: [] })
    assert.deepEqual(onChannel('The claim was withdrawn yesterday, see #3005 above.'), { claim: [], release: [] })
  })

  test('a withdrawal ends the hold in the collision rule too (#3182)', () => {
    // Philip claims, then withdraws; Antonio's later claim must be accepted, not
    // refused as a second claim on a live hold. Mutation: drop `withdrawnLine`
    // from `releaseLine` → refuse.
    const t0 = Date.parse('2026-09-15T11:35:36Z')
    const comments = [
      { author: 'PhilipEriksson', body: '🔒 CLAIM #3005 — branch `feat/3005-x`', createdAt: '2026-09-15T11:35:36Z', onIssue: CHANNEL_ISSUE, authorAssociation: 'COLLABORATOR' },
      { author: 'PhilipEriksson', body: '↩️ WITHDRAWN #3005 — duplicate of an earlier branch', createdAt: '2026-09-15T12:00:00Z', onIssue: CHANNEL_ISSUE, authorAssociation: 'COLLABORATOR' },
    ]
    const d = decideClaim({ issue: 3005, claimant: 'AntonioSaaranen', state: 'open', assignees: [], comments, postedOn: CHANNEL_ISSUE, claimedAt: '2026-09-15T12:51:40Z', nowMs: t0 + 90 * 60_000 })
    assert.equal(d.action, 'accept', JSON.stringify(d))
  })
})

describe('the channel number is single-sourced (#3182)', () => {
  const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')

  test('every coordination module re-exports the one constant', async () => {
    const [{ CHANNEL_ISSUE: c1 }, { CHANNEL_ISSUE: c2 }] = await Promise.all([import('./claim-collision.mjs'), import('./release-on-merge.mjs')])
    assert.equal(c1, CHANNEL_ISSUE)
    assert.equal(c2, CHANNEL_ISSUE)
    // Mutation: put `export const CHANNEL_ISSUE = 1289` back in either → red.
    for (const f of ['./claim-collision.mjs', './release-on-merge.mjs', './pr-ownership-gate.mjs', './claim-assignee.mjs']) {
      assert.doesNotMatch(read(f), /CHANNEL_ISSUE\s*=\s*\d/, `${f} defines its own channel number`)
    }
  })

  test('the morning-report note defaults to the same issue', () => {
    const yml = read('../../.github/workflows/morning-report-note.yml')
    const m = yml.match(/\n\s+issue:\n(?:.*\n){1,4}?\s+default: '(\d+)'/)
    assert.ok(m, 'no default for the issue input')
    assert.equal(Number(m[1]), CHANNEL_ISSUE)
  })

  test('the shared-surface list is written once, in AGENTS.md (#3182 acceptance)', () => {
    const files = ['../../AGENTS.md', '../../.agents/skills/ship-next/SKILL.md', '../../.github/workflows/claim-assignee.yml', './claim-assignee.mjs']
    const hits = files.filter((f) => read(f).includes('packages/mcp-server/src/tools*'))
    assert.deepEqual(hits, ['../../AGENTS.md'])
  })

  test('the protocol docs name a retired channel only where they call it the predecessor or history', async () => {
    // The first cut of this test matched the URL form only and stayed green
    // over five bare `#1289` live-rule sentences (review of #3182). Bare
    // mentions are the ones agents read, so every LINE that carries one must
    // also say what it is. Mutation: put `coordinate in #1289` back → red.
    const { RETIRED_CHANNEL_ISSUES } = await import('./coordination-channel.mjs')
    for (const old of RETIRED_CHANNEL_ISSUES) {
      for (const f of ['../../AGENTS.md', '../../.agents/skills/ship-next/SKILL.md']) {
        const offenders = read(f)
          .split('\n')
          .filter((l) => new RegExp(`(?:#|issues/)${old}\\b`).test(l) && !/predecessor|history/i.test(l))
        assert.deepEqual(offenders, [], `${f} names the retired channel #${old} as if it were live`)
      }
    }
  })
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
    const r = onChannel(FYI)
    assert.deepEqual(r.claim, [], 'a claim reported inside a bullet is not a claim being made')
    assert.deepEqual(r.release, [])
  })

  test('a claim quoted inside prose is not a claim', () => {
    const r = onChannel('For context, PhilipEriksson posted 🔒 CLAIM #2947 yesterday morning.')
    assert.deepEqual(r.claim, [])
  })

  test('but a real claim on the next line still registers', () => {
    const r = onChannel(`${FYI}\n🔒 CLAIM #2999 — branch \`feat/2999-x\` — touches: packages/core/`)
    assert.deepEqual(r.claim, [2999])
  })
})

describe('a quoted claim is reported, never made', () => {
  // GitHub's "Quote reply" button emits `> 🔒 CLAIM …`, so this is the DEFAULT
  // way one session repeats another's claim. Taking it as a claim would assign
  // the quoter — and since assignment ADDS, the real owner's later RELEASE
  // removes only the owner, stranding the quoter on the issue with nothing in
  // the thread to explain it.
  test('a quote-reply of a claim assigns nobody', () => {
    const r = onChannel('> 🔒 CLAIM #2970 — branch `feat/2970-settled-verified`\n\nThanks, standing down.')
    assert.deepEqual(r.claim, [])
    assert.deepEqual(r.release, [])
  })

  test('a nested quote too', () => {
    assert.deepEqual(onChannel('>> 🔒 CLAIM #2970').claim, [])
  })

  test('a quoted RELEASE is ignored as well', () => {
    assert.deepEqual(onChannel('> 🔓 RELEASE #2968 — landed').release, [])
  })

  test('an unquoted claim below a quoted one still registers', () => {
    const r = onChannel('> 🔒 CLAIM #2970 — theirs\n\n🔒 CLAIM #2999 — branch `feat/2999-x`')
    assert.deepEqual(r.claim, [2999])
  })
})

describe('a marker inside a code fence is documentation, not a claim', () => {
  test('fenced claim assigns nobody', () => {
    const r = onChannel('The format is:\n```\n🔒 CLAIM #2947 — branch `feat/x` — touches: …\n```\nPost that on the issue.')
    assert.deepEqual(r.claim, [])
  })

  test('a real claim after the fence closes still registers', () => {
    const r = onChannel('Example:\n```\n🔒 CLAIM #1111 — sample\n```\n🔒 CLAIM #2947 — branch `feat/real`')
    assert.deepEqual(r.claim, [2947])
  })
})

describe('the bare-issue fallback is claims-only', () => {
  // `releaseLine` matches any line leading with the word, on purpose. Composed
  // with a fallback to the containing issue, an ordinary sentence about a
  // VERSION would have unassigned the issue it was posted on — erasing a live
  // claim, and firing on the owner whose claim it erases.
  test('a sentence about a release version does not unassign the issue', () => {
    const r = parse({ body: 'Release 0.1.21 promoting tonight; #2900 and #2901 ride it.', onIssue: 2947 })
    assert.deepEqual(r.release, [])
    assert.deepEqual(r.claim, [])
  })

  test('nor does prose that merely starts with Released', () => {
    assert.deepEqual(parse({ body: 'Released to prod this morning, all good.', onIssue: 2947 }).release, [])
  })

  test('but an explicit padlock with no number still releases the containing issue', () => {
    // A deliberate use of the protocol, so the fallback is kept for it.
    const r = parse({ body: '🔓 RELEASE — landed as PR #2955', onIssue: 2947 })
    assert.deepEqual(r.release, [2947])
  })

  test('prose beginning with the word Claim does not assign', () => {
    assert.deepEqual(parse({ body: 'Claim checks pass now.', onIssue: 2947 }).claim, [])
  })
})

describe('CLI contract the workflow depends on', () => {
  const run = (body, onIssue) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'claim-'))
    writeFileSync(path.join(dir, 'c.txt'), body)
    const args = [CLI, '--body', 'c.txt']
    if (onIssue) args.push('--on-issue', String(onIssue))
    return execFileSync(process.execPath, args, { cwd: dir, encoding: 'utf8' })
  }

  test('every emitted line is a verb and a plain number', () => {
    // This output is the only thing between a public comment box and `gh` argv.
    // No line may ever begin with a dash or carry anything but digits.
    const hostile = [
      '🔒 CLAIM #2947 --repo evil/repo — branch x',
      '🔒 CLAIM #-5 and #2948',
      '🔓 RELEASE #2945; rm -rf /',
      '🔒 CLAIM #2999 `$(whoami)`',
    ].join('\n')
    for (const line of run(hostile, CHANNEL_ISSUE).split('\n').filter(Boolean)) {
      assert.match(line, /^(claim|release)=\d{1,6}$/, `unsafe CLI line: ${JSON.stringify(line)}`)
    }
  })

  test('a comment with nothing to do prints nothing', () => {
    assert.equal(run('LGTM, nice work.', CHANNEL_ISSUE), '')
  })

  test('output ends with a newline so the shell read loop sees the last line', () => {
    const out = run('🔒 CLAIM #2947 — branch x', CHANNEL_ISSUE)
    assert.equal(out, 'claim=2947\n')
  })

  test('missing --body exits non-zero', () => {
    let code = 0
    try {
      execFileSync(process.execPath, [CLI], { encoding: 'utf8', stdio: 'pipe' })
    } catch (e) {
      code = e.status
    }
    assert.notEqual(code, 0)
  })
})

describe('mixed and ambiguous comments', () => {
  test('a comment that releases one issue and claims another does both', () => {
    const r = onChannel('🔓 RELEASE #2945 — landed as PR #2955\n🔒 CLAIM #2947 — branch `feat/2947-shell`')
    assert.deepEqual(r.release, [2945])
    assert.deepEqual(r.claim, [2947])
  })

  test('an issue on BOTH sides resolves to release — the safe direction', () => {
    // Unassigning something still in flight costs a re-read of the thread.
    // Leaving a finished issue assigned misleads every reader and every tool.
    const r = onChannel('🔒 CLAIM #2947 — restating\n🔓 RELEASE #2947 — actually landed as PR #3000')
    assert.deepEqual(r.claim, [])
    assert.deepEqual(r.release, [2947])
  })

  test('a status note re-asserting a live claim is a no-op', () => {
    // Real: "🔒 claim LIVE — #2949 (Cortana ledger note, not a release)". The
    // word between the keyword and the number breaks the leading run, so
    // nothing is extracted — and that is the right outcome. The note says it is
    // not a release, and the original CLAIM already assigned the issue, so
    // acting on it could only duplicate an assignment that already holds.
    const r = onChannel('🔒 claim LIVE — #2949 (Cortana ledger note, not a release)')
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
      const r = onChannel(body)
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
    const r = onChannel('🔒 CLAIM #2947 — branch feat/2947\nUnrelated prose mentioning #9999.')
    assert.deepEqual(r.claim, [2947])
  })

  test('duplicates on one line collapse', () => {
    assert.deepEqual(onChannel('🔒 CLAIM #2947 — see #2947 for detail').claim, [2947])
  })

  test('a long digit run is not a reference', () => {
    // Timestamps and card ids appear in these comments constantly.
    assert.deepEqual(onChannel('🔒 CLAIM #12345678 — card t_8f39877c').claim, [])
  })
})

describe('a bot author is honoured for one shape only: the merge-time release (#3177)', () => {
  const bot = (body, onIssue = 3134) => parse({ body, onIssue, authorType: 'Bot' })
  const autoRelease = '🔓 RELEASE #3134 — landed as PR #3186 (squash `a29d5469`, into `dev`) — posted automatically on merge (#3177); nothing to release by hand.'

  test('the merge-time release names its PR and is honoured', () => {
    assert.deepEqual(bot(autoRelease), { claim: [], release: [3134] })
  })

  test('honoured on the channel too, releasing the issue named, never the channel', () => {
    assert.deepEqual(bot(autoRelease, CHANNEL_ISSUE), { claim: [], release: [3134] })
  })

  test('a bot CLAIM is ignored — a bot owns no work', () => {
    assert.deepEqual(bot('🔒 CLAIM #3134 — branch `feat/x` — touches: everything'), { claim: [], release: [] })
  })

  test('a bot RELEASE that names no PR is not the workflow\'s and is ignored', () => {
    assert.deepEqual(bot('🔓 RELEASE #3134 — done'), { claim: [], release: [] })
    assert.deepEqual(bot('Released: #3134'), { claim: [], release: [] })
  })

  test('the bare-issue fallback is closed to bots', () => {
    // A human `🔓` with no number releases the issue it was posted on; a bot
    // line with no number says nothing.
    assert.deepEqual(bot('🔓 RELEASE — landed as PR #3186'), { claim: [], release: [] })
  })

  test('a human comment with the same text is unchanged by the flag', () => {
    assert.deepEqual(parse({ body: autoRelease, onIssue: 3134, authorType: 'User' }), { claim: [], release: [3134] })
    assert.deepEqual(parse({ body: '🔒 CLAIM #3134 — x', onIssue: 3134 }), { claim: [3134], release: [] })
  })

  test('the CLI accepts --author-type and narrows the same way', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'claim-bot-'))
    const p = path.join(dir, 'c.txt')
    writeFileSync(p, '🔒 CLAIM #3134 — x\n🔓 RELEASE #3135 — landed as PR #9\n')
    const out = execFileSync(process.execPath, [CLI, '--body', p, '--on-issue', '3134', '--author-type', 'Bot'], { encoding: 'utf8' })
    assert.equal(out, 'release=3135\n')
  })
})

describe('a second CLAIM on a held issue is answered, not silently accepted (#3178)', () => {
  // The #3005 shape, 2026-09-15, as #1289 records it: Philip claimed on #1289
  // at 11:35:36Z; Antonio claimed the same issue at 12:51:40Z (76 min later)
  // with the same branch, then withdrew at 13:00:47Z. Roles and times are the
  // measured ones (`gh api --paginate repos/…/issues/1289/comments`); the
  // branch name is abbreviated here (the real one was ci/3005-core-qa-agent-jobs).
  const NOW = Date.parse('2026-09-15T12:51:40Z')
  const holderClaimLine = { author: 'PhilipEriksson', body: '🔒 CLAIM #3005 — branch `feat/3005-x` — touches: packages/backend/…', createdAt: '2026-09-15T11:35:36Z', onIssue: CHANNEL_ISSUE, authorAssociation: 'COLLABORATOR' }
  const base = { issue: 3005, claimant: 'AntonioSaaranen', state: 'open', assignees: ['PhilipEriksson'], postedOn: CHANNEL_ISSUE, nowMs: NOW }

  test('second claim within 24 h → refused with a reply naming the holder, the age, the branch, and that nothing was recorded', () => {
    const d = decideClaim({ ...base, comments: [holderClaimLine] })
    assert.equal(d.action, 'refuse')
    assert.equal(d.assign, undefined)
    assert.equal(d.reply.issue, CHANNEL_ISSUE)
    assert.match(d.reply.body, /^⚠️ Already claimed: issue 3005 is held by @PhilipEriksson\./)
    assert.ok(d.reply.body.includes(`claimed it 76 min ago on #${CHANNEL_ISSUE} (branch \`feat/3005-x\`)`), d.reply.body)
    assert.match(d.reply.body, /This claim by @AntonioSaaranen was not recorded/)
  })

  test('the reply is posted where the claim was posted — on the issue itself when the claim was there', () => {
    const d = decideClaim({ ...base, postedOn: 3005, comments: [{ ...holderClaimLine, onIssue: 3005 }] })
    assert.equal(d.reply.issue, 3005)
    assert.match(d.reply.body, /on this issue/)
  })

  test('same author re-claiming (branch rename) → accepted silently', () => {
    const d = decideClaim({ ...base, claimant: 'PhilipEriksson', comments: [holderClaimLine] })
    assert.deepEqual(d, { action: 'accept', issue: 3005, assign: 'PhilipEriksson', reason: 'nobody else holds it' })
  })

  test('stale claim (≥ 24 h, unreleased) → taken over: holder unassigned, claimant assigned, reply says so', () => {
    // #3178 acceptance mutation: drop the 24 h age check and this goes red.
    const old = { ...holderClaimLine, createdAt: '2026-09-12T13:00:00Z' } // 3 d
    const d = decideClaim({ ...base, comments: [old] })
    assert.equal(d.action, 'takeover')
    assert.equal(d.assign, 'AntonioSaaranen')
    assert.deepEqual(d.unassign, ['PhilipEriksson'])
    assert.match(d.reply.body, /^ℹ️ Taken over: issue 3005 — @PhilipEriksson's claim was 3 d ago, their last comment about it 3 d ago, with no RELEASE since/)
    assert.match(d.reply.body, /reassigned to @AntonioSaaranen/)
  })

  test('exactly 24 h is stale; one minute less is live', () => {
    const at = (ms) => ({ ...holderClaimLine, createdAt: new Date(NOW - ms).toISOString() })
    assert.equal(decideClaim({ ...base, comments: [at(LIVE_CLAIM_MS)] }).action, 'takeover')
    assert.equal(decideClaim({ ...base, comments: [at(LIVE_CLAIM_MS - 60_000)] }).action, 'refuse')
  })

  test('released claim → accepted (the holder said they dropped it, even if the projection missed it)', () => {
    const release = { author: 'PhilipEriksson', body: '🔓 RELEASE #3005 — abandoned: picking #3010 instead', createdAt: '2026-09-15T12:30:00Z', onIssue: CHANNEL_ISSUE }
    const d = decideClaim({ ...base, comments: [holderClaimLine, release] })
    assert.equal(d.action, 'accept')
    assert.equal(d.assign, 'AntonioSaaranen')
  })

  test('a release BEFORE the claim does not count as releasing it', () => {
    const earlier = { author: 'PhilipEriksson', body: '🔓 RELEASE #3005 — abandoned', createdAt: '2026-09-15T10:00:00Z', onIssue: CHANNEL_ISSUE }
    assert.equal(decideClaim({ ...base, comments: [earlier, holderClaimLine] }).action, 'refuse')
  })

  test('an assignee with no claim comment (tracking) is not a claim in force → the claimant is added beside them, silently', () => {
    const d = decideClaim({ ...base, comments: [] })
    assert.equal(d.action, 'accept')
    assert.equal(d.assign, 'AntonioSaaranen')
    assert.equal(d.reply, undefined)
  })

  test('a QUOTED claim by the holder is not their claim — reporting is not claiming', () => {
    const quoted = { ...holderClaimLine, body: '> 🔒 CLAIM #3005 — branch `feat/3005-x`\n\nFYI: quoting the claim as posted on the issue.' }
    assert.equal(decideClaim({ ...base, comments: [quoted] }).action, 'accept')
  })

  test('a closed issue → skip, as before', () => {
    assert.equal(decideClaim({ ...base, state: 'closed', comments: [holderClaimLine] }).action, 'skip')
  })

  test('two holders: one live, one stale → refused (live wins); both stale → both unassigned', () => {
    const daniel = { author: 'd-hinders', body: '🔒 CLAIM #3005 — branch `x`', createdAt: '2026-09-10T00:00:00Z', onIssue: 3005 }
    const mixed = decideClaim({ ...base, assignees: ['PhilipEriksson', 'd-hinders'], comments: [holderClaimLine, daniel] })
    assert.equal(mixed.action, 'refuse')
    const both = decideClaim({ ...base, assignees: ['PhilipEriksson', 'd-hinders'], comments: [{ ...holderClaimLine, createdAt: '2026-09-11T00:00:00Z' }, daniel] })
    assert.equal(both.action, 'takeover')
    assert.deepEqual(both.unassign.sort(), ['PhilipEriksson', 'd-hinders'])
  })

  test('both replies are ignored by the parser — no marker at line start, #N never leads a line', () => {
    const refuse = decideClaim({ ...base, comments: [holderClaimLine] }).reply.body
    const takeover = decideClaim({ ...base, comments: [{ ...holderClaimLine, createdAt: '2026-09-12T13:00:00Z' }] }).reply.body
    for (const body of [refuse, takeover]) {
      assert.deepEqual(parse({ body, onIssue: CHANNEL_ISSUE }), { claim: [], release: [] })
      assert.deepEqual(parse({ body, onIssue: 3005 }), { claim: [], release: [] })
      assert.deepEqual(parse({ body, onIssue: 3005, authorType: 'Bot' }), { claim: [], release: [] })
      for (const line of body.split('\n')) assert.doesNotMatch(line, /^\s*(🔒|🔓|#\d)/)
    }
  })

  test('helpers: branch extraction and age text', () => {
    assert.equal(branchOf('🔒 CLAIM #1 — branch `feat/x-y` — touches: a'), 'feat/x-y')
    assert.equal(branchOf('🔒 CLAIM #1 — branch feat/plain — x'), 'feat/plain')
    assert.equal(branchOf('🔒 CLAIM #1 — no branch named'), null)
    assert.equal(ageText('2026-09-15T11:35:36Z', NOW), '76 min ago')
    assert.equal(ageText('2026-09-15T10:00:00Z', NOW), '3 h ago')
    assert.equal(ageText('2026-09-12T13:00:00Z', NOW), '3 d ago')
  })

  test('holderClaim picks the NEWEST claim and only a release after it counts', () => {
    const c1 = { ...holderClaimLine, createdAt: '2026-09-14T09:00:00Z' }
    const r = { author: 'PhilipEriksson', body: '🔓 RELEASE #3005 — abandoned', createdAt: '2026-09-14T10:00:00Z', onIssue: CHANNEL_ISSUE }
    const c2 = { ...holderClaimLine, createdAt: '2026-09-15T11:44:00Z' }
    const h = holderClaim({ holder: 'PhilipEriksson', issue: 3005, comments: [c2, r, c1] })
    assert.equal(h.claim.createdAt, c2.createdAt)
    assert.equal(h.releasedAfter, false)
  })

  test('S1: a live claim by someone the field does NOT name is still a holder (concurrent claims, non-assignable author)', () => {
    // Two sessions post within seconds: both runs read assignees: [] before
    // either --add-assignee lands. The comment is already there, so it decides.
    const d = decideClaim({ ...base, assignees: [], comments: [holderClaimLine] })
    assert.equal(d.action, 'refuse')
    assert.match(d.reply.body, /held by @PhilipEriksson/)
  })

  test('S1 guard: a drive-by claim by a NON-collaborator on the public channel makes no holder', () => {
    // The channel is public. Without this, anyone could post `🔒 CLAIM #N` there and
    // get every real claim of #N refused.
    const driveBy = { ...holderClaimLine, author: 'stranger', authorAssociation: 'NONE' }
    assert.equal(decideClaim({ ...base, assignees: [], comments: [driveBy] }).action, 'accept')
    const firstTimer = { ...holderClaimLine, author: 'newbie', authorAssociation: 'FIRST_TIME_CONTRIBUTOR' }
    assert.equal(decideClaim({ ...base, assignees: [], comments: [firstTimer] }).action, 'accept')
    // …but the same stranger, once ASSIGNED by a maintainer, is a holder through the field.
    assert.equal(decideClaim({ ...base, assignees: ['stranger'], comments: [driveBy] }).action, 'refuse')
    assert.deepEqual([...TRUSTED_ASSOCIATIONS].sort(), ['COLLABORATOR', 'MEMBER', 'OWNER'])
  })

  test('every decision carries the issue number (the step summary prints it)', () => {
    for (const c of [
      decideClaim({ ...base, comments: [holderClaimLine] }),
      decideClaim({ ...base, comments: [] }),
      decideClaim({ ...base, state: 'closed', comments: [] }),
      decideClaim({ ...base, comments: [{ ...holderClaimLine, createdAt: '2026-09-12T12:51:40Z' }] }),
    ]) assert.equal(c.issue, 3005)
  })

  test('a bot comment quoting the claim format is never a holder', () => {
    const bot = { ...holderClaimLine, author: 'github-actions[bot]', authorType: 'Bot', authorAssociation: 'MEMBER', body: '🔒 CLAIM #3005 — example of the format' }
    assert.equal(decideClaim({ ...base, assignees: [], comments: [bot] }).action, 'accept')
  })

  test('logins compare case-insensitively (GitHub logins are)', () => {
    assert.ok(sameLogin('PhilipEriksson', 'philiperiksson'))
    const d = decideClaim({ ...base, claimant: 'philiperiksson', assignees: ['PhilipEriksson'], comments: [holderClaimLine] })
    assert.equal(d.action, 'accept', 'own re-claim under a different casing')
  })

  test('S-c: a mention inside a quote or a code fence is not activity; a plain line is', () => {
    assert.equal(mentionsIssue('> unrelated quote mentioning #3005', 3005), false)
    assert.equal(mentionsIssue('```\n🔒 CLAIM #3005 — example\n```', 3005), false)
    assert.equal(mentionsIssue('Morning report: open work #3001 #3005 #3010', 3005), true)
    assert.equal(mentionsIssue('see #30050', 3005), false)
    assert.equal(mentionsIssue('https://example.com/x/#3005', 3005), false)
    const old = { ...holderClaimLine, createdAt: '2026-09-12T12:51:40Z' }
    const quotedRecent = { author: 'PhilipEriksson', body: '> someone wrote about #3005', createdAt: '2026-09-15T10:51:40Z', onIssue: CHANNEL_ISSUE }
    assert.equal(decideClaim({ ...base, comments: [old, quotedRecent] }).action, 'takeover')
  })

  test('dead heat: a holder whose claim is NEWER than the incoming one does not block it — the older claim wins', () => {
    // Both runs see each other's comment ~20 s after their triggers. Antonio
    // claimed at 12:00:00, Philip at 12:00:05: Antonio's run must accept,
    // Philip's must refuse and name Antonio.
    const antonio = { author: 'AntonioSaaranen', body: '🔒 CLAIM #3200 — branch `feat/3200-a`', createdAt: '2026-09-20T12:00:00Z', onIssue: CHANNEL_ISSUE, authorAssociation: 'COLLABORATOR' }
    const philip = { author: 'PhilipEriksson', body: '🔒 CLAIM #3200 — branch `feat/3200-p`', createdAt: '2026-09-20T12:00:05Z', onIssue: CHANNEL_ISSUE, authorAssociation: 'COLLABORATOR' }
    const now = Date.parse('2026-09-20T12:00:30Z')
    const common = { issue: 3200, state: 'open', assignees: [], comments: [antonio, philip], postedOn: CHANNEL_ISSUE, nowMs: now }
    const a = decideClaim({ ...common, claimant: 'AntonioSaaranen', claimedAt: antonio.createdAt })
    const p = decideClaim({ ...common, claimant: 'PhilipEriksson', claimedAt: philip.createdAt })
    assert.equal(a.action, 'accept')
    assert.equal(p.action, 'refuse')
    assert.match(p.reply.body, /held by @AntonioSaaranen/)
    // Same second: the lexically smaller login wins, so both runs agree.
    const tie = { ...philip, createdAt: antonio.createdAt }
    const a2 = decideClaim({ ...common, comments: [antonio, tie], claimant: 'AntonioSaaranen', claimedAt: antonio.createdAt })
    const p2 = decideClaim({ ...common, comments: [antonio, tie], claimant: 'PhilipEriksson', claimedAt: tie.createdAt })
    assert.equal(a2.action, 'accept')
    assert.equal(p2.action, 'refuse')
    // Without the incoming timestamp (older callers), nothing changes: refuse.
    assert.equal(decideClaim({ ...common, claimant: 'AntonioSaaranen' }).action, 'refuse')
  })

  test('the tie-break uses the holder\'s FIRST claim in force: a re-claim or channel copy does not make them "newer"', () => {
    // Antonio claimed at 12:00:00 (issue) and mirrored to the channel at 12:00:20;
    // Philip claimed at 12:00:05. Antonio's hold began first and must win even
    // though his NEWEST claim is later than Philip's.
    const a1 = { author: 'AntonioSaaranen', body: '🔒 CLAIM #3200 — branch `feat/3200-a`', createdAt: '2026-09-20T12:00:00Z', onIssue: 3200, authorAssociation: 'COLLABORATOR' }
    const a2 = { ...a1, createdAt: '2026-09-20T12:00:20Z', onIssue: CHANNEL_ISSUE }
    const p = { author: 'PhilipEriksson', body: '🔒 CLAIM #3200 — branch `feat/3200-p`', createdAt: '2026-09-20T12:00:05Z', onIssue: CHANNEL_ISSUE, authorAssociation: 'COLLABORATOR' }
    const now = Date.parse('2026-09-20T12:01:00Z')
    const common = { issue: 3200, state: 'open', assignees: [], comments: [a1, p, a2], postedOn: CHANNEL_ISSUE, nowMs: now }
    assert.equal(decideClaim({ ...common, claimant: 'PhilipEriksson', claimedAt: p.createdAt }).action, 'refuse')
    assert.equal(decideClaim({ ...common, claimant: 'AntonioSaaranen', claimedAt: a2.createdAt }).action, 'refuse', 'the incoming copy is later than Philip — but see the gate, which passes the hold start')
    // The refusal reply ages Antonio's HOLD (12:00:00, on the issue), not his
    // mirror, and appends no "last active" clause for a mere mirror.
    const reply = decideClaim({ ...common, claimant: 'PhilipEriksson', claimedAt: p.createdAt }).reply.body
    assert.match(reply, /@AntonioSaaranen claimed it 1 min ago on this issue/)
    assert.doesNotMatch(reply, /last active on it/)
    // …and a release RESTARTS the hold: claim, release, re-claim → first claim is the re-claim.
    const rel = { author: 'AntonioSaaranen', body: '🔓 RELEASE #3200 — abandoned', createdAt: '2026-09-20T12:00:02Z', onIssue: 3200 }
    const h = holderClaim({ holder: 'AntonioSaaranen', issue: 3200, comments: [a1, rel, a2] })
    assert.equal(h.firstClaim.createdAt, a2.createdAt)
    assert.equal(h.releasedAfter, false)
  })

  test('S2: staleness is measured from the holder\'s LAST ACTIVITY about the issue, not the claim', () => {
    // Claimed 3 days ago, but commented on the issue thread 2 h ago: live.
    const old = { ...holderClaimLine, createdAt: '2026-09-12T12:51:40Z' }
    const recentOnIssue = { author: 'PhilipEriksson', body: 'review round 3 pushed', createdAt: '2026-09-15T10:51:40Z', onIssue: 3005 }
    const d = decideClaim({ ...base, comments: [old, recentOnIssue] })
    assert.equal(d.action, 'refuse')
    assert.match(d.reply.body, new RegExp(`claimed it 3 d ago on #${CHANNEL_ISSUE} .* last active on it 2 h ago`))
    // …a recent comment on the CHANNEL counts only if it names the issue.
    const recentOnChannelNaming = { author: 'PhilipEriksson', body: '📣 FYI — #3005 waits on CODEOWNERS', createdAt: '2026-09-15T10:51:40Z', onIssue: CHANNEL_ISSUE }
    assert.equal(decideClaim({ ...base, comments: [old, recentOnChannelNaming] }).action, 'refuse')
    const recentOnChannelOther = { author: 'PhilipEriksson', body: '🔒 CLAIM #3010 — branch `x/y`', createdAt: '2026-09-15T10:51:40Z', onIssue: CHANNEL_ISSUE }
    assert.equal(decideClaim({ ...base, comments: [old, recentOnChannelOther] }).action, 'takeover')
  })

  test('S3: the constant IS 24 hours, pinned absolutely and with literal timestamps', () => {
    assert.equal(LIVE_CLAIM_MS, 24 * 60 * 60 * 1000)
    const now = Date.parse('2026-09-16T12:00:00Z')
    const at = (iso) => ({ ...holderClaimLine, createdAt: iso })
    assert.equal(decideClaim({ ...base, nowMs: now, comments: [at('2026-09-15T12:01:00Z')] }).action, 'refuse')   // 23 h 59 m
    assert.equal(decideClaim({ ...base, nowMs: now, comments: [at('2026-09-15T11:59:00Z')] }).action, 'takeover') // 24 h 01 m
  })

  test('S4: an unreadable timestamp is LIVE (refuse), never a takeover', () => {
    const d = decideClaim({ ...base, comments: [{ ...holderClaimLine, createdAt: 'not-a-date' }] })
    assert.equal(d.action, 'refuse')
    assert.match(d.reply.body, /claimed it just now/)
  })
})

describe('collision fetch and apply through an injected gh (#3178)', () => {
  const recorder = (answers = {}) => {
    const calls = []
    const gh = async (args, opts = {}) => {
      calls.push({ args, input: opts.input ?? null })
      if (args[0] === 'api' && args.includes('--paginate')) {
        const n = Number(args[args.length - 1].match(/issues\/(\d+)\//)[1])
        return JSON.stringify([answers.comments?.(n) ?? []])
      }
      if (args[0] === 'api' && /^repos\/[^/]+\/[^/]+\/issues\/\d+$/.test(args[1])) return JSON.stringify(answers.issue ?? { state: 'open', assignees: [] })
      if (answers.refuse?.(args)) throw new Error('HTTP 403')
      return ''
    }
    return { gh, calls }
  }

  test('fetchClaimState reads the issue, its comments and the channel, tagging where each comment was posted', async () => {
    const { gh, calls } = recorder({
      issue: { state: 'open', assignees: [{ login: 'AntonioSaaranen' }] },
      comments: (n) => (n === CHANNEL_ISSUE ? [{ user: { login: 'AntonioSaaranen' }, author_association: 'OWNER', body: '🔒 CLAIM #3005 — x', created_at: '2026-09-15T11:44:00Z' }] : [{ user: { login: 'd-hinders' }, body: 'hi', created_at: '2026-09-15T09:00:00Z' }]),
    })
    const r = await fetchClaimState({ gh, repo: 'o/r', issue: 3005 })
    assert.equal(r.state, 'open')
    assert.deepEqual(r.assignees, ['AntonioSaaranen'])
    assert.deepEqual(r.comments.map((c) => [c.author, c.onIssue, c.authorAssociation, c.authorType]), [['d-hinders', 3005, 'NONE', 'User'], ['AntonioSaaranen', CHANNEL_ISSUE, 'OWNER', 'User']])
    assert.equal(calls.filter((c) => c.args.includes('--paginate')).length, 2)
  })

  test('a closed issue reads no comments at all', async () => {
    const { gh, calls } = recorder({ issue: { state: 'closed', assignees: [] } })
    const r = await fetchClaimState({ gh, repo: 'o/r', issue: 3005 })
    assert.equal(r.state, 'closed')
    assert.equal(calls.length, 1)
  })

  test('applyClaim: refuse posts the reply via stdin and touches no assignee', async () => {
    const d = { action: 'refuse', reply: { issue: CHANNEL_ISSUE, body: '⚠️ Already claimed: …' } }
    const { gh, calls } = recorder()
    const done = await applyClaim(d, { gh, repo: 'o/r', issue: 3005, log: () => {} })
    assert.deepEqual(calls.map((c) => c.args.slice(0, 3)), [['issue', 'comment', String(CHANNEL_ISSUE)]])
    assert.equal(calls[0].input, '⚠️ Already claimed: …')
    assert.deepEqual(done.map((x) => x.kind), ['reply'])
  })

  test('applyClaim: takeover unassigns first, then assigns, then replies; a refused write is logged and the rest proceed', async () => {
    const d = { action: 'takeover', assign: 'PhilipEriksson', unassign: ['AntonioSaaranen'], reply: { issue: 3005, body: 'ℹ️ Taken over: …' } }
    const logs = []
    const { gh, calls } = recorder({ refuse: (args) => args.includes('--remove-assignee') })
    const done = await applyClaim(d, { gh, repo: 'o/r', issue: 3005, log: (m) => logs.push(m) })
    assert.deepEqual(calls.map((c) => c.args.slice(0, 3)), [['issue', 'edit', '3005'], ['issue', 'edit', '3005'], ['issue', 'comment', '3005']])
    assert.deepEqual(done.map((x) => x.kind), ['assign', 'reply'])
    assert.ok(logs.some((l) => /could not unassign/.test(l)))
  })

  test('applyClaim: accept assigns only', async () => {
    const { gh, calls } = recorder()
    await applyClaim({ action: 'accept', assign: 'x' }, { gh, repo: 'o/r', issue: 1, log: () => {} })
    assert.deepEqual(calls.map((c) => c.args.slice(0, 3)), [['issue', 'edit', '1']])
    assert.ok(calls[0].args.includes('--add-assignee'))
  })
})

describe('claim-collision CLI end to end, with a stub gh on PATH (#3178)', () => {
  const CLI2 = fileURLToPath(new URL('./claim-collision.mjs', import.meta.url))
  const dir = mkdtempSync(path.join(tmpdir(), 'claim-collision-cli-'))
  // A `gh` that answers: the issue (open, assignee Philip), the issue's
  // comments (none), the channel's comments (Philip's claim), and records
  // every write to a file instead of GitHub.
  const ghStub = path.join(dir, 'gh')
  // The CLI uses the real clock, so the stub's claim must be recent to be LIVE.
  const recent = new Date(Date.now() - 60_000).toISOString()
  writeFileSync(ghStub, `#!/bin/sh
case "$*" in
  *"issues/3005/comments"*) echo '[[]]' ;;
  *"issues/${CHANNEL_ISSUE}/comments"*) echo '[[{"user":{"login":"PhilipEriksson"},"author_association":"COLLABORATOR","body":"🔒 CLAIM #3005 — branch \`feat/3005-x\`","created_at":"${recent}"}]]' ;;
  *"issues/3005"*) echo '{"state":"open","assignees":[{"login":"PhilipEriksson"}]}' ;;
  *) echo "$*" >> "${dir}/writes.txt"; cat >/dev/null; echo '' ;;
esac
`)
  execFileSync('chmod', ['+x', ghStub])
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, GITHUB_REPOSITORY: 'o/r' }

  const writesFile = path.join(dir, 'writes.txt')
  const writesNow = () => { try { return execFileSync('cat', [writesFile], { encoding: 'utf8' }).trim().split('\n').filter(Boolean) } catch { return [] } }

  test('dry run prints exactly one JSON line and writes nothing', () => {
    const before = writesNow().length
    const out = execFileSync(process.execPath, [CLI2, '--issue', '3005', '--claimant', 'AntonioSaaranen', '--posted-on', String(CHANNEL_ISSUE)], { encoding: 'utf8', env })
    const lines = out.trim().split('\n').filter((l) => l.startsWith('{'))
    assert.equal(lines.length, 1)
    const d = JSON.parse(lines[0])
    assert.equal(d.action, 'refuse')
    assert.equal(d.issue, 3005)
    assert.equal(d.reply.issue, CHANNEL_ISSUE)
    // Order-independent: the write count is unchanged by a dry run.
    assert.equal(writesNow().length, before)
  })

  test('--apply posts the reply through gh (stdin body) and touches no assignee', () => {
    const before = writesNow().length
    execFileSync(process.execPath, [CLI2, '--issue', '3005', '--claimant', 'AntonioSaaranen', '--posted-on', String(CHANNEL_ISSUE), '--apply'], { encoding: 'utf8', env })
    assert.deepEqual(writesNow().slice(before), [`issue comment ${CHANNEL_ISSUE} --repo o/r -F -`])
  })

  test('a failed read (no gh on PATH) logs, prints no JSON, exits 0', () => {
    const out = execFileSync(process.execPath, [CLI2, '--issue', '3005', '--claimant', 'x', '--posted-on', '3005', '--apply'], { encoding: 'utf8', env: { ...process.env, PATH: '' } })
    assert.match(out, /could not read #3005 or the channel — claim not projected/)
    assert.ok(!out.split('\n').some((l) => l.startsWith('{')))
  })

  test('a malformed claimant login exits 2 before touching gh', () => {
    assert.throws(() => execFileSync(process.execPath, [CLI2, '--issue', '3005', '--claimant', 'bad login;rm', '--posted-on', '3005'], { stdio: 'pipe', env }), (e) => e.status === 2)
  })
})
