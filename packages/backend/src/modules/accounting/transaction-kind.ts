/**
 * #4532 — what KIND of transaction a settled payment is.
 *
 * Every settled payment produces one `underlag` receipt, and until this module
 * the receipt carried the payment id, amount, book value, merchant, resource
 * URL and settlement hashes but nothing that said WHAT the payment was. One
 * BikBok gift-card purchase through Bitrefill's plain-HTTP x402 route settled
 * three payments — `POST /x402/invoice/create` (0.002 USDC), `POST
 * /x402/invoice/pay` (0.010) and `GET /x402/invoice/status` (0.001) — and all
 * three rendered identically. Only the middle one is the purchase; the other
 * two are the merchant's per-call API fees. An accountant reading the three
 * documents could not tell them apart.
 *
 * The kind is DERIVED here, server-side, from facts Haven already holds. There
 * is no field an agent can set: `transaction_kind` is accepted on no route, and
 * the derivation reads the stored payment record only. A caller that passes a
 * `transactionKind` of its own on the signals object changes nothing — the
 * function never reads it (pinned by a test).
 *
 * ## The signal ladder
 *
 * Each rung is a fact, strongest first. A rung that does not fire falls
 * through; when none fires the kind is `unknown` — the field is never guessed.
 *
 *  1. `direction` — the feed's own contract (`AccountingEntry.direction`):
 *     `in` is income/refund. The closed enum has no `income` member and an
 *     inbound payment on this rail is a merchant refund, so `in` → `refund`.
 *  2. `directPayment` (#4578) — the direct-payment branch of the entry source
 *     emits this as a literal, so a settled direct payment (`haven_send`,
 *     `POST /payments`) is a movement of funds to an address → `transfer`.
 *     The literal is written by the SQL branch, never read from an intent
 *     column, so no agent-written metadata can set it.
 *  3. the merchant's own document (`merchant_receipts.inline_json`, #956) — an
 *     invoice-shaped body (invoice/order number, line items, seller block) is
 *     the document a merchant issues for a PURCHASE; a body carrying none of
 *     those markers is a bare acknowledgement, i.e. a paid call that delivered
 *     no product → `api_fee`.
 *  4. `machine_payment_evidence.delivery_reference` (#3778) — the agent named a
 *     deliverable ("Bik Bok 5 SEK, order 6ac7…"), so something was bought →
 *     `purchase`.
 *  5. the intent's own metadata (`machine_metadata.mcp_call_context.toolName`,
 *     #1307) — an MCP tool call IS the paid deliverable (one call, one
 *     output), so → `purchase`.
 *  6. the x402 resource route — the last path segment of `resource_url` is the
 *     call verb. A closed PURCHASE vocabulary → `purchase`, a closed FEE
 *     vocabulary → `api_fee`, a closed TRANSFER vocabulary → `transfer`.
 *     Anything else → `unknown`.
 *
 * Rung 6 is the one the issue's three Bitrefill routes pin: `create` and
 * `status` are fee verbs, `pay` is a purchase verb.
 *
 * ## Why the vocabularies are closed
 *
 * A route verb outside the three sets is `unknown`, not a best guess. The issue
 * is explicit that the field must never be guessed, and a wrong `purchase` on a
 * fee call is worse than an honest `unknown`: an accountant can see `unknown`
 * and ask, but cannot see a confident lie. `price` is deliberately absent from
 * the fee set — `https://api.anchor-x402.com/v1/price/token` is a paid data
 * call whose OUTPUT is the price, i.e. a purchase, so the verb is ambiguous and
 * stays `unknown`.
 *
 * ## What this module does NOT do
 *
 * It changes no payment, no settlement, no amount and no custody fact. It
 * classifies a document the feed already produces. Existing stored receipts are
 * untouched: the kind is rendered at push time and nothing re-renders a
 * delivered document.
 */

/** The closed enum. Nothing outside it may reach a receipt or a feed payload. */
export type TransactionKind = 'purchase' | 'api_fee' | 'transfer' | 'refund' | 'unknown'

