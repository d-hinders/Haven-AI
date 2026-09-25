/**
 * Real-DB tests for #3319: the agent-side allowance and identity reads emit
 * their Haven-owned addresses EIP-55 checksummed at the response boundary —
 * the same rule #3129 (transactions feed) and #3307 (receipt, payment status,
 * payment reads) already apply — while storage stays lowercase.
 *
 * Covered here, end to end on the #1220 harness with the REAL agent-credential
 * path (sha256 key hash → agents/smart_accounts JOIN), zero handler mocks:
 *
 *  - `GET /machine-payments/allowances`: top-level `delegate_address` and each
 *    allowance's `token_address` (the joined allowance block on
 *    `haven_get_payment_status` and `haven_settle_mcp_tool` inherits this —
 *    the SDK copies `match.tokenAddress` from this very read);
 *  - `GET /machine-payments/agent` (`haven_get_agent`): `delegate_address`;
 *  - `GET /machine-payments/balance-coverage` (`haven_check_funds`' backend):
 *    `token_address` echoes ONE casing whether the caller sent lowercase or
 *    checksummed.
 *
 * `account_address` / `delegate_account_address` on the identity read are
 * deliberately NOT asserted to change: `agents.account_address`-side values
 * come from `smart_accounts.account_address`, written checksummed as computed
 * by viem (hybrid provisioning), and `delegate_account_address` is a viem
 * counterfactual derivation — both verified live on dev 2026-09-25
 * (`haven_get_agent` → `accountAddress 0x0A5B…ba6C`, mixed case). Storage
 * stays lowercase: every address is SEEDED lowercase and the raw rows are
 * re-read to prove the fix is a read-boundary one.
 *
 * Every seed is letter-bearing and asserted to differ from its checksum form:
 * a digit-only or self-checksumming address (e.g. `0x…00f1`) would pass on the
 * old code and prove nothing. Lowercase Base Sepolia USDC
 * `0x036cbd53…3dcf7e` qualifies.
 */
import Fastify, { type FastifyInstance } from 'fastify'
import { createHash } from 'crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ethers } from 'ethers'

const { mockGetTokenBalance } = vi.hoisted(() => ({ mockGetTokenBalance: vi.fn() }))
vi.mock('../../infra/chain/index.js', () => ({
  getChainClient: () => ({
    getTokenBalance: (...a: unknown[]) => mockGetTokenBalance(...a),
  }),
}))

import db from '../../db.js'
import machinePaymentRoutes from '../machine-payments.js'
import {
  assertWorkerSchemaAtHead,
  describeDb,
  initDbHarness,
  resetDb,
} from '../../infra/__tests__/helpers/db-harness.js'
import { expectMatchesSpec } from '../../openapi/response-shape.js'

const AGENT_KEY = 'sk_agent_tst_casing3319aaaaaaaaaaaaaaaaaaaa'
const AGENT_KEY_HASH = createHash('sha256').update(AGENT_KEY).digest('hex')
const CHAIN = 84532 // Base Sepolia — the registry names USDC there
const headers = { authorization: `Bearer ${AGENT_KEY}` }

// Letter-bearing, seeded LOWERCASE (the CHECK-constraint storage form).
const TOKEN = '0x036cbd53842c5426634e7929541ec2318f3dcf7e' // Base Sepolia USDC
const DELEGATE = '0x' + 'ab'.repeat(20)
const ACCOUNT = '0x' + 'cd'.repeat(20)
const SEEDS = { TOKEN, DELEGATE, ACCOUNT }
const checksum = (a: string) => ethers.getAddress(a.toLowerCase())

let seq = 0

async function seedUser(): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`casing-${++seq}-${Date.now()}-${Math.random()}@test.example`],
  )
  return rows[0].id
}

/** A delegation-rail agent whose key is AGENT_KEY, addresses seeded LOWERCASE. */
async function seedDelegationAgent(): Promise<{ userId: string; agentId: string }> {
  const userId = await seedUser()
  const account = await db.query<{ id: string }>(
    `INSERT INTO smart_accounts (user_id, account_address, chain_id, execution_rail, account_type)
     VALUES ($1, $2, $3, 'delegation', 'delegator_hybrid') RETURNING id`,
    [userId, ACCOUNT.toLowerCase(), CHAIN],
  )
  const agent = await db.query<{ id: string }>(
    `INSERT INTO agents (user_id, name, delegate_address, api_key_hash, api_key_prefix, account_id, status)
     VALUES ($1, 'casing agent', $2, $3, 'sk_agent_tst', $4, 'active') RETURNING id`,
    [userId, DELEGATE.toLowerCase(), AGENT_KEY_HASH, account.rows[0].id],
  )
  return { userId, agentId: agent.rows[0].id }
}

/**
 * The agent's ACTIVE delegation with a LOWERCASE token address — the real
 * storage form (`042_agent_delegations` CHECKs `token_address =
 * LOWER(token_address)`). `delegation_json` stays null so the remaining read
 * falls back to the configured full budget with `fromChain: false` (#1145) —
 * the deterministic behaviour the assertions pin.
 */
