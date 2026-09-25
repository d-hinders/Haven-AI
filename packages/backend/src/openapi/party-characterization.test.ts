// db-mock-exempt: no database behaviour is under test here — every mocked
// row below is a fixed literal pinned to the recorded base-SHA fixture, at
// the same route/repository boundary the (deleted with #2914)
// p0-characterization.test.ts already
// mocks (that file's own db-mock-exempt comment explains the pattern).
/**
 * #2960 — party-characterization replay.
 *
 * The fixtures under `__fixtures__/party-characterization/*.json` were
 * recorded from a scratch worktree checked out at this PR's base commit
 * (`24a08ec3`, the `_base` on every fixture — see `record.ts`'s doc
 * comment for the exact recipe, the same recorder-run-at-base-only pattern
 * the deleted `p0-characterization/record.ts` used). This file replays the SAME inputs
 * against HEAD's `listReceipts` / `getAgentPaymentStatus` and asserts:
 *
 *   1. Every field the base fixture carried is byte-for-byte unchanged
 *      (the live body, with `parties` stripped, deep-equals the fixture).
 *   2. `parties` is present at HEAD and correct for the fixture's scheme —
 *      `treasury_account` is `payer_address` (receipts) /
 *      `account_address` (status), and `delegate` differs by scheme only
 *      in WHICH of these two fixtures encodes it, never by mapper logic
 *      (both surfaces read `agents.delegate_address`).
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getAddress } from 'ethers'

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__/party-characterization')

function loadFixture(slug: string): { _base: string; body: unknown } {
  return JSON.parse(readFileSync(path.join(FIXTURES_DIR, `${slug}.json`), 'utf8'))
}

/** Strip the additive `parties` key, recursively into arrays — the ONLY key #2960 adds to these two shapes. */
/**
 * Fields added AFTER the base fixture was recorded, each named here on
 * purpose: the replay pins that every base field is byte-identical, and an
 * addition has to be declared to pass — not absorbed by a looser matcher.
 *   - `parties` — #2960 (this file's own change)
 *   - `funding_tx_hash` / `settlement_tx_hash` — #2998, the two hashes
 *     named beside the unlabeled `tx_hash`; asserted separately below.
 */
const ADDITIVE_SINCE_BASE = new Set([
  // #3128: the receipts envelope gained page fields; the receipts themselves are unchanged.
  'total', 'has_more', 'next_cursor','parties', 'funding_tx_hash', 'settlement_tx_hash'])

function stripParties(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripParties)
  if (value === null || typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (ADDITIVE_SINCE_BASE.has(k)) continue
    out[k] = stripParties(v)
  }
  return out
}

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }))
vi.mock('../db.js', () => ({ default: { query: (...args: unknown[]) => mockQuery(...args) } }))

// Static, not dynamic: a per-test `await import(...)` pays module-graph
// resolution at TEST-RUN time, which is slow enough under full-suite
// worker contention to exceed vitest's 5000ms default testTimeout (seen
// in CI-shaped runs, not in isolation) — the same class of cost
// `vitest.config.ts`'s hookTimeout comment documents for db-harness.
import { listReceipts } from '../modules/mpp/evidence.js'
import { getAgentPaymentStatus } from '../modules/payments/agent-payment-status.js'

beforeEach(() => {
  mockQuery.mockReset()
})

