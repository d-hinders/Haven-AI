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
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from './claim-assignee.mjs'
import { decideClaim, holderClaim, branchOf, ageText, fetchClaimState, applyClaim, LIVE_CLAIM_MS } from './claim-collision.mjs'

const CLI = fileURLToPath(new URL('./claim-assignee.mjs', import.meta.url))

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
      // deepEqual, not includes: two of these lines name the PR that carried
      // the work, and the whole point of dropping `PR #n` is that the PR number
      // must NOT also be released. `includes` would pass either way.
      assert.deepEqual(r.release, [expected], `got ${JSON.stringify(r)}`)
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

describe('a quoted claim is reported, never made', () => {
  // GitHub's "Quote reply" button emits `> 🔒 CLAIM …`, so this is the DEFAULT
  // way one session repeats another's claim. Taking it as a claim would assign
  // the quoter — and since assignment ADDS, the real owner's later RELEASE
  // removes only the owner, stranding the quoter on the issue with nothing in
  // the thread to explain it.
  test('a quote-reply of a claim assigns nobody', () => {
    const r = on1289('> 🔒 CLAIM #2970 — branch `feat/2970-settled-verified`\n\nThanks, standing down.')
    assert.deepEqual(r.claim, [])
    assert.deepEqual(r.release, [])
  })

  test('a nested quote too', () => {
    assert.deepEqual(on1289('>> 🔒 CLAIM #2970').claim, [])
  })

  test('a quoted RELEASE is ignored as well', () => {
    assert.deepEqual(on1289('> 🔓 RELEASE #2968 — landed').release, [])
  })

  test('an unquoted claim below a quoted one still registers', () => {
    const r = on1289('> 🔒 CLAIM #2970 — theirs\n\n🔒 CLAIM #2999 — branch `feat/2999-x`')
    assert.deepEqual(r.claim, [2999])
  })
})

