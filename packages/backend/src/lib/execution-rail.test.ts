import { describe, expect, it, vi } from 'vitest'
import { Wallet, getBytes } from 'ethers'

vi.mock('../db.js', () => ({ default: { query: vi.fn() } }))

const {
  deserializeUserOp,
  recoverSessionSigner,
  resolveExecutionRail,
  serializeUserOp,
} = await import('./execution-rail.js')

const PERMISSION_ID = ('0x' + 'ab'.repeat(32)) as `0x${string}`
const CHAIN = 84532 // Base Sepolia — the only session-rail chain today

describe('resolveExecutionRail — fail-closed decision matrix', () => {
  const full = {
    safeExecutionRail: 'session_key',
    sessionPermissionId: PERMISSION_ID,
    chainId: CHAIN,
  }

  it('routes to the session rail only with the full state', () => {
    expect(resolveExecutionRail(full)).toEqual({
      rail: 'session_key',
      permissionId: PERMISSION_ID,
    })
  })

  it.each([
    ['default legacy safe', { ...full, safeExecutionRail: 'allowance_module' }],
    ['missing safe row', { ...full, safeExecutionRail: null }],
    ['unknown safe rail value', { ...full, safeExecutionRail: 'something_else' }],
    ['no agent session', { ...full, sessionPermissionId: null }],
    ['malformed permissionId', { ...full, sessionPermissionId: '0x1234' }],
    ['non-hex permissionId', { ...full, sessionPermissionId: '0x' + 'zz'.repeat(32) }],
    ['chain not allowlisted (Base mainnet)', { ...full, chainId: 8453 }],
    ['chain not allowlisted (Gnosis)', { ...full, chainId: 100 }],
  ])('falls back to allowance_module when %s', (_label, state) => {
    expect(resolveExecutionRail(state)).toEqual({ rail: 'allowance_module' })
  })
})

describe('serializeUserOp / deserializeUserOp', () => {
  const userOp = {
    sender: '0x' + 'aa'.repeat(20),
    nonce: 123456789012345678901234567890n,
    callData: '0xdeadbeef',
    maxFeePerGas: 1_000_000n,
    factory: null,
    paymasterData: '0x',
    nested: { verificationGasLimit: 900_000n },
  }

  it('round-trips bigints exactly (string path)', () => {
    expect(deserializeUserOp(serializeUserOp(userOp))).toEqual(userOp)
  })

  it('round-trips through a JSONB read (pg returns a parsed object)', () => {
    // node-postgres parses JSONB columns — simulate: parse WITHOUT the reviver.
    const fromPg = JSON.parse(serializeUserOp(userOp))
    expect(deserializeUserOp(fromPg)).toEqual(userOp)
  })
})

describe('recoverSessionSigner — EIP-191, never raw ECDSA', () => {
  const wallet = new Wallet('0x' + '11'.repeat(32))
  const hash = ('0x' + 'cd'.repeat(32)) as `0x${string}`

  it('recovers the signer of an EIP-191 personal-sign over the hash', async () => {
    // Exactly what signUserOpHashForSession (@haven_ai/sdk, #741) produces.
    const signature = await wallet.signMessage(getBytes(hash))
    expect(recoverSessionSigner(hash, signature).toLowerCase()).toBe(
      wallet.address.toLowerCase(),
    )
  })

  it('does NOT recover the signer of a raw-ECDSA signature (the #731 footgun)', () => {
    const raw = wallet.signingKey.sign(hash).serialized
    expect(recoverSessionSigner(hash, raw).toLowerCase()).not.toBe(
      wallet.address.toLowerCase(),
    )
  })
})
