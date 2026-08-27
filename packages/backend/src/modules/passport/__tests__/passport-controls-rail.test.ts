/**
 * The passport's `controls.rail` must document exactly the values the emitter
 * can produce, and `policyEnforcedOnchain` must answer per rail (#2110, epic
 * #1440).
 *
 * ## Why this test exists
 *
 * `controls.rail` was documented for years as "'delegation' or 'allowance'".
 * The emitter passes `user_safes.execution_rail` through verbatim, and that
 * column's CHECK domain is `allowance_module | session_key | delegation`
 * (migration 041, widening 036). So `'allowance'` was a value the published
 * contract named and the database could not hold — and the same string in
 * `policyEnforcedOnchain`'s `=== 'allowance'` comparison meant that branch
 * never fired.
 *
 * The bug was invisible precisely because the dead comparison produced the
 * RIGHT answer for the WRONG reason: `false` for the legacy rail, which is
 * what #1440 requires anyway. Nothing failed, so nothing surfaced it.
 *
 * ## What this pins, and why it is three assertions rather than one
 *
 * 1. The documented enum equals the column's CHECK domain — the divergence
 *    the issue asks to make impossible to reintroduce.
 * 2. `policyEnforcedOnchain` answers correctly across the WHOLE domain, not
 *    just the live rail. A test that only asserted `delegation → true` would
 *    have passed against the buggy code.
 * 3. `'allowance'` appears nowhere in the passport surface — the specific
 *    string that was wrong, asserted absent so a copy-paste cannot restore it.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { openapiSpec } from '../../../openapi/spec.js'
// The canonical comment stripper (#2107's census). Reused rather than
// re-implemented: the first version of this file scanned raw source and failed
// on its OWN docblocks, which name `'allowance'` to explain why it is wrong.
// A guard over a surface that must DESCRIBE the defect has to strip prose, or
// it fires on the explanation instead of the code — the exact failure mode the
// census documents.
// @ts-expect-error -- plain .mjs CI helper, no type declarations
import { stripComments } from '../../../../../../scripts/ci/queue-framing-census.test.mjs'

const src = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

/**
 * The authoritative domain, read from the migration that owns the constraint
 * rather than restated here — a hardcoded copy would drift the same way the
 * spec description did, which is the whole defect this file guards.
 */
function railDomainFromMigration(): string[] {
  const migration = src('../../../db/migrations/041_hybrid_accounts.ts')
  const m = migration.match(/CHECK \(execution_rail IN \(([^)]*)\)\)/)
  if (!m) throw new Error('could not read the execution_rail CHECK from migration 041')
  return m[1]
    .split(',')
    .map((v) => v.trim().replace(/^'|'$/g, ''))
    .filter(Boolean)
}

/** Mirrors `controlsOf`'s rule. Kept in sync by assertion 2, not by hope. */
const policyEnforcedOnchain = (rail: string) => rail === 'delegation'

function controlsRailSchema(): string[] {
  const json = JSON.stringify(openapiSpec)
  const found = json.match(/"rail":\{"type":"string","enum":(\[[^\]]*\])/)
  if (!found) throw new Error('controls.rail schema not found in the spec')
  return JSON.parse(found[1]) as string[]
}

describe('passport controls.rail (#2110)', () => {
  it('the documented enum is exactly the column CHECK domain — verified, not assumed', () => {
    const domain = railDomainFromMigration()
    expect(domain.sort()).toEqual(['allowance_module', 'delegation', 'session_key'])
    expect(controlsRailSchema().sort()).toEqual(domain.sort())
  })

  it('policyEnforcedOnchain answers across the WHOLE domain, not just the live rail', () => {
    // The buggy version (`=== 'delegation' || === 'allowance'`) also passed a
    // delegation-only assertion. Every member is checked for that reason.
    expect(policyEnforcedOnchain('delegation')).toBe(true)
    expect(policyEnforcedOnchain('allowance_module')).toBe(false)
    expect(policyEnforcedOnchain('session_key')).toBe(false)

    for (const rail of railDomainFromMigration()) {
      expect(
        typeof policyEnforcedOnchain(rail),
        `${rail} must yield a boolean, never undefined`,
      ).toBe('boolean')
    }
  })

  it("the emitter's rule matches this test's mirror, char for char", () => {
    // Guards the one way assertion 2 could go vacuous: the mirror above
    // drifting from `controlsOf`. Pinned to the source line rather than
    // re-implemented.
    const verification = stripComments(src('../verification.ts')) as string
    expect(verification).toMatch(/policyEnforcedOnchain: row\.execution_rail === 'delegation',/)
    expect(verification).not.toMatch(/=== 'allowance'/)
  })

  it("the string 'allowance' appears nowhere in the passport surface", () => {
    for (const rel of ['../verification.ts', '../receipt.ts']) {
      const body = stripComments(src(rel)) as string
      // `allowance_module` is legitimate; a bare `'allowance'` literal is not.
      expect(body, `${rel} carries a bare 'allowance' literal`).not.toMatch(/'allowance'(?!_)/)
    }
  })
})
