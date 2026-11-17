/**
 * The proxy's settings, read ONCE from the environment into a typed config
 * (docs/architecture/12-merchant-kit.md §12). Everything the proxy needs to
 * take a payment is required: it refuses to start, naming every missing or
 * invalid setting, rather than come up half-configured. The error names the
 * variables and never a secret's value.
 */
import { isAddress, getAddress, type Address } from 'viem'
import { chainForNetwork, PROXY_CHAINS, type ProxyChain } from './chains.js'

export class ConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`The proxy cannot start:\n${problems.map((p) => `  - ${p}`).join('\n')}`)
    this.name = 'ConfigError'
  }
}

export interface ProxyConfig {
  port: number
  host: string
  chain: ProxyChain
  payTo: Address
  operatorName: string
  productsFile: string
  upstream: {
    baseUrl: URL
    apiKey: string
    authHeader: string
    /** Empty string: the key is sent bare, with no scheme. */
    authScheme: string
  }
  /** The path prefix the products' routes are matched under ('' or '/x', no trailing slash). */
  basePath: string
  /** Absolute public origin used in the challenge's resource URL; absent: derived from the request's Host. */
  publicBaseUrl?: string
  cdp: { apiKeyId: string; apiKeySecret: string }
  rpcUrl: string
  paymentsDb: string
  upstreamTimeoutMs: number
  reservationDeadlineMs: number
}

export const DEFAULT_UPSTREAM_TIMEOUT_MS = 180_000
export const DEFAULT_RESERVATION_DEADLINE_MS = 120_000
/** §6: the reserving request's worst case from `reservedAt` (read 10 + verify 30 + slot 10 + settle 30 + resolve 30). */
export const HOLDER_WORST_CASE_MS = 110_000

type Env = Readonly<Record<string, string | undefined>>

/** Variables whose values must never be echoed, in an error or anywhere else. */
export const SECRET_VARIABLES = ['UPSTREAM_API_KEY', 'CDP_API_KEY_SECRET'] as const

export function secretValues(config: Pick<ProxyConfig, 'upstream' | 'cdp'>): string[] {
  return [config.upstream.apiKey, config.cdp.apiKeySecret].filter((value) => value.length >= 8)
}

