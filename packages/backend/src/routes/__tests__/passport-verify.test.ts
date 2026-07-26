import { beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'
import { Wallet, verifyMessage } from 'ethers'
import passportVerifyRoutes from '../passport-verify.js'
import {
  canonicalize,
  setReceiptSigningKey,
  verifyReceipt,
  type SignedPassportReceipt,
} from '../../lib/passport/index.js'

/**
 * The merchant-facing verifier (#974). These tests exercise it end to end
 * through HTTP, because the properties that matter — minimal disclosure,
 * fail-closed, and "no passport" being a normal answer — are properties of the
 * RESPONSE, not of the functions behind it.
 */

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }))
vi.mock('../../db.js', () => ({
  default: { query: (...args: unknown[]) => mockQuery(...args) },
}))

const SIGNER = Wallet.createRandom()
const EOA = '0x15179876c595922999c2d5dc7c23cc7711fe799a'
const SMART = '0x2222222222222222222222222222222222222222'
const UID = '0x' + 'ab'.repeat(32)
const ZERO = '0x0000000000000000000000000000000000000000'

/** One agent_passports row joined with its agent + account, as the repo reads it. */
function row(overrides: Record<string, unknown> = {}) {
  return {
    agent_id: 'agt_1',
    agent_status: 'active',
    standing_changed_at: new Date('2026-07-20T00:00:00Z'),
    passport_status: 'anchored',
    attestation_uid: UID,
    revocation_status: 'none',
    revocation_confirmed_at: null,
    agent_eoa: EOA,
    smart_account: SMART,
    chain_id: 84532,
    execution_rail: 'delegation',
    safe_address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    ...overrides,
  }
}

/** Resolve any lookup to `found`, so tests vary state rather than plumbing. */
function mockLookup(found: Record<string, unknown> | null) {
  mockQuery.mockImplementation(async () => ({ rows: found ? [found] : [] }))
}

/**
 * A faithful stand-in for the WHERE clause, so a test can prove the SQL filters
 * rather than that the mock returned nothing. Rows are matched the way the real
 * query matches them, including `p.status = 'anchored'`.
 */
function mockTable(rows: Array<Record<string, unknown>>) {
  mockQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
    const needle = String(params[0] ?? '').toLowerCase()
    // The anchored filter is DERIVED from the SQL, never assumed. Hard-coding it
    // here would make every test below pass with the WHERE clause deleted —
    // asserting the mock's opinion instead of the query's.
    const anchoredOnly = /p\.status = 'anchored'/.test(sql)
    const match = rows
      .filter((r) => !anchoredOnly || r.passport_status === 'anchored')
      .filter((r) =>
        /attestation_uid = \$1/.test(sql)
          ? r.attestation_uid === params[0]
          : r.agent_eoa === needle || r.smart_account === needle,
      )
    return { rows: match.slice(0, 1) }
  })
}

async function build() {
  const app = Fastify({ logger: false })
  await app.register(passportVerifyRoutes, { prefix: '/passport' })
  return app
}

beforeEach(() => {
  mockQuery.mockReset()
  setReceiptSigningKey(SIGNER.privateKey)
})

