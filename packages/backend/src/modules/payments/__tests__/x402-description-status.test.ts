/**
 * #3610: a plain-HTTP x402 payment's status reports what was bought.
 *
 * The status reads `machine_metadata` off the real `payment_intents` row
 * (`FIND_INTENT_STATUS_ROW_SQL`), so this runs on real Postgres per
 * `docs/contributing/testing-strategy.md`. Three row shapes:
 *
 * - written since #3610: `machine_metadata.description` is set at authorize;
 * - written before #3610: no `description`, but the verbatim 402 (#1355)
 *   carries `payment_required.resource.description` — the shape of the
 *   reported payment;
 * - a 402 without a description: `null`, never invented.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import db from '../../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../../infra/__tests__/helpers/db-harness.js'
import { type AgentContext } from '../../../middleware/agentAuth.js'
import { getAgentPaymentStatus } from '../agent-payment-status.js'
import { MAX_X402_DESCRIPTION_CODE_POINTS, x402Description } from '../../../domain/x402-description.js'

let seq = 0

const PAYMENT_REQUIRED_WITH_DESCRIPTION = {
  x402Version: 2,
  resource: {
    url: 'https://merchant.example/api/fact',
    description: 'Get a random fun fact',
    mimeType: 'application/json',
  },
  accepts: [],
}

async function seedConfirmedX402(metadata: Record<string, unknown>): Promise<{ agent: AgentContext; paymentId: string }> {
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`x402-description-${++seq}-${Date.now()}@test.example`],
  )
  const userId = user.rows[0].id
  const agentRow = await db.query<{ id: string }>(
    `INSERT INTO agents (user_id, name) VALUES ($1, 'description agent') RETURNING id`,
    [userId],
  )
  const agentId = agentRow.rows[0].id
  const intent = await db.query<{ id: string }>(
    `INSERT INTO payment_intents
       (agent_id, user_id, account_address, token_symbol, token_address, to_address,
        amount_raw, amount_human, delegate_address, allowance_nonce, sign_hash,
        status, tx_hash, confirmed_at, expires_at, source, payment_rail,
        x402_resource_url, x402_merchant_address, machine_metadata)
     VALUES ($1, $2, '0x00000000000000000000000000000000000000f1', 'USDC',
             '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
             '0x00000000000000000000000000000000000000c1',
             '1000', '0.001', '0x00000000000000000000000000000000000000d1',
             0, '0xsign', 'confirmed', '0x' || repeat('ab', 32),
             NOW(), NOW() + interval '10 minutes', 'x402', 'x402',
             'https://merchant.example/api/fact',
             '0x00000000000000000000000000000000000000c1', $3::jsonb)
     RETURNING id`,
    [agentId, userId, JSON.stringify({ settlement_scheme: 'erc7710', ...metadata })],
  )
  return {
    agent: {
      id: agentId,
      user_id: userId,
      name: 'description agent',
      delegate_address: '0x00000000000000000000000000000000000000d1',
      account_address: '0x00000000000000000000000000000000000000f1',
      chain_id: 84532,
      status: 'active',
    } as AgentContext,
    paymentId: intent.rows[0].id,
  }
}

describeDb('#3610 — x402 status reports the merchant description', () => {
  beforeAll(initDbHarness)
  beforeEach(resetDb)

  it('reports the description persisted at authorize', async () => {
    const { agent, paymentId } = await seedConfirmedX402({ description: 'Get a random fun fact' })
    const status = await getAgentPaymentStatus(agent, paymentId)
    expect(status?.description).toBe('Get a random fun fact')
    expect(status?.x402?.description).toBe('Get a random fun fact')
  })

  it('a pre-#3610 row reads it from the stored 402 (the reported payment shape)', async () => {
    const { agent, paymentId } = await seedConfirmedX402({ payment_required: PAYMENT_REQUIRED_WITH_DESCRIPTION })
    const status = await getAgentPaymentStatus(agent, paymentId)
    expect(status?.description).toBe('Get a random fun fact')
    expect(status?.x402?.description).toBe('Get a random fun fact')
  })

  it('a 402 without a description still reports null', async () => {
    const { agent, paymentId } = await seedConfirmedX402({
      payment_required: { x402Version: 2, resource: { url: 'https://merchant.example/api/fact' }, accepts: [] },
    })
    const status = await getAgentPaymentStatus(agent, paymentId)
    expect(status?.description).toBeNull()
    expect(status?.x402?.description).toBeNull()
  })
})

describe('x402Description (#3610)', () => {
  it('prefers the body description, trimmed', () => {
    expect(x402Description('  Body text ', PAYMENT_REQUIRED_WITH_DESCRIPTION)).toBe('Body text')
  })

  it('falls back to the stored 402, and ignores non-strings and blanks', () => {
    expect(x402Description(undefined, PAYMENT_REQUIRED_WITH_DESCRIPTION)).toBe('Get a random fun fact')
    expect(x402Description('   ', PAYMENT_REQUIRED_WITH_DESCRIPTION)).toBe('Get a random fun fact')
    expect(x402Description(42, { resource: { description: ['not', 'a', 'string'] } })).toBeNull()
    expect(x402Description(null, null)).toBeNull()
    expect(x402Description(null, [])).toBeNull()
  })

  it('bounds untrusted merchant text by code points, with an ellipsis', () => {
    const long = '😀'.repeat(MAX_X402_DESCRIPTION_CODE_POINTS + 5)
    const out = x402Description(long, null) as string
    expect([...out].length).toBe(MAX_X402_DESCRIPTION_CODE_POINTS + 1)
    expect(out.endsWith('…')).toBe(true)
    expect(x402Description('😀'.repeat(MAX_X402_DESCRIPTION_CODE_POINTS), null)).toBe('😀'.repeat(MAX_X402_DESCRIPTION_CODE_POINTS))
  })
})
