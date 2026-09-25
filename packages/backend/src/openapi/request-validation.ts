/**
 * Validate every route's request against the OpenAPI spec at runtime
 * (#3029, epic #3028 slice 1).
 *
 * The spec declares machine-readable request constraints that nothing
 * enforced — the one boundary of the API contract with neither runtime nor
 * test enforcement, and it fronts the money path. The spec was largely
 * backfilled (#1446): it describes what routes were BELIEVED to accept, not
 * what installed clients send (the first proof was live for two slices —
 * `X402AuthorizeRequest` was `additionalProperties: false` and did not declare
 * `settlementScheme`, which the shipped SDK sends; #3031 declared it and
 * `facilitatorAddresses` beside it when it enforced that module). So
 * enforcement lands
 * BEHIND A MODE, shadow-first (owner decision #2, epic #3028):
 *
 *   off     — nothing runs anywhere: no schema is injected and no route is
 *             observed. The GLOBAL kill switch (#3032: an `enforcedModules`
 *             entry does not override it — an operator setting `off` is
 *             stopping this layer outright)
 *   shadow  — every route's request is compiled against the spec; a refusal is
 *             logged once (`request_validation.would_refuse`) and counted, and
 *             the request CONTINUES on the normal path — no behaviour change on
 *             any currently-accepted request. The GLOBAL observation switch,
 *             listed modules included (#3032). That last clause was
 *             ASPIRATIONAL until #3082: ajv's `coerceTypes` rewrites the body
 *             in place, so shadow was editing the payload it claimed only to
 *             measure and a `null` reached handlers as `''`. It is now
 *             enforced for the request BODY by a snapshot/restore pair (see
 *             the hooks below), not merely stated. Querystring and params
 *             coercion deliberately stays, so the promise still reads narrower
 *             than it sounds — and a body that coercion made VALID is now
 *             counted as `request_validation.would_coerce` rather than passing
 *             unseen.
 *   enforce — the DEFAULT since slice 4's flip (#3032). A refused request on
 *             a module listed in `enforcedModules` gets the 400 envelope; a
 *             module NOT listed falls back to shadow behaviour (log and
 *             continue), which is the per-module rollback: removing one file
 *             from the list returns exactly that module to observation without
 *             a global switch in front of every payment route (epic decision
 *             6). After the flip the list covers every constrained module, so
 *             the fallback is the exception path a rollback deliberately
 *             creates — never the default state of a new module (new modules
 *             are born enforced; the ratchet keeps `shadow: 0` everywhere).
 *
 * Per-module `enforcedModules` flips a module under `enforce` (and before the
 * flip did so under EVERY mode — the proof module rode that in slice 1); the
 * epic's slices 2–4 grew the list module by module after their shadow
 * readings.
 *
 * ## Why the flip is keyed on the route FILE (#3135, epic #3028 decision 7)
 *
 * Slice 1 keyed it on the mount PREFIX, and a prefix cannot express the epic's
 * slice partition. `/agents` is shared by `agents.ts`, `agent-delegations.ts`
 * (slice 3), `agent-rekey.ts` and `agent-passports.ts` (slice 4), so flipping
 * one of them flipped all four; and the root prefix `''` matched every module
 * under the old `startsWith` test, so listing it would have enforced the whole
 * server. The key is now `'routes/<file>.ts'` (and the bare `'index.ts'` for
 * the two routes declared on the app itself), resolved per operation through
 * `route-modules.generated.ts` — the table `route-inventory.ts` derives from
 * the same `index.ts` registration table the server itself reads, and the same
 * string `scripts/lint-request-schemas-baseline.json` keys its entries with,
 * so the two instruments cannot drift into keying the rollout two ways.
 *
 * The table is GENERATED and committed rather than derived at boot because the
 * derivation reads TypeScript source and the deployed image ships only
 * `dist/*.js`: deriving at runtime would resolve nothing in production and
 * silently un-enforce every flipped module. `npm run check:route-modules` and
 * `__tests__/route-modules.generated.test.ts` both fail on a stale table.
 *
 * This is a VALIDATOR, nothing more (CASP, docs/regulatory/casp-risk-guardrails.md):
 * it reads shape, refuses or logs, and never authorizes or constructs spend
 * intent. It did once ALTER a request, and that is worth stating precisely
 * rather than leaving the older absolute wording to contradict the note below:
 * ajv's spec-declared scalar coercion rewrites values in place. Since #3082 a
 * shadow-mode BODY is restored before the handler sees it; coercion of
 * querystring and params (and of an enforce-mode body) remains, deliberately,
 * because a typed spec parameter is unusable without it and an enforced route
 * answers on the result. No coercion has ever touched spend intent: every
 * semantic refusal on the money path — the rail seam's 410, the budget
 * pre-check, the token resolution — keeps its exact position and body; this layer only answers BEFORE them for requests the spec already
 * refuses, and in slice 1 it does not even do that outside the proof module.
 *
 * ## Registration contract (spiked against fastify 5.8.x, issue item 2)
 *
 * The install is ROOT-SCOPE on purpose: hooks registered inside a normal
 * (encapsulated) plugin never see routes registered after the plugin returns —
 * `onRoute` would fire for nothing (measured, spike 1). Called directly on the
 * app (`installRequestValidation(app, …)`, as index.ts and the route tests do)
 * the `onRoute` hook, `setValidatorCompiler` and `schemaErrorFormatter` all
 * inherit into every child module registered afterwards, which is the whole
 * point — the shadow readings slices 2–4 wait for would not exist until the
 * PR that enforces them.
 *
 * The validator compiler returns the RAW ajv validate function, deliberately
 * NOT a wrapper closure: fastify's `validateParam` answers
 * `if (ret === false) return validatorFunction.errors` (lib/validation.js:139)
 * — a wrapper owns no `.errors`, so a refusal would pass SILENTLY (measured,
 * spikes 3–4). `attachValidation` is set explicitly (`true` in shadow, left
 * false in enforce): fastify checks `attachValidation === false`
 * (lib/handle-request.js:107), and the route-level `errorHandler` is the one
 * place the "is a 400" envelope lives afterwards.
 *
 * ## The envelope
 *
 * Fits the spec's shared `errorResponse` (`spec.ts`) without a contract change:
 * `{ error, statusCode: 400, details, error_code: 'invalid_request' }` —
 * `details` is ajv's joined message, and `error_code` rides along because
 * `errorResponse` is `additionalProperties: true` (no `INVALID_REQUEST` exists
 * today: 0 hits; this picks `lower_snake`, the newer accounting convention).
 * Non-validation errors on an enforced route DELEGATE to the app-level error
 * handler captured at install — the 22P02 400 body (#1464) and every other
 * existing answer keep flowing exactly as before.
 *
 * RESTART-SCOPED: `attachValidation` and the injected schema are fixed at
 * registration, so flipping `HAVEN_REQUEST_VALIDATION` is a redeploy, not a
 * live kill switch (documented in .env.example and the runbook).
 */
