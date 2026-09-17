#!/usr/bin/env node
/**
 * Naming epic #2906 census — the exact pattern and exclusion list
 * pinned in the issue body (corrected 2026-09-12 after Philip's re-review:
 * explicit `[A-Za-z0-9_]*` tails on `HAVEN_SAFE`/`ACTIVE_SAFE` so the group
 * cannot silently fail to match `HAVEN_SAFE_ADDRESS` / `haven_active_safe_id`
 * — `_` is a word character, so a bare token inside `\b(...)\b` never
 * reaches past its own boundary into the tail).
 *
 * Every later naming slice and every guard builds its census on this same
 * pattern (Daniel's ask, #2906) — do not hand-roll a second one.
 *
 * **#2914 turned this instrument around, rather than retiring it.** Through
 * P0–P4 the guard asserted every per-token count was `> 0`: the tokens were
 * SUPPOSED to be everywhere, so a zero meant a dead alternation in the one
 * big group — silent in the total, catchable only per token. The contraction
 * makes that assertion assert the opposite of the truth, and this file's own
 * test said the P5 PR "retires this census with them".
 *
 * Deleting it would have been the cheaper move and the wrong one: the census
 * is the only instrument that reads the whole repo for this vocabulary, and
 * it found two live defects during #2914 that every test suite was green
 * about — a deprecated `safe_address` column still on the transactions CSV,
 * and the CLI's ACCOUNT column reading a field the server had stopped
 * sending. A guard that catches what tests cannot is worth pointing the
 * right way, not throwing away.
 *
 * So the assertion is now: every hit falls inside `ALLOWED`, a list of path
 * classes that may legitimately still name the old vocabulary, each with a
 * written reason. A hit anywhere else fails the run. Pattern liveness — the
 * property the old `> 0` check really bought — is proven against a FIXTURE
 * string instead of against the repo, which is what
 * `zeroedTokens`'s own comment always said it should be.
 *
 * Usage: node scripts/ci/safe-account-rename-census.mjs [git-ref]
 * Defaults to the working tree (no ref) when omitted.
 */
import { execFileSync } from 'node:child_process'

const PATTERN =
  '\\b(safe_id|safeId|safe_address|safeAddress|safe_name|safeName|safe_chain_id|safeChainId|' +
  'safe_tx_hash|user_safes|userSafes|user_safe_id|activeSafe[A-Za-z0-9]*|' +
  'ACTIVE_SAFE[A-Za-z0-9_]*|HAVEN_SAFE[A-Za-z0-9_]*|FIXTURE_SAFE[A-Za-z0-9_]*|' +
  'UserSafe[A-Za-z0-9]*|useUserSafes|useSafeFunding|useSafeOperationGate|' +
  'SafeOperationGate|SafeFunding|fund_safe_or_raise_allowance|haven_active_safe_id|' +
  'havenActiveSafeId)\\b'

const EXCLUSIONS =
  'safety|safe-area|SafeArea|unsafe|safely|safeParse|safe_to_continue|' +
  'safeToContinue|ssrf|REBROADCAST_SAFE|MAX_SAFE_INTEGER'

// The census scope: packages/** and docs/** minus docs/archive and the CASP
// changelog shards (both explicitly out of scope per the issue).
const PATHSPECS = [
  'packages/**',
  'docs/**',
  ':!docs/archive/**',
  ':!docs/regulatory/casp-changelog/**',
]

const PER_TOKEN = [
  'HAVEN_SAFE_ADDRESS',
  'haven_active_safe_id',
  'fund_safe_or_raise_allowance',
  'user_safes',
  'safe_tx_hash',
  'user_safe_id',
  'components\\.safe',
]

/**
 * Path classes that may still name the old vocabulary after #2914, each with
 * the reason it is allowed. Anything outside this list is a finding.
 *
 * Shrink-only in spirit: adding an entry means writing down why a live
 * surface still says "safe", which is a thing a reviewer can argue with.
 */
