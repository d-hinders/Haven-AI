import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { FastifyInstance } from 'fastify'

const {
  mockQuery,
  mockGetRelayer,
  mockWarnIfRelayerLow,
  mockCreateProxyWithNonce,
  mockContractConstructor,
} = vi.hoisted(() => {
  const createProxyWithNonce = vi.fn()
  return {
    mockQuery: vi.fn(),
    mockGetRelayer: vi.fn(),
    mockWarnIfRelayerLow: vi.fn(),
    mockCreateProxyWithNonce: createProxyWithNonce,
    mockContractConstructor: vi.fn(function contractMock() {
      return {
        createProxyWithNonce,
      }
    }),
  }
})

vi.mock('../../db.js', () => ({
  default: {
    query: (...args: unknown[]) => mockQuery(...args),
  },
}))

vi.mock('../../lib/relayer.js', () => ({
  getRelayer: (...args: unknown[]) => mockGetRelayer(...args),
  warnIfRelayerLow: (...args: unknown[]) => mockWarnIfRelayerLow(...args),
}))

vi.mock('ethers', async () => {
  const actual = await vi.importActual<typeof import('ethers')>('ethers')
  return {
    ...actual,
    Contract: mockContractConstructor,
  }
})

import { Interface } from 'ethers'
import { buildApp } from '../../__tests__/helpers.js'

const PROXY_FACTORY_EVENT_ABI = ['event ProxyCreation(address proxy, address singleton)']
const PROXY_FACTORY_IFACE = new Interface(PROXY_FACTORY_EVENT_ABI)

