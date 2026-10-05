/**
 * #3620 (epic #3615 S-E) — the entrypoint matrix has a decision for every
 * cell.
 *
 * Enumerates `MATRIX_ENTRYPOINTS × MATRIX_SCOPES × MATRIX_STATES`. The scope
 * columns come from the resolver's `BUDGET_SCOPE_KINDS`, so a scope added
 * there without a decision for every entrypoint and request state fails
 * here, naming the cells. `entrypoint-matrix.db.test.ts` runs the applicable
 * cells through the real routes; this file runs without a database, so the
 * completeness rule holds in every suite run.
 */
import { describe, expect, it } from 'vitest'
import { BUDGET_SCOPE_KINDS } from '../index.js'
import {
  ENTRYPOINT_MATRIX,
  MATRIX_ENTRYPOINTS,
  MATRIX_SCOPES,
  MATRIX_STATES,
  isNotApplicable,
} from './entrypoint-matrix.js'

describe('#3620 entrypoint × scope × state matrix — completeness', () => {
  it('the scope columns are every resolver scope plus the merchant pin', () => {
    expect([...MATRIX_SCOPES]).toEqual([...BUDGET_SCOPE_KINDS, 'merchantPin'])
  })

  it('the cross product is 4 entrypoints × 4 scopes × 4 states = 64 cells today', () => {
    expect(MATRIX_ENTRYPOINTS.length * MATRIX_SCOPES.length * MATRIX_STATES.length).toBe(64)
  })

  it('every cell has an entry: an expected outcome with a reason, or a not-applicable reason', () => {
    const missing: string[] = []
    for (const entrypoint of MATRIX_ENTRYPOINTS) {
      for (const scope of MATRIX_SCOPES) {
        for (const state of MATRIX_STATES) {
          const entry = ENTRYPOINT_MATRIX[entrypoint]?.[scope]?.[state]
          if (!entry) missing.push(`${entrypoint} × ${scope} × ${state}`)
        }
      }
    }
    expect(missing).toEqual([])
  })

  it('no entry outside the cross product (a renamed scope or state cannot leave a dead row behind)', () => {
    const stray: string[] = []
    for (const [entrypoint, row] of Object.entries(ENTRYPOINT_MATRIX)) {
      if (!(MATRIX_ENTRYPOINTS as readonly string[]).includes(entrypoint)) stray.push(entrypoint)
      for (const [scope, cells] of Object.entries(row ?? {})) {
        if (!(MATRIX_SCOPES as readonly string[]).includes(scope)) stray.push(`${entrypoint} × ${scope}`)
        for (const state of Object.keys(cells ?? {})) {
          if (!(MATRIX_STATES as readonly string[]).includes(state)) stray.push(`${entrypoint} × ${scope} × ${state}`)
        }
      }
    }
    expect(stray).toEqual([])
  })

  it('every entry says why', () => {
    for (const row of Object.values(ENTRYPOINT_MATRIX)) {
      for (const cells of Object.values(row ?? {})) {
        for (const entry of Object.values(cells ?? {})) {
          if (!entry) continue
          if (isNotApplicable(entry)) expect(entry.notApplicable.length).toBeGreaterThan(20)
          else {
            expect(entry.outcome).toMatch(/^\d{3}( |$)/)
            expect(entry.why.length).toBeGreaterThan(20)
          }
        }
      }
    }
  })
})
