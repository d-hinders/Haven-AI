import { randomUUID } from 'node:crypto'
import { beforeAll, beforeEach, expect, it } from 'vitest'
import db from '../../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../__tests__/helpers/db-harness.js'
import { insertUser } from '../users.js'
import {
  DEVICE_CODE_TTL_MS,
  approveDeviceAuthorization,
  createDeviceAuthorization,
  denyDeviceAuthorization,
  findByDeviceCode,
  generateUserCode,
  hashCode,
  normalizeUserCode,
  purgeExpired,
  redeemDeviceAuthorization,
} from '../device-authorizations.js'

/**
 * Real-DB tests for the device-authorization grants (#2526).
 *
 * This table backs a login. Every property below is one an attacker would
 * probe, and each is asserted against a real Postgres because that is where
 * the guard actually lives — the WHERE clauses are the enforcement, not the
 * route's `if` statements.
 */

let seq = 0
const email = () => `dev-auth-${++seq}-${Date.now()}@test.example`

async function pending(clientLabel = 'Haven CLI on test-host') {
  const userCode = generateUserCode()
  const deviceCode = randomUUID()
  const row = await createDeviceAuthorization({
    userCode,
    deviceCode,
    clientLabel,
    expiresAt: new Date(Date.now() + DEVICE_CODE_TTL_MS),
  })
  return { row, userCode, deviceCode }
}

describeDb('device authorizations (#2526)', () => {
  beforeAll(initDbHarness)
  beforeEach(resetDb)

  it('stores BOTH codes hashed, never in the clear', async () => {
    // The property a leaked row must not break: whoever reads the table cannot
    // complete somebody else's login.
    const { userCode, deviceCode } = await pending()
    const stored = await db.query<{ user_code_hash: string; device_code_hash: string }>(
      `SELECT user_code_hash, device_code_hash FROM device_authorizations`,
    )
    const [only] = stored.rows
    expect(only.user_code_hash).toBe(hashCode(normalizeUserCode(userCode)))
    expect(only.device_code_hash).toBe(hashCode(deviceCode))
    // Positive control: the raw values are genuinely absent, not merely
    // different — a hash of the wrong thing would also pass the lines above.
    const dump = JSON.stringify(stored.rows)
    expect(dump).not.toContain(deviceCode)
    expect(dump).not.toContain(normalizeUserCode(userCode))
  })

  it('a pending grant is attached to nobody', async () => {
    const { row } = await pending()
    expect(row.status).toBe('pending')
    expect(row.user_id).toBeNull()
    expect(row.approved_at).toBeNull()
  })

  it('approve binds the grant to the approving user', async () => {
    const user = await insertUser('Owner', email(), 'x', null)
    const { userCode, deviceCode } = await pending()
    const approved = await approveDeviceAuthorization(userCode, user.id)
    expect(approved?.status).toBe('approved')
    expect(approved?.user_id).toBe(user.id)
    const polled = await findByDeviceCode(deviceCode)
    expect(polled?.status).toBe('approved')
  })

  it('accepts the code as a human types it — lowercase, spaced, dashed', async () => {
    const user = await insertUser('Owner', email(), 'x', null)
    const { userCode } = await pending()
    const typed = ` ${userCode.toLowerCase().replace('-', ' ')} `
    expect(await approveDeviceAuthorization(typed, user.id)).not.toBeNull()
  })

  it('SINGLE USE: two concurrent redemptions mint one session, not two', async () => {
    // The normal case for a poll loop, not an exotic one. Enforced by the
    // `status = 'approved'` predicate INSIDE the update, so there is no
    // read-then-write window for the second caller to win.
    const user = await insertUser('Owner', email(), 'x', null)
    const { userCode, deviceCode } = await pending()
    await approveDeviceAuthorization(userCode, user.id)

    const [a, b] = await Promise.all([
      redeemDeviceAuthorization(deviceCode),
      redeemDeviceAuthorization(deviceCode),
    ])
    expect([a, b].filter(Boolean)).toHaveLength(1)
    expect(await redeemDeviceAuthorization(deviceCode)).toBeNull()
  })

  it('CONCURRENCY: two approvals of one code bind it once', async () => {
    const one = await insertUser('One', email(), 'x', null)
    const two = await insertUser('Two', email(), 'x', null)
    const { userCode } = await pending()
    const [a, b] = await Promise.all([
      approveDeviceAuthorization(userCode, one.id),
      approveDeviceAuthorization(userCode, two.id),
    ])
    const winners = [a, b].filter(Boolean)
    expect(winners).toHaveLength(1)
    expect([one.id, two.id]).toContain(winners[0]!.user_id)
  })

  it('an EXPIRED grant cannot be approved or redeemed', async () => {
    const user = await insertUser('Owner', email(), 'x', null)
    const userCode = generateUserCode()
    const deviceCode = randomUUID()
    await createDeviceAuthorization({
      userCode,
      deviceCode,
      clientLabel: null,
      expiresAt: new Date(Date.now() - 1000),
    })
    expect(await approveDeviceAuthorization(userCode, user.id)).toBeNull()
    expect(await redeemDeviceAuthorization(deviceCode)).toBeNull()
    // Positive control: the row IS there — the refusal is the expiry, not a
    // missing row, which would make this assertion vacuous.
    expect(await findByDeviceCode(deviceCode)).not.toBeNull()
  })

  it('a WRONG user code matches nothing — codes are not enumerable', async () => {
    const user = await insertUser('Owner', email(), 'x', null)
    await pending()
    expect(await approveDeviceAuthorization('AAAA-AAAA', user.id)).toBeNull()
  })

  it('deny closes the grant, and a denied grant cannot be redeemed', async () => {
    const { userCode, deviceCode } = await pending()
    const denied = await denyDeviceAuthorization(userCode)
    expect(denied?.status).toBe('denied')
    expect(await redeemDeviceAuthorization(deviceCode)).toBeNull()
  })

  it('an UNAPPROVED grant cannot be redeemed', async () => {
    const { deviceCode } = await pending()
    expect(await redeemDeviceAuthorization(deviceCode)).toBeNull()
  })

  it('purge drops expired rows and leaves live ones', async () => {
    const { deviceCode: live } = await pending()
    const dead = randomUUID()
    await createDeviceAuthorization({
      userCode: generateUserCode(),
      deviceCode: dead,
      clientLabel: null,
      expiresAt: new Date(Date.now() - 1000),
    })
    expect(await purgeExpired()).toBe(1)
    expect(await findByDeviceCode(dead)).toBeNull()
    expect(await findByDeviceCode(live)).not.toBeNull()
  })

  it('the CHECK constraint refuses an approved row with no user', async () => {
    // The invariant stated in SQL rather than trusted to the route: "the route
    // always sets both" is the kind of promise that decays.
    const { row } = await pending()
    await expect(
      db.query(`UPDATE device_authorizations SET status = 'approved' WHERE id = $1`, [row.id]),
    ).rejects.toThrow(/device_authorizations_approved_has_user/)
  })

  it('user codes avoid the characters a human misreads', async () => {
    // 0/O, 1/I/L and U are absent by construction. Sampled rather than
    // asserted once, because a single draw proves nothing about an alphabet.
    const drawn = Array.from({ length: 200 }, () => generateUserCode()).join('')
    expect(drawn).not.toMatch(/[01ILOU]/)
    expect(new Set(drawn.replace(/-/g, '')).size).toBeGreaterThan(10)
  })
})
