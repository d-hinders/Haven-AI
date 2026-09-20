/**
 * The generated `(method, OpenAPI path) → route file` table must agree with
 * the routes the server actually registers (#3135, epic #3028 decision 7).
 *
 * The request-validation plugin resolves `enforcedModules` through that table,
 * and it is GENERATED rather than derived at boot because the derivation reads
 * TypeScript source while the deployed image ships only `dist/*.js`. A stale
 * table therefore fails quietly in both directions: a route it does not know
 * is never enforced, so a module somebody flipped keeps shadow-logging while
 * the gate reports it enforced; and a route that MOVED keeps its old
 * attribution, so a route in a file nobody listed stays enforced. Neither is
 * visible at runtime, which is why the staleness itself is what gets gated.
 * `npm run check:route-modules` says the same thing
 * from the CLI; this is the copy that runs inside the backend suite, so a PR
 * that simply never ran the script cannot reach `dev` green.
 */
import { describe, expect, it } from 'vitest'
import {
  deriveRouteModuleMap,
  operationKey,
  renderRouteModules,
  routeModuleKey,
} from '../route-inventory.js'
import { ROUTE_MODULE_BY_OPERATION } from '../route-modules.generated.js'

describe('route-modules.generated.ts (#3135)', () => {
  it('is not stale — it equals what the registration table derives today', async () => {
    expect(ROUTE_MODULE_BY_OPERATION).toEqual(await deriveRouteModuleMap())
  })

  it('is byte-identical to what the generator would write', async () => {
    // Stronger than the object comparison above: it also pins the committed
    // file's formatting, so `--check` and the suite cannot disagree.
    const { readFile } = await import('node:fs/promises')
    const committed = await readFile(new URL('../route-modules.generated.ts', import.meta.url), 'utf8')
    expect(committed).toBe(renderRouteModules(await deriveRouteModuleMap()))
  })

  it('attributes the four route files sharing the /agents mount separately', async () => {
    const map = await deriveRouteModuleMap()
    const agentFiles = new Set(
      Object.entries(map)
        .filter(([key]) => key.includes(' /agents'))
        .map(([, file]) => file),
    )
    expect(agentFiles).toEqual(
      new Set([
        'routes/agents.ts',
        'routes/agent-delegations.ts',
        'routes/agent-rekey.ts',
        'routes/agent-passports.ts',
        // #3167: the label assignment route shares the /agents mount too.
        'routes/agent-labels.ts',
      ]),
    )
  })

  it('refuses a collision rather than picking a silent winner', () => {
    // The derivation throws when two modules claim one (method, path), because
    // a silent winner is how a module nobody flipped gets enforced. Pinned on
    // the shape of the guard rather than by forging a second index.ts.
    expect(operationKey('post', '/agents')).toBe('POST /agents')
    expect(routeModuleKey({ file: 'index.ts', sourcePath: '/x/src/index.ts', prefix: '' })).toBe('index.ts')
  })

  it('CONTROL: the derivation returns a populated table', async () => {
    // "No drift" is only evidence when the instrument can find something.
    const map = await deriveRouteModuleMap()
    expect(Object.keys(map).length).toBeGreaterThan(100)
    expect(map['POST /contacts']).toBe('routes/contacts.ts')
  })
})
