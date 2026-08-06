/**
 * One-off: deploy a counterfactual delegator (treasury) Hybrid so its budget
 * delegation can be validated on redemption. This is the step the delegation
 * rail's grant lifecycle is MISSING (#835 finding) — done here by hand to prove
 * rows 3–8 work once the delegator is deployed.
 *
 * Env: PILOT_OWNER_PRIVATE_KEY (treasury owner), PILOT_BUNDLER_URL, PILOT_RPC_URL?
 * Arg: the treasury address to deploy (defaults to the DoD account).
 */
import { createPublicClient, http, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { baseSepolia } from 'viem/chains'
import { createTreasuryOps } from '../src/lib/delegation-rail.js'

async function main(): Promise<void> {
  const ownerKey = process.env.PILOT_OWNER_PRIVATE_KEY as Hex
  const bundlerUrl = process.env.PILOT_BUNDLER_URL
  if (!ownerKey || !bundlerUrl) { console.error('need PILOT_OWNER_PRIVATE_KEY + PILOT_BUNDLER_URL'); process.exit(2) }
  process.env.DELEGATION_RAIL_BUNDLER_URL = bundlerUrl // createTreasuryOps reads this via delegationRailBundlerUrl in routes, but here we pass bundlerUrl directly
  const rpcUrl = process.env.PILOT_RPC_URL ?? 'https://sepolia.base.org'
  const owner = privateKeyToAccount(ownerKey)
  const target = (process.argv[2] as Address) ?? '0x8B9bfeC4B58ffF2c830c49F1F0b57daa8a4BCac1'

  const pc = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) })
  const before = await pc.getBytecode({ address: target })
  console.log(`treasury ${target} — ${before && before !== '0x' ? 'already deployed' : 'counterfactual'}`)
  if (before && before !== '0x') return

  const treasury = await createTreasuryOps({
    ownerAddress: owner.address as Address,
    chainId: baseSepolia.id,
    bundlerUrl,
    rpcUrl,
    sponsorshipPolicyId: process.env.DELEGATION_RAIL_SPONSORSHIP_POLICY_ID || undefined,
  })
  if (treasury.treasuryAddress.toLowerCase() !== target.toLowerCase()) {
    console.error(`owner ${owner.address} derives ${treasury.treasuryAddress}, not ${target}. Wrong owner key.`)
    process.exit(1)
  }
  // A no-op self-call: the prepared UserOp carries the factory, so submitting it deploys the account.
  const prepared = await treasury.prepareCall(target, '0x')
  const types = { ...prepared.signingTypedData.types }
  delete (types as Record<string, unknown>).EIP712Domain
  const signature = await owner.signTypedData({
    domain: prepared.signingTypedData.domain,
    types,
    primaryType: prepared.signingTypedData.primaryType,
    message: prepared.signingTypedData.message,
  } as never)
  const result = await treasury.submitCall(prepared, signature as Hex)
  console.log(`✅ deployed — tx https://sepolia.basescan.org/tx/${result.txHash}`)
}

main().catch((e) => { console.error('deploy-treasury failed:', e instanceof Error ? e.message : e); process.exit(1) })
