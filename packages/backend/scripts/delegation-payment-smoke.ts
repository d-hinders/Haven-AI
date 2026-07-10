/**
 * #829 live smoke — the FULL payment-rail contract, offline of the HTTP API:
 * prepare (production lib) → sign the typed data with the SDK's delegation
 * signer → submit. If the typed data or the scheme were wrong, the account's
 * validateUserOp would reject and this fails. That is exactly the check the
 * route tests cannot make.
 *
 * Env: PILOT_7710_DELEGATOR_PRIVATE_KEY (treasury owner), SPIKE_DELEGATE_KEY
 * (agent key), PILOT_BUNDLER_URL, PILOT_ALLOWED_RECIPIENT, PILOT_RPC_URL?
 *
 * Run: npm run pilot:delegation-payment-smoke -w @haven/backend
 */
import { http, createPublicClient, type Hex, type Address } from 'viem'
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
import { signUserOpTypedDataForDelegation } from '@haven_ai/sdk'

const CHAIN = baseSepolia
const USDC: Address = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'

function requireEnv(name: string): string {
  const v = process.env[name]
  if (!v) { console.error(`${name} is required.`); process.exit(2) }
  return v
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

  const treasury = await toMetaMaskSmartAccount({
    client: publicClient as never,
    implementation: Implementation.Hybrid,
    deployParams: [treasuryOwner.address, [], [], []],
    deploySalt: '0x',
    signer: { account: treasuryOwner },
  })

  const rail = await createDelegationRail({
    delegateOwnerAddress: agent.address,
    chainId: CHAIN.id,
    bundlerUrl,
    rpcUrl,
  })
  console.log(`treasury: ${treasury.address}`)
  console.log(`delegate account: ${rail.delegateAccountAddress}`)

  const nowSec = Math.floor(Date.now() / 1000)
  const delegation = createOpenDelegation({
    environment: treasury.environment,
    from: treasury.address,
    scope: {
      type: 'erc20PeriodTransfer',
      tokenAddress: USDC,
      periodAmount: 30_000n,
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

  // 1. Backend prepares (watch-only).
  const prepared = await rail.prepareRedemption(signed, USDC, recipient, 10_000n)
  console.log('prepared: typed data domain =', prepared.signingTypedData.domain.name)

  // 2. The AGENT signs with the SDK's delegation signer — the exact call the
  //    SDK makes for sign_data.signature_scheme === 'eip712_userop'.
  const signature = await signUserOpTypedDataForDelegation(agentKey, prepared.signingTypedData)
  console.log(`signed by agent key via @haven_ai/sdk (${signature.slice(0, 12)}…)`)

  // 3. Backend submits. The account validates the signature on-chain.
  const result = await rail.submitRedemption(prepared, signature as Hex)
  console.log('')
  console.log(`✅ SDK signature validated ON-CHAIN by the delegate account`)
  console.log(`   gas ${result.actualGasUsed} — tx https://sepolia.basescan.org/tx/${result.txHash}`)
  console.log('   (a wrong typed-data domain or scheme would have reverted in validateUserOp)')
}

main().catch((e) => {
  console.error('delegation-payment-smoke failed:', e instanceof Error ? e.message : e)
  process.exit(1)
})