import { isDeepStrictEqual } from 'node:util'
import type { FastifyError, FastifyInstance, FastifyRequest, RouteOptions } from 'fastify'
import { makeSpecAjv, REQUEST_AJV_OPTIONS, type ErrorObject } from './ajv.js'
import { fastifyPathToOpenApi, operationKey } from './route-inventory.js'
import { ROUTE_MODULE_BY_OPERATION } from './route-modules.generated.js'
import { openapiSpec } from './spec.js'
import type { RequestValidationMode } from '../config.js'

type Json = Record<string, unknown>

/** The spec object, typed loosely — it is a literal, not a generated model. */
const spec = openapiSpec as unknown as {
  paths: Record<string, Record<string, Json>>
  components: { schemas: Record<string, Json>; parameters?: Record<string, Json> }
}

/**
 * Resolve a `$ref` into `#/components/parameters`, or hand back a parameter
 * that is already inline.
 *
 * Without this the resolver dropped every `$ref`'d parameter on the floor —
 * `parameter.in` is `undefined` on a `$ref` node, so the `path`/`query` filter
 * skipped it. That was **40 of the spec's 134 request parameters** at
 * `b16be14`, and not a random 40: every `AgentId`, `PaymentId` and `SetupId`
 * path parameter, i.e. the uuid path params on the agent, payment and setup
 * routes — the exact #1464 malformed-uuid class epic #3028 cites as
 * demonstrated cost, and the modules slices 3 and 4 flip.
 *
 * Found while re-keying the flip (#3135). It is fixed HERE rather than filed
 * because slice #3030's whole deliverable is a shadow READING, and a reading
 * taken through an instrument that silently skips 30% of the request
 * parameters would record "no refusals" for routes it never checked. Blast
 * radius is shadow-only: neither enforced module (`contacts.ts`,
 * `merchants.ts`) uses a `$ref`'d parameter, so no route that refuses today
 * changes its answer — pinned by `resolves $ref'd parameters` below.
 */
export function resolveParameter(parameter: Json): Json | undefined {
  const ref = parameter.$ref
  if (typeof ref !== 'string') return parameter
  const name = ref.replace('#/components/parameters/', '')
  return spec.components.parameters?.[name]
}

