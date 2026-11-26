/**
 * #4890: the bounds the shared core puts on every chain read, and the chain
 * the client is built for. The behaviour of the search itself (what an event
 * means, the window arithmetic) is characterised in the demo merchant's
 * `cdp-chain-reader.test.ts`; these pin what the move added.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { createPublicClient, custom, getAddress, toHex, type Address, type Hex } from 'viem'
import { base } from 'viem/chains'
import {
  CDP_CALL_TIMEOUT_MS,
  CDP_SECRET_CANNOT_SIGN,
  CHAIN_READ_TIMEOUT_MS,
  CdpSecretError,
  CdpTimeoutError,
  SETTLE_RESOLVE_MS,
  createCdpChainReader,
  createViemChainReadClient,
  preflightCdpSecret,
  resolveCdpCredentials,
  withCdpTimeout,
  type ChainReadClient,
} from './cdp.js'

const USDC: Address = getAddress('0x833589fcd6edb6e08f4c7c32d4f71b54bda02913')
const PAYER = getAddress('0x1a642f0e3c3af545e7acbd38b07251b3990914f1')
const MERCHANT = getAddress('0x15179876c595922999c2d5dc7c23cc7711fe799a')
const NONCE = `0x${'ab12'.repeat(16)}` as Hex
const NOW = 1_800_000_000n
const LATEST = 30_000_000n
const BLOCK_HASH = `0x${'11'.repeat(32)}` as Hex

const PARAMS = {
  authorizer: PAYER,
  nonce: NONCE,
  to: MERCHANT,
  value: 10_000n,
  // A window far longer than the search cap, so the scan has many windows to walk.
  validAfter: 0n,
  validBefore: NOW - 300n,
}

function block() {
  return {
    number: toHex(LATEST),
    timestamp: toHex(NOW),
    hash: BLOCK_HASH,
    parentHash: BLOCK_HASH,
    transactions: [],
    gasLimit: '0x0',
    gasUsed: '0x0',
    baseFeePerGas: '0x0',
  }
}

/** A client whose node answers `answers` per method; a method not listed never answers. */
function client(answers: Record<string, () => Promise<unknown>>, calls: string[] = []): ChainReadClient {
  const transport = custom(
    {
      async request({ method }: { method: string }) {
        calls.push(method)
        const answer = answers[method]
        if (!answer) return new Promise<never>(() => {})
        return answer()
      },
    },
    { retryCount: 0 },
  )
  return createPublicClient({ chain: base, transport }) as ChainReadClient
}

