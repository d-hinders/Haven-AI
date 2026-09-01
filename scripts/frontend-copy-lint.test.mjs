// Unit tests for the frontend-copy-lint matcher.
// Run with: node --test scripts/frontend-copy-lint.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  findCopyIssues,
  newViolations,
  missingTargets,
  matchesCopyConvention,
  conventionGaps,
  libSourceFiles,
  CONVENTION_EXEMPT,
  SCAN_FILES,
} from './frontend-copy-lint.mjs'

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

// ── Attribution phrases (#2334) ──────────────────────────────────────────────

test('flags the CASP attribution inversion this list was extended for', () => {
  // The exact sentence that shipped in the downloadable SKILL.md (#2334).
  const r = findCopyIssues(
    "the pay-tool result's amount is the amount\nHaven authorizes for that call\n",
  )
  assert.equal(r.length, 1)
  assert.equal(r[0].phrase, 'haven authorizes')
  assert.equal(r[0].line, 2)
})

test('the attribution match is literal and single-line — say so, do not overclaim', () => {
  // Both of these are the SAME inversion and BOTH go undetected. This test
  // pins the guard's known ceiling so nobody reads a green run as "attribution
  // was checked": rewording, and a line break between the two words, each
  // evade it. Attribution is a human-review control (copy-guidelines.md
  // § Core principle); this list is only the literal floor under it.
  assert.deepEqual(findCopyIssues('authorization for that call comes from Haven\n'), [])
  assert.deepEqual(findCopyIssues('is the amount Haven\nauthorizes for that call\n'), [])
})

test('ordinary Haven sentences are not flagged (false-positive floor)', () => {
  // Haven-as-actor prose that is TRUE and must stay writable.
  assert.deepEqual(findCopyIssues('Haven relays policy-limited account operations.\n'), [])
  assert.deepEqual(findCopyIssues('Haven cannot move funds outside the limits you approve.\n'), [])
})

// ── The extracted-copy naming convention (#2333) ─────────────────────────────

test('the three rendered-copy modules #2333 found are on the allowlist', () => {
  // passkeyRowLabel renders the credential row (WalletButton, AccountSignersCard);
  // the transaction pair renders every row title, initiator and status.
  for (const f of [
    'packages/frontend/src/lib/passkeyLabels.ts',
    'packages/frontend/src/lib/transaction-labels.ts',
    'packages/frontend/src/lib/transaction-presentation.tsx',
  ]) {
    assert.ok(SCAN_FILES.includes(f), `${f} must be scanned`)
  }
})

test('matchesCopyConvention: the extracted-copy names match', () => {
  assert.ok(matchesCopyConvention('packages/frontend/src/lib/agent-pause-copy.ts'))
  assert.ok(matchesCopyConvention('packages/frontend/src/lib/transaction-labels.ts'))
  assert.ok(matchesCopyConvention('packages/frontend/src/lib/passkeyLabels.ts'))
  // Any .tsx under lib renders by definition — the directory scan would have
  // caught it one level up in components/.
  assert.ok(matchesCopyConvention('packages/frontend/src/lib/transaction-presentation.tsx'))
})

test('matchesCopyConvention: genuine utilities do NOT match', () => {
  // #2332 is the standing counter-example: passkey.ts carries a banned phrase
  // in a developer-facing throw and deliberately stays out of the gate. If this
  // check ever pulled it in, the convention would have become the `src/lib`
  // sweep #2317 rejected.
  for (const f of [
    'packages/frontend/src/lib/passkey.ts',
    'packages/frontend/src/lib/passkeyErrors.ts',
    'packages/frontend/src/lib/allowance-module.ts',
    'packages/frontend/src/lib/format.ts',
    'packages/frontend/src/lib/api.ts',
  ]) {
    assert.equal(matchesCopyConvention(f), false, `${f} must not be forced into the gate`)
  }
})

test('conventionGaps: an unlisted extracted-copy module fails the run', () => {
  // The whole point: the NEXT extraction is caught when it lands, not a
  // fortnight later by a human re-reading src/lib.
  const gaps = conventionGaps(
    [
      'packages/frontend/src/lib/agent-pause-copy.ts',
      'packages/frontend/src/lib/new-banner-copy.ts',
      'packages/frontend/src/lib/format.ts',
    ],
    ['packages/frontend/src/lib/agent-pause-copy.ts'],
    {},
  )
  assert.deepEqual(gaps, ['packages/frontend/src/lib/new-banner-copy.ts'])
})

test('conventionGaps: allowlisted and exempted files are both accepted', () => {
  const files = [
    'packages/frontend/src/lib/a-copy.ts',
    'packages/frontend/src/lib/b-labels.ts',
  ]
  assert.deepEqual(
    conventionGaps(files, ['packages/frontend/src/lib/a-copy.ts'], {
      'packages/frontend/src/lib/b-labels.ts': 'not copy: pure column-key map',
    }),
    [],
  )
})

test('a stale CONVENTION_EXEMPT entry is detected', () => {
  // The mechanism, over a NON-EMPTY map. The structural test below runs the
  // real map, which is `{}` today and so cannot fail on its own — that pair is
  // deliberate: this one proves the check works, that one proves the repo
  // currently satisfies it. A stale exemption silently excuses a file that is
  // no longer there — the dangling-allowlist-entry defect, one mechanism over.
  const exempt = {
    'packages/frontend/src/lib/agent-pause-copy.ts': 'still here',
    'packages/frontend/src/lib/gone-copy.ts': 'deleted last month',
  }
  assert.deepEqual(
    missingTargets(Object.keys(exempt), (rel) => existsSync(join(REPO_ROOT, rel))),
    ['packages/frontend/src/lib/gone-copy.ts'],
  )
})

test('every CONVENTION_EXEMPT entry resolves to a real file', () => {
  // Structural: vacuously true while the map is empty, and that is the correct
  // state to assert — it starts failing the moment someone exempts a file that
  // is not there. The test above is what proves the check itself can fire.
  const missing = missingTargets(Object.keys(CONVENTION_EXEMPT), (rel) =>
    existsSync(join(REPO_ROOT, rel)),
  )
  assert.deepEqual(missing, [], `CONVENTION_EXEMPT entries do not exist: ${missing.join(', ')}`)
})

test('the REAL src/lib tree has no unscanned prose-shaped file', async () => {
  // The structural half of the convention: run over the actual tree, with the
  // same walk `scanAll` uses. Neutering the check in the script leaves the lint
  // green (it has nothing to report) — this is what goes red instead, which is
  // #2317's own lesson about a sibling test job catching a silently-narrowed
  // gate.
  const gaps = conventionGaps(await libSourceFiles(), SCAN_FILES, CONVENTION_EXEMPT)
  assert.deepEqual(
    gaps,
    [],
    `add these to SCAN_FILES (or CONVENTION_EXEMPT with a reason): ${gaps.join(', ')}`,
  )
})
