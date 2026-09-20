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
import { decide, apply, fetchInputs, prFromPayload, AUTO_RELEASE_MARK } from './release-on-merge.mjs'
import { parse } from './claim-assignee.mjs'

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
    const r = decide({ pr: mergedPr, closingIssues: [closedByMerge(1289), closedByMerge(3134)] })
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
    assert.match(r.skipped[0].reason, /still open/)
  })

  test('an issue closed BEFORE this merge — merely mentioned — is skipped (the #3187 self-test)', () => {
    // PR #3187's own body prose linked #2268, closed 2026-09-02 by a person.
    // GitHub's merge is a no-op on it; releasing it would post a false line on
    // the issue and on #1289.
    const r = decide({ pr: mergedPr, closingIssues: [{ number: 2268, assignees: ['d-hinders'], state: 'closed', closedAt: '2026-09-02T10:13:48Z' }, closedByMerge(3177)] })
    assert.deepEqual(r.releases.map((x) => x.issue), [3177])
    assert.equal(r.skipped[0].issue, 2268)
    assert.match(r.skipped[0].reason, /before this merge/)
  })

  test('closed_at a moment before merged_at is still this merge (tolerance)', () => {
    const r = decide({ pr: mergedPr, closingIssues: [{ number: 3134, assignees: [], state: 'closed', closedAt: '2026-09-20T01:25:40Z' }] })
    assert.deepEqual(r.releases.map((x) => x.issue), [3134])
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

  test('a claim on #1289 earns the channel its release', () => {
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
      if (args[0] === 'api' && args.includes('--paginate')) return JSON.stringify(answers.channelPages ?? [[]])
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

  test('one unreadable candidate (fixes #9999 for a number that is not an issue here) does not cancel the others', async () => {
    const { gh } = recorder({
      closing: [{ number: 3134 }],
      commitPages: [['chore\n\nfixes #9999']],
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
    const done = await apply(decision, { gh, repo: 'd-hinders/Haven-AI', log: (m) => logs.push(m) })
    assert.deepEqual(calls.map((c) => c.args.slice(0, 3)), [
      ['issue', 'comment', '3134'],
      ['issue', 'edit', '3134'],
      ['issue', 'edit', '3134'],
      ['issue', 'comment', '1289'],
    ])
    // Body through stdin, never argv.
    assert.ok(calls[0].args.includes('-F') && calls[0].args.includes('-') && calls[0].input.startsWith('🔓 RELEASE #3134'))
    assert.deepEqual(calls.slice(1, 3).map((c) => c.args[c.args.indexOf('--remove-assignee') + 1]), ['PhilipEriksson', 'AntonioSaaranen'])
    assert.deepEqual(done.map((d) => d.kind), ['comment', 'unassign', 'unassign', 'channel'])
    assert.ok(logs.some((l) => /left #3141 alone/.test(l)))
  })

  test('no channel copy when the decision has none', async () => {
    const decision = decide({ pr: mergedPr, closingIssues: [closedByMerge(3134)] })
    const { gh, calls } = recorder()
    await apply(decision, { gh, repo: 'o/r', log: () => {} })
    assert.ok(!calls.some((c) => c.args[2] === '1289'))
  })

  test('a refused write is logged and the rest still happens — never a thrown build failure', async () => {
    const decision = decide({ pr: mergedPr, closingIssues: [closedByMerge(3134), closedByMerge(3135)] })
    const logs = []
    const { gh } = recorder({ refuse: (args) => args[2] === '3134' })
    const done = await apply(decision, { gh, repo: 'o/r', log: (m) => logs.push(m) })
    assert.deepEqual(done.map((d) => `${d.kind}:${d.issue}`), ['comment:3135', 'unassign:3135'])
    assert.ok(logs.some((l) => /could not comment on #3134/.test(l)))
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
