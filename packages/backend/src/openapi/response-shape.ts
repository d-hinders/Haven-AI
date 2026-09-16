/**
 * Validate a real response against the shape the OpenAPI spec promises.
 *
 * #1444 (epic #1442). `check:api-types` compares the spec to the types
 * generated FROM that spec — both sides derive from one file, so they agree by
 * construction even when the spec describes a shape no route returns. Nothing
 * compared the spec to the actual response. This closes that boundary: a route
 * test hands its real payload to `expectMatchesSpec` and the spec's own schema
 * decides.
 *
 * Strict where the spec lets it be. `additionalProperties: false` is injected
 * into every object schema that does not state a preference, so an undeclared
 * field is a failure rather than a shrug. **A schema that explicitly sets
 * `additionalProperties: true` keeps it** — several do, `Agent` among them, and
 * for those an undeclared field is permitted BY THE CONTRACT and this helper
 * will not flag it. That is the spec's decision to make, not this file's; what
 * still bites everywhere is a missing required field, a wrong type, a bad enum
 * value, and (since `ajv-formats` is wired) a malformed uuid or timestamp.
 *
 * OpenAPI 3.1 schemas are JSON Schema 2020-12, so this uses ajv's 2020 entry
 * point rather than the draft-07 default.
 */

// ajv construction lives in `openapi/ajv.ts` (#3029) — the one factory shared
// with the request-validation plugin. The options and `closeObjects` behaviour
// here are UNCHANGED from the pre-#3029 instrument; only the construction site
// moved. The response instance keeps `{ strict: false, allErrors: true }` and
// the component schemas registered CLOSED — the request side uses the same
// factory with Fastify's request defaults and open objects, which is exactly
// why they must be two instances.
import { makeSpecAjv, closeObjects, type ErrorObject, type ValidateFunction } from './ajv.js'
import { openapiSpec } from './spec.js'

type Json = Record<string, unknown>

/** The spec object, typed loosely — it is a literal, not a generated model. */
const spec = openapiSpec as unknown as {
  paths: Record<string, Record<string, Json>>
  components: { schemas: Record<string, Json> }
}

const ajv = makeSpecAjv(
  { strict: false, allErrors: true, closeObjects: true },
  spec.components.schemas,
)

/**
 * Resolve the response schema the spec declares for one operation.
 *
 * Throws rather than returning null when the operation or its schema is
 * missing: a test asking about a response the spec does not describe has found
 * a real gap, and silently skipping would make this helper a gate that cannot
 * fail — the failure mode #1443's guard test exists to prevent.
 */
export function responseSchema(
  method: string,
  path: string,
  status: string = '200',
): Json {
  const pathItem = spec.paths[path]
  if (!pathItem) {
    throw new Error(`OpenAPI spec has no path '${path}'. Documented paths are the contract — add it, or fix the test.`)
  }
  const operation = pathItem[method.toLowerCase()]
  if (!operation) {
    throw new Error(`OpenAPI spec has no ${method.toUpperCase()} operation for '${path}'.`)
  }
  const responses = operation.responses as Record<string, Json> | undefined
  const response = responses?.[status]
  if (!response) {
    throw new Error(`OpenAPI spec declares no '${status}' response for ${method.toUpperCase()} ${path}.`)
  }
  const content = response.content as Record<string, Json> | undefined
  const schema = content?.['application/json']?.schema as Json | undefined
  if (!schema) {
    throw new Error(
      `OpenAPI spec declares a '${status}' response for ${method.toUpperCase()} ${path} ` +
        'without an application/json schema — nothing to validate against.',
    )
  }
  return schema
}

/**
 * Every `#/components/schemas/*` is registered — CLOSED — by `makeSpecAjv` at
 * construction (#3029); compiling a schema here reuses them so `$ref` resolves.
 * Compiled lazily and once — ajv rejects duplicate schema ids.
 */
let compiledFor: Map<string, ValidateFunction> | null = null

function compile(schema: Json): ValidateFunction {
  if (!compiledFor) compiledFor = new Map()
  const key = JSON.stringify(schema)
  const existing = compiledFor.get(key)
  if (existing) return existing
  const validate = ajv.compile(closeObjects(schema) as Json)
  compiledFor.set(key, validate)
  return validate
}

