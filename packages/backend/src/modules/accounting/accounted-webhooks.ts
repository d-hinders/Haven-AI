/**
 * The Accounted webhook orchestration (#3019, epic #3016 slice 3) — the
 * connect-time registration, the disconnect teardown, and the envelope
 * verification the inbound route calls.
 *
 * ## Registration is all-or-nothing
 *
 * A subscription is ONE event type, so connect creates THREE
 * (`journal_entry.committed`, `period.locked`, `document.uploaded`), each
 * answering its HMAC signing secret exactly once. If any create fails, the
 * ones already created are DELETED (best effort, including a list sweep for
 * the orphan a lost response leaves — the create answer carrying the secret
 * is the only record of it, and a half-subscribed connection is the failure
 * mode the issue rules out) and the caller reports the connection as
 * `needs_attention` with the reason. Never half-subscribed.
 *
 * ## The secrets blob widens
 *
 * `ApiKeySecrets` carries the three `(subscription_id, event_type, secret)`
 * triples as `webhooks`, next to `apiKey`. Everything is
 * encrypted together with the key (`infra/secrets.ts`); no secret is ever
 * logged or echoed.
 *
 * ## Disconnect deletes all three, best effort
 *
 * A failed delete never blocks the disconnect (the user's row is cleared
 * regardless — `connections.ts` owns that); the runbook's dead-subscription
 * section covers the residue.
 */

import {
  ACCOUNTED_WEBHOOK_EVENT_TYPES,
  accountedListWebhooks,
  accountedCreateWebhookSubscription,
  accountedDeleteWebhookSubscription,
  type AccountedWebhookEventType,
} from './accounted-client.js'
import { webhookCallbackUrl } from '../../infra/repositories/accounting-connections.js'
import { createHmac, timingSafeEqual } from 'node:crypto'

/** One `(subscription_id, event_type, secret)` triple, stored in the secrets blob. */
export interface AccountedWebhookSubscriptionSecret {
  subscriptionId: string
  eventType: AccountedWebhookEventType
  secret: string
}

/**
 * Register the three subscriptions against `companyId` with the given
 * callback origin. Returns the triples to store, in creation order. Throws
 * `AccountedWebhookRegistrationError` (after rolling back) when any create
 * fails.
 */
export async function registerAccountedWebhooks(input: {
  apiKey: string
  companyId: string
  /** The public origin the callback URL is built on (`HAVEN_API_URL`-style). */
  apiOrigin: string
  token: string
  fetchImpl: typeof fetch
}): Promise<AccountedWebhookSubscriptionSecret[]> {
  const callbackUrl = webhookCallbackUrl(input.apiOrigin, input.token)
  const created: AccountedWebhookSubscriptionSecret[] = []
  try {
    for (const eventType of ACCOUNTED_WEBHOOK_EVENT_TYPES) {
      const webhook = await accountedCreateWebhookSubscription({
        apiKey: input.apiKey,
        companyId: input.companyId,
        eventType,
        callbackUrl,
        name: `Haven — ${eventType}`,
        fetchImpl: input.fetchImpl,
      })
      created.push({
        subscriptionId: webhook.id,
        eventType,
        // Consumed here and never surfaced again: the caller stores the triple
        // encrypted, and `webhook.secret` on the returned object is dropped
        // with it.
        secret: webhook.secret as string,
      })
    }
  } catch (err) {
    // All-or-nothing: delete what was created, then rethrow the reason.
    await rollbackSubscriptions({
      apiKey: input.apiKey,
      companyId: input.companyId,
      createdIds: created.map((c) => c.subscriptionId),
      callbackUrl,
      fetchImpl: input.fetchImpl,
    }).catch(() => {
      // The rollback is best effort BY DESIGN; the registration failure is
      // the thing being reported. Orphans (a lost create response) are swept
      // by URL below, also best effort.
    })
    throw new AccountedWebhookRegistrationError(
      `Accounted webhook registration failed: ${err instanceof Error ? err.message : String(err)}`,
      err,
    )
  }
  return created
}

export class AccountedWebhookRegistrationError extends Error {
  readonly name = 'AccountedWebhookRegistrationError'
  constructor(
    message: string,
    public readonly cause: unknown,
  ) {
    super(message)
  }
}

/**
 * The rollback: DELETE each created id, then sweep the list for any OTHER
 * subscription on the same callback URL (an orphan whose create response —
 * and therefore its secret — never arrived). Delete failures inside the sweep
 * are swallowed: the goal state is "nothing half-subscribed", and the runbook
 * names the manual command when the provider is down.
 */
