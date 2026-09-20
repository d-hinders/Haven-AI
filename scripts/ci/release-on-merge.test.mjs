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

const mergedPr = { number: 3186, merged: true, author: 'AntonioSaaranen', mergeCommit: 'a29d5469abcdef0123456789', base: 'dev' }

describe('the merged filter is the whole safety of this workflow', () => {
  test('a closed-but-unmerged PR releases nothing and unassigns nobody', () => {
    // #3177 acceptance mutation: remove the `merged !== true` return and this
    // goes red. A PR closed without merging did NOT finish the work — its
    // claim is still live, and releasing it would hand the issue to whoever
    // reads next.
    const r = decide({ pr: { ...mergedPr, merged: false }, closingIssues: [{ number: 3134, assignees: ['AntonioSaaranen'] }] })
    assert.deepEqual(r, { releases: [], channel: null })
  })

  test('a missing merged flag is treated as unmerged, never as merged', () => {
    const { merged, ...noFlag } = mergedPr
    assert.deepEqual(decide({ pr: noFlag, closingIssues: [{ number: 3134 }] }), { releases: [], channel: null })
  })

  test('a PR that closes no issue does nothing', () => {
    assert.deepEqual(decide({ pr: mergedPr, closingIssues: [] }), { releases: [], channel: null })
  })
})

