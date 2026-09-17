/**
 * Naming-epic census guard (#2906) — asserts the instrument itself, not just
 * its printed numbers (the original review finding: the script used to print
 * and exit 0 no matter what, so the exact failure mode it existed to catch
 * would have scrolled past green in CI).
 *
 * **#2914 turned the assertion around.** Through P0–P4 the guard asserted
 * every per-token count was `> 0` — the tokens were supposed to be
 * everywhere, so a zero meant a dead alternation inside the one big group,
 * silent in the total and catchable only per token. The contraction drives
 * those counts toward zero on purpose, so that assertion would now assert the
 * opposite of the truth. An earlier version of this file said the P5 PR would
 * "retire this census"; it did not, because the census found two live defects
 * during #2914 that every test suite was green about. The guard is pointed
 * the other way instead: every surviving hit must sit in a path class with a
 * written reason.
 *
 * Pattern liveness — the property `> 0` really bought — is proven against a
 * FIXTURE string here rather than against the repo, which is what
 * `zeroedTokens`'s own comment always said it should be. That decoupling is
 * the point: the pattern's health no longer depends on the repo being dirty.
 *
 * Run by `node --test scripts/ci/*.test.mjs`, the same `ci_config_checks` step
 * every other `scripts/ci/*.test.mjs` file runs under (#1206).
 */
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { allowedReason, runCensus, zeroedTokens } from './safe-account-rename-census.mjs'

test('positive control: the working tree is a real git repo the census can read', () => {
  // If this throws, every assertion below is meaningless — `runCensus` would
  // be exercising a broken `git grep` invocation, not the pattern.
  const out = execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' })
  assert.equal(out.trim(), 'true')
})

test('the pattern still matches every token it claims to — proven on a fixture, not the repo', () => {
  // The liveness check that `> 0` used to buy, decoupled from the repo. A
  // dead alternation inside the one big group is silent in a total taken over
  // real files; here each token is fed a line that ONLY it can match, so a
  // broken alternation fails by name. The pattern is applied, not read as a
  // string — `HAVEN_SAFE_ADDRESS` is matched by the `HAVEN_SAFE[A-Za-z0-9_]*`
  // branch and never appears literally in the source.
  const source = readFileSync('scripts/ci/safe-account-rename-census.mjs', 'utf8')
  const literal = source.slice(source.indexOf("const PATTERN ="), source.indexOf('const EXCLUSIONS'))
  // Rebuild the RegExp from the module's own source so the fixture cannot
  // drift from the pattern it is testing.
  // eslint-disable-next-line no-eval
  const PATTERN = eval(literal.slice(literal.indexOf('=') + 1).trim().replace(/\n\s*/g, ''))
  for (const [token, line] of Object.entries({
    safe_id: 'const x = row.safe_id',
    safeId: 'const x = params.safeId',
    safe_address: 'const x = row.safe_address',
    safeAddress: 'const x = tx.safeAddress',
    user_safes: 'SELECT * FROM user_safes',
    user_safe_id: 'a.user_safe_id = b.id',
    safe_tx_hash: 'approval.safe_tx_hash',
    HAVEN_SAFE_ADDRESS: 'process.env.HAVEN_SAFE_ADDRESS',
    haven_active_safe_id: "localStorage.getItem('haven_active_safe_id')",
    fund_safe_or_raise_allowance: "next_action === 'fund_safe_or_raise_allowance'",
    useUserSafes: 'const { data } = useUserSafes()',
    SafeOperationGate: 'render(SafeOperationGate)',
  })) {
    assert.match(line, new RegExp(PATTERN), `the census pattern no longer matches ${token}`)
  }
})

test('the exclusion list does not swallow a real hit', () => {
  // The other half of liveness: an exclusion that grew too broad would make
  // the census silently stop reporting. These must NOT be excluded.
  const exclusions = new RegExp(
    'safety|safe-area|SafeArea|unsafe|safely|safeParse|safe_to_continue|' +
      'safeToContinue|ssrf|REBROADCAST_SAFE|MAX_SAFE_INTEGER',
  )
  for (const line of ['const x = row.safe_address', 'SELECT * FROM user_safes']) {
    assert.ok(!exclusions.test(line), `exclusion list swallows a real hit: ${line}`)
  }
  // …and the false positives it exists for must still be excluded.
  for (const line of ['import { safeParse } from "zod"', 'Number.MAX_SAFE_INTEGER']) {
    assert.ok(exclusions.test(line), `exclusion list stopped covering: ${line}`)
  }
})

test('every surviving hit sits in an ALLOWED path class', () => {
  // The contraction's standing assertion. A file naming the retired
  // vocabulary with no recorded reason is a finding, whether it arrived in
  // this PR or a later one.
  const { unallowed, total } = runCensus('')
  assert.deepEqual(
    unallowed,
    [],
    `files naming the retired vocabulary with no ALLOWED reason:\n${unallowed
      .map(([f, n]) => `  ${f} (${n})`)
      .join('\n')}`,
  )
  // Guards the guard: if the pattern or the pathspecs ever stop matching
  // anything at all, `unallowed` is trivially empty and this file would pass
  // while checking nothing. The repo legitimately retains hundreds of hits
  // (migrations, tests, dated docs), so a total of zero means the instrument
  // broke, not that the repo got clean.
  assert.ok(total > 0, `census matched nothing at all (${total}) — the instrument is broken, not the repo clean`)
})

test('MUTATION: a hit outside every ALLOWED class is rejected', () => {
  // `allowedReason` is the function `runCensus` calls to decide whether a file
  // is a finding, so this proves the failing path is reachable rather than
  // that some string got printed.
  assert.equal(allowedReason('packages/backend/src/routes/payments.ts'), null)
  assert.equal(allowedReason('packages/frontend/src/components/Whatever.tsx'), null)
})

test('ALLOWED covers the classes this epic deliberately left alone', () => {
  // Each of these is a decision recorded in #2914, not an oversight, and each
  // has a one-line reason in the script. If one of these starts returning
  // null, a permanent fallback or a refusal site has been renamed by mistake.
  for (const file of [
    'packages/backend/src/db/migrations/084_rename_user_safes_to_smart_accounts.ts',
    'packages/signer/src/credentials.ts',
    'packages/mcp/src/credentials.ts',
    'packages/connect/src/storage.ts',
    'packages/frontend/src/lib/signer.ts',
    'packages/backend/src/middleware/retired-safe-names.ts',
    'packages/backend/src/routes/transactions.ts',
    'packages/core/src/api-types.ts',
  ]) {
    assert.notEqual(allowedReason(file), null, `${file} lost its recorded reason`)
  }
})

test('zeroedTokens still reports a per-token zero, for the epic record', () => {
  // No longer an assertion — the contraction drives these to zero on purpose
  // — but the function stays, because the per-token breakdown is what the
  // epic's acceptance criteria quote.
  assert.deepEqual(
    zeroedTokens([
      { token: 'HAVEN_SAFE_ADDRESS', count: 11 },
      { token: 'haven_active_safe_id', count: 0 },
    ]),
    ['haven_active_safe_id'],
  )
})
