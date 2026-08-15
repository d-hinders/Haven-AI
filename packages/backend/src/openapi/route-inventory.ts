/**
 * Route inventory — what the app actually registers, derived rather than listed.
 *
 * Extracted from `spec.test.ts` (#1443, epic #1442) so two gates can share one
 * extractor instead of keeping two copies that drift. The extraction helpers
 * are verbatim from that file; `registeredRouteModules` is new.
 *
 * **Why derive instead of boot.** The obvious way to enumerate routes is to
 * start Fastify and read its routing table — but the app boots against a live
 * Postgres (`runMigrations()` before `listen`), a relayer and vendor env, which
 * is far too much machinery for a static coverage check. Parsing the
 * registration table in `index.ts` gets the same answer from the same source of
 * truth, and the extractor below is already regression-tested against the
 * shapes that used to slip past it.
 *
 * The property that matters: **no hand-maintained list of route files.** A new
 * route module is covered by the gate from its first commit, because the gate
 * discovers it the same way the server does.
 */

import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

export const BACKEND_SRC = join(__dirname, '..')
export const ROUTES_DIR = join(BACKEND_SRC, 'routes')

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const

export interface DeclaredRoute {
  method: string
  path: string
}

export interface RegisteredRouteModule {
  /** Display name — `agents.ts`, or `index.ts` for routes declared on the app itself. */
  file: string
  /** Absolute path to read the declarations from. */
  sourcePath: string
  /** Mount prefix from `app.register(..., { prefix })`; `''` when mounted at root. */
  prefix: string
}

/**
 * Extract Fastify route registrations from a route file's source text.
 *
 * Matches `<identifier>.<method>(<optional generic>)(<path>` for the standard
 * HTTP methods. The optional generic is consumed by `[^'"\`(]*` — anything
 * that is not a string quote or an opening paren — so nested type parameters
 * like `Record<K,V>` or multi-line `{\n  Body: ...\n}` work without a regex
 * brace-balancer. Quote-aware for single/double/backtick string literals.
 * Strips comments before matching so example snippets in JSDoc don't appear
 * as live registrations.
 */
export function extractRoutes(source: string): DeclaredRoute[] {
  // Strip comments outside string literals so we don't (a) match example
  // routes inside JSDoc, (b) eat `://` inside a URL string literal.
  const noComments = stripCommentsOutsideStrings(source)
  const re = new RegExp(
    `\\b[A-Za-z_$][A-Za-z0-9_$]*\\.(${HTTP_METHODS.join('|')})[^'"\`(]*\\(\\s*(['"\`])([^'"\`]+)\\2`,
    'g',
  )
  const routes: DeclaredRoute[] = []
  let match: RegExpExecArray | null
  while ((match = re.exec(noComments)) !== null) {
    routes.push({ method: match[1].toUpperCase(), path: match[3] })
  }
  return routes
}

// Strip JS line and block comments from `source`, leaving content inside
// string literals untouched. A naive `source.replace(/\/\/[^\n]*/g, '')`
// would eat the rest of any line that contains `://` inside a URL string,
// dropping route registrations on that line. This walks the text
// character-by-character with a small state machine instead.
export function stripCommentsOutsideStrings(source: string): string {
  let out = ''
  let i = 0
  // States: 'code' | 'line-comment' | 'block-comment' | 'single' | 'double' | 'template'
  let state: 'code' | 'line-comment' | 'block-comment' | 'single' | 'double' | 'template' = 'code'
  while (i < source.length) {
    const c = source[i]
    const next = source[i + 1]
    if (state === 'code') {
      if (c === '/' && next === '/') { state = 'line-comment'; i += 2; continue }
      if (c === '/' && next === '*') { state = 'block-comment'; i += 2; continue }
      if (c === "'") { state = 'single'; out += c; i++; continue }
      if (c === '"') { state = 'double'; out += c; i++; continue }
      if (c === '`') { state = 'template'; out += c; i++; continue }
      out += c; i++; continue
    }
    if (state === 'line-comment') {
      if (c === '\n') { state = 'code'; out += c; i++; continue }
      i++; continue
    }
    if (state === 'block-comment') {
      if (c === '*' && next === '/') { state = 'code'; i += 2; continue }
      i++; continue
    }
    // Inside a string literal — preserve content as-is, honor backslash escapes.
    if (c === '\\' && i + 1 < source.length) {
      out += c + source[i + 1]; i += 2; continue
    }
    if (state === 'single' && c === "'") { state = 'code'; out += c; i++; continue }
    if (state === 'double' && c === '"') { state = 'code'; out += c; i++; continue }
    if (state === 'template' && c === '`') { state = 'code'; out += c; i++; continue }
    out += c; i++
  }
  return out
}

/**
 * Fastify path syntax `:id` → OpenAPI path syntax `{id}`. Both inside the
 * same path string.
 */
export function fastifyPathToOpenApi(prefix: string, path: string): string {
  const full = (prefix + (path === '/' ? '' : path)).replace(/\/+/g, '/')
  return full.replace(/:([A-Za-z0-9_]+)/g, '{$1}')
}

/**
 * Every route module the server registers, with its mount prefix — read out of
 * `index.ts` rather than listed here.
 *
 * Two passes over the same file: `import x from './routes/y.js'` binds an
 * identifier to a file, `app.register(x, { prefix: 'p' })` binds it to a mount
 * point. A module registered more than once (agents.ts, agent-delegations.ts
 * and agent-passports.ts all mount under `/agents`) yields one entry per
 * registration, because each mount can publish different paths.
 */
export async function registeredRouteModules(): Promise<RegisteredRouteModule[]> {
  const indexSource = stripCommentsOutsideStrings(
    await readFile(join(BACKEND_SRC, 'index.ts'), 'utf8'),
  )

  const fileByIdentifier = new Map<string, string>()
  for (const m of indexSource.matchAll(
    /import\s+([A-Za-z_$][A-Za-z0-9_$]*)\s+from\s+'\.\/routes\/([A-Za-z0-9_-]+)\.js'/g,
  )) {
    fileByIdentifier.set(m[1], `${m[2]}.ts`)
  }

  const modules: RegisteredRouteModule[] = []
  for (const m of indexSource.matchAll(
    /app\.register\(\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:,\s*\{[^}]*prefix:\s*'([^']*)'[^}]*\})?\s*\)/g,
  )) {
    const file = fileByIdentifier.get(m[1])
    if (!file) continue // not a route module (plugins, cors, etc.)
    modules.push({ file, sourcePath: join(ROUTES_DIR, file), prefix: m[2] ?? '' })
  }

  // Routes declared straight on the app rather than in a `routes/` module
  // (`/health`, `/chains`). Registering through a module is the convention, but
  // the convention is not enforced — so a gate that only walked `routes/` would
  // claim to cover "every registered route" while two of them were invisible,
  // which is how `GET /chains` reached production undocumented (#1443 review).
  if (extractRoutes(indexSource).length > 0) {
    modules.push({ file: 'index.ts', sourcePath: join(BACKEND_SRC, 'index.ts'), prefix: '' })
  }

  return modules
}
