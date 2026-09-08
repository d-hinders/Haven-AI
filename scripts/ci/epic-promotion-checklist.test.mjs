// `scripts/ci/epic-promotion-checklist.mjs` — the closeout's "may this epic be
// reported ready to close?" reader (#2767). Sample epic bodies in the shape the
// template produces, driven through the CLI so the exit codes are what is
// asserted, not the parser alone.
//
// Run with: node --test scripts/ci/epic-promotion-checklist.test.mjs

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { evaluate, readPromotionChecklist } from './epic-promotion-checklist.mjs'

const SCRIPT = fileURLToPath(new URL('./epic-promotion-checklist.mjs', import.meta.url))
const TEMPLATE = fileURLToPath(new URL('../../.github/ISSUE_TEMPLATE/loop-epic.md', import.meta.url))

const epic = (checklist) => `## Goal

Ship the thing.

## Sub-issues (the queue, in order)

- [x] #2701
- [x] #2702

## Surface(s)

- [x] \`area:backend\`

## Promotion checklist

<!-- guidance comment: - [ ] this is not a box -->

${checklist}

## Notes

- [ ] a box OUTSIDE the section does not count
`

function cli(body) {
  return spawnSync(process.execPath, [SCRIPT], { input: body, encoding: 'utf8' })
}

describe('epic-promotion-checklist', () => {
  test('all boxes ticked → ready, exit 0', () => {
    const r = cli(epic('- [x] Operator step: set QA_REQUIRE_ALL_LEGS — done in repo variables\n- [X] Product verification on `dev`: money-flow harness — run by owner'))
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.match(r.stdout, /ready to close — all 2/)
  })

  test('one unticked box → NOT ready, exit 1, and the box is printed', () => {
    const r = cli(epic('- [x] Operator step: set the variable — done in repo variables\n- [ ] Product verification on `dev`: run the e2e runbook — run by owner'))
    assert.equal(r.status, 1)
    assert.match(r.stdout, /NOT ready to close — 1 of 2/)
    assert.match(r.stdout, /- \[ \] Product verification on `dev`: run the e2e runbook/)
    assert.doesNotMatch(r.stdout, /set the variable/, 'ticked boxes are not listed')
  })

  test('boxes in the template comment and outside the section are ignored', () => {
    const { boxes } = readPromotionChecklist(epic('- [x] only real box'))
    assert.equal(boxes.length, 1)
    assert.equal(boxes[0].text, 'only real box')
  })

  test('no Promotion checklist section → ready with the absence NAMED, exit 0', () => {
    const body = '## Goal\n\nOld epic.\n\n## Sub-issues (the queue, in order)\n\n- [x] #1\n'
    const r = cli(body)
    assert.equal(r.status, 0)
    assert.match(r.stdout, /no `## Promotion checklist` section/)
    assert.equal(evaluate(body).reason, 'no-section')
  })

  test('section present but empty → NOT ready (fill it or remove it)', () => {
    const r = cli(epic(''))
    assert.equal(r.status, 1)
    assert.equal(evaluate(epic('')).reason, 'empty-section')
  })

  test('the shipped template itself parses as NOT ready — its placeholders are unticked', () => {
    const body = readFileSync(TEMPLATE, 'utf8').replace(/^---[\s\S]*?---\n/, '')
    const v = evaluate(body)
    assert.equal(v.present ?? true, true)
    assert.equal(v.reason, 'unticked')
    assert.equal(v.total, 2, 'the template ships exactly two placeholder boxes')
  })

  test('heading match is case-insensitive and tolerates trailing space; CRLF bodies parse', () => {
    const body = epic('- [ ] step').replace('## Promotion checklist', '## Promotion Checklist ').replace(/\n/g, '\r\n')
    assert.equal(evaluate(body).reason, 'unticked')
  })

  test('empty stdin (an upstream `gh` failure in the pipe) → exit 2, never "ready"', () => {
    for (const input of ['', '   \n\n']) {
      const r = cli(input)
      assert.equal(r.status, 2, `input ${JSON.stringify(input)}: ${r.stdout}`)
      assert.doesNotMatch(r.stdout, /ready to close/)
      assert.match(r.stderr, /empty body/)
    }
  })

  test('reported line numbers are the real 1-based lines, on the shipped template and a simple body', () => {
    const body = readFileSync(TEMPLATE, 'utf8').replace(/^---[\s\S]*?---\n/, '')
    const lines = body.split('\n')
    const { boxes } = readPromotionChecklist(body)
    assert.equal(boxes.length, 2)
    for (const box of boxes) {
      assert.equal(lines[box.line - 1].includes(box.text), true, `line ${box.line} does not hold "${box.text}"`)
    }
    const simple = '## Promotion checklist\n\n- [ ] step one\n'
    assert.equal(readPromotionChecklist(simple).boxes[0].line, 3)
  })

  test('unreadable file → exit 2', () => {
    const r = spawnSync(process.execPath, [SCRIPT, '/nonexistent/epic-body.md'], { encoding: 'utf8' })
    assert.equal(r.status, 2)
  })
})
