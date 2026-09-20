// Tests for the PR ownership gate (`pr-ownership-gate.mjs`, #3179).
// Run with: node --test scripts/ci/pr-ownership-gate.test.mjs
// (also collected by the `ci_config_checks` job's `scripts/ci/*.test.mjs` glob)

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { evaluate, collect, prFromPayload } from './pr-ownership-gate.mjs'
import { CHANNEL_ISSUE } from './coordination-channel.mjs'

const CLI = fileURLToPath(new URL('./pr-ownership-gate.mjs', import.meta.url))

// The #3015 shape: Antonio's claim on #1289 stood at 13:03Z; Daniel's PR #3022
// (13:28Z) would close #3015.
const NOW = Date.parse('2026-09-15T13:28:09Z')
const pr = { number: 3022, author: 'd-hinders', draft: false, base: 'dev', defaultBranch: 'dev' }
const antonio = { holder: 'AntonioSaaranen', claim: { createdAt: '2026-09-15T13:03:08Z', body: '🔒 CLAIM #3015 — branch `fix/3015-boolean-env-flags` — touches: config.ts', onIssue: CHANNEL_ISSUE, htmlUrl: 'https://github.com/d-hinders/Haven-AI/issues/1289#issuecomment-1' }, lastActivityAt: '2026-09-15T13:03:08Z' }