describe('every chain read is bounded (#4890)', () => {
  it('the defaults are 10 s per read and 30 s per search', () => {
    expect(CHAIN_READ_TIMEOUT_MS).toBe(10_000)
    expect(SETTLE_RESOLVE_MS).toBe(30_000)
    expect(CDP_CALL_TIMEOUT_MS).toBe(30_000)
  })

  it('a node that never answers: authorizationUsed rejects at the read bound', async () => {
    const reader = createCdpChainReader(client({}), { usdcAddress: USDC, readTimeoutMs: 50 })
    const started = Date.now()
    await expect(reader.authorizationUsed(PAYER, NONCE)).rejects.toBeInstanceOf(CdpTimeoutError)
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  it('a node that never answers: the search rejects at the first read, never hangs', async () => {
    const reader = createCdpChainReader(client({}), { usdcAddress: USDC, readTimeoutMs: 50, resolveTimeoutMs: 5_000 })
    const started = Date.now()
    await expect(reader.findAuthorizationOutcome(PARAMS)).rejects.toBeInstanceOf(CdpTimeoutError)
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  it('a node that answers the head but never the logs: the getLogs read is bounded', async () => {
    const reader = createCdpChainReader(client({ eth_getBlockByNumber: async () => block() }), {
      usdcAddress: USDC,
      readTimeoutMs: 50,
      resolveTimeoutMs: 5_000,
    })
    const started = Date.now()
    await expect(reader.findAuthorizationOutcome(PARAMS)).rejects.toBeInstanceOf(CdpTimeoutError)
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  it('a slow getLogs: the whole search rejects at the resolve bound and stops scanning', async () => {
    const calls: string[] = []
    const reader = createCdpChainReader(
      client(
        {
          eth_getBlockByNumber: async () => block(),
          // Each window answers, slowly and with nothing, so an unbounded scan would walk them all.
          eth_getLogs: () => new Promise((resolve) => setTimeout(() => resolve([]), 60)),
        },
        calls,
      ),
      { usdcAddress: USDC, readTimeoutMs: 1_000, resolveTimeoutMs: 100 },
    )
    const started = Date.now()
    await expect(reader.findAuthorizationOutcome(PARAMS)).rejects.toBeInstanceOf(CdpTimeoutError)
    expect(Date.now() - started).toBeLessThan(500)
    // The scan must not carry on in the background once the bound has passed.
    await new Promise((resolve) => setTimeout(resolve, 400))
    const logReads = calls.filter((method) => method === 'eth_getLogs').length
    expect(logReads).toBeGreaterThan(0)
    expect(logReads).toBeLessThanOrEqual(3)
  })

  it('a chain_read timeout names the chain, not the facilitator', async () => {
    const error = await withCdpTimeout('chain_read', 5, () => new Promise(() => {})).catch((err: unknown) => err)
    expect(error).toBeInstanceOf(CdpTimeoutError)
    expect((error as CdpTimeoutError).operation).toBe('chain_read')
    expect((error as CdpTimeoutError).message).toBe('Chain read did not answer within 5 ms')
  })

  it('the facilitator timeouts keep their message', async () => {
    const error = await withCdpTimeout('settle', 5, () => new Promise(() => {})).catch((err: unknown) => err)
    expect((error as CdpTimeoutError).message).toBe('Coinbase facilitator settle did not answer within 5 ms')
  })
})

describe('createViemChainReadClient (#4890)', () => {
  it('serves Base and Base Sepolia', () => {
    expect(createViemChainReadClient('http://localhost:1', 8453).chain?.id).toBe(8453)
    expect(createViemChainReadClient('http://localhost:1', 84532).chain?.id).toBe(84532)
  })

  it.each([1, 100, 0, 8454])('refuses chain %s: there is no default chain', (chainId) => {
    expect(() => createViemChainReadClient('http://localhost:1', chainId)).toThrow(`Unsupported chain ${chainId}`)
  })
})

describe('resolveCdpCredentials (#4890)', () => {
  it('appends the caller\'s note to the warning, and nothing else of the merchant\'s', () => {
    const messages: string[] = []
    expect(resolveCdpCredentials('id', undefined, (m) => messages.push(m), 'Product X is not offered.')).toBeUndefined()
    expect(messages).toEqual([
      'Coinbase facilitator (CDP) settlement is disabled: set BOTH CDP_API_KEY_ID and CDP_API_KEY_SECRET. Product X is not offered.',
    ])
  })

  it('without a note the warning has no trailing space', () => {
    const messages: string[] = []
    resolveCdpCredentials(undefined, 'secret', (m) => messages.push(m))
    expect(messages[0]!.endsWith('CDP_API_KEY_SECRET.')).toBe(true)
  })
})

/** #5060: a valid Ed25519 CDP secret — the 32-byte seed then its derived public key, base64. */
function validSecret(): string {
  const { privateKey } = generateKeyPairSync('ed25519')
  const jwk = privateKey.export({ format: 'jwk' }) as { d: string; x: string }
  return Buffer.concat([Buffer.from(jwk.d, 'base64url'), Buffer.from(jwk.x, 'base64url')]).toString('base64')
}

describe('preflightCdpSecret (#5060)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('accepts a generated Ed25519 key pair', async () => {
    await expect(preflightCdpSecret({ apiKeyId: 'organizations/x/apiKeys/y', apiKeySecret: validSecret() })).resolves.toBeUndefined()
  })

  it('refuses the .env.example placeholder, naming the variable and never the value', async () => {
    const secret = 'your-cdp-api-key-secret'
    const failure = await preflightCdpSecret({ apiKeyId: 'id', apiKeySecret: secret }).then(
      () => undefined,
      (err: unknown) => err,
    )
    expect(failure).toBeInstanceOf(CdpSecretError)
    expect((failure as Error).message).toBe(CDP_SECRET_CANNOT_SIGN)
    expect((failure as Error).message).toContain('CDP_API_KEY_SECRET')
    expect((failure as Error).message).not.toContain(secret)
  })

  it('refuses 64 random bytes: the SDK accepts the format, then cannot sign with it', async () => {
    const secret = randomBytes(64).toString('base64')
    await expect(preflightCdpSecret({ apiKeyId: 'id', apiKeySecret: secret })).rejects.toBeInstanceOf(CdpSecretError)
  })

  it('makes no network call', async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error('the preflight must not reach the network')
    })
    vi.stubGlobal('fetch', fetchSpy)
    await preflightCdpSecret({ apiKeyId: 'id', apiKeySecret: validSecret() })
    await expect(preflightCdpSecret({ apiKeyId: 'id', apiKeySecret: randomBytes(64).toString('base64') })).rejects.toBeInstanceOf(
      CdpSecretError,
    )
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
