// Tests for the merge-time release decision (`release-on-merge.mjs`, #3177).
// Run with: node --test scripts/ci/release-on-merge.test.mjs
// (also collected by the `ci_config_checks` job's `scripts/ci/*.test.mjs` glob)

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { decide, apply, fetchInputs, fetchCandidates, fetchChannel, prFromPayload, AUTO_RELEASE_MARK, CLOSE_WINDOW_MS, decideRefs, decideClose, claimsToRelease, refsReleaseLine, closeReleaseLine, prepareMerge, applyMerge, prepareClose, applyPerClaimant, fetchRefsInputs, closerFromTimeline, closeDeferral, CLOSE_EVENT_TOLERANCE_MS, EPIC_LABEL } from './release-on-merge.mjs'
import { parse, botReleaseClaimants } from './claim-assignee.mjs'
import { parseRefsRefs } from './operator-verify-close-guard.mjs'
import { readFileSync } from 'node:fs'
import { CHANNEL_ISSUE } from './coordination-channel.mjs'

const CLI = fileURLToPath(new URL('./release-on-merge.mjs', import.meta.url))

const MERGED_AT = '2026-09-20T01:26:29Z'
const mergedPr = { number: 3186, merged: true, mergedAt: MERGED_AT, author: 'AntonioSaaranen', mergeCommit: 'a29d5469abcdef0123456789', base: 'dev', defaultBranch: 'dev' }
/** A candidate as the workflow reads it back: closed one second after the merge. */
const closedByMerge = (number, assignees = []) => ({ number, assignees, state: 'closed', closedAt: '2026-09-20T01:26:30Z' })

describe('the merged filter is the whole safety of this workflow', () => {
  test('a closed-but-unmerged PR releases nothing and unassigns nobody', () => {
    // #3177 acceptance mutation: remove the `merged !== true` return and this
    // goes red. A PR closed without merging did NOT finish the work — its
    // claim is still live, and releasing it would hand the issue to whoever
    // reads next.
    const r = decide({ pr: { ...mergedPr, merged: false }, closingIssues: [closedByMerge(3134, ['AntonioSaaranen'])] })
    assert.deepEqual(r, { releases: [], channel: null, skipped: [] })
  })

  test('a missing merged flag is treated as unmerged, never as merged', () => {
    const { merged, ...noFlag } = mergedPr
    assert.deepEqual(decide({ pr: noFlag, closingIssues: [closedByMerge(3134)] }), { releases: [], channel: null, skipped: [] })
  })

  test('a PR that closes no issue does nothing', () => {
    assert.deepEqual(decide({ pr: mergedPr, closingIssues: [] }), { releases: [], channel: null, skipped: [] })
  })
})

