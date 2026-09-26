import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import {
  CLIENT_COMPAT,
  evaluateClient,
  upgradeCommandFor as upgradeCommandOnChannel,
  type ClientCompatEntry,
  type ClientCompatVerdict,
  type PublishedClientPackage,
} from '@haven_ai/core'
import { config } from '../config.js'
import { AgentPaymentNextAction } from '../domain/agent-payment-taxonomy.js'
import { releaseNotesUrl } from '../domain/release-notes.js'
import { findSendIntentByIdempotencyKey } from '../infra/repositories/payment-intents.js'
import { findX402IntentByIdempotencyKey } from '../infra/repositories/x402-authorizations.js'
import { loadExecutionRailState, resolveExecutionRail } from '../rails/execution-rail.js'
import type { AgentContext } from './agentAuth.js'

/**
 * Client-version signal (#3303, epic #3302).
 *
 * Every published Haven client names itself with `X-Haven-Client:
 * <package>/<version>`; `@haven_ai/core`'s `CLIENT_COMPAT` says which versions
 * this deployment still serves. Two hooks act on the verdict:
 *
 * 1. **Hint** (`onSend`, every route). A client below `recommended_version` —
 *    or below a set `min_version` on a route that does not refuse it — gets a
 *    `client_update` object added to any JSON-object response body. A JSON
 *    array or a non-JSON body cannot carry a field and is left untouched.
 *
 * 2. **Refusal** (`preHandler`, the {@link CLIENT_REFUSAL_POINTS} only). A
 *    client below a SET `min_version` is answered 426 `client_outdated` before
 *    the handler runs, so nothing is written. Owner decision (2026-09-25, on
 *    #3302): warn by default, refuse only when flagged — no header, an
 *    unparseable header, a package outside the published five, or a
 *    `0.0.0-dev.*` snapshot is never refused.
 *
 * What is deliberately NOT a refusal point, because refusing it would strand
 * funds or a payment already prepared: the sweep routes, `/payments/:id/sign`,
 * `/x402/:id/settle`, the evidence and reconciliation reports, and any status
 * read. The signer is refused at sign-context — its only contact with the
 * backend, which comes AFTER prepare wrote the row, so for the signer the
 * contract is "nothing signed or submitted", not "nothing written" (owner
 * decision 2026-09-25, recorded on #3303). The prepared row then takes the
 * existing unsigned/abandoned path.
 *
 * Two more things skip the refusal and let the handler answer as today:
 * - an agent whose account is on a retired rail — the handler's 410 is the
 *   truer answer, and it is what a retired account has always received;
 * - an idempotent replay the handler will answer from the existing row
 *   without preparing anything — the exemption mirrors each handler's own
 *   replay rule (`clientCompatDeps.findReplay`). A pending row past its
 *   `expires_at` is NOT one: the handler lazily expires it and prepares a
 *   fresh payment, so that request is refused like a new one.
 * Both checks run only on the refusal branch, so a request that is not about
 * to be refused costs no query.
 */

declare module 'fastify' {
  interface FastifyRequest {
    /** The `X-Haven-Client` verdict, computed once per request. */
    clientCompat?: ClientCompatVerdict
  }
}

/** 426 Upgrade Required: the client must be updated before this request can succeed. */
export const CLIENT_OUTDATED_STATUS = 426
export const CLIENT_OUTDATED_ERROR_CODE = 'client_outdated'

type ReplayStore = 'send_intent' | 'x402_intent'

export interface ClientRefusalPoint {
  method: 'GET' | 'POST'
  /** The route pattern, without a trailing slash (`/payments`, not `/payments/`). */
  url: string
  /** The packages this point refuses when they are below their minimum. */
  packages: readonly PublishedClientPackage[]
  /** Where an already-accepted request with the same idempotency key would live. */
  replay?: { store: ReplayStore; bodyKey: 'idempotency_key' | 'idempotencyKey' }
}

/** Every client that can initiate a payment through the Haven API. The signer never does. */
const INITIATING_CLIENTS: readonly PublishedClientPackage[] = [
  '@haven_ai/sdk',
  '@haven_ai/mcp',
  '@haven_ai/cli',
  '@haven_ai/connect',
]

/**
 * The refusal points. Payment-INITIATING routes refuse the API clients; the two
 * sign-context reads refuse the signer. Nothing else refuses.
 */
