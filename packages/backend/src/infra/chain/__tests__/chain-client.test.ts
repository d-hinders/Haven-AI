/**
 * `ChainClient` conformance (#1149).
 *
 * `viem-client.ts` had zero call sites and zero tests — the delegation
 * rail's implementation would have bit-rotted silently until its first real
 * balance read. Worse, the two implementations had already drifted: viem's
 * `getTokenBalance` silently returned the NATIVE balance for a zero token
 * address while ethers built a contract at `0x0`. Same call, two answers,
 * decided by the rail.
 *
 * So the interesting tests here run the SAME expectations against BOTH
 * implementations. A future divergence fails on the implementation that
 * moved, naming it.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'

const mockGetBalance = vi.fn()
const mockReadContract = vi.fn()
const mockEthersGetBalance = vi.fn()
const mockBalanceOf = vi.fn()

vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>()
  return {
    ...actual,
    createPublicClient: () => ({ getBalance: mockGetBalance, readContract: mockReadContract }),
    http: () => ({}),
  }
})

vi.mock('ethers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ethers')>()
  return {
    ...actual,
    ethers: {
      ...actual.ethers,
      Contract: class {
        balanceOf = mockBalanceOf
      },
    },
  }
})

vi.mock('../../../rails/allowance-module.js', () => ({
  getProvider: () => ({ getBalance: mockEthersGetBalance }),
}))

const { viemChainClient } = await import('../viem-client.js')
const { ethersChainClient } = await import('../ethers-client.js')
const { getChainClient } = await import('../index.js')

const CHAIN = 84532
const HOLDER = '0x9281d7c312e67859c65f4A3449F0548ea2f90974'
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
const ZERO = '0x0000000000000000000000000000000000000000'

beforeEach(() => {
  vi.clearAllMocks()
  mockGetBalance.mockResolvedValue(1_000n)
  mockReadContract.mockResolvedValue(2_000n)
  mockEthersGetBalance.mockResolvedValue(1_000n)
  mockBalanceOf.mockResolvedValue(2_000n)
})

describe('the factory is a genuine two-SDK choice', () => {
  it('routes each impl literal to its own SDK-backed implementation', () => {
    // The reason viem-client exists at all: if this ever collapsed to one
    // implementation, the port would be ceremony around a single path.
    expect(getChainClient('viem')).toBe(viemChainClient)
    expect(getChainClient('ethers')).toBe(ethersChainClient)
  })
})

// The conformance suite. Both implementations, identical expectations.
describe.each([
  ['viem (delegation rail)', () => viemChainClient],
  ['ethers (allowance-module rail)', () => ethersChainClient],
])('%s', (_name, client) => {
  it('reads a native balance', async () => {
    await expect(client().getNativeBalance(CHAIN, HOLDER)).resolves.toBe(1_000n)
  })

  it('reads an ERC-20 balance', async () => {
    await expect(client().getTokenBalance(CHAIN, USDC, HOLDER)).resolves.toBe(2_000n)
  })

  it('refuses the zero address as a token — that is getNativeBalance (#1149)', async () => {
    // The divergence this file exists to prevent: viem used to answer 1_000n
    // (the native balance) here while ethers called balanceOf on 0x0.
    await expect(client().getTokenBalance(CHAIN, ZERO, HOLDER)).rejects.toThrow(
      /requires an ERC-20 contract address/,
    )
  })

  it('refuses an empty token address rather than inventing an answer', async () => {
    await expect(client().getTokenBalance(CHAIN, '', HOLDER)).rejects.toThrow(
      /requires an ERC-20 contract address/,
    )
  })

  it('refuses before doing any chain I/O', async () => {
    await client().getTokenBalance(CHAIN, ZERO, HOLDER).catch(() => {})
    // A guard that throws AFTER the RPC call would still "pass" the refusal
    // tests above while burning a request and, on viem, returning native.
    expect(mockGetBalance).not.toHaveBeenCalled()
    expect(mockReadContract).not.toHaveBeenCalled()
    expect(mockEthersGetBalance).not.toHaveBeenCalled()
    expect(mockBalanceOf).not.toHaveBeenCalled()
  })

  it('checksums a lower-cased address (EIP-55)', async () => {
    expect(client().normaliseAddress(USDC.toLowerCase())).toBe(USDC)
  })

  it('leaves an already-checksummed address unchanged', async () => {
    expect(client().normaliseAddress(USDC)).toBe(USDC)
  })
})

describe('the two implementations agree', () => {
  it('produces byte-identical checksums for the same address', () => {
    // Two different SDKs implementing the same EIP-55. If they ever disagree,
    // an address normalised on one rail would not match the other's.
    for (const addr of [USDC, HOLDER, ZERO]) {
      expect(viemChainClient.normaliseAddress(addr.toLowerCase())).toBe(
        ethersChainClient.normaliseAddress(addr.toLowerCase()),
      )
    }
  })
})
