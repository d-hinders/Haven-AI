import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { config } from '../config.js'
import {
  processAccountedWebhook,
  readAccountedWebhookContext,
  verifyAccountedSignature,
  incrementAccountingWebhookCounter,
  prepareStoredPayload,
  type AccountedWebhookSubscriptionSecret,
  type SignatureVerdict,
} from '../modules/accounting/index.js'
import { recordWebhookDelivery } from '../infra/repositories/accounting-webhook-deliveries.js'
import {
  ACCOUNTING_WEBHOOK_CALLBACK_PREFIX,
  getConnectionByWebhookToken,
} from '../infra/repositories/accounting-connections.js'
import { decryptSecrets } from '../infra/secrets.js'

/**
 * The Accounted webhook receiver (#3019, epic #3016 slice 3).
 *
 * `POST /accounting/webhooks/accounted/<token>` — public, no session. The
 * token is the first credential: 32 random bytes base64url (256 bits — the
 * entropy is stated where it is generated, `accounting-connections.ts`),
 * stored on the connection at connect, so the secret lookup is direct and the
 * route never guesses the company from the payload. The second credential is
 * the HMAC: `X-Gnubok-Signature` (`t=<unix>,v1=<hex>`, HMAC-SHA256 over
 * `${t}.${rawBody}`) verified against the secret of the triple whose event
 * type matches `X-Gnubok-Event` (an unknown or missing type is verified
 * against EVERY stored secret — the provider signs `webhook.test` with the
 * subscription it was dispatched on), with `t` refused past 5 minutes.
 *
 * ## The raw body, and why this parser is route-scoped
 *
 * The signature covers the bytes the provider SENT; any framework JSON parse
 * plus re-serialisation produces different bytes. Fastify parses
 * `application/json` for every route, so THIS plugin encapsulates a
 * content-type parser that keeps the raw Buffer (`request.body` is the Buffer
 * itself here). Route-scoped on purpose: no `addContentTypeParser` exists
 * app-wide today, and an app-wide one would change body handling for EVERY
 * route.
 *
 * ## The answer matrix — read before touching the handler
 *
 *  - 400: bad signature, malformed signature header, stale `t` — the
 *    provider's own reference implementation's status for a failed verdict.
 *  - 404: unknown token (no connection carries it).
 *  - 200: every other path — unparseable JSON (the SIGNATURE verdict comes
 *    first; a failed parse changes only the counter), feature off,
 *    `webhook.test`, unknown event types, duplicates, success. The provider
 *    retries any non-2xx for ~87 h; a delivery we will never accept must NOT
 *    be retried, and by then the ledger row is already written.
 *  - NEVER 410 (it auto-disables the subscription at the provider, with no
 *    replay) and NEVER any 3xx (a redirect hands the provider a URL it did
 *    not register): the handler is registered for BOTH the exact path and
 *    the trailing-slash variant, and every answer is a JSON body. A test
 *    below enumerates the matrix.
 *
 * ## Why the handler has no request-shape logic
 *
 * Header coercion and envelope interpretation live in the module
 * (`readAccountedWebhookContext`): the route file carries no hand-rolled
 * type-ladders for the request-schemas gauge to count — the spec
 * (`openapi/spec.ts`) carries the route's shape and the request-validation
 * plugin enforces it. The handler is branch-on-context only.
 *
 * Rate limiting (#3019 item 3): `@fastify/rate-limit` keys on
 * `Authorization`/`X-API-Key` (`middleware/rate-limit.ts`), which a webhook
 * carries neither of — the shared generator degrades to `ip:`
 * (`rateLimitKeyFor` returns `ip:${request.ip}` when neither header is
 * present). Behind the deployment proxy that is one shared bucket, so the
 * ceiling sits far above the whole provider's legitimate cadence: 600
 * callbacks a minute dwarfs a 7-retry storm across every connection, and the
 * 429 that could push the provider's deliveries toward `dead` is unreachable
 * in practice.
 */

/** The plugin's own rate-limit tier — see the header for the keying math. Exported for the test pin. */
export const WEBHOOK_RATE_LIMIT = { max: 600, timeWindow: '1 minute' } as const