export const CLIENT_REFUSAL_POINTS: readonly ClientRefusalPoint[] = [
  {
    method: 'POST',
    url: '/payments',
    packages: INITIATING_CLIENTS,
    replay: { store: 'send_intent', bodyKey: 'idempotency_key' },
  },
  {
    method: 'POST',
    url: '/machine-payments/send',
    packages: INITIATING_CLIENTS,
    // Same key column as POST /payments (migration 020, #1207).
    replay: { store: 'send_intent', bodyKey: 'idempotency_key' },
  },
  {
    method: 'POST',
    url: '/x402',
    packages: INITIATING_CLIENTS,
    replay: { store: 'x402_intent', bodyKey: 'idempotencyKey' },
  },
  {
    method: 'POST',
    url: '/x402/authorize',
    packages: INITIATING_CLIENTS,
    replay: { store: 'x402_intent', bodyKey: 'idempotencyKey' },
  },
  { method: 'GET', url: '/x402/:id/sign-context', packages: ['@haven_ai/signer'] },
  { method: 'GET', url: '/payments/:id/sign-context', packages: ['@haven_ai/signer'] },
]

function normaliseUrl(url: string | undefined): string {
  if (!url) return ''
  return url.length > 1 && url.endsWith('/') ? url.slice(0, -1) : url
}

export function findRefusalPoint(method: string, url: string | undefined): ClientRefusalPoint | undefined {
  const normalised = normaliseUrl(url)
  return CLIENT_REFUSAL_POINTS.find((p) => p.method === method && p.url === normalised)
}

/**
 * The command that updates `pkg`, on THIS deployment's channel. Derived from
 * `config.connectorChannel` — the same value `CONNECTOR_PACKAGE` in the setup
 * handout uses — never from a client's build-time channel, which would tell a
 * dev deployment's clients to install the production package. The command
 * itself lives in `@haven_ai/core` (#3304) so the public release documents
 * print the same one.
 */
export function upgradeCommandFor(pkg: PublishedClientPackage, channel: string = config.connectorChannel): string {
  return upgradeCommandOnChannel(pkg, channel)
}

export interface ClientUpdateHint {
  package: PublishedClientPackage
  current: string
  recommended: string | null
  min_version: string | null
  /** True when this client is below a set minimum and will be refused at its refusal points. */
  required: boolean
  upgrade_command: string
  /** The public release notes page (#3304). Typed nullable for clients built before it existed. */
  notes_url: string | null
}

type ActionableVerdict = Extract<ClientCompatVerdict, { kind: 'behind' | 'below_min' }>

export function clientUpdateHint(verdict: ActionableVerdict): ClientUpdateHint {
  return {
    package: verdict.package,
    current: verdict.version,
    recommended: verdict.recommended_version,
    min_version: verdict.min_version,
    required: verdict.kind === 'below_min',
    upgrade_command: upgradeCommandFor(verdict.package),
    notes_url: releaseNotesUrl(),
  }
}

export function clientOutdatedBody(verdict: ActionableVerdict): Record<string, unknown> {
  const hint = clientUpdateHint(verdict)
  return {
    error:
      `${hint.package} ${hint.current} is below the minimum version this Haven deployment accepts ` +
      `here (${hint.min_version}). Nothing was written or signed. Update with \`${hint.upgrade_command}\`, ` +
      'restart the agent runtime, then retry the same request.',
    error_code: CLIENT_OUTDATED_ERROR_CODE,
    client_update: hint,
    next_action: AgentPaymentNextAction.StopAndTellUser,
    next_tool_omitted_reason:
      `the client must be updated before any tool can succeed — tell the user to run ${hint.upgrade_command}, ` +
      'restart the agent runtime, then retry the same request',
  }
}

function verdictFor(request: FastifyRequest, table: CompatTable): ClientCompatVerdict {
  if (!request.clientCompat) request.clientCompat = evaluateClient(request.headers['x-haven-client'], table)
  return request.clientCompat
}

type CompatTable = Readonly<Record<PublishedClientPackage, ClientCompatEntry>>

export interface ClientCompatDeps {
  table: CompatTable
  loadRail: (agent: AgentContext) => Promise<'delegation' | 'retired'>
  findReplay: (store: ReplayStore, agentId: string, key: string) => Promise<boolean>
}

/**
 * The production collaborators: the handlers' own rail seam and replay
 * lookups, so the refusal and the handler cannot disagree about either. `table`
 * is a parameter only so a test can flag a minimum without editing the shipped
 * table.
 */
