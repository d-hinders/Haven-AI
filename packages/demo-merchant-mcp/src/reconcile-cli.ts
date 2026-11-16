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
 *
 * #4866: an RPC or Stripe error that stops the run ends in ONE line naming the
 * error class (and Stripe's own type/code), exit 3 — never a stack trace. A
 * viem error message carries the RPC URL (an API key can sit in its path or
 * query) and the request body, so no error message is ever printed.
 */
import { createPublicClient, http, type PublicClient } from 'viem'
import { base, baseSepolia } from 'viem/chains'
import { LogWindows, parseMaxBlockRange } from './log-range.js'
import { CHAIN_ID, PRODUCTS } from './products.js'
import { StripeApiError, createStripeRecording, resolveStripeConfig, type StripeHttpClient } from './stripe.js'
import { createViemReconcileChainReader, reconcileStripe } from './stripe-reconcile.js'

export const USAGE = `Usage: reconcile-stripe --from-block <n> --to-block <n>

Lists the settled joke payments to the Stripe deposit address that have no
PaymentIntent, and records them. Only EIP-3009 transfers of the product's exact
price are recorded; any other transfer to the address is listed as "not
recorded" and left alone. Each PaymentIntent is reported with Stripe's verdict:
recorded / already_recorded (succeeded), pending (Stripe still verifying; run
again later) or declined (permanent for that transaction).

Environment (the merchant service's own variables):
  STRIPE_SECRET_KEY            restricted key: create PaymentIntents, read PaymentIntents
  STRIPE_DEPOSIT_ADDRESS       the deposit address the joke is paid to
  BASE_RPC_URL                 the chain's RPC
  MERCHANT_CHAIN_ID            8453 (default) or 84532 for Base Sepolia
  ETH_GETLOGS_MAX_BLOCK_RANGE  optional: the widest eth_getLogs range the RPC
                               serves (otherwise learned from its refusal)

Exit codes: 0 nothing declined or failed (pending is listed, not an error),
1 usage or configuration, 2 Stripe refused or declined a payment, 3 an RPC or
Stripe error stopped the run.`

/** #4866: exit code for an RPC or Stripe error that stopped the run. */
export const EXIT_RUN_ERROR = 3

/** Test seams. Production passes none. */
export interface MainDeps {
  createClient?: (rpcUrl: string) => PublicClient
  stripeHttp?: StripeHttpClient
  out?: (line: string) => void
  err?: (line: string) => void
  /** The wait between Stripe status reads; tests pass a no-op. */
  sleep?: (ms: number) => Promise<void>
}

/** The error's class, and Stripe's own type/code. Never a message. */
export function describeRunError(error: unknown): string {
  if (error instanceof StripeApiError) return `${error.name} (${error.type}${error.code ? `/${error.code}` : ''})`
  if (error instanceof Error) return error.name
  return 'UnknownError'
}

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

export async function main(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  deps: MainDeps = {},
): Promise<number> {
  const out = deps.out ?? ((line: string) => console.log(line))
  const err = deps.err ?? ((line: string) => console.error(line))
  const range = parseBlockRange(argv)
  if (!range) {
    err(USAGE)
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
    err('Stripe recording is not configured: set STRIPE_DEPOSIT_ADDRESS and STRIPE_SECRET_KEY.')
    return 1
  }

  const rpcUrl = env.BASE_RPC_URL
  if (!rpcUrl) {
    err('BASE_RPC_URL is required: set it to the chain RPC the merchant uses.')
    return 1
  }

  const client = deps.createClient
    ? deps.createClient(rpcUrl)
    : (createPublicClient({ chain: CHAIN_ID === 84532 ? baseSepolia : base, transport: http(rpcUrl) }) as PublicClient)
  const logWindows = new LogWindows({ maxSpan: parseMaxBlockRange(env.ETH_GETLOGS_MAX_BLOCK_RANGE, err) })
  const recording = createStripeRecording(config, {
    ...(deps.stripeHttp ? { http: deps.stripeHttp } : {}),
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
    log: err,
  })
  let report
  try {
    report = await reconcileStripe({
      chain: createViemReconcileChainReader(client, logWindows),
      recording,
      depositAddress: config.depositAddress,
      priceAtomic: PRODUCTS.joke.price_usdc,
      productId: 'joke',
      fromBlock: range.fromBlock,
      toBlock: range.toBlock,
    })
    await recording.flush()
  } catch (error) {
    // #4866: one line, the class only — never the message, which can carry
    // the RPC URL and the request.
    err(`Reconciliation stopped: ${describeRunError(error)}. Nothing after this point was read or recorded.`)
    return EXIT_RUN_ERROR
  }

  out(JSON.stringify(report, null, 2))
  return report.failed.length > 0 || report.declined.length > 0 ? 2 : 0
}