describe('what a merge releases', () => {
  test('one release per closed issue, naming the PR, and unassigning everyone left on it', () => {
    const r = decide({
      pr: mergedPr,
      closingIssues: [{ number: 3134, assignees: ['PhilipEriksson'] }, { number: 3135, assignees: [] }],
    })
    assert.equal(r.releases.length, 2)
    const [a, b] = r.releases
    assert.equal(a.issue, 3134)
    assert.match(a.body, /^🔓 RELEASE #3134 — landed as PR #3186 \(squash `a29d5469`, into `dev`\)/)
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
    const [r] = decide({ pr: mergedPr, closingIssues: [{ number: 3134 }] }).releases
    assert.deepEqual(parse({ body: r.body, onIssue: 3134 }), { claim: [], release: [3134] })
  })

  test('the coordination thread itself is never released, even if GitHub lists it', () => {
    const r = decide({ pr: mergedPr, closingIssues: [{ number: 1289 }, { number: 3134 }] })
    assert.deepEqual(r.releases.map((x) => x.issue), [3134])
  })

  test('duplicates and malformed numbers are dropped', () => {
    const r = decide({ pr: mergedPr, closingIssues: [{ number: 3134 }, { number: 3134 }, { number: 'x' }, { number: -1 }] })
    assert.deepEqual(r.releases.map((x) => x.issue), [3134])
  })

  test('a non-hex merge sha or missing base degrades the parenthesis, not the release', () => {
    const [r] = decide({ pr: { ...mergedPr, mergeCommit: null, base: null }, closingIssues: [{ number: 3134 }] }).releases
    assert.match(r.body, /^🔓 RELEASE #3134 — landed as PR #3186 — /)
  })
})

describe('the channel copy is posted only where the claim was', () => {
  const claimOnChannel = '🔒 CLAIM #3134 — epic #3130 slice 4/4 — branch `feat/3134-vocabulary-converge` — Antonio'

  test('a claim on #1289 earns the channel its release', () => {
    const r = decide({ pr: mergedPr, closingIssues: [{ number: 3134 }], channelBodies: ['📣 FYI — promotion tonight', claimOnChannel] })
    assert.ok(r.channel)
    assert.match(r.channel.body, /^🔓 RELEASE #3134 — landed as PR #3186/)
  })

  test('an issue-only claim posts nothing to the channel', () => {
    const r = decide({ pr: mergedPr, closingIssues: [{ number: 3134 }], channelBodies: ['🔒 CLAIM #2999 — something else'] })
    assert.equal(r.channel, null)
    assert.equal(r.releases.length, 1)
  })

  test('a QUOTED claim on the channel is a report, not a claim — no channel copy', () => {
    const r = decide({ pr: mergedPr, closingIssues: [{ number: 3134 }], channelBodies: [`> ${claimOnChannel}`] })
    assert.equal(r.channel, null)
  })

  test('a claim of a different issue that merely MENTIONS ours does not count', () => {
    // Leading-run rule: only #3120 is claimed here.
    const r = decide({ pr: mergedPr, closingIssues: [{ number: 3134 }], channelBodies: ['🔒 CLAIM #3120 — follows #3134'] })
    assert.equal(r.channel, null)
  })

  test('two closed issues, one claimed on the channel — the channel gets one line', () => {
    const r = decide({ pr: mergedPr, closingIssues: [{ number: 3134 }, { number: 3135 }], channelBodies: [claimOnChannel] })
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
  const event = { number: 3186, merged: true, merge_commit_sha: 'a29d5469abcdef', user: { login: 'AntonioSaaranen' }, base: { ref: 'dev' } }
  const closing = [{ number: 3134, assignees: { nodes: [{ login: 'AntonioSaaranen' }] } }]

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
    assert.deepEqual(JSON.parse(out), { releases: [], channel: null })
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
      const key = args.slice(0, 2).join(' ')
      if (key === 'api graphql') return JSON.stringify(answers.closing ?? [])
      if (key === 'api' || args[0] === 'api') {
        if (/\/comments\?/.test(args[1])) return JSON.stringify(answers.page?.(args[1]) ?? [])
        return String(answers.total ?? 0)
      }
      if (answers.refuse?.(args)) throw new Error('HTTP 403')
      return ''
    }
    return { gh, calls }
  }

  test('fetchInputs reads GitHub\'s closing references and the channel\'s last two pages', async () => {
    const { gh, calls } = recorder({
      closing: [{ number: 3134, assignees: { nodes: [{ login: 'AntonioSaaranen' }] } }],
      total: 1380,
      page: (url) => (url.endsWith('page=13') ? [{ body: 'older' }] : [{ body: '🔒 CLAIM #3134 — x' }]),
    })
    const r = await fetchInputs({ gh, repo: 'd-hinders/Haven-AI', prNumber: 3186 })
    assert.deepEqual(r.closingIssues, [{ number: 3134, assignees: ['AntonioSaaranen'] }])
    assert.deepEqual(r.channelBodies, ['older', '🔒 CLAIM #3134 — x'])
    const pages = calls.map((c) => c.args[1]).filter((a) => /comments\?/.test(a))
    assert.deepEqual(pages, ['repos/d-hinders/Haven-AI/issues/1289/comments?per_page=100&page=13', 'repos/d-hinders/Haven-AI/issues/1289/comments?per_page=100&page=14'])
    assert.equal(calls[0].args[0], 'api')
    assert.equal(calls[0].args[1], 'graphql')
  })

  test('a channel with fewer than 100 comments reads one page', async () => {
    const { gh, calls } = recorder({ total: 7 })
    await fetchInputs({ gh, repo: 'o/r', prNumber: 1 })
    assert.deepEqual(calls.map((c) => c.args[1]).filter((a) => /comments\?/.test(a)), ['repos/o/r/issues/1289/comments?per_page=100&page=1'])
  })

  test('apply comments via stdin, unassigns each login, and posts the channel copy', async () => {
    const decision = decide({ pr: mergedPr, closingIssues: [{ number: 3134, assignees: ['PhilipEriksson'] }], channelBodies: ['🔒 CLAIM #3134 — x'] })
    const { gh, calls } = recorder()
    const done = await apply(decision, { gh, repo: 'd-hinders/Haven-AI', log: () => {} })
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
  })

  test('no channel copy when the decision has none', async () => {
    const decision = decide({ pr: mergedPr, closingIssues: [{ number: 3134 }] })
    const { gh, calls } = recorder()
    await apply(decision, { gh, repo: 'o/r', log: () => {} })
    assert.ok(!calls.some((c) => c.args[2] === '1289'))
  })

  test('a refused write is logged and the rest still happens — never a thrown build failure', async () => {
    const decision = decide({ pr: mergedPr, closingIssues: [{ number: 3134 }, { number: 3135 }] })
    const logs = []
    const { gh } = recorder({ refuse: (args) => args[2] === '3134' })
    const done = await apply(decision, { gh, repo: 'o/r', log: (m) => logs.push(m) })
    assert.deepEqual(done.map((d) => `${d.kind}:${d.issue}`), ['comment:3135', 'unassign:3135'])
    assert.ok(logs.some((l) => /could not comment on #3134/.test(l)))
  })

  test('prFromPayload reads the event\'s pull_request shape', () => {
    assert.deepEqual(prFromPayload({ number: 3186, merged: true, merge_commit_sha: 'a29d', user: { login: 'A' }, base: { ref: 'dev' } }), { number: 3186, merged: true, author: 'A', mergeCommit: 'a29d', base: 'dev' })
    assert.equal(prFromPayload({}).merged, false)
  })

  test('--event on an unmerged payload prints the empty decision without touching gh', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'release-on-merge-ev-'))
    const p = path.join(dir, 'event.json')
    writeFileSync(p, JSON.stringify({ action: 'closed', pull_request: { number: 5, merged: false, user: { login: 'x' } } }))
    // PATH emptied: any gh call would fail loudly instead of reaching GitHub.
    const out = execFileSync(process.execPath, [CLI, '--event', p, '--apply'], { encoding: 'utf8', env: { ...process.env, PATH: '' } })
    assert.deepEqual(JSON.parse(out), { releases: [], channel: null })
  })
})
