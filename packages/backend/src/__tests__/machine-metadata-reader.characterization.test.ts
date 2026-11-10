/**
 * Characterization table for `payment_intents.machine_metadata` (#4765).
 *
 * The column is JSONB (`db/migrations/012_machine_payment_metadata.ts:13`), so
 * `pg` hands back a parsed value or null — yet fifteen sites across twelve
 * `modules/` files each carried their own defensive `JSON.parse` branch, and
 * `machine_metadata.settlement_scheme` (the field that selects erc7710 vs the
 * EIP-3009 bridge) was read on eight code lines by five differently-shaped
 * readers. Their parity was held by comment.
 *
 * This table is step 1 of the issue: it records, for each input shape, WHAT
 * EACH CALL SITE READS TODAY — the value its expression evaluates to, or the
 * error it throws. It is a characterization, not a specification: every cell
 * below was recorded from the pre-refactor code, and step 2 (one reader file)
 * must reproduce the same column for the same row. A cell that would change is
 * a behaviour change and is not allowed in this PR.
 *
 * Rows are the input shapes the issue names — an object, null, undefined, a
 * JSON string of an object, malformed JSON, the JSON texts `null` and `5`, the
 * JSON strings `"null"` and `"5"`, an array, the scheme field absent, a
 * non-string scheme, each of the two scheme literals, an unknown scheme string,
 * and the field absent beside a `{child, budget}` settlement state.
 *
 * Columns are the fifteen parse sites and the eight scheme reads. Where a
 * parse site's only consumer is a scheme read, the column is that read; where
 * the consumer compares the field to a literal, the column is the comparison's
 * boolean, because that is what the call site observes.
 *
 * Three cells throw today, all on the JSON text `null`: `mpp/evidence.ts`'s
 * two inline parses dereference the parsed value without a guard, and
 * `x402/eip3009-receipt-settlement.ts:150`'s `metadataOf` is dereferenced
 * without one at its `:434` call site. Those throws are recorded, not fixed.
 */
import { describe, expect, it } from 'vitest'
import {
  parsedMachineMetadata as budgetPrecheckParsedMachineMetadata,
  settlementSchemeOf as budgetPrecheckSettlementSchemeOf,
} from '../modules/mpp/budget-precheck.js'
import { isEip3009BridgePayment, storedReceiptVerdict } from '../modules/mpp/evidence.js'
import { metadataObject as railDispatchMetadataObject } from '../modules/mpp/rail-dispatch.js'
import {
  metadataObject as agentStatusMetadataObject,
  parsedMachineMetadata as agentStatusParsedMachineMetadata,
  settlementSchemeOf as agentStatusSettlementSchemeOf,
} from '../modules/payments/agent-payment-status.js'
import {
  metadataOf as receiptMetadataOf,
  metadataRecord as receiptMetadataRecord,
} from '../modules/x402/eip3009-receipt-settlement.js'
import { metadataOf as evidenceMetadataOf } from '../modules/x402/eip3009-settlement-evidence.js'
import { x402MetadataNetwork } from '../modules/x402/helpers.js'
import { parseObject, settlementSchemeOf as intentByKeySettlementSchemeOf } from '../modules/x402/intent-by-key.js'
import {
  parseMachineMetadata as merchantCallContextParseMachineMetadata,
  storedMcpCallContext,
} from '../modules/x402/merchant-call-context.js'
import { settlementScheme as settleSettlementScheme } from '../modules/x402/settle.js'
import { settlementSchemeOf as observedSettlementSchemeOf } from '../modules/x402/settlement-observed.js'
import { storedPaymentRequiredFromMetadata } from '../modules/x402/sign-context.js'

interface Row {
  name: string
  machineMetadata: unknown
  preparedUserOp?: unknown
}

