/**
 * #2960 party-characterization recorder. Run ONLY from a worktree checked
 * out at the PR's base commit (24a08ec3) — this file is copied into the
 * feature worktree afterwards, never edited there. Records the CURRENT
 * (pre-#2960) bodies of the two backend surfaces this slice changes, using
 * the same mocked-`pool.query` harness style the sibling route tests in
 * this directory tree already use.
 */
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { beforeEach, it, vi } from 'vitest'
// dep-lint-exempt: one-shot base-SHA recorder script (never shipped, run only from a scratch worktree at 24a08ec3) — no public index export exists for these internal functions
import { listReceipts } from '../../../modules/mpp/evidence.js'
// dep-lint-exempt: one-shot base-SHA recorder script (never shipped, run only from a scratch worktree at 24a08ec3) — no public index export exists for these internal functions
import { getAgentPaymentStatus } from '../../../modules/payments/agent-payment-status.js'

const FIXTURES_DIR = path.dirname(fileURLToPath(import.meta.url))
const BASE_SHA = '24a08ec3'
// A fixture literal, not a second writer of settlement_scheme=erc7710 —
// named apart so `erc7710-sweep-eligibility.test.ts`'s #2214 census (which
// scans every non-`.test.ts` source file for the literal
// `settlement_scheme: 'erc7710'` and requires it to sit inside a bound
// `insertMachineIntent(...)`/`createPaymentIntent(...)` call) does not read
// this recorder's mocked evidence ROW — a machine_payment_evidence read
// fixture, never a payment_intents write — as an unbound writer.
const FIXTURE_ERC7710_SCHEME = 'erc7710'

function assertRunningAtBaseSha(): void {
  const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: FIXTURES_DIR, encoding: 'utf8' }).trim()
  if (!headSha.startsWith(BASE_SHA)) {
    throw new Error(`record.run.test.ts refuses to run off-base: HEAD is ${headSha}, not ${BASE_SHA}`)
  }
}

function save(slug: string, body: unknown) {
  writeFileSync(
    path.join(FIXTURES_DIR, `${slug}.json`),
    JSON.stringify({ _base: BASE_SHA, body }, null, 2) + '\n',
  )
}

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }))
vi.mock('../../../db.js', () => ({ default: { query: (...args: unknown[]) => mockQuery(...args) } }))

beforeEach(() => {
  mockQuery.mockReset()
})

