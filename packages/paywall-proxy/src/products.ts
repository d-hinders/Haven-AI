/**
 * The products file (docs/architecture/12-merchant-kit.md §3): JSON, validated
 * at start; any problem refuses startup and names the product. The price is an
 * atomic USDC integer string, never a number, and the network is a deployment
 * setting, never a field of the file.
 */
import { readFileSync } from 'node:fs'
import { InputSchemaCompileError, inputValidatorFor } from './input-schema.js'

/** The receipt reader accepts at most this many characters in a line and refuses these characters. */
export const RECEIPT_LINE_MAX = 300
// eslint-disable-next-line no-control-regex
const FORBIDDEN_TEXT = /[\u0000-\u001f\u007f-\u009f\u061c\u200b\u200e\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const
export type HttpMethod = (typeof HTTP_METHODS)[number]
/** Methods whose requests carry no body, so a product on one cannot carry an `input_schema` (#4988). */
const BODYLESS_METHODS: ReadonlySet<HttpMethod> = new Set(['GET', 'DELETE'])

export interface Product {
  id: string
  name?: string
  method: HttpMethod
  /** The path after the proxy's base path. */
  path: string
  /** `METHOD /path`, the products-file spelling. */
  route: string
  model?: string
  /** Atomic USDC units. */
  price: bigint
  outputTokenCap?: number
  description: string
  inputExample?: unknown
  inputSchema?: unknown
  outputExample?: unknown
}

export class ProductsFileError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`The products file is invalid:\n${problems.map((p) => `  - ${p}`).join('\n')}`)
    this.name = 'ProductsFileError'
  }
}

