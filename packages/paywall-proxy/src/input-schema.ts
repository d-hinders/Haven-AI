/**
 * A product's `input_schema`, compiled and enforced (#4988,
 * docs/architecture/12-merchant-kit.md §3 and §8). The dialect is JSON Schema
 * draft 2020-12 through Ajv, the validator the backend and the hosted MCP
 * server already use. A schema is compiled once, when the products file loads;
 * loading a schema never makes a network call, because a `$ref` that leaves the
 * schema is refused rather than fetched.
 *
 * A failure is reported as `{ path, rule }` pairs: `path` is a JSON pointer into
 * the request body and `rule` the schema keyword that failed. Neither carries a
 * value from the body, so a refusal never echoes what the buyer sent.
 */
import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js'

/** At most this many entries in a refusal's `errors`, each string at most this long. */
export const MAX_INPUT_ERRORS = 10
export const MAX_INPUT_ERROR_TEXT = 200

/** One way the body fails the product's schema. */
export interface InputSchemaError {
  /** A JSON pointer into the request body; `""` is the body itself. */
  path: string
  /** The schema keyword that failed, or `json` when the body is not JSON, or `content_type` for a non-JSON Content-Type. */
  rule: string
}

/** A compiled schema: the body's failures, at most {@link MAX_INPUT_ERRORS} of them, or none. */
export type InputValidator = (body: unknown) => InputSchemaError[]

/** Why a schema cannot be enforced; startup refuses the products file with it. */
export class InputSchemaCompileError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InputSchemaCompileError'
  }
}

/** A `$ref` or `$dynamicRef` that does not point inside the schema itself. */
function findRemoteRef(node: unknown): string | undefined {
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findRemoteRef(item)
      if (found !== undefined) return found
    }
    return undefined
  }
  if (node === null || typeof node !== 'object') return undefined
  for (const [key, value] of Object.entries(node)) {
    if ((key === '$ref' || key === '$dynamicRef') && typeof value === 'string' && !value.startsWith('#')) return value
    const found = findRemoteRef(value)
    if (found !== undefined) return found
  }
  return undefined
}

const clip = (text: string): string => ([...text].length > MAX_INPUT_ERROR_TEXT ? [...text].slice(0, MAX_INPUT_ERROR_TEXT).join('') : text)

/** RFC 6901: `~` and `/` in a property name are escaped. */
const pointerSegment = (name: string): string => name.replace(/~/g, '~0').replace(/\//g, '~1')

function toInputError(error: ErrorObject): InputSchemaError {
  let path = error.instancePath
  // A missing property is named by the schema, not by the body, so the pointer can name it.
  if ((error.keyword === 'required' || error.keyword === 'dependentRequired') && typeof error.params.missingProperty === 'string') {
    path = `${path}/${pointerSegment(error.params.missingProperty)}`
  }
  return { path: clip(path), rule: clip(error.keyword) }
}

/**
 * Compile one product's schema. Each schema gets its own Ajv instance, so two
 * products may reuse an `$id` without colliding. Throws
 * {@link InputSchemaCompileError} with the reason in words.
 */
export function compileInputSchema(schema: unknown): InputValidator {
  const remote = findRemoteRef(schema)
  if (remote !== undefined) {
    throw new InputSchemaCompileError(`"input_schema" has a $ref outside the schema (${clip(JSON.stringify(remote))}): only "#..." references are allowed, so loading never makes a network call`)
  }
  const ajv = new Ajv2020({
    allErrors: true,
    messages: false,
    // `format` is an annotation in 2020-12, not a check: an unknown format is not a startup failure.
    validateFormats: false,
    // An unknown keyword fails startup, so a misspelt rule is never silently ignored.
    strictSchema: true,
    strictTypes: false,
    strictTuples: false,
    strictRequired: false,
  })
  let validate: ValidateFunction
  try {
    validate = ajv.compile(schema as object | boolean)
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'it could not be compiled'
    throw new InputSchemaCompileError(`"input_schema" is not a JSON Schema (draft 2020-12) the proxy can enforce: ${clip(reason)}`)
  }
  return (body: unknown): InputSchemaError[] => {
    if (validate(body)) return []
    const seen = new Set<string>()
    const errors: InputSchemaError[] = []
    for (const error of validate.errors ?? []) {
      const entry = toInputError(error)
      const id = `${entry.path}\u0000${entry.rule}`
      if (seen.has(id)) continue
      seen.add(id)
      errors.push(entry)
      if (errors.length === MAX_INPUT_ERRORS) break
    }
    // A failed validation always names at least one rule.
    return errors.length > 0 ? errors : [{ path: '', rule: 'schema' }]
  }
}

const compiled = new WeakMap<object, InputValidator>()

/**
 * The product's compiled validator, cached per product object, or undefined
 * when the product has no `input_schema`. The products file compiles every
 * schema at load, so this does not throw for a product that loaded.
 */
export function inputValidatorFor(product: { inputSchema?: unknown }): InputValidator | undefined {
  if (product.inputSchema === undefined) return undefined
  let validator = compiled.get(product)
  if (!validator) {
    validator = compileInputSchema(product.inputSchema)
    compiled.set(product, validator)
  }
  return validator
}

/** The media type of a Content-Type header, or undefined when none was sent. */
function mediaType(contentType: string | undefined): string | undefined {
  if (contentType === undefined) return undefined
  return contentType.split(';')[0]!.trim().toLowerCase()
}

/**
 * Whether a Content-Type can carry a JSON body: absent (agents often omit it,
 * and a body that parses is accepted), `application/json`, or a `+json` type.
 */
export function isJsonContentType(contentType: string | undefined): boolean {
  const type = mediaType(contentType)
  if (type === undefined || type === '') return true
  return type === 'application/json' || /^application\/[a-z0-9.+-]+\+json$/.test(type)
}
