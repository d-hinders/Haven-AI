/**
 * #4866: the reconciliation CLI's `main()` — exit codes and what it prints.
 *
 * The chain is a REAL viem client over a stub node, and Stripe is a fake: the
 * key is obviously fake, and the RPC URL carries a fake key in its path, the
 * shape Alchemy and dRPC URLs have, so a leak would show.
 */
import { describe, expect, it } from 'vitest'
import { createPublicClient, custom, pad, toEventSelector, toHex, type Address, type Hex, type PublicClient } from 'viem'
import { base } from 'viem/chains'
import { EXIT_RUN_ERROR, main } from './reconcile-cli.js'
import { PRODUCTS, USDC_ADDRESS } from './products.js'
import type { StripeHttpClient } from './stripe.js'

const DEPOSIT = '0x3333333333333333333333333333333333333333' as Address
const PAYER = '0x5555555555555555555555555555555555555555' as Address
const FAKE_KEY = 'sk_test_fake_key_for_tests_only'
const RPC_SECRET = 'rpcpathsecret0123456789'
const RPC_URL = `https://rpc.example.invalid/v2/${RPC_SECRET}`
const TX = `0x${'a1'.repeat(32)}` as Hex
const BLOCK_HASH = `0x${'11'.repeat(32)}` as Hex

const ENV = {
  STRIPE_SECRET_KEY: FAKE_KEY,
  STRIPE_DEPOSIT_ADDRESS: DEPOSIT,
  BASE_RPC_URL: RPC_URL,
} as NodeJS.ProcessEnv

/** A stub node with one EIP-3009 joke payment to the deposit address, or one that fails every read. */
function node(opts: { fail?: boolean } = {}): PublicClient {
  const transport = custom(
    {
      async request({ method, params }: { method: string; params?: unknown }) {
        if (method === 'eth_chainId') return toHex(base.id)
        if (opts.fail) {
          // The shape a provider error takes: its message names the URL.
          throw new Error(`upstream ${RPC_URL} answered 503`)
        }
        if (method === 'eth_getLogs') {
          return [
            {
              address: USDC_ADDRESS,
              topics: [
                toEventSelector('Transfer(address,address,uint256)'),
                pad(PAYER.toLowerCase() as Hex, { size: 32 }),
                pad(DEPOSIT.toLowerCase() as Hex, { size: 32 }),
              ],
              data: toHex(PRODUCTS.joke.price_usdc, { size: 32 }),
              blockNumber: '0x10',
              blockHash: BLOCK_HASH,
              transactionHash: TX,
              transactionIndex: '0x0',
              logIndex: '0x0',
              removed: false,
            },
          ]
        }
        if (method === 'eth_getTransactionReceipt') {
          return {
            transactionHash: (params as Hex[])[0],
            transactionIndex: '0x0',
            blockHash: BLOCK_HASH,
            blockNumber: '0x10',
            from: PAYER,
            to: USDC_ADDRESS,
            cumulativeGasUsed: '0x0',
            gasUsed: '0x0',
            effectiveGasPrice: '0x0',
            contractAddress: null,
            logsBloom: `0x${'0'.repeat(512)}`,
            type: '0x2',
            status: '0x1',
            logs: [
              {
                address: USDC_ADDRESS,
                topics: [
                  toEventSelector('AuthorizationUsed(address,bytes32)'),
                  pad(PAYER.toLowerCase() as Hex, { size: 32 }),
                  `0x${'ab'.repeat(32)}`,
                ],
                data: '0x',
                blockNumber: '0x10',
                blockHash: BLOCK_HASH,
                transactionHash: TX,
                transactionIndex: '0x0',
                logIndex: '0x0',
                removed: false,
              },
            ],
          }
        }
        throw new Error(`stub node: unexpected ${method}`)
      },
    },
    { retryCount: 0 },
  )
  return createPublicClient({ chain: base, transport }) as PublicClient
}

/** Stripe answers create with `status` and every later read with the same. */
function stripe(status: string): StripeHttpClient {
  const intent = (id: string) =>
    status === 'requires_payment_method'
      ? { id, status, last_payment_error: { code: 'payment_method_provider_decline' } }
      : { id, status }
  return {
    async request(request) {
      if (request.method === 'GET' && request.path.startsWith('/v1/payment_intents/search')) {
        return { status: 200, body: { data: [] } }
      }
      if (request.method === 'GET') return { status: 200, body: intent(request.path.split('/').pop()!) }
      return { status: 200, body: intent('pi_3CliRun00001') }
    },
  }
}

async function run(opts: { fail?: boolean; status?: string; argv?: string[] }) {
  const out: string[] = []
  const err: string[] = []
  const code = await main(opts.argv ?? ['--from-block', '1', '--to-block', '100'], ENV, {
    createClient: () => node({ fail: opts.fail }),
    stripeHttp: stripe(opts.status ?? 'succeeded'),
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    sleep: async () => {},
  })
  return { code, out, err }
}

describe('reconcile-stripe main() (#4866)', () => {
  it('an RPC error ends in one line and exit 3 — no stack trace, no URL, no key', async () => {
    const { code, out, err } = await run({ fail: true })
    expect(code).toBe(EXIT_RUN_ERROR)
    expect(out).toEqual([])
    expect(err).toHaveLength(1)
    expect(err[0]).toMatch(/^Reconciliation stopped: \w+\. Nothing after this point was read or recorded\.$/)
    for (const line of [...out, ...err]) {
      expect(line).not.toContain(RPC_SECRET)
      expect(line).not.toContain('rpc.example')
      expect(line).not.toContain(FAKE_KEY)
    }
  })

  it('a payment Stripe declines exits 2 and is listed under declined', async () => {
    const { code, out } = await run({ status: 'requires_payment_method' })
    expect(code).toBe(2)
    const report = JSON.parse(out.join('\n'))
    expect(report.declined).toEqual([
      { tx_hash: TX, payment_intent: 'pi_3CliRun00001', code: 'payment_method_provider_decline' },
    ])
    expect(report.recorded).toEqual([])
  })

  it('a payment Stripe is still verifying exits 0 and is listed under pending', async () => {
    const { code, out } = await run({ status: 'processing' })
    expect(code).toBe(0)
    expect(JSON.parse(out.join('\n')).pending).toEqual([{ tx_hash: TX, payment_intent: 'pi_3CliRun00001' }])
  })

  it('a succeeded payment exits 0, and stdout carries only the JSON report', async () => {
    const { code, out, err } = await run({ status: 'succeeded' })
    expect(code).toBe(0)
    expect(JSON.parse(out.join('\n')).recorded).toEqual([{ tx_hash: TX, payment_intent: 'pi_3CliRun00001' }])
    // The recorder's log lines go to stderr, so the report stays parseable.
    expect(err.some((line) => line.startsWith('[stripe] recorded'))).toBe(true)
  })

  it('a usage error still exits 1', async () => {
    expect((await run({ argv: ['--from-block', '9'] })).code).toBe(1)
  })
})