/** The closed enum, in the order the receipt and the feed document it. */
export const TRANSACTION_KINDS: readonly TransactionKind[] = [
  'purchase',
  'api_fee',
  'transfer',
  'refund',
  'unknown',
]

/**
 * Which rung of the ladder decided the kind. Recorded beside the kind so a
 * reader can tell a route-derived classification from a document-derived one —
 * the two carry different weight, and the feed's audit trail should say which.
 */
export type TransactionKindBasis =
  | 'direction'
  | 'rail'
  | 'merchant_document'
  | 'delivery_reference'
  | 'mcp_tool'
  | 'route'
  | 'none'

/** The stored facts the derivation reads. Every one of them is Haven-held. */
export interface TransactionKindSignals {
  /** `AccountingEntry.direction` — `in` is income/refund. */
  direction: 'out' | 'in'
  /**
   * #4578: the entry source's direct-payment branch emits this as a literal
   * (`TRUE::BOOLEAN` on the `payment_intents` branch, `FALSE::BOOLEAN` on the
   * evidence branch). It is a fact about which branch produced the row, never
   * an intent column, so no agent-written metadata can set it. Optional so
   * every pre-#4578 fixture stays valid; absent reads as `false`.
   */
  directPayment?: boolean
  /** `machine_payment_evidence.resource_url` — the x402 resource the payment paid for. */
  resourceUrl: string | null
  /** `machine_metadata.mcp_call_context.toolName` — the MCP tool the payment called. */
  mcpToolName: string | null
  /** `merchant_receipts.inline_json` — the merchant's own document, when captured. */
  merchantReceiptJson: unknown
  /** `machine_payment_evidence.delivery_reference` — the deliverable the agent named. */
  deliveryReference: string | null
}

export interface TransactionKindVerdict {
  kind: TransactionKind
  basis: TransactionKindBasis
  /** The route/tool tail the classification read (`invoice/pay`, `create_text`), or null. */
  route: string | null
}

/**
 * Route tails that name the call which DELIVERS what was bought. `pay` is the
 * Bitrefill purchase leg; the rest are the same shape under other merchants'
 * naming.
 */
const PURCHASE_VERBS = new Set([
  'pay',
  'purchase',
  'buy',
  'order',
  'checkout',
  'redeem',
  'claim',
  'settle',
  'execute',
  'charge',
  'subscribe',
  'book',
  'reserve',
  'mint',
  'swap',
  'fulfil',
  'fulfill',
  'deliver',
  'issue',
])

/**
 * Route tails that name a per-call auxiliary step — the merchant's API fee.
 * `create`, `status`, `search` and `detail` are the four the issue names; the
 * rest are the same class of call under other merchants' naming.
 */
const FEE_VERBS = new Set([
  'create',
  'status',
  'quote',
  'search',
  'list',
  'detail',
  'details',
  'lookup',
  'check',
  'estimate',
  'preview',
  'info',
  'health',
  'balance',
  'validate',
  'verify',
  'resolve',
  'discover',
  'schema',
  'session',
  'auth',
  'nonce',
  'challenge',
  'catalog',
  'tools',
  'ping',
  'version',
])

/** Route tails that name a movement of funds rather than a purchase. */
const TRANSFER_VERBS = new Set(['send', 'transfer', 'withdraw', 'deposit', 'sweep', 'topup'])

/**
 * Keys that mark a merchant document as an INVOICE rather than an
 * acknowledgement. Normalized (lowercased, non-alphanumerics folded to `_`)
 * before the lookup, so `invoiceNumber`, `invoice_number` and `Invoice-Number`
 * all read the same. Swedish spellings are here because the demo merchant and
 * the Swedish bookkeeping shape use them (`fakturanummer`, `saljare`, `moms_nr`).
 */
