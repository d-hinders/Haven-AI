import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { FastifyInstance } from 'fastify'

const {
  mockQuery,
  mockGetRelayer,
  mockWarnIfRelayerLow,
  mockExecTransaction,
  mockExecTransactionStaticCall,
  mockContractConstructor,
} = vi.hoisted(() => {
  const execTransaction = vi.fn()
  const execTransactionStaticCall = vi.fn()
  Object.assign(execTransaction, {
    staticCall: execTransactionStaticCall,
  })
  return {
    mockQuery: vi.fn(),
    mockGetRelayer: vi.fn(),
    mockWarnIfRelayerLow: vi.fn(),
    mockExecTransaction: execTransaction,
    mockExecTransactionStaticCall: execTransactionStaticCall,
    mockContractConstructor: vi.fn(function contractMock() {
      return {
        execTransaction,
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

import { buildApp } from '../../__tests__/helpers.js'

describe('Safe exec routes', () => {
  let app: FastifyInstance

  const validBody = {
    chain_id: 100,
    safe_address: '0x07058311f995c89F4DbE17Db61fa1A3CDe638975',
    to: '0x1111111111111111111111111111111111111111',
    value: '0',
    data: '0x',
    operation: 0 as const,
    safe_tx_gas: '0',
    base_gas: '0',
    gas_price: '0',
    gas_token: '0x0000000000000000000000000000000000000000',
    refund_receiver: '0x0000000000000000000000000000000000000000',
    nonce: '1',
    signatures: '0x1234',
  }

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
    mockExecTransaction.mockReset()
    mockExecTransactionStaticCall.mockReset()
    mockContractConstructor.mockClear()

    mockGetRelayer.mockReturnValue({ address: '0xrelayer' })
    mockWarnIfRelayerLow.mockResolvedValue(undefined)
    mockExecTransactionStaticCall.mockResolvedValue(true)
  })

  function signToken(payload: { sub: string; email: string }): string {
    return app.jwt.sign(payload, { expiresIn: '1h' })
  }

  it('POST /safe/exec relays Safe execution', async () => {
    const token = signToken({ sub: 'user-1', email: 'test@example.com' })
    mockQuery.mockResolvedValueOnce({
      rows: [{
        public_key_x: Buffer.from('11223344556677889900aabbccddeeff00112233445566778899aabbccddeeff', 'hex'),
        public_key_y: Buffer.from('ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100', 'hex'),
        signer_address: '0x0802e96a6dd7e1dd80620cf5d759d41b714c0ce2',
      }],
    })
    mockExecTransaction.mockResolvedValueOnce({
      hash: '0xtxhash',
      wait: vi.fn().mockResolvedValue({}),
    })

    const response = await app.inject({
      method: 'POST',
      url: '/safe/exec',
      headers: { authorization: `Bearer ${token}` },
      payload: validBody,
    })

    expect(response.statusCode).toBe(201)
    expect(response.json()).toEqual({
      tx_hash: '0xtxhash',
      chain_id: 100,
    })
    expect(mockWarnIfRelayerLow).toHaveBeenCalledWith(100)
    expect(mockGetRelayer).toHaveBeenCalledWith(100)
    expect(mockExecTransactionStaticCall).toHaveBeenCalledWith(
      validBody.to,
      0n,
      '0x',
      0,
      0n,
      0n,
      0n,
      validBody.gas_token,
      validBody.refund_receiver,
      validBody.signatures,
    )
    expect(mockExecTransaction).toHaveBeenCalledWith(
      validBody.to,
      0n,
      '0x',
      0,
      0n,
      0n,
      0n,
      validBody.gas_token,
      validBody.refund_receiver,
      validBody.signatures,
      { gasLimit: 1_500_000n },
    )
  })

  it('POST /safe/exec returns 403 for an unrelated Safe', async () => {
    const token = signToken({ sub: 'user-1', email: 'test@example.com' })
    mockQuery.mockResolvedValueOnce({ rows: [] })

    const response = await app.inject({
      method: 'POST',
      url: '/safe/exec',
      headers: { authorization: `Bearer ${token}` },
      payload: validBody,
    })

    expect(response.statusCode).toBe(403)
    expect(response.json().error).toBe('Safe is not associated with the authenticated user')
  })

  it('POST /safe/exec returns 503 when the relayer is unfunded', async () => {
    const token = signToken({ sub: 'user-1', email: 'test@example.com' })
    mockQuery.mockResolvedValueOnce({
      rows: [{
        public_key_x: Buffer.from('11223344556677889900aabbccddeeff00112233445566778899aabbccddeeff', 'hex'),
        public_key_y: Buffer.from('ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100', 'hex'),
        signer_address: '0x0802e96a6dd7e1dd80620cf5d759d41b714c0ce2',
      }],
    })
    mockExecTransaction.mockRejectedValueOnce(new Error('insufficient funds for intrinsic transaction cost'))

    const response = await app.inject({
      method: 'POST',
      url: '/safe/exec',
      headers: { authorization: `Bearer ${token}` },
      payload: validBody,
    })

    expect(response.statusCode).toBe(503)
    expect(response.json().error).toBe('Relayer is temporarily unfunded; please try again later')
  })

  it('POST /safe/exec returns 502 on generic revert without leaking the revert code', async () => {
    const token = signToken({ sub: 'user-1', email: 'test@example.com' })
    mockQuery.mockResolvedValueOnce({
      rows: [{
        public_key_x: Buffer.from('11223344556677889900aabbccddeeff00112233445566778899aabbccddeeff', 'hex'),
        public_key_y: Buffer.from('ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100', 'hex'),
        signer_address: '0x0802e96a6dd7e1dd80620cf5d759d41b714c0ce2',
      }],
    })
    mockExecTransactionStaticCall.mockRejectedValueOnce(new Error('execution reverted: GS013'))

    const response = await app.inject({
      method: 'POST',
      url: '/safe/exec',
      headers: { authorization: `Bearer ${token}` },
      payload: validBody,
    })

    expect(response.statusCode).toBe(502)
    expect(response.json().error).toBe('Safe execution reverted on-chain')
    expect(JSON.stringify(response.json())).not.toContain('GS013')
  })

  it('POST /safe/exec requires auth', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/safe/exec',
      payload: validBody,
    })

    expect(response.statusCode).toBe(401)
    expect(response.json().error).toBe('Unauthorized')
  })
})