const TOP_LEVEL_FIELDS = new Set(['version', 'products'])
const PRODUCT_FIELDS = new Set([
  'id',
  'name',
  'route',
  'model',
  'price',
  'output_token_cap',
  'description',
  'input_example',
  'input_schema',
  'output_example',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function parseProducts(raw: unknown): Product[] {
  const problems: string[] = []
  if (!isRecord(raw)) throw new ProductsFileError(['the file must be a JSON object'])
  for (const key of Object.keys(raw)) {
    if (!TOP_LEVEL_FIELDS.has(key)) {
      problems.push(
        key === 'network'
          ? '"network" is not a products-file field: the network is the NETWORK setting of the deployment'
          : `unknown field "${key}"`,
      )
    }
  }
  if (raw.version !== 1) problems.push('"version" must be 1')
  if (!Array.isArray(raw.products) || raw.products.length === 0) {
    problems.push('"products" must be a non-empty array')
    throw new ProductsFileError(problems)
  }

  const products: Product[] = []
  const ids = new Set<string>()
  raw.products.forEach((entry: unknown, index: number) => {
    const where = isRecord(entry) && typeof entry.id === 'string' ? `product "${entry.id}"` : `product #${index + 1}`
    const problem = (message: string): void => {
      problems.push(`${where}: ${message}`)
    }
    if (!isRecord(entry)) return problem('must be an object')
    for (const key of Object.keys(entry)) {
      if (!PRODUCT_FIELDS.has(key)) problem(key === 'network' ? '"network" is a deployment setting, not a product field' : `unknown field "${key}"`)
    }

    const id = entry.id
    if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/.test(id)) {
      problem('"id" must be a lower-case identifier (a-z, 0-9, ".", "_", "-")')
    } else if (ids.has(id)) {
      problem('"id" is used by another product')
    } else {
      ids.add(id)
    }

    const name = entry.name
    if (name !== undefined && (typeof name !== 'string' || name.trim() === '')) problem('"name" must be non-empty text')

    let method: HttpMethod = 'POST'
    let path = '/'
    if (typeof entry.route !== 'string') {
      problem('"route" is required: "METHOD /path"')
    } else {
      const match = /^([A-Z]+) (\/\S*)$/.exec(entry.route)
      if (!match || !(HTTP_METHODS as readonly string[]).includes(match[1]!)) {
        problem(`"route" must be "METHOD /path" with a method of ${HTTP_METHODS.join(', ')}`)
      } else if (match[2]!.includes('?') || match[2]!.includes('#')) {
        problem('"route" must be a path with no query or fragment')
      } else {
        method = match[1] as HttpMethod
        path = match[2]!
      }
    }

    const model = entry.model
    if (model !== undefined && (typeof model !== 'string' || model.trim() === '')) problem('"model" must be non-empty text')

    let price = 0n
    if (typeof entry.price === 'number') {
      problem('"price" must be a decimal string of atomic USDC units, not a JSON number')
    } else if (typeof entry.price !== 'string' || !/^[1-9][0-9]*$/.test(entry.price)) {
      problem('"price" must be a decimal string of atomic USDC units, greater than zero (for example "10000" for $0.01)')
    } else {
      price = BigInt(entry.price)
    }

    const cap = entry.output_token_cap
    if (cap !== undefined && (typeof cap !== 'number' || !Number.isSafeInteger(cap) || cap < 1)) {
      problem('"output_token_cap" must be a positive whole number')
    }

    const description = entry.description
    if (typeof description !== 'string' || description.trim() === '') {
      problem('"description" is required')
    } else {
      const display = typeof name === 'string' && name.trim() !== '' ? name : typeof id === 'string' ? id : ''
      const line = `${display} — ${description}`
      if (FORBIDDEN_TEXT.test(display) || FORBIDDEN_TEXT.test(description)) {
        problem('"name" and "description" must not contain control, line-break or invisible formatting characters')
      }
      if ([...line].length > RECEIPT_LINE_MAX) {
        problem(`the receipt line "<name> — <description>" is ${[...line].length} characters; the limit is ${RECEIPT_LINE_MAX}`)
      }
    }

    const product: Product = {
      id: typeof id === 'string' ? id : '',
      ...(typeof name === 'string' ? { name } : {}),
      method,
      path,
      route: `${method} ${path}`,
      ...(typeof model === 'string' ? { model } : {}),
      price,
      ...(typeof cap === 'number' ? { outputTokenCap: cap } : {}),
      description: typeof description === 'string' ? description : '',
      ...(entry.input_example !== undefined ? { inputExample: entry.input_example } : {}),
      ...(entry.input_schema !== undefined ? { inputSchema: entry.input_schema } : {}),
      ...(entry.output_example !== undefined ? { outputExample: entry.output_example } : {}),
    }

    // #4988: the schema is compiled here, so a schema the proxy cannot enforce fails startup.
    if (entry.input_schema !== undefined) {
      if (BODYLESS_METHODS.has(method)) {
        problem(`"input_schema" is for a request body, and a ${method} request has none: remove it or sell the route with a method that carries a body`)
      } else {
        try {
          const validate = inputValidatorFor(product)!
          const failed = entry.input_example !== undefined ? validate(entry.input_example) : []
          if (failed.length > 0) {
            problem(`"input_example" does not pass "input_schema": ${failed.map((e) => `${e.path || '(the body)'} fails "${e.rule}"`).join(', ')}`)
          }
        } catch (err) {
          if (!(err instanceof InputSchemaCompileError)) throw err
          problem(err.message)
        }
      }
    }
    products.push(product)
  })

  // Two products may share a route only when each pins a different model.
  const byRoute = new Map<string, Product[]>()
  for (const product of products) {
    byRoute.set(product.route, [...(byRoute.get(product.route) ?? []), product])
  }
  for (const [route, sharing] of byRoute) {
    if (sharing.length < 2) continue
    const models = sharing.map((p) => p.model)
    if (models.some((m) => m === undefined)) {
      problems.push(`route "${route}" is shared by ${sharing.map((p) => `"${p.id}"`).join(', ')}: products on one route must each name a "model"`)
    } else if (new Set(models).size !== models.length) {
      problems.push(`route "${route}" has two products with the same model: the price would be ambiguous`)
    }
  }

  if (problems.length > 0) throw new ProductsFileError(problems)
  return products
}

export function loadProductsFile(path: string): Product[] {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    throw new ProductsFileError([`the file at PRODUCTS_FILE could not be read`])
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new ProductsFileError(['the file is not valid JSON'])
  }
  return parseProducts(raw)
}

/** The products on a route, by exact method and path. */
export function indexProducts(products: readonly Product[]): Map<string, Product[]> {
  const index = new Map<string, Product[]>()
  for (const product of products) {
    index.set(product.route, [...(index.get(product.route) ?? []), product])
  }
  return index
}
