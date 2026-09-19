#!/usr/bin/env node
// Shrink-only ratchet over the request-validation rollout (#3029, epic #3028).
//
// The request-validation plugin (`packages/backend/src/openapi/request-validation.ts`)
// compiles every route's request against the OpenAPI spec. A route whose spec
// operation declares request constraints (a requestBody, or query/path
// parameters) is either SHADOWED (the plugin injects the schema and logs
// would-be refusals) or ENFORCED (the module is in the plugin's
// `enforcedModules`, and a refusal is the 400 envelope). This gate freezes
// that rollout so it can only advance:
//
//   shadow    — per route file, 1 while any registered route in the file is
//               still shadowed, 0 once every route the spec constrains in the
//               file is enforced (slices 2-4 flip modules one at a time).
//   typeof    — per route file, the number of lines carrying a `typeof` guard.
//               These are the hand-rolled request checks the spec's own schemas
//               replace (`typeof name !== 'string'`, `typeof amount !== ...`);
//               a module leaves shadow by deleting them, so the count is the
//               per-file measure of the same migration. Slices 2-4 drive it to
//               zero; at slice 4 every entry is zeros.
//   ownSchema — per route file, the number of routes declaring their OWN
//               Fastify `schema:` option (#3135). The plugin refuses to clobber
//               one (`request-validation.ts`: "never clobber a route's own
//               schema"), so such a route escapes spec validation AND — before
//               this key existed — escaped this gate too: it is neither
//               shadowed nor enforced, and "all zeros" at slice 4 could not
//               see it. Zero today; the key exists so it cannot grow unseen.
//   unspecced — per route file, the number of registered routes with NO spec
//               operation at all (#3135). "No operation → no schema" means the
//               plugin never touches them, so they are invisible to `shadow`
//               for the same reason. One today: `POST /safe/deploy`, the
//               retired-rail tombstone that carries a coverage-gate exemption
//               (epic #3028 open question 1, answered "keep the exemption and
//               count it, so all-zeros stays honest").
//
// The baseline shape is the engine's `{ "routes/<file>.ts": { key: n } }`
// (scripts/lib/ratchet.mjs). A SCALAR is not a baseline — the engine refuses
// it. Never an empty `{}` while any entry is non-zero: `{}` is what a fully
// migrated tree writes, not a way to say "no constraints" (the engine's
// first-run trap note).
//
// WHAT COUNTS AS SHADOWED. A route file is scanned for its registered routes
// (`app.get('/x')`, generics included); its mount prefix is read from
// `src/index.ts` (`app.register(fileRoutes, { prefix: '/p' })`; files
// registered directly — `registerHealthRoutes(app)` — mount at ''). The route
// is resolved against the spec with the same path mapping the plugin uses
// (`fastifyPathToOpenApi`: `:param` → `{param}`), and the file is shadowed
// when ANY of its registered operations carries `parameters` (query/path) or a
// `requestBody`. `contacts.ts` reports shadow: 0 — it is the PROOF module,
// enforced via `enforcedModules` as of slice 1; the wiring is load-bearing
// and pinned by the self-test (removing it reddens this gate).
//
// The boundary this gate deliberately does not police (same honesty as
// lint-wire-types' stated holes): a route registered with its path in a
// non-literal (a variable) is invisible to the scanner; a file whose routes
// are registered nowhere is invisible to index.ts and reads as unmounted (its
// routes then never resolve to a spec path and it reports shadow: 0, which is
// the safe direction — an unregistered file ships no refusals to shrink); and
// whether a route belongs in the spec AT ALL is #1443's coverage gate's
// problem, not this one — `unspecced` counts such routes so slice 4's
// "all zeros" cannot silently exclude them, and says nothing about whether
// each is legitimately exempt. The HEAD auto-twin is skipped, as the plugin
// skips it.
//
// `ownSchema`'s gauge is narrower than the others and says so: it counts lines
// matching `/^\s*schema:\s/` in a route file with whole-line comments removed,
// which is the shape a Fastify route options object uses. A `schema:` written
// inline on the same line as the path literal would be missed. Zero today in
// every route file, so the key starts as a tripwire rather than a measurement
// of existing debt.
//
//   node scripts/lint-request-schemas.mjs            # check against the baseline
//   node scripts/lint-request-schemas.mjs --update   # tighten after a reduction
//                                                    # (refuses to ratchet upward)
import { readFile, readdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  newViolations,
  hasShrunk,
  writeBaseline,
  loadBaseline,
  updateRefusals,
  ACCEPT_NEW_BASELINE_FLAG,
  firstRunRefusalMessage,
} from './lib/ratchet.mjs'
import { runGate } from './lib/ratchet.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ROUTES_DIR = join(ROOT, 'packages/backend/src/routes')
const INDEX_TS = join(ROOT, 'packages/backend/src/index.ts')
const SPEC_TS = join(ROOT, 'packages/backend/src/openapi/spec.ts')
const BASELINE_PATH = join(ROOT, 'scripts/lint-request-schemas-baseline.json')