const ROWS: Row[] = [
  {
    name: 'object',
    machineMetadata: {
      settlement_scheme: 'erc7710',
      network: 'eip155:8453',
      mcp_call_context: { merchantUrl: 'https://merchant.example/pay', toolName: 'pay' },
      payment_required: { resource: { description: 'paid resource' } },
      merchant_settlement_tx_hash: '0xabc',
      merchant_settlement_receipt_verdict: 'verified',
    },
  },
  { name: 'null', machineMetadata: null },
  { name: 'undefined', machineMetadata: undefined },
  {
    name: 'json-string-of-object',
    machineMetadata: '{"settlement_scheme":"eip3009","network":"eip155:8453"}',
  },
  { name: 'malformed-json', machineMetadata: '{"settlement_scheme":' },
  { name: 'json-text-null', machineMetadata: 'null' },
  { name: 'json-text-five', machineMetadata: '5' },
  { name: 'json-string-null', machineMetadata: '"null"' },
  { name: 'json-string-five', machineMetadata: '"5"' },
  { name: 'array', machineMetadata: [{ settlement_scheme: 'erc7710' }] },
  { name: 'scheme-absent', machineMetadata: { network: 'eip155:8453' } },
  { name: 'non-string-scheme', machineMetadata: { settlement_scheme: 5 } },
  { name: 'scheme-erc7710', machineMetadata: { settlement_scheme: 'erc7710' } },
  { name: 'scheme-eip3009', machineMetadata: { settlement_scheme: 'eip3009' } },
  { name: 'scheme-unknown', machineMetadata: { settlement_scheme: 'erc4337' } },
  {
    name: 'scheme-absent-beside-child-budget-state',
    machineMetadata: {},
    preparedUserOp: { child: { delegation: '0xchild' }, budget: { delegation: '0xbudget' } },
  },
]

/** A canonical, comparable rendering of whatever a call site reads. */
function observe(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort()
    return keys.length === 0 ? 'object{}' : `object{${keys.join(',')}}`
  }
  return `${typeof value}:${String(value)}`
}

/** The cell: the value the call site reads, or the error it throws. */
function cell(fn: () => unknown): string {
  try {
    return observe(fn())
  } catch (error) {
    return `throw:${(error as Error).name}`
  }
}

/** The evidence-shaped intent `mpp/evidence.ts` reads its two fields off. */
function evidenceIntent(row: Row) {
  return {
    status: 'confirmed',
    payment_rail: 'x402',
    execution_rail: 'delegation',
    machine_metadata: row.machineMetadata,
  } as never
}

const COLUMNS: Array<{ site: string; probe: (row: Row) => unknown }> = [
  { site: 'mpp/budget-precheck.ts:133', probe: (r) => budgetPrecheckParsedMachineMetadata(r.machineMetadata) },
  { site: 'mpp/budget-precheck.ts:143', probe: (r) => budgetPrecheckSettlementSchemeOf(r.machineMetadata) },
  { site: 'mpp/evidence.ts:296', probe: (r) => isEip3009BridgePayment(evidenceIntent(r)) },
  { site: 'mpp/evidence.ts:317', probe: (r) => storedReceiptVerdict(evidenceIntent(r)) },
  { site: 'mpp/rail-dispatch.ts:52', probe: (r) => railDispatchMetadataObject(r.machineMetadata) },
  { site: 'payments/agent-payment-status.ts:302', probe: (r) => agentStatusMetadataObject(r.machineMetadata) },
  { site: 'payments/agent-payment-status.ts:510', probe: (r) => agentStatusParsedMachineMetadata(r.machineMetadata) },
  { site: 'payments/agent-payment-status.ts:520', probe: (r) => agentStatusSettlementSchemeOf(r.machineMetadata) },
  {
    site: 'x402/eip3009-receipt-settlement.ts:150',
    probe: (r) => receiptMetadataOf({ machine_metadata: r.machineMetadata } as never).merchant_settlement_tx_hash,
  },
  {
    site: 'x402/eip3009-receipt-settlement.ts:517',
    probe: (r) => receiptMetadataRecord({ machine_metadata: r.machineMetadata } as never)?.settlement_scheme === 'eip3009',
  },
  {
    site: 'x402/eip3009-settlement-evidence.ts:106',
    probe: (r) => evidenceMetadataOf({ machine_metadata: r.machineMetadata } as never)?.settlement_scheme === 'eip3009',
  },
  { site: 'x402/helpers.ts:67', probe: (r) => x402MetadataNetwork(r.machineMetadata) },
  { site: 'x402/intent-by-key.ts:22', probe: (r) => parseObject(r.machineMetadata) },
  {
    site: 'x402/intent-by-key.ts:37',
    probe: (r) => intentByKeySettlementSchemeOf({ machine_metadata: r.machineMetadata, prepared_user_op: r.preparedUserOp }),
  },
  { site: 'x402/merchant-call-context.ts:28', probe: (r) => merchantCallContextParseMachineMetadata(r.machineMetadata) },
  { site: 'x402/merchant-call-context.ts:38', probe: (r) => storedMcpCallContext(r.machineMetadata) },
  { site: 'x402/settle.ts:32', probe: (r) => settleSettlementScheme({ machine_metadata: r.machineMetadata } as never) },
  {
    site: 'x402/settlement-observed.ts:120',
    probe: (r) => observedSettlementSchemeOf({ machine_metadata: r.machineMetadata } as never),
  },
  { site: 'x402/sign-context.ts:180', probe: (r) => storedPaymentRequiredFromMetadata(r.machineMetadata) },
]

