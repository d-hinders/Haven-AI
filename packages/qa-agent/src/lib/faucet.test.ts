import { beforeEach, describe, expect, it, vi } from 'vitest'

const { generateJwt } = vi.hoisted(() => ({ generateJwt: vi.fn() }))

vi.mock('@coinbase/cdp-sdk/auth', () => ({ generateJwt }))

import { CdpFaucetError, requestCdpEvmFaucet } from './faucet.js'

const ADDRESS = '0x1111111111111111111111111111111111111111'
const API_KEY_ID = 'organizations/example/apiKeys/test-key'
const API_KEY_SECRET = 'test-secret-that-must-never-escape'

const baseOptions = () => ({
  address: ADDRESS,
  chainId: 84532,
  apiKeyId: API_KEY_ID,
  apiKeySecret: API_KEY_SECRET,
})

describe('requestCdpEvmFaucet', () => {
  beforeEach(() => {
    generateJwt.mockReset()
    generateJwt.mockResolvedValue('signed-jwt')
  })

  it('requests Base Sepolia ETH exactly once and returns the transaction hash', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ transactionHash: '0xabc123' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    await expect(
      requestCdpEvmFaucet({
        ...baseOptions(),
        idempotencyKey: 'qa-run-123',
        fetchImpl,
      }),
    ).resolves.toEqual({ transactionHash: '0xabc123' })

    expect(generateJwt).toHaveBeenCalledTimes(1)
    expect(generateJwt).toHaveBeenCalledWith({
      apiKeyId: API_KEY_ID,
      apiKeySecret: API_KEY_SECRET,
      requestMethod: 'POST',
      requestHost: 'api.cdp.coinbase.com',
      requestPath: '/platform/v2/evm/faucet',
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.cdp.coinbase.com/platform/v2/evm/faucet',
      expect.objectContaining({
        method: 'POST',
        headers: {
          Authorization: 'Bearer signed-jwt',
          'Content-Type': 'application/json',
          'X-Idempotency-Key': 'qa-run-123',
        },
        body: JSON.stringify({
          address: ADDRESS,
          network: 'base-sepolia',
          token: 'eth',
        }),
        signal: expect.any(AbortSignal),
      }),
    )
  })

  it.each([8453, 100])('refuses chain %s before authentication or network access', async (chainId) => {
    const fetchImpl = vi.fn()

    await expect(
      requestCdpEvmFaucet({ ...baseOptions(), chainId, fetchImpl }),
    ).rejects.toMatchObject({
      category: 'unsupported_network',
      status: undefined,
    })

    expect(generateJwt).not.toHaveBeenCalled()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('classifies 429 without reading or retaining the response body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(`secret=${API_KEY_SECRET}&url=https://internal.example`, { status: 429 }),
    )

    const error = await requestCdpEvmFaucet({ ...baseOptions(), fetchImpl }).catch(
      (caught: unknown) => caught,
    )

    expect(error).toBeInstanceOf(CdpFaucetError)
    expect(error).toMatchObject({
      category: 'rate_limited',
      status: 429,
      reason: 'CDP faucet rate limit was reached',
    })
    expect(JSON.stringify(error)).not.toContain(API_KEY_SECRET)
    expect(JSON.stringify(error)).not.toContain('internal.example')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('classifies other non-success responses without exposing their body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(`credential=${API_KEY_SECRET}`, { status: 503 }),
    )

    const error = await requestCdpEvmFaucet({ ...baseOptions(), fetchImpl }).catch(
      (caught: unknown) => caught,
    )

    expect(error).toMatchObject({
      category: 'http_error',
      status: 503,
      reason: 'CDP faucet returned an unsuccessful response',
    })
    expect(JSON.stringify(error)).not.toContain(API_KEY_SECRET)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('aborts a request at the configured timeout and does not retry', async () => {
    const fetchImpl = vi.fn((_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted request containing secret data', 'AbortError'))
        })
      }),
    )

    await expect(
      requestCdpEvmFaucet({ ...baseOptions(), timeoutMs: 5, fetchImpl }),
    ).rejects.toMatchObject({
      category: 'timeout',
      reason: 'CDP faucet request timed out',
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('classifies a transport failure without retaining the underlying error', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(
      new Error(`failed https://internal.example?secret=${API_KEY_SECRET}`),
    )

    const error = await requestCdpEvmFaucet({ ...baseOptions(), fetchImpl }).catch(
      (caught: unknown) => caught,
    )

    expect(error).toMatchObject({
      category: 'network_error',
      reason: 'CDP faucet request could not be completed',
    })
    expect(String(error)).not.toContain(API_KEY_SECRET)
    expect(String(error)).not.toContain('internal.example')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('refuses a successful response without a transaction hash', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: 'submitted' }), { status: 200 }),
    )

    await expect(
      requestCdpEvmFaucet({ ...baseOptions(), fetchImpl }),
    ).rejects.toMatchObject({
      category: 'invalid_response',
      reason: 'CDP faucet response did not include a transaction hash',
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('omits the idempotency header when no key is supplied', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ transactionHash: '0xdef456' }), { status: 200 }),
    )

    await requestCdpEvmFaucet({ ...baseOptions(), fetchImpl })

    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit
    expect(init.headers).toEqual({
      Authorization: 'Bearer signed-jwt',
      'Content-Type': 'application/json',
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('scrubs JWT-generation failures and never calls fetch', async () => {
    generateJwt.mockRejectedValueOnce(
      new Error(`bad credential ${API_KEY_SECRET} for https://internal.example`),
    )
    const fetchImpl = vi.fn()

    const error = await requestCdpEvmFaucet({ ...baseOptions(), fetchImpl }).catch(
      (caught: unknown) => caught,
    )

    expect(error).toMatchObject({
      category: 'authentication_failure',
      reason: 'CDP faucet authentication could not be prepared',
    })
    expect(String(error)).not.toContain(API_KEY_SECRET)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
