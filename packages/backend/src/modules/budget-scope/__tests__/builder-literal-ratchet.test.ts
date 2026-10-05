/**
 * #3620 (epic #3615 S-E) — the `delegation_budget_exceeded` refusal body has
 * ONE builder.
 *
 * Before the #3616 module the literal was written at nine sites in three files:
 * five response bodies and four refusal-ledger `detail` objects.
 * #3616–#3619 moved every authorize-time site onto the module's builders
 * (`buildPeriodExceededBody`, `periodExceededLedgerDetail`). The literal
 * `error_code: 'delegation_budget_exceeded'` may now appear in non-test
 * backend source only:
 *
 * - in the module (`modules/budget-scope/refusal-body.ts`), and
 * - in `routes/payments.ts`'s sign-leg revert 502. #3618 deliberately left
 *   that one alone: it is decided after the chain reverted, not by a
 *   pre-check, and it reads nothing from the resolver.
 *
 * A source scan, not a behaviour test, on purpose: a new hand-built site
 * reddens here whether or not any test reaches its branch. `openapi/` is
 * excluded because it documents the wire value; it builds no body.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SRC = fileURLToPath(new URL('../../..', import.meta.url))
// The exact single-quoted spelling the issue defines (#3620). A double-quoted
// or computed error code would slip past; the codebase writes neither today.
const LITERAL = "error_code: 'delegation_budget_exceeded'"

/** Every allowed site, with its exact count. A stale entry fails too. */
const ALLOWED: Record<string, number> = {
  'modules/budget-scope/refusal-body.ts': 2,
  'routes/payments.ts': 1,
}

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      if (name === '__tests__' || name === '__fixtures__' || name === 'node_modules') continue
      if (relative(SRC, full) === 'openapi') continue
      out.push(...sourceFiles(full))
    } else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) {
      out.push(full)
    }
  }
  return out
}

function literalSites(): Record<string, number> {
  const sites: Record<string, number> = {}
  for (const file of sourceFiles(SRC)) {
    const count = readFileSync(file, 'utf8').split(LITERAL).length - 1
    if (count > 0) sites[relative(SRC, file)] = count
  }
  return sites
}

describe('delegation_budget_exceeded has one builder (#3620)', () => {
  it('the scan can say yes: it finds the module itself', () => {
    // Anti-vacuity: a wrong SRC root or an over-eager exclusion would find
    // nothing and pass the equality below trivially.
    expect(sourceFiles(SRC).length).toBeGreaterThan(100)
    expect(literalSites()['modules/budget-scope/refusal-body.ts']).toBeGreaterThan(0)
  })

  it('the literal appears only in the #3616 module and the /payments sign-leg revert 502', () => {
    expect(literalSites()).toEqual(ALLOWED)
  })

  it('the one /payments site is the sign-leg revert 502, not a pre-check', () => {
    const source = readFileSync(join(SRC, 'routes/payments.ts'), 'utf8')
    const at = source.indexOf(LITERAL)
    const window = source.slice(Math.max(0, at - 1500), at)
    expect(window).toContain('isPeriodBudgetRevert(err)')
    expect(window).toContain('reply.code(502)')
  })
})
