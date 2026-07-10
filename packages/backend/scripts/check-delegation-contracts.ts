/**
 * #826 standing check: are the PINNED delegation-framework contracts still
 * live bytecode on every enabled chain? The pins in lib/delegation-contracts
 * are Haven's security anchor (audited, immutable deployments) — this probe
 * catches an RPC pointing at the wrong network, a bad pin edit, or (however
 * unlikely) a chain reorg/removal, and doubles as the re-evaluation tripwire
 * hook: if MetaMask ships NEW manager versions, the pins here intentionally
 * do NOT move (see the fork-and-pin policy in the runbook).
 *
 * exit 0 = all pinned contracts have code · 1 = something is missing.
 * Run: npm run ops:check-delegation -w @haven/backend
 */

import { getChain } from '../src/lib/chains.js'
import {
  DELEGATION_RAIL_CHAIN_IDS,
  getDelegationContracts,
} from '../src/lib/delegation-contracts.js'

async function hasCode(rpcUrl: string, address: string): Promise<boolean> {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getCode', params: [address, 'latest'] }),
    signal: AbortSignal.timeout(15_000),
  })
  const body = (await response.json()) as { result?: string }
  return typeof body.result === 'string' && body.result.length > 2
}

async function main(): Promise<void> {
  let failures = 0
  for (const chainId of DELEGATION_RAIL_CHAIN_IDS) {
    const { rpcUrl } = getChain(chainId)
    const pins = getDelegationContracts(chainId)
    const targets: Array<[string, string]> = [
      ['DelegationManager', pins.delegationManager],
      ['EntryPoint', pins.entryPoint],
      ['SimpleFactory', pins.simpleFactory],
      ['HybridDeleGatorImpl', pins.hybridDeleGatorImpl],
      ...Object.entries(pins.enforcers).map(([n, a]): [string, string] => [`enforcer:${n}`, a]),
    ]
    console.log(`chain ${chainId}:`)
    for (const [name, address] of targets) {
      const ok = await hasCode(rpcUrl, address)
      console.log(`  ${ok ? '✓' : '✗'} ${name} ${address}`)
      if (!ok) failures++
    }
  }
  if (failures > 0) {
    console.error(`❌ ${failures} pinned contract(s) missing bytecode — check pins/RPC before ANY rail use.`)
    process.exit(1)
  }
  console.log('✅ every pinned delegation contract is live bytecode.')
}

main().catch((e) => {
  console.error('check-delegation-contracts failed:', e instanceof Error ? e.message : e)
  process.exit(1)
})
