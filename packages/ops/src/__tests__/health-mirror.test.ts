/**
 * The #3514 health-shape contract (#3516).
 *
 * `OpsHealth` in `lib/ops-types.ts` is `ApiSchema<'OpsSystemHealth'>`:
 * `packages/core/src/api-types.ts` is generated from the backend's OpenAPI
 * document, which declares `GET /ops/health`'s response as the named
 * `OpsSystemHealth` schema (#3514). A backend field rename regenerates that
 * document, fails this package's typecheck, and the mirror this test used to
 * hold against the branch's source is gone. What remains to pin here is the
 * import itself: the alias must exist and re-export the generated schema —
 * a rename of the generated schema name fails THIS file loudly.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ApiSchema } from '@haven_ai/core'
import type { OpsHealth } from '../lib/ops-types'

// Tests run with the package as cwd (`npm run test` from packages/ops), so
// the generated document resolves from the sibling core package.
const API_TYPES_TS = join(process.cwd(), '..', 'core', 'src', 'api-types.ts')

/** Compile-level: the alias IS the generated schema type (assignable both ways). */
type Expect<T extends true> = T
type SameType<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type _OpsHealthIsGenerated = Expect<SameType<OpsHealth, ApiSchema<'OpsSystemHealth'>>>

describe('the OpsHealth alias re-exports the generated schema', () => {
  it('the generated document declares OpsSystemHealth with the keys the pages render', () => {
    const text = readFileSync(API_TYPES_TS, 'utf8')
    for (const key of [
      'sweepable_intents',
      'evidence_orphans',
      'stuck_revocations',
      'stuck_reanchors',
      'stuck_lanes',
      'delegate_balances',
      'ops_diagnostics',
      'generated_at',
    ]) {
      expect(text, `OpsSystemHealth.${key} in the generated schema`).toContain(`${key}:`)
    }
  })

  it('the generated schema carries the not-available replica variant', () => {
    const text = readFileSync(API_TYPES_TS, 'utf8')
    expect(text).toContain('not_available_on_this_replica')
  })
})
