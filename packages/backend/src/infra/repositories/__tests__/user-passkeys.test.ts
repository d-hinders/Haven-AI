/**
 * Real-DB tests for the user-passkeys repository (#1229, epic #1219).
 *
 * These belong on the real harness rather than behind `vi.mock('db.js')`
 * because every claim here is a claim about POSTGRES: which unique constraint
 * still bites, what a partial-predicate UPDATE refuses to touch, and whether
 * an address comparison is case-blind. A positional mock chain would assert
 * only that the code called `query` in the order the test already assumed.
 *
 * The load-bearing one is the first: migration 056 removed
 * `UNIQUE (user_id, chain_id)` so a user can enrol a BACKUP passkey, which is
 * the only recovery a single-owner passkey Safe can have. If that constraint
 * ever comes back, the legacy rail silently loses its recovery story again —
 * and the failure surfaces as a 409 during approver management, a long way
 * from the schema that caused it.
 *
 * Row builders are local per #1220's domain-free-harness rule.
 */
import { beforeAll, beforeEach, expect, it } from 'vitest'
import db from '../../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../__tests__/helpers/db-harness.js'
import {
  bindPasskeyToSafe,
  findPasskeyForSafe,
  findUserPasskeyByCredential,
  insertUserPasskey,
  listPasskeySignersForChain,
  listUserPasskeys,
} from '../user-passkeys.js'

const BASE = 8453
const GNOSIS = 100
const SAFE_A = '0x07058311f995c89F4DbE17Db61fa1A3CDe638975'
const SAFE_B = '0x1111111111111111111111111111111111111111'

let counter = 0

async function seedUser(): Promise<string> {
  const result = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`u${++counter}-${Date.now()}@test.example`],
  )
  return result.rows[0].id
}

async function seedPasskey(seed: {
  userId: string
  credentialId?: string
  signerAddress?: string
  chainId?: number
}): Promise<{ credentialId: string; signerAddress: string }> {
  const n = ++counter
  const credentialId = seed.credentialId ?? `credential-${n}`
  const signerAddress = seed.signerAddress ?? `0x${String(n).padStart(40, 'a')}`
  await insertUserPasskey({
    userId: seed.userId,
    credentialId,
    publicKeyX: Buffer.alloc(32, n % 251),
    publicKeyY: Buffer.alloc(32, (n + 1) % 251),
    signerAddress,
    chainId: seed.chainId ?? BASE,
    rawAttestation: null,
  })
  return { credentialId, signerAddress }
}

/** The Safe binding is set by the deploy path, not at enrolment. */
async function bindDirect(credentialId: string, safeAddress: string): Promise<void> {
  await db.query('UPDATE user_passkeys SET safe_address = $2 WHERE credential_id = $1', [
    credentialId,
    safeAddress,
  ])
}

describeDb('user-passkeys repository (#1229)', () => {
  beforeAll(async () => {
    await initDbHarness()
  })

  beforeEach(async () => {
    await resetDb()
  })

  it('accepts a SECOND passkey on the same chain — the backup signer', async () => {
    // Migration 056's whole point, asserted against the live constraint set
    // rather than against a mock that cannot have one.
    const user = await seedUser()
    await seedPasskey({ userId: user })
    await seedPasskey({ userId: user })

    const rows = await listPasskeySignersForChain(user, BASE)
    expect(rows).toHaveLength(2)
  })

  it('still refuses to register one credential twice', async () => {
    // `UNIQUE (credential_id)` stays: an assertion must resolve to exactly one
    // row, or the exec path cannot tell which signer produced it.
    const user = await seedUser()
    const { credentialId } = await seedPasskey({ userId: user })

    await expect(seedPasskey({ userId: user, credentialId })).rejects.toMatchObject({
      code: '23505',
    })
  })

  it('scopes a credential lookup to the owning user and chain', async () => {
    // The credential id arrives from the client, so tenant scope is the only
    // thing stopping it naming someone else's row.
    const mine = await seedUser()
    const theirs = await seedUser()
    const { credentialId } = await seedPasskey({ userId: theirs })

    expect(await findUserPasskeyByCredential(mine, BASE, credentialId)).toBeNull()
    expect(await findUserPasskeyByCredential(theirs, GNOSIS, credentialId)).toBeNull()
    expect(await findUserPasskeyByCredential(theirs, BASE, credentialId)).toMatchObject({
      credential_id: credentialId,
    })
  })

  it('lists a chain oldest-first and leaves other chains out', async () => {
    const user = await seedUser()
    const first = await seedPasskey({ userId: user })
    const second = await seedPasskey({ userId: user })
    await seedPasskey({ userId: user, chainId: GNOSIS })

    const rows = await listPasskeySignersForChain(user, BASE)
    expect(rows.map((r) => r.credential_id)).toEqual([first.credentialId, second.credentialId])
  })

  it('binds an unbound passkey and REFUSES to move one already bound', async () => {
    // `safe_address` is a fast-path hint, and a passkey can own several Safes.
    // Overwriting would move the hint off the Safe it was first bound to and
    // slow that one down for nothing — so the predicate is `IS NULL`.
    const user = await seedUser()
    const { credentialId } = await seedPasskey({ userId: user })

    expect(await bindPasskeyToSafe(user, credentialId, SAFE_A)).toBe(true)
    expect(await bindPasskeyToSafe(user, credentialId, SAFE_B)).toBe(false)

    const row = await findUserPasskeyByCredential(user, BASE, credentialId)
    expect(row?.safe_address).toBe(SAFE_A)
  })

  it('never binds another user\'s passkey', async () => {
    const mine = await seedUser()
    const theirs = await seedUser()
    const { credentialId } = await seedPasskey({ userId: theirs })

    expect(await bindPasskeyToSafe(mine, credentialId, SAFE_A)).toBe(false)
    expect((await findUserPasskeyByCredential(theirs, BASE, credentialId))?.safe_address).toBeNull()
  })

  it('finds a Safe-bound passkey case-blind, and only for its own Safe', async () => {
    const user = await seedUser()
    const { credentialId } = await seedPasskey({ userId: user })
    await bindDirect(credentialId, SAFE_A.toLowerCase())

    expect(await findPasskeyForSafe(user, SAFE_A, BASE)).toMatchObject({
      credential_id: credentialId,
    })
    expect(await findPasskeyForSafe(user, SAFE_B, BASE)).toBeNull()
    expect(await findPasskeyForSafe(user, SAFE_A, GNOSIS)).toBeNull()
  })

  it('returns every passkey a user holds, across chains, oldest first', async () => {
    const user = await seedUser()
    const base = await seedPasskey({ userId: user })
    const gnosis = await seedPasskey({ userId: user, chainId: GNOSIS })

    const rows = await listUserPasskeys(user)
    expect(rows.map((r) => r.credential_id)).toEqual([base.credentialId, gnosis.credentialId])
  })
})
