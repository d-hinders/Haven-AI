/**
 * Real-DB test for `GET /user/signers` (#3825).
 *
 * The route composes existing repository reads (`listAccountsForUser`,
 * `loadHybridOwnerConfig`, `listAccountPasskeys`) and folds them through the
 * pure `aggregateUserSigners`. Nothing here is mocked: the user scoping, the
 * delegation-rail filter and the passkey join are proven against Postgres.
 */
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import db from '../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../infra/__tests__/helpers/db-harness.js'
import { buildApp } from '../../__tests__/helpers.js'

let seq = 0
const addr = (n: number): string => `0x${n.toString(16).padStart(40, '0')}`

async function seedUser(): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`signers-${++seq}-${randomUUID()}@test.example`],
  )
  return r.rows[0].id
}

async function seedAccount(
  userId: string,
  opts: { chainId: number; name?: string | null; ownerAddress?: string | null; accountType?: string },
): Promise<{ id: string; address: string }> {
  const address = addr(++seq + 1000)
  const r = await db.query<{ id: string }>(
    `INSERT INTO smart_accounts (user_id, account_address, chain_id, name, owner_address, execution_rail, account_type)
     VALUES ($1, $2, $3, $4, $5, 'delegation', $6) RETURNING id`,
    [userId, address, opts.chainId, opts.name ?? 'Main', opts.ownerAddress ?? null, opts.accountType ?? 'delegator_hybrid'],
  )
  return { id: r.rows[0].id, address }
}

async function seedPasskey(accountId: string, keyId: string, createdAt: string | null): Promise<void> {
  await db.query(
    `INSERT INTO hybrid_account_passkeys (account_id, key_id, public_key_x, public_key_y, created_at)
     VALUES ($1, $2, '1', '2', COALESCE($3::timestamptz, now()))`,
    [accountId, keyId, createdAt],
  )
}

describeDb('GET /user/signers (real DB, #3825)', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    await initDbHarness()
    app = await buildApp()
  })
  afterAll(async () => {
    await app?.close()
  })
  beforeEach(async () => {
    await resetDb()
  })

  async function get(userId: string) {
    const token = app.jwt.sign({ sub: userId, email: 'u@example.com' }, { expiresIn: '1h' })
    return app.inject({ method: 'GET', url: '/user/signers', headers: { authorization: `Bearer ${token}` } })
  }

  it('lists a passkey that sits on two chains once, with both accounts, earliest date, and no coordinates', async () => {
    const user = await seedUser()
    const base = await seedAccount(user, { chainId: 8453, name: 'Main' })
    const sepolia = await seedAccount(user, { chainId: 84532, name: 'Savings' })
    await seedPasskey(base.id, '0xABCDEF', '2026-02-01T00:00:00.000Z')
    await seedPasskey(sepolia.id, '0xabcdef', '2026-01-01T00:00:00.000Z')

    const res = await get(user)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      signers: [
        {
          kind: 'passkey',
          key_id: '0xabcdef',
          created_at: '2026-01-01T00:00:00.000Z',
          accounts: [
            { account_id: sepolia.id, account_address: sepolia.address, account_name: 'Savings', chain_id: 84532 },
            { account_id: base.id, account_address: base.address, account_name: 'Main', chain_id: 8453 },
          ].sort((a, b) => a.chain_id - b.chain_id),
        },
      ],
    })
    expect(JSON.stringify(res.json())).not.toMatch(/"x"|"y"|public_key/)
  })

  it('returns an owner wallet on one account, lowercase, after the passkeys', async () => {
    const user = await seedUser()
    const owner = '0xAbCd000000000000000000000000000000000001'
    const a = await seedAccount(user, { chainId: 8453, ownerAddress: owner })
    await seedPasskey(a.id, '0x01', '2026-01-01T00:00:00.000Z')

    const body = (await get(user)).json()
    expect(body.signers.map((s: { kind: string }) => s.kind)).toEqual(['passkey', 'wallet'])
    expect(body.signers[1]).toEqual({
      kind: 'wallet',
      address: owner.toLowerCase(),
      accounts: [{ account_id: a.id, account_address: a.address, account_name: 'Main', chain_id: 8453 }],
    })
  })

  it("never returns another user's signers or a retired-rail account's", async () => {
    const me = await seedUser()
    const other = await seedUser()
    const mine = await seedAccount(me, { chainId: 8453 })
    await seedPasskey(mine.id, '0xaa', '2026-01-01T00:00:00.000Z')
    const theirs = await seedAccount(other, { chainId: 8453, ownerAddress: addr(77) })
    await seedPasskey(theirs.id, '0xbb', '2026-01-01T00:00:00.000Z')
    const retired = await seedAccount(me, { chainId: 84532, ownerAddress: addr(88), accountType: 'legacy_safe' })
    await seedPasskey(retired.id, '0xcc', '2026-01-01T00:00:00.000Z')

    const body = (await get(me)).json()
    expect(body.signers.map((s: { key_id?: string }) => s.key_id)).toEqual(['0xaa'])
  })

  it('orders passkeys by enrollment date with the unknown last, deterministically', async () => {
    const user = await seedUser()
    const a = await seedAccount(user, { chainId: 8453 })
    await seedPasskey(a.id, '0xc2', '2026-03-01T00:00:00.000Z')
    await seedPasskey(a.id, '0xc1', '2026-01-01T00:00:00.000Z')
    await seedPasskey(a.id, '0xc3', '2026-03-01T00:00:00.000Z')
    // created_at is NOT NULL in the schema, so the "no date known" fallback is
    // pinned in the pure aggregator's unit test; here a malformed value cannot exist.
    const body = (await get(user)).json()
    expect(body.signers.map((s: { key_id: string }) => s.key_id)).toEqual(['0xc1', '0xc2', '0xc3'])
  })

  it('skips an account whose signer configuration cannot be resolved instead of failing the read', async () => {
    const user = await seedUser()
    await seedAccount(user, { chainId: 84532 }) // no owner_address, no passkeys -> unresolvable
    const ok = await seedAccount(user, { chainId: 8453 })
    await seedPasskey(ok.id, '0xaa', '2026-01-01T00:00:00.000Z')

    const res = await get(user)
    expect(res.statusCode).toBe(200)
    const [only] = res.json().signers
    expect(only.key_id).toBe('0xaa')
    expect(only.accounts).toHaveLength(1)
  })

  it('answers an empty list for a user with no accounts, and 401 without a token', async () => {
    const user = await seedUser()
    expect((await get(user)).json()).toEqual({ signers: [] })
    const anon = await app.inject({ method: 'GET', url: '/user/signers' })
    expect(anon.statusCode).toBe(401)
  })
})
