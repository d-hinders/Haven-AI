/**
 * #4119: the qa-dev EIP-3009 legs assert that Haven RECORDED the merchant
 * settlement, not only that both legs landed on-chain.
 *
 * ## Why the legs needed it
 *
 * #3925 made the backend refuse an EIP-3009 settlement report that carries no
 * payment header. Until #4075 the SDK posted none, so every settlement report
 * from the SDK's paid-retry paths was refused for five days — and every
 * EIP-3009 leg stayed green, because each one proved that money MOVED and none
 * read the record the receipts headline (#3763) and the accounting feed (#3767)
 * book under. A hand-run testnet purchase found it (#4061), not qa-dev.
 *
 * ## What "recorded" means, and why it is read the way it is
 *
 * `GET /machine-payments/:id/status` answers `merchant_settlement_recorded:
 * true` only when `machine_metadata.merchant_settlement_tx_hash` is written,
 * and only the on-chain-verifying writer writes it. The receipt's
 * `settlement_tx_hash` is then compared, case-insensitively (the writer stores
 * `LOWER(hash)`), with the hash the leg proved on-chain. The receipt hash alone
 * proves nothing: with no record it falls back to the merchant's own
 * unverified echo. That is why the flag is read first.
 *
 * ## The sweep cannot mask a missing report inside the attribution window
 *
 * The backend's #3888 eip3009 sweep records the same settlement independently,
 * from the chain. Its candidate query takes payments with `confirmed_at <=
 * NOW() - 60 s`, and its tick runs at boot and then every 120 s, so a sweep
 * record lands 60–180 s after the funding confirm, never earlier. A client
 * report, by contrast, finishes before the call that triggers it returns: the
 * SDK awaits its one settlement report inside `MerchantCompletion.retryRequest`,
 * and the hosted settle posts its report inside the settle call.
 *
 * So each leg takes an anchor — a runner timestamp the funding confirm cannot
 * precede — and a record observed within {@link ATTRIBUTION_WINDOW_MS} of it
 * can only be a client-made record. The window is the sweep's 60 s floor minus
 * a 15 s margin. A record first seen after it fails the leg: the deadline is
 * never extended to "wait for the sweep".
 *
 * ## Flake risk, stated
 *
 * The backend checks the settlement transaction once per report, with no wait.
 * A merchant transaction not yet visible to the backend's node at report time
 * is answered `retryable`. The SDK cannot surface that answer (it swallows the
 * outcome by design) and posts once, so on the SDK-direct legs that case is a
 * red that is not a Haven regression. The #4119 spec (spec-review correction
 * 3) keeps the SDK legs strict: if that red recurs, the fix is in the SDK —
 * surface `settlementEvidenceOutcome` on the local `fetch` /
 * `resumeX402Payment` path — never a re-post from the leg. The hosted legs
 * can see `retryable` and follow it ({@link assertHostedSettlementRecorded}).
 *
 * A second, bounded residual: a hosted follow-up report that Haven accepts
 * but whose status read lands after the deadline is red although the leg's
 * own report made the record. It needs a slow follow-up near the end of the
 * window, so it is rare, and it is left strict on purpose.
 */

import { parseMerchantSettlement } from '@haven_ai/sdk'
import type { HavenApi, MachinePaymentStatus } from './haven-api.js'
import {
  HostedMcpToolError,
  type HostedMcpClient,
  type HostedReportSettlementEvidenceResult,
  type HostedSettleMcpToolResult,
} from './hosted-mcp.js'

/** The #3888 sweep's candidate floor (`EIP3009_SWEEP_MIN_AGE_SECONDS = 60`). */
export const SWEEP_MIN_AGE_MS = 60_000

/** Margin for runner-to-backend clock rate and request latency. */
export const ATTRIBUTION_MARGIN_MS = 15_000

/**
 * How long after the anchor a record may first be seen and still be
 * attributed to the leg's own report: 60 s − 15 s = 45 s.
 */
export const ATTRIBUTION_WINDOW_MS = SWEEP_MIN_AGE_MS - ATTRIBUTION_MARGIN_MS

/** Status poll interval inside the window. */
export const RECORD_POLL_INTERVAL_MS = 2_000

/** Hosted legs: at most this many follow-up reports while the answer stays retryable. */
export const MAX_FOLLOW_UP_REPORTS = 4

/**
 * The hosted eip3009 settled arm's two no-tool omitted reasons
 * (`settlementEvidenceHandoff`, `packages/mcp-server/src/tools/paid-mcp-completion.ts`),
 * pinned verbatim. Recorded and nothing-posted SHARE the first string, so the
 * status read is what separates those two. Any other omitted reason fails the
 * leg, so a reworded hosted string turns this red rather than passing blind.
 */