export interface RequestValidationOptions {
  /**
   * Boot-read mode. `off` runs NOTHING anywhere (the global kill switch —
   * `enforcedModules` does not override it, #3032); `shadow` observes
   * everything globally and refuses nothing; `enforce` (the DEFAULT since
   * slice 4's flip) refuses on the modules listed in `enforcedModules` and
   * falls back to shadow behaviour elsewhere — the per-module rollback list.
   */
  mode: RequestValidationMode
  /**
   * Route FILES enforced under `mode: 'enforce'`: the schema is injected and
   * a refusal is the 400 envelope. Keys are `'routes/<file>.ts'`, or the bare
   * `'index.ts'` for the routes declared on the app itself — the same keys the
   * ratchet baseline uses. Two modules sharing a mount prefix flip
   * independently (header § *Why the flip is keyed on the route FILE*).
   *
   * ROLLBACK LIST since the flip (#3032, epic decision 6): with the default
   * `enforce`, deleting an entry returns exactly that module to shadow
   * behaviour — the response to one misbehaving module — instead of a global
   * switch in front of every payment route. Under `off` or `shadow` the list
   * is INERT: those modes are global.
   */
  enforcedModules?: string[]
}

/** One would-be refusal, as the structured log line carries it. */
export interface WouldRefuseEvent {
  event: 'request_validation.would_refuse'
  route: string
  field: string
  message: string
}

/** The `/health/ops` `request_validation` payload: mode, total, per route+field. */
export interface RequestValidationSnapshot {
  mode: RequestValidationMode
  wouldRefuse: number
  /**
   * Top-level body FIELDS ajv rewrote in place and #3082 then restored — one
   * increment PER FIELD, so a single body can move it more than once. That is
   * the unit, and it is why this must never be summed with `wouldRefuse`,
   * which fires at most once per request (`allErrors: false` stops at the
   * first error). One request can do both: ajv rewrites an earlier field and
   * then fails a later one.
   *
   * A refusal is not the only way shadow and enforce diverge. A body ajv made
   * valid by rewriting it raises no would-refusal, yet the handler would
   * receive a DIFFERENT value once the route is enforced. "Rewrote" is wider
   * than type coercion: `useDefaults: true` would inject a spec `default`
   * here too. No request BODY declares one today — all 16 `default:`s in the
   * spec are query parameters — but the counter would catch it if one did. Slices 2–4 flip money-path
   * modules on these readings, so that divergence has to be visible rather
   * than inferred from a comment.
   */
  wouldCoerce: number
  byRouteField: Record<string, number>
  coerceByRouteField: Record<string, number>
  /**
   * When these counters started (the plugin install — one per process), ISO.
   * The counters are in-process and dev redeploys on every merge, so a
   * reading is only as wide as this window (#3208: the 2026-09-21 reading
   * covered five minutes and could not prove a single module).
   */
  since: string
  /**
   * Requests that reached validation, per shadowed route, whatever the
   * verdict (#3208). This is what makes a `wouldRefuse` of zero readable:
   * `seen: 200, refused: 0` is a conformant route; `seen: 0` is a route the
   * window never exercised — NOT PROVEN, never "clean". Keyed on the
   * registered route (`METHOD /path`), so an unknown path never enters the
   * map. Enforced routes are not counted here: they refuse for real and have
   * nothing left to prove.
   */
  seenByRoute: Record<string, number>
}

/**
 * The plugin's own counters — in-process, by design: no generic counter module
 * exists (`modules/accounting/ops-signals.ts` is accounting-scoped and
 * SQL-backed), so the plugin owns its own. Reset at every install, which makes
 * per-suite test apps independent.
 */
const counters = {
  mode: 'off' as RequestValidationMode,
  // The epoch until `installRequestValidation` runs — a sentinel that says
  // "never installed", not a window start; production installs before it
  // listens, so a served snapshot always carries the install time.
  since: new Date(0).toISOString(),
  total: 0,
  byRouteField: new Map<string, number>(),
  coerceTotal: 0,
  coerceByRouteField: new Map<string, number>(),
  seenByRoute: new Map<string, number>(),
  /** Per route, the minute (epoch ms / 60 000) the last `seen` line was logged — the rate limit's state. */
  seenLoggedMinute: new Map<string, number>(),
}

function resetCounters(mode: RequestValidationMode): void {
  counters.mode = mode
  counters.since = new Date().toISOString()
  counters.total = 0
  counters.byRouteField.clear()
  counters.coerceTotal = 0
  counters.coerceByRouteField.clear()
  counters.seenByRoute.clear()
  counters.seenLoggedMinute.clear()
}