const ALLOWED = [
  // ── Whole classes ──────────────────────────────────────────────────────
  [/^packages\/backend\/src\/db\/migrations\//,
   'a migration records a schema that existed; rewriting one falsifies history'],
  [/(^|\/)__tests__\//,
   'tests — including the ones that must NAME a retired input to prove it is refused'],
  [/\.test\.(ts|tsx|mjs)$/, 'tests, as above'],
  [/^docs\//,
   'dated records and decision history; the live-behaviour docs were swept in #2914'],
  [/(^|\/)CHANGELOG\.md$/, 'released history'],
  [/^packages\/core\/src\/api-types\.ts$/,
   'generated from the spec; its hits are the descriptions of the refusals'],

  // ── Named files, one reason each. Deliberately NOT directory globs: a
  //    glob over `src/` would allow the whole surface this guard exists to
  //    watch, which is how a guard comes to read as coverage and be none.
  ...[
    'packages/signer/src/credentials.ts',
    'packages/mcp/src/credentials.ts',
    'packages/connect/src/storage.ts',
    'packages/connect/src/doctor.ts',
  ].map((f) => [f, 'PERMANENT credential-FILE fallback — a file on disk never rewrites itself']),
  ['packages/signer/src/audit.ts',
   'the persisted audit JSONL key; same permanent-format reasoning as a credential file'],
  ['packages/frontend/src/lib/signer.ts',
   'the persisted localStorage key for an enrolled passkey signer — renaming it orphans every enrolled signer'],

  ...[
    'packages/backend/src/middleware/retired-safe-names.ts',
    'packages/backend/src/routes/transactions.ts',
    'packages/backend/src/routes/agents.ts',
    'packages/backend/src/routes/agent-connection-setups.ts',
  ].map((f) => [f, 'a retired request name stays DECLARED so Fastify can REFUSE it rather than drop it in silence']),

  ...[
    'packages/backend/src/openapi/spec.ts',
    'packages/backend/src/routes/user.ts',
    'packages/backend/src/modules/transactions/csv-export.ts',
    'packages/backend/src/infra/repositories/smart-accounts.ts',
    'packages/backend/src/infra/repositories/transaction-history.ts',
    'packages/sdk/src/account-naming.ts',
    'packages/sdk/src/types.ts',
    'packages/signer/src/core.ts',
    'packages/connect/src/api.ts',
    'packages/frontend/src/context/AuthContext.tsx',
    'packages/frontend/src/hooks/useAgents.ts',
    'packages/frontend/src/lib/agent-handoff.ts',
    'packages/qa-agent/src/seed.ts',
    'packages/cli/README.md',
    'packages/mcp/README.md',
    'packages/signer/README.md',
  ].map((f) => [f, 'prose naming what was removed, a retired path, or a historical table name']),

  ...[
    'packages/frontend/e2e/fixtures/api-mock.ts',
    'packages/frontend/e2e/fixtures/haven-api.ts',
    'packages/frontend/scripts/screenshot.mjs',
  ].map((f) => [f, 'capture/e2e fixture history, plus `safe_tx_hash` (see below)']),
]

/**
 * `safe_tx_hash` is in the epic's pattern but was NOT in #2914's scope: it is
 * a live field on the connect-setup approval shape, not one of the names the
 * contraction retires. It survives on purpose, and the files above that carry
 * it are allowed for that reason among others. Recorded here rather than
 * dropped from the pattern, because narrowing the pattern to make a census
 * pass is the move this file exists to prevent.
 */
/**
 * Per-file CEILINGS for the named live-source entries above (#2914 review).
 *
 * The allow-list matches on PATH, which is the granularity that let the guard
 * be switched off on the two files where it earned its keep: re-adding
 * `'safe_address'` to `TRANSACTION_CSV_COLUMNS` left the census green, and
 * that is byte-for-byte the first defect this instrument caught. An entry
 * saying "prose naming what was removed" cannot tell prose from a
 * reintroduced wire field — but it can tell a file that grew.
 *
 * So each named file also carries the number of hits it had when its reason
 * was written. Shrink-only: fewer is fine and re-baselines on the next run,
 * more is a finding. That closes the reintroduction case without pretending a
 * regex can read intent. The bulk classes (migrations, tests, docs) are not
 * capped — they are legitimately large and churn for unrelated reasons.
 */
