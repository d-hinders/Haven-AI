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

// ── The two CASP avoid-list phrases (#2246) ──────────────────────────────────

test('flags both CASP § Product Copy Rules phrases that shipped in the agent modal', () => {
  // The two live strings from `components/UsingYourAgentInfo.tsx`, verbatim
  // including the JSX interpolation and the entity the file actually carried.
  const settles = findCopyIssues(
    ", Haven signs and settles the payment automatically — within the agent&apos;s remaining allowance.\n",
  )
  assert.equal(settles.length, 1)
  assert.equal(settles[0].phrase, 'haven signs and settles')

  const gave = findCopyIssues("When you created your agent, Haven gave you a{' '}\n")
  assert.equal(gave.length, 1)
  assert.equal(gave[0].phrase, 'haven gave you')
})

test('the two nearby generalisations stay OUT, and here is what they would have hit', () => {
  // Rejected on measurement, not taste. Both of these sentences are TRUE and
  // live in the scanned set; banning the wider phrase would fail the run on
  // correct copy — and one of them is the non-custody claim itself.
  assert.deepEqual(findCopyIssues('Client signs and settles on‑chain.\n'), [])
  assert.deepEqual(findCopyIssues('the account is the signer; Haven signs nothing.\n'), [])
})

test('#2246 is a phrase floor, not a claim detector — the reword still evades it', () => {
  // The avoid list bans a CLAIM; this list can only hold a phrase. Pinned so a
  // green run is never citable as "the modal makes no custody claim".
  assert.deepEqual(findCopyIssues('the private key we issued you when you created the agent\n'), [])
  assert.deepEqual(findCopyIssues('Haven gave\nyou a private key\n'), [])
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

// --- The CLI path (#2721, epic #2720)
//
// The cases above test the term matching and the escape handling. The refusal
// — new banned copy beyond the ratcheting baseline — lives in `main()`, and no
// exported function reaches it. That is the line deciding whether a pull
// request lands, and the shape that survived mutation elsewhere with a green
// suite (#2690).

import { runGuard } from './test-support/guard-cli.mjs'

const PAGE = 'packages/frontend/src/app/page.tsx'
const BASE = 'packages/frontend/copy-lint-baseline.json'
const copy = (text) => `export default function P() {\n  return <p>${text}</p>\n}\n`

// Both SCAN_DIRS must contain something: the guard REFUSES a scan directory
// that matches no files ("repoint it, do not leave it matching nothing"), which
// is its own positive control against a lint quietly reporting on an empty set.
// A fixture supplying only `app/` trips that refusal and would have looked like
// the copy rule firing.
const OTHER = 'packages/frontend/src/components/Thing.tsx'

// The guard carries THREE self-checks that fire before any copy rule, and each
// one caught a draft of this fixture: a SCAN_DIRS entry matching no files, a
// SCAN_FILES allowlist entry that does not exist, and (below) the baseline.
// They are the guard's own positive controls — it refuses to report on a set it
// could not actually read — so the fixture has to satisfy them before the rule
// under test is even reached. `SCAN_FILES` is imported rather than restated, so
// this scaffold cannot drift from the allowlist it exists to satisfy.
const allowlisted = Object.fromEntries(
  SCAN_FILES.map((rel) => [rel, 'export const x = 1\n']),
)
const scaffold = (files) => ({
  ...allowlisted,
  [OTHER]: copy('Nothing to see.'),
  ...files,
})

test('CLI: a new banned term beyond the baseline exits non-zero and names it', () => {
  const { status, out } = runGuard('frontend-copy-lint.mjs', {
    also: ['lib/ratchet.mjs', 'lib/lint-escapes.mjs'],
    files: scaffold({ [PAGE]: copy('Haven runs a policy engine for you.'), [BASE]: '{}' }),
  })
  assert.equal(status, 1)
  assert.match(out, /NEW banned product-copy terms/)
  assert.match(out, /policy engine/)
  // The file AND the position: a message naming only the term sends the
  // reader searching the whole tree for it.
  assert.match(out, /page\.tsx:\d+:\d+/)
})

test('CLI: copy with no banned term exits 0', () => {
  // The control. Without it the case above passes against a lint that
  // refuses everything.
  const { status } = runGuard('frontend-copy-lint.mjs', {
    also: ['lib/ratchet.mjs', 'lib/lint-escapes.mjs'],
    files: scaffold({ [PAGE]: copy('Your agents pay within the rules you set.'), [BASE]: '{}' }),
  })
  assert.equal(status, 0)
})

test('CLI: an occurrence already in the baseline is tolerated', () => {
  // The ratchet half: this lint is shrink-only, so an existing occurrence must
  // NOT fail the build. A refusal test alone cannot tell a working ratchet
  // from a lint that fires on every hit.
  const { status } = runGuard('frontend-copy-lint.mjs', {
    also: ['lib/ratchet.mjs', 'lib/lint-escapes.mjs'],
    files: scaffold({
      [PAGE]: copy('Haven runs a policy engine for you.'),
      [BASE]: JSON.stringify({ [PAGE]: { 'policy engine': 1 } }),
    }),
  })
  assert.equal(status, 0)
})

test('CLI: `--update` REFUSES to raise the baseline, and writes nothing', () => {
  // #2728, and this test replaces the one that pinned the hole.
  //
  // The branch used to be `if (update) { writeBaseline(...); return }` -- no
  // comparison at all -- so the command the failure message sends you to was
  // the one that laundered the failure. Its three siblings on the same
  // `lib/ratchet.mjs` had refused to raise since they were written.
  //
  // The fixture is the SAME tree the hole test used, so the two are directly
  // comparable: exit 0 + growth written, then exit 1 + baseline untouched.
  const before = JSON.stringify({ [PAGE]: { 'policy engine': 0 } })
  const grown = scaffold({ [PAGE]: copy('Haven runs a policy engine for you.'), [BASE]: before })
  const shared = { also: ['lib/ratchet.mjs', 'lib/lint-escapes.mjs'], files: grown }

  // The plain run refuses it -- so the growth is real, not a fixture artifact.
  assert.equal(runGuard('frontend-copy-lint.mjs', shared).status, 1)

  const { status, out, wrote } = runGuard('frontend-copy-lint.mjs', {
    ...shared,
    args: ['--update'],
    readBack: [BASE],
  })
  assert.equal(status, 1)
  assert.match(out, /--update refuses to RAISE the baseline/)
  // The file and the numbers, not just the headline: a refusal that cannot say
  // WHAT grew sends the reader back to the plain run to find out.
  assert.match(out, /page\.tsx \[policy engine\]: 0 → 1/)
  // "writes nothing" is checked, not claimed -- a guard that printed the
  // refusal after writing would still have laundered the copy.
  assert.equal(wrote[BASE], before)
})

test('CLI: `--update` DOES write when the count fell', () => {
  // The accept half. Without it the refusal above is also satisfied by an
  // `--update` that refuses everything, which would break the ratchet in the
  // other direction: debt could never be tightened after a real cleanup.
  const { status, out, wrote } = runGuard('frontend-copy-lint.mjs', {
    also: ['lib/ratchet.mjs', 'lib/lint-escapes.mjs'],
    files: scaffold({
      [PAGE]: copy('Your agents pay within the rules you set.'),
      [BASE]: JSON.stringify({ [PAGE]: { 'policy engine': 3 } }),
    }),
    args: ['--update'],
    readBack: [BASE],
  })
  assert.equal(status, 0)
  assert.match(out, /baseline written/)
  // The written file, not the console line: a `writeBaseline` resolving its
  // path against the wrong root prints this and writes nothing.
  assert.equal(JSON.parse(wrote[BASE])[PAGE], undefined)
})

test('CLI: `--update` on an EMPTY baseline still writes -- the first-run allowance', () => {
  // Deliberate, and the one case in which growth is written: it is how a
  // baseline gets created at all. Pinned so a future tightening of the refusal
  // cannot take it away silently -- the refusal is `Object.keys(baseline)
  // .length === 0 ? [] : newViolations(...)`, and only the first half of that
  // is load-bearing here.
  const { status, wrote } = runGuard('frontend-copy-lint.mjs', {
    also: ['lib/ratchet.mjs', 'lib/lint-escapes.mjs'],
    files: scaffold({ [PAGE]: copy('Haven runs a policy engine for you.'), [BASE]: '{}' }),
    args: ['--update'],
    readBack: [BASE],
  })
  assert.equal(status, 0)
  assert.match(wrote[BASE], /"policy engine": 1/)
})