describe('#2960 party-characterization replay (base 24a08ec3 → HEAD)', () => {
  it('listReceipts — erc7710 scheme: old fields unchanged, parties correct', async () => {
    const fixture = loadFixture('machine-payments-receipts-erc7710')
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 'ev-1',
          payment_intent_id: 'pi-1',
          approval_request_id: null,
          settlement_scheme: 'erc7710',
          intent_delegate_account_address: null,
          budget_delegation_hash: '0x' + 'aa'.repeat(32),
          intent_delegate_address: '0x9999999999999999999999999999999999999999',
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
    // The delegate that PAID this intent — joined from `payment_intents.delegate_address`,
    // never the calling agent's current delegate (see the rekey test below).
    const intentDelegateAddress = '0x9999999999999999999999999999999999999999'
    // #3128: the page's COUNT(*) is the second query; the list rows were queued first.
    mockQuery.mockResolvedValueOnce({ rows: [{ total: '1' }] })
    const liveBody = await listReceipts('agent-1', 25)

    // #3128: `listReceipts` returns a page; this fixture recorded the receipts ARRAY.
    expect(stripParties(liveBody!.receipts)).toEqual(stripParties(fixture.body))

    const live = liveBody!.receipts[0] as {
      parties: { treasury_account: string; delegate: string; delegate_account: string | null; merchant: string }
      funding_tx_hash: string | null
      settlement_tx_hash: string | null
    }
    expect(live.parties).toEqual({
      treasury_account: '0x3333333333333333333333333333333333333333', // == payer_address
      delegate: intentDelegateAddress,
      delegate_account: null, // #2960: base fixture's machine_metadata is null (pre-#2960)
      merchant: '0x2222222222222222222222222222222222222222', // == merchant_address
    })
    // #2998: erc7710 has one transaction — it is the settlement, there is no funding leg.
    expect(live.funding_tx_hash).toBeNull()
    expect(live.settlement_tx_hash).toBe('0x' + 'cd'.repeat(32))
  })

  it('rekeyed agent: receipts and status both show the delegate that PAID, not the agent row\'s current delegate', async () => {
    // #2960 finding 1: `mapEvidence` used to thread `AgentContext.delegate_address`
    // (the CALLING agent's CURRENT delegate) into `parties.delegate`. That
    // rotates on rekey, so a rekeyed agent would repaint an old receipt with
    // its NEW delegate instead of the one that actually paid. The fix joins
    // `payment_intents.delegate_address` (captured at intent time, never
    // rotated) on both the receipts SQL and the status SQL — this test
    // simulates a rekey (the agent row's current delegate differs from the
    // intent's) and asserts both surfaces still report the ORIGINAL, paying
    // delegate, and agree with each other.
    const paidWithDelegate = '0x9999999999999999999999999999999999999999'
    const rotatedDelegate = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

    // ── receipts ─────────────────────────────────────────────────────────
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 'ev-1',
          payment_intent_id: 'pi-1',
          approval_request_id: null,
          settlement_scheme: 'erc7710',
          intent_delegate_account_address: null,
          budget_delegation_hash: '0x' + 'aa'.repeat(32),
          // The row's joined intent column — unaffected by the agent's rekey.
          intent_delegate_address: paidWithDelegate,
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
    // `listReceipts` no longer accepts an agent-delegate argument at all —
    // there is nothing here to rotate into it. `rotatedDelegate` exists only
    // to document what the OLD (wrong) behaviour would have shown.
    // #3128: the page's COUNT(*) is the second query; the list rows were queued first.
    mockQuery.mockResolvedValueOnce({ rows: [{ total: '1' }] })
    const receiptsBody = await listReceipts('agent-1', 25)
    const receipt = receiptsBody!.receipts[0] as { parties: { delegate: string } }
    expect(receipt.parties.delegate).toBe(paidWithDelegate)
    expect(receipt.parties.delegate).not.toBe(rotatedDelegate)

    // ── status, same payment, agent object carries the ROTATED delegate ────
    const rekeyedAgent = {
      id: 'agent-1',
      user_id: 'user-1',
      name: 'Agent',
      // The agent row's CURRENT delegate, post-rekey — must NOT leak into
      // `parties.delegate` for a historical payment.
      delegate_address: rotatedDelegate,
      account_address: '0x2222222222222222222222222222222222222222',
      chain_id: 8453,
      status: 'active',
    }
    mockQuery.mockReset().mockImplementation(async (sql: string) => {
      const s = String(sql)
      if (/UPDATE payment_intents/.test(s)) return { rows: [] }
      return {
        rows: [
          {
            id: 'pi-1',
            chain_id: 8453,
            token_symbol: 'USDC',
            token_address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
            amount_human: '0.01',
            amount_raw: '10000',
            status: 'confirmed',
            tx_hash: '0x' + 'cd'.repeat(32),
            expires_at: '2026-09-01T01:00:00.000Z',
            // The intent's own delegate column — captured at authorize time,
            // never rotated by a later rekey.
            delegate_address: paidWithDelegate,
            account_address: '0x2222222222222222222222222222222222222222',
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
    const statusBody = await getAgentPaymentStatus(rekeyedAgent as never, 'pi-1')
    const status = statusBody as unknown as { parties: { delegate: string } }
    expect(status.parties.delegate).toBe(paidWithDelegate)
    expect(status.parties.delegate).not.toBe(rotatedDelegate)

    // Both surfaces agree on the SAME payment's paying delegate.
    expect(receipt.parties.delegate).toBe(status.parties.delegate)
  })

  it('listReceipts — eip3009 scheme: old fields unchanged, parties correct', async () => {
    const fixture = loadFixture('machine-payments-receipts-eip3009')
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 'ev-2',
          payment_intent_id: 'pi-3',
          approval_request_id: null,
          settlement_scheme: 'eip3009',
          intent_delegate_account_address: null,
          budget_delegation_hash: '0x' + 'bb'.repeat(32),
          intent_delegate_address: '0x8888888888888888888888888888888888888888',
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
    const intentDelegateAddress = '0x8888888888888888888888888888888888888888'
    // #3128: the page's COUNT(*) is the second query; the list rows were queued first.
    mockQuery.mockResolvedValueOnce({ rows: [{ total: '1' }] })
    const liveBody = await listReceipts('agent-2', 25)

    // #3128: `listReceipts` returns a page; this fixture recorded the receipts ARRAY.
    expect(stripParties(liveBody!.receipts)).toEqual(stripParties(fixture.body))

    const live = liveBody!.receipts[0] as { parties: { treasury_account: string; delegate: string } }
    expect(live.parties.treasury_account).toBe('0x5555555555555555555555555555555555555555')
    expect(live.parties.delegate).toBe(intentDelegateAddress)
  })

  it('getAgentPaymentStatus — eip3009: old fields unchanged, parties.treasury_account === account_address', async () => {
    const fixture = loadFixture('machine-payment-status-eip3009')
    const agent = {
      id: 'agent-1',
      user_id: 'user-1',
      name: 'Agent',
      delegate_address: '0x1111111111111111111111111111111111111111',
      account_address: '0x2222222222222222222222222222222222222222',
      chain_id: 8453,
      status: 'active',
    }
    mockQuery.mockImplementation(async (sql: string) => {
      const s = String(sql)
      if (/UPDATE payment_intents/.test(s)) return { rows: [] }
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
            // #2960: the one new SELECT column — see FIND_INTENT_STATUS_ROW_SQL.
            account_address: '0x2222222222222222222222222222222222222222',
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
    const liveBody = await getAgentPaymentStatus(agent as never, 'pi-2')

    expect(stripParties(liveBody)).toEqual(stripParties(fixture.body))

    const live = liveBody as unknown as { parties: { treasury_account: string; delegate: string } }
    // eip3009: the on-chain PAYMENT-RESPONSE.payer is the delegate EOA —
    // `parties.delegate`, NOT `parties.treasury_account`. The treasury is
    // where the ERC-3009 transfer's funding leg originated.
    expect(live.parties.treasury_account).toBe('0x2222222222222222222222222222222222222222')
    expect(live.parties.delegate).toBe('0x1111111111111111111111111111111111111111')
  })

  it('getAgentPaymentStatus — erc7710: old fields unchanged, parties.treasury_account === account_address', async () => {
    const fixture = loadFixture('machine-payment-status-erc7710')
    const agent = {
      id: 'agent-2',
      user_id: 'user-2',
      name: 'Agent',
      delegate_address: '0x6666666666666666666666666666666666666666',
      account_address: '0x7777777777777777777777777777777777777777',
      chain_id: 8453,
      status: 'active',
    }
    mockQuery.mockImplementation(async (sql: string) => {
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
            account_address: '0x7777777777777777777777777777777777777777',
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
    const liveBody = await getAgentPaymentStatus(agent as never, 'pi-4')

    expect(stripParties(liveBody)).toEqual(stripParties(fixture.body))

    const live = liveBody as unknown as { parties: { treasury_account: string; delegate: string; delegate_account: string | null } }
    // erc7710: the merchant-visible PAYMENT-RESPONSE.payer is the DELEGATE
    // ACCOUNT (`x402-delegation.ts:211`'s `delegator: delegateAccountAddress`),
    // which is neither `parties.treasury_account` nor `parties.delegate` here.
    // This fixture's `machine_metadata` is null (base commit, before #2960
    // wrote `delegate_account_address`), so `parties.delegate_account` is
    // null too — a separate HEAD-only test below covers the populated case.
    // `treasury_account` is the account the funds LEFT Haven's custody model
    // from on BOTH schemes — on erc7710 that transfer's `from` IS the
    // merchant-visible one; on eip3009 the merchant-visible transfer is one
    // hop later (delegate → merchant), and the treasury→delegate funding leg
    // precedes it. The two schemes agree on what `treasury_account` means,
    // not on which transfer's `from` a merchant sees.
    expect(live.parties.treasury_account).toBe('0x7777777777777777777777777777777777777777')
    expect(live.parties.delegate).toBe('0x6666666666666666666666666666666666666666')
    expect(live.parties.delegate_account).toBeNull()
  })

  // ── #2960 finding 2 / 6: HEAD-only — `parties.delegate_account` populated ──
  //
  // The four base fixtures above are recorded at `24a08ec3`, before #2960
  // wrote `delegate_account_address` into `machine_metadata`, so they
  // deliberately keep `machine_metadata: null` / no joined column and prove
  // additivity only. These two tests are NOT a base-fixture replay — they
  // assert the NEW behaviour directly: `delegate_account_address`, once
  // written at authorize time (both delegation-rail legs), round-trips onto
  // `parties.delegate_account` on both receipts and status, for both schemes.

  it('listReceipts — erc7710: parties.delegate_account reads back the authorize-time delegator', async () => {
    const authorizeTimeDelegator = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    mockQuery.mockReset().mockResolvedValueOnce({
      rows: [
        {
          id: 'ev-5',
          payment_intent_id: 'pi-5',
          approval_request_id: null,
          settlement_scheme: 'erc7710',
          // `pi.machine_metadata->>'delegate_account_address'`, joined by
          // `LIST_EVIDENCE_RECEIPTS_SQL` — the authorize-time delegator.
          intent_delegate_account_address: authorizeTimeDelegator,
          budget_delegation_hash: '0x' + 'aa'.repeat(32),
          intent_delegate_address: '0x9999999999999999999999999999999999999999',
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
    // #3128: the page's COUNT(*) is the second query; the list rows were queued first.
    mockQuery.mockResolvedValueOnce({ rows: [{ total: '1' }] })
    const liveBody = await listReceipts('agent-1', 25)
    const live = liveBody!.receipts[0] as { parties: { delegate_account: string | null } }
    // #3307: read back EIP-55 checksummed at the read boundary (storage stays lowercase).
    expect(live.parties.delegate_account).toBe(getAddress(authorizeTimeDelegator))
  })

  it('getAgentPaymentStatus — erc7710: parties.delegate_account reads back machine_metadata.delegate_account_address', async () => {
    const authorizeTimeDelegator = '0xcccccccccccccccccccccccccccccccccccccccc'
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
            id: 'pi-6',
            chain_id: 8453,
            token_symbol: 'USDC',
            token_address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
            amount_human: '0.02',
            amount_raw: '20000',
            status: 'confirmed',
            tx_hash: '0x' + 'fa'.repeat(32),
            expires_at: '2026-09-01T02:00:00.000Z',
            delegate_address: '0x6666666666666666666666666666666666666666',
            account_address: '0x7777777777777777777777777777777777777777',
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
            // Written at authorize time on the erc7710 leg
            // (`modules/x402/delegation-authorize.ts`).
            machine_metadata: {
              settlement_scheme: 'erc7710',
              delegate_account_address: authorizeTimeDelegator,
            },
            funded_but_unsettled: false,
            merchant_leg_reported: false,
          },
        ],
      }
    })
    const liveBody = await getAgentPaymentStatus(agent as never, 'pi-6')
    const live = liveBody as unknown as { parties: { delegate_account: string | null } }
    // #3307: read back EIP-55 checksummed at the read boundary (storage stays lowercase).
    expect(live.parties.delegate_account).toBe(getAddress(authorizeTimeDelegator))
  })
})