/**
 * One `seen` increment per shadowed request, and at most one
 * `request_validation.seen` log line per route per minute carrying the
 * running total (#3208). The line is what lets a reading taken from the log
 * stream — which survives the deploys the in-process map does not — total a
 * route's traffic; the once-a-minute cap keeps a busy route from writing a
 * line per request. Returns the total when a line is due, else null.
 */
function recordSeen(route: string, nowMs: number): number | null {
  const seen = (counters.seenByRoute.get(route) ?? 0) + 1
  counters.seenByRoute.set(route, seen)
  const minute = Math.floor(nowMs / 60_000)
  if (counters.seenLoggedMinute.get(route) === minute) return null
  counters.seenLoggedMinute.set(route, minute)
  return seen
}

function recordWouldRefuse(route: string, field: string): void {
  counters.total += 1
  const key = `${route} ${field}`
  counters.byRouteField.set(key, (counters.byRouteField.get(key) ?? 0) + 1)
}

function recordWouldCoerce(route: string, field: string): void {
  counters.coerceTotal += 1
  const key = `${route} ${field}`
  counters.coerceByRouteField.set(key, (counters.coerceByRouteField.get(key) ?? 0) + 1)
}

/** The top-level body keys ajv rewrote, so a reading names a field, not just a route. */
function coercedFields(original: unknown, coerced: unknown): string[] {
  if (
    original === null ||
    coerced === null ||
    typeof original !== 'object' ||
    typeof coerced !== 'object'
  ) {
    return ['body']
  }
  const keys = new Set([...Object.keys(original), ...Object.keys(coerced)])
  const changed = [...keys].filter(
    (k) =>
      !isDeepStrictEqual(
        (original as Record<string, unknown>)[k],
        (coerced as Record<string, unknown>)[k],
      ),
  )
  return changed.length > 0 ? changed.sort() : ['body']
}

/** What `GET /health/ops` reports under `request_validation` (keys sorted for a stable payload). */
export function requestValidationOpsSnapshot(): RequestValidationSnapshot {
  const byRouteField: Record<string, number> = {}
  for (const key of [...counters.byRouteField.keys()].sort()) {
    byRouteField[key] = counters.byRouteField.get(key) as number
  }
  const coerceByRouteField: Record<string, number> = {}
  for (const key of [...counters.coerceByRouteField.keys()].sort()) {
    coerceByRouteField[key] = counters.coerceByRouteField.get(key) as number
  }
  const seenByRoute: Record<string, number> = {}
  for (const key of [...counters.seenByRoute.keys()].sort()) {
    seenByRoute[key] = counters.seenByRoute.get(key) as number
  }
  return {
    mode: counters.mode,
    wouldRefuse: counters.total,
    wouldCoerce: counters.coerceTotal,
    byRouteField,
    coerceByRouteField,
    since: counters.since,
    seenByRoute,
  }
}

/**
 * The one place the refusal envelope is shaped. Fits the spec's shared
 * `errorResponse` (`additionalProperties: true`), so `error_code` rides along
 * for clients that branch on it without a contract change.
 */
export function requestValidationErrorBody(error: {
  details?: string
  message?: string
}): { error: string; statusCode: 400; details: string; error_code: 'invalid_request' } {
  return {
    error: 'Request does not match the API spec',
    statusCode: 400,
    details: error.details ?? error.message ?? 'the request does not match the spec',
    error_code: 'invalid_request',
  }
}

type ValidationCarrierError = Error & {
  statusCode?: number
  details?: string
  error_code?: 'invalid_request'
  validation?: ErrorObject[]
  validationContext?: string
}

/**
 * `schemaErrorFormatter` for the request edge: ajv's errors joined into the
 * `details` string (`body/amount must match pattern …`). MUST return an Error
 * instance — fastify treats a formatter's plain object as a serialization
 * payload, not an error, and the refusal would 200 (measured, spike 5).
 */
export function requestSchemaErrorFormatter(
  errors: ErrorObject[],
  dataVar: string,
): ValidationCarrierError {
  const details = errors
    .map((e) => `${dataVar}${e.instancePath} ${e.message ?? 'is invalid'}`)
    .join('; ')
  const error = new Error(details) as ValidationCarrierError
  error.statusCode = 400
  error.details = details
  error.error_code = 'invalid_request'
  error.validation = errors
  error.validationContext = dataVar
  return error
}

