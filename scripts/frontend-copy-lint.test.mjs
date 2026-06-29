// Unit tests for the frontend-copy-lint matcher.
// Run with: node --test scripts/frontend-copy-lint.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findCopyIssues } from './frontend-copy-lint.mjs'

test('flags a banned multi-word phrase (case-insensitive)', () => {
  const r = findCopyIssues('const label = "Set your Spending Policy"\n')
  assert.equal(r.length, 1)
  assert.equal(r[0].phrase, 'spending policy')
  assert.equal(r[0].line, 1)
})

test('does NOT flag a bare generic word', () => {
  // "Safe", "owner", "deploy" must never trip the lint (only multi-word phrases).
  assert.equal(findCopyIssues('const safe = useSafe(); const owner = a.owner\n').length, 0)
  assert.equal(findCopyIssues('await deploySafe()\n').length, 0)
})

test('respects // copy-lint-ignore on the same line', () => {
  const r = findCopyIssues('label="Allowance Module" // copy-lint-ignore advanced surface\n')
  assert.equal(r.length, 0)
})

test('respects // copy-lint-ignore on the line above', () => {
  const r = findCopyIssues('// copy-lint-ignore\nlabel="transaction hash"\n')
  assert.equal(r.length, 0)
})

test('reports each banned phrase with its preferred replacement', () => {
  const r = findCopyIssues('Use a session key and a smart wallet\n')
  const phrases = r.map((x) => x.phrase).sort()
  assert.deepEqual(phrases, ['session key', 'smart wallet'])
  assert.ok(r.every((x) => typeof x.suggestion === 'string' && x.suggestion.length > 0))
})

test('clean copy yields no findings', () => {
  assert.equal(findCopyIssues('Set agent rules and budgets for your Haven account\n').length, 0)
})