const REMEDY =
  'A request-validation rollout regression: a module re-entered shadow, a `typeof` ' +
  'ladder regrew, a route took its own `schema:` out of the plugin\'s reach, or a route ' +
  'was registered with no spec operation. Slices of epic #3028 only ever ADD enforced ' +
  'modules and REMOVE residue — if your change did that by accident, fix it; if it ' +
  'genuinely needs the old shape, say so on the epic instead of growing this baseline.'

/**
 * The `fastifyPathToOpenApi` mapping — copied byte-for-byte from
 * `openapi/route-inventory.ts:118` (the TS original stays there; this gate
 * stays a dependency-free .mjs). Slash-run collapsing, the '' → '/' root
 * normalization (#2530), and `:param` → `{param}` all included.
 */
export function fastifyPathToOpenApi(prefix, path) {
  const full = (prefix + (path === '/' ? '' : path)).replace(/\/+/g, '/')
  const normalized = full === '' ? '/' : full
  return normalized.replace(/:([A-Za-z0-9_]+)/g, '{$1}')
}

/** The mount prefixes `src/index.ts` registers `importName` at ([] when none). */
export function prefixesFromIndex(indexSource, importName) {
  const prefixes = []
  // `await app.register(agentRoutes, { prefix: '/agents' })` — the repo's
  // registration shape for every route module. An import registered under two
  // prefixes counts once per registration — #2907 had one such twin mount
  // until #2914 retired the old prefix; the mechanism stands, the example is
  // history.
  const re = /app\.register\(\s*([A-Za-z_$][\w$]*)\s*,\s*\{[^}]*?prefix:\s*'([^']*)'/g
  for (const m of indexSource.matchAll(re)) {
    if (m[1] === importName) prefixes.push(m[2])
  }
  return prefixes
}

/**
 * The `enforcedModules` the production install declares (`src/index.ts`,
 * `installRequestValidation(app, { … enforcedModules: ['routes/contacts.ts'] })`).
 * The plugin is registered by index.ts and by route tests, never inline, so
 * this one site is the rollout's state: a listed route FILE is ENFORCED, and
 * this gate's whole mutation story hangs off it — removing
 * `routes/contacts.ts` from that array re-enters the module in shadow here and
 * reddens the gate against its `shadow: 0` baseline entry.
 *
 * Keyed on the file since #3135 (epic #3028 decision 7). The old
 * `enforcedPrefixes` key could not express the epic's slice partition —
 * `/agents` is shared by four route files across two slices — and this gate
 * now reads exactly the string the baseline keys its entries with, so the
 * plugin and the ratchet cannot key the rollout two different ways.
 */
export function enforcedModulesFromIndex(indexSource) {
  const m = indexSource.match(/installRequestValidation\([\s\S]*?enforcedModules:\s*\[([^\]]*)\]/)
  if (!m) return []
  return [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1])
}

/** The import name `src/index.ts` binds the route file to (null when unimported). */
export function importNameFromIndex(indexSource, fileBase) {
  const m = indexSource.match(new RegExp(`import\\s+(\\w+)\\s+from\\s*'[^']*routes/${fileBase}\\.js'`))
  return m ? m[1] : null
}

/**
 * The registered routes of one module source: [{ method, path }] for the
 * `app.<method>('…')` literal forms. Generics (`app.post<{ Body: X }>('/')`)
 * are part of the shape every money-path route file uses. HEAD is skipped —
 * the auto-generated twin adds nothing, as in the plugin.
 */
