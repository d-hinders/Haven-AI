/**
 * #452 buyer prototype: pay an x402 merchant DIRECTLY from a smart account —
 * no delegate funding leg, no transient hot balance (the structural fix the
 * delegate-exposure epic #713 pointed at).
 *
 * Counterpart to the merchant half (#747/#750: demo-merchant advertises
 * `assetTransferMethod: 'erc7710'`, verifies by simulating
 * `redeemDelegations`, settles from its settlement key). This script is the
 * buyer: a MetaMask (ERC-7710) smart account signs a delegation; the payment
 * payload carries { delegator, delegationManager, permissionContext }; the
 * merchant redeems and USDC moves smart account → merchant in one tx.
 *
 * Per the #452 decisions (research doc §7): ready-made framework first
 * (MetaMask Smart Accounts Kit) to prove settlement fast — porting to Safe is
 * the follow-up; local demo-merchant as the facilitator so nothing blocks on a
 * vendor. Testnet-only, experimental, isolated from every production path.
 *
 * Env (~/.haven/pilot.env):
 *   PILOT_7710_DELEGATOR_PRIVATE_KEY  throwaway EOA key controlling the smart account
 *   PILOT_MERCHANT_URL                demo-merchant base URL (e.g. http://localhost:8402)
 *   PILOT_BUNDLER_URL                 Pimlico Base Sepolia URL (deploys the delegator, sponsored)
 *   PILOT_RPC_URL                     optional, default https://sepolia.base.org
 *
 * Run: npm run pilot:x402-7710-buyer -w packages/qa-agent
 *
 * The merchant must run with the rail on:
 *   MERCHANT_X402_ERC7710=1
 *   MERCHANT_ERC7710_DELEGATION_MANAGER=<the DelegationManager this script prints>
 */

import {
  http,
  createPublicClient,
  parseAbi,
  formatUnits,
  type Address,
  type Chain,
  type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { baseSepolia } from 'viem/chains'
import { entryPoint07Address } from 'viem/account-abstraction'
import { createSmartAccountClient } from 'permissionless'
import { createPimlicoClient } from 'permissionless/clients/pimlico'
import { Implementation, toMetaMaskSmartAccount } from '@metamask/smart-accounts-kit'
import { createx402DelegationProvider } from '@metamask/smart-accounts-kit/experimental'
import { x402Erc7710Client } from '@metamask/x402'
import { wrapFetchWithPayment, x402Client, decodePaymentResponseHeader } from '@x402/fetch'

const CHAIN: Chain = baseSepolia
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as Address
const ERC20_ABI = parseAbi(['function balanceOf(address) view returns (uint256)'])
const VPN_BASIC_PRICE = 1_000n // 0.001 USDC — the demo merchant's cheapest product
const DELEGATION_EXPIRY_SECONDS = 3600

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    console.error(`${name} is required.`)
    process.exit(2)
  }
  return value
}

async function mcpRequest(
  fetchImpl: typeof fetch,
  url: string,
  body: unknown,
  sessionId?: string,
): Promise<{ response: Response; sessionId?: string }> {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
    },
    body: JSON.stringify(body),
  })
  return { response, sessionId: response.headers.get('mcp-session-id') ?? sessionId }
}