/**
 * `closeObjects` itself moved to `openapi/ajv.ts` (#3029) — imported at the top
 * of this file and applied on registration and compile exactly as before.
 * Re-exported for the composition tests only — not part of the assertion API.
 */
export const __closeObjectsForTest = closeObjects

export interface ShapeMismatch {
  /** JSON pointer into the payload, e.g. `/agents/0/status`. */
  at: string
  problem: string
}

/** Validate `payload`; returns [] when it matches the spec's schema. */
export function matchSpec(schema: Json, payload: unknown): ShapeMismatch[] {
  const validate = compile(schema)
  if (validate(payload)) return []
  return (validate.errors ?? []).map((e: ErrorObject) => ({
    at: e.instancePath || '/',
    problem: `${e.message ?? 'invalid'}${
      e.params && 'additionalProperty' in e.params
        ? ` ('${String((e.params as { additionalProperty: string }).additionalProperty)}')`
        : ''
    }`,
  }))
}

/**
 * Assert a route's real response matches what the spec promises for it.
 *
 * Usage in a route test, after `app.inject`:
 *
 *   expectMatchesSpec('GET', '/agents', response.json())
 *
 * Failure prints the JSON pointer and the reason for every mismatch, so the
 * message names the field rather than the fact that something disagreed.
 */
export function expectMatchesSpec(
  method: string,
  path: string,
  payload: unknown,
  status: string = '200',
): void {
  const mismatches = matchSpec(responseSchema(method, path, status), payload)
  if (mismatches.length === 0) return

  const detail = mismatches.map((m) => `  ${m.at}: ${m.problem}`).join('\n')
  throw new Error(
    `Response from ${method.toUpperCase()} ${path} does not match the '${status}' schema ` +
      `in openapi/spec.ts:\n${detail}\n\n` +
      'Either the route changed and the spec is now a lie, or the spec was always wrong. ' +
      'Fix whichever is untrue — do not loosen the schema to make this pass.',
  )
}

/**
 * Assert a request the spec refuses IS refused, with the plugin's envelope.
 *
 * The request-side twin of `expectMatchesSpec` (#3029): a route test hands it
 * the app, an off-spec body, and the field the spec's own schema should name,
 * and the assertion fails unless the answer is the 400
 * `{ error, statusCode: 400, details, error_code: 'invalid_request' }` the
 * request-validation plugin produces on an enforced route. Used per handler on
 * the proof module (`routes/contacts.ts` first); like `expectMatchesSpec`, the
 * spec's own schema decides — this helper never restates a rule.
 *
 * `expectedField` is matched against the start of `details` (e.g. `body/address`),
 * so a refusal caused by a DIFFERENT field fails the test rather than passing
 * for the wrong reason.
 */
export function expectRejectsOffSpec(
  app: { inject: (opts: { method: string; url: string; payload?: unknown; headers?: Record<string, string> }) => Promise<{ statusCode: number; json(): unknown }> },
  route: string,
  body: unknown,
  expectedField: string,
  headers: Record<string, string> = {},
): Promise<void> {
  const [method, ...pathParts] = route.split(' ')
  return app
    .inject({ method, url: pathParts.join(' '), payload: body, headers })
    .then((response) => {
      const problems: string[] = []
      if (response.statusCode !== 400) {
        problems.push(`expected 400, got ${response.statusCode}`)
      }
      const payload = response.json() as Record<string, unknown>
      if (payload.error !== 'Request does not match the API spec') {
        problems.push(`expected the plugin's envelope error, got ${JSON.stringify(payload.error)}`)
      }
      if (payload.error_code !== 'invalid_request') {
        problems.push(`expected error_code 'invalid_request', got ${JSON.stringify(payload.error_code)}`)
      }
      const details = typeof payload.details === 'string' ? payload.details : ''
      if (!details.startsWith(expectedField)) {
        problems.push(`expected details to name '${expectedField}', got ${JSON.stringify(details)}`)
      }
      if (problems.length > 0) {
        throw new Error(
          `${route} did not refuse the off-spec body the way the request-validation ` +
            `plugin refuses it:\n  ${problems.join('\n  ')}\n\n` +
            'Either the plugin is not installed on this test app with the module enforced, ' +
            'or the spec stopped describing the request the handler actually accepts. ' +
            'Fix the wiring or the spec — do not weaken the assertion.',
        )
      }
    })
}
