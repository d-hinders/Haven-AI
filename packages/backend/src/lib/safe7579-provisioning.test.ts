import { describe, expect, it } from 'vitest'
import { Interface, getAddress, ZeroAddress } from 'ethers'
import { getChain } from './chains.js'
import {
  SAFE7579_ABI,
  SAFE7579_ADAPTER,
  SAFE_MODULE_ABI,
  SMART_SESSIONS_VALIDATOR,
  buildProvisionBatch,
  buildProvisionMigrationPayload,
  encodeMultiSendTransactions,
} from './safe7579-provisioning.js'

const SAFE = '0x' + 'aa'.repeat(20)
const BASE_SEPOLIA = 84532

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
  const batch = buildProvisionBatch(SAFE)
  const safeIface = new Interface(SAFE_MODULE_ABI)
  const adapterIface = new Interface(SAFE7579_ABI)

  it('is exactly three plain CALLs, all targeting the Safe (2771 fallback routing)', () => {
    expect(batch).toHaveLength(3)
    expect(batch.map((t) => t.operation)).toEqual([0, 0, 0])
    // initializeAccount goes to the SAFE, not the adapter — the adapter's
    // HandlerContext access control only authenticates via the fallback path.
    expect(batch.map((t) => t.to)).toEqual([getAddress(SAFE), getAddress(SAFE), getAddress(SAFE)])
  })

  it('enables the adapter as module, then as fallback handler', () => {
    expect(batch[0].data.slice(0, 10)).toBe(safeIface.getFunction('enableModule')!.selector)
    expect(batch[1].data.slice(0, 10)).toBe(safeIface.getFunction('setFallbackHandler')!.selector)
    expect(getAddress(safeIface.decodeFunctionData('enableModule', batch[0].data)[0])).toBe(
      SAFE7579_ADAPTER,
    )
    expect(getAddress(safeIface.decodeFunctionData('setFallbackHandler', batch[1].data)[0])).toBe(
      SAFE7579_ADAPTER,
    )
  })

  it('initializes with Smart Sessions as sole validator and registry gating disabled', () => {
    const decoded = adapterIface.decodeFunctionData('initializeAccount', batch[2].data)
    const [validators, executors, fallbacks, hooks, registryInit] = decoded
    expect(validators).toHaveLength(1)
    expect(getAddress(validators[0].module)).toBe(SMART_SESSIONS_VALIDATOR)
    expect(validators[0].initData).toBe('0x')
    expect(executors).toHaveLength(0)
    expect(fallbacks).toHaveLength(0)
    expect(hooks).toHaveLength(0)
    // pilot runs without ERC-7484 gating — re-enabling it is gate #735.
    expect(registryInit.registry).toBe(ZeroAddress)
    expect([...registryInit.attesters]).toEqual([])
    expect(registryInit.threshold).toBe(0n)
  })
})

describe('buildProvisionMigrationPayload', () => {
  it('is one delegatecall to the chain MultiSendCallOnly wrapping the batch', () => {
    const payload = buildProvisionMigrationPayload(SAFE, BASE_SEPOLIA)
    const chain = getChain(BASE_SEPOLIA)
    expect(payload.to).toBe(getAddress(chain.contracts.multiSendCallOnly))
    expect(payload.value).toBe('0')
    expect(payload.operation).toBe(1)

    const multiSendIface = new Interface(['function multiSend(bytes transactions) payable'])
    const [transactions] = multiSendIface.decodeFunctionData('multiSend', payload.data)
    expect(transactions).toBe(encodeMultiSendTransactions(buildProvisionBatch(SAFE)))
  })
})