export function registeredRoutes(moduleSource) {
  const routes = []
  const re = /\bapp\.(get|post|put|patch|delete|head|options)(?:<[^>\n]*>)?\(\s*['"]([^'"]*)['"]/g
  for (const m of moduleSource.matchAll(re)) {
    const method = m[1].toLowerCase()
    if (method === 'head') continue
    routes.push({ method, path: m[2] })
  }
  return routes
}

/**
 * True when the spec operation declares request constraints: a requestBody,
 * or `parameters` carrying a query/path parameter (headers are out of scope —
 * the plugin does not compile them either).
 *
 * `$ref`'d parameters are resolved against `components.parameters`, mirroring
 * the plugin's `resolveParameter` (#3135). Both instruments dropped them
 * before that — a `$ref` node has no `in`, so the query/path filter skipped
 * it — and a `$ref` is how every `AgentId`/`PaymentId`/`SetupId` path
 * parameter in the spec is written. The two must share the rule or the gate
 * and the runtime disagree about which modules carry residue.
 */
export function operationHasRequestConstraints(operation, componentParameters = {}) {
  if (!operation || typeof operation !== 'object') return false
  if (operation.requestBody && typeof operation.requestBody === 'object') return true
  if (!Array.isArray(operation.parameters)) return false
  return operation.parameters.some((entry) => {
    if (!entry || typeof entry !== 'object') return false
    const p =
      typeof entry.$ref === 'string'
        ? componentParameters[entry.$ref.replace('#/components/parameters/', '')]
        : entry
    return Boolean(p) && (p.in === 'query' || p.in === 'path')
  })
}

/**
 * The number of routes in `source` declaring their own Fastify `schema:`
 * option (#3135). Whole-line comments are dropped first so a JSDoc mention of
 * `schema:` is not a hit — the gauge's narrowness is stated in the header.
 */
export function ownSchemaRoutes(source) {
  return source
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim()
      return !(trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*'))
    })
    .filter((line) => /^\s*schema:\s/.test(line)).length
}

/** The number of lines in `source` that mention `typeof` — the metric. */
export function typeofLines(source) {
  return source.split('\n').filter((line) => line.includes('typeof')).length
}

/**
 * The spec's `paths` as a plain object. The spec is a typed TS module, so it
 * is loaded through the backend's `tsx` — the same mechanism
 * `scripts/generate-api-types.mjs` uses, so this gate sees exactly what
 * `/openapi.json` serves.
 */
async function loadSpec() {
  const TSX = join(ROOT, 'node_modules/.bin/tsx')
  const { execFileSync } = await import('node:child_process')
  const json = execFileSync(
    TSX,
    [
      '-e',
      "import('./packages/backend/src/openapi/spec.ts').then(m => process.stdout.write(JSON.stringify({ paths: m.openapiSpec.paths, parameters: m.openapiSpec.components?.parameters ?? {} })))",
    ],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )
  return JSON.parse(json)
}

/**
 * Scan every route module and produce the counts the baseline stores:
 * `{ "routes/<file>.ts": { shadow: 0|1, typeof: n } }`. Only files with
 * something to count appear (a file with no routes and no `typeof` is not
 * debt). Direct-registration modules (`registerHealthRoutes(app)`) mount at
 * ''.
 */
export async function scanRoutes({ indexSource, specPaths, componentParameters = {}, readModule }) {
  const counts = {}
  const enforcedModules = enforcedModulesFromIndex(indexSource)
  for (const entry of (await readdir(ROUTES_DIR)).sort()) {
    if (!entry.endsWith('.ts')) continue
    const base = entry.replace(/\.ts$/, '')
    const relKey = `routes/${base}.ts`
    const source = await readModule(join(ROUTES_DIR, entry))

    // `shadow` and `typeof` are written together, zeros included, so an entry
    // always states both — the shape the baseline has carried since #3029.
    // `ownSchema` and `unspecced` are written only when NON-ZERO: the engine
    // reads a missing key as 0, so a zero entry would be 26 lines of noise
    // saying nothing, and their whole job is to be visible when they are not
    // zero.
    const ensure = () => (counts[relKey] ??= { shadow: 0, typeof: 0 })
    const bump = (key, n) => {
      if (n === 0) return
      ensure()[key] = n
    }

    const typeofTotal = typeofLines(source)
    if (typeofTotal > 0) ensure().typeof = typeofTotal
    bump('ownSchema', ownSchemaRoutes(source))

    const importName = importNameFromIndex(indexSource, base)
    if (!importName) continue
    const prefixes = prefixesFromIndex(indexSource, importName)
    // An enforced module is not shadow, whatever its spec operations declare —
    // the plugin injects the same schema and refuses instead of logging. The
    // PROOF module (contacts, slice 1) and merchants (#3078) ride this. The
    // key is the route FILE since #3135, the same one the plugin resolves.
    const enforced = enforcedModules.includes(relKey)
    let shadowed = false
    let unspecced = 0
    for (const prefix of prefixes) {
      for (const { method, path } of registeredRoutes(source)) {
        const pathItem = specPaths[fastifyPathToOpenApi(prefix, path)]
        if (!pathItem?.[method]) {
          // No spec operation at all: the plugin never touches this route, so
          // neither `shadow` nor `enforced` can describe it. Counted on its
          // own key so slice 4's "every entry zero" cannot be reached while
          // an unvalidated route is still registered (#3135).
          unspecced += 1
          continue
        }
        if (enforced) continue
        // Path-item-level parameters merge beneath operation-level ones —
        // the same resolution rule the plugin implements by passing
        // `pathItem.parameters` to `requestSchemaForOperation` (none exist in
        // the spec today; kept here so the scanner cannot drift from the
        // plugin when one is added).
        const parameters = [
          ...(Array.isArray(pathItem.parameters) ? pathItem.parameters : []),
          ...(Array.isArray(pathItem[method]?.parameters) ? pathItem[method].parameters : []),
        ]
        const operation = pathItem[method]
        const effective = parameters.length > 0 ? { ...operation, parameters } : operation
        if (operationHasRequestConstraints(effective, componentParameters)) shadowed = true
      }
    }
    if (shadowed) ensure().shadow = 1
    bump('unspecced', unspecced)
  }
  return counts
}

