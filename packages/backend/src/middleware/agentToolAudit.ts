import type { FastifyInstance, FastifyRequest } from 'fastify'
import pool from '../db.js'

/**
 * Minimal pool-like interface — matches the shape exported by `db.ts` and
 * the real `pg.Pool` alike, so tests can pass a fake without dragging in
 * pg's full type surface.
 */
export interface QueryableLike {
  query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number | null }>
}

/**
 * Tool names recognised in the `X-Haven-MCP-Tool` request header.
 *
 * Restricted to the surface exposed by `@haven_ai/mcp` so the audit log
 * cannot be polluted with arbitrary strings supplied by a caller. Unknown
 * values are dropped silently — the request still proceeds, it just isn't
 * recorded as an MCP tool invocation.
 */
export const MCP_TOOL_NAMES = [
  'haven_quote_x402',
  'haven_pay_x402_quote',
  'haven_resume_x402_payment',
  'haven_quote_mpp',
  'haven_pay_mpp_challenge',
  'haven_resume_mpp_payment',
  'haven_get_payment_status',
  'haven_get_resume_state',
  'haven_get_agent',
  'haven_get_allowances',
  'haven_list_receipts',
] as const

export type McpToolName = (typeof MCP_TOOL_NAMES)[number]

const TOOL_NAME_SET: ReadonlySet<string> = new Set(MCP_TOOL_NAMES)

declare module 'fastify' {
  interface FastifyRequest {
    /** Captured `X-Haven-MCP-Tool` header value, if it matched the allowlist. */
    mcpTool?: McpToolName
    /** Captured response body (parsed JSON if possible) for audit log extraction. */
    mcpResponseBody?: unknown
  }
}

/**
 * Read the `X-Haven-MCP-Tool` header and stash it on the request if it
 * matches the allowlist. Runs as `onRequest` so it precedes auth and is
 * available throughout the request lifecycle.
 */
export function readMcpToolHeader(request: FastifyRequest): void {
  const raw = request.headers['x-haven-mcp-tool']
  const value = Array.isArray(raw) ? raw[0] : raw
  if (typeof value !== 'string') return
  const trimmed = value.trim()
  if (TOOL_NAME_SET.has(trimmed)) {
    request.mcpTool = trimmed as McpToolName
  }
}

/**
 * Register `onRequest` + `onSend` + `onResponse` hooks on the Fastify app
 * so any request that:
 *   1) carries a recognised `X-Haven-MCP-Tool` header, and
 *   2) authenticated as an agent (via `agentAuthMiddleware`)
 *
 * leaves an `agent_tool_invocations` row regardless of outcome.
 */
export function registerAgentToolAuditHooks(
  app: FastifyInstance,
  poolOverride: QueryableLike = pool as unknown as QueryableLike,
): void {
  app.addHook('onRequest', async (request) => {
    readMcpToolHeader(request)
  })

  app.addHook('onSend', async (request, _reply, payload) => {
    if (!request.mcpTool) return payload
    request.mcpResponseBody = tryParseJson(payload)
    return payload
  })

  app.addHook('onResponse', async (request, reply) => {
    const tool = request.mcpTool
    if (!tool) return
    // Need an authenticated agent context to attribute the call. The
    // agentAuthMiddleware decorates request.agent on success.
    const agent = request.agent
    if (!agent) return

    const status = reply.statusCode
    const body = (request.mcpResponseBody ?? {}) as Record<string, unknown>
    const errorBody = (body.error && typeof body.error === 'object')
      ? (body.error as Record<string, unknown>)
      : undefined

    const paymentId = extractPaymentId(body)
    const nextAction = pickString(
      body.nextAction,
      body.next_action,
      errorBody?.nextAction,
      errorBody?.next_action,
      pickFromState(body, ['nextAction', 'next_action']),
    )
    const errorCode = status >= 400
      ? pickString(body.code, body.error, errorBody?.code, errorBody?.error)
      : undefined
    const resultStatus = deriveResultStatus(status)

    try {
      await poolOverride.query(
        `INSERT INTO agent_tool_invocations
           (agent_id, user_id, tool_name, payment_id, result_status, next_action, error_code, status_code)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          agent.id,
          agent.user_id,
          tool,
          paymentId,
          resultStatus,
          nextAction ?? null,
          errorCode ?? null,
          status,
        ],
      )
    } catch (err) {
      // Audit logging is best-effort: a failure here must not affect the
      // user-visible response, which has already been sent. Log to stderr
      // so it lands in the platform logs.
      request.log.error({ err }, 'Failed to record agent_tool_invocations row')
    }
  })
}

function tryParseJson(payload: unknown): unknown {
  if (typeof payload === 'string') {
    try {
      return JSON.parse(payload)
    } catch {
      return undefined
    }
  }
  if (payload && typeof payload === 'object' && !(payload instanceof Buffer)) {
    return payload
  }
  return undefined
}

function deriveResultStatus(status: number): 'ok' | 'error' | 'denied' {
  if (status === 401 || status === 403) return 'denied'
  if (status >= 400) return 'error'
  return 'ok'
}

function extractPaymentId(body: Record<string, unknown>): string | null {
  const direct = pickString(
    body.payment_id,
    body.paymentId,
    (body.payment as Record<string, unknown> | undefined)?.id,
    (body.payment as Record<string, unknown> | undefined)?.payment_id,
    pickFromState(body, ['paymentId', 'payment_id']),
  )
  if (direct && looksLikeUuid(direct)) return direct
  return null
}

function pickFromState(
  body: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  const containers: Array<Record<string, unknown> | undefined> = [
    body.state as Record<string, unknown> | undefined,
    body.resume_state as Record<string, unknown> | undefined,
    body.resumeState as Record<string, unknown> | undefined,
  ]
  for (const c of containers) {
    if (!c) continue
    for (const key of keys) {
      const v = c[key]
      if (typeof v === 'string' && v.length > 0) return v
    }
  }
  return undefined
}

function pickString(...candidates: unknown[]): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate
  }
  return undefined
}

function looksLikeUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
}