export function clientCompatDeps(table: CompatTable = CLIENT_COMPAT): ClientCompatDeps {
  return {
    table,
    loadRail: async (agent) => {
      const state = await loadExecutionRailState(agent)
      return resolveExecutionRail(state).rail === 'delegation' ? 'delegation' : 'retired'
    },
    findReplay: async (store, agentId, key) => {
      const now = Date.now()
      if (store === 'send_intent') {
        // Mirrors `findPaymentReplay` (routes/payments.ts): a row in any status
        // other than pending_signature is answered from the row (a status
        // replay, or a 409 on a mismatch) — no new work. A pending_signature
        // row PAST its expires_at is lazily expired by the handler, which then
        // prepares a fresh payment: that is NOT a replay (#3303 review, B1).
        const row = await findSendIntentByIdempotencyKey(agentId, key)
        if (!row) return false
        if (row.status !== 'pending_signature') return true
        return new Date(row.expires_at).getTime() >= now
      }
      // Mirrors `delegationReplay` (modules/x402/replay.ts): only a confirmed
      // row with a tx hash, or an in-window pending_signature row carrying its
      // prepared UserOp, is served without minting. Every other status, an
      // expired row, and a time-expired pending row all fall through to a
      // fresh intent there, so none of them is a replay here. Anything this
      // rule is unsure of is refused — the refusal writes nothing.
      const row = await findX402IntentByIdempotencyKey(agentId, key)
      if (!row) return false
      if (row.status === 'confirmed' && row.tx_hash) return true
      return (
        row.status === 'pending_signature' &&
        row.prepared_user_op != null &&
        new Date(row.expires_at).getTime() >= now
      )
    },
  }
}

const defaultDeps = clientCompatDeps()

export async function clientRefusalPreHandler(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: ClientCompatDeps = defaultDeps,
): Promise<FastifyReply | undefined> {
  const verdict = verdictFor(request, deps.table)
  if (verdict.kind !== 'below_min') return undefined
  const point = findRefusalPoint(request.method, request.routeOptions?.url)
  if (!point || !point.packages.includes(verdict.package)) return undefined
  const agent = request.agent as AgentContext | undefined
  // Every refusal point is agent-authenticated; with no agent the route's own
  // 401 has already answered. Never refuse what we cannot attribute.
  if (!agent) return undefined
  if ((await deps.loadRail(agent)) !== 'delegation') return undefined
  if (point.replay) {
    const body = request.body as Record<string, unknown> | undefined
    const key = body?.[point.replay.bodyKey]
    if (typeof key === 'string' && key.length > 0 && (await deps.findReplay(point.replay.store, agent.id, key))) {
      return undefined
    }
  }
  return reply.code(CLIENT_OUTDATED_STATUS).send(clientOutdatedBody(verdict))
}

/**
 * Add `client_update` to a JSON-object payload. Anything else — a JSON array,
 * a non-JSON body, a body already carrying the field (the refusal) — is
 * returned unchanged.
 */
export function injectClientUpdate(payload: unknown, contentType: unknown, hint: ClientUpdateHint): unknown {
  if (typeof payload !== 'string') return payload
  if (typeof contentType !== 'string' || !contentType.includes('application/json')) return payload
  if (!payload.trimStart().startsWith('{')) return payload
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch {
    return payload
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return payload
  if ('client_update' in parsed) return payload
  // Splice the field in as TEXT before the closing brace rather than
  // re-serializing: a parse/stringify round trip reorders integer-like keys
  // and would lose precision on any integer above 2^53, and the body is the
  // route's, not this hook's (#3303 review, N2). The parse above only decides
  // WHETHER to add the field.
  const end = payload.lastIndexOf('}')
  const isEmpty = Object.keys(parsed).length === 0
  return `${payload.slice(0, end)}${isEmpty ? '' : ','}"client_update":${JSON.stringify(hint)}${payload.slice(end)}`
}

export function registerClientCompatHooks(app: FastifyInstance, deps: ClientCompatDeps = defaultDeps): void {
  app.addHook('preHandler', async (request, reply) => {
    // Fastify's documented contract for an async hook that sends is to return
    // the reply. On fastify 5.8 the handler is skipped once the reply is sent
    // even without it (measured in #3303: removing this return keeps every
    // "handler never runs" assertion green), so this return follows the
    // contract rather than being the only thing between a refusal and a write.
    const refused = await clientRefusalPreHandler(request, reply, deps)
    if (refused) return refused
  })

  app.addHook('onSend', async (request, reply, payload) => {
    const verdict = verdictFor(request, deps.table)
    if (verdict.kind !== 'behind' && verdict.kind !== 'below_min') return payload
    return injectClientUpdate(payload, reply.getHeader('content-type'), clientUpdateHint(verdict))
  })
}
