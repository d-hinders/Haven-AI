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

// Two interop details, both load-bearing under `moduleResolution: NodeNext`:
// the `.js` extension (a bare `ajv/dist/2020` does not resolve, and would throw
// at runtime in plain node), and the NAMED `Ajv2020` import — ajv sets
// `module.exports = Ajv2020` on a CJS module, so the default import is typed as
// the namespace and is not constructable.
import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js'
import addFormatsModule, { type FormatsPlugin } from 'ajv-formats'
import { openapiSpec } from './spec.js'

type Json = Record<string, unknown>

/** The spec object, typed loosely — it is a literal, not a generated model. */
const spec = openapiSpec as unknown as {
  paths: Record<string, Record<string, Json>>
  components: { schemas: Record<string, Json> }
}

const ajv = new Ajv2020({
  strict: false, // OpenAPI keywords (`example`, `discriminator`) are not JSON Schema
  allErrors: true,
})
// Without this, `format: 'uuid'` / `'date-time'` are silently IGNORED — ajv logs
// "unknown format … ignored" and validates nothing. A spec that promises a uuid
// and a route that returns "banana" would have passed.
// ajv-formats is CJS (`module.exports = plugin`, with a `.default` alias), so
// under NodeNext the default import is typed as the namespace rather than the
// callable. Both shapes point at the same function at runtime.
const addFormats: FormatsPlugin =
  (addFormatsModule as unknown as { default?: FormatsPlugin }).default ??
  (addFormatsModule as unknown as FormatsPlugin)
addFormats(ajv)

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
 * Every `#/components/schemas/*` the spec defines, registered so `$ref`
 * resolves. Compiled lazily and once — ajv rejects duplicate schema ids.
 */
let compiledFor: Map<string, ValidateFunction> | null = null

function compile(schema: Json): ValidateFunction {
  if (!compiledFor) {
    compiledFor = new Map()
    for (const [name, definition] of Object.entries(spec.components.schemas)) {
      ajv.addSchema(closeObjects(definition) as Json, `#/components/schemas/${name}`)
    }
  }
  const key = JSON.stringify(schema)
  const existing = compiledFor.get(key)
  if (existing) return existing
  const validate = ajv.compile(closeObjects(schema) as Json)
  compiledFor.set(key, validate)
  return validate
}

/**
 * Add `additionalProperties: false` to every object schema that does not state
 * a preference, recursively. Returns a copy — the spec object is shared with
 * the served `/openapi.json` and must never be mutated by a test helper.
 *
 * **Never inside an `allOf`.** This is the classic JSON Schema composition
 * trap: `additionalProperties` only sees the properties declared at its OWN
 * level, so closing one `allOf` member makes it reject the properties its
 * sibling members contribute — and a payload that is perfectly valid gets
 * reported as a spec violation. The spec has such shapes today (`mpp`,
 * `AgentConnectionAllowance`); none is on a route asserted here yet, so the
 * bug would have lain dormant until someone widened coverage and hit a
 * baffling false failure. A schema composed with `allOf` is left open.
 */
function closeObjects(node: unknown, insideAllOf: boolean = false): unknown {
  if (Array.isArray(node)) return node.map((item) => closeObjects(item, insideAllOf))
  if (node === null || typeof node !== 'object') return node

  const copy: Json = {}
  for (const [key, value] of Object.entries(node as Json)) {
    copy[key] = closeObjects(value, key === 'allOf')
  }
  const declaresProperties = 'properties' in copy
  const statesPreference = 'additionalProperties' in copy
  const composes = 'allOf' in copy
  // Only close schemas that actually describe an object's properties on their
  // own; leaving `anyOf`/`$ref` wrappers and `allOf` composition alone keeps
  // composed shapes valid.
  if (declaresProperties && !statesPreference && !composes && !insideAllOf) {
    copy.additionalProperties = false
  }
  return copy
}

/** Exported for the composition tests only — not part of the assertion API. */
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