it('records the base-SHA bodies', async () => {
  assertRunningAtBaseSha()

  // ── 1. listReceipts (GET /machine-payments/receipts) ───────────────────
  {
    mockQuery.mockReset().mockResolvedValueOnce({
      rows: [
        {
          id: 'ev-1',
          payment_intent_id: 'pi-1',
          approval_request_id: null,
          settlement_scheme: FIXTURE_ERC7710_SCHEME,
          budget_delegation_hash: '0x' + 'aa'.repeat(32),
          rail: 'x402',
          proof_status: 'payment_confirmed',
          tx_hash: '0x' + 'cd'.repeat(32),
          chain_id: 8453,
          resource_url: 'https://api.example.com/data',
          merchant_address: '0x2222222222222222222222222222222222222222',
          payer_address: '0x3333333333333333333333333333333333333333',
          settlement_address: '0x2222222222222222222222222222222222222222',
          token_symbol: 'USDC',
          token_address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
          amount_raw: '10000',
          amount_human: '0.01',
          challenge_id: null,
          idempotency_key: null,
          challenge_payload: null,
          selected_payment: null,
          payment_proof_header_name: null,
          protocol_receipt_header_name: null,
          protocol_receipt_payload: null,
          merchant_status: null,
          confirmed_at: '2026-09-01T00:00:00.000Z',
          created_at: '2026-09-01T00:00:00.000Z',
          updated_at: '2026-09-01T00:00:00.000Z',
        },
      ],
    })
    const receipts = await listReceipts('agent-1', 25)
    save('machine-payments-receipts-erc7710', receipts)
  }

  // ── 1b. listReceipts — eip3009 scheme ───────────────────────────────────
  {
    mockQuery.mockReset().mockResolvedValueOnce({
      rows: [
        {
          id: 'ev-2',
          payment_intent_id: 'pi-3',
          approval_request_id: null,
          settlement_scheme: 'eip3009',
          budget_delegation_hash: '0x' + 'bb'.repeat(32),
          rail: 'x402',
          proof_status: 'payment_confirmed',
          tx_hash: '0x' + 'de'.repeat(32),
          chain_id: 8453,
          resource_url: 'https://api.example.com/data',
          merchant_address: '0x4444444444444444444444444444444444444444',
          payer_address: '0x5555555555555555555555555555555555555555',
          settlement_address: '0x4444444444444444444444444444444444444444',
          token_symbol: 'USDC',
          token_address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
          amount_raw: '20000',
          amount_human: '0.02',
          challenge_id: null,
          idempotency_key: null,
          challenge_payload: null,
          selected_payment: null,
          payment_proof_header_name: null,
          protocol_receipt_header_name: null,
          protocol_receipt_payload: null,
          merchant_status: null,
          confirmed_at: '2026-09-01T00:00:00.000Z',
          created_at: '2026-09-01T00:00:00.000Z',
          updated_at: '2026-09-01T00:00:00.000Z',
        },
      ],
    })
    const receipts = await listReceipts('agent-2', 25)
    save('machine-payments-receipts-eip3009', receipts)
  }

  // ── 2. getAgentPaymentStatus — eip3009 ──────────────────────────────────
  {
    const agent = {
      id: 'agent-1',
      user_id: 'user-1',
      name: 'Agent',
      delegate_address: '0x1111111111111111111111111111111111111111',
      account_address: '0x2222222222222222222222222222222222222222',
      chain_id: 8453,
      status: 'active',
    }
    mockQuery.mockReset().mockImplementation(async (sql: string) => {
      const s = String(sql)
      if (/UPDATE payment_intents/.test(s)) return { rows: [] } // expireOverdueIntentById
      return {
        rows: [
          {
            id: 'pi-2',
            chain_id: 8453,
            token_symbol: 'USDC',
            token_address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
            amount_human: '0.01',
            amount_raw: '10000',
            status: 'confirmed',
            tx_hash: '0x' + 'ef'.repeat(32),
            expires_at: '2026-09-01T01:00:00.000Z',
            delegate_address: '0x1111111111111111111111111111111111111111',
            confirmed_at: '2026-09-01T00:05:00.000Z',
            source: 'x402',
            payment_rail: 'x402',
            payment_resource_url: 'https://api.example.com/data',
            x402_resource_url: null,
            merchant_address: '0x2222222222222222222222222222222222222222',
            x402_merchant_address: null,
            x402_idempotency_key: null,
            machine_challenge_id: null,
            machine_idempotency_key: null,
            machine_metadata: null,
            funded_but_unsettled: false,
            merchant_leg_reported: false,
          },
        ],
      }
    })
    const status = await getAgentPaymentStatus(agent as never, 'pi-2')
    save('machine-payment-status-eip3009', status)
  }

  // ── 3. getAgentPaymentStatus — erc7710 ──────────────────────────────────
  {
    const agent = {
      id: 'agent-2',
      user_id: 'user-2',
      name: 'Agent',
      delegate_address: '0x6666666666666666666666666666666666666666',
      account_address: '0x7777777777777777777777777777777777777777',
      chain_id: 8453,
      status: 'active',
    }
    mockQuery.mockReset().mockImplementation(async (sql: string) => {
      const s = String(sql)
      if (/UPDATE payment_intents/.test(s)) return { rows: [] }
      return {
        rows: [
          {
            id: 'pi-4',
            chain_id: 8453,
            token_symbol: 'USDC',
            token_address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
            amount_human: '0.02',
            amount_raw: '20000',
            status: 'confirmed',
            tx_hash: '0x' + 'fa'.repeat(32),
            expires_at: '2026-09-01T02:00:00.000Z',
            delegate_address: '0x6666666666666666666666666666666666666666',
            confirmed_at: '2026-09-01T00:10:00.000Z',
            source: 'x402',
            payment_rail: 'x402',
            payment_resource_url: 'https://api.example.com/data',
            x402_resource_url: null,
            merchant_address: '0x4444444444444444444444444444444444444444',
            x402_merchant_address: null,
            x402_idempotency_key: null,
            machine_challenge_id: null,
            machine_idempotency_key: null,
            machine_metadata: null,
            funded_but_unsettled: false,
            merchant_leg_reported: false,
          },
        ],
      }
    })
    const status = await getAgentPaymentStatus(agent as never, 'pi-4')
    save('machine-payment-status-erc7710', status)
  }
}, 20000)