export const SETTLED_NO_TOOL_REASON = 'the purchase is settled; no Haven tool follows'
export const REFUSED_HASH_REASON =
  'the merchant settlement hash was refused: it does not match this payment on-chain — do not re-report the same hash'

const REPORT_TOOL = 'haven_report_settlement_evidence'
const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/
const ZERO_HASH_RE = /^0x0+$/
const MCP_PAYMENT_RESPONSE_META_KEY = 'x402/payment-response'

export type SettlementRecordCheck = { ok: true; hash: string; via: string } | { ok: false; detail: string }

/** The attribution deadline for an anchor taken before the funding confirm could happen. */
export function attributionDeadline(anchorMs: number): number {
  return anchorMs + ATTRIBUTION_WINDOW_MS
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const isSettlementHash = (value: unknown): value is string =>
  typeof value === 'string' && TX_HASH_RE.test(value) && !ZERO_HASH_RE.test(value)

/**
 * The merchant settlement hash an SDK-direct leg holds: the paid response's
 * `PAYMENT-RESPONSE` header, decoded with the SDK's own public
 * `parseMerchantSettlement`; when the header carries no transaction, the tool
 * result's `_meta["x402/payment-response"].transaction`. The body is the
 * merchant's JSON-RPC envelope or the bare result the SDK surfaces from SSE,
 * as plain JSON or SSE `data:` lines. `null` when neither source names a
 * well-formed, non-zero transaction.
 */
export function merchantSettlementHashFrom(
  headers: { get(name: string): string | null },
  bodyText: string,
): { hash: string; source: 'PAYMENT-RESPONSE' | '_meta' } | null {
  const fromHeader = parseMerchantSettlement(headers.get('PAYMENT-RESPONSE')).settlementTxHash
  if (isSettlementHash(fromHeader)) return { hash: fromHeader, source: 'PAYMENT-RESPONSE' }

  const candidates: unknown[] = []
  try {
    candidates.push(JSON.parse(bodyText))
  } catch {
    for (const line of bodyText.split('\n')) {
      const idx = line.indexOf('{')
      if (idx === -1) continue
      try {
        candidates.push(JSON.parse(line.slice(idx)))
      } catch {
        /* not a JSON line — keep scanning */
      }
    }
  }
  for (const value of candidates) {
    if (!value || typeof value !== 'object') continue
    const record = value as Record<string, unknown>
    const result = 'jsonrpc' in record ? record.result : record
    const meta = (result as { _meta?: Record<string, unknown> } | undefined)?._meta
    const settlement = meta?.[MCP_PAYMENT_RESPONSE_META_KEY] as { transaction?: unknown } | undefined
    if (isSettlementHash(settlement?.transaction)) return { hash: settlement.transaction, source: '_meta' }
  }
  return null
}

interface RecordRead {
  state: 'recorded' | 'absent' | 'unreadable'
  status?: MachinePaymentStatus
  error?: string
  /** Runner time after the response arrived — the conservative end of the read. */
  observedAt: number
}

async function readRecord(api: HavenApi, paymentId: string): Promise<RecordRead> {
  try {
    const { ok, status, data } = await api.getMachinePaymentStatus(paymentId)
    const observedAt = Date.now()
    if (!ok) return { state: 'unreadable', error: `HTTP ${status}`, observedAt }
    return { state: data?.merchant_settlement_recorded === true ? 'recorded' : 'absent', status: data, observedAt }
  } catch (err) {
    return { state: 'unreadable', error: err instanceof Error ? err.message : String(err), observedAt: Date.now() }
  }
}

/**
 * Read the status until it carries the record or the deadline passes. A
 * record observed after the deadline does not count. With `firstReadDecides`,
 * the first status that answers at all decides: absent there is final.
 */
async function waitForRecord(
  api: HavenApi,
  paymentId: string,
  deadlineMs: number,
  { firstReadDecides }: { firstReadDecides: boolean },
): Promise<{ recorded: true } | { recorded: false; late: boolean; last: RecordRead }> {
  for (;;) {
    const read = await readRecord(api, paymentId)
    if (read.state === 'recorded') {
      return read.observedAt <= deadlineMs ? { recorded: true } : { recorded: false, late: true, last: read }
    }
    if (read.state === 'absent' && firstReadDecides) return { recorded: false, late: false, last: read }
    if (Date.now() + RECORD_POLL_INTERVAL_MS >= deadlineMs) return { recorded: false, late: false, last: read }
    await sleep(RECORD_POLL_INTERVAL_MS)
  }
}

function describeRead(read: RecordRead): string {
  if (read.state === 'unreadable') return `the status read failed (${read.error ?? 'unknown error'})`
  const s = read.status ?? {}
  return `status phase=${s.phase ?? 'none'}, next_action=${s.next_action ?? 'none'}, no merchant_settlement_recorded`
}

const seconds = (ms: number) => `${Math.round(ms / 100) / 10}s`

function lateDetail(paymentId: string, anchorMs: number, read: RecordRead): string {
  return (
    `the merchant settlement of payment ${paymentId} was first seen recorded ${seconds(read.observedAt - anchorMs)} ` +
    `after this leg's anchor, past the ${seconds(ATTRIBUTION_WINDOW_MS)} window in which only this leg's own ` +
    'settlement report can have made the record — a record seen later cannot be told apart from the #3888 sweep, ' +
    'so it does not show the report was recorded'
  )
}

/**
 * The recorded hash must be the transaction this leg proved, in any letter
 * case. A 5xx on the receipts read is re-read once, and only while the window
 * leaves room for it — the same tolerance the status reads give a failed read.
 */
async function recordedHashMatches(
  api: HavenApi,
  paymentId: string,
  merchantHash: string,
  deadlineMs: number,
): Promise<string | null> {
  let { ok, status, data } = await api.listReceipts(25)
  if (!ok && status >= 500 && Date.now() + RECORD_POLL_INTERVAL_MS < deadlineMs) {
    await sleep(RECORD_POLL_INTERVAL_MS)
    ;({ ok, status, data } = await api.listReceipts(25))
  }
  if (!ok) return `GET /machine-payments/receipts returned HTTP ${status} — the recorded hash of payment ${paymentId} is unreadable`
  const row = data?.receipts?.find((receipt) => receipt.payment_id === paymentId)
  if (!row) return `no receipt row for payment ${paymentId} among the agent's newest 25 — the recorded hash is unreadable`
  if (!row.settlement_tx_hash) {
    return `payment ${paymentId} reads merchant_settlement_recorded but its receipt carries no settlement_tx_hash`
  }
  if (row.settlement_tx_hash.toLowerCase() !== merchantHash.toLowerCase()) {
    return (
      `Haven recorded merchant settlement ${row.settlement_tx_hash} for payment ${paymentId}, not ${merchantHash}, ` +
      'the transaction this leg holds — Haven attributed another transaction to this payment'
    )
  }
  return null
}

/**
 * SDK-direct legs (`x402-delegation-3009`, `-grace-resume`): the SDK posted
 * its one settlement report inside the call that returned. Call this right
 * after that call; `anchorMs` is a runner timestamp taken before the funding
 * confirm could happen.
 */
export async function assertSdkSettlementRecorded(
  api: HavenApi,
  args: { paymentId: string; merchantHash: string; anchorMs: number },
): Promise<SettlementRecordCheck> {
  const deadline = attributionDeadline(args.anchorMs)
  const record = await waitForRecord(api, args.paymentId, deadline, { firstReadDecides: false })
  if (!record.recorded) {
    if (record.late) return { ok: false, detail: lateDetail(args.paymentId, args.anchorMs, record.last) }
    return {
      ok: false,
      detail:
        `Haven did not record the merchant settlement of payment ${args.paymentId} within ` +
        `${seconds(ATTRIBUTION_WINDOW_MS)} of the submitting call (${describeRead(record.last)}): the SDK's ` +
        'settlement report was refused, or the backend answered it retryable (the merchant tx was not yet ' +
        'visible to its node) and the SDK, which posts once, did not retry',
    }
  }
  const mismatch = await recordedHashMatches(api, args.paymentId, args.merchantHash, deadline)
  if (mismatch) return { ok: false, detail: mismatch }
  return { ok: true, hash: args.merchantHash, via: "the SDK's own settlement report" }
}

/**
 * Hosted legs (`x402-hosted-mcp-signer`, the catalog leg's eip3009
 * continuation): call this IMMEDIATELY after `haven_settle_mcp_tool` returns,
 * before any other I/O, so on the no-tool arm the status read is taken right
 * at settle-return. It follows the settle's settlement-evidence guidance:
 *
 *   - no tool + {@link SETTLED_NO_TOOL_REASON}: recorded or nothing posted.
 *     The status read right after settle returned decides — a record that
 *     appears only later is not the settle's report.
 *   - no tool + {@link REFUSED_HASH_REASON}: red, whatever the status says.
 *   - `haven_report_settlement_evidence`: the follow-up, with the prefilled
 *     `next_arguments` PLUS the leg's own `payment_header` — the prefilled
 *     arguments never carry it, and an eip3009 report without it is refused
 *     before the chain is read. Retried while retryable, bounded by count and
 *     by the deadline; any refusal is red.
 */
export async function assertHostedSettlementRecorded(
  api: HavenApi,
  hosted: HostedMcpClient,
  args: {
    paymentId: string
    settle: HostedSettleMcpToolResult
    paymentHeader: string
    merchantHash: string
    anchorMs: number
  },
): Promise<SettlementRecordCheck> {
  const { paymentId, settle, anchorMs } = args
  const deadline = attributionDeadline(anchorMs)
  const tool = settle.next_tool_name

  if (tool === undefined || tool === null) {
    const omitted = settle.next_tool_omitted_reason
    if (omitted === REFUSED_HASH_REASON) {
      return {
        ok: false,
        detail: `haven_settle_mcp_tool reports Haven REFUSED the merchant settlement of payment ${paymentId}: "${omitted}"`,
      }
    }
    if (omitted !== SETTLED_NO_TOOL_REASON) {
      return {
        ok: false,
        detail:
          `haven_settle_mcp_tool named no next tool for payment ${paymentId} and an unpinned ` +
          `next_tool_omitted_reason ${JSON.stringify(omitted)} — this leg cannot tell recorded from refused`,
      }
    }
    const record = await waitForRecord(api, paymentId, deadline, { firstReadDecides: true })
    if (!record.recorded) {
      if (record.late) return { ok: false, detail: lateDetail(paymentId, anchorMs, record.last) }
      return {
        ok: false,
        detail:
          `haven_settle_mcp_tool said "${omitted}" for payment ${paymentId} (recorded, or nothing posted), but the ` +
          `status read right after settle returned shows no record (${describeRead(record.last)}): the settle's ` +
          'settlement report was not recorded, or was never posted. A record that appears later is not that report',
      }
    }
    const mismatch = await recordedHashMatches(api, paymentId, args.merchantHash, deadline)
    if (mismatch) return { ok: false, detail: mismatch }
    return { ok: true, hash: args.merchantHash, via: "the settle's own settlement report" }
  }

  if (tool !== REPORT_TOOL) {
    return {
      ok: false,
      detail: `haven_settle_mcp_tool named ${JSON.stringify(tool)} as the next tool for settled payment ${paymentId}; expected none or ${REPORT_TOOL}`,
    }
  }

  // The report-tool arm: retryable, or the missing-proof-header refusal.
  const prefilled = settle.next_arguments ?? {}
  if (prefilled.payment_id !== paymentId) {
    return {
      ok: false,
      detail: `${REPORT_TOOL} next_arguments.payment_id ${JSON.stringify(prefilled.payment_id)} is not payment ${paymentId}`,
    }
  }
  const followUp = { ...prefilled, payment_header: args.paymentHeader }
  for (let attempt = 1; ; attempt++) {
    let report: HostedReportSettlementEvidenceResult
    try {
      report = await hosted.callTool<HostedReportSettlementEvidenceResult>(REPORT_TOOL, followUp)
    } catch (err) {
      if (err instanceof HostedMcpToolError) {
        return {
          ok: false,
          detail: `the follow-up ${REPORT_TOOL} for payment ${paymentId} was refused: ${err.code} — ${err.message.slice(0, 220)}`,
        }
      }
      throw err
    }
    if (report.settled === true) break
    const retryable = report.retryable === true && report.code === 'SETTLEMENT_PENDING'
    if (!retryable) {
      return {
        ok: false,
        detail:
          `Haven refused the follow-up ${REPORT_TOOL} for payment ${paymentId}: ${report.code ?? 'no code'} — ` +
          `${(report.refusal_reason ?? report.reason ?? report.next_tool_omitted_reason ?? 'no reason').slice(0, 220)}`,
      }
    }
    if (attempt >= MAX_FOLLOW_UP_REPORTS || Date.now() + RECORD_POLL_INTERVAL_MS >= deadline) {
      return {
        ok: false,
        detail:
          `the follow-up ${REPORT_TOOL} for payment ${paymentId} was still retryable after ${attempt} attempt(s) ` +
          `inside the ${seconds(ATTRIBUTION_WINDOW_MS)} window — Haven never verified the merchant settlement`,
      }
    }
    await sleep(RECORD_POLL_INTERVAL_MS)
  }

  const record = await waitForRecord(api, paymentId, deadline, { firstReadDecides: false })
  if (!record.recorded) {
    if (record.late) return { ok: false, detail: lateDetail(paymentId, anchorMs, record.last) }
    return {
      ok: false,
      detail:
        `the follow-up ${REPORT_TOOL} for payment ${paymentId} answered settled, but the status never showed the ` +
        `record inside the window (${describeRead(record.last)})`,
    }
  }
  const mismatch = await recordedHashMatches(api, paymentId, args.merchantHash, deadline)
  if (mismatch) return { ok: false, detail: mismatch }
  return { ok: true, hash: args.merchantHash, via: `a follow-up ${REPORT_TOOL} carrying payment_header` }
}
