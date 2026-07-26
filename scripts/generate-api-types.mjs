#!/usr/bin/env node
/**
 * Generate `packages/core/src/api-types.ts` from the backend's OpenAPI spec
 * (#984, epic #980 M1).
 *
 * The spec (`packages/backend/src/openapi/spec.ts`) is the single authoritative
 * description of the API's wire shapes; the frontend used to hand-maintain a
 * parallel copy, which nothing kept honest. This script makes the generated
 * types the only frontend source for wire shapes, and `--check` makes CI fail
 * when the spec changes without regeneration (same drift-gate shape as
 * `packages/backend/src/docs-drift/`).
 *
 * Usage:
 *   node scripts/generate-api-types.mjs            # regenerate in place
 *   node scripts/generate-api-types.mjs --check    # exit 1 on drift, write nothing
 *
 * The spec is a typed TS module, so it is loaded through the backend's `tsx`
 * rather than parsed as JSON — the generator sees exactly what `/openapi.json`
 * serves.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUTPUT = join(ROOT, 'packages/core/src/api-types.ts')
const TSX = join(ROOT, 'node_modules/.bin/tsx')

const BANNER = `/**
 * GENERATED FILE — DO NOT EDIT BY HAND.
 *
 * Generated from \`packages/backend/src/openapi/spec.ts\` by
 * \`scripts/generate-api-types.mjs\` (#984). Regenerate with:
 *
 *   npm run generate:api-types
 *
 * CI fails on drift (\`npm run check:api-types\`): edit the spec, then
 * regenerate — never this file. Frontend-only derived types belong in the
 * frontend, extending these; wire shapes live here and only here.
 */
`

async function main() {
  const check = process.argv.includes('--check')

  // 1. Materialize the spec as JSON through the backend's own module graph.
  const specJson = execFileSync(
    TSX,
    ['-e', "import('./packages/backend/src/openapi/spec.ts').then(m => process.stdout.write(JSON.stringify(m.openapiSpec)))"],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )
  const spec = JSON.parse(specJson)

  // 2. Generate types.
  const openapiTS = (await import('openapi-typescript')).default
  const astToString = (await import('openapi-typescript')).astToString
  const ast = await openapiTS(spec, {
    // Wire shapes only; route interfaces (`paths`) come along for free and are
    // what consumers should key on (`paths['/transactions']['get']…`).
    exportType: true,
  })
  const generated = BANNER + astToString(ast)

  if (check) {
    const current = existsSync(OUTPUT) ? readFileSync(OUTPUT, 'utf8') : ''
    if (current !== generated) {
      console.error('api-types drift: packages/core/src/api-types.ts is stale relative to the OpenAPI spec.')
      console.error('Run `npm run generate:api-types` and commit the result.')
      process.exit(1)
    }
    console.log('api-types: in sync with the spec.')
    return
  }

  writeFileSync(OUTPUT, generated)
  console.log(`wrote ${OUTPUT.replace(ROOT + '/', '')} (${generated.length} bytes)`)
}

main().catch((err) => {
  console.error('generate-api-types failed:', err instanceof Error ? err.message : err)
  process.exit(1)
})
