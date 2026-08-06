import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { openapiSpec } from '../openapi/spec.js'
import { getChain, SUPPORTED_CHAIN_IDS } from '../lib/chains.js'

/**
 * Documentation drift tests (Phase 2 of the docs-quality system, epic #642).
 *
 * These generalize the OpenAPI drift test (`openapi/spec.test.ts`): they pin
 * hand-maintained claims in `CLAUDE.md` to the code those claims mirror, so the
 * doc and the code can never silently disagree. When a row here fails, either
 * the code changed (update CLAUDE.md) or the doc is wrong (fix it) — the failure
 * names which.
 *
 * Keep the `because:` allowlists tight: the default is "document it correctly",
 * not "add an exception".
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..', '..', '..', '..')
const CLAUDE_MD = readFileSync(join(REPO_ROOT, 'CLAUDE.md'), 'utf8')

describe('CLAUDE.md API surface table matches the OpenAPI spec', () => {
  // Endpoints listed in the "API Surface (POC)" table but intentionally not in
  // the published spec. Each needs an explicit reason.
  const KNOWN_DOC_ONLY: Array<{ method: string; path: string; because: string }> = []

  // Parse rows like: | `/agents/{id}/revoke` | POST | Create agent |
  const rows = [...CLAUDE_MD.matchAll(/^\|\s*`(\/[^`]*)`\s*\|\s*([A-Z]+)\s*\|/gm)].map((m) => ({
    path: m[1],
    method: m[2].toLowerCase(),
  }))

  it('finds the documented endpoint table', () => {
    // Guard against the table being moved/renamed and this test silently
    // passing with zero rows.
    expect(rows.length).toBeGreaterThanOrEqual(5)
  })

  const specPaths = openapiSpec.paths as Record<string, Record<string, unknown>>

  for (const row of rows) {
    const allowed = KNOWN_DOC_ONLY.find((e) => e.method === row.method && e.path === row.path)
    const label = `${row.method.toUpperCase()} ${row.path}`

    it(`documents ${label} consistently with the spec`, () => {
      if (allowed) return
      const pathItem = specPaths[row.path]
      expect(pathItem, `CLAUDE.md documents ${label} but it is missing from openapiSpec.paths`).toBeDefined()
      expect(
        pathItem[row.method],
        `CLAUDE.md documents ${label} but the spec has no ${row.method.toUpperCase()} on ${row.path}`,
      ).toBeDefined()
    })
  }
})

describe('CLAUDE.md chain claims match the chains registry', () => {
  it('only references chain IDs that are actually supported', () => {
    const referenced = [...CLAUDE_MD.matchAll(/chain ID (\d+)/g)].map((m) => Number(m[1]))
    expect(referenced.length).toBeGreaterThan(0)
    for (const id of referenced) {
      expect(
        SUPPORTED_CHAIN_IDS,
        `CLAUDE.md references chain ID ${id}, which is not in lib/chains.ts`,
      ).toContain(id)
    }
  })

  it('pins the documented primary (Base) and secondary (Gnosis) chains', () => {
    // CLAUDE.md: "Base (chain ID 8453) is the primary / default network;
    // Gnosis Chain (chain ID 100) is also supported".
    expect(getChain(8453).name).toBe('Base')
    expect(getChain(8453).shortName).toBe('base')
    expect(getChain(100).name).toBe('Gnosis Chain')
  })
})