describe('a marker inside a code fence is documentation, not a claim', () => {
  test('fenced claim assigns nobody', () => {
    const r = on1289('The format is:\n```\n🔒 CLAIM #2947 — branch `feat/x` — touches: …\n```\nPost that on the issue.')
    assert.deepEqual(r.claim, [])
  })

  test('a real claim after the fence closes still registers', () => {
    const r = on1289('Example:\n```\n🔒 CLAIM #1111 — sample\n```\n🔒 CLAIM #2947 — branch `feat/real`')
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
    for (const line of run(hostile, 1289).split('\n').filter(Boolean)) {
      assert.match(line, /^(claim|release)=\d{1,6}$/, `unsafe CLI line: ${JSON.stringify(line)}`)
    }
  })

  test('a comment with nothing to do prints nothing', () => {
    assert.equal(run('LGTM, nice work.', 1289), '')
  })

  test('output ends with a newline so the shell read loop sees the last line', () => {
    const out = run('🔒 CLAIM #2947 — branch x', 1289)
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

describe('a bot author is honoured for one shape only: the merge-time release (#3177)', () => {
  const bot = (body, onIssue = 3134) => parse({ body, onIssue, authorType: 'Bot' })
  const autoRelease = '🔓 RELEASE #3134 — landed as PR #3186 (squash `a29d5469`, into `dev`) — posted automatically on merge (#3177); nothing to release by hand.'

  test('the merge-time release names its PR and is honoured', () => {
    assert.deepEqual(bot(autoRelease), { claim: [], release: [3134] })
  })

  test('honoured on the channel too, releasing the issue named, never #1289', () => {
    assert.deepEqual(bot(autoRelease, 1289), { claim: [], release: [3134] })
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
  // The #3005 shape, 2026-09-15: Antonio claimed on #1289 at 11:44Z; Philip
  // claimed the same issue at 13:00Z (76 min later) with the same branch.
  const NOW = Date.parse('2026-09-15T13:00:00Z')
  const antonioClaim = { author: 'AntonioSaaranen', body: '🔒 CLAIM #3005 — branch `feat/3005-x` — touches: packages/backend/…', createdAt: '2026-09-15T11:44:00Z', onIssue: 1289 }
  const base = { issue: 3005, claimant: 'PhilipEriksson', state: 'open', assignees: ['AntonioSaaranen'], postedOn: 1289, nowMs: NOW }

  test('second claim within 24 h → refused with a reply naming the holder, the age, the branch, and that nothing was recorded', () => {
    const d = decideClaim({ ...base, comments: [antonioClaim] })
    assert.equal(d.action, 'refuse')
    assert.equal(d.assign, undefined)
    assert.equal(d.reply.issue, 1289)
    assert.match(d.reply.body, /^⚠️ Already claimed: issue 3005 is held by @AntonioSaaranen\./)
    assert.match(d.reply.body, /claimed it 76 min ago on #1289 \(branch `feat\/3005-x`\)/)
    assert.match(d.reply.body, /This claim by @PhilipEriksson was not recorded/)
  })

  test('the reply is posted where the claim was posted — on the issue itself when the claim was there', () => {
    const d = decideClaim({ ...base, postedOn: 3005, comments: [{ ...antonioClaim, onIssue: 3005 }] })
    assert.equal(d.reply.issue, 3005)
    assert.match(d.reply.body, /on this issue/)
  })

  test('same author re-claiming (branch rename) → accepted silently', () => {
    const d = decideClaim({ ...base, claimant: 'AntonioSaaranen', comments: [antonioClaim] })
    assert.deepEqual(d, { action: 'accept', assign: 'AntonioSaaranen', reason: 'nobody else holds it' })
  })

  test('stale claim (≥ 24 h, unreleased) → taken over: holder unassigned, claimant assigned, reply says so', () => {
    // #3178 acceptance mutation: drop the 24 h age check and this goes red.
    const old = { ...antonioClaim, createdAt: '2026-09-12T13:00:00Z' } // 3 d
    const d = decideClaim({ ...base, comments: [old] })
    assert.equal(d.action, 'takeover')
    assert.equal(d.assign, 'PhilipEriksson')
    assert.deepEqual(d.unassign, ['AntonioSaaranen'])
    assert.match(d.reply.body, /^ℹ️ Taken over: issue 3005 — @AntonioSaaranen's claim was 3 d ago with no RELEASE since/)
    assert.match(d.reply.body, /reassigned to @PhilipEriksson/)
  })

  test('exactly 24 h is stale; one minute less is live', () => {
    const at = (ms) => ({ ...antonioClaim, createdAt: new Date(NOW - ms).toISOString() })
    assert.equal(decideClaim({ ...base, comments: [at(LIVE_CLAIM_MS)] }).action, 'takeover')
    assert.equal(decideClaim({ ...base, comments: [at(LIVE_CLAIM_MS - 60_000)] }).action, 'refuse')
  })

  test('released claim → accepted (the holder said they dropped it, even if the projection missed it)', () => {
    const release = { author: 'AntonioSaaranen', body: '🔓 RELEASE #3005 — abandoned: picking #3010 instead', createdAt: '2026-09-15T12:30:00Z', onIssue: 1289 }
    const d = decideClaim({ ...base, comments: [antonioClaim, release] })
    assert.equal(d.action, 'accept')
    assert.equal(d.assign, 'PhilipEriksson')
  })

  test('a release BEFORE the claim does not count as releasing it', () => {
    const earlier = { author: 'AntonioSaaranen', body: '🔓 RELEASE #3005 — abandoned', createdAt: '2026-09-15T10:00:00Z', onIssue: 1289 }
    assert.equal(decideClaim({ ...base, comments: [earlier, antonioClaim] }).action, 'refuse')
  })

  test('an assignee with no claim comment (tracking) is not a claim in force → the claimant is added beside them, silently', () => {
    const d = decideClaim({ ...base, comments: [] })
    assert.equal(d.action, 'accept')
    assert.equal(d.assign, 'PhilipEriksson')
    assert.equal(d.reply, undefined)
  })

  test('a QUOTED claim by the holder is not their claim — reporting is not claiming', () => {
    const quoted = { ...antonioClaim, body: '> 🔒 CLAIM #3005 — branch `feat/3005-x`\n\nFYI: this is what Daniel posted.' }
    assert.equal(decideClaim({ ...base, comments: [quoted] }).action, 'accept')
  })

  test('a closed issue → skip, as before', () => {
    assert.equal(decideClaim({ ...base, state: 'closed', comments: [antonioClaim] }).action, 'skip')
  })

  test('two holders: one live, one stale → refused (live wins); both stale → both unassigned', () => {
    const daniel = { author: 'd-hinders', body: '🔒 CLAIM #3005 — branch `x`', createdAt: '2026-09-10T00:00:00Z', onIssue: 3005 }
    const mixed = decideClaim({ ...base, assignees: ['AntonioSaaranen', 'd-hinders'], comments: [antonioClaim, daniel] })
    assert.equal(mixed.action, 'refuse')
    const both = decideClaim({ ...base, assignees: ['AntonioSaaranen', 'd-hinders'], comments: [{ ...antonioClaim, createdAt: '2026-09-11T00:00:00Z' }, daniel] })
    assert.equal(both.action, 'takeover')
    assert.deepEqual(both.unassign.sort(), ['AntonioSaaranen', 'd-hinders'])
  })

  test('both replies are ignored by the parser — no marker at line start, #N never leads a line', () => {
    const refuse = decideClaim({ ...base, comments: [antonioClaim] }).reply.body
    const takeover = decideClaim({ ...base, comments: [{ ...antonioClaim, createdAt: '2026-09-12T13:00:00Z' }] }).reply.body
    for (const body of [refuse, takeover]) {
      assert.deepEqual(parse({ body, onIssue: 1289 }), { claim: [], release: [] })
      assert.deepEqual(parse({ body, onIssue: 3005 }), { claim: [], release: [] })
      assert.deepEqual(parse({ body, onIssue: 3005, authorType: 'Bot' }), { claim: [], release: [] })
      for (const line of body.split('\n')) assert.doesNotMatch(line, /^\s*(🔒|🔓|#\d)/)
    }
  })

  test('helpers: branch extraction and age text', () => {
    assert.equal(branchOf('🔒 CLAIM #1 — branch `feat/x-y` — touches: a'), 'feat/x-y')
    assert.equal(branchOf('🔒 CLAIM #1 — branch feat/plain — x'), 'feat/plain')
    assert.equal(branchOf('🔒 CLAIM #1 — no branch named'), null)
    assert.equal(ageText('2026-09-15T11:44:00Z', NOW), '76 min ago')
    assert.equal(ageText('2026-09-15T10:00:00Z', NOW), '3 h ago')
    assert.equal(ageText('2026-09-12T13:00:00Z', NOW), '3 d ago')
  })

  test('holderClaim picks the NEWEST claim and only a release after it counts', () => {
    const c1 = { ...antonioClaim, createdAt: '2026-09-14T09:00:00Z' }
    const r = { author: 'AntonioSaaranen', body: '🔓 RELEASE #3005 — abandoned', createdAt: '2026-09-14T10:00:00Z', onIssue: 1289 }
    const c2 = { ...antonioClaim, createdAt: '2026-09-15T11:44:00Z' }
    const h = holderClaim({ holder: 'AntonioSaaranen', issue: 3005, comments: [c2, r, c1] })
    assert.equal(h.claim.createdAt, c2.createdAt)
    assert.equal(h.releasedAfter, false)
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
      comments: (n) => (n === 1289 ? [{ user: { login: 'AntonioSaaranen' }, body: '🔒 CLAIM #3005 — x', created_at: '2026-09-15T11:44:00Z' }] : [{ user: { login: 'd-hinders' }, body: 'hi', created_at: '2026-09-15T09:00:00Z' }]),
    })
    const r = await fetchClaimState({ gh, repo: 'o/r', issue: 3005 })
    assert.equal(r.state, 'open')
    assert.deepEqual(r.assignees, ['AntonioSaaranen'])
    assert.deepEqual(r.comments.map((c) => [c.author, c.onIssue]), [['d-hinders', 3005], ['AntonioSaaranen', 1289]])
    assert.equal(calls.filter((c) => c.args.includes('--paginate')).length, 2)
  })

  test('a closed issue reads no comments at all', async () => {
    const { gh, calls } = recorder({ issue: { state: 'closed', assignees: [] } })
    const r = await fetchClaimState({ gh, repo: 'o/r', issue: 3005 })
    assert.equal(r.state, 'closed')
    assert.equal(calls.length, 1)
  })

  test('applyClaim: refuse posts the reply via stdin and touches no assignee', async () => {
    const d = { action: 'refuse', reply: { issue: 1289, body: '⚠️ Already claimed: …' } }
    const { gh, calls } = recorder()
    const done = await applyClaim(d, { gh, repo: 'o/r', issue: 3005, log: () => {} })
    assert.deepEqual(calls.map((c) => c.args.slice(0, 3)), [['issue', 'comment', '1289']])
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
