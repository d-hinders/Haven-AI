import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { expectMatchesSpec } from '../../openapi/response-shape.js'
import { FastifyInstance } from 'fastify'
import { buildApp } from '../../__tests__/helpers.js'
import { predictSafePasskeySignerAddress } from '../../modules/accounts/index.js'

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
        id: '8c1e4f70-2a63-4b95-8d07-1f4a6b3c9e28',
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
    expectMatchesSpec('POST', '/passkeys', response.json(), '201')
    expect(response.json()).toEqual({
      id: '8c1e4f70-2a63-4b95-8d07-1f4a6b3c9e28',
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

  it('POST /passkeys enrols a SECOND passkey on a chain that already has one (#1229)', async () => {
    // The backup signer. This 409'd before migration 056, which is why the
    // legacy passkey rail had no recovery at all: the only users who could
    // add a backup were the ones who did not need one.
    const token = signToken({ sub: 'user-1', email: 'test@example.com' })
    // Not positional: the route issues exactly one query here, and the insert's
    // real behaviour under the widened key space is proven against Postgres in
    // `infra/repositories/__tests__/user-passkeys.test.ts`.
    mockQuery.mockResolvedValue({
      rows: [
        {
          id: '9d2f5081-3b74-4ca6-9e18-2a5b7c4d0f39',
          credential_id: fixtureBody.credential_id,
          signer_address: '0x0802E96a6dd7e1DD80620CF5D759d41B714c0ce2',
          chain_id: fixtureBody.chain_id,
        },
      ],
    })

    const response = await app.inject({
      method: 'POST',
      url: '/passkeys',
      headers: { authorization: `Bearer ${token}` },
      payload: fixtureBody,
    })

    expect(response.statusCode).toBe(201)
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
          id: '8c1e4f70-2a63-4b95-8d07-1f4a6b3c9e28',
          credential_id: 'cred-1',
          signer_address: '0x1111111111111111111111111111111111111111',
          chain_id: 100,
          safe_address: null,
          created_at: '2026-05-04T10:00:00.000Z',
        },
        {
          id: '9d2f5081-3b74-4ca6-9e18-2a5b7c4d0f39',
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
          id: '8c1e4f70-2a63-4b95-8d07-1f4a6b3c9e28',
          credential_id: 'cred-1',
          signer_address: '0x1111111111111111111111111111111111111111',
          chain_id: 100,
          safe_address: null,
          created_at: '2026-05-04T10:00:00.000Z',
        },
        {
          id: '9d2f5081-3b74-4ca6-9e18-2a5b7c4d0f39',
          credential_id: 'cred-2',
          signer_address: '0x2222222222222222222222222222222222222222',
          chain_id: 8453,
          safe_address: '0x3333333333333333333333333333333333333333',
          created_at: '2026-05-04T10:05:00.000Z',
        },
      ],
    })
    expectMatchesSpec('GET', '/passkeys', response.json())
  })
})
