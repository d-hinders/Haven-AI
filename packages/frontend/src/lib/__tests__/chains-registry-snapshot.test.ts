import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ALL_CHAINS } from '../chains'

/**
 * Registry purity snapshot (#986) — frontend counterpart of the backend's
 * `chains-registry-snapshot.test.ts`. Serialized BEFORE the #980-M1 move into
 * `@haven_ai/core`; the moved registry must match byte for byte. Do NOT
 * update the fixture to make this pass — a diff means the move changed
 * values, and the diff is the bug.
 *
 * `viemChain` is serialized as its chain id only: the viem object is
 * environment/client construction (it stays in the frontend by design), and
 * its id is the load-bearing linkage.
 */
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'chains-registry.json')

function serializeRegistry(): string {
  const chains = ALL_CHAINS.slice()
    .sort((a, b) => a.chainId - b.chainId)
    .map((chain) => ({ ...chain, viemChain: { id: chain.viemChain.id } }))
  return JSON.stringify(chains, null, 2) + '\n'
}

describe('frontend chain registry snapshot (#986)', () => {
  it('matches the committed pre-move fixture byte for byte', () => {
    const fixture = readFileSync(FIXTURE, 'utf8')
    expect(serializeRegistry()).toBe(fixture)
  })
})