// Raised once, deliberately, during #2914's own review: the reliance-based
// refusal (`retiredNameVerdict`) names the retired input more times than the
// presence check it replaced — in the producer's doc and at each call site.
// Every added hit was read before the number moved; that is the bar for
// raising one of these, and the guard caught the increase rather than being
// told about it.
const ALLOWED_CEILING = new Map([
  ['packages/backend/src/infra/repositories/smart-accounts.ts', 1],
  ['packages/backend/src/infra/repositories/transaction-history.ts', 3],
  // 5 -> 10 (#2914 review, B1): the module gained the two RESPONSE twins
  // kept for one more release, and a twin cannot be described without
  // writing the name it keeps (`safes`, `safeName`). These are the only
  // two retired names still EMITTED anywhere; the removal condition is at
  // the call site. Everything else in this file names a retired input in
  // order to refuse it.
  ['packages/backend/src/middleware/retired-safe-names.ts', 10],
  ['packages/backend/src/modules/transactions/csv-export.ts', 1],
  // 9 -> 14 (#2914 review, B1+S1): two `safe_id` request properties
  // declared so ajv agrees with the handlers that deliberately ACCEPT a
  // dual-send (undeclared under `additionalProperties: false` they would be
  // refused before the handler ran), plus the two response twins. Declaring
  // a name in order to refuse it is the opposite of putting it back.
  ['packages/backend/src/openapi/spec.ts', 14],
  ['packages/backend/src/routes/agent-connection-setups.ts', 8],
  ['packages/backend/src/routes/agents.ts', 7],
  ['packages/backend/src/routes/transactions.ts', 9],
  ['packages/backend/src/routes/user.ts', 1],
  ['packages/cli/README.md', 1],
  ['packages/connect/src/api.ts', 1],
  ['packages/connect/src/doctor.ts', 6],
  ['packages/connect/src/storage.ts', 7],
  ['packages/frontend/e2e/fixtures/api-mock.ts', 2],
  ['packages/frontend/e2e/fixtures/haven-api.ts', 2],
  ['packages/frontend/scripts/screenshot.mjs', 6],
  ['packages/frontend/src/context/AuthContext.tsx', 1],
  ['packages/frontend/src/hooks/useAgents.ts', 1],
  ['packages/frontend/src/lib/agent-handoff.ts', 1],
  ['packages/frontend/src/lib/signer.ts', 9],
  ['packages/mcp/README.md', 2],
  // 7 -> 8 and 6 -> 7 (#2914 review, S2): the retired env names moved from
  // prose into a refusal list. Ignoring them silently left `expectedSafe`
  // undefined, which SKIPS the sweep-destination cross-check in
  // `signer/src/core.ts` — a money-path check lost with no signal.
  ['packages/mcp/src/credentials.ts', 8],
  ['packages/qa-agent/src/seed.ts', 1],
  ['packages/sdk/src/account-naming.ts', 2],
  ['packages/sdk/src/types.ts', 1],
  ['packages/signer/README.md', 2],
  ['packages/signer/src/audit.ts', 3],
  ['packages/signer/src/core.ts', 1],
  ['packages/signer/src/credentials.ts', 7],
])

/** The first ALLOWED reason matching `file`, or null when nothing allows it. */
export function allowedReason(file) {
  for (const [matcher, reason] of ALLOWED) {
    const hit = typeof matcher === 'string' ? matcher === file : matcher.test(file)
    if (hit) return reason
  }
  return null
}

function grepCount(ref, pattern, caseSensitive) {
  const args = ['grep', '-c', ...(caseSensitive ? ['-P'] : ['-Pi']), pattern]
  if (ref) args.push(ref)
  args.push('--', ...PATHSPECS)
  try {
    const out = execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    return out
      .trim()
      .split('\n')
      .filter(Boolean)
      .reduce((sum, line) => sum + Number(line.slice(line.lastIndexOf(':') + 1)), 0)
  } catch (err) {
    // git grep exits 1 when there are zero matches — that is a real (zero)
    // count, not a failure, so surface it as 0 rather than throwing.
    if (err.status === 1) return 0
    throw err
  }
}

function grepHitsWithExclusions(ref) {
  const args = ['grep', '-nP', PATTERN]
  if (ref) args.push(ref)
  args.push('--', ...PATHSPECS)
  let out
  try {
    out = execFileSync('git', args, { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 })
  } catch (err) {
    if (err.status === 1) return []
    throw err
  }
  const exclusionRe = new RegExp(EXCLUSIONS)
  return out
    .split('\n')
    .filter((line) => line.length > 0 && !exclusionRe.test(line))
    .map((line) => {
      // `git grep -n` prints `<file>:<line>:<text>`, and with a ref
      // `<ref>:<file>:<line>:<text>`. Strip the ref when one was given.
      const body = ref ? line.slice(line.indexOf(':') + 1) : line
      return body.slice(0, body.indexOf(':'))
    })
}

