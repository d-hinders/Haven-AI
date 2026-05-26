/**
 * Cross-package parity test.
 *
 * The agent payment taxonomy is exported from `@haven_ai/sdk` (source of
 * truth) and re-declared in this package as a hand-mirror so backend code can
 * typecheck without depending on a built SDK artifact at compile time. The
 * mirror saves CI time but introduces a real drift risk — if someone adds a
 * phase to the SDK and forgets the mirror (or vice versa) the two sides
 * silently disagree. The OpenAPI spec and the MCP server both consume the
 * SDK enums, so the wire surface would lie about what the backend can
 * actually emit.
 *
 * This test imports both modules and asserts the exported value sets and
 * description keysets are identical. Failure prints a clear diff so the gap
 * is obvious.
 */

import { describe, expect, it } from 'vitest'
import * as sdk from '@haven_ai/sdk'
import * as backend from './agent-payment-taxonomy.js'

describe('agent payment taxonomy parity', () => {
  it('AgentPaymentPhase values match between SDK and backend mirror', () => {
    expect(Object.values(backend.AgentPaymentPhase).sort()).toEqual(
      Object.values(sdk.AgentPaymentPhase).sort(),
    )
  })

  it('AgentPaymentPhase key names match between SDK and backend mirror', () => {
    expect(Object.keys(backend.AgentPaymentPhase).sort()).toEqual(
      Object.keys(sdk.AgentPaymentPhase).sort(),
    )
  })

  it('AgentPaymentNextAction values match between SDK and backend mirror', () => {
    expect(Object.values(backend.AgentPaymentNextAction).sort()).toEqual(
      Object.values(sdk.AgentPaymentNextAction).sort(),
    )
  })

  it('AgentPaymentNextAction key names match between SDK and backend mirror', () => {
    expect(Object.keys(backend.AgentPaymentNextAction).sort()).toEqual(
      Object.keys(sdk.AgentPaymentNextAction).sort(),
    )
  })

  it('AgentPaymentRail values match between SDK and backend mirror', () => {
    expect(Object.values(backend.AgentPaymentRail).sort()).toEqual(
      Object.values(sdk.AgentPaymentRail).sort(),
    )
  })

  it('AgentPaymentRail key names match between SDK and backend mirror', () => {
    expect(Object.keys(backend.AgentPaymentRail).sort()).toEqual(
      Object.keys(sdk.AgentPaymentRail).sort(),
    )
  })

  it('AgentPaymentRail contains every MachinePaymentRail wire value', () => {
    // MachinePaymentRail is the granular type used on response bodies. Every
    // value the backend can emit on the `rail` field must be representable in
    // the documented enum, otherwise OpenAPI consumers (and MCP clients
    // reading `phase`/`nextAction`/`rail` together) will reject valid
    // responses.
    const machineRails = ['x402', 'mpp_demo', 'mpp_crypto', 'stripe_deposit', 'spt']
    const railValues = Object.values(sdk.AgentPaymentRail)
    for (const rail of machineRails) {
      expect(railValues).toContain(rail)
    }
  })
})