describe('what a merge releases', () => {
  test('one release per closed issue, naming the PR, and unassigning everyone left on it', () => {
    const r = decide({
      pr: mergedPr,
      closingIssues: [closedByMerge(3134, ['PhilipEriksson']), closedByMerge(3135)],
    })
    assert.equal(r.releases.length, 2)
    const [a, b] = r.releases
    assert.equal(a.issue, 3134)
    // No merge-method word: a promotion into main merges with a merge commit,
    // and the event does not say which method was used.
    assert.match(a.body, /^🔓 RELEASE #3134 — landed as PR #3186 \(`a29d5469`, into `dev`\)/)
    assert.doesNotMatch(a.body, /squash|merge commit/)
    assert.ok(a.body.includes(AUTO_RELEASE_MARK))
    // The PR author is unassigned even when the projection never assigned them,
    // and a second session's stale assignee goes too: no claim on a closed
    // issue is live.
    assert.deepEqual(a.unassign, ['PhilipEriksson', 'AntonioSaaranen'])
    assert.deepEqual(b.unassign, ['AntonioSaaranen'])
  })

  test('the release line is one the projection parser reads as a release of exactly that issue', () => {
    // The bot's comment lands on the issue and `claim-assignee.yml` parses it.
    // The `PR #3186` reference must not be read as a second issue.
    const [r] = decide({ pr: mergedPr, closingIssues: [closedByMerge(3134)] }).releases
    assert.deepEqual(parse({ body: r.body, onIssue: 3134 }), { claim: [], release: [3134] })
  })

  test('the coordination thread itself is never released, even if GitHub lists it', () => {
    const r = decide({ pr: mergedPr, closingIssues: [closedByMerge(CHANNEL_ISSUE), closedByMerge(3134)] })
    assert.deepEqual(r.releases.map((x) => x.issue), [3134])
  })

  test('duplicates and malformed numbers are dropped', () => {
    const r = decide({ pr: mergedPr, closingIssues: [closedByMerge(3134), closedByMerge(3134), { number: 'x' }, { number: -1 }] })
    assert.deepEqual(r.releases.map((x) => x.issue), [3134])
  })

  test('a non-hex merge sha or missing base degrades the parenthesis, not the release', () => {
    const [r] = decide({ pr: { ...mergedPr, mergeCommit: null, base: null, defaultBranch: null }, closingIssues: [closedByMerge(3134)] }).releases
    assert.match(r.body, /^🔓 RELEASE #3134 — landed as PR #3186 — /)
  })
})

describe('released only when GitHub closed it BY THIS MERGE', () => {
  test('a candidate still open is skipped with a reason, not released', () => {
    // The commit said `Closes #3140` inside a code span: GitHub left it open,
    // so its claim is live.
    const r = decide({ pr: mergedPr, closingIssues: [closedByMerge(3134), { number: 3140, assignees: ['PhilipEriksson'], state: 'open', closedAt: null }] })
    assert.deepEqual(r.releases.map((x) => x.issue), [3134])
    assert.equal(r.skipped.length, 1)
    assert.equal(r.skipped[0].issue, 3140)
    assert.match(r.skipped[0].reason, /reports it open now/)
  })

  test('an issue closed BEFORE this merge — merely mentioned — is skipped (the #3187 self-test)', () => {
    // PR #3187's own body prose linked #2268, closed 2026-09-02 by a person.
    // GitHub's merge is a no-op on it; releasing it would post a false line on
    // the issue and on the channel (#1289 at the time).
    const r = decide({ pr: mergedPr, closingIssues: [{ number: 2268, assignees: ['d-hinders'], state: 'closed', closedAt: '2026-09-02T10:13:48Z' }, closedByMerge(3177)] })
    assert.deepEqual(r.releases.map((x) => x.issue), [3177])
    assert.equal(r.skipped[0].issue, 2268)
    assert.match(r.skipped[0].reason, /outside this merge's window/)
  })

  test('the window opens AT the merge: closed_at a moment before merged_at is not this merge', () => {
    // Measured 2026-09-20 on 83 pairs over the last 100 merges into dev (see
    // the module header): GitHub stamps the close +1…+2 s AFTER the merge,
    // never before. An issue a person closed 49 s earlier is theirs.
    const r = decide({ pr: mergedPr, closingIssues: [{ number: 3134, assignees: [], state: 'closed', closedAt: '2026-09-20T01:25:40Z' }] })
    assert.deepEqual(r.releases, [])
    assert.match(r.skipped[0].reason, /outside this merge's window/)
  })

  test('the window is bounded above: re-closed by hand later is not this merge (the #2314 → #2268 reopen)', () => {
    // #2314 merged 19:03:57; the merge closed #2268 at +1 s; a person reopened
    // it at +13 min and closed it by hand two days later. That later close is
    // what `closed_at` reports, and it must not read as this merge's.
    const later = new Date(Date.parse(MERGED_AT) + CLOSE_WINDOW_MS + 1000).toISOString()
    const r = decide({ pr: mergedPr, closingIssues: [{ number: 2268, assignees: [], state: 'closed', closedAt: later }] })
    assert.deepEqual(r.releases, [])
    assert.match(r.skipped[0].reason, /outside this merge's window/)
    // …while a slow close event four minutes after the merge is still this merge.
    const slow = new Date(Date.parse(MERGED_AT) + 4 * 60_000).toISOString()
    assert.deepEqual(decide({ pr: mergedPr, closingIssues: [{ number: 3134, assignees: [], state: 'closed', closedAt: slow }] }).releases.map((x) => x.issue), [3134])
  })

  test('a candidate that is a pull request is skipped — the issues API answers for PRs too', () => {
    const r = decide({ pr: mergedPr, closingIssues: [{ ...closedByMerge(3186), isPullRequest: true }, closedByMerge(3134)] })
    assert.deepEqual(r.releases.map((x) => x.issue), [3134])
    assert.match(r.skipped[0].reason, /is a pull request/)
  })

  test('reopened since the merge reads as open and is left alone, with a reason that admits both causes', () => {
    const r = decide({ pr: mergedPr, closingIssues: [{ number: 3134, assignees: [], state: 'open', closedAt: null }] })
    assert.match(r.skipped[0].reason, /not closed by this merge, or reopened since/)
  })

  test('a candidate with no read-back state is skipped, never released on trust', () => {
    const r = decide({ pr: mergedPr, closingIssues: [{ number: 3134, assignees: ['AntonioSaaranen'] }] })
    assert.deepEqual(r.releases, [])
    assert.match(r.skipped[0].reason, /no state read back/)
  })

  test('an unreadable candidate (not an issue here) is skipped and the rest still release', () => {
    const r = decide({ pr: mergedPr, closingIssues: [{ number: 9999, unreadable: true }, closedByMerge(3134)] })
    assert.deepEqual(r.releases.map((x) => x.issue), [3134])
    assert.match(r.skipped[0].reason, /could not be read/)
  })

  test('a merge into a non-default branch (a promotion) releases nothing, linked or scanned', () => {
    const r = decide({ pr: { ...mergedPr, base: 'main' }, closingIssues: [closedByMerge(42, ['someone'])] })
    assert.deepEqual(r, { releases: [], channel: null, skipped: [] })
  })

  test('a bot PR author (dependabot) is never in the unassign list', () => {
    const [r] = decide({ pr: { ...mergedPr, author: 'dependabot[bot]', authorType: 'Bot' }, closingIssues: [closedByMerge(3134, ['AntonioSaaranen'])] }).releases
    assert.deepEqual(r.unassign, ['AntonioSaaranen'])
  })
})

describe('the channel copy is posted only where the claim was', () => {
  const claimOnChannel = '🔒 CLAIM #3134 — epic #3130 slice 4/4 — branch `feat/3134-vocabulary-converge` — Antonio'

  test('a claim on the channel earns the channel its release', () => {
    const r = decide({ pr: mergedPr, closingIssues: [closedByMerge(3134)], channelBodies: ['📣 FYI — promotion tonight', claimOnChannel] })
    assert.ok(r.channel)
    assert.match(r.channel.body, /^🔓 RELEASE #3134 — landed as PR #3186/)
  })

  test('an issue-only claim posts nothing to the channel', () => {
    const r = decide({ pr: mergedPr, closingIssues: [closedByMerge(3134)], channelBodies: ['🔒 CLAIM #2999 — something else'] })
    assert.equal(r.channel, null)
    assert.equal(r.releases.length, 1)
  })

  test('a QUOTED claim on the channel is a report, not a claim — no channel copy', () => {
    const r = decide({ pr: mergedPr, closingIssues: [closedByMerge(3134)], channelBodies: [`> ${claimOnChannel}`] })
    assert.equal(r.channel, null)
  })

  test('a claim of a different issue that merely MENTIONS ours does not count', () => {
    // Leading-run rule: only #3120 is claimed here.
    const r = decide({ pr: mergedPr, closingIssues: [closedByMerge(3134)], channelBodies: ['🔒 CLAIM #3120 — follows #3134'] })
    assert.equal(r.channel, null)
  })

  test('two closed issues, one claimed on the channel — the channel gets one line', () => {
    const r = decide({ pr: mergedPr, closingIssues: [closedByMerge(3134), closedByMerge(3135)], channelBodies: [claimOnChannel] })
    assert.equal(r.channel.body.split('\n').length, 1)
    assert.match(r.channel.body, /#3134/)
  })
})

describe('CLI contract the workflow depends on', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'release-on-merge-'))
  const write = (name, obj) => {
    const p = path.join(dir, name)
    writeFileSync(p, JSON.stringify(obj))
    return p
  }
  const event = { number: 3186, merged: true, merged_at: MERGED_AT, merge_commit_sha: 'a29d5469abcdef', user: { login: 'AntonioSaaranen' }, base: { ref: 'dev' } }
  const closing = [{ number: 3134, state: 'closed', closed_at: '2026-09-20T01:26:30Z', assignees: [{ login: 'AntonioSaaranen' }] }]

  test('prints one JSON document the shell can jq', () => {
    const out = execFileSync(process.execPath, [CLI, '--pr', write('pr.json', event), '--closing', write('c.json', closing), '--channel', write('ch.json', [{ body: '🔒 CLAIM #3134 — x', user: { login: 'AntonioSaaranen' } }])], { encoding: 'utf8' })
    const doc = JSON.parse(out)
    assert.equal(doc.releases.length, 1)
    assert.deepEqual(doc.releases[0].unassign, ['AntonioSaaranen'])
    assert.ok(doc.channel)
    assert.ok(out.endsWith('\n'))
  })

  test('an unmerged event payload prints the empty decision', () => {
    const out = execFileSync(process.execPath, [CLI, '--pr', write('pr2.json', { ...event, merged: false }), '--closing', write('c2.json', closing)], { encoding: 'utf8' })
    assert.deepEqual(JSON.parse(out), { releases: [], channel: null, skipped: [] })
  })

  test('missing inputs exit 2', () => {
    assert.throws(() => execFileSync(process.execPath, [CLI, '--pr', write('pr3.json', event)], { stdio: 'pipe' }), (e) => e.status === 2)
  })
})

describe('fetch and apply through an injected gh', () => {
  const recorder = (answers = {}) => {
    const calls = []
    const gh = async (args, opts = {}) => {
      calls.push({ args, input: opts.input ?? null })
      if (args[0] === 'api' && args[1] === 'graphql') {
        const query = args.find((a) => a.startsWith('query=')) ?? ''
        if (/closingIssuesReferences/.test(query)) return JSON.stringify({ title: answers.title ?? 't', closingIssuesReferences: { nodes: answers.closing ?? [] } })
        if (/commits\(/.test(query)) {
          const pages = answers.commitPages ?? [[]]
          const idx = args.includes('-F') && args.some((a) => a.startsWith('cursor=')) ? Number(args.find((a) => a.startsWith('cursor=')).slice(7)) : 0
          const page = pages[idx] ?? []
          return JSON.stringify({ nodes: page.map((m) => ({ commit: { oid: 'abc', message: m } })), pageInfo: { hasNextPage: idx + 1 < pages.length, endCursor: String(idx + 1) } })
        }
      }
      if (args[0] === 'api' && args.includes('--paginate')) {
        const url = args[args.length - 1]
        if (new RegExp(`/issues/${CHANNEL_ISSUE}/comments`).test(url)) return JSON.stringify(answers.channelPages ?? [[]])
        return JSON.stringify(answers.existingComments?.(Number(url.match(/issues\/(\d+)\//)[1])) ?? [[]])
      }
      if (args[0] === 'api' && /^repos\/[^/]+\/[^/]+\/issues\/\d+$/.test(args[1])) {
        const n = Number(args[1].split('/').pop())
        return JSON.stringify(answers.issue?.(n) ?? { state: 'closed', closed_at: '2026-09-20T01:26:30Z', assignees: [] })
      }
      if (answers.refuse?.(args)) throw new Error('HTTP 403')
      return ''
    }
    return { gh, calls }
  }

  test('fetchInputs reads GitHub\'s linked references, the commit/title scan, reads EVERY candidate back, and the WHOLE channel', async () => {
    const { gh, calls } = recorder({
      closing: [{ number: 3134 }],
      title: 'fix: x (Closes #3140)',
      commitPages: [['feat: a\n\nCloses #3134'], ['chore: b\n\nfixes #3141']],
      issue: (n) => {
        if (n === 3141) return { state: 'open', closed_at: null, assignees: [{ login: 'PhilipEriksson' }] }
        if (n === 3134) return { state: 'closed', closed_at: '2026-09-20T01:26:30Z', assignees: [{ login: 'AntonioSaaranen' }] }
        return { state: 'closed', closed_at: '2026-09-20T01:26:31Z', assignees: [] }
      },
      channelPages: [[{ body: 'older' }], [{ body: '🔒 CLAIM #3134 — x' }]],
    })
    const r = await fetchInputs({ gh, repo: 'd-hinders/Haven-AI', prNumber: 3186 })
    // Linked reference first, then the scan's finds — ALL read back with state and closed_at.
    assert.deepEqual(r.closingIssues, [
      { number: 3134, assignees: ['AntonioSaaranen'], state: 'closed', closedAt: '2026-09-20T01:26:30Z' },
      { number: 3140, assignees: [], state: 'closed', closedAt: '2026-09-20T01:26:31Z' },
      { number: 3141, assignees: ['PhilipEriksson'], state: 'open', closedAt: null },
    ])
    assert.deepEqual(r.channelBodies, ['older', '🔒 CLAIM #3134 — x'])
    const paginate = calls.filter((c) => c.args.includes('--paginate'))
    assert.equal(paginate.length, 1)
    assert.ok(paginate[0].args.includes('--slurp'))
    assert.equal(calls.filter((c) => (c.args.find((a) => a.startsWith('query=')) ?? '').includes('commits(')).length, 2)
  })

  test('fetchCandidates flags a pull-request number; fetchChannel is a separate read', async () => {
    const { gh, calls } = recorder({
      closing: [{ number: 3186 }],
      issue: (n) => (n === 3186 ? { state: 'closed', closed_at: '2026-09-20T01:26:29Z', assignees: [], pull_request: { url: 'x' } } : { state: 'closed', closed_at: '2026-09-20T01:26:30Z', assignees: [] }),
    })
    const { closingIssues } = await fetchCandidates({ gh, repo: 'o/r', prNumber: 1 })
    assert.deepEqual(closingIssues, [{ number: 3186, assignees: [], state: 'closed', closedAt: '2026-09-20T01:26:29Z', isPullRequest: true }])
    assert.ok(!calls.some((c) => c.args.includes('--paginate')), 'no channel read yet')
    const { channelBodies } = await fetchChannel({ gh, repo: 'o/r' })
    assert.deepEqual(channelBodies, [])
    assert.equal(calls.filter((c) => c.args.includes('--paginate')).length, 1)
  })

  test('one unreadable candidate (a keyword for a number that is not an issue here) does not cancel the others', async () => {
    const { gh } = recorder({
      closing: [{ number: 3134 }],
      commitPages: [['chore\n\n' + 'fixes' + ' #9999']],
      issue: (n) => { if (n === 9999) throw new Error('HTTP 404'); return { state: 'closed', closed_at: '2026-09-20T01:26:30Z', assignees: [] } },
    })
    const r = await fetchInputs({ gh, repo: 'o/r', prNumber: 1 })
    assert.deepEqual(r.closingIssues, [
      { number: 3134, assignees: [], state: 'closed', closedAt: '2026-09-20T01:26:30Z' },
      { number: 9999, assignees: [], unreadable: true },
    ])
  })

  test('more than five commit pages is refused, never read in part (the close guard\'s rule)', async () => {
    const { gh } = recorder({ closing: [], commitPages: [[], [], [], [], [], []] })
    await assert.rejects(fetchInputs({ gh, repo: 'o/r', prNumber: 1 }), /more than 500 commits/)
  })

  test('a GraphQL read that returns nothing on stdout is a thrown read, not a silent empty decision', async () => {
    const gh = async () => ''
    await assert.rejects(fetchInputs({ gh, repo: 'o/r', prNumber: 1 }), /closing references: gh returned no output/)
  })

  test('apply comments via stdin, unassigns each login, logs skips, and posts the channel copy', async () => {
    const decision = decide({ pr: mergedPr, closingIssues: [closedByMerge(3134, ['PhilipEriksson']), { number: 3141, state: 'open', closedAt: null }], channelBodies: ['🔒 CLAIM #3134 — x'] })
    const { gh, calls } = recorder()
    const logs = []
    const done = await apply(decision, { gh, repo: 'd-hinders/Haven-AI', prNumber: 3186, log: (m) => logs.push(m) })
    const writes = calls.filter((c) => c.args[0] === 'issue')
    assert.deepEqual(writes.map((c) => c.args.slice(0, 3)), [
      ['issue', 'comment', '3134'],
      ['issue', 'edit', '3134'],
      ['issue', 'edit', '3134'],
      ['issue', 'comment', String(CHANNEL_ISSUE)],
    ])
    // Body through stdin, never argv.
    assert.ok(writes[0].args.includes('-F') && writes[0].args.includes('-') && writes[0].input.startsWith('🔓 RELEASE #3134'))
    assert.deepEqual(writes.slice(1, 3).map((c) => c.args[c.args.indexOf('--remove-assignee') + 1]), ['PhilipEriksson', 'AntonioSaaranen'])
    assert.deepEqual(done.map((d) => d.kind), ['comment', 'unassign', 'unassign', 'channel'])
    assert.ok(logs.some((l) => /left #3141 alone/.test(l)))
  })

  test('no channel copy when the decision has none', async () => {
    const decision = decide({ pr: mergedPr, closingIssues: [closedByMerge(3134)] })
    const { gh, calls } = recorder()
    await apply(decision, { gh, repo: 'o/r', prNumber: 3186, log: () => {} })
    assert.ok(!calls.some((c) => c.args[0] === 'issue' && c.args[2] === String(CHANNEL_ISSUE)))
  })

  test('a refused write is logged and the rest still happens — never a thrown build failure', async () => {
    const decision = decide({ pr: mergedPr, closingIssues: [closedByMerge(3134), closedByMerge(3135)] })
    const logs = []
    const { gh } = recorder({ refuse: (args) => args[2] === '3134' })
    const done = await apply(decision, { gh, repo: 'o/r', prNumber: 3186, log: (m) => logs.push(m) })
    assert.deepEqual(done.map((d) => `${d.kind}:${d.issue}`), ['comment:3135', 'unassign:3135'])
    assert.ok(logs.some((l) => /could not comment on #3134/.test(l)))
  })

  test('a re-run posts no second release on a thread that already carries this merge\'s — but still unassigns', async () => {
    const decision = decide({ pr: mergedPr, closingIssues: [closedByMerge(3134, ['PhilipEriksson'])], channelBodies: ['🔒 CLAIM #3134 — x'] })
    const posted = `🔓 RELEASE #3134 — landed as PR #3186 (\`a29d5469\`, into \`dev\`) — ${AUTO_RELEASE_MARK}; nothing to release by hand.`
    const { gh, calls } = recorder({ existingComments: (n) => [[{ body: n === CHANNEL_ISSUE ? 'unrelated' : posted }]] })
    const logs = []
    const done = await apply(decision, { gh, repo: 'o/r', prNumber: 3186, log: (m) => logs.push(m) })
    const writes = calls.filter((c) => c.args[0] === 'issue').map((c) => c.args.slice(0, 3))
    // No comment on #3134 (already there); unassigns proceed; the channel copy
    // IS posted because the channel does not carry it yet.
    assert.deepEqual(writes, [['issue', 'edit', '3134'], ['issue', 'edit', '3134'], ['issue', 'comment', String(CHANNEL_ISSUE)]])
    assert.ok(logs.some((l) => /already carries this merge's release/.test(l)))
    assert.deepEqual(done.map((d) => d.kind), ['unassign', 'unassign', 'channel'])
  })

  test('an unreadable release thread answers "not yet posted" — the comment is still issued (fail OPEN)', async () => {
    // A transient 5xx on the idempotency read must cost at most one duplicate
    // line, never a silently suppressed release. Mutation: `catch { return
    // true }` turns this red.
    const decision = decide({ pr: mergedPr, closingIssues: [closedByMerge(3134)], channelBodies: ['🔒 CLAIM #3134 — x'] })
    const { gh, calls } = recorder({ existingComments: () => { throw new Error('HTTP 502') } })
    const logs = []
    await apply(decision, { gh, repo: 'o/r', prNumber: 3186, log: (m) => logs.push(m) })
    const writes = calls.filter((c) => c.args[0] === 'issue').map((c) => c.args.slice(0, 3))
    assert.deepEqual(writes, [['issue', 'comment', '3134'], ['issue', 'edit', '3134'], ['issue', 'comment', String(CHANNEL_ISSUE)]])
    assert.ok(!logs.some((l) => /already carries/.test(l)))
  })

  test('the channel bodies fetched for the decision are reused for its idempotency check — no second read', async () => {
    const decision = decide({ pr: mergedPr, closingIssues: [closedByMerge(3134)], channelBodies: ['🔒 CLAIM #3134 — x'] })
    const { gh, calls } = recorder()
    await apply(decision, { gh, repo: 'o/r', prNumber: 3186, channelBodies: ['🔒 CLAIM #3134 — x'], log: () => {} })
    assert.ok(!calls.some((c) => c.args.includes('--paginate') && new RegExp(`issues/${CHANNEL_ISSUE}/`).test(c.args[c.args.length - 1])), 'no channel re-read')
    assert.ok(calls.some((c) => c.args[0] === 'issue' && c.args[2] === String(CHANNEL_ISSUE)), 'channel copy posted')
    // …and when the pre-fetched bodies already carry it, nothing is posted there.
    const { gh: gh2, calls: calls2 } = recorder()
    const posted = `🔓 RELEASE #3134 — landed as PR #3186 (\`a29d5469\`, into \`dev\`) — ${AUTO_RELEASE_MARK}; nothing to release by hand.`
    await apply(decision, { gh: gh2, repo: 'o/r', prNumber: 3186, channelBodies: [posted], log: () => {} })
    assert.ok(!calls2.some((c) => c.args[0] === 'issue' && c.args[2] === String(CHANNEL_ISSUE)))
  })

  test('a release for a DIFFERENT PR on the same issue does not count as already posted', async () => {
    const decision = decide({ pr: mergedPr, closingIssues: [closedByMerge(3134)] })
    const other = `🔓 RELEASE #3134 — landed as PR #99 — ${AUTO_RELEASE_MARK}; nothing to release by hand.`
    const { gh, calls } = recorder({ existingComments: () => [[{ body: other }]] })
    await apply(decision, { gh, repo: 'o/r', prNumber: 3186, log: () => {} })
    assert.ok(calls.some((c) => c.args[0] === 'issue' && c.args[1] === 'comment' && c.args[2] === '3134'))
  })

  test('prFromPayload reads the event\'s pull_request shape, including author type and default branch', () => {
    assert.deepEqual(
      prFromPayload({ number: 3186, merged: true, merged_at: MERGED_AT, merge_commit_sha: 'a29d', user: { login: 'A', type: 'User' }, base: { ref: 'dev', repo: { default_branch: 'dev' } } }),
      { number: 3186, merged: true, mergedAt: MERGED_AT, author: 'A', authorType: 'User', mergeCommit: 'a29d', base: 'dev', defaultBranch: 'dev' },
    )
    assert.equal(prFromPayload({}).merged, false)
  })

  const eventDir = mkdtempSync(path.join(tmpdir(), 'release-on-merge-ev-'))
  const eventFile = (name, pull_request) => {
    const p = path.join(eventDir, name)
    writeFileSync(p, JSON.stringify({ action: 'closed', pull_request }))
    return p
  }

  test('--event on an unmerged payload prints the empty decision without touching gh', () => {
    // PATH emptied: any gh call would fail loudly instead of reaching GitHub.
    const out = execFileSync(process.execPath, [CLI, '--event', eventFile('unmerged.json', { number: 5, merged: false, user: { login: 'x' } }), '--apply'], { encoding: 'utf8', env: { ...process.env, PATH: '' } })
    assert.deepEqual(JSON.parse(out), { releases: [], channel: null, skipped: [] })
  })

  test('--event on a merge into a non-default branch (a promotion) prints the empty decision without touching gh', () => {
    const out = execFileSync(process.execPath, [CLI, '--event', eventFile('promotion.json', { number: 6, merged: true, merged_at: MERGED_AT, user: { login: 'x', type: 'User' }, base: { ref: 'main', repo: { default_branch: 'dev' } } }), '--apply'], { encoding: 'utf8', env: { ...process.env, PATH: '' } })
    assert.deepEqual(JSON.parse(out), { releases: [], channel: null, skipped: [] })
  })

  test('--event on a malformed event file exits 0 with the empty decision — never a red run', () => {
    const p = path.join(eventDir, 'broken.json')
    writeFileSync(p, '{not json')
    const out = execFileSync(process.execPath, [CLI, '--event', p, '--apply'], { encoding: 'utf8', env: { ...process.env, PATH: '' } })
    assert.match(out, /could not read this merge's event/)
    assert.deepEqual(JSON.parse(out.trim().split('\n').pop()), { releases: [], channel: null, skipped: [] })
  })

  test('--event on a MERGED payload whose reads fail exits 0 with an empty decision and a logged reason — never a red run', () => {
    // PATH emptied: `gh` cannot be spawned, so fetchInputs throws; the CLI must
    // log and exit 0 (the workflow promises never to fail the build).
    const out = execFileSync(process.execPath, [CLI, '--event', eventFile('merged.json', { number: 5, merged: true, user: { login: 'x', type: 'User' }, base: { ref: 'dev', repo: { default_branch: 'dev' } } }), '--apply'], { encoding: 'utf8', env: { ...process.env, PATH: '' } })
    assert.match(out, /could not read this merge's event, closing references/)
    assert.deepEqual(JSON.parse(out.trim().split('\n').pop()), { releases: [], channel: null, skipped: [] })
  })
})

// ---------------------------------------------------------------------------
// #4176 — Path A (a `Refs`-only merge releases the author's claim) and Path B
// (a close with no merge behind it).
// ---------------------------------------------------------------------------

/** A comment as `readComments` returns it. */
const said = (author, body, createdAt, onIssue, extra = {}) => ({ author, body, createdAt, onIssue, authorAssociation: 'COLLABORATOR', authorType: 'User', ...extra })
const botSaid = (body, createdAt, onIssue) => ({ author: 'github-actions[bot]', body, createdAt, onIssue, authorAssociation: 'NONE', authorType: 'Bot' })
/** The same comment as the REST API returns it, for recorders. */
const rest = (c) => ({ user: { login: c.author, type: c.authorType }, author_association: c.authorAssociation, body: c.body, created_at: c.createdAt, html_url: null })

describe('the Refs grammar (Path A candidates, the close guard\'s family)', () => {
  test('one number per keyword, optional colon, bare `#` or this repository only', () => {
    const repo = 'd-hinders/Haven-AI'
    assert.deepEqual(parseRefsRefs('Refs #4176', { repo }), [4176])
    assert.deepEqual(parseRefsRefs('refs: #12\nRef #13', { repo }), [12, 13])
    assert.deepEqual(parseRefsRefs('Refs #4005 (panel), #4004 (budget answer)', { repo }), [4005])
    assert.deepEqual(parseRefsRefs('Refs d-hinders/Haven-AI#43 and Refs https://github.com/d-hinders/Haven-AI/issues/44', { repo }), [43, 44])
    assert.deepEqual(parseRefsRefs('Refs other/repo#42 and Refs https://github.com/other/repo/issues/41', { repo }), [])
    assert.deepEqual(parseRefsRefs('Refs d-hinders/Haven-AI#43'), [], 'no repo given: a qualified reference is dropped')
  })

  test('a quoted, fenced or inline-code `Refs #N` is documentation, not a reference (the lines parse() reads)', () => {
    assert.deepEqual(parseRefsRefs('> Refs #11\nUse `Refs #12`, not `Closes`.\n```\nRefs #13\n```\n~~~\nRefs #14\n~~~\nRefs #15'), [15])
    assert.deepEqual(parseRefsRefs('  > Refs #11 (quoted reply)'), [])
  })

  test('placeholders, branch refs and prose without a number are not references', () => {
    assert.deepEqual(parseRefsRefs('Refs #NNN — operator-verify mode. Use `Refs`, not `Closes`. git push refs/heads/dev'), [])
    assert.deepEqual(parseRefsRefs('Refs: epic #4022, blocked-by #4024 satisfied'), [])
    assert.deepEqual(parseRefsRefs('prefers #12'), [], 'a word ending in "refs" is not the keyword')
  })
})

describe('Path A: a merged `Refs`-only reference releases the AUTHOR\'s claim, and the issue stays open', () => {
  const pr = { ...mergedPr, number: 4131, author: 'AntonioSaaranen', authorType: 'User', mergeCommit: '5f3e2a10aaaa', base: 'dev', defaultBranch: 'dev' }
  const open = (number, assignees = []) => ({ number, state: 'open', closedAt: null, assignees })
  const authorClaim = said('AntonioSaaranen', '🔒 CLAIM #4122 — branch `ci/4122-x` — touches: scripts/ci', '2026-10-20T09:00:00Z', 4122)
  const philipClaim = said('PhilipEriksson', '🔒 CLAIM #4122 — branch `docs/4122-y`', '2026-10-20T09:30:00Z', 4122)
  const expected = '🔓 RELEASE #4122 — claim of `AntonioSaaranen` — PR #4131 merged (`5f3e2a10`, into `dev`) and references the issue with `Refs`, so it stays open for its operator step — posted automatically on a `Refs` merge (#4176).'

  test('claimed by the author and by a second session: one line naming the author only, unassign the author only', () => {
    const d = decideRefs({ pr, refsIssues: [open(4122, ['AntonioSaaranen', 'PhilipEriksson'])], commentsByIssue: { 4122: [authorClaim, philipClaim] } })
    assert.deepEqual(d.releases, [{ issue: 4122, body: expected, unassign: ['AntonioSaaranen'] }])
    assert.equal(d.channel, null, 'no claim on the channel → no channel line')
    assert.equal(refsReleaseLine({ issue: 4122, author: 'AntonioSaaranen', pr: 4131, where: '`5f3e2a10`, into `dev`' }), expected)
    // The line is the per-claimant shape: it names exactly the author.
    assert.deepEqual(botReleaseClaimants(expected), { issue: 4122, claimants: ['AntonioSaaranen'], path: 'refs' })
  })

  test('the channel line is added only when the channel holds the AUTHOR\'s claim of #N', () => {
    const onChannel = { ...authorClaim, onIssue: CHANNEL_ISSUE, body: '🔒 CLAIM #4122 — branch `ci/4122-x`' }
    const d = decideRefs({ pr, refsIssues: [open(4122)], commentsByIssue: { 4122: [] }, channelComments: [onChannel] })
    assert.equal(d.releases[0].body, expected, 'the issue gets the line even when the claim was made on the channel')
    assert.deepEqual(d.channel, { body: expected })
    const someoneElsesOnChannel = { ...philipClaim, onIssue: CHANNEL_ISSUE }
    assert.equal(decideRefs({ pr, refsIssues: [open(4122)], commentsByIssue: { 4122: [authorClaim] }, channelComments: [someoneElsesOnChannel] }).channel, null)
  })

  test('a Refs issue with no claim by the author: nothing posted, nobody unassigned', () => {
    const d = decideRefs({ pr, refsIssues: [open(4122, ['PhilipEriksson', 'AntonioSaaranen'])], commentsByIssue: { 4122: [philipClaim] } })
    assert.deepEqual(d.releases, [])
    assert.equal(d.channel, null)
    assert.match(d.skipped[0].reason, /no unreleased claim of it by AntonioSaaranen/)
  })

  test('the author already released (or withdrew) by hand: nothing posted', () => {
    for (const body of ['🔓 RELEASE #4122 — landed as PR #4131', '↩️ WITHDRAWN #4122 — superseded']) {
      const d = decideRefs({ pr, refsIssues: [open(4122)], commentsByIssue: { 4122: [authorClaim, said('AntonioSaaranen', body, '2026-10-20T10:00:00Z', 4122)] } })
      assert.deepEqual(d.releases, [], body)
    }
  })

  test('a closed Refs issue, a pull-request number and an unreadable one are skipped with reasons', () => {
    const d = decideRefs({ pr, refsIssues: [{ number: 4111, state: 'closed', closedAt: '2026-10-19T00:00:00Z', assignees: [] }, { number: 4130, state: 'open', isPullRequest: true, assignees: [] }, { number: 9999, unreadable: true, assignees: [] }], commentsByIssue: {} })
    assert.deepEqual(d.releases, [])
    assert.deepEqual(d.skipped.map((x) => x.issue), [4111, 4130, 9999])
    assert.match(d.skipped[0].reason, /stays open/)
  })

  test('unmerged, a promotion, and a bot author release nothing', () => {
    const args = { refsIssues: [open(4122)], commentsByIssue: { 4122: [authorClaim] } }
    assert.deepEqual(decideRefs({ pr: { ...pr, merged: false }, ...args }).releases, [])
    assert.deepEqual(decideRefs({ pr: { ...pr, base: 'main' }, ...args }).releases, [])
    assert.deepEqual(decideRefs({ pr: { ...pr, authorType: 'Bot' }, ...args }).releases, [])
  })

  test('a claim from a non-collaborator association is not the author\'s claim here', () => {
    const d = decideRefs({ pr, refsIssues: [open(4122)], commentsByIssue: { 4122: [{ ...authorClaim, authorAssociation: 'CONTRIBUTOR' }] } })
    assert.deepEqual(d.releases, [])
  })

  test('idempotent per thread: a re-run where both threads carry the line posts nothing; where only the issue does, only the channel line', () => {
    const onChannel = { ...authorClaim, onIssue: CHANNEL_ISSUE }
    const postedOnIssue = botSaid(expected, '2026-10-20T10:00:05Z', 4122)
    const postedOnChannel = botSaid(expected, '2026-10-20T10:00:06Z', CHANNEL_ISSUE)
    const both = decideRefs({ pr, refsIssues: [open(4122)], commentsByIssue: { 4122: [authorClaim, postedOnIssue] }, channelComments: [onChannel, postedOnChannel] })
    assert.deepEqual(both.releases, [], 'nothing left to release on either thread')
    assert.equal(both.channel, null)
    const half = decideRefs({ pr, refsIssues: [open(4122)], commentsByIssue: { 4122: [authorClaim, postedOnIssue] }, channelComments: [onChannel] })
    assert.deepEqual(half.releases, [{ issue: 4122, body: null, unassign: ['AntonioSaaranen'] }])
    assert.deepEqual(half.channel, { body: expected })
  })

  // A recorder that answers every read the merge run makes.
  const mergeGh = ({ closing = [], title = 't', body = '', commits = [], issues = {}, comments = {}, refuseRefs = false }) => {
    const calls = []
    const gh = async (args, opts = {}) => {
      calls.push({ args, input: opts.input ?? null })
      if (args[0] === 'api' && args[1] === 'graphql') {
        const q = args.find((a) => a.startsWith('query=')) ?? ''
        if (/closingIssuesReferences/.test(q)) return JSON.stringify({ title, closingIssuesReferences: { nodes: closing.map((number) => ({ number })) } })
        if (/commits\(/.test(q)) return JSON.stringify({ nodes: commits.map((m) => ({ commit: { oid: 'abc', message: m } })), pageInfo: { hasNextPage: false } })
        if (/title body/.test(q)) {
          if (refuseRefs) return ''
          return JSON.stringify({ title, body })
        }
      }
      if (args[0] === 'api' && args.includes('--paginate')) {
        const n = Number(args[args.length - 1].match(/issues\/(\d+)\//)[1])
        return JSON.stringify([(comments[n] ?? []).map(rest)])
      }
      if (args[0] === 'api' && /^repos\/[^/]+\/[^/]+\/issues\/\d+$/.test(args[1])) {
        const n = Number(args[1].split('/').pop())
        const i = issues[n] ?? { state: 'open', closed_at: null, assignees: [] }
        return JSON.stringify(i)
      }
      return ''
    }
    return { gh, calls }
  }

  test('a PR that closes one issue and Refs another: each path releases its own issue, once, and the channel gets ONE comment', async () => {
    const closedClaim = said('AntonioSaaranen', '🔒 CLAIM #4120 — branch `x`', '2026-10-20T08:00:00Z', CHANNEL_ISSUE)
    const refsClaim = said('AntonioSaaranen', '🔒 CLAIM #4122 — branch `y`', '2026-10-20T08:00:01Z', CHANNEL_ISSUE)
    const { gh, calls } = mergeGh({
      closing: [4120],
      // The body also says `Refs #4120`: an issue the PR closes is the merge path's only.
      body: 'Closes #4120\nRefs #4120\nRefs #4122',
      commits: ['ci: x\n\nRefs #4122'],
      issues: {
        4120: { state: 'closed', closed_at: '2026-09-20T01:26:30Z', assignees: [{ login: 'AntonioSaaranen' }] },
        4122: { state: 'open', closed_at: null, assignees: [{ login: 'AntonioSaaranen' }, { login: 'PhilipEriksson' }] },
      },
      comments: { [CHANNEL_ISSUE]: [closedClaim, refsClaim], 4122: [] },
    })
    const prepared = await prepareMerge({ pr: { ...pr, mergedAt: MERGED_AT }, gh, repo: 'd-hinders/Haven-AI', log: () => {} })
    assert.deepEqual(prepared.decision.releases.map((r) => r.issue), [4120])
    assert.deepEqual(prepared.refs.releases.map((r) => [r.issue, r.unassign]), [[4122, ['AntonioSaaranen']]])
    assert.ok(!prepared.refs.skipped.some((x) => x.issue === 4120) && !prepared.refs.releases.some((r) => r.issue === 4120), '#4120 is not a Refs candidate')
    await applyMerge(prepared, { gh, repo: 'd-hinders/Haven-AI', prNumber: 4131, log: () => {} })
    const comments = calls.filter((c) => c.args[0] === 'issue' && c.args[1] === 'comment')
    assert.deepEqual(comments.map((c) => c.args[2]), ['4120', String(CHANNEL_ISSUE), '4122'], 'one comment per thread')
    const channelBody = comments[1].input
    assert.match(channelBody, /^🔓 RELEASE #4120 — landed as PR #4131/)
    assert.match(channelBody, /\n🔓 RELEASE #4122 — claim of `AntonioSaaranen` — PR #4131 merged/)
    const unassigns = calls.filter((c) => c.args.includes('--remove-assignee')).map((c) => [c.args[2], c.args[c.args.length - 1]])
    assert.deepEqual(unassigns, [['4120', 'AntonioSaaranen'], ['4122', 'AntonioSaaranen']], 'PhilipEriksson keeps #4122')
  })

  test('a re-run of the same merge posts nothing on any thread that already carries its line', async () => {
    const refsClaim = said('AntonioSaaranen', '🔒 CLAIM #4122 — branch `y`', '2026-10-20T08:00:01Z', 4122)
    const line = refsReleaseLine({ issue: 4122, author: 'AntonioSaaranen', pr: 4131, where: '`5f3e2a10`, into `dev`' })
    const { gh, calls } = mergeGh({ body: 'Refs #4122', comments: { 4122: [refsClaim, botSaid(line, '2026-10-20T10:00:00Z', 4122)] } })
    const prepared = await prepareMerge({ pr, gh, repo: 'd-hinders/Haven-AI', log: () => {} })
    await applyMerge(prepared, { gh, repo: 'd-hinders/Haven-AI', prNumber: 4131, log: () => {} })
    assert.equal(calls.filter((c) => c.args[0] === 'issue' && c.args[1] === 'comment').length, 0)
  })

  test('Path A\'s reads failing never cancel the merge path', async () => {
    const { gh, calls } = mergeGh({ closing: [4120], refuseRefs: true, issues: { 4120: { state: 'closed', closed_at: '2026-09-20T01:26:30Z', assignees: [] } } })
    const logs = []
    const prepared = await prepareMerge({ pr: { ...pr, mergedAt: MERGED_AT }, gh, repo: 'o/r', log: (l) => logs.push(l) })
    assert.deepEqual(prepared.decision.releases.map((r) => r.issue), [4120])
    assert.match(prepared.refs.error, /title and body/)
    assert.ok(logs.some((l) => /no `Refs` release/.test(l)))
    await applyMerge(prepared, { gh, repo: 'o/r', prNumber: 4131, log: () => {} })
    assert.equal(calls.filter((c) => c.args[0] === 'issue' && c.args[1] === 'comment').length, 1)
  })

  test('fetchRefsInputs reads title, body and every commit, excludes closing candidates, and reads comments only for open issues', async () => {
    const { gh, calls } = mergeGh({ title: 'ci: x (Refs #1)', body: 'Refs #2\nRefs #3', commits: ['Refs #4'], issues: { 3: { state: 'closed', closed_at: 'x', assignees: [] } } })
    const r = await fetchRefsInputs({ gh, repo: 'o/r', prNumber: 9, exclude: [2] })
    assert.deepEqual(r.refsIssues.map((i) => i.number), [1, 3, 4])
    assert.deepEqual(Object.keys(r.commentsByIssue).map(Number), [1, 4])
    assert.ok(!calls.some((c) => (c.args.find((a) => a.startsWith('query=')) ?? '').includes('closingIssuesReferences')), 'its own query, not fetchCandidates\'s')
  })
})

describe('Path B: a close with no merge behind it releases every collaborator\'s unreleased claim', () => {
  const CLOSED_AT = '2026-10-19T08:52:58Z'
  const issue = (extra = {}) => ({ number: 3815, state: 'closed', closedAt: CLOSED_AT, assignees: ['PhilipEriksson'], author: 'd-hinders', authorAssociation: 'OWNER', ...extra })
  const sender = { login: 'd-hinders', type: 'User' }
  const philip = said('PhilipEriksson', '🔒 CLAIM #3815 — branch `feat/3815-x`', '2026-10-09T10:00:00Z', 3815)
  const base = { issue: issue(), sender, closer: null, defaultBranch: 'dev', repo: 'd-hinders/Haven-AI' }
  const line = (claimants) => closeReleaseLine({ issue: 3815, claimants, closer: 'd-hinders' })

  test('the line, pinned: names the claimants in backticks, names no PR, carries its own mark', () => {
    assert.equal(line(['PhilipEriksson']), '🔓 RELEASE #3815 — claim of `PhilipEriksson` — the issue was closed by `d-hinders` with no merge behind the close, so no claim on it is live — posted automatically on a hand close (#4176).')
    assert.deepEqual(botReleaseClaimants(line(['a', 'b'])), { issue: 3815, claimants: ['a', 'b'], path: 'close' })
    assert.doesNotMatch(line(['a']), /\bPR\s*#\d/)
  })

  test('a hand-closed issue with an unreleased claim on the issue: one line on the issue, everyone still assigned unassigned', () => {
    const d = decideClose({ ...base, issue: issue({ assignees: ['PhilipEriksson', 'AntonioSaaranen'] }), comments: [philip] })
    assert.deepEqual(d.releases, [{ issue: 3815, body: line(['PhilipEriksson']), unassign: ['PhilipEriksson', 'AntonioSaaranen'] }])
    assert.equal(d.channel, null)
  })

  test('the claim only on the channel: the line on the issue AND the #3193 mirror', () => {
    const d = decideClose({ ...base, comments: [{ ...philip, onIssue: CHANNEL_ISSUE }] })
    assert.equal(d.releases[0].body, line(['PhilipEriksson']))
    assert.deepEqual(d.channel, { body: line(['PhilipEriksson']) })
  })

  test('two claimants: ONE comment per thread naming both; the channel names only the one whose claim is there', () => {
    const daniel = said('d-hinders', '🔒 CLAIM #3815 — branch `y`', '2026-10-10T10:00:00Z', CHANNEL_ISSUE)
    const d = decideClose({ ...base, comments: [philip, daniel] })
    assert.equal(d.releases.length, 1)
    assert.equal(d.releases[0].body, line(['PhilipEriksson', 'd-hinders']))
    assert.deepEqual(d.channel, { body: line(['d-hinders']) })
  })

  test('the claimant already posted 🔓 RELEASE or ↩️ WITHDRAWN: nothing posted, nobody unassigned', () => {
    for (const body of ['🔓 RELEASE #3815 — abandoned: superseded', '↩️ WITHDRAWN #3815 — collided with Daniel\'s claim']) {
      for (const where of [3815, CHANNEL_ISSUE]) {
        const d = decideClose({ ...base, comments: [philip, said('PhilipEriksson', body, '2026-10-10T00:00:00Z', where)] })
        assert.deepEqual(d.releases, [], `${body} on #${where}`)
        assert.equal(d.channel, null)
      }
    }
  })

  test('a claim from a non-collaborator association is ignored', () => {
    for (const authorAssociation of ['NONE', 'CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR']) {
      const d = decideClose({ ...base, comments: [{ ...philip, author: 'stranger', authorAssociation }] })
      assert.deepEqual(d.releases, [], authorAssociation)
    }
    assert.deepEqual(decideClose({ ...base, comments: [{ ...philip, authorType: 'Bot', author: 'x[bot]' }] }).releases, [], 'nor a bot')
  })

  test('no claim at all: nothing posted and the assignees are LEFT (the decided unassign-without-claim rule)', () => {
    const d = decideClose({ ...base, issue: issue({ assignees: ['PhilipEriksson'] }), comments: [] })
    assert.deepEqual(d.releases, [])
    assert.match(d.skipped[0].reason, /assignees left as they are/)
  })

  test('only a collaborator\'s close counts: a bot, or a non-collaborator closing their own issue, releases nothing', () => {
    assert.deepEqual(decideClose({ ...base, sender: { login: 'some-app[bot]', type: 'Bot' }, comments: [philip] }).releases, [])
    const ownClose = { ...base, issue: issue({ author: 'stranger', authorAssociation: 'NONE' }), sender: { login: 'stranger', type: 'User' }, comments: [philip] }
    assert.deepEqual(decideClose(ownClose).releases, [])
    assert.match(decideClose(ownClose).skipped[0].reason, /not a collaborator/)
    // A collaborator closing a stranger's issue needed triage access: it counts.
    assert.equal(decideClose({ ...ownClose, sender: { login: 'd-hinders', type: 'User' } }).releases.length, 1)
    // The author's close counts when the author is a collaborator.
    assert.equal(decideClose({ ...ownClose, issue: issue({ author: 'stranger', authorAssociation: 'COLLABORATOR' }) }).releases.length, 1)
  })

  test('reopened since, the channel itself, an unreadable timeline: nothing released', () => {
    assert.deepEqual(decideClose({ ...base, issue: issue({ state: 'open' }), comments: [philip] }).releases, [])
    assert.deepEqual(decideClose({ ...base, issue: issue({ number: CHANNEL_ISSUE }), comments: [philip] }).releases, [])
    assert.deepEqual(decideClose({ ...base, closer: { unreadable: true }, comments: [philip] }).releases, [])
  })

  test('idempotent per thread: the issue line already there → only the channel line; both there → nothing', () => {
    const onChannel = { ...philip, onIssue: CHANNEL_ISSUE }
    const issueLine = botSaid(line(['PhilipEriksson']), '2026-10-19T08:53:30Z', 3815)
    const half = decideClose({ ...base, comments: [onChannel, issueLine] })
    assert.deepEqual(half.releases, [{ issue: 3815, body: null, unassign: ['PhilipEriksson'] }])
    assert.deepEqual(half.channel, { body: line(['PhilipEriksson']) })
    const both = decideClose({ ...base, comments: [onChannel, issueLine, botSaid(line(['PhilipEriksson']), '2026-10-19T08:53:31Z', CHANNEL_ISSUE)] })
    assert.deepEqual(both.releases, [])
  })

  test('a reopened issue the merge path already released is not released twice on its later hand close', () => {
    const merge = botSaid('🔓 RELEASE #3815 — landed as PR #3820 (`abc12345`, into `dev`) — posted automatically on merge (#3177); nothing to release by hand.', '2026-10-10T00:00:00Z', 3815)
    assert.deepEqual(decideClose({ ...base, comments: [philip, merge] }).releases, [])
    // …but a claim made AFTER that release is a new one, and is released.
    const reclaim = { ...philip, createdAt: '2026-10-11T00:00:00Z' }
    assert.equal(decideClose({ ...base, comments: [philip, merge, reclaim] }).releases.length, 1)
  })
})

describe('the double fire: Path B defers to the merge path by the merge path\'s own rule', () => {
  const MERGED = '2026-10-20T19:58:00Z'
  const closer = { kind: 'PullRequest', number: 4181, merged: true, mergedAt: MERGED, baseRefName: 'dev', repository: 'd-hinders/Haven-AI' }
  const claim = said('AntonioSaaranen', '🔒 CLAIM #4173 — branch `x`', '2026-10-20T19:00:00Z', 4173)
  const closeArgs = (over = {}) => ({ issue: { number: 4173, state: 'closed', closedAt: '2026-10-20T19:58:01Z', assignees: ['AntonioSaaranen'], author: 'AntonioSaaranen', authorAssociation: 'OWNER' }, sender: { login: 'AntonioSaaranen', type: 'User' }, closer, defaultBranch: 'dev', repo: 'd-hinders/Haven-AI', comments: [claim], ...over })

  test('a merge closed it within the window: exactly ONE release across both runs (the merge path\'s)', () => {
    // The #4181 → #4173 shape, measured: merged 19:58:00Z, closed 19:58:01Z.
    const mergeRun = decide({ pr: { number: 4181, merged: true, mergedAt: MERGED, author: 'AntonioSaaranen', base: 'dev', defaultBranch: 'dev' }, closingIssues: [{ number: 4173, state: 'closed', closedAt: '2026-10-20T19:58:01Z', assignees: ['AntonioSaaranen'] }] })
    const closeRun = decideClose(closeArgs())
    assert.equal(mergeRun.releases.length + closeRun.releases.length + (closeRun.channel ? 1 : 0), 1)
    assert.match(closeRun.skipped[0].reason, /closed by the merge of PR #4181 into `dev`.*the merge path releases it/)
  })

  test('the window\'s edges are the merge path\'s: at +5 min deferred, past it released here, before the merge released here', () => {
    const at = (ms) => new Date(Date.parse(MERGED) + ms).toISOString()
    const releasedAt = (closedAt) => decideClose(closeArgs({ issue: { ...closeArgs().issue, closedAt } })).releases.length
    assert.equal(releasedAt(at(CLOSE_WINDOW_MS)), 0)
    assert.equal(releasedAt(at(CLOSE_WINDOW_MS + 1000)), 1)
    assert.equal(releasedAt(at(-1000)), 1)
  })

  test('a closer that is not a default-branch merge of this repository is not deferred', () => {
    assert.equal(decideClose(closeArgs({ closer: { ...closer, baseRefName: 'main' } })).releases.length, 1, 'a promotion closes nothing on GitHub')
    assert.equal(decideClose(closeArgs({ closer: { ...closer, merged: false } })).releases.length, 1)
    assert.equal(decideClose(closeArgs({ closer: { ...closer, repository: 'other/repo' } })).releases.length, 1)
    // A Commit closer is the squash merge's when a merged PR carries it (the #4176 review blocker) — deferred:
    assert.equal(decideClose(closeArgs({ closer: { kind: 'Commit', oid: '022ad59f', pullRequests: [{ ...closer, kind: undefined }] } })).releases.length, 0, 'a squash commit of a merged PR: the merge path owns it')
    // …and a direct push (no PR carries the commit) is not a merge the merge path ever sees:
    assert.equal(decideClose(closeArgs({ closer: { kind: 'Commit', oid: 'abc', pullRequests: [] } })).releases.length, 1, 'a direct push: the merge path never sees it')
    assert.equal(decideClose(closeArgs({ closer: null })).releases.length, 1, 'a hand close')
  })
})

describe('Path B through an injected gh', () => {
  const closeGh = ({ node, comments = {} }) => {
    const calls = []
    const gh = async (args, opts = {}) => {
      calls.push({ args, input: opts.input ?? null })
      if (args[0] === 'api' && args[1] === 'graphql') return node === undefined ? '' : JSON.stringify(node)
      if (args[0] === 'api' && args.includes('--paginate')) {
        const n = Number(args[args.length - 1].match(/issues\/(\d+)\//)[1])
        return JSON.stringify([(comments[n] ?? []).map(rest)])
      }
      return ''
    }
    return { gh, calls }
  }
  const ev = (over = {}) => ({ action: 'closed', issue: { number: 3815, user: { login: 'd-hinders' }, author_association: 'OWNER' }, sender: { login: 'd-hinders', type: 'User' }, repository: { default_branch: 'dev' }, ...over })
  const claim = said('PhilipEriksson', '🔒 CLAIM #3815 — branch `x`', '2026-10-09T10:00:00Z', CHANNEL_ISSUE)

  test('reads the issue and its closed event\'s closer from the timeline, then both threads; posts one line per thread and unassigns', async () => {
    const { gh, calls } = closeGh({
      node: { state: 'CLOSED', closedAt: '2026-10-19T08:52:58Z', assignees: { nodes: [{ login: 'PhilipEriksson' }] }, timelineItems: { nodes: [{ createdAt: '2026-10-19T08:52:59Z', closer: null }] } },
      comments: { [CHANNEL_ISSUE]: [claim] },
    })
    const d = await prepareClose({ ev: ev(), gh, repo: 'd-hinders/Haven-AI' })
    assert.equal(d.releases[0].issue, 3815)
    const q = calls[0].args.find((a) => a.startsWith('query=')) ?? ''
    assert.match(q, /timelineItems\(itemTypes:\[CLOSED_EVENT\], last:1\)/)
    await applyPerClaimant(d, { gh, repo: 'd-hinders/Haven-AI', log: () => {} })
    const writes = calls.filter((c) => c.args[0] === 'issue').map((c) => c.args.slice(0, 3).join(' '))
    assert.deepEqual(writes, ['issue comment 3815', 'issue edit 3815', `issue comment ${CHANNEL_ISSUE}`])
  })

  test('a merge-caused close read from the timeline is deferred and posts nothing', async () => {
    const { gh, calls } = closeGh({
      node: { state: 'CLOSED', closedAt: '2026-10-20T19:58:01Z', assignees: { nodes: [] }, timelineItems: { nodes: [{ createdAt: '2026-10-20T19:58:02Z', closer: { __typename: 'PullRequest', number: 4181, merged: true, mergedAt: '2026-10-20T19:58:00Z', baseRefName: 'dev', repository: { nameWithOwner: 'd-hinders/Haven-AI' } } }] } },
      comments: { [CHANNEL_ISSUE]: [claim] },
    })
    const d = await prepareClose({ ev: ev(), gh, repo: 'd-hinders/Haven-AI' })
    assert.deepEqual(d.releases, [])
    await applyPerClaimant(d, { gh, repo: 'd-hinders/Haven-AI', log: () => {} })
    assert.equal(calls.filter((c) => c.args[0] === 'issue').length, 0)
  })

  test('a bot\'s close is decided from the payload and reads nothing', async () => {
    const { gh, calls } = closeGh({ node: {} })
    const d = await prepareClose({ ev: ev({ sender: { login: 'x[bot]', type: 'Bot' } }), gh, repo: 'o/r' })
    assert.deepEqual(d.releases, [])
    assert.equal(calls.length, 0)
  })

  test('a timeline with no closed event yet is not read as a hand close', async () => {
    const { gh } = closeGh({ node: { state: 'CLOSED', closedAt: 'x', assignees: { nodes: [] }, timelineItems: { nodes: [] } }, comments: { 3815: [claim] } })
    assert.deepEqual((await prepareClose({ ev: ev(), gh, repo: 'o/r' })).releases, [])
  })

  test('an empty GraphQL answer is a thrown read, never a silent "no closer"', async () => {
    const { gh } = closeGh({ node: undefined })
    await assert.rejects(prepareClose({ ev: ev(), gh, repo: 'o/r' }), /gh returned no output/)
  })

  test('--close-event exits 0 with the empty decision when reads fail, and on a malformed file', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'release-on-close-ev-'))
    const p = path.join(dir, 'closed.json')
    writeFileSync(p, JSON.stringify(ev()))
    const out = execFileSync(process.execPath, [CLI, '--close-event', p, '--apply'], { encoding: 'utf8', env: { ...process.env, PATH: '' } })
    assert.match(out, /could not read this close's event/)
    assert.deepEqual(JSON.parse(out.trim().split('\n').pop()), { releases: [], channel: null, skipped: [] })
    const bad = path.join(dir, 'bad.json')
    writeFileSync(bad, '{not json')
    const out2 = execFileSync(process.execPath, [CLI, '--close-event', bad], { encoding: 'utf8', env: { ...process.env, PATH: '' } })
    assert.deepEqual(JSON.parse(out2.trim().split('\n').pop()), { releases: [], channel: null, skipped: [] })
  })
})

describe('the close workflow (#4176) is shaped as the spec requires', () => {
  const yml = readFileSync(new URL('../../.github/workflows/claim-release-on-close.yml', import.meta.url), 'utf8')
  const body = yml.replace(/^\s*#.*$/gm, '')

  test('triggers on issues: closed only, in this repository only, with issues: write only', () => {
    assert.match(body, /^on:\n  issues:\n    types: \[closed\]\n\n/m)
    assert.match(body, /^permissions:\n  issues: write(?: #[^\n]*)?\n\n/m)
    assert.match(body, /if: github\.repository == 'd-hinders\/Haven-AI'/)
  })

  test('checks out the DEFAULT branch, never the PR path\'s base ref (empty on an issues event)', () => {
    assert.match(body, /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/)
    assert.doesNotMatch(body, /pull_request\.base\.ref/)
    assert.match(body, /ref: \$\{\{ github\.event\.repository\.default_branch \}\}\n\s+persist-credentials: false\n/)
  })

  test('reads the event from the file, never interpolated into the script', () => {
    assert.match(body, /run: node scripts\/ci\/release-on-merge\.mjs --close-event "\$GITHUB_EVENT_PATH" --apply\n/)
    const run = body.slice(body.indexOf('run:'))
    assert.doesNotMatch(run, /\$\{\{\s*github\.event/)
  })

  test('the header states the limits it does not guard: GITHUB_TOKEN closes, the 50-reference cap, the rate limit', () => {
    for (const f of ['qa-failure-issue.mjs', 'qa-balance-issue.mjs', 'dev-push-health.mjs', 'guard-freshness.mjs']) assert.ok(yml.includes(f), f)
    assert.match(yml, /first:50/)
    assert.match(yml, /rate limit/)
  })
})

describe('#4176 review: a Commit closer, the closed event tied to THIS close, staged reads', () => {
  // Real #2268 data (read-only GraphQL, 2026-10-20): its second closed event
  // has closer Commit 7f7102ff, associated PR #2314 merged into dev at
  // 2026-08-31T19:03:57Z, event at 19:03:58Z. Its third closed event (the hand
  // close that stands today) has closer null, event == closedAt 2026-09-02T10:13:48Z.
  const node2268MergeClose = {
    state: 'CLOSED', closedAt: '2026-08-31T19:03:58Z', assignees: { nodes: [{ login: 'AntonioSaaranen' }] },
    timelineItems: { nodes: [{ createdAt: '2026-08-31T19:03:58Z', closer: { __typename: 'Commit', oid: '7f7102ff754f1aec62b4dc2a1c45ab8786cb70ce', associatedPullRequests: { nodes: [{ number: 2314, merged: true, mergedAt: '2026-08-31T19:03:57Z', baseRefName: 'dev', repository: { nameWithOwner: 'd-hinders/Haven-AI' } }] } } }] },
  }
  const node2268HandClose = {
    state: 'CLOSED', closedAt: '2026-09-02T10:13:48Z', assignees: { nodes: [{ login: 'AntonioSaaranen' }] },
    timelineItems: { nodes: [{ createdAt: '2026-09-02T10:13:48Z', closer: null }] },
  }
  const claim = said('AntonioSaaranen', '🔒 CLAIM #2268 — branch `x`', '2026-08-31T10:00:00Z', 2268)

  test('closerFromTimeline reads a Commit closer with its associated pull requests', () => {
    assert.deepEqual(closerFromTimeline(node2268MergeClose), { kind: 'Commit', oid: '7f7102ff754f1aec62b4dc2a1c45ab8786cb70ce', pullRequests: [{ number: 2314, merged: true, mergedAt: '2026-08-31T19:03:57Z', baseRefName: 'dev', repository: 'd-hinders/Haven-AI' }] })
    assert.equal(closerFromTimeline(node2268HandClose), null, 'a null closer tied to this close is a hand close')
  })

  test('the #2314 → #2268 squash close (closer = commit 7f7102ff) is deferred to the merge path', () => {
    const issue = { number: 2268, state: 'closed', closedAt: node2268MergeClose.closedAt, assignees: ['AntonioSaaranen'], author: 'AntonioSaaranen', authorAssociation: 'OWNER' }
    const reason = closeDeferral({ issue, closer: closerFromTimeline(node2268MergeClose), defaultBranch: 'dev', repo: 'd-hinders/Haven-AI' })
    assert.match(reason, /closed by the merge of PR #2314 into `dev` \(2026-08-31T19:03:57Z\) via its commit `7f7102ff` — the merge path releases it/)
    assert.deepEqual(decideClose({ issue, sender: { login: 'AntonioSaaranen', type: 'User' }, closer: closerFromTimeline(node2268MergeClose), defaultBranch: 'dev', repo: 'd-hinders/Haven-AI', comments: [claim] }).releases, [])
  })

  test('the later #2268 hand close (closer null, same second) is Path B\'s and releases', () => {
    const issue = { number: 2268, state: 'closed', closedAt: node2268HandClose.closedAt, assignees: ['AntonioSaaranen'], author: 'AntonioSaaranen', authorAssociation: 'OWNER' }
    const d = decideClose({ issue, sender: { login: 'd-hinders', type: 'User' }, closer: closerFromTimeline(node2268HandClose), defaultBranch: 'dev', repo: 'd-hinders/Haven-AI', comments: [claim] })
    assert.equal(d.releases.length, 1)
  })

  test('a closed event more than 10 s from closedAt is not THIS close: unreadable, nothing posted — null closer included', () => {
    const shifted = (node, ms) => ({ ...node, timelineItems: { nodes: [{ ...node.timelineItems.nodes[0], createdAt: new Date(Date.parse(node.closedAt) + ms).toISOString() }] } })
    assert.deepEqual(closerFromTimeline(shifted(node2268HandClose, CLOSE_EVENT_TOLERANCE_MS + 1000)), { unreadable: true })
    assert.deepEqual(closerFromTimeline(shifted(node2268HandClose, -(CLOSE_EVENT_TOLERANCE_MS + 1000))), { unreadable: true })
    assert.equal(closerFromTimeline(shifted(node2268HandClose, CLOSE_EVENT_TOLERANCE_MS)), null, 'at the tolerance it is still this close')
    assert.deepEqual(closerFromTimeline({ ...node2268HandClose, timelineItems: { nodes: [{ closer: null }] } }), { unreadable: true }, 'no event time')
    const issue = { number: 2268, state: 'closed', closedAt: node2268HandClose.closedAt, assignees: ['AntonioSaaranen'], author: 'AntonioSaaranen', authorAssociation: 'OWNER' }
    const d = decideClose({ issue, sender: { login: 'd-hinders', type: 'User' }, closer: closerFromTimeline(shifted(node2268HandClose, 60_000)), defaultBranch: 'dev', repo: 'd-hinders/Haven-AI', comments: [claim] })
    assert.deepEqual(d.releases, [])
    assert.match(d.skipped[0].reason, /could not be tied to this close/)
  })

  // A recorder that counts every read the close run makes.
  const counting = (node, comments = {}) => {
    const calls = []
    const gh = async (args) => {
      calls.push(args)
      if (args[0] === 'api' && args[1] === 'graphql') return JSON.stringify(node)
      if (args[0] === 'api' && args.includes('--paginate')) {
        const n = Number(args[args.length - 1].match(/issues\/(\d+)\//)[1])
        return JSON.stringify([(comments[n] ?? []).map(rest)])
      }
      return ''
    }
    const count = () => ({
      timeline: calls.filter((a) => a[1] === 'graphql').length,
      channel: calls.filter((a) => a.includes('--paginate') && a[a.length - 1].includes(`/issues/${CHANNEL_ISSUE}/comments`)).length,
      all: calls.length,
    })
    return { gh, count }
  }
  const ev = (over = {}) => ({ action: 'closed', issue: { number: 2268, user: { login: 'AntonioSaaranen' }, author_association: 'OWNER' }, sender: { login: 'AntonioSaaranen', type: 'User' }, repository: { default_branch: 'dev' }, ...over })

  test('call counts: a non-collaborator closing their own issue makes 0 reads; a deferred merge close makes 1 timeline read and 0 channel reads', async () => {
    const own = counting(node2268HandClose)
    const d1 = await prepareClose({ ev: ev({ issue: { number: 2268, user: { login: 'stranger' }, author_association: 'NONE' }, sender: { login: 'stranger', type: 'User' } }), gh: own.gh, repo: 'd-hinders/Haven-AI' })
    assert.deepEqual(d1.releases, [])
    assert.deepEqual(own.count(), { timeline: 0, channel: 0, all: 0 })

    const merged = counting(node2268MergeClose, { [CHANNEL_ISSUE]: [claim] })
    const d2 = await prepareClose({ ev: ev(), gh: merged.gh, repo: 'd-hinders/Haven-AI' })
    assert.deepEqual(d2.releases, [])
    assert.deepEqual(merged.count(), { timeline: 1, channel: 0, all: 1 })

    const untied = counting({ ...node2268HandClose, timelineItems: { nodes: [{ createdAt: '2026-09-01T00:00:00Z', closer: null }] } })
    await prepareClose({ ev: ev(), gh: untied.gh, repo: 'd-hinders/Haven-AI' })
    assert.deepEqual(untied.count(), { timeline: 1, channel: 0, all: 1 })

    const hand = counting(node2268HandClose, { 2268: [claim] })
    const d3 = await prepareClose({ ev: ev({ sender: { login: 'd-hinders', type: 'User' } }), gh: hand.gh, repo: 'd-hinders/Haven-AI' })
    assert.equal(d3.releases.length, 1)
    assert.deepEqual(hand.count(), { timeline: 1, channel: 1, all: 3 }, 'only a close that may release reads both threads')
  })
})

describe('#4176 review: only the workflows\' account can release, and epics are skipped', () => {
  const philip = said('PhilipEriksson', '🔒 CLAIM #3815 — branch `feat/3815-x`', '2026-10-09T10:00:00Z', 3815)
  const line = closeReleaseLine({ issue: 3815, claimants: ['PhilipEriksson'], closer: 'd-hinders' })
  const base = { issue: { number: 3815, state: 'closed', closedAt: '2026-10-19T08:52:58Z', assignees: [], author: 'd-hinders', authorAssociation: 'OWNER' }, sender: { login: 'd-hinders', type: 'User' }, closer: null, defaultBranch: 'dev', repo: 'd-hinders/Haven-AI' }

  test('a `vercel[bot]` line in the Path B shape is not the workflow\'s: the claim is still released by this run', () => {
    const vercel = { ...botSaid(line, '2026-10-19T08:53:00Z', 3815), author: 'vercel[bot]' }
    assert.equal(decideClose({ ...base, comments: [philip, vercel] }).releases[0].body, line)
    assert.equal(decideClose({ ...base, comments: [philip, botSaid(line, '2026-10-19T08:53:00Z', 3815)] }).releases.length, 0, 'the workflow\'s own line does count')
  })

  test('a collaborator writing the shape about someone else releases nothing', () => {
    const daniel = said('d-hinders', line, '2026-10-19T08:53:00Z', 3815)
    assert.equal(decideClose({ ...base, comments: [philip, daniel] }).releases[0].body, line)
  })

  test('Path A skips an issue labelled `epic` (captain decision on the review)', () => {
    const pr = { ...mergedPr, number: 4131, author: 'AntonioSaaranen', authorType: 'User', base: 'dev', defaultBranch: 'dev' }
    const claim = said('AntonioSaaranen', '🔒 CLAIM #3957 — epic', '2026-10-01T00:00:00Z', 3957)
    const epic = { number: 3957, state: 'open', assignees: ['AntonioSaaranen'], labels: ['area:qa', 'Epic'] }
    const d = decideRefs({ pr, refsIssues: [epic], commentsByIssue: { 3957: [claim] } })
    assert.deepEqual(d.releases, [])
    assert.match(d.skipped[0].reason, /labelled `epic`/)
    assert.equal(EPIC_LABEL, 'epic')
    assert.equal(decideRefs({ pr, refsIssues: [{ ...epic, labels: ['area:qa'] }], commentsByIssue: { 3957: [claim] } }).releases.length, 1, 'the same issue without the label is released')
  })

  test('fetchRefsInputs reads the labels and reads no comments for an epic', async () => {
    const calls = []
    const gh = async (args) => {
      calls.push(args)
      if (args[1] === 'graphql') {
        const q = args.find((a) => a.startsWith('query=')) ?? ''
        if (/commits\(/.test(q)) return JSON.stringify({ nodes: [], pageInfo: { hasNextPage: false } })
        return JSON.stringify({ title: 't', body: 'Refs #3957\nRefs #4122' })
      }
      if (args.includes('--paginate')) return JSON.stringify([[]])
      const n = Number(args[1].split('/').pop())
      return JSON.stringify({ state: 'open', closed_at: null, assignees: [], labels: n === 3957 ? [{ name: 'epic' }] : [] })
    }
    const r = await fetchRefsInputs({ gh, repo: 'o/r', prNumber: 1 })
    assert.deepEqual(r.refsIssues.map((i) => [i.number, i.labels]), [[3957, ['epic']], [4122, []]])
    assert.deepEqual(Object.keys(r.commentsByIssue).map(Number), [4122])
  })

  test('only the issues the merge RELEASED are excluded: an open closing candidate that is also `Refs`ed is Path A\'s', async () => {
    const claim = said('AntonioSaaranen', '🔒 CLAIM #4122 — y', '2026-10-20T08:00:01Z', 4122)
    const gh = async (args) => {
      if (args[1] === 'graphql') {
        const q = args.find((a) => a.startsWith('query=')) ?? ''
        if (/closingIssuesReferences/.test(q)) return JSON.stringify({ title: 't', closingIssuesReferences: { nodes: [{ number: 4122 }] } })
        if (/commits\(/.test(q)) return JSON.stringify({ nodes: [], pageInfo: { hasNextPage: false } })
        return JSON.stringify({ title: 't', body: 'Refs #4122' })
      }
      if (args.includes('--paginate')) {
        const n = Number(args[args.length - 1].match(/issues\/(\d+)\//)[1])
        return JSON.stringify([n === 4122 ? [rest(claim)] : []])
      }
      return JSON.stringify({ state: 'open', closed_at: null, assignees: [{ login: 'AntonioSaaranen' }], labels: [] })
    }
    const prepared = await prepareMerge({ pr: { ...mergedPr, number: 4131, author: 'AntonioSaaranen', authorType: 'User' }, gh, repo: 'o/r', log: () => {} })
    assert.deepEqual(prepared.decision.releases, [], 'GitHub did not close it')
    assert.deepEqual(prepared.refs.releases.map((r) => r.issue), [4122])
  })
})