describe('GET /passport/verify', () => {
  it('returns a receipt a merchant can verify OFFLINE', async () => {
    mockLookup(row())
    const res = await (await build()).inject({ url: `/passport/verify?address=${EOA}` })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { found: boolean } & SignedPassportReceipt
    expect(body.found).toBe(true)
    // The whole pitch: authenticity checkable with no call back to Haven.
    expect(verifyMessage(canonicalize(body.receipt), body.signature).toLowerCase()).toBe(
      SIGNER.address.toLowerCase(),
    )
    expect(verifyReceipt(body, SIGNER.address).valid).toBe(true)
  })

  it('resolves EITHER address to the same passport', async () => {
    // #971 binds both because #946 made settlement a per-payment choice: a
    // merchant sees the EOA on an EIP-3009 header and the Hybrid account in
    // erc7710 redemption. Verification must work from whichever it holds.
    mockLookup(row())
    const app = await build()
    const byEoa = (await app.inject({ url: `/passport/verify?address=${EOA}` })).json()
    const bySmart = (await app.inject({ url: `/passport/verify?address=${SMART}` })).json()
    expect(byEoa.receipt.agentId).toBe(bySmart.receipt.agentId)
    expect(bySmart.receipt.agentEoa).toBe(EOA)
  })

  it('resolves by attestation UID', async () => {
    mockLookup(row())
    const res = await (await build()).inject({ url: `/passport/verify?uid=${UID}` })
    expect(res.json().receipt.evidenceUid).toBe(UID)
  })

  it('reflects revocation IMMEDIATELY, whatever the anchor is doing', async () => {
    // The headline property of #973 seen from the merchant's side: during the
    // lag window the on-chain attestation still reads valid, and the receipt
    // must not.
    mockLookup(row({ agent_status: 'revoked', revocation_status: 'pending' }))
    const body = (await (await build()).inject({ url: `/passport/verify?address=${EOA}` })).json()
    expect(body.receipt.standing).toBe('revoked')
    expect(body.receipt.anchor).toBe('revocation_pending')
  })

  it('a PAUSED agent is not active', async () => {
    mockLookup(row({ agent_status: 'paused' }))
    const body = (await (await build()).inject({ url: `/passport/verify?address=${EOA}` })).json()
    expect(body.receipt.standing).toBe('suspended')
  })

  it('an agent with no passport is a clean answer, NOT an error', async () => {
    // Issuance is opt-in, so most agents have none. A 404 here invites
    // integrations to treat a lookup failure as a pass.
    mockLookup(null)
    const res = await (await build()).inject({ url: `/passport/verify?address=${EOA}` })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ found: false, reason: 'no_passport' })
    // And it must not be cached: "no passport today" can become one tomorrow.
    expect(res.headers['cache-control']).toBe('no-store')
  })

  it('never resolves the ZERO address', async () => {
    // The EAS sentinel for "no smart account". If a lookup by 0x0 matched, every
    // EOA-only agent would collide on one address and a merchant querying junk
    // would be handed somebody else's passport.
    mockLookup(row())
    const res = await (await build()).inject({ url: `/passport/verify?address=${ZERO}` })
    expect(res.json()).toEqual({ found: false, reason: 'no_passport' })
    // Rejected before it ever reaches the database.
    expect(mockQuery).not.toHaveBeenCalled()
  })
})

describe('the verifier speaks ONLY about passports already public on-chain', () => {
  // Owner decision 2026-07-26. Everything the endpoint reveals about an agent's
  // EXISTENCE is readable from the EAS attestation by anyone. Live standing goes
  // further than the chain — that is the product — but only for agents whose
  // attestation is already published.

  it('does not resolve a PENDING passport, even with its addresses populated', async () => {
    // The columns are populated deliberately here. Today `markAnchored` writes
    // them in the same statement that sets status='anchored', so a pending row
    // has NULLs and could not be found regardless — which means a test using a
    // realistic pending row would pass without the filter and prove nothing.
    // This asserts the FILTER, so recording addresses earlier (to show a
    // "passport pending" state, say) cannot silently widen disclosure.
    mockTable([row({ passport_status: 'pending', attestation_uid: null })])
    const res = await (await build()).inject({ url: `/passport/verify?address=${EOA}` })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ found: false, reason: 'no_passport' })
  })

  it('does not resolve a FAILED passport', async () => {
    mockTable([row({ passport_status: 'failed' })])
    const body = (await (await build()).inject({ url: `/passport/verify?address=${EOA}` })).json()
    expect(body).toEqual({ found: false, reason: 'no_passport' })
  })

  it('does not resolve a pending passport by UID either', async () => {
    mockTable([row({ passport_status: 'pending' })])
    const body = (await (await build()).inject({ url: `/passport/verify?uid=${UID}` })).json()
    expect(body).toEqual({ found: false, reason: 'no_passport' })
  })

  it('is INDISTINGUISHABLE from an agent with no passport at all', async () => {
    // Reporting "pending" separately would leak exactly what the filter
    // withholds: that this address belongs to a Haven customer.
    mockTable([row({ passport_status: 'pending' })])
    const pending = (await (await build()).inject({ url: `/passport/verify?address=${EOA}` })).json()
    mockTable([])
    const absent = (await (await build()).inject({ url: `/passport/verify?address=${EOA}` })).json()
    expect(pending).toEqual(absent)
  })

  it('still resolves an anchored passport', async () => {
    // The filter must not have narrowed away the feature.
    mockTable([row()])
    expect((await (await build()).inject({ url: `/passport/verify?address=${EOA}` })).json().found).toBe(true)
  })

  it('still reports a REVOKED anchored agent — live standing is the product', async () => {
    // Narrowing is about existence, not about standing. An anchored attestation
    // is already public, so answering "revoked" for it discloses nothing new
    // about who the agent is — only that Haven has withdrawn it, which is the
    // entire reason the endpoint exists.
    mockTable([row({ agent_status: 'revoked', revocation_status: 'pending' })])
    const body = (await (await build()).inject({ url: `/passport/verify?address=${EOA}` })).json()
    expect(body.receipt.standing).toBe('revoked')
  })
})

