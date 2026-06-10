import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Address, Hash, PublicClient } from 'viem'

import { executeAgentSetup } from '@/lib/agent-setup'
import { SafeTxReceiptTimeoutError } from '@/lib/safe-tx'
import type { HavenUserSigner } from '@/lib/signer'

// Mock the on-chain primitives so the test exercises only the orchestration.
vi.mock('@/lib/allowance-module', () => ({
  isModuleEnabled: vi.fn().mockResolvedValue(true),
  buildAgentSetupTx: vi.fn().mockReturnValue({ to: '0xmodule', nonce: 5n }),
}))

const executeSafeTx = vi.fn()
const proposeSafeTx = vi.fn().mockResolvedValue(undefined)
const signSafeTx = vi.fn().mockResolvedValue('0xsig')
const getSafeNonce = vi.fn().mockResolvedValue(5n)
const getSafeTxHash = vi.fn().mockReturnValue('0xsafetxhash' as Hash)

vi.mock('@/lib/safe-tx', async () => {
  const actual = await vi.importActual<typeof import('@/lib/safe-tx')>('@/lib/safe-tx')
  return {
    ...actual,
    executeSafeTx: (...args: unknown[]) => executeSafeTx(...args),
    proposeSafeTx: (...args: unknown[]) => proposeSafeTx(...args),
    signSafeTx: (...args: unknown[]) => signSafeTx(...args),
    getSafeNonce: (...args: unknown[]) => getSafeNonce(...args),
    getSafeTxHash: (...args: unknown[]) => getSafeTxHash(...args),
  }
})

const SIGNER = { type: 'eoa', address: '0xowner' } as unknown as HavenUserSigner
const PUBLIC_CLIENT = {} as PublicClient
const baseParams = {
  signer: SIGNER,
  publicClient: PUBLIC_CLIENT,
  safeAddress: '0xsafe' as Address,
  delegateAddress: '0xdelegate' as Address,
  allowances: [],
  chainId: 8453,
}

describe('executeAgentSetup', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns confirmed with the on-chain tx hash for a single-owner Safe', async () => {
    executeSafeTx.mockResolvedValueOnce({ txHash: '0xonchain' as Hash })

    const result = await executeAgentSetup({ ...baseParams, threshold: 1 })

    expect(result).toEqual({
      status: 'confirmed',
      txHash: '0xonchain',
      safeTxHash: '0xsafetxhash',
    })
    expect(proposeSafeTx).not.toHaveBeenCalled()
  })

  it('returns proposed with the SafeTx hash for a multisig Safe', async () => {
    const result = await executeAgentSetup({ ...baseParams, threshold: 2 })

    expect(result).toEqual({
      status: 'proposed',
      txHash: '0xsafetxhash',
      safeTxHash: '0xsafetxhash',
    })
    expect(executeSafeTx).not.toHaveBeenCalled()
    expect(proposeSafeTx).toHaveBeenCalledTimes(1)
  })

  it('converts a receipt timeout into a status (not a throw) carrying both hashes', async () => {
    executeSafeTx.mockRejectedValueOnce(new SafeTxReceiptTimeoutError('0xpending' as Hash))

    const result = await executeAgentSetup({ ...baseParams, threshold: 1 })

    expect(result).toEqual({
      status: 'receipt_timeout',
      txHash: '0xpending',
      safeTxHash: '0xsafetxhash',
    })
  })

  it('rethrows non-timeout execution errors', async () => {
    executeSafeTx.mockRejectedValueOnce(new Error('user rejected'))

    await expect(executeAgentSetup({ ...baseParams, threshold: 1 })).rejects.toThrow('user rejected')
  })

  it('reports progress in order: checking → signing → executing', async () => {
    executeSafeTx.mockResolvedValueOnce({ txHash: '0xonchain' as Hash })
    const onStatus = vi.fn()

    await executeAgentSetup({ ...baseParams, threshold: 1, onStatus })

    expect(onStatus.mock.calls.map((c) => c[0])).toEqual(['checking', 'signing', 'executing'])
  })
})