const INVOICE_MARKERS = new Set([
  'invoice',
  'invoice_id',
  'invoice_number',
  'invoice_no',
  'invoicenumber',
  'faktura',
  'fakturanummer',
  'order',
  'order_id',
  'order_number',
  'order_no',
  'receipt',
  'receipt_id',
  'kvitto',
  'line_items',
  'lineitems',
  'items',
  'product',
  'products',
  'sku',
  'seller',
  'saljare',
  'total',
  'amount_due',
  'vat',
  'moms',
  'moms_nr',
  'org_nr',
])

/** The accountant-facing label for each kind, as it appears in `(…)`. */
const KIND_LABELS: Record<TransactionKind, string> = {
  purchase: 'purchase',
  api_fee: 'API fee',
  transfer: 'transfer',
  refund: 'refund',
  unknown: 'unclassified',
}

function normalizedKey(key: string): string {
  return key
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

function hasInvoiceMarker(obj: Record<string, unknown>): boolean {
  return Object.keys(obj).some((key) => INVOICE_MARKERS.has(normalizedKey(key)))
}

/**
 * Whether a captured merchant document is an invoice (a product was sold) or a
 * bare acknowledgement (the call delivered nothing). `null` when there is no
 * document to read — the rung then does not fire at all.
 *
 * One level of nesting is inspected: merchants wrap the invoice
 * (`{ data: { fakturanummer, saljare } }`) as often as they send it flat.
 */
export function merchantDocumentShape(
  inlineJson: unknown,
): 'invoice' | 'acknowledgement' | null {
  if (inlineJson == null || typeof inlineJson !== 'object' || Array.isArray(inlineJson)) return null
  const document = inlineJson as Record<string, unknown>
  if (Object.keys(document).length === 0) return null
  if (hasInvoiceMarker(document)) return 'invoice'
  for (const value of Object.values(document)) {
    if (value != null && typeof value === 'object' && !Array.isArray(value)) {
      if (hasInvoiceMarker(value as Record<string, unknown>)) return 'invoice'
    }
  }
  return 'acknowledgement'
}

/** The path segments of a resource URL, or null when it will not parse. */
function routeSegments(resourceUrl: string | null): string[] | null {
  if (!resourceUrl) return null
  let path: string
  try {
    path = new URL(resourceUrl).pathname
  } catch {
    return null
  }
  const segments = path
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
  return segments.length > 0 ? segments : null
}

/**
 * The route the classification reads, and the label the description shows.
 *
 * An MCP payment's "route" is the tool it called — the resource URL is the
 * merchant's single MCP endpoint (`https://mcp.soundside.ai/mcp`), which names
 * nothing. Everything else reads the URL's path, with the last two segments as
 * the label so `invoice/pay` reads as a route rather than a bare verb.
 */
function routeOf(signals: TransactionKindSignals): { tail: string; label: string } | null {
  const tool = signals.mcpToolName?.trim()
  if (tool) return { tail: tool.toLowerCase(), label: tool }
  const segments = routeSegments(signals.resourceUrl)
  if (!segments) return null
  return {
    tail: segments[segments.length - 1].toLowerCase(),
    label: segments.slice(-2).join('/'),
  }
}

/**
 * Derive the transaction kind from the stored payment record. Pure — the
 * caller supplies the facts, this decides nothing else.
 */
export function deriveTransactionKind(signals: TransactionKindSignals): TransactionKindVerdict {
  const route = routeOf(signals)
  const routeLabel = route?.label ?? null

  // Rung 1 — the feed's own direction contract.
  if (signals.direction === 'in') {
    return { kind: 'refund', basis: 'direction', route: routeLabel }
  }

  // Rung 2 — the direct-payment rail (#4578). A settled direct payment
  // (`haven_send`, `POST /payments`) moves funds to an address; it buys no
  // resource, so it is a transfer. The signal is the literal the entry
  // source's direct branch emits, so no agent-written metadata can set it.
  // `route` is null: a direct payment has no route to name, and the
  // description must read exactly `<address> (transfer)`.
  if (signals.directPayment === true) {
    return { kind: 'transfer', basis: 'rail', route: null }
  }

  // Rung 3 — the merchant's own document: an invoice means a product was sold,
  // a bare acknowledgement means the paid call delivered nothing.
  const documentShape = merchantDocumentShape(signals.merchantReceiptJson)
  if (documentShape === 'invoice') {
    return { kind: 'purchase', basis: 'merchant_document', route: routeLabel }
  }
  if (documentShape === 'acknowledgement') {
    return { kind: 'api_fee', basis: 'merchant_document', route: routeLabel }
  }

  // Rung 4 — the agent named a deliverable, so something was bought.
  if (signals.deliveryReference != null && signals.deliveryReference.trim().length > 0) {
    return { kind: 'purchase', basis: 'delivery_reference', route: routeLabel }
  }

  // Rung 5 — an MCP tool call is itself the paid deliverable.
  if (signals.mcpToolName != null && signals.mcpToolName.trim().length > 0) {
    return { kind: 'purchase', basis: 'mcp_tool', route: routeLabel }
  }

  // Rung 6 — the x402 route's call verb, against the three closed vocabularies.
  if (route) {
    if (PURCHASE_VERBS.has(route.tail)) return { kind: 'purchase', basis: 'route', route: route.label }
    if (FEE_VERBS.has(route.tail)) return { kind: 'api_fee', basis: 'route', route: route.label }
    if (TRANSFER_VERBS.has(route.tail)) return { kind: 'transfer', basis: 'route', route: route.label }
  }

  // No rung fired. `unknown` is the honest answer — never a guess.
  return { kind: 'unknown', basis: 'none', route: routeLabel }
}

/** Fold a label to printable ASCII and bound it — the PDF renderer's own constraint. */
function asciiLabel(value: string | null): string | null {
  if (value == null) return null
  const folded = value
    .replace(/[^\x20-\x7e]/g, '?')
    .replace(/\s+/g, ' ')
    .trim()
  return folded.length > 0 ? folded.slice(0, 120) : null
}

/** The resource URL's host, or null when it will not parse. */
function hostOf(resourceUrl: string | null): string | null {
  if (!resourceUrl) return null
  try {
    return new URL(resourceUrl).host || null
  } catch {
    return null
  }
}

/**
 * One human-readable line for the accountant, e.g.
 * `api.bitrefill.com - invoice/pay (purchase)` beside
 * `api.bitrefill.com - invoice/create (API fee)`.
 *
 * Built only from Haven-held facts — the merchant label and the route — and
 * never from merchant free text: the receipt is a filing artifact, so the line
 * has to be reproducible from Haven's own record. ASCII only, because the PDF
 * renderer folds everything else to `?` anyway.
 *
 * The merchant label is the counterparty's name when the entry carries one,
 * else the resource host. `toAccountingEntry` leaves `counterparty.name` null
 * (the seller block fills it at underlag time from the merchant's own invoice),
 * so in practice the host is what renders — the same host on all three
 * Bitrefill receipts, which is what makes them comparable.
 *
 * A direct payment (#4578) has neither a name nor a resource host: it is a
 * movement of funds to an address, so `toAccountingEntry` passes the
 * counterparty's canonical address as the label and the line reads exactly
 * `0x1517…799a (transfer)`. `counterparty.name` stays null — filling it would
 * also change Fortnox's booked supplier and the underlag's `Counterparty`
 * line.
 */
export function transactionDescription(
  kind: TransactionKind,
  merchantName: string | null,
  resourceUrl: string | null,
  route: string | null,
): string {
  const merchant = asciiLabel(merchantName) ?? asciiLabel(hostOf(resourceUrl)) ?? 'Unknown merchant'
  const label = KIND_LABELS[kind]
  const routeLabel = asciiLabel(route)
  return routeLabel ? `${merchant} - ${routeLabel} (${label})` : `${merchant} (${label})`
}