export function loadConfig(env: Env): ProxyConfig {
  const problems: string[] = []
  const text = (name: string): string | undefined => {
    const value = env[name]?.trim()
    return value ? value : undefined
  }
  const required = (name: string): string => {
    const value = text(name)
    if (value === undefined) problems.push(`${name} is required`)
    return value ?? ''
  }
  const positiveInt = (name: string, fallback: number): number => {
    const raw = text(name)
    if (raw === undefined) return fallback
    if (!/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
      problems.push(`${name} must be a positive whole number of milliseconds`)
      return fallback
    }
    return Number(raw)
  }

  const networkRaw = required('NETWORK')
  let chain: ProxyChain | undefined
  if (networkRaw) {
    chain = chainForNetwork(networkRaw)
    if (!chain) {
      problems.push(`NETWORK must be one of ${Object.keys(PROXY_CHAINS).join(', ')} (there is no default network)`)
    }
  }

  const payToRaw = required('PAY_TO')
  let payTo = '' as Address
  if (payToRaw) {
    if (isAddress(payToRaw, { strict: false })) payTo = getAddress(payToRaw.toLowerCase())
    else problems.push('PAY_TO must be an EVM address (0x followed by 40 hex characters)')
  }

  const operatorName = required('OPERATOR_NAME')
  if (operatorName && /[\u0000-\u001f\u007f]/.test(operatorName)) {
    problems.push('OPERATOR_NAME must be a single line of text')
  }

  const productsFile = required('PRODUCTS_FILE')
  const paymentsDb = required('PAYMENTS_DB')
  const apiKey = required('UPSTREAM_API_KEY')
  const apiKeySecret = required('CDP_API_KEY_SECRET')
  const apiKeyId = required('CDP_API_KEY_ID')
  const rpcUrl = required('RPC_URL')

  let baseUrl = new URL('http://invalid.invalid')
  const baseUrlRaw = required('UPSTREAM_BASE_URL')
  if (baseUrlRaw) {
    try {
      baseUrl = new URL(baseUrlRaw)
      if (baseUrl.protocol !== 'https:' && baseUrl.protocol !== 'http:') throw new Error('scheme')
      if (baseUrl.username || baseUrl.password) {
        problems.push('UPSTREAM_BASE_URL must not carry credentials; use UPSTREAM_API_KEY')
      }
    } catch {
      problems.push('UPSTREAM_BASE_URL must be an http(s) URL')
    }
  }

  const authHeader = text('UPSTREAM_AUTH_HEADER') ?? 'Authorization'
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(authHeader)) {
    problems.push('UPSTREAM_AUTH_HEADER must be a valid HTTP header name')
  }
  // Unset: Bearer. Set but empty: the key is sent bare (an upstream that wants `x-api-key: <key>`).
  const authScheme = env.UPSTREAM_AUTH_SCHEME === undefined ? 'Bearer' : env.UPSTREAM_AUTH_SCHEME.trim()
  if (/[\r\n]/.test(authScheme)) problems.push('UPSTREAM_AUTH_SCHEME must be a single line')
  if (apiKey && /[\r\n]/.test(apiKey)) problems.push('UPSTREAM_API_KEY must not contain a line break')

  let basePath = text('BASE_PATH') ?? ''
  if (basePath) {
    if (!basePath.startsWith('/')) problems.push('BASE_PATH must start with "/"')
    basePath = basePath.replace(/\/+$/, '')
  }

  let publicBaseUrl: string | undefined
  const publicRaw = text('PUBLIC_BASE_URL')
  if (publicRaw) {
    try {
      const url = new URL(publicRaw)
      if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('scheme')
      publicBaseUrl = url.origin
    } catch {
      problems.push('PUBLIC_BASE_URL must be an http(s) URL')
    }
  }

  if (text('DIRECTORY_LISTING')?.toLowerCase() === 'on') {
    problems.push('DIRECTORY_LISTING=on is not built in this release (the pilot runs with listing off)')
  }

  const port = text('PORT') === undefined ? 8080 : Number(text('PORT'))
  if (!Number.isInteger(port) || port < 0 || port > 65535) problems.push('PORT must be a port number')

  const upstreamTimeoutMs = positiveInt('UPSTREAM_TIMEOUT_MS', DEFAULT_UPSTREAM_TIMEOUT_MS)
  const reservationDeadlineMs = positiveInt('RESERVATION_DEADLINE_MS', DEFAULT_RESERVATION_DEADLINE_MS)
  // Review of #4893: two guarantees in §6 rest on these values. The 110 s
  // budget before the call plus the call must stay inside Haven's 300 s wait,
  // and a holder that finishes its 110 s worst case must still hold its token.
  if (upstreamTimeoutMs > DEFAULT_UPSTREAM_TIMEOUT_MS) {
    problems.push(`UPSTREAM_TIMEOUT_MS may not exceed ${DEFAULT_UPSTREAM_TIMEOUT_MS} (the design's 300 s budget)`)
  }
  if (reservationDeadlineMs < HOLDER_WORST_CASE_MS) {
    problems.push(`RESERVATION_DEADLINE_MS may not be below ${HOLDER_WORST_CASE_MS} (the holder's worst case)`)
  }

  if (problems.length > 0 || !chain) throw new ConfigError(problems)

  return {
    port,
    host: text('HOST') ?? '0.0.0.0',
    chain,
    payTo,
    operatorName,
    productsFile,
    upstream: { baseUrl, apiKey, authHeader, authScheme },
    basePath,
    ...(publicBaseUrl ? { publicBaseUrl } : {}),
    cdp: { apiKeyId, apiKeySecret },
    rpcUrl,
    paymentsDb,
    upstreamTimeoutMs,
    reservationDeadlineMs,
  }
}