/**
 * The mode this route was registered under, read off the `config` the
 * `onRoute` hook set at registration. `undefined` for a route the plugin
 * never touched (schema-less, or mode `off` with no matching
 * `enforcedModules` — an enforced module reports `'enforced'` even under
 * `off`).
 */
function routeMode(request: FastifyRequest): 'enforced' | 'shadow' | undefined {
  const config = request.routeOptions.config as
    | { havenRequestValidation?: 'enforced' | 'shadow' }
    | undefined
  return config?.havenRequestValidation
}

/** The `field` a would-refusal names: context plus JSON pointer (`body/amount`). */
function refusalField(error: ValidationCarrierError): string {
  const context = error.validationContext ?? 'request'
  const first = error.validation?.[0]
  // A missing-required error fires on the ROOT object: ajv reports it with an
  // EMPTY instancePath and names the field in `params.missingProperty`. The
  // `additionalProperties: false` refusal has the same shape — empty
  // instancePath, the offending key in `params.additionalProperty` (the x402
  // characterization, #3029). Without these branches every root-object refusal
  // would collapse to the bare context (`body`) and a test could not tell
  // which field the spec refused.
  let pointer = first?.instancePath ?? ''
  if (first && first.instancePath === '' && first.params && typeof first.params === 'object') {
    const params = first.params as Record<string, unknown>
    if (typeof params.missingProperty === 'string') pointer = `/${params.missingProperty}`
    else if (typeof params.additionalProperty === 'string') pointer = `/${params.additionalProperty}`
  }
  return `${context}${pointer}`
}

interface RequestSchema {
  body?: Json
  params?: Json
  querystring?: Json
}

/**
 * Resolve one route's request schema from the spec operation:
 * `requestBody.content['application/json'].schema` → `body`, and the
 * operation's `parameters` (query/path only — headers are out of scope)
 * → `params` / `querystring`. Path-item-level parameters are merged first so
 * an operation-level parameter of the same `name`+`in` overrides it, which is
 * OpenAPI's rule. `null` when the spec describes no request constraints for
 * the operation — the route stays untouched and the ratchet counts the file.
 *
 * `pathItemParameters` is an ARGUMENT, not a field written onto `operation`
 * (#3135). Slice 1 handed them over by setting `operation.__pathItemParameters`
 * and deleting it a line later — a write to the shared, served spec object,
 * which `response-shape.ts:120` forbids for exactly the reason that a
 * concurrent read of `/openapi.json` could observe the scratch field.
 */
export function requestSchemaForOperation(
  operation: Json,
  pathItemParameters?: unknown,
): RequestSchema | null {
  const schema: RequestSchema = {}

  const requestBody = operation.requestBody as Json | undefined
  const bodySchema = (requestBody?.content as Record<string, Json> | undefined)?.[
    'application/json'
  ]?.schema as Json | undefined
  if (bodySchema) schema.body = bodySchema

  // OpenAPI resolution order: path-item parameters first, operation parameters
  // overriding by `name`+`in`.
  const byLocation = new Map<string, Json>()
  const collect = (list: unknown) => {
    if (!Array.isArray(list)) return
    for (const entry of list as Json[]) {
      if (!entry || typeof entry !== 'object') continue
      const parameter = resolveParameter(entry)
      if (!parameter) continue // a $ref the spec does not define — nothing to compile
      const location = parameter.in
      if (location !== 'path' && location !== 'query') continue // headers out of scope
      byLocation.set(`${location} ${String(parameter.name)}`, parameter)
    }
  }
  collect(pathItemParameters)
  collect(operation.parameters)

  const pathProperties: Record<string, Json> = {}
  const pathRequired: string[] = []
  const queryProperties: Record<string, Json> = {}
  const queryRequired: string[] = []
  for (const [locationKey, parameter] of byLocation) {
    const name = String(parameter.name)
    const parameterSchema = (parameter.schema as Json | undefined) ?? { type: 'string' }
    if (locationKey.startsWith('path')) {
      pathProperties[name] = parameterSchema
      if (parameter.required === true) pathRequired.push(name)
    } else {
      queryProperties[name] = parameterSchema
      if (parameter.required === true) queryRequired.push(name)
    }
  }
  if (Object.keys(pathProperties).length > 0) {
    schema.params = { type: 'object', properties: pathProperties }
    if (pathRequired.length > 0) schema.params.required = pathRequired
  }
  if (Object.keys(queryProperties).length > 0) {
    schema.querystring = { type: 'object', properties: queryProperties }
    if (queryRequired.length > 0) schema.querystring.required = queryRequired
  }

  return Object.keys(schema).length > 0 ? schema : null
}

