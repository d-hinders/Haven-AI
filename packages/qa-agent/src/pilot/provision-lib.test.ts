import { describe, expect, it } from 'vitest'
import { ethers } from 'ethers'
import {
  SAFE7579_ABI,
  SAFE_ABI,
  buildProvisionBatch,
  encodeMultiSendTransactions,
  safeTxTypedData,
} from './provision-lib.js'

const SAFE = '0x' + 'aa'.repeat(20)
const ADAPTER = '0x' + 'bb'.repeat(20)
const SESSIONS = '0x' + 'cc'.repeat(20)

describe('encodeMultiSendTransactions', () => {
  it('packs operation ++ to ++ value ++ length ++ data', () => {
    const encoded = encodeMultiSendTransactions([
      { to: SAFE, value: 0n, data: '0x1234', operation: 0 },
    ])
    expect(encoded).toBe(
      '0x00' + // operation
        'aa'.repeat(20) + // to
        '00'.repeat(32) + // value
        '00'.repeat(31) + '02' + // data length = 2
        '1234', // data
    )
  })

  it('concatenates multiple txs without separators', () => {
    const one = encodeMultiSendTransactions([{ to: SAFE, value: 0n, data: '0x', operation: 0 }])
    const two = encodeMultiSendTransactions([
      { to: SAFE, value: 0n, data: '0x', operation: 0 },
      { to: SAFE, value: 0n, data: '0x', operation: 0 },
    ])
    expect(two).toBe(one + one.slice(2))
  })
})

describe('buildProvisionBatch', () => {
  const batch = buildProvisionBatch({
    safeAddress: SAFE,
    safe7579Adapter: ADAPTER,
    smartSessionsValidator: SESSIONS,
  })
  const safeIface = new ethers.Interface(SAFE_ABI)
  const adapterIface = new ethers.Interface(SAFE7579_ABI)

  it('is exactly three plain CALLs, all targeting the Safe (2771 fallback routing)', () => {
    expect(batch).toHaveLength(3)
    expect(batch.map((t) => t.operation)).toEqual([0, 0, 0])
    // initializeAccount goes to the SAFE, not the adapter — the adapter's
    // HandlerContext access control only authenticates via the fallback path.
    expect(batch.map((t) => t.to.toLowerCase())).toEqual([SAFE, SAFE, SAFE])
  })

  it('enables the adapter as module, then as fallback handler', () => {
    expect(batch[0].data.slice(0, 10)).toBe(safeIface.getFunction('enableModule')!.selector)
    expect(batch[1].data.slice(0, 10)).toBe(safeIface.getFunction('setFallbackHandler')!.selector)
    expect(safeIface.decodeFunctionData('enableModule', batch[0].data)[0].toLowerCase()).toBe(ADAPTER)
  })

  it('initializes with Smart Sessions as sole validator and registry gating disabled', () => {
    const decoded = adapterIface.decodeFunctionData('initializeAccount', batch[2].data)
    const [validators, executors, fallbacks, hooks, registryInit] = decoded
    expect(validators).toHaveLength(1)
    expect(validators[0].module.toLowerCase()).toBe(SESSIONS)
    expect(validators[0].initData).toBe('0x')
    expect(executors).toHaveLength(0)
    expect(fallbacks).toHaveLength(0)
    expect(hooks).toHaveLength(0)
    // pilot runs without ERC-7484 gating — no attestation coverage on Base
    // Sepolia for this Smart Sessions deployment (Stage 2 finding, see lib docs)
    expect(registryInit.registry).toBe(ethers.ZeroAddress)
    expect([...registryInit.attesters]).toEqual([])
    expect(registryInit.threshold).toBe(0n)
  })
})

describe('safeTxTypedData', () => {
  it('produces a hashable Safe v1.4.1 SafeTx payload', () => {
    const typed = safeTxTypedData({
      chainId: 84532,
      safeAddress: SAFE,
      to: ADAPTER,
      data: '0x1234',
      operation: 1,
      nonce: 3n,
    })
    expect(typed.domain).toEqual({ chainId: 84532, verifyingContract: SAFE })
    expect(typed.message.nonce).toBe(3n)
    expect(typed.message.operation).toBe(1)
    const hash = ethers.TypedDataEncoder.hash(typed.domain, typed.types, typed.message)
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/)
  })
})
