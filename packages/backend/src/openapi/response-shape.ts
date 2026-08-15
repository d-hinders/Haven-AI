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
 * Deliberately strict. `additionalProperties: false` is injected into every
 * object schema that does not set it, so a field the route returns and the spec
 * never declared is a failure rather than a shrug — undeclared fields are
 * exactly the drift a consumer generating types from the spec cannot see.
 * A schema that genuinely wants to be open says so explicitly and keeps it.
 *
 * OpenAPI 3.1 schemas are JSON Schema 2020-12, so this uses ajv's 2020 entry
 * point rather than the draft-07 default.
 */

import Ajv2020, { type ErrorObject, type ValidateFunction } from 'ajv/dist/2020'
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
      ajv.addSchema(closeObjects(definition), `#/components/schemas/${name}`)
    }
  }
  const key = JSON.stringify(schema)
  const existing = compiledFor.get(key)
  if (existing) return existing
  const validate = ajv.compile(closeObjects(schema))
  compiledFor.set(key, validate)
  return validate
}

/**
 * Add `additionalProperties: false` to every object schema that does not state
 * a preference, recursively. Returns a copy — the spec object is shared with
 * the served `/openapi.json` and must never be mutated by a test helper.
 */
function closeObjects(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(closeObjects)
  if (node === null || typeof node !== 'object') return node

  const copy: Json = {}
  for (const [key, value] of Object.entries(node as Json)) {
    copy[key] = closeObjects(value)
  }
  const declaresProperties = 'properties' in copy
  const statesPreference = 'additionalProperties' in copy
  // Only close schemas that actually describe an object's properties; leaving
  // `anyOf`/`$ref` wrappers alone keeps composition working.
  if (declaresProperties && !statesPreference) {
    copy.additionalProperties = false
  }
  return copy
}

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
