/**
 * The x402 challenge (EIP-3009, `exact`) for one product. The price comes from
 * the product, the network and asset from the deployment's chain and the
 * receiving address from `PAY_TO` — never from the payment that comes back.
 */
import type { Address } from 'viem'
import type { PaymentRequired } from '@x402/core/types'
import { MAX_TIMEOUT_SECONDS, type PaymentAsset } from '@haven_ai/merchant-payments'
import type { Product } from './products.js'

export function buildChallenge(params: {
  chain: PaymentAsset
  payTo: Address
  product: Product
  resourceUrl: string
}): PaymentRequired {
  const { chain, payTo, product, resourceUrl } = params
  return {
    x402Version: 2,
    resource: {
      url: resourceUrl,
      description: product.description,
      mimeType: 'application/json',
    },
    accepts: [
      {
        scheme: 'exact',
        network: chain.network,
        amount: product.price.toString(),
        payTo,
        maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
        asset: chain.usdcAddress,
        // The USDC signing domain, which the buyer's EIP-3009 signature is made over.
        extra: { name: chain.usdcDomainName, version: chain.usdcDomainVersion },
      },
    ],
    error: 'Payment required',
  }
}

/** A refusal body: `error` and `message` first, then the challenge (so a truncated echo still says why). */
export function refusalWithChallenge(
  error: string,
  message: string,
  challenge: PaymentRequired,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const { error: _default, ...rest } = challenge
  return { error, message, ...extra, ...rest }
}
