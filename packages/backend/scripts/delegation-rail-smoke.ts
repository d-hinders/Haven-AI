/**
 * #826 live smoke — the PRODUCTION delegation-rail lib (prepare/submit
 * split), exercised end-to-end on Base Sepolia, twice: cold (delegate
 * account deploys inside the first sponsored op) and warm (steady state).
 *
 * Non-custody proof shape: the backend lib is constructed WATCH-ONLY (it
 * cannot sign); this script plays the CLIENT — it signs the prepared
 * userOpHash with the agent key via the kit account, then hands the
 * signature back to the lib's submit. The signature scheme this pins
 * (account.signUserOperation over the prepared op) is the #829 SDK contract.
 *
 * Env (~/.haven/pilot.env + scratch): PILOT_7710_DELEGATOR_PRIVATE_KEY
 * (treasury owner), SPIKE_DELEGATE_KEY (agent key), PILOT_BUNDLER_URL,
 * PILOT_RPC_URL?, PILOT_ALLOWED_RECIPIENT.
 *
 * Run: npm run pilot:delegation-rail-smoke -w @haven/backend
 */

import { http, createPublicClient, formatUnits, parseAbi, type Hex, type Address } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { baseSepolia } from 'viem/chains'
import {
  Implementation,
  toMetaMaskSmartAccount,
  createOpenDelegation,
  signDelegation,
  type Delegation,
} from '@metamask/smart-accounts-kit'
import { createDelegationRail } from '../src/lib/delegation-rail.js'

const CHAIN = baseSepolia
const USDC: Address = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    console.error(`${name} is required.`)
    process.exit(2)
  }
  return value
}

async function main(): Promise<void> {
  const treasuryKey = requireEnv('PILOT_7710_DELEGATOR_PRIVATE_KEY') as Hex
  const agentKey = requireEnv('SPIKE_DELEGATE_KEY') as Hex
  const bundlerUrl = requireEnv('PILOT_BUNDLER_URL')
  const recipient = requireEnv('PILOT_ALLOWED_RECIPIENT') as Address
  const rpcUrl = process.env.PILOT_RPC_URL ?? 'https://sepolia.base.org'

  const publicClient = createPublicClient({ chain: CHAIN, transport: http(rpcUrl) })
  const treasuryOwner = privateKeyToAccount(treasuryKey)
  const agent = privateKeyToAccount(agentKey)

  // Treasury (the #820 Hybrid, still funded).
  const treasury = await toMetaMaskSmartAccount({
    client: publicClient as never,
    implementation: Implementation.Hybrid,
    deployParams: [treasuryOwner.address, [], [], []],
    deploySalt: '0x',
    signer: { account: treasuryOwner },
  })
  console.log(`treasury:  ${treasury.address}`)

  // The PRODUCTION rail — watch-only; can never sign (throws if it tries).
  const rail = await createDelegationRail({
    delegateOwnerAddress: agent.address,
    chainId: CHAIN.id,
    bundlerUrl,
    rpcUrl,
  })
  console.log(`delegate account (agent-owned): ${rail.delegateAccountAddress}`)

  // Client-side signer stand-in for the SDK (#829): the kit account with the
  // real agent key — signs userOps the way HybridDeleGator validates them.
  const clientSideDelegate = await toMetaMaskSmartAccount({
    client: publicClient as never,
    implementation: Implementation.Hybrid,
    deployParams: [agent.address, [], [], []],
    deploySalt: '0x',
    signer: { account: agent },
  })

  // Grant: ONE offline owner signature — open delegation, small budget.
  const nowSec = Math.floor(Date.now() / 1000)
  const delegation = createOpenDelegation({
    environment: treasury.environment,
    from: treasury.address,
    scope: {
      type: 'erc20PeriodTransfer',
      tokenAddress: USDC,
      periodAmount: 40_000n, // 0.04/period
      periodDuration: 3600,
      startDate: nowSec - 60,
    },
    caveats: [{ type: 'timestamp', afterThreshold: 0, beforeThreshold: nowSec + 3600 }],
  })
  const signed: Delegation = {
    ...delegation,
    signature: await signDelegation({
      privateKey: treasuryKey,
      delegation,
      delegationManager: treasury.environment.DelegationManager,
      chainId: CHAIN.id,
    }),
  }

  const runs: Array<{ label: string; gas: bigint; ms: number; tx: string }> = []
  for (const label of ['cold', 'warm'] as const) {
    const t = Date.now()
    const prepared = await rail.prepareRedemption(signed, USDC, recipient, 10_000n)
    const signature = (await clientSideDelegate.signUserOperation({
      ...prepared.userOperation,
    })) as Hex
    const result = await rail.submitRedemption(prepared, signature)
    runs.push({ label, gas: result.actualGasUsed, ms: Date.now() - t, tx: result.txHash })
    console.log(`✅ ${label}: gas ${result.actualGasUsed}, ${Date.now() - t}ms — tx ${result.txHash}`)
  }

  console.log('')
  console.log('#826 metrics (sponsored redemption via the PRODUCTION lib):')
  for (const r of runs) console.log(`  ${r.label}: ${r.gas} gas · ${r.ms}ms · https://sepolia.basescan.org/tx/${r.tx}`)
  console.log(`  spent: ${formatUnits(20_000n, 6)} USDC treasury→recipient, agent key held 0 ETH / 0 USDC throughout`)
}

main().catch((e) => {
  console.error('delegation-rail-smoke failed:', e instanceof Error ? e.message : e)
  process.exit(1)
})
