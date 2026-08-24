/**
 * Catalogue verification probe (epic #1717, #1713).
 *
 * ## What this is for
 *
 * A submission that has passed domain-ownership proof (#1712) says only that
 * someone controls the domain. It does not say the endpoint is a working,
 * payable MCP server. This module is what turns `ownership_verified` into
 * `verified_payable` — it walks `initialize → tools/list → paid tool call`
 * and reads the `402` challenge the merchant answers with.
 *
 * The badge the directory ends up showing means exactly what this module
 * observed and nothing more: *this endpoint answered a real x402 quote.* Not
 * that the merchant is honest, competent, or will still be there tomorrow.
 *
 * ## Read-only, structurally
 *
 * The probe **never signs and never pays**. That is not a convention here, it
 * is an absence: this module imports no signer, no settle path, no key
 * material, and the tool call it makes is unpaid *on purpose* — the `402` is
 * the result it wants, and continuing past it would be the bug. A test pins
 * the import surface, because "we didn't call the signer" is easy to say and
 * easy to stop being true.
 *
 * ## Every URL here is attacker-chosen
 *
 * `resource_url` comes from a public, unauthenticated submit endpoint. #1711
 * accepts RFC1918, NAT64 and 6to4 literals into the queue **by design** —
 * blocking hostname *shapes* at submit time is cosmetic when a public name
 * can resolve privately a second later. So every outbound call from here goes
 * through the shared SSRF guard (`infra/http/ssrf-guard.ts`, #1712), which
 * classifies the **resolved address** and pins the socket to it. Do not
 * reintroduce a bare `fetch` in this file; `modules/catalog/merchant-catalog.ts`
 * legitimately uses one because its URLs are operator-curated, and that
 * difference is the entire reason this module exists separately.
 *
 * ## Two budgets that are not the timeout
 *
 * - **Global concurrency cap.** At most `maxConcurrency` probes in flight for
 *   a whole batch, so a flood of eligible rows cannot turn one leader replica
 *   into an outbound request storm.
 * - **Per-hostname cooldown.** One host is probed at most once per
 *   `hostCooldownMs`, across batches. Without it, a submitter who enqueues
 *   many rows pointing at one victim gets Haven to hammer it — the ownership
 *   gate means they must own that host, but owning a host does not entitle
 *   them to unbounded traffic from us, and a shared-hosting neighbour never
 *   consented at all.
 *
 * ## Detail is server-side only
 *
 * `ProbeFailure.reason` is coarse and public-safe by construction; the
 * granular string lives in `detail`, which must never reach an untrusted
 * caller. `redactProbeOutcome` is the one supported way to cross that line —
 * see its docstring for the oracle it closes.
 */
import {
  safePostJson,
  type SafeFetchOptions,
  type SafeFetchResult,
  type SafeResponse,
} from '../../infra/http/ssrf-guard.js'

/** Wall-clock budget for ONE JSON-RPC leg. Three legs, so ~3x worst case. */
export const DEFAULT_LEG_TIMEOUT_MS = 5_000
/** Response cap per leg. A `tools/list` for a large server is still small. */
export const DEFAULT_MAX_BYTES = 256 * 1024
/** Probes in flight across a whole batch. */
export const DEFAULT_MAX_CONCURRENCY = 4
/** Minimum gap between two probes of the same hostname. */
export const DEFAULT_HOST_COOLDOWN_MS = 15 * 60 * 1000

/**
 * Public-safe failure reasons. Deliberately coarse: every transport-level
 * refusal the SSRF guard can produce collapses into `unreachable`, so the
 * value itself carries no information about Haven's internal network view.
 */
export type ProbeFailureReason =
  | 'unreachable'
  | 'not_mcp'
  | 'no_payable_tool'
  | 'malformed_challenge'

/** Minimal parsed metadata. Pointer-shaped: the epic forbids storing bodies. */
export interface ProbeMetadata {
  name: string
  description: string | null
  entrypoint: string
}

export interface ProbeSuccess {
  ok: true
  metadata: ProbeMetadata
  verifiedAt: Date
}