describe('Safe deploy routes', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = await buildApp()
  })

  afterAll(async () => {
    await app.close()
  })

  beforeEach(() => {
    mockQuery.mockReset()
    mockGetRelayer.mockReset()
    mockWarnIfRelayerLow.mockReset()
    mockCreateProxyWithNonce.mockReset()
    mockContractConstructor.mockClear()

    mockGetRelayer.mockReturnValue({ address: '0xrelayer' })
    mockWarnIfRelayerLow.mockResolvedValue(undefined)
  })

  function signToken(payload: { sub: string; email: string }): string {
    return app.jwt.sign(payload, { expiresIn: '1h' })
  }

  function makeProxyCreationLog(proxy: string, singleton: string) {
    const encoded = PROXY_FACTORY_IFACE.encodeEventLog(
      'ProxyCreation',
      [proxy, singleton],
    )

    return {
      address: '0xC22834581EbC8527d974F8a1c97E1bEA4EF910BC',
      topics: encoded.topics,
      data: encoded.data,
    }
  }

  it('POST /safe/deploy relays Safe creation and stores the deployed address', async () => {
    const token = signToken({ sub: 'user-1', email: 'test@example.com' })
    mockQuery
      .mockResolvedValueOnce({
        rows: [{
          id: 'passkey-1',
          public_key_x: Buffer.from('11223344556677889900aabbccddeeff00112233445566778899aabbccddeeff', 'hex'),
          public_key_y: Buffer.from('ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100', 'hex'),
          signer_address: '0xe54122f41f7adf87fb6d5ab36bae42fc2aac882c',
          safe_address: null,
        }],
      })
      .mockResolvedValueOnce({ rows: [] })

    mockCreateProxyWithNonce.mockResolvedValueOnce({
      hash: '0xtxhash',
      wait: vi.fn().mockResolvedValue({
        logs: [
          makeProxyCreationLog(
            '0x1111111111111111111111111111111111111111',
            '0xfb1bffC9d739B8D520DaF37dF666da4C687191EA',
          ),
        ],
      }),
    })

    const response = await app.inject({
      method: 'POST',
      url: '/safe/deploy',
      headers: { authorization: `Bearer ${token}` },
      payload: { chain_id: 8453, salt_nonce: '42' },
    })

    expect(response.statusCode).toBe(201)
    expect(response.json()).toEqual({
      safe_address: '0x1111111111111111111111111111111111111111',
      tx_hash: '0xtxhash',
      chain_id: 8453,
    })

    expect(mockWarnIfRelayerLow).toHaveBeenCalledWith(8453)
    expect(mockGetRelayer).toHaveBeenCalledWith(8453)
    expect(mockContractConstructor).toHaveBeenCalledWith(
      '0xC22834581EbC8527d974F8a1c97E1bEA4EF910BC',
      expect.any(Array),
      { address: '0xrelayer' },
    )
    expect(mockCreateProxyWithNonce).toHaveBeenCalledWith(
      '0xfb1bffC9d739B8D520DaF37dF666da4C687191EA',
      expect.any(String),
      42n,
    )
    expect(mockQuery).toHaveBeenLastCalledWith(
      expect.stringContaining('UPDATE user_passkeys'),
      ['0x1111111111111111111111111111111111111111', 'passkey-1'],
    )
  })

  it('POST /safe/deploy returns 404 when the user has no passkey for the chain', async () => {
    const token = signToken({ sub: 'user-1', email: 'test@example.com' })
    mockQuery.mockResolvedValueOnce({ rows: [] })

    const response = await app.inject({
      method: 'POST',
      url: '/safe/deploy',
      headers: { authorization: `Bearer ${token}` },
      payload: { chain_id: 8453 },
    })

    expect(response.statusCode).toBe(404)
    expect(response.json().error).toBe('No passkey enrolled for this chain')
  })

  it('POST /safe/deploy returns 409 when a Safe is already deployed', async () => {
    const token = signToken({ sub: 'user-1', email: 'test@example.com' })
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'passkey-1',
        public_key_x: Buffer.alloc(32),
        public_key_y: Buffer.alloc(32),
        signer_address: '0x0000000000000000000000000000000000000000',
        safe_address: '0x1111111111111111111111111111111111111111',
      }],
    })

    const response = await app.inject({
      method: 'POST',
      url: '/safe/deploy',
      headers: { authorization: `Bearer ${token}` },
      payload: { chain_id: 8453 },
    })

    expect(response.statusCode).toBe(409)
    expect(response.json().error).toBe('A Safe is already deployed for this passkey')
  })

  it('POST /safe/deploy returns 503 when the relayer is unfunded', async () => {
    const token = signToken({ sub: 'user-1', email: 'test@example.com' })
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'passkey-1',
        public_key_x: Buffer.from('11223344556677889900aabbccddeeff00112233445566778899aabbccddeeff', 'hex'),
        public_key_y: Buffer.from('ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100', 'hex'),
        signer_address: '0xe54122f41f7adf87fb6d5ab36bae42fc2aac882c',
        safe_address: null,
      }],
    })
    mockCreateProxyWithNonce.mockRejectedValueOnce(new Error('insufficient funds for intrinsic transaction cost'))

    const response = await app.inject({
      method: 'POST',
      url: '/safe/deploy',
      headers: { authorization: `Bearer ${token}` },
      payload: { chain_id: 8453 },
    })

    expect(response.statusCode).toBe(503)
    expect(response.json().error).toBe('Relayer is temporarily unfunded; please try again later')
  })

  it('POST /safe/deploy returns 500 when the stored signer address does not match the key material', async () => {
    const token = signToken({ sub: 'user-1', email: 'test@example.com' })
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'passkey-1',
        public_key_x: Buffer.from('11223344556677889900aabbccddeeff00112233445566778899aabbccddeeff', 'hex'),
        public_key_y: Buffer.from('ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100', 'hex'),
        signer_address: '0x0000000000000000000000000000000000000000',
        safe_address: null,
      }],
    })

    const response = await app.inject({
      method: 'POST',
      url: '/safe/deploy',
      headers: { authorization: `Bearer ${token}` },
      payload: { chain_id: 8453 },
    })

    expect(response.statusCode).toBe(500)
  })
})