async function rollbackSubscriptions(input: {
  apiKey: string
  companyId: string
  createdIds: string[]
  callbackUrl: string
  fetchImpl: typeof fetch
}): Promise<void> {
  for (const id of input.createdIds) {
    await accountedDeleteWebhookSubscription({
      apiKey: input.apiKey,
      companyId: input.companyId,
      webhookId: id,
      fetchImpl: input.fetchImpl,
    }).catch(() => undefined)
  }
  // The orphan sweep: list (webhooks:manage), match OUR callback URL, delete.
  // A list failure is swallowed too — the sweep is a repair, not a gate.
  const list = await accountedListWebhooks({
    apiKey: input.apiKey,
    companyId: input.companyId,
    fetchImpl: input.fetchImpl,
  }).catch(() => [] as Awaited<ReturnType<typeof accountedListWebhooks>>)
  for (const webhook of list) {
    if (webhook.webhook_url === input.callbackUrl && !input.createdIds.includes(webhook.id)) {
      await accountedDeleteWebhookSubscription({
        apiKey: input.apiKey,
        companyId: input.companyId,
        webhookId: webhook.id,
        fetchImpl: input.fetchImpl,
      }).catch(() => undefined)
    }
  }
}

/**
 * Disconnect: delete all three subscriptions, best effort. Never throws — a
 * provider outage must not block the user from disconnecting (the local
 * secrets are cleared by the caller regardless; the runbook's
 * dead-subscription section covers subscriptions left behind).
 */
export async function deleteAccountedWebhooks(input: {
  apiKey: string
  companyId: string
  subscriptions: readonly AccountedWebhookSubscriptionSecret[]
  fetchImpl: typeof fetch
}): Promise<{ deleted: number; failed: number }> {
  let deleted = 0
  let failed = 0
  for (const sub of input.subscriptions) {
    try {
      await accountedDeleteWebhookSubscription({
        apiKey: input.apiKey,
        companyId: input.companyId,
        webhookId: sub.subscriptionId,
        fetchImpl: input.fetchImpl,
      })
      deleted += 1
    } catch {
      failed += 1
    }
  }
  return { deleted, failed }
}

// ── Envelope verification ────────────────────────────────────────────────────
//
// `X-Gnubok-Signature: t=<unix-seconds>,v1=<hex>`; the signed payload is
// `${t}.${rawBody}` with HMAC-SHA256 over the subscription's secret — byte
// for byte the provider's reference implementation (docs § Verifying
// signatures). The RAW body is what is hashed: re-serialising JSON produces
// different bytes and the signature would not match.

/** The `t` header older than this is refused (the provider's recommended replay window). */
export const ACCOUNTED_WEBHOOK_TIMESTAMP_TOLERANCE_MS = 5 * 60_000

export type SignatureVerdict =
  | { ok: true }
  | { ok: false; reason: 'malformed_header' | 'bad_signature' | 'stale_timestamp' }

/** Parse `t=<unix>,v1=<hex>` into its two parts, or null when malformed. */
function parseSignatureHeader(header: string): { t: string; v1: string } | null {
  const parts = new Map<string, string>()
  for (const pair of header.split(',')) {
    const eq = pair.indexOf('=')
    if (eq <= 0) return null
    parts.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim())
  }
  const t = parts.get('t')
  const v1 = parts.get('v1')
  if (!t || !v1 || !/^\d+$/.test(t) || !/^[0-9a-f]{64}$/.test(v1)) return null
  return { t, v1 }
}

/**
 * Verify one delivery's signature. `nowMs` is injectable so tests can age a
 * timestamp past the window without sleeping.
 */
export function verifyAccountedSignature(input: {
  rawBody: Buffer
  header: string | undefined
  secret: string
  nowMs: number
}): SignatureVerdict {
  if (!input.header) return { ok: false, reason: 'malformed_header' }
  const parsed = parseSignatureHeader(input.header)
  if (!parsed) return { ok: false, reason: 'malformed_header' }
  const age = input.nowMs - Number(parsed.t) * 1000
  if (!Number.isFinite(age) || age > ACCOUNTED_WEBHOOK_TIMESTAMP_TOLERANCE_MS) {
    return { ok: false, reason: 'stale_timestamp' }
  }
  const expected = createHmac('sha256', input.secret).update(`${parsed.t}.${input.rawBody.toString('utf8')}`).digest('hex')
  const a = Buffer.from(parsed.v1, 'hex')
  const b = Buffer.from(expected, 'hex')
  // timingSafeEqual throws on length mismatch; both sides are 32 bytes by
  // construction (the header regex demanded 64 hex chars, sha256 hex is 64).
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: 'bad_signature' }
  return { ok: true }
}