/**
 * Run the census against `ref` (empty string = working tree) and return the
 * total plus the per-token breakdown. Exported so
 * `safe-account-rename-census.test.mjs` can assert on it directly rather than
 * shelling out and scraping stdout — the two things this file guarantees
 * (every per-token count is a real number, and the CLI enforces "each > 0")
 * are checked in code, not by re-reading a printed string.
 *
 * `PER_TOKEN` entries are written with a single backslash where they need one
 * (e.g. `components\.safe`) — that is already a valid PCRE token, so no
 * unescaping step belongs here. A `token.replace(/\\\\/g, '\\')` used to sit
 * where the display string is built: it matches a literal double backslash,
 * which none of these tokens ever contain, so it silently did nothing on
 * every run. Removed rather than "fixed", because there is nothing for it to
 * do — the tokens are printed as written.
 */
export function runCensus(ref) {
  const files = grepHitsWithExclusions(ref)
  const perToken = PER_TOKEN.map((token) => ({ token, count: grepCount(ref, token, true) }))
  const unallowed = new Map()
  const perFile = new Map()
  for (const file of files) {
    perFile.set(file, (perFile.get(file) ?? 0) + 1)
    if (allowedReason(file) !== null) continue
    unallowed.set(file, (unallowed.get(file) ?? 0) + 1)
  }
  // A named file that GREW past the count its reason was written for: the
  // reason still matches the path, so `unallowed` cannot see it.
  const overCeiling = []
  for (const [file, ceiling] of ALLOWED_CEILING) {
    const actual = perFile.get(file) ?? 0
    if (actual > ceiling) overCeiling.push([file, actual, ceiling])
  }
  return {
    ref,
    total: files.length,
    perToken,
    unallowed: [...unallowed.entries()].sort(),
    overCeiling: overCeiling.sort(),
  }
}

/**
 * The whole point of the per-token breakdown (issue #2907 AC): a dead
 * alternation inside the one big TIER_A group is silent in the total — only a
 * per-token assertion catches it. Pulled out as a pure function, independent
 * of `git grep`, so `safe-account-rename-census.test.mjs` can prove the
 * decision itself with a fabricated zero rather than depending on the repo
 * ever actually reaching one (which would mean the guard already failed).
 */
export function zeroedTokens(perToken) {
  return perToken.filter((entry) => entry.count === 0).map((entry) => entry.token)
}

function main() {
  const ref = process.argv[2] ?? ''
  const { total, perToken, unallowed, overCeiling } = runCensus(ref)

  console.log(`#2906 naming census — ref: ${ref || '(working tree)'}`)
  console.log(`Tier-A pattern total (excluding false positives): ${total}`)
  console.log('Per-token counts (reported, not asserted — see ALLOWED):')
  for (const { token, count } of perToken) {
    console.log(`  ${token}: ${count}`)
  }

  // #2914: the assertion is no longer "every token is present" — the
  // contraction is supposed to drive these toward zero. It is "every
  // surviving hit sits in a path class that has a written reason".
  if (unallowed.length > 0) {
    const shown = unallowed.slice(0, 40)
    console.error(`\n#2906 census FAILED — ${unallowed.length} file(s) name the retired vocabulary with no recorded reason:`)
    for (const [file, count] of shown) {
      console.error(`  ${file} (${count} hit${count === 1 ? '' : 's'})`)
    }
    if (unallowed.length > shown.length) {
      console.error(`  … and ${unallowed.length - shown.length} more`)
    }
    console.error(
      '\nEither rename the occurrence to the account vocabulary, or add a path class to ' +
        'ALLOWED with the reason it must keep the old name. Do not widen a pattern or ' +
        'an exclusion to make this pass — those hide the finding instead of answering it.',
    )
    process.exitCode = 1
    return
  }

  if (overCeiling.length > 0) {
    console.error(`\n#2906 census FAILED — ${overCeiling.length} allow-listed file(s) gained retired-vocabulary hits:`)
    for (const [file, actual, ceiling] of overCeiling) {
      console.error(`  ${file}: ${actual} hit(s), ceiling ${ceiling}`)
    }
    console.error(
      '\nThese files are allow-listed for PROSE, a permanent fallback, or a refusal that must ' +
        'name the retired input — not as a licence to put the old vocabulary back on the wire. ' +
        'Raising a ceiling is a decision to argue for in review, not a way to make this pass.',
    )
    process.exitCode = 1
    return
  }

  console.log(`\n✓ every one of the ${total} surviving hit(s) is in an ALLOWED path class, and no allow-listed file grew.`)
}

// Only run as a CLI when invoked directly — importing `runCensus` for a test
// must not also execute `main()` and print/exit on the test's behalf.
if (import.meta.url === `file://${process.argv[1]}`) {
  main()
}
