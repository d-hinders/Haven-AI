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

const ref = process.argv[2] ?? ''
const total = grepTotalWithExclusions(ref)

console.log(`#2907 census — ref: ${ref || '(working tree)'}`)
console.log(`Tier-A pattern total (excluding false positives): ${total}`)
console.log('Per-token counts (each must be > 0):')
for (const token of PER_TOKEN) {
  const count = grepCount(ref, token, true)
  console.log(`  ${token.replace(/\\\\/g, '\\')}: ${count}`)
}