// ── Processing (#3019 item 4) ────────────────────────────────────────────────
//
// Probe-first: whether a *booked* state can be derived is unknown until a
// real `journal_entry.committed` payload is seen (no per-event payload schema
// is published). So this slice RECORDS, it does not decide:
//
//  - `document.uploaded` → if the payload's document id matches a sync row's
//    ref, that sync row is delivery-confirmed (a counter; no wire change).
//  - `journal_entry.committed` → the redacted `data.object` is stored on the
//    deliveries row (the probe's raw material) and counted — NO state change
//    on the sync row in this slice.
//  - `period.locked` → counted only.
//  - unknown types (incl. `webhook.test`) → counted as unknown.
//
// Redaction is a DENYLIST (the CASP shard says so, and says what that does
// not guarantee): the stored object is the envelope's `data.object` with the
// named sensitive keys dropped and the whole thing size-capped. Nothing about a user, a payment
// or an amount is claimed from it anywhere in this slice.

/** Keys never stored from a `data.object`, however the provider shapes it. */
const REDACTED_OBJECT_KEYS = new Set([
  'attachments',
  'attachment_urls',
  'download_url',
  'presigned_url',
  'url',
  'urls',
  'file',
  'file_content',
  'content',
  'notes',
  'comment',
  'description',
  'metadata',
])

/** Cap on the stored redacted object's JSON size; anything larger stores nothing. */
export const ACCOUNTED_WEBHOOK_STORED_PAYLOAD_MAX_BYTES = 16_384

/**
 * The redacted copy of a `journal_entry.committed` `data.object`, or null
 * when nothing may be stored (non-object, everything redacted, or over the
 * cap). Shallow-by-design: one level of keys is what the probe needs, and a
 * deep walk would need its own policy for nested objects this slice has
 * never seen — the raw payload lands on the epic FIRST, the denylist is
 * widened from evidence, not imagination.
 */
export function redactAccountedWebhookObject(object: Record<string, unknown>): Record<string, unknown> | null {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(object)) {
    if (REDACTED_OBJECT_KEYS.has(key)) continue
    out[key] = value
  }
  if (Object.keys(out).length === 0) return null
  if (Buffer.byteLength(JSON.stringify(out), 'utf8') > ACCOUNTED_WEBHOOK_STORED_PAYLOAD_MAX_BYTES) return null
  return out
}

/**
 * The per-type processing AFTER the dedupe row is written. Returns the
 * counter name the route reports. The document match reads the sync ledger
 * for ONE USER's row whose `external_ref` carries the payload's document id
 * (`userId` comes from the connection row the capability token resolved —
 * the scoping keeps the confirmation write inside that user's ledger, PR
 * #3196 review S1); a read failure is swallowed into the generic `processed`
 * count — the confirmation is an optimisation over the recorded delivery,
 * never a correctness gate (the row and the counter are the durable facts).
 */
export async function processAccountedWebhook(input: {
  eventType: string | null
  object: Record<string, unknown> | null
  /** The connection row's owner — scopes the document confirmation. */
  userId: string
}): Promise<string> {
  if (input.eventType === 'journal_entry.committed') {
    // Stored on the deliveries row by the route (payload), counted here. The
    // follow-up slice reads the recorded payload for document ids; this
    // slice deliberately changes no sync-row state.
    return 'processed_journal_entry_committed'
  }
  if (input.eventType === 'period.locked') return 'processed_period_locked'
  if (input.eventType === 'document.uploaded') {
    const documentId = extractDocumentId(input.object)
    if (documentId) {
      try {
        const { confirmAccountedDocumentDelivery } = await import('../../infra/repositories/accounting-feed-syncs.js')
        const confirmed = await confirmAccountedDocumentDelivery(input.userId, documentId)
        if (confirmed) return 'confirmed_document_uploaded'
      } catch {
        // Fall through to the plain processed count.
      }
    }
    return 'processed_document_uploaded'
  }
  return 'unknown_type'
}

