/**
 * #2016 — the decoder that lets an over-budget scenario say WHY it was refused.
 *
 * The fixture is not invented: it is the verbatim `details` prefix the shared
 * dev backend returned on 2026-08-25 for `POST /payments` with 2 USDC against
 * a 1.00 USDC/day budget delegation. If the bundler's error shape ever changes,
 * this test is where it shows up — as a red decoder rather than as a QA leg
 * that silently stops proving anything.
 */
import { describe, it, expect } from 'vitest'
import { caveatEnforcerRejection, decodeRevertStrings } from './revert-reason.js'

/** Verbatim from a live Base Sepolia refusal (dev backend, 2026-08-25). */
const LIVE_OVER_BUDGET_DETAILS =
  'Execution reverted with reason: UserOperation reverted during simulation with reason: ' +
  '0x08c379a000000000000000000000000000000000000000000000000000000000000000200000000000000000' +
  '000000000000000000000000000000000000000000000034' +
  '4552433230506572696f645472616e73666572456e666f726365723a7472616e736665722d616d6f756e742d65786365656465' +
  '64000000000000000000000000.\n\nRequest Arguments:\n  callData: 0x5c1c6dcd'

describe('caveatEnforcerRejection', () => {
  it('names the enforcer inside a live over-budget refusal', () => {
    expect(caveatEnforcerRejection(LIVE_OVER_BUDGET_DETAILS)).toBe(
      'ERC20PeriodTransferEnforcer:transfer-amount-exceeded',
    )
  })

  it('finds an enforcer name that arrives as plain text, not only as hex', () => {
    // The mocked shape backend tests use (`routes/__tests__/…`) — same meaning,
    // different spelling. Both must be recognised or the leg's verdict would
    // depend on which layer formatted the error.
    expect(
      caveatEnforcerRejection('ERC20PeriodTransferEnforcer:transfer-amount-exceeded at https://bundler'),
    ).toBe('ERC20PeriodTransferEnforcer:transfer-amount-exceeded')
  })

  it('returns null for a refusal that did NOT come from an enforcer', () => {
    // The whole point: a bundler outage must not be readable as budget proof.
    expect(caveatEnforcerRejection('fetch failed: ECONNREFUSED api.pimlico.io')).toBeNull()
    expect(caveatEnforcerRejection('AA31 paymaster deposit too low')).toBeNull()
    expect(caveatEnforcerRejection(undefined)).toBeNull()
  })

  it('does not mistake unrelated hex for a reason string', () => {
    // A calldata dump is hex too; it must not decode into a false positive.
    expect(caveatEnforcerRejection('0x' + '00'.repeat(64))).toBeNull()
  })

  it('decodeRevertStrings can actually see into the hex (positive control)', () => {
    // Without this, every null above would be consistent with a decoder that
    // decodes nothing at all — the empty-set pass this suite exists to avoid.
    expect(decodeRevertStrings(LIVE_OVER_BUDGET_DETAILS)).toContain(
      '4ERC20PeriodTransferEnforcer:transfer-amount-exceeded',
    )
  })
})
