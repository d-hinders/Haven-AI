// #2680 slice-2 guard — pins casp-risk-guardrails.md's rail-roster claim (the
// rail census the doc states three times: "the only live rail — epic #1440"):
// `resolveExecutionRail`'s decision union admits exactly one live rail
// (`delegation`) plus the two retired tombstones (`retired_session`,
// `retired_allowance`). Pinned against the union type in
// `rails/execution-rail.ts`, so a third arm — a newly live rail — reddens the
// pin until the doc's roster is consciously updated.
//
// Mutation-proven for #2680: adding a `{ rail: 'delegation_fast' }` arm to the
// union reddens; restoring the file turns it green, byte-identical.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const SEAM = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'src',
  'rails',
  'execution-rail.ts',
)

describe('execution-rail live-rail census (#2680 pin)', () => {
  const src = readFileSync(SEAM, 'utf8')

  it('the decision union holds exactly one live rail and two retired tombstones', () => {
    // The union is a run of `  | { rail: '…' }` lines directly under the
    // alias — match exactly that run, not the whole file.
    const union = src.match(
      /export type ExecutionRailDecision =\n(?:\s+\|\s*\{ rail: '[a-z_]+' \}\n?)+/,
    )?.[0]
    expect(union, 'the ExecutionRailDecision union is load-bearing for the doc').toBeDefined()
    const arms = [...union!.matchAll(/rail: '([a-z_]+)'/g)].map((m) => m[1]).sort()
    expect(arms).toEqual(['delegation', 'retired_allowance', 'retired_session'])
    // Exactly one arm lacks the `retired_` prefix — the one live rail.
    expect(arms.filter((a) => !a.startsWith('retired_'))).toEqual(['delegation'])
  })
})
