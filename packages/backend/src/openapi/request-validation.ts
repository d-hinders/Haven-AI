/**
 * Validate every route's request against the OpenAPI spec at runtime
 * (#3029, epic #3028 slice 1).
 *
 * The spec declares machine-readable request constraints that nothing
 * enforced — the one boundary of the API contract with neither runtime nor
 * test enforcement, and it fronts the money path. The spec was largely
 * backfilled (#1446): it describes what routes were BELIEVED to accept, not
 * what installed clients send (the first proof is already live —
 * `X402AuthorizeRequest` is `additionalProperties: false` and does not declare
 * `settlementScheme`, which the shipped SDK sends). So enforcement lands
 * BEHIND A MODE, shadow-first (owner decision #2, epic #3028):
 *
 *   off     — nothing runs: no schema is injected, no route is observed
 *   shadow  — every route's request is compiled against the spec; a refusal is
 *             logged once (`request_validation.would_refuse`) and counted, and
 *             the request CONTINUES on the normal path — no behaviour change on
 *             any currently-accepted request
 *   enforce — a refused request gets the 400 envelope instead of the route
 *
 * Per-module `enforcedPrefixes` flips a module regardless of the mode (the
 * proof module rides this in slice 1); slices 2–4 flip the rest after their
 * shadow counters have been read on dev.
 *
 * This is a VALIDATOR, nothing more (CASP, docs/regulatory/casp-risk-guardrails.md):
 * it reads shape, refuses or logs, and never authorizes, alters, or constructs
 * spend intent. Every semantic refusal on the money path — the rail seam's 410,
 * the budget pre-check, the token resolution — keeps its exact position and
 * body; this layer only answers BEFORE them for requests the spec already
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
import type { FastifyError, FastifyInstance, FastifyRequest, RouteOptions } from 'fastify'
import { makeSpecAjv, REQUEST_AJV_OPTIONS, type ErrorObject } from './ajv.js'
import { fastifyPathToOpenApi } from './route-inventory.js'
import { openapiSpec } from './spec.js'
import type { RequestValidationMode } from '../config.js'

type Json = Record<string, unknown>

/** The spec object, typed loosely — it is a literal, not a generated model. */
const spec = openapiSpec as unknown as {
  paths: Record<string, Record<string, Json>>
  components: { schemas: Record<string, Json> }
}

export interface RequestValidationOptions {
  /** Boot-read mode. `off` observes nothing; `shadow` logs and continues; `enforce` refuses. */
  mode: RequestValidationMode
  /**
   * Module mount prefixes flipped to enforce REGARDLESS of the mode (and
   * regardless of `off`): the schema is injected and a refusal is the 400
   * envelope. Slice 1 pins exactly one: the contacts proof module.
   */
  enforcedPrefixes?: string[]
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
  byRouteField: Record<string, number>
}

/**
 * The plugin's own counters — in-process, by design: no generic counter module
 * exists (`modules/accounting/ops-signals.ts` is accounting-scoped and
 * SQL-backed), so the plugin owns its own. Reset at every install, which makes
 * per-suite test apps independent.
 */
const counters = {
  mode: 'off' as RequestValidationMode,
  total: 0,
  byRouteField: new Map<string, number>(),
}

function resetCounters(mode: RequestValidationMode): void {
  counters.mode = mode
  counters.total = 0
  counters.byRouteField.clear()
}

function recordWouldRefuse(route: string, field: string): void {
  counters.total += 1
  const key = `${route} ${field}`
  counters.byRouteField.set(key, (counters.byRouteField.get(key) ?? 0) + 1)
}

/** What `GET /health/ops` reports under `request_validation` (keys sorted for a stable payload). */
export function requestValidationOpsSnapshot(): RequestValidationSnapshot {
  const byRouteField: Record<string, number> = {}
  for (const key of [...counters.byRouteField.keys()].sort()) {
    byRouteField[key] = counters.byRouteField.get(key) as number
  }
  return { mode: counters.mode, wouldRefuse: counters.total, byRouteField }
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

/** The `field` a would-refusal names: context plus JSON pointer (`body/amount`). */
function refusalField(error: ValidationCarrierError): string {
  const context = error.validationContext ?? 'request'
  const first = error.validation?.[0]
  // A missing-required error fires on the ROOT object: ajv reports it with an
  // EMPTY instancePath and names the field in `params.missingProperty`. Without
  // this branch every "required" refusal would collapse to the bare context
  // (`body`) and a test could not tell which field the spec refused.
  const pointer =
    first && first.instancePath === '' && typeof first.params?.missingProperty === 'string'
      ? `/${first.params.missingProperty}`
      : (first?.instancePath ?? '')
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
 */
export function requestSchemaForOperation(operation: Json): RequestSchema | null {
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
    for (const parameter of list as Json[]) {
      if (!parameter || typeof parameter !== 'object') continue
      const location = parameter.in
      if (location !== 'path' && location !== 'query') continue // headers out of scope
      byLocation.set(`${location} ${String(parameter.name)}`, parameter)
    }
  }
  collect(operation.__pathItemParameters)
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
 * True when the module mounted at `prefix` is flipped by `enforcedPrefixes`.
 * A listed prefix matches its own mount exactly (the module registration is
 * the unit — `catalogRoutes` and `catalogSubmissionRoutes` share `/catalog`
 * and flip together) and, defensively, anything mounted beneath it.
 */
export function prefixIsEnforced(prefix: string, enforcedPrefixes: readonly string[]): boolean {
  return enforcedPrefixes.some((p) => prefix === p || prefix.startsWith(`${p}/`))
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
  const { mode, enforcedPrefixes = [] } = options
  resetCounters(mode)

  // The request-side ajv — Fastify's request defaults, NO closeObjects (the
  // epic's settled "two ajv instances, one factory" decision; see ajv.ts).
  const requestAjv = makeSpecAjv({ ...REQUEST_AJV_OPTIONS, closeObjects: false })

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
    const ro = routeOptions as RouteOptions & { prefix?: string; routePath?: string }
    const prefix = ro.prefix ?? ''
    const enforced = prefixIsEnforced(prefix, enforcedPrefixes)
    if (mode === 'off' && !enforced) return

    const openApiPath = fastifyPathToOpenApi(prefix, ro.routePath ?? routeOptions.url)
    const method = String(routeOptions.method).toLowerCase()
    const pathItem = spec.paths[openApiPath]
    const operation = pathItem?.[method] as Json | undefined
    if (!operation) return // no spec operation — no schema; the ratchet counts the file (#1443 covers spec-presence)

    // Expose path-item parameters to the resolver (they live on the pathItem,
    // one level above the operation).
    operation.__pathItemParameters = pathItem.parameters
    const requestSchema = requestSchemaForOperation(operation)
    delete operation.__pathItemParameters
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

  // One structured line per would-be refusal, then the request continues on
  // its normal path. Runs on every route; the guard makes it a no-op for
  // schema-less and enforce-mode routes (fastify only sets `validationError`
  // when attachValidation let it attach).
  app.addHook('preHandler', (request: FastifyRequest, _reply, done) => {
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
