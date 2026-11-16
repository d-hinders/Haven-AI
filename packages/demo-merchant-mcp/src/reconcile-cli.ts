/**
 * #4853: the reconciliation CLI's entry point.
 *
 * `scripts/reconcile-stripe.mjs` is the thin wrapper that calls `main()`; the
 * logic lives here, under `src/`, so it is on the money-path list and reviewed
 * as such — it creates live PaymentIntents.
 *
 * It runs inside the merchant service's environment, as a one-off command
 * using that service's variables (`STRIPE_SECRET_KEY`, `STRIPE_DEPOSIT_ADDRESS`,
 * `BASE_RPC_URL`, `MERCHANT_CHAIN_ID`). The key is never exported to a local
 * shell or written to a file, and the report it prints carries transaction
 * hashes and PaymentIntent IDs only.
 */
import { createPublicClient, http, type PublicClient } from 'viem'
import { base, baseSepolia } from 'viem/chains'
import { CHAIN_ID, PRODUCTS } from './products.js'
import { createStripeRecording, resolveStripeConfig } from './stripe.js'
import { createViemReconcileChainReader, reconcileStripe } from './stripe-reconcile.js'

export const USAGE = `Usage: reconcile-stripe --from-block <n> --to-block <n>

Lists the settled joke payments to the Stripe deposit address that have no
PaymentIntent, and records them. Only EIP-3009 transfers of the product's exact
price are recorded; any other transfer to the address is listed as "not
recorded" and left alone.

Environment (the merchant service's own variables):
  STRIPE_SECRET_KEY        restricted key: create PaymentIntents, read PaymentIntents
  STRIPE_DEPOSIT_ADDRESS   the deposit address the joke is paid to
  BASE_RPC_URL             the chain's RPC
  MERCHANT_CHAIN_ID        8453 (default) or 84532 for Base Sepolia

Exit codes: 0 recorded or nothing to do, 1 usage or configuration, 2 a payment
Stripe refused.`

export function parseBlockRange(argv: string[]): { fromBlock: bigint; toBlock: bigint } | undefined {
  const values: Record<string, string> = {}
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!
    const match = /^--(from-block|to-block)(?:=(.*))?$/.exec(arg)
    if (!match) return undefined
    const value = match[2] ?? argv[++index]
    if (value === undefined) return undefined
    values[match[1]!] = value
  }
  const from = values['from-block']
  const to = values['to-block']
  if (!from || !to) return undefined
  if (!/^\d+$/.test(from) || !/^\d+$/.test(to)) return undefined
  const fromBlock = BigInt(from)
  const toBlock = BigInt(to)
  if (toBlock < fromBlock) return undefined
  return { fromBlock, toBlock }
}

export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const range = parseBlockRange(argv)
  if (!range) {
    console.error(USAGE)
    return 1
  }

  // The script records what CDP already settled, so it does not need CDP
  // itself — only the two Stripe values and the chain.
  const config = resolveStripeConfig({
    depositAddressRaw: env.STRIPE_DEPOSIT_ADDRESS,
    secretKeyRaw: env.STRIPE_SECRET_KEY,
    cdpConfigured: false,
    requireCdp: false,
    priceAtomic: PRODUCTS.joke.price_usdc,
    chainId: CHAIN_ID,
  })
  if (!config) {
    console.error('Stripe recording is not configured: set STRIPE_DEPOSIT_ADDRESS and STRIPE_SECRET_KEY.')
    return 1
  }

  const rpcUrl = env.BASE_RPC_URL
  if (!rpcUrl) {
    console.error('BASE_RPC_URL is required: set it to the chain RPC the merchant uses.')
    return 1
  }

  const chain = CHAIN_ID === 84532 ? baseSepolia : base
  const client = createPublicClient({ chain, transport: http(rpcUrl) }) as PublicClient
  const recording = createStripeRecording(config)
  const report = await reconcileStripe({
    chain: createViemReconcileChainReader(client),
    recording,
    depositAddress: config.depositAddress,
    priceAtomic: PRODUCTS.joke.price_usdc,
    productId: 'joke',
    fromBlock: range.fromBlock,
    toBlock: range.toBlock,
  })
  await recording.flush()

  console.log(JSON.stringify(report, null, 2))
  return report.failed.length > 0 ? 2 : 0
}
