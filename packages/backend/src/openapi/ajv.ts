/**
 * The one place ajv instances are built against the OpenAPI spec.
 *
 * Two consumers, two configurations, one factory (#3029, epic #3028):
 *
 *   response-side (`openapi/response-shape.ts`) — `{ strict: false, allErrors:
 *   true }` plus `closeObjects`, so a test assertion fails on every undeclared
 *   field at once.
 *
 *   request-side (`openapi/request-validation.ts`) — Fastify's own request
 *   defaults (`coerceTypes: 'array'`, `useDefaults: true`,
 *   `removeAdditional: false`, `allErrors: false`) and NO `closeObjects`: a
 *   request body is closed only where the spec says `additionalProperties:
 *   false`. Sharing the response instance would close every `$ref`-ed request
 *   body AND refuse typed query/path parameters (the wire carries strings) —
 *   manufacturing exactly the breakage the shadow exists to catch.
 *
 * The split is the settled mechanism decision (epic § Mechanism, "Two ajv
 * instances, one factory"); this module exists so the two instances cannot
 * drift apart in HOW they are built — the CJS interop for `ajv-formats`, the
 * 2020 entry point, and the component-schema registration live here once.
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

type Json = Record<string, unknown>

export interface SpecAjvOptions {
  /** ajv constructor options. Defaults below exist so `makeSpecAjv()` is usable bare. */
  strict?: boolean
  allErrors?: boolean
  coerceTypes?: boolean | 'array'
  useDefaults?: boolean
  removeAdditional?: boolean | 'all' | 'failing'
  /** Apply `closeObjects` (additionalProperties: false) to object schemas stating no preference. */
  closeObjects?: boolean
}

/** The default `{ strict: false, allErrors: true }` of the response-side instance. */
const RESPONSE_DEFAULTS = { strict: false, allErrors: true } as const

/** Fastify's request-validation defaults, per the epic's settled mechanism. */
export const REQUEST_AJV_OPTIONS = {
  strict: false,
  allErrors: false,
  coerceTypes: 'array',
  useDefaults: true,
  removeAdditional: false,
} as const

/** True when `makeSpecAjv` should inject `additionalProperties: false`. */
function wantsCloseObjects(options: SpecAjvOptions): boolean {
  // Explicit false wins; everything else (undefined included) is the response
  // side's historical behaviour, because the factory's first consumer is the
  // response-shape instrument and its 26 test files must not move.
  return options.closeObjects !== false
}

/**
 * Build one ajv instance wired for the spec. The caller owns what it does with
 * it — this module adds no schemas beyond the spec's components.
 *
 * `specComponents` (optional) registers every `#/components/schemas/*` so `$ref`
 * resolves. The response side passes them; a request-side instance that only
 * ever compiles inline operation schemas may omit them, but passing them is
 * cheap and keeps one behaviour.
 */
export function makeSpecAjv(
  options: SpecAjvOptions = {},
  specComponents?: Record<string, Json>,
): Ajv2020 {
  const close = wantsCloseObjects(options)

  const ajv = new Ajv2020({
    strict: options.strict ?? RESPONSE_DEFAULTS.strict,
    allErrors: options.allErrors ?? RESPONSE_DEFAULTS.allErrors,
    coerceTypes: options.coerceTypes,
    useDefaults: options.useDefaults,
    removeAdditional: options.removeAdditional,
  })

  // Without this, `format: 'uuid'` / `'date-time'` are silently IGNORED — ajv logs
  // "unknown format … ignored" and validates nothing. A spec that promises a uuid
  // and a payload carrying "banana" would have passed.
  // ajv-formats is CJS (`module.exports = plugin`, with a `.default` alias), so
  // under NodeNext the default import is typed as the namespace rather than the
  // callable. Both shapes point at the same function at runtime.
  const addFormats: FormatsPlugin =
    (addFormatsModule as unknown as { default?: FormatsPlugin }).default ??
    (addFormatsModule as unknown as FormatsPlugin)
  addFormats(ajv)

  if (specComponents && close) {
    for (const [name, definition] of Object.entries(specComponents)) {
      ajv.addSchema(closeObjects(definition) as Json, `#/components/schemas/${name}`)
    }
  } else if (specComponents) {
    for (const [name, definition] of Object.entries(specComponents)) {
      // A copy, never the spec object itself — it is shared with the served
      // /openapi.json and must not be mutated by a validator instance.
      ajv.addSchema({ ...(definition as Json) }, `#/components/schemas/${name}`)
    }
  }

  return ajv
}

/**
 * Add `additionalProperties: false` to every object schema that does not state
 * a preference, recursively. Returns a copy — the spec object is shared with
 * the served `/openapi.json` and must never be mutated by a validator.
 *
 * **Never inside an `allOf`.** This is the classic JSON Schema composition
 * trap: `additionalProperties` only sees the properties declared at its OWN
 * level, so closing one `allOf` member makes it reject the properties its
 * sibling members contribute — and a payload that is perfectly valid gets
 * reported as a spec violation. The spec has such shapes today (`mpp`,
 * `AgentConnectionAllowance`); none is on a route asserted here yet, so the
 * bug would have lain dormant until someone widened coverage and hit a
 * baffling false failure. A schema composed with `allOf` is left open.
 *
 * Moved verbatim from `response-shape.ts` (#3029 slice 1); the response-shape
 * module re-exports it for its composition tests.
 */
export function closeObjects(node: unknown, insideAllOf: boolean = false): unknown {
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

/** Re-exported for callers formatting ajv errors (the request envelope). */
export type { ErrorObject, ValidateFunction }
