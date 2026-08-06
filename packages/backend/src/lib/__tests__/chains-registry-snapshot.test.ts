import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { SUPPORTED_CHAIN_IDS, getChain } from '../chains.js'

/**
 * Registry purity snapshot (#986). The chain/token registry is load-bearing
 * for payment routing, so the #980-M1 move into `@haven_ai/core` must be
 * provably pure: this serializes every chain, every token, every field to a
 * fixture committed BEFORE the move, and the moved registry must match
 * byte for byte. Do NOT update the fixture to make this pass — a diff here
 * means the move changed values, and the diff is the bug.
 *
 * `rpcUrl` and `explorerApiKey` are resolved from environment config and are
 * redacted: they are environment wiring, not registry data, and stay in the
 * backend by design.
 */
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'chains-registry.json')

function serializeRegistry(): string {
  const chains = SUPPORTED_CHAIN_IDS.slice().sort((a, b) => a - b).map((id) => {
    const chain = getChain(id)
    return { ...chain, rpcUrl: '<env>', explorerApiKey: '<env>' }
  })
  return JSON.stringify(chains, null, 2) + '\n'
}

describe('backend chain registry snapshot (#986)', () => {
  it('matches the committed pre-move fixture byte for byte', () => {
    const fixture = readFileSync(FIXTURE, 'utf8')
    expect(serializeRegistry()).toBe(fixture)
  })
})
