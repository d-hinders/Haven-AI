// Tests for the External intake gate (`external-intake-gate.mjs`, #4200 part C).
// Run with: node --test scripts/ci/external-intake-gate.test.mjs
// (also collected by the `ci_config_checks` job's `scripts/ci/*.test.mjs` glob)

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { evaluate, collect, prFromPayload } from './external-intake-gate.mjs'

const CLI = fileURLToPath(new URL('./external-intake-gate.mjs', import.meta.url))

// Maintainers by the collaborator-permission API (measured 2026-10-21).
const PERMS = { 'd-hinders': 'admin', PhilipEriksson: 'write', AntonioSaaranen: 'write', rezearcher: 'read', drive_by: 'read' }
const unlabel = (login, type = 'User') => ({ event: 'unlabeled', label: { name: 'external' }, actor: { login, type }, created_at: '2026-10-21T09:00:00Z' })
const relabel = (login, type = 'User') => ({ event: 'labeled', label: { name: 'external' }, actor: { login, type }, created_at: '2026-10-21T10:00:00Z' })
const botLabel = { event: 'labeled', label: { name: 'external' }, actor: { login: 'github-actions[bot]', type: 'Bot' }, created_at: '2026-10-21T08:00:00Z' }

/**
 * A stub `gh` over a small world.
 * items: { [n]: { login, type?, assoc, state?, pr?, events? } }
 * pr:    { closing?: number[], title?: string, commits?: string[] }
 */