describe('the verdict (#3179 acceptance fixtures)', () => {
  test('claimed by other → fail, naming the holder, the age, the branch, the link and both ways out', () => {
    const r = evaluate({ pr, issues: [{ number: 3015, state: 'open', assignees: ['AntonioSaaranen'], live: [antonio] }], nowMs: NOW })
    assert.equal(r.verdict, 'fail')
    assert.match(r.report, /^❌ PR ownership gate: this pull request would close an issue held by someone else\./)
    assert.match(r.report, new RegExp(`- #3015: @AntonioSaaranen claimed it 25 min ago on #${CHANNEL_ISSUE} \\(branch \`fix/3015-boolean-env-flags\`\\) — https://github\\.com/.*issuecomment-1\\.`))
    assert.match(r.report, /holder posts `🔓 RELEASE #<issue>`/)
    assert.match(r.report, /change `Closes #<issue>` to `Refs #<issue>`/)
    assert.deepEqual(r.findings.map((f) => f.issue), [3015])
  })

  test('claimed by the author → pass (mutation: invert the author comparison and this goes red)', () => {
    const own = { ...antonio, holder: 'd-hinders' }
    const r = evaluate({ pr, issues: [{ number: 3015, state: 'open', assignees: ['d-hinders'], live: [own] }], nowMs: NOW })
    assert.equal(r.verdict, 'pass')
    assert.deepEqual(r.findings, [])
  })

  test('unclaimed → pass', () => {
    assert.equal(evaluate({ pr, issues: [{ number: 3015, state: 'open', assignees: [], live: [] }], nowMs: NOW }).verdict, 'pass')
    assert.equal(evaluate({ pr, issues: [] }).verdict, 'pass')
  })

  test('draft → pass, even when the issue is held by someone else', () => {
    const r = evaluate({ pr: { ...pr, draft: true }, issues: [{ number: 3015, state: 'open', assignees: ['AntonioSaaranen'], live: [antonio] }], nowMs: NOW })
    assert.equal(r.verdict, 'pass')
    assert.match(r.reason, /draft/)
  })

  test('two closes, one foreign → fail naming WHICH', () => {
    const r = evaluate({
      pr,
      issues: [
        { number: 3015, state: 'open', assignees: ['AntonioSaaranen'], live: [antonio] },
        { number: 3021, state: 'open', assignees: ['d-hinders'], live: [] },
      ],
      nowMs: NOW,
    })
    assert.equal(r.verdict, 'fail')
    assert.deepEqual(r.findings.map((f) => f.issue), [3015])
    assert.match(r.report, /- #3015: /)
    assert.doesNotMatch(r.report, /- #3021: /)
  })

  test('a tracking assignee with no live claim still counts (the issue text: assignee ≠ author fails)', () => {
    const r = evaluate({ pr, issues: [{ number: 3015, state: 'open', assignees: ['PhilipEriksson'], live: [] }], nowMs: NOW })
    assert.equal(r.verdict, 'fail')
    assert.match(r.report, /assigned to @PhilipEriksson \(no live claim comment found/)
  })

  test('genuinely later activity DOES earn the "last active" clause (positive direction)', () => {
    // Mutation `const active = ''` must go red here; the mirror case above only
    // proves the clause is absent when it should be.
    const later = { ...antonio, lastActivityAt: '2026-09-15T13:20:00Z' } // 17 min after the claim
    const r = evaluate({ pr, issues: [{ number: 3015, state: 'open', assignees: [], live: [later] }], nowMs: NOW })
    assert.ok(r.report.includes(`claimed it 25 min ago on #${CHANNEL_ISSUE} (branch \`fix/3015-boolean-env-flags\`), last active on it 8 min ago`), r.report)
  })

  test('a live holder who is not assigned still counts (the #3178 holder rule)', () => {
    const r = evaluate({ pr, issues: [{ number: 3015, state: 'open', assignees: [], live: [antonio] }], nowMs: NOW })
    assert.equal(r.verdict, 'fail')
  })

  test('closed candidates and pull-request numbers are skipped', () => {
    const r = evaluate({ pr, issues: [
      { number: 3010, state: 'closed', assignees: ['AntonioSaaranen'], live: [antonio] },
      { number: 3020, state: 'open', isPullRequest: true, assignees: ['AntonioSaaranen'], live: [] },
    ], nowMs: NOW })
    assert.equal(r.verdict, 'pass')
  })

  test('a merge into a non-default branch passes — GitHub closes nothing there', () => {
    const r = evaluate({ pr: { ...pr, base: 'main' }, issues: [{ number: 3015, state: 'open', assignees: ['AntonioSaaranen'], live: [antonio] }], nowMs: NOW })
    assert.equal(r.verdict, 'pass')
  })

  test('an unreadable candidate FAILS CLOSED when nothing else already fails', () => {
    const r = evaluate({ pr, issues: [{ number: 9999, unreadable: true, assignees: [], live: [] }], nowMs: NOW })
    assert.equal(r.verdict, 'fail')
    assert.match(r.report, /could not read #9999/)
  })

  test('a bot assignee (assignable coding agent) is nobody\'s claim', () => {
    const r = evaluate({ pr, issues: [{ number: 3015, state: 'open', assignees: ['copilot-swe-agent[bot]'], live: [] }], nowMs: NOW })
    assert.equal(r.verdict, 'pass')
  })

  test('logins compare case-insensitively', () => {
    const r = evaluate({ pr: { ...pr, author: 'D-Hinders' }, issues: [{ number: 3015, state: 'open', assignees: ['d-hinders'], live: [] }], nowMs: NOW })
    assert.equal(r.verdict, 'pass')
  })

  test('the report never parses as a claim or release marker', async () => {
    const { parse } = await import('./claim-assignee.mjs')
    const r = evaluate({ pr, issues: [{ number: 3015, state: 'open', assignees: ['AntonioSaaranen'], live: [antonio] }], nowMs: NOW })
    assert.deepEqual(parse({ body: r.report, onIssue: 3015 }), { claim: [], release: [] })
  })
})

describe('collect through an injected gh', () => {
  const recorder = (answers) => {
    const calls = []
    const gh = async (args) => {
      calls.push(args)
      if (args[0] === 'api' && args[1] === 'graphql') {
        const q = args.find((a) => a.startsWith('query=')) ?? ''
        if (/closingIssuesReferences/.test(q)) return JSON.stringify({ title: 't', closingIssuesReferences: { nodes: answers.closing ?? [] } })
        if (/commits\(/.test(q)) return JSON.stringify({ nodes: [], pageInfo: { hasNextPage: false } })
      }
      if (args[0] === 'api' && args.includes('--paginate')) {
        const n = Number(args[args.length - 1].match(/issues\/(\d+)\//)[1])
        return JSON.stringify([answers.comments?.(n) ?? []])
      }
      if (args[0] === 'api' && /^repos\/[^/]+\/[^/]+\/issues\/\d+$/.test(args[1])) {
        const n = Number(args[1].split('/').pop())
        return JSON.stringify(answers.issue(n))
      }
      return ''
    }
    return { gh, calls }
  }

  test('reads candidates, then per open candidate the claim state, and reports live holders other than the author', async () => {
    const { gh } = recorder({
      closing: [{ number: 3015 }],
      issue: () => ({ state: 'open', closed_at: null, assignees: [{ login: 'AntonioSaaranen' }] }),
      comments: (n) => (n === CHANNEL_ISSUE ? [{ user: { login: 'AntonioSaaranen', type: 'User' }, author_association: 'COLLABORATOR', body: '🔒 CLAIM #3015 — branch `fix/3015-x`', created_at: new Date(NOW - 25 * 60_000).toISOString(), html_url: 'https://x/1' }] : []),
    })
    const { issues } = await collect({ gh, repo: 'o/r', prNumber: 3022, author: 'd-hinders', nowMs: NOW })
    assert.equal(issues.length, 1)
    assert.deepEqual(issues[0].assignees, ['AntonioSaaranen'])
    assert.equal(issues[0].live.length, 1)
    assert.equal(issues[0].live[0].holder, 'AntonioSaaranen')
    assert.equal(issues[0].live[0].claim.htmlUrl, 'https://x/1')
    assert.equal(evaluate({ pr, issues, nowMs: NOW }).verdict, 'fail')
  })

  test('a claim posted AFTER the author\'s own does not block the author\'s PR (a refused claim is not a claim)', async () => {
    // #3178 refused Philip's later claim; the gate must not resurrect it.
    const antonioAt = new Date(NOW - 2 * 3_600_000).toISOString()
    const philipAt = new Date(NOW - 1 * 3_600_000).toISOString()
    const { gh } = recorder({
      closing: [{ number: 4242 }],
      issue: () => ({ state: 'open', closed_at: null, assignees: [{ login: 'AntonioSaaranen' }] }),
      comments: (n) => (n === CHANNEL_ISSUE ? [
        { user: { login: 'AntonioSaaranen', type: 'User' }, author_association: 'COLLABORATOR', body: '🔒 CLAIM #4242 — branch `feat/4242-a`', created_at: antonioAt, html_url: 'https://x/A' },
        { user: { login: 'PhilipEriksson', type: 'User' }, author_association: 'COLLABORATOR', body: '🔒 CLAIM #4242 — branch `feat/4242-p`', created_at: philipAt, html_url: 'https://x/P' },
      ] : []),
    })
    const { issues } = await collect({ gh, repo: 'o/r', prNumber: 1, author: 'AntonioSaaranen', nowMs: NOW })
    assert.equal(evaluate({ pr: { ...pr, author: 'AntonioSaaranen' }, issues, nowMs: NOW }).verdict, 'pass')
    // …while Philip's PR on the same issue is blocked by Antonio's older claim.
    const { issues: theirs } = await collect({ gh, repo: 'o/r', prNumber: 2, author: 'PhilipEriksson', nowMs: NOW })
    assert.equal(evaluate({ pr: { ...pr, author: 'PhilipEriksson' }, issues: theirs, nowMs: NOW }).verdict, 'fail')
  })

  test('the author\'s own later re-claim or channel copy does not resurrect a refused foreign claim (hold start, not newest claim)', async () => {
    const t0 = new Date(NOW - 6 * 3_600_000).toISOString() // Antonio claims on the issue
    const t1 = new Date(NOW - 5 * 3_600_000).toISOString() // Philip claims on the channel → refused by #3178
    const t2 = new Date(NOW - 4.5 * 3_600_000).toISOString() // Antonio posts his channel copy
    const { gh } = recorder({
      closing: [{ number: 4242 }],
      issue: () => ({ state: 'open', closed_at: null, assignees: [{ login: 'AntonioSaaranen' }] }),
      comments: (n) => (n === CHANNEL_ISSUE
        ? [{ user: { login: 'PhilipEriksson', type: 'User' }, author_association: 'COLLABORATOR', body: '🔒 CLAIM #4242 — branch `feat/4242-p`', created_at: t1, html_url: 'https://x/P' },
           { user: { login: 'AntonioSaaranen', type: 'User' }, author_association: 'COLLABORATOR', body: '🔒 CLAIM #4242 — branch `feat/4242-a`', created_at: t2, html_url: 'https://x/A2' }]
        : [{ user: { login: 'AntonioSaaranen', type: 'User' }, author_association: 'COLLABORATOR', body: '🔒 CLAIM #4242 — branch `feat/4242-a`', created_at: t0, html_url: 'https://x/A1' }]),
    })
    const { issues } = await collect({ gh, repo: 'o/r', prNumber: 1, author: 'AntonioSaaranen', nowMs: NOW })
    assert.equal(evaluate({ pr: { ...pr, author: 'AntonioSaaranen' }, issues, nowMs: NOW }).verdict, 'pass')
    // …and from Philip's side the report names Antonio's HOLD START (first
    // claim, on the issue, https://x/A1), not his newest channel copy, and
    // does not append a "last active" clause for a mere mirror.
    const { issues: theirs } = await collect({ gh, repo: 'o/r', prNumber: 2, author: 'PhilipEriksson', nowMs: NOW })
    const r = evaluate({ pr: { ...pr, author: 'PhilipEriksson' }, issues: theirs, nowMs: NOW })
    assert.equal(r.verdict, 'fail')
    assert.equal(r.findings[0].holders[0].url, 'https://x/A1')
    assert.equal(r.findings[0].holders[0].where, '#4242')
    assert.equal(r.findings[0].holders[0].claimedAt, t0)
    assert.match(r.report, /claimed it 6 h ago on #4242/)
    assert.doesNotMatch(r.report, /last active on it/)
  })

  test('a closed candidate is carried but not read for claims', async () => {
    const { gh, calls } = recorder({ closing: [{ number: 3010 }], issue: () => ({ state: 'closed', closed_at: '2026-09-01T00:00:00Z', assignees: [] }) })
    const { issues } = await collect({ gh, repo: 'o/r', prNumber: 1, author: 'x' })
    assert.equal(issues[0].state, 'closed')
    assert.ok(!calls.some((a) => a.includes('--paginate')))
  })

  test('prFromPayload reads number, author, draft, base and default branch', () => {
    assert.deepEqual(prFromPayload({ number: 3022, draft: true, user: { login: 'd-hinders' }, base: { ref: 'dev', repo: { default_branch: 'dev' } } }), { number: 3022, author: 'd-hinders', draft: true, base: 'dev', defaultBranch: 'dev' })
  })
})

describe('CLI end to end with a stub gh on PATH', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pr-ownership-gate-'))
  const recent = new Date(Date.now() - 25 * 60_000).toISOString()
  const ghStub = path.join(dir, 'gh')
  writeFileSync(ghStub, `#!/bin/sh
case "$*" in
  *"closingIssuesReferences"*) echo '{"title":"t","closingIssuesReferences":{"nodes":[{"number":3015}]}}' ;;
  *"commits("*) echo '{"nodes":[],"pageInfo":{"hasNextPage":false}}' ;;
  *"issues/3015/comments"*) echo '[[]]' ;;
  *"issues/${CHANNEL_ISSUE}/comments"*) echo '[[{"user":{"login":"AntonioSaaranen","type":"User"},"author_association":"COLLABORATOR","body":"🔒 CLAIM #3015 — branch \`fix/3015-x\`","created_at":"${recent}","html_url":"https://x/1"}]]' ;;
  *"issues/3015"*) echo '{"state":"open","closed_at":null,"assignees":[{"login":"AntonioSaaranen"}]}' ;;
  *) echo '' ;;
esac
`)
  execFileSync('chmod', ['+x', ghStub])
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, GITHUB_REPOSITORY: 'o/r' }
  const eventFile = (name, pull_request) => {
    const p = path.join(dir, name)
    writeFileSync(p, JSON.stringify({ action: 'opened', pull_request }))
    return p
  }
  const base = { number: 3022, draft: false, user: { login: 'd-hinders' }, base: { ref: 'dev', repo: { default_branch: 'dev' } } }
  const run = (file, e = env) => {
    try {
      return { status: 0, out: execFileSync(process.execPath, [CLI, '--event', file], { encoding: 'utf8', env: e }) }
    } catch (err) {
      return { status: err.status, out: String(err.stdout ?? '') }
    }
  }

  test('foreign holder → exit 1 with the report', () => {
    const r = run(eventFile('foreign.json', base))
    assert.equal(r.status, 1)
    assert.match(r.out, /would close an issue held by someone else/)
    assert.ok(r.out.includes(`@AntonioSaaranen claimed it 25 min ago on #${CHANNEL_ISSUE}`), r.out)
  })

  test('author holds it → exit 0', () => {
    const r = run(eventFile('own.json', { ...base, user: { login: 'AntonioSaaranen' } }))
    assert.equal(r.status, 0)
    assert.match(r.out, /✅ PR ownership gate/)
  })

  test('draft → exit 0 without reading anything', () => {
    const r = run(eventFile('draft.json', { ...base, draft: true }), { ...process.env, PATH: '', GITHUB_REPOSITORY: 'o/r' })
    assert.equal(r.status, 0)
    assert.match(r.out, /draft/)
  })

  test('no gh on PATH → exit 1, fails closed, says so', () => {
    const r = run(eventFile('noread.json', base), { ...process.env, PATH: '', GITHUB_REPOSITORY: 'o/r' })
    assert.equal(r.status, 1)
    assert.match(r.out, /fails closed/)
  })

  test('missing --event → exit 2', () => {
    assert.throws(() => execFileSync(process.execPath, [CLI], { stdio: 'pipe', env }), (e) => e.status === 2)
  })
})

describe('the workflow cannot mask the verdict', () => {
  const yml = readFileSync(new URL('../../.github/workflows/pr-ownership-gate.yml', import.meta.url), 'utf8')

  test('the judging step runs under bash with pipefail, so `| tee` cannot turn exit 1 green', () => {
    // Actions' default `run:` shell is `bash -e {0}` WITHOUT pipefail;
    // `bash -e -c 'false | tee /dev/null'` exits 0. Mutation: drop either line
    // and this goes red.
    // Anchored on the STEP, not the file: the header comment also says
    // "set -o pipefail", so a file-wide match could not fail (it did not, once).
    const step = yml.slice(yml.indexOf('- name: Judge the issues'))
    assert.match(step, /\n\s+shell: bash\n\s+run: \|\n\s+set -o pipefail\n\s+node scripts\/ci\/pr-ownership-gate\.mjs --event "\$GITHUB_EVENT_PATH" \| tee -a "\$GITHUB_STEP_SUMMARY"\n/)
  })

  test('the judge is the default branch\'s copy: pull_request_target, read-only token, no ref on the checkout, one run per PR', () => {
    assert.match(yml, /^on:\n  pull_request_target:/m)
    assert.match(yml, /concurrency:\n  group: pr-ownership-gate-\$\{\{ github\.event\.pull_request\.number \}\}\n  cancel-in-progress: true/)
    assert.doesNotMatch(yml, /^on:\n  pull_request:/m)
    assert.match(yml, /permissions:\n  contents: read\n  issues: read\n  pull-requests: read/)
    // No `ref:` under the checkout step — the default on pull_request_target is the DEFAULT branch.
    const checkout = yml.slice(yml.indexOf('actions/checkout@v4'), yml.indexOf('actions/setup-node@v4'))
    assert.doesNotMatch(checkout, /ref:/)
  })
})
