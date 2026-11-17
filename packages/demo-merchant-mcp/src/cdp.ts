/**
 * #4851: settlement through Coinbase's hosted x402 facilitator (CDP).
 *
 * #4890: the facilitator client, the chain reader and the bounded wait moved
 * to `@haven_ai/merchant-payments`. This module re-exports them and binds the
 * three that need this merchant's chain and USDC contract to
 * `CHAIN_ID` / `USDC_ADDRESS`, so callers (and the tests) keep their
 * signatures.
 */
import {
  createCdpChainReader as createCoreCdpChainReader,
  createViemChainReadClient as createCoreViemChainReadClient,
  resolveCdpCredentials as resolveCoreCdpCredentials,
  type CdpChainReader,
  type ChainReadClient,
  type LogWindows,
} from '@haven_ai/merchant-payments'
import { CHAIN_ID, USDC_ADDRESS } from './products.js'

export {
  CDP_CALL_TIMEOUT_MS,
  CDP_MAX_AUTHORIZATION_WINDOW_SECONDS,
  CHAIN_READ_TIMEOUT_MS,
  CdpTimeoutError,
  SETTLE_RESOLVE_MS,
  createCdpFacilitator,
  withCdpTimeout,
  type AuthorizationOutcome,
  type CdpChainReader,
  type CdpFacilitator,
  type CdpSettlementConfig,
  type ChainReadClient,
} from '@haven_ai/merchant-payments'

/** The viem public client the reader uses, for this merchant's chain. */
export function createViemChainReadClient(rpcUrl: string): ChainReadClient {
  return createCoreViemChainReadClient(rpcUrl, CHAIN_ID)
}

export function createCdpChainReader(client: ChainReadClient, logWindows?: LogWindows): CdpChainReader {
  return createCoreCdpChainReader(client, { usdcAddress: USDC_ADDRESS, logWindows })
}

/** #4851: the CDP credentials from the environment's two values — see the core. */
export function resolveCdpCredentials(
  apiKeyIdRaw: string | undefined,
  apiKeySecretRaw: string | undefined,
  warn: (message: string) => void = console.warn,
): { apiKeyId: string; apiKeySecret: string } | undefined {
  return resolveCoreCdpCredentials(
    apiKeyIdRaw,
    apiKeySecretRaw,
    warn,
    'The CDP-settled joke product is not offered until both are set; every other product is unaffected.',
  )
}