export interface ProbeFailure {
  ok: false
  reason: ProbeFailureReason
  /**
   * **SERVER-SIDE ONLY.** Carries the SSRF guard's granular verdict
   * (`address_not_public: … (ipv4-private)`, `dns_failure: …`) and the leg it
   * failed on. Never return this to an untrusted caller — see
   * `redactProbeOutcome`.
   */
  detail: string
  /** Which JSON-RPC leg failed, for ops. Server-side only, same as `detail`. */
  leg: ProbeLeg
}

/**
 * Named `SubmissionProbeResult`, not `ProbeResult`: `merchant-catalog.ts`
 * already exports a `ProbeResult` for the operator-curated refresh, and both
 * leave this module directory through the same `index.ts`.
 */
export type SubmissionProbeResult = ProbeSuccess | ProbeFailure

export type ProbeLeg = 'initialize' | 'tools/list' | 'tools/call'

/** A queue row, reduced to what the probe actually needs. */
export interface ProbeCandidate {
  id: string
  resourceUrl: string
}

export type ProbeOutcome =
  | { id: string; status: 'verified_payable'; metadata: ProbeMetadata; lastVerifiedAt: Date }
  | { id: string; status: 'failed'; reason: ProbeFailureReason; detail: string; leg: ProbeLeg }
  | { id: string; status: 'skipped'; reason: 'host_cooldown' }

/**
 * Strip everything an untrusted caller must not see.
 *
 * Handed `detail` verbatim, a status route becomes a blind internal-DNS
 * oracle: an anonymous submitter aims a hostname they do not own at the
 * probe and learns whether Haven's resolver sees it and roughly what address
 * class it resolves into. No content leaks and no connection is made, so the
 * severity is bounded — but it is free to close here and expensive to
 * retrofit once a route has shipped the field. `reason` stays, because a
 * genuine merchant needs to know *that* their endpoint did not answer.
 */
export function redactProbeOutcome(outcome: ProbeOutcome): PublicProbeOutcome {
  if (outcome.status === 'failed') {
    return { id: outcome.id, status: 'failed', reason: outcome.reason }
  }
  if (outcome.status === 'skipped') {
    return { id: outcome.id, status: 'skipped' }
  }
  return { id: outcome.id, status: 'verified_payable', metadata: outcome.metadata }
}

export type PublicProbeOutcome =
  | { id: string; status: 'verified_payable'; metadata: ProbeMetadata }
  | { id: string; status: 'failed'; reason: ProbeFailureReason }
  | { id: string; status: 'skipped' }

/** Transport seam, so the probe is testable without a network. */
export type GuardedPost = (
  url: string,
  payload: unknown,
  options?: SafeFetchOptions,
) => Promise<SafeFetchResult>

export interface ProbeDeps {
  post?: GuardedPost
  legTimeoutMs?: number
  maxBytes?: number
  now?: () => Date
}

/**
 * MCP Streamable HTTP answers either `application/json` or an SSE stream. The
 * SSE form frames the JSON-RPC message in `data:` lines, so unwrap it rather
 * than failing a perfectly ordinary server.
 */
function parseJsonRpcBody(raw: string): unknown {
  const trimmed = raw.trim()
  if (trimmed === '') return null
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed)
    } catch {
      return null
    }
  }
  // SSE: take the last complete `data:` payload that parses.
  const dataLines = trimmed
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
  for (let i = dataLines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(dataLines[i]!)
    } catch {
      /* try the previous frame */
    }
  }
  return null
}

/**
 * Locate the x402 `payment_required` object a merchant answers an unpaid MCP
 * tool call with. Servers place it in a few different places depending on
 * which SDK wrapped them; check the documented ones and stop.
 */
function findPaymentRequired(payload: unknown): Record<string, unknown> | null {
  if (payload === null || typeof payload !== 'object') return null
  const candidates: unknown[] = [
    (payload as { payment_required?: unknown }).payment_required,
    (payload as { error?: { data?: { payment_required?: unknown } } }).error?.data?.payment_required,
    (payload as { result?: { payment_required?: unknown } }).result?.payment_required,
  ]
  for (const candidate of candidates) {
    if (candidate !== null && typeof candidate === 'object') return candidate as Record<string, unknown>
  }
  return null
}

/**
 * The `extensions.bazaar.schema` block — the machine-readable description of
 * WHAT is being sold, which is the only part of a 402 this probe keeps.
 * Deliberately not the payment terms: prices move, and #1714 owns cadence.
 */
