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
 *             any currently-accepted request. That last clause was ASPIRATIONAL
 *             until #3082: ajv's `coerceTypes` rewrites the body in place, so
 *             shadow was editing the payload it claimed only to measure and a
 *             `null` reached handlers as `''`. It is now enforced for the
 *             request BODY by a snapshot/restore pair (see the hooks below),
 *             not merely stated. Querystring and params coercion deliberately
 *             stays, so the promise still reads narrower than it sounds — and
 *             a body that coercion made VALID is now counted as
 *             `request_validation.would_coerce` rather than passing unseen.
 *   enforce — a refused request gets the 400 envelope instead of the route
 *
 * Per-module `enforcedPrefixes` flips a module regardless of the mode (the
 * proof module rides this in slice 1); slices 2–4 flip the rest after their
 * shadow counters have been read on dev.
 *
 * This is a VALIDATOR, nothing more (CASP, docs/regulatory/casp-risk-guardrails.md):
 * it reads shape, refuses or logs, and never authorizes or constructs spend
 * intent. It did once ALTER a request, and that is worth stating precisely
 * rather than leaving the older absolute wording to contradict the note below:
 * ajv's spec-declared scalar coercion rewrites values in place. Since #3082 a
 * shadow-mode BODY is restored before the handler sees it; coercion of
 * querystring and params (and of an enforce-mode body) remains, deliberately,
 * because a typed spec parameter is unusable without it and an enforced route
 * answers on the result. No coercion has ever touched spend intent: the
 * semantic money-path refusals keep their exact position and body. Every semantic refusal on the money path — the rail seam's 410,
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
import { isDeepStrictEqual } from 'node:util'
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
  /**
   * Bodies shadow COERCED and then restored (#3082). A refusal is not the only
   * way shadow and enforce diverge: a body that coercion alone made valid
   * raises no would-refusal, yet the handler would receive a DIFFERENT value
   * once the route is enforced. NOT mutually exclusive with `wouldRefuse`, and
   * the two must never be summed as "requests affected": ajv coerces field by
   * field, so one request can coerce an earlier field and still be refused on
   * a later one, moving both counters. Slices 2–4 flip money-path
   * modules on these readings, so that divergence has to be visible rather
   * than inferred from a comment.
   */
  wouldCoerce: number
  byRouteField: Record<string, number>
  coerceByRouteField: Record<string, number>
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
  coerceTotal: 0,
  coerceByRouteField: new Map<string, number>(),
}

function resetCounters(mode: RequestValidationMode): void {
  counters.mode = mode
  counters.total = 0
  counters.byRouteField.clear()
  counters.coerceTotal = 0
  counters.coerceByRouteField.clear()
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
  return {
    mode: counters.mode,
    wouldRefuse: counters.total,
    wouldCoerce: counters.coerceTotal,
    byRouteField,
    coerceByRouteField,
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
 * never touched (schema-less, or mode `off`).
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
    const body: unknown = request.body
    // Only a structured body can be coerced into a different one; a string or
    // Buffer body has no properties for ajv to rewrite.
    if (body === null || typeof body !== 'object') return done()
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
