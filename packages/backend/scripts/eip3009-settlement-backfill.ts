/**
 * #4319 settlement 1/3 — the eip3009 merchant-settlement proof ladder's
 * BACKFILL, for the historic rows the arrival path and the 24-hour sweep
 * horizon can no longer reach (the deferred feed rows that
 * `accounting-feed-syncs.ts`'s selection would otherwise drop).
 *
 * Tier 1 — a stored X-PAYMENT header: the proof is derived from it, the
 * settlement is found by `AuthorizationUsed(delegate, headerNonce)` and
 * recorded nonce-bound through the standard seam. NOT flag-gated: it is
 * today's #3925 standard.
 *
 * Tier 2 — the stored merchant receipt's transaction hash: the seven-limit
 * receipt attribution (`observeEip3009ReceiptSettlement`), labelled
 * `receipt`. GATED by `HAVEN_EIP3009_RECEIPT_ATTRIBUTION` (default off);
 * with the flag off the run counts `disabled` and writes nothing for those
 * rows. `protocol_receipt_header`-only rows are counted, never decoded —
 * the issue defers that fallback to a later slice.
 *
 * Run `--dry-run` FIRST (the default): per tier and verdict counts, nothing
 * written — no record, no verdict, no feed. Then `--write`: idempotent
 * (already-recorded payments are excluded by the selection; the writer's
 * compare-and-set is the backstop), and `feedSettledPaymentBestEffort`
 * fires after each record exactly as the sweep tick does (S9).
 *
 * Env: DATABASE_URL (+ RPC_URL_* as usual).
 * Run: npm run x402:eip3009-backfill -w @haven/backend [-- --write]
 */
import db, { getPool } from '../src/db.js'
import { feedSettledPaymentBestEffort } from '../src/modules/accounting/index.js'
import { recordTier1SettlementFromStoredHeader, observeEip3009ReceiptSettlement, receiptPayloadTransaction } from '../src/modules/x402/eip3009-receipt-settlement.js'
import type { Eip3009SettlementIntent } from '../src/modules/x402/eip3009-settlement-evidence.js'

const WRITE = process.argv.includes('--write')

interface BackfillRow {
  id: string
  agent_id: string
  user_id: string
  chain_id: number
  token_address: string
  to_address: string
  amount_raw: string
  status: string
  tx_hash: string | null
  source: string | null
  payment_rail: string | null
  execution_rail: string | null
  machine_metadata: Record<string, unknown> | string | null
  x402_merchant_address: string | null
  merchant_address: string | null
  confirmed_at: string | null
  payment_proof_header: string | null
  protocol_receipt_header: string | null
  protocol_receipt_payload: unknown
}

const SELECT_SQL = `SELECT pi.id, pi.agent_id, pi.user_id, pi.chain_id, pi.token_address,
              pi.to_address, pi.amount_raw, pi.status, pi.tx_hash, pi.source,
              pi.payment_rail, pi.execution_rail, pi.machine_metadata,
              pi.x402_merchant_address, pi.merchant_address, pi.confirmed_at,
              mpe.payment_proof_header, mpe.protocol_receipt_header,
              mpe.protocol_receipt_payload
         FROM payment_intents pi
         LEFT JOIN machine_payment_evidence mpe ON mpe.payment_intent_id = pi.id
        WHERE COALESCE(pi.payment_rail, pi.source) = 'x402'
          AND pi.execution_rail = 'delegation'
          AND pi.machine_metadata->>'settlement_scheme' = 'eip3009'
          AND pi.status = 'confirmed'
          AND pi.tx_hash IS NOT NULL
          AND pi.machine_metadata->>'merchant_settlement_tx_hash' IS NULL
        ORDER BY pi.confirmed_at DESC NULLS LAST`

function toIntent(row: BackfillRow): Eip3009SettlementIntent {
  return {
    id: row.id,
    agent_id: row.agent_id,
    chain_id: row.chain_id,
    token_address: row.token_address,
    to_address: row.to_address,
    amount_raw: row.amount_raw,
    status: row.status,
    tx_hash: row.tx_hash,
    x402_merchant_address: row.x402_merchant_address,
    merchant_address: row.merchant_address,
    source: row.source,
    payment_rail: row.payment_rail,
    execution_rail: row.execution_rail,
    machine_metadata: row.machine_metadata,
    confirmed_at: row.confirmed_at,
  }
}

function increment(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1
}

async function main(): Promise<void> {
  const result = await db.query<BackfillRow>(SELECT_SQL)
  const rows = result.rows

  const tier1: Record<string, number> = {}
  const tier2: Record<string, number> = {}
  let receiptHeaderOnly = 0

  for (const row of rows) {
    const intent = toIntent(row)
    let recorded = false

    if (row.payment_proof_header) {
      const t1 = await recordTier1SettlementFromStoredHeader(intent, { dryRun: !WRITE })
      increment(tier1, t1.outcome)
      recorded = t1.outcome === 'recorded' || t1.outcome === 'would_record'
    } else if (row.protocol_receipt_header) {
      // Not decoded in this slice — counted so the dry run says how many
      // rows a later fallback would have to handle.
      receiptHeaderOnly += 1
    }

    if (recorded) continue
    const candidate = receiptPayloadTransaction(row.protocol_receipt_payload)
    if (!candidate) continue
    const t2 = await observeEip3009ReceiptSettlement(intent, candidate, { dryRun: !WRITE })
    increment(tier2, t2.outcome)
    if (!WRITE && (t2.outcome === 'recorded' || t2.outcome === 'would_record')) continue
    if (WRITE && t2.outcome === 'recorded') {
      // S9, as the tick does: one best-effort feed fire per record, so the
      // booking sees the settlement hash instead of the funding hash.
      feedSettledPaymentBestEffort(row.user_id, row.id)
    }
  }

  console.log(`eip3009 settlement backfill — ${WRITE ? 'WRITE' : 'DRY RUN'} (nothing written in a dry run)`)
  console.log(`candidate rows: ${rows.length}`)
  console.log(`tier 1 (stored header) outcomes: ${JSON.stringify(tier1)}`)
  console.log(`tier 2 (receipt hash) outcomes: ${JSON.stringify(tier2)}`)
  console.log(`rows carrying only protocol_receipt_header (not decoded in this slice): ${receiptHeaderOnly}`)
  await getPool().end()
  // eslint-disable-next-line n/no-process-exit
  process.exit(0)
}

main().catch((err) => {
  console.error(err)
  // eslint-disable-next-line n/no-process-exit
  process.exit(1)
})