/** The document id a `document.uploaded` payload names, wherever it sits at top level. */
function extractDocumentId(object: Record<string, unknown> | null): string | null {
  if (!object) return null
  const candidate = object.document_id ?? object.id ?? (object.document as Record<string, unknown> | undefined)?.id
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : null
}

// ── The delivery context the route reads (#3019 item 3) ──────────────────────
//
// Header coercion and envelope interpretation live HERE, not in the route
// file: the route module carries no hand-rolled `typeof` ladders for the
// request-schemas gauge to count — the spec carries the route's shape (the
// validation plugin runs it in shadow mode: the module is not in
// `enforcedModules`, and the body is a raw Buffer the HMAC needs verbatim,
// so the coercion below is the enforcement), and what the wire "means" is
// the module's vocabulary.

/** The delivery envelope, per docs.gnubok.se/webhooks § Payload shape. */
export interface AccountedWebhookEnvelope {
  id?: unknown
  type?: unknown
  api_version?: unknown
  created?: unknown
  data?: { object?: unknown } | null
}

/** The per-connection request context the inbound route needs, coerced once. */
export interface AccountedWebhookDeliveryContext {
  /** `X-Gnubok-Event`, or null when absent. */
  eventTypeHeader: string | null
  /** `X-Gnubok-Signature` raw header value, or undefined. */
  signatureHeader: string | undefined
  /** `X-Gnubok-Delivery`, or null when absent. */
  deliveryHeader: string | null
  /** `X-Gnubok-Api-Version` header, else the envelope's `api_version`, else null. */
  apiVersion: string | null
  /** `X-Request-Id`, or null when absent. */
  requestId: string | null
  /** The envelope `id` when it is a non-empty string; null otherwise. */
  envelopeId: string | null
  /** The envelope `type` when it is a non-empty string; null otherwise. */
  envelopeType: string | null
  /** The parsed envelope, or null when the body is not an object. */
  envelope: AccountedWebhookEnvelope | null
  /** The `data.object` when the envelope carries one; null otherwise. */
  rawObject: Record<string, unknown> | null
}

/**
 * Read the delivery's identity out of the raw headers and the raw body. The
 * envelope is parsed LENIENTLY (a body that does not parse has already had
 * its signature verdict — a malformed-but-stable payload must not consume
 * ~87 h of retries), and every field the route files away is coerced here.
 */
export function readAccountedWebhookContext(input: {
  headers: Record<string, unknown>
  rawBody: Buffer
}): AccountedWebhookDeliveryContext {
  const headerString = (name: string): string | null => {
    const v = input.headers[name]
    return typeof v === 'string' && v.length > 0 ? v : null
  }
  const envelope = parseEnvelope(input.rawBody)
  const rawObject =
    typeof envelope?.data?.object === 'object' && envelope.data.object !== null
      ? (envelope.data.object as Record<string, unknown>)
      : null
  return {
    eventTypeHeader: headerString('x-gnubok-event'),
    signatureHeader: typeof input.headers['x-gnubok-signature'] === 'string' ? (input.headers['x-gnubok-signature'] as string) : undefined,
    deliveryHeader: headerString('x-gnubok-delivery'),
    apiVersion: headerString('x-gnubok-api-version') ?? (typeof envelope?.api_version === 'string' ? envelope.api_version : null),
    requestId: headerString('x-request-id'),
    envelopeId: typeof envelope?.id === 'string' && envelope.id.length > 0 ? envelope.id : null,
    envelopeType: typeof envelope?.type === 'string' && envelope.type.length > 0 ? envelope.type : null,
    envelope,
    rawObject,
  }
}

/** Parse the envelope, or null when the body is not the expected shape. */
function parseEnvelope(rawBody: Buffer): AccountedWebhookEnvelope | null {
  try {
    const parsed = JSON.parse(rawBody.toString('utf8')) as unknown
    if (typeof parsed !== 'object' || parsed === null) return null
    return parsed as AccountedWebhookEnvelope
  } catch {
    return null
  }
}

/**
 * What processing stores for the event type (#3019 item 4): a
 * `journal_entry.committed` carries the REDACTED `data.object` into the
 * deliveries row (the probe's raw material); every other type counts without
 * a stored body.
 */
export function prepareStoredPayload(eventType: string | null, envelope: AccountedWebhookEnvelope): Record<string, unknown> | null {
  const rawObject = envelope.data?.object
  if (eventType === 'journal_entry.committed' && typeof rawObject === 'object' && rawObject !== null) {
    return redactAccountedWebhookObject(rawObject as Record<string, unknown>)
  }
  return null
}

