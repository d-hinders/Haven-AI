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
 * This test imports both modules and asserts the exported value sets, key
 * names, and — since #2262, when the mirror gained the per-value prose the
 * served spec publishes as `x-enumDescriptions` — the description strings
 * themselves are identical. Failure prints a clear diff so the gap is
 * obvious.
 */

import { describe, expect, it } from 'vitest'
import * as sdk from '@haven_ai/sdk'
import * as backend from '../agent-payment-taxonomy.js'

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

  // #2262: the doc comment above has always claimed this file asserts
  // "description keysets are identical". It did not — there were no
  // descriptions in the mirror to assert. Now the served spec carries the
  // SDK's retirement prose through the mirror, so the strings themselves are
  // pinned VALUE-for-value, not just by key: a reworded description on either
  // side fails CI instead of silently forking into a second copy that drifts.
  it('AgentPaymentPhase descriptions are the SDK strings verbatim', () => {
    expect(backend.AgentPaymentPhaseDescriptions).toEqual(sdk.AgentPaymentPhaseDescriptions)
  })

  it('AgentPaymentNextAction descriptions are the SDK strings verbatim', () => {
    expect(backend.AgentPaymentNextActionDescriptions).toEqual(sdk.AgentPaymentNextActionDescriptions)
  })

  it('the five retired approval values document their retirement, not a wait', () => {
    // The point of shipping these into the spec at all. A raw-API integrator
    // must be able to read, from `/openapi.json` alone, that these values are
    // retired — the SDK user has had this since #2101.
    const retiredPhases = [
      sdk.AgentPaymentPhase.UserApprovalRequired,
      sdk.AgentPaymentPhase.UserExecutionRequired,
      sdk.AgentPaymentPhase.WaitingForAdditionalApprovals,
    ]
    for (const phase of retiredPhases) {
      expect(backend.AgentPaymentPhaseDescriptions[phase], phase).toContain('Retired wire value')
      expect(backend.AgentPaymentPhaseDescriptions[phase], phase).toContain('no live rail produces it')
    }

    const retiredNextActions = [
      sdk.AgentPaymentNextAction.WaitForUserApproval,
      sdk.AgentPaymentNextAction.WaitForUserToCompletePayment,
    ]
    for (const nextAction of retiredNextActions) {
      expect(backend.AgentPaymentNextActionDescriptions[nextAction], nextAction).toContain('Retired wire value')
      expect(
        backend.AgentPaymentNextActionDescriptions[nextAction].toLowerCase(),
        nextAction,
      ).toContain('stop and tell the user')
    }
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
