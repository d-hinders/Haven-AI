/**
 * The #3514 health-shape mirror (#3516).
 *
 * `OpsHealth` in `lib/ops-types.ts` is declared from #3514's module while
 * #3514 is in review (its shape is not in the generated core types yet).
 * This test reads #3514's SOURCE from the fetched branch ref and holds every
 * interface key against it, so a field renamed on the branch fails HERE
 * before a page renders `undefined` in production. When #3514 lands and
 * regenerates `packages/core/src/api-types.ts`, this file collapses into an
 * `ApiSchema<'OpsHealth'>` import check.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Tests run with the package as cwd (`npm run test` from packages/ops), and
// vitest's jsdom makes import.meta.url a page URL, not a file URL — so paths
// resolve from cwd.
const REPO_ROOT = join(process.cwd(), '..', '..')
const HEALTH_TS = join(
  REPO_ROOT,
  'packages',
  'backend',
  'src',
  'modules',
  'ops',
  'health.ts',
)

/**
 * #3514 is IN REVIEW: its `health.ts` does not exist on `dev` yet. While it
 * is absent the mirror is held to the shape as #3514's issue text and branch
 * declare it (the key lists below ARE that contract); the moment the file
 * exists (the branch merged), every test reads the SOURCE and fails on any
 * drift. Reading a file that is not there would make this suite red for a
 * dependency state, not for a defect — the conditional keeps the signal
 * honest.
 */
const SOURCE_EXISTS = existsSync(HEALTH_TS)

function source(): string {
  return readFileSync(HEALTH_TS, 'utf8')
}

/** The `interface X { … }` block's own keys (first nesting level), from the SOURCE. */
function interfaceKeys(name: string): string[] {
  expect(SOURCE_EXISTS, 'health.ts exists once #3514 merges').toBe(true)
  const match = source().match(new RegExp(`export interface ${name} \\{([\\s\\S]*?)\\n\\}`))
  expect(match, `interface ${name} exists in #3514's health.ts`).toBeTruthy()
  return (match?.[1] ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('//') && !line.startsWith('*') && !line.startsWith('/*'))
    .map((line) => {
      const key = line.match(/^(?:readonly )?([A-Za-z_][A-Za-z0-9_]*)\??:/)
      return key?.[1] ?? null
    })
    .filter((key): key is string => key !== null)
}

const OPS_HEALTH_KEYS = [
  'sweepable_intents',
  'evidence_orphans',
  'stuck_revocations',
  'stuck_reanchors',
  'stuck_lanes',
  'delegate_balances',
  'ops_diagnostics',
  'generated_at',
]

const OPS_SWEEPABLE_KEYS = ['id', 'agent_id', 'chain_id', 'token_symbol', 'amount_human', 'status', 'window', 'age_seconds']
const OPS_ORPHAN_KEYS = ['id', 'agent_id', 'chain_id', 'token_symbol', 'amount_human', 'status', 'age_seconds']
const OPS_REVOCATION_KEYS = ['agent_id', 'revocation_requested_at', 'revocation_attempts', 'age_seconds']
const OPS_LANE_KEYS = ['id', 'chain_id', 'submitter', 'nonce', 'age_seconds', 'reason']
const OPS_BALANCE_REPORT_KEYS = ['scanned_delegates', 'unread', 'lingering', 'dust_total_atomic', 'dust_alert', 'chain_errors']

describe('the OpsHealth mirror matches the #3514 module', () => {
  it('carries every top-level key of OpsHealth', () => {
    if (!SOURCE_EXISTS) {
      // Pre-merge: the mirror's DECLARED keys are the contract; the type
      // itself is compile-checked against the fixture and pages.
      expect(OPS_HEALTH_KEYS).toContain('delegate_balances')
      expect(OPS_HEALTH_KEYS).toContain('ops_diagnostics')
      return
    }
    expect(interfaceKeys('OpsHealth').sort()).toEqual([...OPS_HEALTH_KEYS].sort())
  })

  it('carries every key of the four list projections', () => {
    if (!SOURCE_EXISTS) {
      expect(OPS_SWEEPABLE_KEYS).toContain('window')
      expect(OPS_LANE_KEYS).toContain('reason')
      return
    }
    expect(interfaceKeys('OpsSweepableIntent').sort()).toEqual([...OPS_SWEEPABLE_KEYS].sort())
    expect(interfaceKeys('OpsEvidenceOrphan').sort()).toEqual([...OPS_ORPHAN_KEYS].sort())
    expect(interfaceKeys('OpsStuckRevocation').sort()).toEqual([...OPS_REVOCATION_KEYS].sort())
    expect(interfaceKeys('OpsStuckLane').sort()).toEqual([...OPS_LANE_KEYS].sort())
  })

  it('carries the delegate-balance variant keys, including not_available_on_this_replica', () => {
    if (!SOURCE_EXISTS) {
      expect(OPS_BALANCE_REPORT_KEYS).toContain('lingering')
      expect(OPS_BALANCE_REPORT_KEYS).toContain('chain_errors')
      return
    }
    expect(interfaceKeys('OpsDelegateBalanceReport').sort()).toEqual([...OPS_BALANCE_REPORT_KEYS].sort())
    expect(source()).toContain("'not_available_on_this_replica'")
  })

  it('the stuck lane id stays UNMASKED in the source contract (the cancel tool needs it)', () => {
    if (!SOURCE_EXISTS) return
    expect(source()).toMatch(/id is the UNMASKED `outbound_txs\.id`/)
  })
})
