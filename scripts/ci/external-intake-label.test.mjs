// Tests for the external intake label decision (`external-intake-label.mjs`,
// #4200 part A) and the shared definitions (`external-intake.mjs`).
// Run with: node --test scripts/ci/external-intake-label.test.mjs
// (also collected by the `ci_config_checks` job's `scripts/ci/*.test.mjs` glob)

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { decide, fromEvent, apply, intakeComment } from './external-intake-label.mjs'
import { isExternalAuthor, acceptanceFrom, refusalLine, withPrefix, withoutPrefix, TITLE_PREFIX } from './external-intake.mjs'
import { TRUSTED_ASSOCIATIONS } from './claim-collision.mjs'

const item = (over = {}) => ({ number: 4107, title: 'Add token safety', author: 'rezearcher', association: 'NONE', userType: 'User', ...over })

describe('who is external (association × user.type)', () => {
  for (const association of ['NONE', 'FIRST_TIME_CONTRIBUTOR', 'FIRST_TIMER', 'MANNEQUIN', 'CONTRIBUTOR']) {
    test(`${association} User → external`, () => assert.equal(isExternalAuthor({ association, userType: 'User' }), true))
    test(`${association} Bot → not external`, () => assert.equal(isExternalAuthor({ association, userType: 'Bot' }), false))
  }
  for (const association of ['OWNER', 'MEMBER', 'COLLABORATOR', 'collaborator']) {
    test(`${association} User → maintainer, not external`, () => assert.equal(isExternalAuthor({ association, userType: 'User' }), false))
  }
  test('a missing association is external (fails toward blocked)', () => assert.equal(isExternalAuthor({ association: undefined, userType: 'User' }), true))
  test('the trusted set is claim-collision.mjs\'s, imported — not a copy', () => {
    const src = readFileSync(new URL('./external-intake.mjs', import.meta.url), 'utf8')
    assert.match(src, /import \{ TRUSTED_ASSOCIATIONS \} from '\.\/claim-collision\.mjs'/)
    assert.doesNotMatch(src, /new Set\(\['OWNER'/)
    assert.deepEqual([...TRUSTED_ASSOCIATIONS].sort(), ['COLLABORATOR', 'MEMBER', 'OWNER'])
  })
})

describe('acceptance is a maintainer-actor unlabel, never the label\'s absence', () => {
  const maint = (a) => ['d-hinders', 'PhilipEriksson'].includes(a.login) && a.type === 'User'
  const ev = (event, login, type = 'User', name = 'external') => ({ event, label: { name }, actor: { login, type }, created_at: '2026-10-21T09:00:00Z' })
  test('no events → not accepted', () => assert.equal(acceptanceFrom([], maint).accepted, false))
  test('maintainer unlabel → accepted, naming who', () => assert.deepEqual(acceptanceFrom([ev('labeled', 'github-actions[bot]', 'Bot'), ev('unlabeled', 'PhilipEriksson')], maint), { accepted: true, by: 'PhilipEriksson', at: '2026-10-21T09:00:00Z' }))
  test('non-maintainer or Bot unlabel → not accepted', () => {
    assert.equal(acceptanceFrom([ev('unlabeled', 'rezearcher')], maint).accepted, false)
    assert.equal(acceptanceFrom([ev('unlabeled', 'd-hinders', 'Bot')], maint).accepted, false)
  })
  test('a maintainer unlabel of another label → not accepted', () => assert.equal(acceptanceFrom([ev('unlabeled', 'd-hinders', 'User', 'pending-review')], maint).accepted, false))
  test('a later maintainer re-label revokes; a later bot label does not', () => {
    assert.equal(acceptanceFrom([ev('unlabeled', 'd-hinders'), ev('labeled', 'PhilipEriksson')], maint).accepted, false)
    assert.equal(acceptanceFrom([ev('unlabeled', 'd-hinders'), ev('labeled', 'github-actions[bot]', 'Bot')], maint).accepted, true)
  })
})

describe('the refusal line is pinned', () => {
  test('exact text', () => {
    assert.equal(refusalLine(4107, 'rezearcher'), 'Not building #4107: external author rezearcher, not accepted by a maintainer (a maintainer accepts it by removing the `external` label).')
  })
  test('AGENTS.md and ship-next carry the same template verbatim', () => {
    const template = refusalLine('<n>', '<login>')
    for (const f of ['../../AGENTS.md', '../../.agents/skills/ship-next/SKILL.md']) {
      assert.ok(readFileSync(new URL(f, import.meta.url), 'utf8').includes(template), `${f} lacks: ${template}`)
    }
  })
})

describe('opened', () => {
  test('external issue → external + pending-review, prefixed title, one comment', () => {
    const { actions } = decide({ eventName: 'issues', action: 'opened', item: item() })
    assert.deepEqual(actions.map((a) => a.type), ['addLabels', 'setTitle', 'comment'])
    assert.deepEqual(actions[0].labels, ['external', 'pending-review'])
    assert.equal(actions[1].title, '[external] Add token safety')
    assert.equal(actions[2].body, intakeComment({ kind: 'issue', author: 'rezearcher' }))
    assert.match(actions[2].body, /accepts it by removing the `external` label/)
  })

  test('external PR → external only (never pending-review on a PR)', () => {
    const { actions } = decide({ eventName: 'pull_request_target', action: 'opened', item: item({ number: 4188 }) })
    assert.deepEqual(actions[0].labels, ['external'])
    assert.match(actions[2].body, /This pull request was opened by @rezearcher/)
  })

  test('an already-prefixed title is not prefixed twice', () => {
    const { actions } = decide({ eventName: 'issues', action: 'opened', item: item({ title: '[external] x' }) })
    assert.deepEqual(actions.map((a) => a.type), ['addLabels', 'comment'])
  })

  for (const [association, userType] of [['OWNER', 'User'], ['COLLABORATOR', 'User'], ['MEMBER', 'User'], ['CONTRIBUTOR', 'Bot'], ['NONE', 'Bot']]) {
    test(`${association} ${userType} → nothing written`, () => {
      assert.deepEqual(decide({ eventName: 'issues', action: 'opened', item: item({ association, userType }) }).actions, [])
    })
  }
  for (const association of ['FIRST_TIME_CONTRIBUTOR', 'FIRST_TIMER', 'MANNEQUIN', 'CONTRIBUTOR']) {
    test(`${association} User → marked`, () => {
      assert.equal(decide({ eventName: 'issues', action: 'opened', item: item({ association }) }).actions.length, 3)
    })
  }
})

describe('unlabeled (acceptance)', () => {
  const accepted = (over = {}) => decide({ eventName: 'issues', action: 'unlabeled', item: item({ title: '[external] Add token safety' }), label: 'external', senderIsMaintainer: true, ...over })
  test('by a maintainer → prefix stripped', () => {
    assert.deepEqual(accepted().actions, [{ type: 'setTitle', title: 'Add token safety' }])
  })
  test('a doubled prefix is stripped whole', () => {
    assert.equal(withoutPrefix('[external] [external] x'), 'x')
    assert.equal(withPrefix(withPrefix('x')), `${TITLE_PREFIX}x`)
  })
  test('by a non-maintainer → nothing', () => assert.deepEqual(accepted({ senderIsMaintainer: false }).actions, []))
  test('another label → nothing', () => assert.deepEqual(accepted({ label: 'pending-review' }).actions, []))
  test('no prefix to strip → nothing', () => {
    assert.deepEqual(decide({ eventName: 'issues', action: 'unlabeled', item: item(), label: 'external', senderIsMaintainer: true }).actions, [])
  })
})

describe('event parsing and writes', () => {
  test('fromEvent reads the issue or the pull_request object', () => {
    const issue = { action: 'opened', sender: { login: 'rezearcher', type: 'User' }, issue: { number: 4107, title: 't', user: { login: 'rezearcher', type: 'User' }, author_association: 'NONE' } }
    assert.deepEqual(fromEvent('issues', issue).item, { number: 4107, title: 't', author: 'rezearcher', association: 'NONE', userType: 'User' })
    const pr = { action: 'unlabeled', label: { name: 'external' }, sender: { login: 'd-hinders', type: 'User' }, pull_request: { number: 4188, title: '[external] t', user: { login: 'rezearcher', type: 'User' }, author_association: 'NONE' } }
    const p = fromEvent('pull_request_target', pr)
    assert.equal(p.item.number, 4188)
    assert.equal(p.label, 'external')
    assert.deepEqual(p.sender, { login: 'd-hinders', type: 'User' })
  })

  test('apply writes through gh api argv: labels, title, comment body on stdin', async () => {
    const calls = []
    const gh = async (args, opts = {}) => {
      calls.push({ args, input: opts.input })
      return '{}'
    }
    const { actions } = decide({ eventName: 'issues', action: 'opened', item: item({ title: 'a "quoted" $(title)' }) })
    await apply({ gh, repo: 'o/r', number: 4107, actions })
    assert.deepEqual(calls[0].args, ['api', '-X', 'POST', 'repos/o/r/issues/4107/labels', '-f', 'labels[]=external', '-f', 'labels[]=pending-review'])
    assert.deepEqual(calls[1].args, ['api', '-X', 'PATCH', 'repos/o/r/issues/4107', '-f', 'title=[external] a "quoted" $(title)'])
    assert.deepEqual(calls[2].args, ['api', '-X', 'POST', 'repos/o/r/issues/4107/comments', '-F', 'body=@-'])
    assert.equal(calls[2].input, actions[2].body)
  })
})

describe('the workflow shape', () => {
  const yml = readFileSync(new URL('../../.github/workflows/external-intake-label.yml', import.meta.url), 'utf8')

  test('triggers: issues + pull_request_target, opened and unlabeled only', () => {
    assert.match(yml, /^on:\n  issues:\n    types: \[opened, unlabeled\]\n  pull_request_target:\n    types: \[opened, unlabeled\]\n/m)
  })
  test('permissions are exactly issues: write + pull-requests: write', () => {
    assert.match(yml, /^permissions:\n  issues: write\n  pull-requests: write\n\n/m)
  })
  test('no ref: on the checkout; bash + pipefail; no event title/body expression anywhere', () => {
    const checkout = yml.slice(yml.indexOf('actions/checkout@v4'), yml.indexOf('actions/setup-node@v4'))
    assert.doesNotMatch(checkout, /ref:/)
    const step = yml.slice(yml.indexOf('- name: Decide and apply'))
    assert.match(step, /\n\s+shell: bash\n\s+run: \|\n\s+set -o pipefail\n\s+node scripts\/ci\/external-intake-label\.mjs --event "\$GITHUB_EVENT_PATH" --event-name "\$GITHUB_EVENT_NAME" --apply \| tee -a "\$GITHUB_STEP_SUMMARY"\n/)
    assert.doesNotMatch(yml, /\$\{\{\s*github\.event\.[^}]*\.(title|body)\s*\}\}/)
  })
})
