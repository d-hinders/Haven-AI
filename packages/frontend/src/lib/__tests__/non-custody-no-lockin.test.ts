import { describe, it, expect } from 'vitest'
import { decodeFunctionData, type Address } from 'viem'
import { buildAgentRevokeTx, allowanceModuleFor } from '../allowance-module'

const CHAIN_ID = 8453 // Base mainnet

/**
 * No-lock-in contract test (design: docs/research/non-custody-verification.md;
 * guardrail: casp-risk-guardrails.md Red Line #10 — users can revoke agent
 * authority independently of Haven).
 *
 * Proves agent revocation is a user-signed ON-CHAIN action against the Safe
 * AllowanceModule — not a Haven-only database flip. The user (or any
 * Safe-compatible UI) can produce this exact transaction and remove the agent's
 * authority without Haven's cooperation.
 */

const REMOVE_DELEGATE_ABI = [
  {
    type: 'function',
    name: 'removeDelegate',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'delegate', type: 'address' },
      { name: 'removeAllowances', type: 'bool' },
    ],
    outputs: [],
  },
] as const

const DELEGATE = '0x1a642f0E3c3aF545E7AcBD38b07251B3990914F1' as Address

describe('no lock-in: agent revocation is a user-signed on-chain Safe tx', () => {
  it('targets the AllowanceModule and removes the delegate on-chain', () => {
    const tx = buildAgentRevokeTx(DELEGATE, 5n, CHAIN_ID)

    // Goes to the on-chain AllowanceModule, not a Haven endpoint.
    expect(tx.to).toBe(allowanceModuleFor(CHAIN_ID))
    expect(tx.value).toBe(0n)
    expect(tx.operation).toBe(0) // a plain call, not a delegatecall

    const decoded = decodeFunctionData({ abi: REMOVE_DELEGATE_ABI, data: tx.data as `0x${string}` })
    expect(decoded.functionName).toBe('removeDelegate')
    expect(decoded.args[0]).toBe(DELEGATE)
    expect(decoded.args[1]).toBe(true) // also wipe the delegate's allowances
  })

  it('carries the user-supplied Safe nonce, so the owner signs it', () => {
    expect(buildAgentRevokeTx(DELEGATE, 42n, CHAIN_ID).nonce).toBe(42n)
  })
})