const MODE_ENFORCED_NOTE =
  'routes/contacts.ts must stay shadow: 0 — it is the slice-1 PROOF module, enforced ' +
  "through installRequestValidation({ enforcedModules: ['routes/contacts.ts'] }) in src/index.ts. " +
  'If this gate reddens on it, the enforcedModules wiring was removed.'

async function main() {
  const [indexSource, spec] = await Promise.all([readFile(INDEX_TS, 'utf8'), loadSpec()])
  const counts = await scanRoutes({
    indexSource,
    specPaths: spec.paths,
    componentParameters: spec.parameters,
    readModule: (p) => readFile(p, 'utf8'),
  })

  const sum = (key) => Object.values(counts).reduce((total, k) => total + (k[key] ?? 0), 0)
  const shadowModules = Object.values(counts).filter((k) => k.shadow === 1).length
  console.log(
    `request-schemas gauge: ${shadowModules} shadow module(s), ${sum('typeof')} typeof line(s), ` +
      `${sum('ownSchema')} own-schema route(s), ${sum('unspecced')} unspecced route(s) ` +
      `across ${Object.keys(counts).length} file(s).`,
  )

  const { baseline, firstRun } = loadBaseline(BASELINE_PATH)
  const acceptNew = process.argv.includes(ACCEPT_NEW_BASELINE_FLAG)

  if (process.argv.includes('--update')) {
    const violations = updateRefusals(counts, baseline, { firstRun, acceptNew })
    if (violations.length > 0) {
      console.error('✗ --update refuses to RAISE the baseline. Grown:')
      for (const v of violations) console.error(`  ${v.file} [${v.key}]: ${v.allowed} → ${v.count}`)
      if (firstRun) console.error(firstRunRefusalMessage(firstRun))
      console.error(`\n${REMEDY}`)
      process.exit(1)
    }
    writeBaseline(BASELINE_PATH, counts)
    console.log(`✓ baseline written (${BASELINE_PATH}).`)
    return
  }

  const violations = newViolations(counts, baseline)
  if (violations.length > 0) {
    console.error('\n✗ the request-validation rollout regressed (shrink-only baseline, #3029):\n')
    for (const v of violations) {
      console.error(`  ${v.file} [${v.key}]: baseline ${v.allowed}, now ${v.count}`)
      if (v.file === 'routes/contacts.ts' && v.key === 'shadow') console.error(`  ${MODE_ENFORCED_NOTE}`)
    }
    console.error(`\n${REMEDY}`)
    console.error(
      '\nIf you genuinely REDUCED the residue (a module enforced, a ladder deleted), run:\n' +
        '  node scripts/lint-request-schemas.mjs --update',
    )
    process.exit(1)
  }

  if (hasShrunk(counts, baseline)) {
    console.log(
      '  (counts are below the baseline — lock in the rollout progress: node scripts/lint-request-schemas.mjs --update)',
    )
  }
  console.log('✓ request-validation rollout has not regressed.')
}

// Run only as a CLI (the pure scanner is imported by tests).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runGate('lint-request-schemas', main)
}