function bazaarSchema(paymentRequired: Record<string, unknown>): Record<string, unknown> | null {
  const extensions = (paymentRequired as { extensions?: unknown }).extensions
  if (extensions === null || typeof extensions !== 'object') return null
  const bazaar = (extensions as { bazaar?: unknown }).bazaar
  if (bazaar === null || typeof bazaar !== 'object') return null
  const schema = (bazaar as { schema?: unknown }).schema
  if (schema === null || typeof schema !== 'object') return null
  return schema as Record<string, unknown>
}

function asTrimmedString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

function fail(reason: ProbeFailureReason, leg: ProbeLeg, detail: string): ProbeFailure {
  return { ok: false, reason, detail, leg }
}

/** Collapse any guard refusal into the one public-safe reason. */
function refusalToFailure(result: Exclude<SafeFetchResult, SafeResponse>, leg: ProbeLeg): ProbeFailure {
  return fail('unreachable', leg, `${result.reason}: ${result.detail}`)
}

interface JsonRpcTool {
  name?: unknown
  description?: unknown
}

/**
 * Probe one endpoint: `initialize → tools/list → unpaid tool call`.
 *
 * Returns a value, never throws — the caller persists the verdict, and an
 * exception escaping into a batch loop would strand every later candidate.
 */
export async function probeSubmission(
  resourceUrl: string,
  deps: ProbeDeps = {},
): Promise<SubmissionProbeResult> {
  const post = deps.post ?? safePostJson
  const now = deps.now ?? (() => new Date())
  const fetchOptions: SafeFetchOptions = {
    timeoutMs: deps.legTimeoutMs ?? DEFAULT_LEG_TIMEOUT_MS,
    maxBytes: deps.maxBytes ?? DEFAULT_MAX_BYTES,
    // A JSON-RPC endpoint that redirects is refused by the guard on POST; say
    // so explicitly rather than relying on a default that could change.
    maxRedirects: 0,
  }

  // ---- Leg 1: initialize -------------------------------------------------
  const initialize = await post(
    resourceUrl,
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'haven-catalog-probe', version: '1' },
      },
    },
    fetchOptions,
  )
  if (!initialize.ok) return refusalToFailure(initialize, 'initialize')
  if (initialize.status !== 200) {
    return fail('not_mcp', 'initialize', `HTTP ${initialize.status} to initialize`)
  }
  const initPayload = parseJsonRpcBody(initialize.body)
  if (findJsonRpcResult(initPayload) === null) {
    return fail('not_mcp', 'initialize', 'initialize did not answer a JSON-RPC result')
  }
  // MCP Streamable HTTP binds later requests to this session when present.
  // The guard allowlists exactly this header for a caller to add.
  const sessionId = initialize.headers['mcp-session-id']
  const sessionOptions: SafeFetchOptions =
    sessionId === undefined ? fetchOptions : { ...fetchOptions, extraHeaders: { 'mcp-session-id': sessionId } }

  // ---- Leg 2: tools/list -------------------------------------------------
  const listed = await post(
    resourceUrl,
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    sessionOptions,
  )
  if (!listed.ok) return refusalToFailure(listed, 'tools/list')
  if (listed.status !== 200) {
    return fail('not_mcp', 'tools/list', `HTTP ${listed.status} to tools/list`)
  }
  const listResult = findJsonRpcResult(parseJsonRpcBody(listed.body)) as { tools?: unknown } | null
  const tools = Array.isArray(listResult?.tools) ? (listResult!.tools as JsonRpcTool[]) : []
  const firstTool = tools.find((tool) => asTrimmedString(tool.name) !== null)
  if (firstTool === undefined) {
    return fail('no_payable_tool', 'tools/list', 'server advertises no named tools')
  }
  const toolName = asTrimmedString(firstTool.name)!

  // ---- Leg 3: the UNPAID tool call --------------------------------------
  // No signature, no payment header, no retry. The 402 IS the result.
  const called = await post(
    resourceUrl,
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: toolName, arguments: {} } },
    sessionOptions,
  )
  if (!called.ok) return refusalToFailure(called, 'tools/call')

  const callPayload = parseJsonRpcBody(called.body)
  const paymentRequired = findPaymentRequired(callPayload)
  if (paymentRequired === null) {
    return fail(
      'no_payable_tool',
      'tools/call',
      `HTTP ${called.status} with no payment_required block — endpoint is not payable`,
    )
  }
  const schema = bazaarSchema(paymentRequired)
  if (schema === null) {
    return fail('malformed_challenge', 'tools/call', 'payment_required carries no extensions.bazaar.schema')
  }

  const name = asTrimmedString(schema.name) ?? toolName
  const description = asTrimmedString(schema.description)
  const entrypoint = asTrimmedString(schema.entrypoint) ?? toolName

  return { ok: true, metadata: { name, description, entrypoint }, verifiedAt: now() }
}

