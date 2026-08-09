import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { FastifyInstance } from 'fastify'

const {
  mockQuery,
  mockGetRelayer,
  mockWarnIfRelayerLow,
  mockExecTransaction,
  mockExecTransactionStaticCall,
  mockExecTransactionEstimateGas,
  mockSafeNonce,
  mockSafeEncodeTransactionData,
  mockSafeCheckSignatures,
  mockCreateSigner,
  mockContractConstructor,
  mockGetSafeDetails,
} = vi.hoisted(() => {
  const execTransaction = vi.fn()
  const execTransactionStaticCall = vi.fn()
  const execTransactionEstimateGas = vi.fn()
  const safeNonce = vi.fn()
  const safeEncodeTransactionData = vi.fn()
  const safeCheckSignatures = vi.fn()
  const createSigner = vi.fn()
  Object.assign(execTransaction, {
    staticCall: execTransactionStaticCall,
    estimateGas: execTransactionEstimateGas,
  })
  return {
    mockQuery: vi.fn(),
    mockGetRelayer: vi.fn(),
    mockWarnIfRelayerLow: vi.fn(),
    mockExecTransaction: execTransaction,
    mockExecTransactionStaticCall: execTransactionStaticCall,
    mockExecTransactionEstimateGas: execTransactionEstimateGas,
    mockSafeNonce: safeNonce,
    mockSafeEncodeTransactionData: safeEncodeTransactionData,
    mockSafeCheckSignatures: safeCheckSignatures,
    mockCreateSigner: createSigner,
    mockGetSafeDetails: vi.fn(),
    mockContractConstructor: vi.fn((address: string, abi: unknown) => {
      if (Array.isArray(abi) && abi.some((item) => String(item).includes('createSigner(uint256 x, uint256 y, uint176 verifiers)'))) {
        return {
          createSigner,
        }
      }

      return {
        nonce: safeNonce,
        encodeTransactionData: safeEncodeTransactionData,
        checkSignatures: safeCheckSignatures,
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

vi.mock('../../infra/relayer.js', () => ({
  getRelayer: (...args: unknown[]) => mockGetRelayer(...args),
  warnIfRelayerLow: (...args: unknown[]) => mockWarnIfRelayerLow(...args),
  // Pass-through: the per-chain send serialisation is covered by
  // lib/relayer.test.ts; route tests only care that the submit runs.
  withRelayerSendLock: (_chainId: number, fn: () => Promise<unknown>) => fn(),
}))

// Only the owner read is faked — `predictSafePasskeySignerAddress` stays real,
// because the route's signer-mismatch guard is meaningless against a stub.
vi.mock('../../modules/accounts/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../modules/accounts/index.js')>(
    '../../modules/accounts/index.js',
  )
  return {
    ...actual,
    getSafeDetails: (...args: unknown[]) => mockGetSafeDetails(...args),
  }
})

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
  const signerAddress = '0x0802e96a6dd7e1dd80620cf5d759d41b714c0ce2'

  function buildPasskeyContractSignature(ownerAddress: string, innerSignature: string): string {
    const ownerWord = ownerAddress.toLowerCase().slice(2).padStart(64, '0')
    const offsetWord = '41'.padStart(64, '0')
    const typeByte = '00'
    const innerHex = innerSignature.startsWith('0x') ? innerSignature.slice(2) : innerSignature
    const lengthWord = (innerHex.length / 2).toString(16).padStart(64, '0')
    return `0x${ownerWord}${offsetWord}${typeByte}${lengthWord}${innerHex}`
  }

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
    signatures: buildPasskeyContractSignature(signerAddress, '0x1234'),
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
    mockExecTransactionEstimateGas.mockReset()
    mockSafeNonce.mockReset()
    mockSafeEncodeTransactionData.mockReset()
    mockSafeCheckSignatures.mockReset()
    mockCreateSigner.mockReset()
    mockContractConstructor.mockClear()
    mockGetSafeDetails.mockReset()

    mockGetRelayer.mockReturnValue({
      address: '0xrelayer',
      provider: {
        getCode: vi.fn().mockResolvedValue('0x1234'),
      },
    })
    mockWarnIfRelayerLow.mockResolvedValue(undefined)
    mockSafeNonce.mockResolvedValue(1n)
    mockSafeEncodeTransactionData.mockResolvedValue('0xdeadbeef')
    mockSafeCheckSignatures.mockResolvedValue(undefined)
    mockExecTransactionStaticCall.mockResolvedValue(true)
    mockExecTransactionEstimateGas.mockResolvedValue(1_900_000n)
    mockCreateSigner.mockResolvedValue({
      hash: '0xsignertx',
      wait: vi.fn().mockResolvedValue({}),
    })
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
        signer_address: signerAddress,
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
    expect(mockCreateSigner).not.toHaveBeenCalled()
    expect(mockSafeCheckSignatures).toHaveBeenCalledWith(
      expect.any(String),
      '0xdeadbeef',
      validBody.signatures,
    )
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
      { gasLimit: 2_050_000n },
    )
  })

  it('POST /safe/exec returns 403 for an unrelated Safe', async () => {
    const token = signToken({ sub: 'user-1', email: 'test@example.com' })
    // No Safe binding, and no passkey on the chain either (#1229 looks at the
    // whole set before refusing).
    mockQuery.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] })

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
        signer_address: signerAddress,
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
        signer_address: signerAddress,
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

  it('POST /safe/exec returns 409 when the Safe nonce is stale', async () => {
    const token = signToken({ sub: 'user-1', email: 'test@example.com' })
    mockQuery.mockResolvedValueOnce({
      rows: [{
        public_key_x: Buffer.from('11223344556677889900aabbccddeeff00112233445566778899aabbccddeeff', 'hex'),
        public_key_y: Buffer.from('ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100', 'hex'),
        signer_address: signerAddress,
      }],
    })
    mockSafeNonce.mockResolvedValueOnce(2n)

    const response = await app.inject({
      method: 'POST',
      url: '/safe/exec',
      headers: { authorization: `Bearer ${token}` },
      payload: validBody,
    })

    expect(response.statusCode).toBe(409)
    expect(response.json().error).toBe('Safe nonce changed; refresh and try again')
    expect(mockExecTransactionStaticCall).not.toHaveBeenCalled()
  })

  it('POST /safe/exec returns a specific error when Safe rejects the full signature payload', async () => {
    const token = signToken({ sub: 'user-1', email: 'test@example.com' })
    mockQuery.mockResolvedValueOnce({
      rows: [{
        public_key_x: Buffer.from('11223344556677889900aabbccddeeff00112233445566778899aabbccddeeff', 'hex'),
        public_key_y: Buffer.from('ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100', 'hex'),
        signer_address: signerAddress,
      }],
    })
    mockSafeCheckSignatures.mockRejectedValueOnce(new Error('execution reverted: GS024'))

    const response = await app.inject({
      method: 'POST',
      url: '/safe/exec',
      headers: { authorization: `Bearer ${token}` },
      payload: validBody,
    })

    expect(response.statusCode).toBe(502)
    expect(response.json().error).toBe('Safe rejected the signed transaction payload')
    expect(mockExecTransactionStaticCall).not.toHaveBeenCalled()
  })

  it('POST /safe/exec falls back to a conservative gas limit when estimation fails', async () => {
    const token = signToken({ sub: 'user-1', email: 'test@example.com' })
    mockQuery.mockResolvedValueOnce({
      rows: [{
        public_key_x: Buffer.from('11223344556677889900aabbccddeeff00112233445566778899aabbccddeeff', 'hex'),
        public_key_y: Buffer.from('ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100', 'hex'),
        signer_address: signerAddress,
      }],
    })
    mockExecTransactionEstimateGas.mockRejectedValueOnce(new Error('estimate failed'))
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
      { gasLimit: 5_000_000n },
    )
  })

  it('POST /safe/exec auto-deploys the passkey signer if the deterministic signer address has no code', async () => {
    const token = signToken({ sub: 'user-1', email: 'test@example.com' })
    mockQuery.mockResolvedValueOnce({
      rows: [{
        public_key_x: Buffer.from('11223344556677889900aabbccddeeff00112233445566778899aabbccddeeff', 'hex'),
        public_key_y: Buffer.from('ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100', 'hex'),
        signer_address: signerAddress,
      }],
    })
    mockGetRelayer.mockReturnValue({
      address: '0xrelayer',
      provider: {
        getCode: vi.fn().mockResolvedValueOnce('0x'),
      },
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
    expect(mockCreateSigner).toHaveBeenCalledWith(
      BigInt('0x11223344556677889900aabbccddeeff00112233445566778899aabbccddeeff'),
      BigInt('0xffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100'),
      BigInt('0x445a0683e494ea0c5af3e83c5159fbe47cf9e765'),
    )
  })

  // ── Multi-passkey resolution (#1229) ──────────────────────────────────

  const passkeyKeys = {
    public_key_x: Buffer.from(
      '11223344556677889900aabbccddeeff00112233445566778899aabbccddeeff',
      'hex',
    ),
    public_key_y: Buffer.from(
      'ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100',
      'hex',
    ),
    signer_address: signerAddress,
  }

  it('POST /safe/exec resolves the named credential without an owner read', async () => {
    const token = signToken({ sub: 'user-1', email: 'test@example.com' })
    // The row is already bound to this Safe — the onboarding passkey. No RPC.
    mockQuery.mockResolvedValueOnce({
      rows: [{ ...passkeyKeys, credential_id: 'cred-primary', safe_address: validBody.safe_address }],
    })
    mockExecTransaction.mockResolvedValueOnce({
      hash: '0xtxhash',
      wait: vi.fn().mockResolvedValue({}),
    })

    const response = await app.inject({
      method: 'POST',
      url: '/safe/exec',
      headers: { authorization: `Bearer ${token}` },
      payload: { ...validBody, credential_id: 'cred-primary' },
    })

    expect(response.statusCode).toBe(201)
    expect(mockGetSafeDetails).not.toHaveBeenCalled()
    expect(mockQuery.mock.calls[0][1]).toEqual(['user-1', 100, 'cred-primary'])
  })

  it('POST /safe/exec authorises an unbound backup passkey that owns the Safe', async () => {
    const token = signToken({ sub: 'user-1', email: 'test@example.com' })
    // A backup enrolled later carries no Safe binding. On-chain ownership is
    // the authoritative answer, and the row is claimed on the way through so
    // the next exec skips the read.
    mockQuery.mockResolvedValueOnce({
      rows: [{ ...passkeyKeys, credential_id: 'cred-backup', safe_address: null }],
    })
    mockGetSafeDetails.mockResolvedValueOnce({
      owners: ['0xSomeoneElse', signerAddress],
      threshold: 1,
      nonce: 1,
    })
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] })
    mockExecTransaction.mockResolvedValueOnce({
      hash: '0xtxhash',
      wait: vi.fn().mockResolvedValue({}),
    })

    const response = await app.inject({
      method: 'POST',
      url: '/safe/exec',
      headers: { authorization: `Bearer ${token}` },
      payload: { ...validBody, credential_id: 'cred-backup' },
    })

    expect(response.statusCode).toBe(201)
    expect(mockGetSafeDetails).toHaveBeenCalledWith(validBody.safe_address, 100)
    expect(mockQuery.mock.calls[1][1]).toEqual([
      'user-1',
      'cred-backup',
      validBody.safe_address,
    ])
  })

  it('POST /safe/exec returns 403 when the passkey does not own the Safe', async () => {
    const token = signToken({ sub: 'user-1', email: 'test@example.com' })
    mockQuery.mockResolvedValueOnce({
      rows: [{ ...passkeyKeys, credential_id: 'cred-backup', safe_address: null }],
    })
    mockGetSafeDetails.mockResolvedValueOnce({
      owners: ['0xSomeoneElse'],
      threshold: 1,
      nonce: 1,
    })

    const response = await app.inject({
      method: 'POST',
      url: '/safe/exec',
      headers: { authorization: `Bearer ${token}` },
      payload: { ...validBody, credential_id: 'cred-backup' },
    })

    expect(response.statusCode).toBe(403)
    expect(mockExecTransaction).not.toHaveBeenCalled()
  })

  it('POST /safe/exec refuses to guess when the chain holds several passkeys', async () => {
    const token = signToken({ sub: 'user-1', email: 'test@example.com' })
    // Nothing bound to this Safe, two candidates: relaying for the wrong one
    // would fail on-chain with a signature error that reads like a broken
    // passkey, so ask instead.
    mockQuery.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({
      rows: [
        { ...passkeyKeys, credential_id: 'cred-primary', safe_address: null },
        { ...passkeyKeys, credential_id: 'cred-backup', safe_address: null },
      ],
    })

    const response = await app.inject({
      method: 'POST',
      url: '/safe/exec',
      headers: { authorization: `Bearer ${token}` },
      payload: validBody,
    })

    expect(response.statusCode).toBe(400)
    expect(response.json().error).toContain('credential_id is required')
    expect(mockExecTransaction).not.toHaveBeenCalled()
  })

  it('POST /safe/exec rejects a malformed credential_id', async () => {
    const token = signToken({ sub: 'user-1', email: 'test@example.com' })

    const response = await app.inject({
      method: 'POST',
      url: '/safe/exec',
      headers: { authorization: `Bearer ${token}` },
      payload: { ...validBody, credential_id: 'not base64url!' },
    })

    expect(response.statusCode).toBe(400)
    expect(mockQuery).not.toHaveBeenCalled()
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
