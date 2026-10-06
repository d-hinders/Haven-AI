import { generateJwt } from '@coinbase/cdp-sdk/auth'

const CDP_FAUCET_URL = 'https://api.cdp.coinbase.com/platform/v2/evm/faucet'
const CDP_FAUCET_HOST = 'api.cdp.coinbase.com'
const CDP_FAUCET_PATH = '/platform/v2/evm/faucet'
const BASE_SEPOLIA_CHAIN_ID = 84532
const DEFAULT_TIMEOUT_MS = 10_000

export type CdpFaucetErrorCategory =
  | 'unsupported_network'
  | 'authentication_failure'
  | 'rate_limited'
  | 'http_error'
  | 'timeout'
  | 'network_error'
  | 'invalid_response'

/**
 * A deliberately scrub-safe faucet failure. Raw response bodies, URLs and
 * underlying errors are not retained because they can echo request details or
 * credentials into QA reports.
 */
export class CdpFaucetError extends Error {
  readonly category: CdpFaucetErrorCategory
  readonly status?: number
  readonly reason: string

  constructor(category: CdpFaucetErrorCategory, reason: string, status?: number) {
    super(reason)
    this.name = 'CdpFaucetError'
    this.category = category
    this.reason = reason
    this.status = status
  }
}

export interface CdpEvmFaucetOptions {
  address: string
  /** Explicit chain ID; only Base Sepolia (84532) is permitted. */
  chainId: number
  apiKeyId: string
  apiKeySecret: string
  idempotencyKey?: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

export interface CdpEvmFaucetResult {
  transactionHash: string
}

interface CdpFaucetResponse {
  transactionHash?: unknown
}

/**
 * Request test ETH for a Base Sepolia QA address from Coinbase's CDP faucet.
 *
 * This helper intentionally accepts only an API key ID and secret. It neither
 * accepts nor uses a CDP wallet secret, and it performs exactly one bounded
 * request with no retry.
 */
export async function requestCdpEvmFaucet(
  options: CdpEvmFaucetOptions,
): Promise<CdpEvmFaucetResult> {
  if (options.chainId !== BASE_SEPOLIA_CHAIN_ID) {
    throw new CdpFaucetError(
      'unsupported_network',
      'CDP faucet requests are permitted only on Base Sepolia (chain 84532)',
    )
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new CdpFaucetError('timeout', 'CDP faucet timeout must be a positive finite number')
  }

  let jwt: string
  try {
    jwt = await generateJwt({
      apiKeyId: options.apiKeyId,
      apiKeySecret: options.apiKeySecret,
      requestMethod: 'POST',
      requestHost: CDP_FAUCET_HOST,
      requestPath: CDP_FAUCET_PATH,
    })
  } catch {
    throw new CdpFaucetError(
      'authentication_failure',
      'CDP faucet authentication could not be prepared',
    )
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  const headers: Record<string, string> = {
    Authorization: `Bearer ${jwt}`,
    'Content-Type': 'application/json',
  }
  if (options.idempotencyKey !== undefined) {
    headers['X-Idempotency-Key'] = options.idempotencyKey
  }

  let response: Response
  try {
    response = await (options.fetchImpl ?? fetch)(CDP_FAUCET_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        address: options.address,
        network: 'base-sepolia',
        token: 'eth',
      }),
      signal: controller.signal,
    })
  } catch {
    if (controller.signal.aborted) {
      throw new CdpFaucetError('timeout', 'CDP faucet request timed out')
    }
    throw new CdpFaucetError('network_error', 'CDP faucet request could not be completed')
  } finally {
    clearTimeout(timeout)
  }

  if (!response.ok) {
    if (response.status === 429) {
      throw new CdpFaucetError('rate_limited', 'CDP faucet rate limit was reached', 429)
    }
    throw new CdpFaucetError('http_error', 'CDP faucet returned an unsuccessful response', response.status)
  }

  let body: CdpFaucetResponse
  try {
    body = (await response.json()) as CdpFaucetResponse
  } catch {
    throw new CdpFaucetError('invalid_response', 'CDP faucet response was not valid JSON')
  }

  if (typeof body.transactionHash !== 'string' || body.transactionHash.length === 0) {
    throw new CdpFaucetError(
      'invalid_response',
      'CDP faucet response did not include a transaction hash',
    )
  }

  return { transactionHash: body.transactionHash }
}