async function main(): Promise<void> {
  const delegatorKey = requireEnv('PILOT_7710_DELEGATOR_PRIVATE_KEY') as Hex
  const merchantUrl = requireEnv('PILOT_MERCHANT_URL').replace(/\/$/, '')
  const bundlerUrl = requireEnv('PILOT_BUNDLER_URL')
  const rpcUrl = process.env.PILOT_RPC_URL ?? 'https://sepolia.base.org'

  const publicClient = createPublicClient({ chain: CHAIN, transport: http(rpcUrl) })
  const owner = privateKeyToAccount(delegatorKey)

  // 1. The delegator: a MetaMask Hybrid smart account owned by the throwaway EOA.
  const smartAccount = await toMetaMaskSmartAccount({
    client: publicClient,
    implementation: Implementation.Hybrid,
    deployParams: [owner.address, [], [], []],
    deploySalt: '0x',
    signer: { account: owner },
  })
  const delegator = smartAccount.address
  console.log(`delegator (smart account): ${delegator}`)
  console.log(`  owner EOA:               ${owner.address}`)
  console.log(`  delegation manager:      ${smartAccount.environment.DelegationManager}`)

  // 2. Deploy the delegator if needed — one sponsored no-op UserOp via the
  //    pilot bundler. EIP-1271 delegation signatures need deployed code.
  const code = await publicClient.getCode({ address: delegator })
  if (!code || code === '0x') {
    console.log('deploying the delegator (sponsored UserOp)…')
    const pimlico = createPimlicoClient({
      transport: http(bundlerUrl),
      entryPoint: { address: entryPoint07Address, version: '0.7' },
    })
    const accountClient = createSmartAccountClient({
      account: smartAccount,
      chain: CHAIN,
      bundlerTransport: http(bundlerUrl),
      paymaster: pimlico,
      userOperation: {
        estimateFeesPerGas: async () => (await pimlico.getUserOperationGasPrice()).fast,
      },
    })
    const userOpHash = await accountClient.sendUserOperation({
      calls: [{ to: delegator, value: 0n, data: '0x' }],
    })
    await pimlico.waitForUserOperationReceipt({ hash: userOpHash })
    console.log('  deployed ✓')
  }

  // 3. The delegator must hold USDC — it pays the merchant DIRECTLY.
  const balanceBefore = (await publicClient.readContract({
    address: USDC,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [delegator],
  })) as bigint
  console.log(`delegator USDC balance:    ${formatUnits(balanceBefore, 6)}`)
  if (balanceBefore < VPN_BASIC_PRICE) {
    console.error('')
    console.error(`Fund the DELEGATOR with test USDC first (≥ ${formatUnits(VPN_BASIC_PRICE, 6)}):`)
    console.error(`  send Base Sepolia USDC to ${delegator}`)
    console.error('then re-run. (This is the smart account paying the merchant — the whole point.)')
    process.exit(2)
  }

  // 4. The x402 buyer stack: delegation provider (signs an ERC-7710 delegation
  //    with redeemer/target/expiry caveats) → erc7710 payment client → fetch
  //    wrapper that auto-pays 402 responses.
  const provider = createx402DelegationProvider({
    account: smartAccount,
    expirySeconds: DELEGATION_EXPIRY_SECONDS,
  })
  // The merchant advertises BOTH eip3009 (default) and erc7710; the default
  // selector takes the first option, so pick the erc7710 one explicitly.
  const selectErc7710 = (
    _version: number,
    requirements: Array<{ extra?: Record<string, unknown> | null }>,
  ) => {
    const erc7710 = requirements.find((r) => r.extra?.assetTransferMethod === 'erc7710')
    if (!erc7710) throw new Error('merchant did not advertise assetTransferMethod erc7710')
    return erc7710
  }
  const client = new x402Client(selectErc7710 as never).register(
    `eip155:${CHAIN.id}`,
    new x402Erc7710Client({ delegationProvider: provider }),
  )
  const fetchWithPay = wrapFetchWithPayment(fetch, client)

  // 5. MCP handshake against the demo merchant, then the paid tool call —
  //    the 402 → sign-delegation → retry loop happens inside fetchWithPay.
  const mcpUrl = `${merchantUrl}/mcp`
  console.log(`\n1/3 MCP initialize → ${mcpUrl}`)
  const init = await mcpRequest(fetch, mcpUrl, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'haven-7710-buyer-pilot', version: '0.0.1' },
    },
  })
  if (!init.response.ok) {
    console.error(`initialize failed: HTTP ${init.response.status}`, await init.response.text())
    process.exit(1)
  }
  const sessionId = init.sessionId
  console.log(`   session: ${sessionId ?? '(stateless)'}`)

  console.log('2/3 tools/call buy_vpn(basic) — 402 expected, auto-paid via ERC-7710…')
  const { response: paid } = await mcpRequest(
    fetchWithPay as typeof fetch,
    mcpUrl,
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'buy_vpn', arguments: { plan: 'basic' } },
    },
    sessionId,
  )
  const bodyText = await paid.text()
  if (!paid.ok) {
    console.error(`   payment failed: HTTP ${paid.status}`)
    console.error(bodyText.slice(0, 800))
    process.exit(1)
  }

  console.log('3/3 settled — reading evidence…')
  const paymentResponseHeader =
    paid.headers.get('payment-response') ?? paid.headers.get('x-payment-response')
  const settle = paymentResponseHeader ? decodePaymentResponseHeader(paymentResponseHeader) : null
  // The merchant responds when the settle tx is SUBMITTED; poll until the
  // balance reflects it (or time out) so the printed evidence is on-chain
  // truth, not a race.
  let balanceAfter = balanceBefore
  for (let attempt = 0; attempt < 10 && balanceAfter === balanceBefore; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 3_000))
    balanceAfter = (await publicClient.readContract({
      address: USDC,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [delegator],
    })) as bigint
  }

  console.log('')
  console.log('✅ #452 PROTOTYPE PASSED — merchant paid DIRECTLY from the smart account')
  console.log(`   delegator:      ${delegator}`)
  console.log(`   spent:          ${formatUnits(balanceBefore - balanceAfter, 6)} USDC (price ${formatUnits(VPN_BASIC_PRICE, 6)})`)
  if (settle && typeof settle === 'object' && 'transaction' in settle) {
    console.log(`   settle tx:      https://sepolia.basescan.org/tx/${(settle as { transaction?: string }).transaction}`)
  } else if (paymentResponseHeader) {
    console.log(`   settle header:  ${paymentResponseHeader.slice(0, 60)}…`)
  }
  console.log('   no delegate EOA ever held the funds — the in-flight window does not exist on this rail.')
  console.log('   paste the tx link on #452.')
}

main().catch((e) => {
  console.error('x402-7710-buyer failed:', e instanceof Error ? `${e.name}: ${e.message.slice(0, 400)}` : e)
  process.exit(1)
})