describe('minimal disclosure — the endpoint is unauthenticated', () => {
  it('discloses NO treasury address, budget, balance, or owner', async () => {
    mockLookup(row())
    const res = await (await build()).inject({ url: `/passport/verify?address=${EOA}` })
    const raw = res.body.toLowerCase()
    // The treasury is reported as a boolean, never as an address: a merchant
    // needs to know the agent is governed, not where its owner keeps money.
    expect(raw).not.toContain('833589fcd6edb6e08f4c7c32d4f71b54bda02913')
    expect(raw).not.toContain('user_id')
    expect(raw).not.toContain('safe_address')
    expect(res.json().receipt.controls).toEqual({
      rail: 'delegation',
      policyEnforcedOnchain: true,
      treasuryBound: true,
    })
  })
})

describe('fail-closed and input handling', () => {
  it('503s rather than serving an UNSIGNED receipt', async () => {
    setReceiptSigningKey(null)
    mockLookup(row())
    const res = await (await build()).inject({ url: `/passport/verify?address=${EOA}` })
    expect(res.statusCode).toBe(503)
    // Never reached the database, so an unconfigured deployment leaks nothing.
    expect(mockQuery).not.toHaveBeenCalled()
  })

  it('requires exactly one of address or uid', async () => {
    const app = await build()
    expect((await app.inject({ url: '/passport/verify' })).statusCode).toBe(400)
    expect(
      (await app.inject({ url: `/passport/verify?address=${EOA}&uid=${UID}` })).statusCode,
    ).toBe(400)
  })

  it('rejects a malformed address or uid', async () => {
    const app = await build()
    expect((await app.inject({ url: '/passport/verify?address=nope' })).statusCode).toBe(400)
    expect((await app.inject({ url: '/passport/verify?uid=0x1234' })).statusCode).toBe(400)
  })
})

describe('GET /passport/issuer', () => {
  it('publishes the address to pin, so trust is not circular', async () => {
    // A merchant must not learn the issuer from the `issuer` field of a receipt
    // it has not yet verified — that would authenticate the receipt against
    // itself. Pinning is a one-time setup step from this endpoint.
    const res = await (await build()).inject({ url: '/passport/issuer' })
    expect(res.json().issuer.toLowerCase()).toBe(SIGNER.address.toLowerCase())
    expect(res.json().receipt_ttl_seconds).toBeGreaterThan(0)
  })

  it('503s when verification is not configured', async () => {
    setReceiptSigningKey(null)
    expect((await (await build()).inject({ url: '/passport/issuer' })).statusCode).toBe(503)
  })
})
