#!/usr/bin/env tsx
/**
 * Generate `src/openapi/route-modules.generated.ts` — the `(method, OpenAPI
 * path) → route file` table the request-validation plugin resolves
 * `enforcedModules` against (#3135, epic #3028 decision 7).
 *
 * Why generated rather than derived at boot: `deriveRouteModuleMap()` reads
 * TypeScript SOURCE (`src/index.ts` and `src/routes/*.ts`), and the deployed
 * image ships `dist/*.js` with no `src/` at all — a runtime derivation would
 * resolve nothing in production and silently un-enforce every flipped module.
 * A committed table compiles into `dist` like any other module.
 *
 *   npm run generate:route-modules            # write the table
 *   npm run check:route-modules               # fail if it is stale
 *
 * The rendering itself lives in `openapi/route-inventory.ts` beside the
 * derivation, so `__tests__/route-modules.generated.test.ts` can run the same
 * comparison inside the backend suite without importing this CLI — a stale
 * table cannot reach `dev` through a green PR that simply never ran the script.
 */
import { writeFile, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deriveRouteModuleMap, renderRouteModules } from '../src/openapi/route-inventory.js'

const OUT = join(dirname(fileURLToPath(import.meta.url)), '../src/openapi/route-modules.generated.ts')

async function main(): Promise<void> {
  const rendered = renderRouteModules(await deriveRouteModuleMap())
  if (process.argv.includes('--check')) {
    const current = await readFile(OUT, 'utf8').catch(() => '')
    if (current !== rendered) {
      console.error(
        '✗ src/openapi/route-modules.generated.ts is STALE.\n' +
          '  A route was added, moved or renamed without regenerating the table.\n' +
          '  Run: npm run generate:route-modules',
      )
      process.exit(1)
    }
    console.log('✓ route-modules.generated.ts matches the registered routes.')
    return
  }
  await writeFile(OUT, rendered, 'utf8')
  console.log(`✓ wrote ${OUT}`)
}

await main()
