/**
 * Ops console invariant 1 (#3509, epic #3507): nothing under `/ops` moves
 * funds, signs, changes signers or delegations, or acts as a user.
 *
 * Two checks, both kept next to `non-custody.invariants.test.ts`:
 *
 * 1. The ops code's TRANSITIVE import graph reaches no rail, relayer,
 *    outbound-tx, chain-write or signing module. Following every relative
 *    import from the route module catches a forbidden module pulled in two
 *    hops away, which a direct-import grep would miss.
 * 2. The routes the plugin actually registers (recorded with an `onRoute`
 *    hook, not read from source) are all GET, except `POST /ops/reveal`.
 *
 * A failure here means a change gave the ops console write or spend reach —
 * get the review the epic's threat model requires rather than "fixing" this.
 */
import Fastify from 'fastify'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import opsRoutes from '../routes/ops.js'
import { opsRevealRateLimit, opsSearchRateLimit } from '../middleware/rate-limit.js'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..')
const ENTRY = join(SRC, 'routes', 'ops.ts')

/** Paths (relative to src/) the ops console must never reach. */
const FORBIDDEN = [
  /^rails\//,
  /^infra\/relayer/,
  /^infra\/outbound-/,
  /^infra\/delegate-/,
  /^infra\/chain\//,
  /^modules\/x402\//,
  /^modules\/mpp\//,
  /^modules\/payments\//,
  /^modules\/agents\/rekey-/,
  /signer/i,
]

// Static (`import x from`), side-effect (`import '...'`), re-export
// (`export * from`) and dynamic (`import('...')`) imports — a side-effect
// import is still a module the ops console loads.
const IMPORT_RE = /\b(?:import|export)\s+(?:[^'";]*?\sfrom\s+)?['"](\.{1,2}\/[^'"]+)['"]|\bimport\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g

function resolveImport(fromFile: string, spec: string): string | null {
  const base = resolve(dirname(fromFile), spec)
  for (const candidate of [base.replace(/\.js$/, '.ts'), `${base}.ts`, join(base, 'index.ts')]) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

function reachableFrom(entry: string): string[] {
  const seen = new Set<string>()
  const stack = [entry]
  while (stack.length > 0) {
    const file = stack.pop() as string
    if (seen.has(file)) continue
    seen.add(file)
    for (const match of readFileSync(file, 'utf8').matchAll(IMPORT_RE)) {
      const target = resolveImport(file, match[1] ?? match[2])
      if (target && target.startsWith(SRC)) stack.push(target)
    }
  }
  return [...seen].map((f) => relative(SRC, f).split('\\').join('/'))
}

describe('ops console invariants (#3509)', () => {
  it('reaches no rail, relayer, outbound-tx, chain, payment or signing module', () => {
    const reached = reachableFrom(ENTRY)
    // Positive control: the walk really follows imports (two hops: route → middleware → tokens).
    expect(reached).toEqual(expect.arrayContaining(['routes/ops.ts', 'middleware/ops-auth.ts', 'modules/ops/tokens.ts']))
    const offenders = reached.filter((f) => FORBIDDEN.some((re) => re.test(f)))
    expect(offenders, 'the ops console reaches a module with write or spend reach').toEqual([])
  })

  it('registers only GET routes, except POST /ops/reveal', async () => {
    const app = Fastify({ logger: false })
    const routes: string[] = []
    app.addHook('onRoute', (route) => {
      const methods = Array.isArray(route.method) ? route.method : [route.method]
      for (const method of methods) routes.push(`${method} ${route.url}`)
    })
    await app.register(opsRoutes, {
      prefix: '/ops',
      ops: {
        githubClientId: '',
        githubClientSecret: '',
        jwtSecret: '',
        allowedGithubIds: [],
        redirectOrigins: [],
        publicOrigin: '',
      },
      trustProxyHops: 0,
    })
    await app.ready()
    // Positive control: the recorder saw the routes at all.
    expect(routes).toEqual(expect.arrayContaining(['GET /ops/me', 'POST /ops/reveal']))
    const writes = routes.filter((r) => !/^(GET|HEAD) /.test(r) && r !== 'POST /ops/reveal')
    expect(writes, 'an ops route other than reveal accepts a write method').toEqual([])
    await app.close()
  })

  it('search and reveal are rate-limited in separate buckets (#3512)', async () => {
    const app = Fastify({ logger: false })
    const limits = new Map<string, unknown>()
    app.addHook('onRoute', (route) => {
      const methods = Array.isArray(route.method) ? route.method : [route.method]
      for (const method of methods) limits.set(`${method} ${route.url}`, (route.config as { rateLimit?: unknown } | undefined)?.rateLimit)
    })
    await app.register(opsRoutes, {
      prefix: '/ops',
      ops: {
        githubClientId: '',
        githubClientSecret: '',
        jwtSecret: '',
        allowedGithubIds: [],
        redirectOrigins: [],
        publicOrigin: '',
      },
      trustProxyHops: 0,
    })
    await app.ready()
    // The bucket separation itself is proven against real Postgres in
    // middleware/__tests__/rate-limit-plugin-integration.test.ts; this pins
    // the wiring, so /search cannot drift back onto reveal's limiter.
    expect(limits.get('GET /ops/search')).toBe(opsSearchRateLimit.rateLimit)
    expect(limits.get('POST /ops/reveal')).toBe(opsRevealRateLimit.rateLimit)
    await app.close()
  })
})