/**
 * The route FILE that declares `(method, openApiPath)`, or `undefined` for an
 * operation the generated table does not know — a route added without
 * regenerating it, which `check:route-modules` and the generated table's own
 * test both redden on.
 *
 * For an ADDED route `undefined` is the safe direction: an unattributed route
 * cannot be enforced, so it keeps shadow-logging rather than refusing traffic
 * nobody flipped. It is NOT one-directional for a MOVED one — move an
 * operation into a new file without regenerating and the stale table still
 * answers the OLD file, so a route in a file nobody listed stays enforced
 * until the table is regenerated. What bounds that is the staleness itself
 * being gated: `check:route-modules` and the drift test both redden on it.
 *
 * One blind spot the table and the ratchet share, because both read the same
 * source: a route registered with a NON-LITERAL path (`app.post(BULK_PATH, …)`)
 * is invisible to `extractRoutes`, so it gets no table entry and can never be
 * enforced even when its file IS listed — while `lint:request-schemas`
 * short-circuits per FILE and would report that file enforced. None exists
 * today (measured across every `routes/*.ts` and `index.ts`). Flipping a
 * module in epic #3028 slices 3–4 should therefore assert the refusal per
 * ROUTE, the way `routes/__tests__/contacts.test.ts` and
 * `routes/__tests__/merchants.test.ts` do, and not per file.
 */
export function routeModuleFor(method: string, openApiPath: string): string | undefined {
  return ROUTE_MODULE_BY_OPERATION[operationKey(method, openApiPath)]
}

/**
 * True when the file declaring this operation is flipped by `enforcedModules`.
 * Exact match on the file key — no prefix or `startsWith` semantics, which is
 * the whole point of the re-key (#3135): `'routes/agents.ts'` must not drag
 * `agent-rekey.ts` along with it just because both mount at `/agents`.
 */
export function moduleIsEnforced(
  module: string | undefined,
  enforcedModules: readonly string[],
): boolean {
  return module !== undefined && enforcedModules.includes(module)
}

/**
 * Install the plugin at ROOT SCOPE. See the header for why it must not be
 * wrapped in an encapsulated plugin, and why it must be called AFTER
 * `app.setErrorHandler` (the enforced-route handler delegates non-validation
 * errors to the handler captured here).
 *
 * Registered by `index.ts` and by route tests, never inline — tests test
 * production wiring.
 */