async function seedActiveDelegation(agentId: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO agent_delegations
       (agent_id, chain_id, token_address, delegation_hash, delegation_json, version, status,
        budget_atomic, period_seconds, start_date, expires_at)
     VALUES ($1, $2, $3, $4, $5, 1, 'active', '5000000', 604800, 0, 99999999999) RETURNING id`,
    [
      agentId,
      CHAIN,
      TOKEN.toLowerCase(),
      `0x${String(++seq).padStart(64, '3')}`,
      JSON.stringify({ kind: 'test-fixture' }),
    ],
  )
  return rows[0].id
}

describeDb('agent-facing allowance/identity reads checksum their addresses (#3319)', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    await initDbHarness()
    app = Fastify({ logger: false })
    // The route file registers the plugin-wide agent auth hook itself, so the
    // REAL credential path runs — the same one the tools sit behind.
    await app.register(machinePaymentRoutes, { prefix: '/machine-payments' })
  })

  afterAll(async () => {
    await app.close()
    await assertWorkerSchemaAtHead()
  })

  beforeEach(async () => {
    await resetDb()
    mockGetTokenBalance.mockReset()
  })

  it('every seed differs from its checksum form — otherwise these tests would pass on the old code', () => {
    for (const [name, address] of Object.entries(SEEDS)) {
      expect(checksum(address), name).not.toBe(address.toLowerCase())
    }
  })

  it('GET /allowances: delegate_address and every token_address are checksummed while storage stays lowercase', async () => {
    const { agentId } = await seedDelegationAgent()
    await seedActiveDelegation(agentId)

    const res = await app.inject({
      method: 'GET',
      url: '/machine-payments/allowances',
      headers,
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expectMatchesSpec('GET', '/machine-payments/allowances', body)
    expect(body.delegate_address).toBe(checksum(DELEGATE))
    expect(body.allowances).toHaveLength(1)
    expect(body.allowances[0].token_address).toBe(checksum(TOKEN))
    // The rest of the read is untouched by the casing change.
    expect(body.allowances[0].token_symbol).toBe('USDC')
    expect(body.allowances[0].onchain.remaining).toBe('5000000')

    // Storage is untouched — a write-side "fix" would turn this red.
    const raw = await db.query<{ delegate_address: string; token_address: string }>(
      `SELECT a.delegate_address, d.token_address
         FROM agents a
         JOIN agent_delegations d ON d.agent_id = a.id
        WHERE a.id = $1`,
      [agentId],
    )
    expect(raw.rows[0].delegate_address).toBe(DELEGATE.toLowerCase())
    expect(raw.rows[0].token_address).toBe(TOKEN.toLowerCase())
  })

  it('GET /agent: every Haven-owned address is checksummed while storage stays lowercase', async () => {
    const { agentId } = await seedDelegationAgent()
    await seedActiveDelegation(agentId)

    const res = await app.inject({
      method: 'GET',
      url: '/machine-payments/agent',
      headers,
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expectMatchesSpec('GET', '/machine-payments/agent', body)
    expect(body.delegate_address).toBe(checksum(DELEGATE))
    // The read canonicalises `account_address` too — a no-op on the
    // checksummed rows viem writes in production (verified live on dev
    // 2026-09-25), healing for a lowercase row like this seed.
    expect(body.account_address).toBe(checksum(ACCOUNT))
    // The counterfactual delegate account is derived OFFLINE (CREATE2 from
    // the pinned factory — no RPC, so no mock needed) and viem returns it
    // already EIP-55 checksummed; the passthrough keeps it that way.
    expect(body.delegate_account_address).not.toBeNull()
    expect(ethers.getAddress(body.delegate_account_address!.toLowerCase())).toBe(
      body.delegate_account_address,
    )

    // Storage is untouched — a write-side "fix" would turn this red.
    const raw = await db.query<{ delegate_address: string; account_address: string }>(
      `SELECT a.delegate_address, sa.account_address
         FROM agents a JOIN smart_accounts sa ON sa.id = a.account_id
        WHERE a.id = $1`,
      [agentId],
    )
    expect(raw.rows[0].delegate_address).toBe(DELEGATE.toLowerCase())
    expect(raw.rows[0].account_address).toBe(ACCOUNT.toLowerCase())
  })

  it('GET /balance-coverage: token_address echoes ONE casing whether the caller sent lowercase or checksummed', async () => {
    const { agentId } = await seedDelegationAgent()
    await seedActiveDelegation(agentId)
    mockGetTokenBalance.mockResolvedValue(2_000_000n)

    for (const sent of [TOKEN.toLowerCase(), checksum(TOKEN)]) {
      const res = await app.inject({
        method: 'GET',
        url: `/machine-payments/balance-coverage?token=${encodeURIComponent(sent)}&amount_atomic=1000000`,
        headers,
      })
      expect(res.statusCode, sent).toBe(200)
      expectMatchesSpec('GET', '/machine-payments/balance-coverage', res.json())
      expect(res.json().token_address, sent).toBe(checksum(TOKEN))
      expect(res.json().covered, sent).toBe(true)
    }
    // The match and the chain read keep comparing case-insensitively / on the
    // value sent — the echo is the only thing canonicalised.
    expect(mockGetTokenBalance).toHaveBeenLastCalledWith(CHAIN, checksum(TOKEN), ACCOUNT.toLowerCase())
  })
})