function findJsonRpcResult(payload: unknown): Record<string, unknown> | null {
  if (payload === null || typeof payload !== 'object') return null
  const result = (payload as { result?: unknown }).result
  if (result !== null && typeof result === 'object') return result as Record<string, unknown>
  return null
}

/** Normalised hostname for cooldown accounting; `null` when unparseable. */
export function candidateHostname(resourceUrl: string): string | null {
  try {
    return new URL(resourceUrl).hostname.toLowerCase()
  } catch {
    return null
  }
}

/**
 * Per-hostname cooldown, held across batches by the caller.
 *
 * In-process on purpose. It is a politeness budget, not a security control —
 * the security controls are the ownership gate and the SSRF guard, both of
 * which hold regardless. A replica-local cooldown is off by at most the
 * replica count, and the probe runs under a leader lock anyway, so in
 * practice there is one.
 */
export class HostCooldown {
  private readonly nextEligibleAt = new Map<string, number>()

  constructor(private readonly cooldownMs: number = DEFAULT_HOST_COOLDOWN_MS) {}

  isCoolingDown(hostname: string, now: number): boolean {
    const next = this.nextEligibleAt.get(hostname)
    return next !== undefined && now < next
  }

  record(hostname: string, now: number): void {
    this.nextEligibleAt.set(hostname, now + this.cooldownMs)
  }
}

export interface BatchOptions extends ProbeDeps {
  maxConcurrency?: number
  cooldown?: HostCooldown
}

/**
 * Probe a batch of eligible candidates under both budgets.
 *
 * Order of the two checks matters and is load-bearing: the cooldown is
 * consulted and **recorded before the probe is dispatched**, not after it
 * returns. Recording on completion would let a burst of rows for one host all
 * pass the check while the first probe is still in flight — the same
 * check-then-act shape that made #1711's queue cap not a cap.
 */
export async function runProbeBatch(
  candidates: ProbeCandidate[],
  options: BatchOptions = {},
): Promise<ProbeOutcome[]> {
  const maxConcurrency = Math.max(1, options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY)
  const cooldown = options.cooldown ?? new HostCooldown()
  const now = options.now ?? (() => new Date())

  const outcomes: ProbeOutcome[] = []
  const runnable: ProbeCandidate[] = []

  // Admission is sequential and happens up front, so the cooldown decision is
  // never made concurrently with itself.
  for (const candidate of candidates) {
    const hostname = candidateHostname(candidate.resourceUrl)
    if (hostname === null) {
      outcomes.push({
        id: candidate.id,
        status: 'failed',
        reason: 'unreachable',
        detail: 'resource_url is not a parseable absolute URL',
        leg: 'initialize',
      })
      continue
    }
    const at = now().getTime()
    if (cooldown.isCoolingDown(hostname, at)) {
      outcomes.push({ id: candidate.id, status: 'skipped', reason: 'host_cooldown' })
      continue
    }
    cooldown.record(hostname, at)
    runnable.push(candidate)
  }

  let cursor = 0
  let inFlight = 0

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor
      cursor += 1
      const candidate = runnable[index]
      if (candidate === undefined) return
      inFlight += 1
      try {
        const result = await probeSubmission(candidate.resourceUrl, options)
        outcomes.push(
          result.ok
            ? {
                id: candidate.id,
                status: 'verified_payable',
                metadata: result.metadata,
                lastVerifiedAt: result.verifiedAt,
              }
            : {
                id: candidate.id,
                status: 'failed',
                reason: result.reason,
                detail: result.detail,
                leg: result.leg,
              },
        )
      } finally {
        inFlight -= 1
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(maxConcurrency, Math.max(runnable.length, 1)) }, () => worker()),
  )

  return outcomes
}