export function installRequestValidation(app: FastifyInstance, options: RequestValidationOptions): void {
  const { mode, enforcedModules = [] } = options
  resetCounters(mode)

  // The request-side ajv — Fastify's request defaults, NO closeObjects (the
  // epic's settled "two ajv instances, one factory" decision; see ajv.ts).
  // The spec's component schemas are registered UNCLOSED so an operation whose
  // requestBody is a `$ref` (`/x402/authorize` → X402AuthorizeRequest) compiles
  // — without them fastify's boot fails with "can't resolve reference", and the
  // contacts module hid this because its bodies are inline. The factory's
  // `closeObjects: false` branch copies each definition; the served
  // /openapi.json object is never mutated.
  const requestAjv = makeSpecAjv({ ...REQUEST_AJV_OPTIONS, closeObjects: false }, spec.components.schemas)

  // RAW validate fn, never a wrapper — the `.errors` contract (header § spike).
  app.setValidatorCompiler(({ schema }) => requestAjv.compile(schema as Json))
  app.setSchemaErrorFormatter((errors, dataVar) =>
    requestSchemaErrorFormatter(errors as ErrorObject[], dataVar),
  )

  const appErrorHandler = app.errorHandler

  /** The enforce-mode error handler, set per route via onRoute. */
  const enforcedErrorHandler = function requestValidationErrorHandler(
    error: FastifyError,
    request: FastifyRequest,
    reply: Parameters<Parameters<FastifyInstance['setErrorHandler']>[0]>[2],
  ): void {
    if (error.code !== 'FST_ERR_VALIDATION') {
      // Everything this layer did not refuse keeps the app's existing answer —
      // the 22P02 400 body (#1464) included. Delegation, not duplication.
      ;(appErrorHandler as (...args: unknown[]) => void)(error, request, reply)
      return
    }
    const route = `${request.routeOptions.method} ${request.routeOptions.url}`
    const field = refusalField(error as unknown as ValidationCarrierError)
    request.log.warn({ event: 'request_validation.refused', route, field }, 'request_validation.refused')
    reply.code(error.statusCode ?? 400).send(requestValidationErrorBody(error))
  }

  app.addHook('onRoute', (routeOptions: RouteOptions) => {
    if (routeOptions.method === 'HEAD') return // the auto-generated HEAD twin adds nothing
    if (routeOptions.schema && Object.keys(routeOptions.schema).length > 0) return // never clobber a route's own schema

    // `prefix` and `routePath` are set by fastify's own route() before onRoute
    // runs (lib/route.js) but are missing from its RouteOptions type.
    //
    // `routePath`, never `path`: fastify sets `path = prefix + path` BEFORE the
    // onRoute hooks run (lib/route.js addNewRoute), so `path` would double the
    // prefix, resolve zero operations and read a false zero. Measured again on
    // fastify 5.8.5 for #3135: a route declared at `'/'` under a prefix arrives
    // with `routePath === ''` (not `'/'`), which `fastifyPathToOpenApi` maps to
    // the bare prefix — the spec key.
    const ro = routeOptions as RouteOptions & { prefix?: string; routePath?: string }
    const prefix = ro.prefix ?? ''
    const openApiPath = fastifyPathToOpenApi(prefix, ro.routePath ?? routeOptions.url)
    const method = String(routeOptions.method).toLowerCase()

    // The enforcement decision after the flip (#3032, epic #3028 slice 4):
    //
    //   mode `off`     — the GLOBAL kill switch: nothing runs, and an entry in
    //                    `enforcedModules` does NOT override it. An operator
    //                    setting `off` is stopping the layer outright — a list
    //                    that silently re-enforced 36 route files behind their
    //                    back would make the switch lie.
    //   mode `shadow`  — the GLOBAL observation switch: every constrained
    //                    route logs and continues, listed or not.
    //   mode `enforce` — the DEFAULT since the flip: listed modules refuse
    //                    (the 400 envelope); an unlisted module falls back to
    //                    observation, which is the per-module ROLLBACK (epic
    //                    decision 6): removing one file from the list returns
    //                    exactly that module to shadow behaviour without a
    //                    global switch in front of every payment route.
    //
    // Before the flip the list overrode every mode (slice 1–3 semantics — the
    // proof module had to refuse while the world was still in shadow — pinned
    // then by tests that this slice re-pins); the flip is what makes the
    // issue's "kill switches — global" true.
    if (mode === 'off') return
    const enforced = mode === 'enforce' && moduleIsEnforced(routeModuleFor(method, openApiPath), enforcedModules)

    const pathItem = spec.paths[openApiPath]
    const operation = pathItem?.[method] as Json | undefined
    if (!operation) return // no spec operation — no schema; the ratchet counts the file under `unspecced` (#1443 covers spec-presence)

    // Path-item parameters live one level above the operation and are passed
    // as an ARGUMENT — nothing here writes to the served spec object (#3135).
    const requestSchema = requestSchemaForOperation(operation, pathItem.parameters)
    if (!requestSchema) return

    routeOptions.schema = requestSchema as RouteOptions['schema']
    if (enforced) {
      routeOptions.errorHandler = enforcedErrorHandler
    } else {
      // shadow: fastify hands the refusal to the handler as request.validationError
      routeOptions.attachValidation = true
    }
    routeOptions.config = {
      ...(routeOptions.config ?? {}),
      havenRequestValidation: enforced ? 'enforced' : 'shadow',
    }
  })

  // ── Shadow must not CHANGE the request it is only supposed to observe (#3082) ──
  //
  // The schema above is attached in shadow mode too, and `REQUEST_AJV_OPTIONS`
  // sets `coerceTypes: 'array'`. ajv coerces IN PLACE, so validating for
  // measurement rewrites the very payload the handler then reads. Shadow's
  // documented promise — "no behaviour change on any currently-accepted
  // request" — was false: `{"recipient_address": null}` reached
  // `routes/agent-delegations.ts` as `""`, whose `!= null` guard then refused
  // every OPEN budget with a 400. That is how #3082 blocked agent onboarding
  // on dev, while the layer reported itself as observation-only.
  //
  // Snapshot before validation, restore after it. Not a validator wrapper:
  // fastify reads `.errors` off the raw ajv function it compiled
  // (`validateParam`, lib/validation.js:139), and a closure owning no
  // `.errors` makes refusals pass SILENTLY — measured in spikes 3–4 and the
  // reason `setValidatorCompiler` above returns the raw fn. Hooks leave that
  // contract untouched.
  //
  // BODY ONLY, deliberately. Querystring, params and headers arrive as
  // strings on the wire, so coercion is what makes a typed spec parameter
  // usable at all, and the handler is MEANT to see the coerced value —
  // `?limit=10` reaching a handler as the number 10 is pinned by
  // `__tests__/request-validation.test.ts`. A JSON body is already typed by
  // `JSON.parse`; coercing it only ever rewrites what the client actually
  // sent.
  //
  // Enforce mode still coerces the body. That is deliberate and visible: an
  // enforced route ANSWERS on the validation result, so the coerced value is
  // part of a contract a client can see and test, not a silent edit made
  // while claiming to measure. Slices 2–4 flip routes to enforce one module
  // at a time and should read this note before each flip.
  const BODY_SNAPSHOT = Symbol.for('haven.requestValidation.bodySnapshot')

  app.addHook('preValidation', (request: FastifyRequest, _reply, done) => {
    if (routeMode(request) !== 'shadow') return done()
    // The traffic half of a reading (#3208): every shadowed request counts,
    // before the verdict, so a route's zero refusals can be read against
    // how many requests it saw.
    {
      const route = `${request.routeOptions.method} ${request.routeOptions.url}`
      const total = recordSeen(route, Date.now())
      if (total !== null) {
        request.log.info({ event: 'request_validation.seen', route, seen: total }, 'request_validation.seen')
      }
    }
    const body: unknown = request.body
    // Only a structured body can be coerced into a different one; a string or
    // binary body has no properties for ajv to rewrite. Buffer AND every
    // other ArrayBuffer view are excluded explicitly: `structuredClone` turns
    // a Buffer into a plain `Uint8Array`, whose `toString('utf8')` ignores its
    // argument and answers the byte VALUES joined by commas — the snapshot
    // would then "restore" those comma digits over the real body and every
    // raw-body consumer (the Accounted webhook HMAC, #3019) would read bytes
    // the client never sent. `typeof body === 'object'` alone does not see
    // this: a Buffer IS an object.
    if (body === null || typeof body !== 'object' || Buffer.isBuffer(body) || ArrayBuffer.isView(body)) return done()
    try {
      ;(request as FastifyRequest & { [k: symbol]: unknown })[BODY_SNAPSHOT] = structuredClone(body)
    } catch {
      // A body carrying something structuredClone refuses is not something
      // ajv's scalar coercion rewrites either. Skipping the snapshot leaves
      // the request exactly as it is today rather than failing it.
    }
    done()
  })

  // One structured line per would-be refusal, then the request continues on
  // its normal path. Runs on every route; the guard makes it a no-op for
  // schema-less and enforce-mode routes (fastify only sets `validationError`
  // when attachValidation let it attach).
  app.addHook('preHandler', (request: FastifyRequest, _reply, done) => {
    // Restore FIRST: every later hook and the handler itself must see the
    // client's body, not ajv's edit of it. NOTE for future hooks: nothing
    // registered after this snapshot may mutate `request.body` — the restore
    // below would silently revert it. There are no route-level
    // `preValidation` hooks in this package today; if one is added, it must
    // run before the snapshot or not touch the body.
    const carrier = request as FastifyRequest & { [k: symbol]: unknown }
    if (BODY_SNAPSHOT in carrier) {
      const original = carrier[BODY_SNAPSHOT]
      const coerced = request.body
      request.body = original
      delete carrier[BODY_SNAPSHOT]

      // A refusal is not the only divergence between shadow and enforce. A
      // COERCIBLE off-spec body validates clean — no would-refusal, nothing
      // logged — and yet the handler would receive a different value the
      // moment the route is enforced: `period_seconds: "86400"` becomes an
      // integer, a numeric `budget_atomic` becomes a string, a one-element
      // array is unwrapped. Restoring the body is what makes that silent, so
      // the same snapshot is used to measure it. Epic #3028 flips money-path
      // modules on these readings; this is the reading.
      if (!isDeepStrictEqual(original, coerced)) {
        const route = `${request.routeOptions.method} ${request.routeOptions.url}`
        for (const field of coercedFields(original, coerced)) {
          request.log.info(
            { event: 'request_validation.would_coerce', route, field },
            'request_validation.would_coerce',
          )
          recordWouldCoerce(route, field)
        }
      }
    }
    const validationError = (request as FastifyRequest & { validationError?: ValidationCarrierError })
      .validationError
    if (validationError) {
      const route = `${request.routeOptions.method} ${request.routeOptions.url}`
      const field = refusalField(validationError)
      const message = validationError.message ?? 'the request does not match the spec'
      request.log.info(
        { event: 'request_validation.would_refuse', route, field, message } satisfies WouldRefuseEvent,
        'request_validation.would_refuse',
      )
      recordWouldRefuse(route, field)
    }
    done()
  })
}
