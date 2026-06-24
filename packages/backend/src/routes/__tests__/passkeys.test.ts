import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { FastifyInstance } from 'fastify'
import { buildApp } from '../../__tests__/helpers.js'
import { predictSafePasskeySignerAddress } from '../../lib/passkey-signer.js'

const { mockQuery } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
}))

vi.mock('../../db.js', () => ({
  default: {
    query: (...args: unknown[]) => mockQuery(...args),
  },
}))

describe('Passkey routes', () => {
  let app: FastifyInstance

  const fixtureBody = {
    credential_id: 'test_credential-id',
    public_key_x: '0x11223344556677889900aabbccddeeff00112233445566778899aabbccddeeff',
    public_key_y: '0xffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100',
    chain_id: 8453,
    raw_attestation_object: 'AQID',
  } as const

  beforeAll(async () => {
    app = await buildApp()
  })

  afterAll(async () => {
    await app.close()
  })

  beforeEach(() => {
    mockQuery.mockReset()
  })

  function signToken(payload: { sub: string; email: string }): string {
    return app.jwt.sign(payload, { expiresIn: '1h' })
  }

  it('POST /passkeys derives signer_address server-side and inserts the row', async () => {
    const token = signToken({ sub: 'user-1', email: 'test@example.com' })
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'passkey-1',
        credential_id: fixtureBody.credential_id,
        signer_address: predictSafePasskeySignerAddress({
          x: fixtureBody.public_key_x,
          y: fixtureBody.public_key_y,
          chainId: fixtureBody.chain_id,
        }).toLowerCase(),
        chain_id: fixtureBody.chain_id,
      }],
    })

    const response = await app.inject({
      method: 'POST',
      url: '/passkeys',
      headers: { authorization: `Bearer ${token}` },
      payload: fixtureBody,
    })

    expect(response.statusCode).toBe(201)
    expect(response.json()).toEqual({
      id: 'passkey-1',
      credential_id: fixtureBody.credential_id,
      signer_address: '0xe54122f41f7adf87fb6d5ab36bae42fc2aac882c',
      chain_id: 8453,
    })

    expect(mockQuery).toHaveBeenCalledTimes(1)
    expect(mockQuery.mock.calls[0][1]).toEqual([
      'user-1',
      fixtureBody.credential_id,
      Buffer.from(fixtureBody.public_key_x.slice(2), 'hex'),
      Buffer.from(fixtureBody.public_key_y.slice(2), 'hex'),
      '0xe54122f41f7adf87fb6d5ab36bae42fc2aac882c',
      8453,
      Buffer.from([1, 2, 3]),
    ])
  })

  it('POST /passkeys rejects unsupported chains', async () => {
    const token = signToken({ sub: 'user-1', email: 'test@example.com' })

    const response = await app.inject({
      method: 'POST',
      url: '/passkeys',
      headers: { authorization: `Bearer ${token}` },
      payload: { ...fixtureBody, chain_id: 1 },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json().error).toBe('Unsupported chain: 1')
  })

  it('POST /passkeys rejects malformed public_key_x', async () => {
    const token = signToken({ sub: 'user-1', email: 'test@example.com' })

    const response = await app.inject({
      method: 'POST',
      url: '/passkeys',
      headers: { authorization: `Bearer ${token}` },
      payload: { ...fixtureBody, public_key_x: '0x1234' },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json().error).toBe('public_key_x and public_key_y must be 32-byte 0x-prefixed hex values')
  })

  it('POST /passkeys returns 409 on user/chain conflicts', async () => {
    const token = signToken({ sub: 'user-1', email: 'test@example.com' })
    mockQuery.mockRejectedValueOnce({
      code: '23505',
      constraint: 'user_passkeys_user_id_chain_id_key',
    })

    const response = await app.inject({
      method: 'POST',
      url: '/passkeys',
      headers: { authorization: `Bearer ${token}` },
      payload: fixtureBody,
    })

    expect(response.statusCode).toBe(409)
    expect(response.json().error).toBe('A passkey is already registered for this chain')
  })

  it('POST /passkeys returns 409 on credential conflicts', async () => {
    const token = signToken({ sub: 'user-1', email: 'test@example.com' })
    mockQuery.mockRejectedValueOnce({
      code: '23505',
      constraint: 'user_passkeys_credential_id_key',
    })

    const response = await app.inject({
      method: 'POST',
      url: '/passkeys',
      headers: { authorization: `Bearer ${token}` },
      payload: fixtureBody,
    })

    expect(response.statusCode).toBe(409)
    expect(response.json().error).toBe('This credential is already registered')
  })

  it('POST /passkeys re-throws a non-unique DB error instead of mapping it to 409', async () => {
    const token = signToken({ sub: 'user-1', email: 'test@example.com' })
    // A different SQLSTATE (not-null violation) must not be swallowed as a 409.
    mockQuery.mockRejectedValueOnce({ code: '23502', constraint: 'whatever' })

    const response = await app.inject({
      method: 'POST',
      url: '/passkeys',
      headers: { authorization: `Bearer ${token}` },
      payload: fixtureBody,
    })

    expect(response.statusCode).toBe(500)
  })

  it('POST /passkeys re-throws a 23505 with an unrecognized constraint', async () => {
    const token = signToken({ sub: 'user-1', email: 'test@example.com' })
    // A unique violation on some other constraint is not one of the two known
    // passkey conflicts — surface it as 500, not a misleading 409.
    mockQuery.mockRejectedValueOnce({ code: '23505', constraint: 'some_other_unique_idx' })

    const response = await app.inject({
      method: 'POST',
      url: '/passkeys',
      headers: { authorization: `Bearer ${token}` },
      payload: fixtureBody,
    })

    expect(response.statusCode).toBe(500)
  })

  it('POST /passkeys re-throws a null throw without a secondary TypeError', async () => {
    const token = signToken({ sub: 'user-1', email: 'test@example.com' })
    // The old `error as {...}` cast crashed on property access for a null throw;
    // the narrowing helper short-circuits and re-throws, yielding a clean 500.
    mockQuery.mockRejectedValueOnce(null)

    const response = await app.inject({
      method: 'POST',
      url: '/passkeys',
      headers: { authorization: `Bearer ${token}` },
      payload: fixtureBody,
    })

    expect(response.statusCode).toBe(500)
  })

  it('POST /passkeys requires JWT auth', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/passkeys',
      payload: fixtureBody,
    })

    expect(response.statusCode).toBe(401)
    expect(response.json().error).toBe('Unauthorized')
  })

  it('GET /passkeys returns the authenticated user passkeys ordered by created_at', async () => {
    const token = signToken({ sub: 'user-1', email: 'test@example.com' })
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 'passkey-1',
          credential_id: 'cred-1',
          signer_address: '0x1111111111111111111111111111111111111111',
          chain_id: 100,
          safe_address: null,
          created_at: '2026-05-04T10:00:00.000Z',
        },
        {
          id: 'passkey-2',
          credential_id: 'cred-2',
          signer_address: '0x2222222222222222222222222222222222222222',
          chain_id: 8453,
          safe_address: '0x3333333333333333333333333333333333333333',
          created_at: '2026-05-04T10:05:00.000Z',
        },
      ],
    })

    const response = await app.inject({
      method: 'GET',
      url: '/passkeys',
      headers: { authorization: `Bearer ${token}` },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      passkeys: [
        {
          id: 'passkey-1',
          credential_id: 'cred-1',
          signer_address: '0x1111111111111111111111111111111111111111',
          chain_id: 100,
          safe_address: null,
          created_at: '2026-05-04T10:00:00.000Z',
        },
        {
          id: 'passkey-2',
          credential_id: 'cred-2',
          signer_address: '0x2222222222222222222222222222222222222222',
          chain_id: 8453,
          safe_address: '0x3333333333333333333333333333333333333333',
          created_at: '2026-05-04T10:05:00.000Z',
        },
      ],
    })
  })
})