function world({ items, pr = {} }) {
  const calls = []
  const gh = async (args) => {
    calls.push(args)
    const joined = args.join(' ')
    if (args[1] === 'graphql') {
      const q = args.find((a) => a.startsWith('query=')) ?? ''
      if (/closingIssuesReferences/.test(q)) return JSON.stringify({ title: pr.title ?? 'feat: x', closingIssuesReferences: { nodes: (pr.closing ?? []).map((number) => ({ number })) } })
      if (/commits\(/.test(q)) return JSON.stringify({ nodes: (pr.commits ?? []).map((message, i) => ({ commit: { oid: `c${i}`, message } })), pageInfo: { hasNextPage: false } })
      return ''
    }
    let m
    if ((m = joined.match(/collaborators\/([^/]+)\/permission/))) {
      if (!(m[1] in PERMS)) throw new Error(`${m[1]} is not a user (HTTP 404)`)
      return JSON.stringify({ permission: PERMS[m[1]] })
    }
    if ((m = joined.match(/issues\/(\d+)\/events/))) return JSON.stringify([items[m[1]]?.events ?? []])
    if ((m = joined.match(/repos\/o\/r\/issues\/(\d+)$/))) {
      const it = items[m[1]]
      if (!it) throw new Error(`HTTP 404 #${m[1]}`)
      return JSON.stringify({ user: { login: it.login, type: it.type ?? 'User' }, author_association: it.assoc, state: it.state ?? 'open', closed_at: null, assignees: [], ...(it.pr ? { pull_request: {} } : {}) })
    }
    return ''
  }
  return { gh, calls }
}

const PR = 9000
const prOn = (base = 'dev', draft = false) => ({ number: PR, base, draft })
const maintainerPr = { login: 'd-hinders', assoc: 'OWNER', pr: true }
async function verdict({ items, pr: prShape = {}, payload = prOn() }) {
  const { gh } = world({ items: { [PR]: maintainerPr, ...items }, pr: prShape })
  const { prStanding, issues } = await collect({ gh, repo: 'o/r', prNumber: PR })
  return evaluate({ pr: payload, prStanding, issues })
}

describe('the PR itself (#4200 acceptance)', () => {
  test('a maintainer PR with no closing ref passes', async () => {
    assert.equal((await verdict({ items: {} })).verdict, 'pass')
  })

  for (const labelled of [true, false]) {
    test(`a NONE PR fails ${labelled ? 'carrying' : 'WITHOUT'} the label — the label is not the control`, async () => {
      const r = await verdict({ items: { [PR]: { login: 'rezearcher', assoc: 'NONE', pr: true, events: labelled ? [botLabel] : [] } } })
      assert.equal(r.verdict, 'fail')
      assert.ok(r.report.includes(`- This pull request (#${PR}) is by @rezearcher (NONE), not a maintainer, and no maintainer has accepted it — a maintainer removes \`external\` from #${PR}, then re-runs this check or edits the PR.`), r.report)
    })
  }

  test('passes once a maintainer-actor unlabeled: external exists', async () => {
    const r = await verdict({ items: { [PR]: { login: 'rezearcher', assoc: 'NONE', pr: true, events: [botLabel, unlabel('PhilipEriksson')] } } })
    assert.equal(r.verdict, 'pass')
  })

  test('still fails when the unlabel actor is not a maintainer (read permission, or a Bot)', async () => {
    for (const ev of [unlabel('drive_by'), unlabel('github-actions[bot]', 'Bot'), unlabel('rezearcher')]) {
      const r = await verdict({ items: { [PR]: { login: 'rezearcher', assoc: 'NONE', pr: true, events: [botLabel, ev] } } })
      assert.equal(r.verdict, 'fail', JSON.stringify(ev))
    }
  })

  test('a later maintainer re-label revokes the acceptance', async () => {
    const r = await verdict({ items: { [PR]: { login: 'rezearcher', assoc: 'NONE', pr: true, events: [botLabel, unlabel('d-hinders'), relabel('AntonioSaaranen')] } } })
    assert.equal(r.verdict, 'fail')
  })

  test('an unlabel of a DIFFERENT label by a maintainer accepts nothing', async () => {
    const other = { ...unlabel('d-hinders'), label: { name: 'pending-review' } }
    const r = await verdict({ items: { [PR]: { login: 'rezearcher', assoc: 'NONE', pr: true, events: [other] } } })
    assert.equal(r.verdict, 'fail')
  })

  for (const assoc of ['FIRST_TIME_CONTRIBUTOR', 'FIRST_TIMER', 'MANNEQUIN', 'CONTRIBUTOR', 'NONE']) {
    test(`${assoc} is external`, async () => {
      assert.equal((await verdict({ items: { [PR]: { login: 'someone', assoc, pr: true } } })).verdict, 'fail')
    })
  }
  for (const assoc of ['OWNER', 'MEMBER', 'COLLABORATOR']) {
    test(`${assoc} is a maintainer`, async () => {
      assert.equal((await verdict({ items: { [PR]: { login: 'someone', assoc, pr: true } } })).verdict, 'pass')
    })
  }

  test('github-actions[bot] (type Bot, association CONTRIBUTOR) is not external', async () => {
    assert.equal((await verdict({ items: { [PR]: { login: 'github-actions[bot]', type: 'Bot', assoc: 'CONTRIBUTOR', pr: true } } })).verdict, 'pass')
  })

  test('a non-dev base passes; a draft passes — even for a NONE PR', () => {
    const blocked = { number: PR, author: 'rezearcher', association: 'NONE', blocked: true }
    assert.equal(evaluate({ pr: prOn('main'), prStanding: blocked, issues: [] }).verdict, 'pass')
    assert.equal(evaluate({ pr: prOn('dev', true), prStanding: blocked, issues: [] }).verdict, 'pass')
    assert.equal(evaluate({ pr: prOn('dev'), prStanding: blocked, issues: [] }).verdict, 'fail')
  })
})

describe('the issues the PR closes', () => {
  const ext = (events = []) => ({ login: 'rezearcher', assoc: 'NONE', events })

  for (const labelled of [true, false]) {
    test(`a maintainer PR closing an open NONE issue fails ${labelled ? 'labelled' : 'unlabelled'}, and passes after acceptance`, async () => {
      const before = await verdict({ items: { 4107: ext(labelled ? [botLabel] : []) }, pr: { closing: [4107] } })
      assert.equal(before.verdict, 'fail')
      assert.ok(before.report.includes('- It closes #4107, opened by @rezearcher (NONE), not a maintainer, and not accepted — a maintainer removes `external` from #4107, then re-runs this check or edits the PR.'), before.report)
      const after = await verdict({ items: { 4107: ext([botLabel, unlabel('d-hinders')]) }, pr: { closing: [4107] } })
      assert.equal(after.verdict, 'pass')
    })
  }

  test('a closing keyword in a commit message counts (fetchCandidates, unchanged)', async () => {
    const r = await verdict({ items: { 4107: ext() }, pr: { commits: ['feat: x\n\nCloses #4107'] } })
    assert.equal(r.verdict, 'fail')
  })

  test('the same PR with Refs #n instead of a closing keyword passes, and never reads the issue', async () => {
    const { gh, calls } = world({ items: { [PR]: maintainerPr, 4107: ext() }, pr: { title: 'revert: x (Refs #4107)', commits: ['revert: x\n\nRefs #4107'] } })
    const { prStanding, issues } = await collect({ gh, repo: 'o/r', prNumber: PR })
    assert.deepEqual(issues, [])
    assert.equal(evaluate({ pr: prOn(), prStanding, issues }).verdict, 'pass')
    assert.ok(!calls.some((a) => /issues\/4107/.test(a.join(' '))))
  })

  test('a closed external candidate is skipped — not read for standing in collect, and not judged in evaluate', async () => {
    const { gh, calls } = world({ items: { [PR]: maintainerPr, 4107: { ...ext(), state: 'closed' } }, pr: { closing: [4107] } })
    const { prStanding, issues } = await collect({ gh, repo: 'o/r', prNumber: PR })
    assert.equal(evaluate({ pr: prOn(), prStanding, issues }).verdict, 'pass')
    assert.ok(!calls.some((a) => /issues\/4107\/events/.test(a.join(' '))))
    // evaluate's own skip, on a standing that says blocked but closed:
    const closedBlocked = { number: 4107, state: 'closed', author: 'rezearcher', association: 'NONE', blocked: true }
    assert.equal(evaluate({ pr: prOn(), prStanding: null, issues: [closedBlocked] }).verdict, 'pass')
    assert.equal(evaluate({ pr: prOn(), prStanding: null, issues: [{ ...closedBlocked, state: 'open' }] }).verdict, 'fail')
  })

  test('a Bot-authored PR that closes a blocked issue fails', async () => {
    const r = await verdict({ items: { [PR]: { login: 'github-actions[bot]', type: 'Bot', assoc: 'CONTRIBUTOR', pr: true }, 4107: ext() }, pr: { closing: [4107] } })
    assert.equal(r.verdict, 'fail')
    assert.doesNotMatch(r.report, /This pull request/)
  })

  test('two closes, one external → names only that one', async () => {
    const r = await verdict({ items: { 4107: ext(), 4200: { login: 'd-hinders', assoc: 'OWNER' } }, pr: { closing: [4107, 4200] } })
    assert.equal(r.verdict, 'fail')
    assert.match(r.report, /closes #4107/)
    assert.doesNotMatch(r.report, /closes #4200/)
  })

  test('an unreadable candidate fails closed and says so', async () => {
    const r = await verdict({ items: {}, pr: { closing: [4999] } })
    assert.equal(r.verdict, 'fail')
    assert.match(r.report, /Could not read #4999 .*fails closed/)
  })

  test('an actor whose permission cannot be read fails closed (no silent acceptance)', async () => {
    const r = await verdict({ items: { 4107: ext([unlabel('ghost_account')]) }, pr: { closing: [4107] } })
    assert.equal(r.verdict, 'fail')
    assert.match(r.report, /Could not read #4107 \(.*ghost_account/)
  })
})

describe('replay fixtures (#4107 / #4148 / #4195)', () => {
  const i4107 = { login: 'rezearcher', assoc: 'NONE', state: 'open' } // modelled open
  test('#4107 (NONE) is blocked; a #4148-shaped PR (COLLABORATOR, Closes #4107) fails', async () => {
    const r = await verdict({ items: { [PR]: { login: 'PhilipEriksson', assoc: 'COLLABORATOR', pr: true }, 4107: i4107 }, pr: { title: 'feat(mcp-server): token safety (Closes #4107)', closing: [4107] } })
    assert.equal(r.verdict, 'fail')
    assert.match(r.report, /closes #4107, opened by @rezearcher \(NONE\)/)
  })
  test('a #4195-shaped PR (Refs #4107) passes', async () => {
    const r = await verdict({ items: { [PR]: { login: 'd-hinders', assoc: 'OWNER', pr: true }, 4107: i4107 }, pr: { title: 'revert(mcp-server): remove haven_check_token_safety (#4148)', commits: ['revert\n\nRefs #4107'] } })
    assert.equal(r.verdict, 'pass')
  })
})

describe('payload is routing only', () => {
  test('prFromPayload reads number, draft and base — and no author or labels', () => {
    assert.deepEqual(prFromPayload({ number: 7, draft: true, user: { login: 'x' }, author_association: 'OWNER', labels: [], base: { ref: 'dev' } }), { number: 7, draft: true, base: 'dev' })
  })
})

describe('CLI end to end with a stub gh on PATH', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'external-intake-gate-'))
  const ghStub = path.join(dir, 'gh')
  writeFileSync(ghStub, `#!/bin/sh
case "$*" in
  *"closingIssuesReferences"*) echo '{"title":"t","closingIssuesReferences":{"nodes":[{"number":4107}]}}' ;;
  *"commits("*) echo '{"nodes":[],"pageInfo":{"hasNextPage":false}}' ;;
  *"issues/4107/events"*) echo '[[]]' ;;
  *"issues/4107"*) echo '{"user":{"login":"rezearcher","type":"User"},"author_association":"NONE","state":"open","assignees":[]}' ;;
  *"issues/9000"*) echo '{"user":{"login":"d-hinders","type":"User"},"author_association":"OWNER","state":"open","assignees":[],"pull_request":{}}' ;;
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
  const base = { number: 9000, draft: false, base: { ref: 'dev' } }
  const run = (file, e = env) => {
    try {
      return { status: 0, out: execFileSync(process.execPath, [CLI, '--event', file], { encoding: 'utf8', env: e }) }
    } catch (err) {
      return { status: err.status, out: String(err.stdout ?? '') }
    }
  }

  test('closes an external issue → exit 1 with the report', () => {
    const r = run(eventFile('ext.json', base))
    assert.equal(r.status, 1)
    assert.match(r.out, /❌ External intake gate/)
    assert.match(r.out, /closes #4107/)
  })

  test('base main → exit 0 without reading anything', () => {
    const r = run(eventFile('main.json', { ...base, base: { ref: 'main' } }), { ...process.env, PATH: '', GITHUB_REPOSITORY: 'o/r' })
    assert.equal(r.status, 0)
    assert.match(r.out, /not dev/)
  })

  test('no gh on PATH → exit 1, fails closed', () => {
    const r = run(eventFile('noread.json', base), { ...process.env, PATH: '', GITHUB_REPOSITORY: 'o/r' })
    assert.equal(r.status, 1)
    assert.match(r.out, /fails closed/)
  })

  test('missing --event → exit 2', () => {
    assert.throws(() => execFileSync(process.execPath, [CLI], { stdio: 'pipe', env }), (e) => e.status === 2)
  })
})

describe('the workflow shape', () => {
  const yml = readFileSync(new URL('../../.github/workflows/external-intake-gate.yml', import.meta.url), 'utf8')

  test('pull_request_target with the seven trigger types, read-only token, one run per PR', () => {
    assert.match(yml, /^on:\n  pull_request_target:\n    types: \[opened, edited, synchronize, reopened, ready_for_review, labeled, unlabeled\]\n/m)
    assert.match(yml, /^permissions:\n  contents: read\n  issues: read\n  pull-requests: read\n\n/m)
    assert.match(yml, /concurrency:\n  group: external-intake-gate-\$\{\{ github\.event\.pull_request\.number \}\}\n  cancel-in-progress: true/)
  })

  test('the job is named "External intake gate" (the context the Dev merge ruleset requires)', () => {
    assert.match(yml, /\n    name: External intake gate\n/)
  })

  test('no ref: on the checkout; bash + pipefail on the judging step; no event text in run:', () => {
    const checkout = yml.slice(yml.indexOf('actions/checkout@v4'), yml.indexOf('actions/setup-node@v4'))
    assert.doesNotMatch(checkout, /ref:/)
    const step = yml.slice(yml.indexOf('- name: Judge'))
    assert.match(step, /\n\s+shell: bash\n\s+run: \|\n\s+set -o pipefail\n\s+node scripts\/ci\/external-intake-gate\.mjs --event "\$GITHUB_EVENT_PATH" \| tee -a "\$GITHUB_STEP_SUMMARY"\n/)
    assert.doesNotMatch(yml, /\$\{\{\s*github\.event\.[^}]*\.(title|body)\s*\}\}/)
  })
})