/** Recorded from the pre-refactor code. Step 2 must reproduce every cell. */
const EXPECTED: Record<string, Record<string, string>> = {
  "object": {
    "mpp/budget-precheck.ts:133": "object{mcp_call_context,merchant_settlement_receipt_verdict,merchant_settlement_tx_hash,network,payment_required,settlement_scheme}",
    "mpp/budget-precheck.ts:143": "string:erc7710",
    "mpp/evidence.ts:296": "boolean:false",
    "mpp/evidence.ts:317": "string:verified",
    "mpp/rail-dispatch.ts:52": "object{mcp_call_context,merchant_settlement_receipt_verdict,merchant_settlement_tx_hash,network,payment_required,settlement_scheme}",
    "payments/agent-payment-status.ts:302": "object{mcp_call_context,merchant_settlement_receipt_verdict,merchant_settlement_tx_hash,network,payment_required,settlement_scheme}",
    "payments/agent-payment-status.ts:510": "object{mcp_call_context,merchant_settlement_receipt_verdict,merchant_settlement_tx_hash,network,payment_required,settlement_scheme}",
    "payments/agent-payment-status.ts:520": "string:erc7710",
    "x402/eip3009-receipt-settlement.ts:150": "string:0xabc",
    "x402/eip3009-receipt-settlement.ts:517": "boolean:false",
    "x402/eip3009-settlement-evidence.ts:106": "boolean:false",
    "x402/helpers.ts:67": "string:eip155:8453",
    "x402/intent-by-key.ts:22": "object{mcp_call_context,merchant_settlement_receipt_verdict,merchant_settlement_tx_hash,network,payment_required,settlement_scheme}",
    "x402/intent-by-key.ts:37": "string:erc7710",
    "x402/merchant-call-context.ts:28": "object{mcp_call_context,merchant_settlement_receipt_verdict,merchant_settlement_tx_hash,network,payment_required,settlement_scheme}",
    "x402/merchant-call-context.ts:38": "object{merchantUrl,toolName}",
    "x402/settle.ts:32": "string:erc7710",
    "x402/settlement-observed.ts:120": "string:erc7710",
    "x402/sign-context.ts:180": "object{resource}",
  },
  "null": {
    "mpp/budget-precheck.ts:133": "null",
    "mpp/budget-precheck.ts:143": "null",
    "mpp/evidence.ts:296": "boolean:false",
    "mpp/evidence.ts:317": "null",
    "mpp/rail-dispatch.ts:52": "object{}",
    "payments/agent-payment-status.ts:302": "object{}",
    "payments/agent-payment-status.ts:510": "null",
    "payments/agent-payment-status.ts:520": "null",
    "x402/eip3009-receipt-settlement.ts:150": "undefined",
    "x402/eip3009-receipt-settlement.ts:517": "boolean:false",
    "x402/eip3009-settlement-evidence.ts:106": "boolean:false",
    "x402/helpers.ts:67": "null",
    "x402/intent-by-key.ts:22": "null",
    "x402/intent-by-key.ts:37": "null",
    "x402/merchant-call-context.ts:28": "null",
    "x402/merchant-call-context.ts:38": "null",
    "x402/settle.ts:32": "null",
    "x402/settlement-observed.ts:120": "null",
    "x402/sign-context.ts:180": "null",
  },
  "undefined": {
    "mpp/budget-precheck.ts:133": "null",
    "mpp/budget-precheck.ts:143": "null",
    "mpp/evidence.ts:296": "boolean:false",
    "mpp/evidence.ts:317": "null",
    "mpp/rail-dispatch.ts:52": "object{}",
    "payments/agent-payment-status.ts:302": "object{}",
    "payments/agent-payment-status.ts:510": "null",
    "payments/agent-payment-status.ts:520": "null",
    "x402/eip3009-receipt-settlement.ts:150": "undefined",
    "x402/eip3009-receipt-settlement.ts:517": "boolean:false",
    "x402/eip3009-settlement-evidence.ts:106": "boolean:false",
    "x402/helpers.ts:67": "null",
    "x402/intent-by-key.ts:22": "null",
    "x402/intent-by-key.ts:37": "null",
    "x402/merchant-call-context.ts:28": "null",
    "x402/merchant-call-context.ts:38": "null",
    "x402/settle.ts:32": "null",
    "x402/settlement-observed.ts:120": "null",
    "x402/sign-context.ts:180": "null",
  },
  "json-string-of-object": {
    "mpp/budget-precheck.ts:133": "object{network,settlement_scheme}",
    "mpp/budget-precheck.ts:143": "string:eip3009",
    "mpp/evidence.ts:296": "boolean:true",
    "mpp/evidence.ts:317": "null",
    "mpp/rail-dispatch.ts:52": "object{network,settlement_scheme}",
    "payments/agent-payment-status.ts:302": "object{network,settlement_scheme}",
    "payments/agent-payment-status.ts:510": "object{network,settlement_scheme}",
    "payments/agent-payment-status.ts:520": "string:eip3009",
    "x402/eip3009-receipt-settlement.ts:150": "undefined",
    "x402/eip3009-receipt-settlement.ts:517": "boolean:true",
    "x402/eip3009-settlement-evidence.ts:106": "boolean:true",
    "x402/helpers.ts:67": "string:eip155:8453",
    "x402/intent-by-key.ts:22": "object{network,settlement_scheme}",
    "x402/intent-by-key.ts:37": "string:eip3009",
    "x402/merchant-call-context.ts:28": "object{network,settlement_scheme}",
    "x402/merchant-call-context.ts:38": "null",
    "x402/settle.ts:32": "string:eip3009",
    "x402/settlement-observed.ts:120": "string:eip3009",
    "x402/sign-context.ts:180": "null",
  },
  "malformed-json": {
    "mpp/budget-precheck.ts:133": "null",
    "mpp/budget-precheck.ts:143": "null",
    "mpp/evidence.ts:296": "boolean:false",
    "mpp/evidence.ts:317": "null",
    "mpp/rail-dispatch.ts:52": "object{}",
    "payments/agent-payment-status.ts:302": "object{}",
    "payments/agent-payment-status.ts:510": "null",
    "payments/agent-payment-status.ts:520": "null",
    "x402/eip3009-receipt-settlement.ts:150": "undefined",
    "x402/eip3009-receipt-settlement.ts:517": "boolean:false",
    "x402/eip3009-settlement-evidence.ts:106": "boolean:false",
    "x402/helpers.ts:67": "null",
    "x402/intent-by-key.ts:22": "null",
    "x402/intent-by-key.ts:37": "null",
    "x402/merchant-call-context.ts:28": "null",
    "x402/merchant-call-context.ts:38": "null",
    "x402/settle.ts:32": "null",
    "x402/settlement-observed.ts:120": "null",
    "x402/sign-context.ts:180": "null",
  },
  "json-text-null": {
    "mpp/budget-precheck.ts:133": "null",
    "mpp/budget-precheck.ts:143": "null",
    "mpp/evidence.ts:296": "throw:TypeError",
    "mpp/evidence.ts:317": "throw:TypeError",
    "mpp/rail-dispatch.ts:52": "object{}",
    "payments/agent-payment-status.ts:302": "object{}",
    "payments/agent-payment-status.ts:510": "null",
    "payments/agent-payment-status.ts:520": "null",
    "x402/eip3009-receipt-settlement.ts:150": "throw:TypeError",
    "x402/eip3009-receipt-settlement.ts:517": "boolean:false",
    "x402/eip3009-settlement-evidence.ts:106": "boolean:false",
    "x402/helpers.ts:67": "null",
    "x402/intent-by-key.ts:22": "null",
    "x402/intent-by-key.ts:37": "null",
    "x402/merchant-call-context.ts:28": "null",
    "x402/merchant-call-context.ts:38": "null",
    "x402/settle.ts:32": "null",
    "x402/settlement-observed.ts:120": "null",
    "x402/sign-context.ts:180": "null",
  },
  "json-text-five": {
    "mpp/budget-precheck.ts:133": "number:5",
    "mpp/budget-precheck.ts:143": "null",
    "mpp/evidence.ts:296": "boolean:false",
    "mpp/evidence.ts:317": "null",
    "mpp/rail-dispatch.ts:52": "object{}",
    "payments/agent-payment-status.ts:302": "object{}",
    "payments/agent-payment-status.ts:510": "number:5",
    "payments/agent-payment-status.ts:520": "null",
    "x402/eip3009-receipt-settlement.ts:150": "undefined",
    "x402/eip3009-receipt-settlement.ts:517": "boolean:false",
    "x402/eip3009-settlement-evidence.ts:106": "boolean:false",
    "x402/helpers.ts:67": "null",
    "x402/intent-by-key.ts:22": "null",
    "x402/intent-by-key.ts:37": "null",
    "x402/merchant-call-context.ts:28": "number:5",
    "x402/merchant-call-context.ts:38": "null",
    "x402/settle.ts:32": "null",
    "x402/settlement-observed.ts:120": "null",
    "x402/sign-context.ts:180": "null",
  },
  "json-string-null": {
    "mpp/budget-precheck.ts:133": "string:null",
    "mpp/budget-precheck.ts:143": "null",
    "mpp/evidence.ts:296": "boolean:false",
    "mpp/evidence.ts:317": "null",
    "mpp/rail-dispatch.ts:52": "object{}",
    "payments/agent-payment-status.ts:302": "object{}",
    "payments/agent-payment-status.ts:510": "string:null",
    "payments/agent-payment-status.ts:520": "null",
    "x402/eip3009-receipt-settlement.ts:150": "undefined",
    "x402/eip3009-receipt-settlement.ts:517": "boolean:false",
    "x402/eip3009-settlement-evidence.ts:106": "boolean:false",
    "x402/helpers.ts:67": "null",
    "x402/intent-by-key.ts:22": "null",
    "x402/intent-by-key.ts:37": "null",
    "x402/merchant-call-context.ts:28": "string:null",
    "x402/merchant-call-context.ts:38": "null",
    "x402/settle.ts:32": "null",
    "x402/settlement-observed.ts:120": "null",
    "x402/sign-context.ts:180": "null",
  },
  "json-string-five": {
    "mpp/budget-precheck.ts:133": "string:5",
    "mpp/budget-precheck.ts:143": "null",
    "mpp/evidence.ts:296": "boolean:false",
    "mpp/evidence.ts:317": "null",
    "mpp/rail-dispatch.ts:52": "object{}",
    "payments/agent-payment-status.ts:302": "object{}",
    "payments/agent-payment-status.ts:510": "string:5",
    "payments/agent-payment-status.ts:520": "null",
    "x402/eip3009-receipt-settlement.ts:150": "undefined",
    "x402/eip3009-receipt-settlement.ts:517": "boolean:false",
    "x402/eip3009-settlement-evidence.ts:106": "boolean:false",
    "x402/helpers.ts:67": "null",
    "x402/intent-by-key.ts:22": "null",
    "x402/intent-by-key.ts:37": "null",
    "x402/merchant-call-context.ts:28": "string:5",
    "x402/merchant-call-context.ts:38": "null",
    "x402/settle.ts:32": "null",
    "x402/settlement-observed.ts:120": "null",
    "x402/sign-context.ts:180": "null",
  },
  "array": {
    "mpp/budget-precheck.ts:133": "array",
    "mpp/budget-precheck.ts:143": "null",
    "mpp/evidence.ts:296": "boolean:false",
    "mpp/evidence.ts:317": "null",
    "mpp/rail-dispatch.ts:52": "object{}",
    "payments/agent-payment-status.ts:302": "object{}",
    "payments/agent-payment-status.ts:510": "array",
    "payments/agent-payment-status.ts:520": "null",
    "x402/eip3009-receipt-settlement.ts:150": "undefined",
    "x402/eip3009-receipt-settlement.ts:517": "boolean:false",
    "x402/eip3009-settlement-evidence.ts:106": "boolean:false",
    "x402/helpers.ts:67": "null",
    "x402/intent-by-key.ts:22": "array",
    "x402/intent-by-key.ts:37": "null",
    "x402/merchant-call-context.ts:28": "array",
    "x402/merchant-call-context.ts:38": "null",
    "x402/settle.ts:32": "null",
    "x402/settlement-observed.ts:120": "null",
    "x402/sign-context.ts:180": "null",
  },
  "scheme-absent": {
    "mpp/budget-precheck.ts:133": "object{network}",
    "mpp/budget-precheck.ts:143": "null",
    "mpp/evidence.ts:296": "boolean:false",
    "mpp/evidence.ts:317": "null",
    "mpp/rail-dispatch.ts:52": "object{network}",
    "payments/agent-payment-status.ts:302": "object{network}",
    "payments/agent-payment-status.ts:510": "object{network}",
    "payments/agent-payment-status.ts:520": "null",
    "x402/eip3009-receipt-settlement.ts:150": "undefined",
    "x402/eip3009-receipt-settlement.ts:517": "boolean:false",
    "x402/eip3009-settlement-evidence.ts:106": "boolean:false",
    "x402/helpers.ts:67": "string:eip155:8453",
    "x402/intent-by-key.ts:22": "object{network}",
    "x402/intent-by-key.ts:37": "null",
    "x402/merchant-call-context.ts:28": "object{network}",
    "x402/merchant-call-context.ts:38": "null",
    "x402/settle.ts:32": "null",
    "x402/settlement-observed.ts:120": "null",
    "x402/sign-context.ts:180": "null",
  },
  "non-string-scheme": {
    "mpp/budget-precheck.ts:133": "object{settlement_scheme}",
    "mpp/budget-precheck.ts:143": "null",
    "mpp/evidence.ts:296": "boolean:false",
    "mpp/evidence.ts:317": "null",
    "mpp/rail-dispatch.ts:52": "object{settlement_scheme}",
    "payments/agent-payment-status.ts:302": "object{settlement_scheme}",
    "payments/agent-payment-status.ts:510": "object{settlement_scheme}",
    "payments/agent-payment-status.ts:520": "null",
    "x402/eip3009-receipt-settlement.ts:150": "undefined",
    "x402/eip3009-receipt-settlement.ts:517": "boolean:false",
    "x402/eip3009-settlement-evidence.ts:106": "boolean:false",
    "x402/helpers.ts:67": "null",
    "x402/intent-by-key.ts:22": "object{settlement_scheme}",
    "x402/intent-by-key.ts:37": "null",
    "x402/merchant-call-context.ts:28": "object{settlement_scheme}",
    "x402/merchant-call-context.ts:38": "null",
    "x402/settle.ts:32": "null",
    "x402/settlement-observed.ts:120": "null",
    "x402/sign-context.ts:180": "null",
  },
  "scheme-erc7710": {
    "mpp/budget-precheck.ts:133": "object{settlement_scheme}",
    "mpp/budget-precheck.ts:143": "string:erc7710",
    "mpp/evidence.ts:296": "boolean:false",
    "mpp/evidence.ts:317": "null",
    "mpp/rail-dispatch.ts:52": "object{settlement_scheme}",
    "payments/agent-payment-status.ts:302": "object{settlement_scheme}",
    "payments/agent-payment-status.ts:510": "object{settlement_scheme}",
    "payments/agent-payment-status.ts:520": "string:erc7710",
    "x402/eip3009-receipt-settlement.ts:150": "undefined",
    "x402/eip3009-receipt-settlement.ts:517": "boolean:false",
    "x402/eip3009-settlement-evidence.ts:106": "boolean:false",
    "x402/helpers.ts:67": "null",
    "x402/intent-by-key.ts:22": "object{settlement_scheme}",
    "x402/intent-by-key.ts:37": "string:erc7710",
    "x402/merchant-call-context.ts:28": "object{settlement_scheme}",
    "x402/merchant-call-context.ts:38": "null",
    "x402/settle.ts:32": "string:erc7710",
    "x402/settlement-observed.ts:120": "string:erc7710",
    "x402/sign-context.ts:180": "null",
  },
  "scheme-eip3009": {
    "mpp/budget-precheck.ts:133": "object{settlement_scheme}",
    "mpp/budget-precheck.ts:143": "string:eip3009",
    "mpp/evidence.ts:296": "boolean:true",
    "mpp/evidence.ts:317": "null",
    "mpp/rail-dispatch.ts:52": "object{settlement_scheme}",
    "payments/agent-payment-status.ts:302": "object{settlement_scheme}",
    "payments/agent-payment-status.ts:510": "object{settlement_scheme}",
    "payments/agent-payment-status.ts:520": "string:eip3009",
    "x402/eip3009-receipt-settlement.ts:150": "undefined",
    "x402/eip3009-receipt-settlement.ts:517": "boolean:true",
    "x402/eip3009-settlement-evidence.ts:106": "boolean:true",
    "x402/helpers.ts:67": "null",
    "x402/intent-by-key.ts:22": "object{settlement_scheme}",
    "x402/intent-by-key.ts:37": "string:eip3009",
    "x402/merchant-call-context.ts:28": "object{settlement_scheme}",
    "x402/merchant-call-context.ts:38": "null",
    "x402/settle.ts:32": "string:eip3009",
    "x402/settlement-observed.ts:120": "string:eip3009",
    "x402/sign-context.ts:180": "null",
  },
  "scheme-unknown": {
    "mpp/budget-precheck.ts:133": "object{settlement_scheme}",
    "mpp/budget-precheck.ts:143": "string:erc4337",
    "mpp/evidence.ts:296": "boolean:false",
    "mpp/evidence.ts:317": "null",
    "mpp/rail-dispatch.ts:52": "object{settlement_scheme}",
    "payments/agent-payment-status.ts:302": "object{settlement_scheme}",
    "payments/agent-payment-status.ts:510": "object{settlement_scheme}",
    "payments/agent-payment-status.ts:520": "string:erc4337",
    "x402/eip3009-receipt-settlement.ts:150": "undefined",
    "x402/eip3009-receipt-settlement.ts:517": "boolean:false",
    "x402/eip3009-settlement-evidence.ts:106": "boolean:false",
    "x402/helpers.ts:67": "null",
    "x402/intent-by-key.ts:22": "object{settlement_scheme}",
    "x402/intent-by-key.ts:37": "null",
    "x402/merchant-call-context.ts:28": "object{settlement_scheme}",
    "x402/merchant-call-context.ts:38": "null",
    "x402/settle.ts:32": "string:erc4337",
    "x402/settlement-observed.ts:120": "string:erc4337",
    "x402/sign-context.ts:180": "null",
  },
  "scheme-absent-beside-child-budget-state": {
    "mpp/budget-precheck.ts:133": "object{}",
    "mpp/budget-precheck.ts:143": "null",
    "mpp/evidence.ts:296": "boolean:false",
    "mpp/evidence.ts:317": "null",
    "mpp/rail-dispatch.ts:52": "object{}",
    "payments/agent-payment-status.ts:302": "object{}",
    "payments/agent-payment-status.ts:510": "object{}",
    "payments/agent-payment-status.ts:520": "null",
    "x402/eip3009-receipt-settlement.ts:150": "undefined",
    "x402/eip3009-receipt-settlement.ts:517": "boolean:false",
    "x402/eip3009-settlement-evidence.ts:106": "boolean:false",
    "x402/helpers.ts:67": "null",
    "x402/intent-by-key.ts:22": "object{}",
    "x402/intent-by-key.ts:37": "string:erc7710",
    "x402/merchant-call-context.ts:28": "object{}",
    "x402/merchant-call-context.ts:38": "null",
    "x402/settle.ts:32": "null",
    "x402/settlement-observed.ts:120": "null",
    "x402/sign-context.ts:180": "null",
  },
}

describe('machine_metadata call sites — characterization (#4765)', () => {
  for (const row of ROWS) {
    it(`row: ${row.name}`, () => {
      const actual: Record<string, string> = {}
      for (const column of COLUMNS) actual[column.site] = cell(() => column.probe(row))
      expect(actual).toEqual(EXPECTED[row.name])
    })
  }
})
