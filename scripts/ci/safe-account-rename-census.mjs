#!/usr/bin/env node
/**
 * #2907 (naming epic #2906) census — the exact pattern and exclusion list
 * pinned in the issue body (corrected 2026-09-12 after Philip's re-review:
 * explicit `[A-Za-z0-9_]*` tails on `HAVEN_SAFE`/`ACTIVE_SAFE` so the group
 * cannot silently fail to match `HAVEN_SAFE_ADDRESS` / `haven_active_safe_id`
 * — `_` is a word character, so a bare token inside `\b(...)\b` never
 * reaches past its own boundary into the tail).
 *
 * Every later naming slice and every guard builds its census on this same
 * pattern (Daniel's ask, #2906) — do not hand-roll a second one.
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

function grepTotalWithExclusions(ref) {
  const args = ['grep', '-nP', PATTERN]
  if (ref) args.push(ref)
  args.push('--', ...PATHSPECS)
  let out
  try {
    out = execFileSync('git', args, { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 })
  } catch (err) {
    if (err.status === 1) return 0
    throw err
  }
  const exclusionRe = new RegExp(EXCLUSIONS)
  return out
    .split('\n')
    .filter((line) => line.length > 0 && !exclusionRe.test(line))
    .length
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
  const total = grepTotalWithExclusions(ref)
  const perToken = PER_TOKEN.map((token) => ({ token, count: grepCount(ref, token, true) }))
  return { ref, total, perToken }
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
  const { total, perToken } = runCensus(ref)

  console.log(`#2907 census — ref: ${ref || '(working tree)'}`)
  console.log(`Tier-A pattern total (excluding false positives): ${total}`)
  console.log('Per-token counts (each must be > 0):')
  for (const { token, count } of perToken) {
    console.log(`  ${token}: ${count}`)
  }

  // Printing a zero and exiting 0 anyway is the same failure mode this script
  // exists to prevent, so a zero here fails the run rather than scrolling
  // past in a green CI log.
  const zeroed = zeroedTokens(perToken)
  if (zeroed.length > 0) {
    console.error(`\n#2907 census FAILED — zero matches for: ${zeroed.join(', ')}`)
    console.error(
      'A per-token count of 0 means that token is not just rare, it is ABSENT — the ' +
        'assertion this census exists to make. Fix the pattern or the census scope, not the threshold.',
    )
    process.exitCode = 1
  }
}

// Only run as a CLI when invoked directly — importing `runCensus` for a test
// must not also execute `main()` and print/exit on the test's behalf.
if (import.meta.url === `file://${process.argv[1]}`) {
  main()
}
