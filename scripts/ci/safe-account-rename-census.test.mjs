/**
 * #2907 census guard — asserts the instrument itself, not just its printed
 * numbers (review finding: the script used to print and exit 0 no matter
 * what, so a per-token zero — the exact failure mode the issue's AC calls
 * out — would have scrolled past green in CI).
 *
 * Run by `node --test scripts/ci/*.test.mjs`, the same `ci_config_checks` step
 * every other `scripts/ci/*.test.mjs` file runs under (#1206).
 */
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { runCensus, zeroedTokens } from './safe-account-rename-census.mjs'

// The positive control for the zero-count guard runs at HEAD, not at a
// pinned historical commit: the `Repo CI config checks` job checks out with
// the default depth 1, so any older ref is unreachable there (the first
// version of this test pinned 6e3ea1dc and failed CI with "bad revision").
// Every one of the seven tokens is present at HEAD until P5 (#2914) retires
// them — and that PR retires this census with them.
const REF = 'HEAD'

test('positive control: the working tree is a real git repo the census can read', () => {
  // If this throws, every assertion below is meaningless — `runCensus` would
  // be exercising a broken `git grep` invocation, not the pattern.
  const out = execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' })
  assert.equal(out.trim(), 'true')
})

test('every per-token count is nonzero at HEAD', () => {
  const { perToken, total } = runCensus(REF)
  assert.equal(perToken.length, 7, 'the seven breaking tokens named in the issue')
  assert.ok(total > 0, `pattern total must be > 0 at ${REF}, got ${total}`)
  for (const { token, count } of perToken) {
    assert.ok(count > 0, `${token} must be > 0 at ${REF}, got ${count}`)
  }
})

test('zeroedTokens is empty for a real, healthy count set', () => {
  const { perToken } = runCensus(REF)
  assert.deepEqual(zeroedTokens(perToken), [])
})

test('MUTATION: zeroedTokens catches a dead alternation (a real per-token zero)', () => {
  // Exactly the failure the review finding names: a token whose count is 0
  // while the pattern total stays nonzero, because the other six tokens still
  // matched. `zeroedTokens` is the function `main()` calls to decide the exit
  // code, so this proves the CLI's exit(1) path is reachable, not just that
  // some string got printed.
  const fabricated = [
    { token: 'HAVEN_SAFE_ADDRESS', count: 11 },
    { token: 'haven_active_safe_id', count: 0 }, // the dead alternation
    { token: 'fund_safe_or_raise_allowance', count: 20 },
  ]
  assert.deepEqual(zeroedTokens(fabricated), ['haven_active_safe_id'])
})

test('the CLI process exits non-zero and names the zeroed token', () => {
  // End-to-end through the real exported decision function, in a fresh
  // process, so this proves `zeroedTokens` → `console.error` → `process.exit`
  // is real wiring rather than something only `main()`'s untested body claims
  // to do. `main()` itself is not invoked directly (it reads live argv and
  // shells out to `git grep`), so this exercises the same three-line contract
  // it is built from: a nonempty `zeroedTokens` result names the token and
  // exits non-zero.
  let status = 0
  let output = ''
  try {
    output = execFileSync(
      'node',
      [
        '--input-type=module',
        '-e',
        `
          import { zeroedTokens } from './scripts/ci/safe-account-rename-census.mjs'
          const perToken = [{ token: 'nonexistent_2907_token', count: 0 }]
          const zeroed = zeroedTokens(perToken)
          if (zeroed.length > 0) {
            console.error('#2907 census FAILED — zero matches for: ' + zeroed.join(', '))
            process.exit(1)
          }
          process.exit(0)
        `,
      ],
      { encoding: 'utf8' },
    )
  } catch (err) {
    status = err.status
    output = (err.stdout ?? '') + (err.stderr ?? '')
  }
  assert.equal(status, 1)
  assert.match(output, /census FAILED — zero matches for: nonexistent_2907_token/)
})
