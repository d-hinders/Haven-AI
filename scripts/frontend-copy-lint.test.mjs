// Unit tests for the frontend-copy-lint matcher.
// Run with: node --test scripts/frontend-copy-lint.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findCopyIssues, newViolations, missingTargets, SCAN_FILES } from './frontend-copy-lint.mjs'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

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

test('does not double-report a plural against its singular (session keys)', () => {
  const r = findCopyIssues('Rotate your session keys regularly\n')
  assert.equal(r.length, 1)
  assert.equal(r[0].phrase, 'session keys')
})

test('clean copy yields no findings', () => {
  assert.equal(findCopyIssues('Set agent rules and budgets for your Haven account\n').length, 0)
})

// ── Ratcheting baseline (#902) ────────────────────────────────────────────────

test('newViolations: a new banned term (no baseline entry) fails', () => {
  const f = newViolations({ 'a.tsx': { 'smart account': 1 } }, {})
  assert.deepEqual(f, [{ file: 'a.tsx', key: 'smart account', count: 1, allowed: 0 }])
})

test('newViolations: matching or shrinking the baseline passes', () => {
  const baseline = { 'a.tsx': { 'policy engine': 2 } }
  assert.equal(newViolations({ 'a.tsx': { 'policy engine': 2 } }, baseline).length, 0) // equal
  assert.equal(newViolations({ 'a.tsx': { 'policy engine': 1 } }, baseline).length, 0) // shrank
  assert.equal(newViolations({}, baseline).length, 0) // fully removed
})

test('newViolations: growth of an existing baselined count fails', () => {
  const f = newViolations({ 'a.tsx': { 'policy engine': 3 } }, { 'a.tsx': { 'policy engine': 2 } })
  assert.deepEqual(f, [{ file: 'a.tsx', key: 'policy engine', count: 3, allowed: 2 }])
})

test('newViolations: a baselined term in a DIFFERENT file is not grandfathered', () => {
  // The baseline is per-file — the same phrase newly appearing elsewhere fails.
  const f = newViolations(
    { 'b.tsx': { 'smart account': 1 } },
    { 'a.tsx': { 'smart account': 1 } },
  )
  assert.deepEqual(f, [{ file: 'b.tsx', key: 'smart account', count: 1, allowed: 0 }])
})

// ── Prose-file allowlist (#2317) ─────────────────────────────────────────────

test('every SCAN_FILES entry resolves to a real file', () => {
  // An entry that matches nothing makes the gate silently narrower than it
  // reads — the same defect this allowlist exists to close, one level up.
  const missing = missingTargets(SCAN_FILES, (rel) => existsSync(join(REPO_ROOT, rel)))
  assert.deepEqual(missing, [], `SCAN_FILES entries do not exist: ${missing.join(', ')}`)
  assert.ok(SCAN_FILES.length > 0, 'SCAN_FILES must not be empty')
})

test('missingTargets names a non-existent entry rather than passing quietly', () => {
  const entries = ['packages/frontend/src/lib/agent-skill-bundle.ts', 'packages/frontend/src/lib/moved-away.ts']
  const exists = (rel) => rel !== 'packages/frontend/src/lib/moved-away.ts'
  assert.deepEqual(missingTargets(entries, exists), ['packages/frontend/src/lib/moved-away.ts'])
})

test('the originating downloadable-prose file is on the allowlist', () => {
  // packages/frontend/src/lib/agent-skill-bundle.ts is downloaded verbatim by a
  // human from the connect-agent success screen and read by an agent (#2317).
  assert.ok(SCAN_FILES.includes('packages/frontend/src/lib/agent-skill-bundle.ts'))
})
