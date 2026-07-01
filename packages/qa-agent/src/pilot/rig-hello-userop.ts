/**
 * ERC-4337 rig hello-world (#720, ADR #719 Stage 1).
 *
 * Proves the pilot rig end to end on Base Sepolia: a throwaway owner key gets a
 * counterfactual Safe with the Safe7579 adapter (its "4337 mailbox"), signs one
 * trivial UserOp (a 0-value self-call), a bundler submits it, and a sponsoring
 * paymaster pays the gas — the account holds no ETH, mirroring Haven's gasless
 * model. First run also deploys the account (initCode piggybacks on the op).
 *
 * This is deliberately NOT wired into any Haven flow: no SDK, no backend, no
 * QA-harness identity. It exists to validate bundler + paymaster + client-SDK
 * choices before #721 (pilot account provisioning) builds on them.
 *
 * Run: npm run pilot:rig -w packages/qa-agent   (env: see pilot/config.ts)
 */

import { http, createPublicClient, formatEther } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { baseSepolia } from 'viem/chains'
import { entryPoint07Address } from 'viem/account-abstraction'
import { createSmartAccountClient } from 'permissionless'
import { toSafeSmartAccount } from 'permissionless/accounts'
import { createPimlicoClient } from 'permissionless/clients/pimlico'
import { loadPilotRigConfig } from './config.js'

async function main(): Promise<void> {
  let cfg
  try {
    cfg = loadPilotRigConfig(process.env)
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e))
    process.exit(2)
  }

  const publicClient = createPublicClient({ chain: baseSepolia, transport: http(cfg.rpcUrl) })
  const owner = privateKeyToAccount(cfg.ownerPrivateKey)
  console.log(`owner (throwaway):     ${owner.address}`)

  // Counterfactual Safe in ERC-7579 mode: the launchpad wires the Safe7579
  // adapter in at deploy time, so the account is born with its 4337 mailbox.
  const account = await toSafeSmartAccount({
    client: publicClient,
    owners: [owner],
    version: '1.4.1',
    entryPoint: { address: entryPoint07Address, version: '0.7' },
    safe4337ModuleAddress: cfg.safe7579AdapterAddress,
    erc7579LaunchpadAddress: cfg.erc7579LaunchpadAddress,
    attesters: [cfg.attesterAddress],
    attestersThreshold: 1,
    saltNonce: cfg.saltNonce,
  })
  console.log(`pilot Safe (7579):     ${account.address}`)

  const code = await publicClient.getCode({ address: account.address })
  console.log(`already deployed:      ${code !== undefined && code !== '0x'}`)
  const balance = await publicClient.getBalance({ address: account.address })
  console.log(`account ETH balance:   ${formatEther(balance)} (should stay 0 — paymaster pays)`)

  // One client, three roles (Pimlico-style URL): bundler transport, paymaster
  // sponsorship, and the gas-price oracle bundlers require.
  const pimlico = createPimlicoClient({
    transport: http(cfg.bundlerUrl),
    entryPoint: { address: entryPoint07Address, version: '0.7' },
  })
  const smartAccountClient = createSmartAccountClient({
    account,
    chain: baseSepolia,
    bundlerTransport: http(cfg.bundlerUrl),
    paymaster: pimlico,
    userOperation: {
      estimateFeesPerGas: async () => (await pimlico.getUserOperationGasPrice()).fast,
    },
  })

  // The hello-world op: a 0-value call to self. Moves nothing, proves everything
  // (validation via Safe7579, bundler inclusion, paymaster sponsorship, and on
  // first run the CREATE2 deployment).
  console.log('sending hello-world UserOp (0-value self-call)…')
  const txHash = await smartAccountClient.sendTransaction({
    to: account.address,
    value: 0n,
    data: '0x',
  })

  console.log('')
  console.log('✅ rig proven — one sponsored UserOp landed on Base Sepolia')
  console.log(`   tx:       https://sepolia.basescan.org/tx/${txHash}`)
  console.log(`   account:  https://sepolia.basescan.org/address/${account.address}`)
  console.log('   next:     #721 provisions the pilot QA Safe on this rig')
}

main().catch((e) => {
  console.error('rig run failed:', e instanceof Error ? e.message : e)
  process.exit(1)
})