export default async function accountingWebhookRoutes(app: FastifyInstance): Promise<void> {
  // Route-scoped raw-body capture — THIS instance only (the plugin's
  // encapsulated context), never the root scope.
  app.addContentTypeParser<Buffer>(
    'application/json',
    { parseAs: 'buffer' },
    (_req: FastifyRequest, body: Buffer, done: (err: Error | null, parsed?: Buffer) => void) => {
      done(null, body)
    },
  )

  const handler = async (request: FastifyRequest, reply: FastifyReply) => {
    const params = request.params as Record<string, string>
    const token = params['token']
    const context = readAccountedWebhookContext({ headers: request.headers, rawBody: request.body as Buffer })
    incrementAccountingWebhookCounter('received')

    // ── 1. The capability token: the only lookup the URL affords. ──────────
    const row = await getConnectionByWebhookToken(token)
    if (!row) {
      incrementAccountingWebhookCounter('unknown_token')
      return reply.code(404).send({ status: 'unknown-token' })
    }

    // ── 2. The signature verdict FIRST — before any JSON parsing. ──────────
    // The raw bytes are the parser's untouched Buffer; a body that would fail
    // JSON parse still gets this verdict first.
    const secrets = row.secrets_ciphertext
      ? decryptSecrets<{ apiKey?: string; webhooks?: AccountedWebhookSubscriptionSecret[] }>(
          row.secrets_ciphertext,
          row.secrets_key_version,
        )
      : null
    const triples = secrets?.webhooks ?? []
    const candidates = context.eventTypeHeader
      ? [
          ...triples.filter((t) => t.eventType === context.eventTypeHeader),
          ...triples.filter((t) => t.eventType !== context.eventTypeHeader),
        ]
      : triples
    let verdict: SignatureVerdict = { ok: false, reason: 'malformed_header' }
    for (const triple of candidates) {
      verdict = verifyAccountedSignature({ rawBody: request.body as Buffer, header: context.signatureHeader, secret: triple.secret, nowMs: Date.now() })
      if (verdict.ok) break
    }
    if (!verdict.ok) {
      if (verdict.reason === 'stale_timestamp') incrementAccountingWebhookCounter('stale')
      else incrementAccountingWebhookCounter('bad_signature')
      return reply.code(400).send({ status: 'bad-signature', reason: verdict.reason })
    }

    // ── 3. Past the gate: every remaining path answers 200. ────────────────
    if (!config.accountingEnabled) {
      incrementAccountingWebhookCounter('feature_off')
      return { status: 'ok', counted: 'feature_off' }
    }

    // The delivery's identity: the header first, the envelope as fallback —
    // decided in the module (`readAccountedWebhookContext`), read here.
    const deliveryId = context.deliveryHeader ?? context.envelopeId
    const eventType = context.eventTypeHeader ?? context.envelopeType
    if (!context.envelope || !deliveryId) {
      incrementAccountingWebhookCounter('unknown_type')
      return { status: 'ok', counted: 'unknown_type' }
    }

    // ── 4. The durable dedupe: the row is written BEFORE the 2xx. ──────────
    // The provider stops retrying once it sees 2xx, so nothing may be
    // deferred past the answer — processing is inline and `processed_at` is
    // stamped in the same statement as the insert.
    const stored = prepareStoredPayload(eventType, context.envelope)
    const { inserted } = await recordWebhookDelivery({
      provider: 'accounted',
      deliveryId,
      eventType,
      apiVersion: context.apiVersion,
      requestId: context.requestId,
      payload: stored,
      processed: true,
    })
    if (!inserted) {
      incrementAccountingWebhookCounter('duplicate')
      return { status: 'ok', counted: 'duplicate', deliveryId }
    }

    // ── 5. Inline processing — cheap, counted, no sync-row state change. ───
    // The document match runs on the RAW object (a `document.uploaded` object
    // is matched, not stored — the payload column carries only the redacted
    // `journal_entry.committed` object).
    const counted = await processAccountedWebhook({ eventType, object: stored ?? context.rawObject })
    if (counted === 'confirmed_document_uploaded') incrementAccountingWebhookCounter('confirmed')
    if (counted === 'unknown_type') incrementAccountingWebhookCounter('unknown_type')
    incrementAccountingWebhookCounter('processed')
    return { status: 'ok', counted, deliveryId }
  }

  const routeOptions = { config: { rateLimit: WEBHOOK_RATE_LIMIT } }
  // BOTH path spellings run the handler — the trailing-slash variant must
  // never become a 3xx (or a bare 404 the provider's dispatcher reads as a
  // permanent refusal on a URL it DID register). Literal strings: the
  // route-modules generator reads source, and a literal path is what lands
  // in the generated table.
  app.post('/accounting/webhooks/accounted/:token', routeOptions, handler)
  app.post('/accounting/webhooks/accounted/:token/', routeOptions, handler)
}
