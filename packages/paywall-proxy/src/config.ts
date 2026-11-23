/**
 * The proxy's settings, read ONCE from the environment into a typed config
 * (docs/architecture/12-merchant-kit.md §12). Everything the proxy needs to
 * take a payment is required: it refuses to start, naming every missing or
 * invalid setting, rather than come up half-configured. Four settings have a
 * default that is safe on Base Sepolia — `RPC_URL`, `ENDPOINT_NAME`,
 * `ENDPOINT_DESCRIPTION` and `SALES_OUTBOX` (#5006) — and the rest stay
 * required. The error names the variables and never a secret's value.
 */
import { dirname, join } from 'node:path'
import { isAddress, getAddress, type Address } from 'viem'
import { VAT_RULES, type VatRule } from '@haven_ai/merchant-payments'
import { chainForNetwork, type ProxyChain } from './chains.js'
import type { ReceiptSettings } from './receipt.js'
import { SALES_KEY_PREFIX, type SalesSettings, type SalesStatus } from './sales.js'

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
  /**
   * The endpoint's human name and description, for the discovery document (§4).
   * `endpointName` defaults to `operatorName`; `endpointDescription` is absent
   * when `ENDPOINT_DESCRIPTION` is unset, and `buildDiscoveryDocument` builds
   * the sentence from the products file and the network (#5006).
   */
  endpointName: string
  endpointDescription?: string
  /** A URL or address a reader can use to reach the operator (§4). */
  operatorContact?: string
  /** A public image URL, for a directory listing (§4). */
  iconUrl?: string
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
  /**
   * The request header the merchant's own front proxy sets to the client's
   * address (lower-case), for the per-IP limits (§7). Absent: the socket's
   * peer address, which behind a reverse proxy is the reverse proxy's own.
   */
  clientIpHeader?: string
  cdp: { apiKeyId: string; apiKeySecret: string }
  /** §12: the chain reads that resolve a lost settle answer and a used authorization. */
  rpcUrl: string
  /** True when `rpcUrl` is the kit's public default rather than a configured value. */
  rpcUrlDefault: boolean
  paymentsDb: string
  upstreamTimeoutMs: number
  reservationDeadlineMs: number
  /**
   * §11: the receipt settings, present only when a VAT rule is configured AND
   * the seller details it needs are present. Absent: the proxy sends no
   * `x-receipt-json` header.
   */
  receipt?: ReceiptSettings
  /** What the startup log says about receipts (§11). */
  receiptStatus: ReceiptStatus
  /**
   * §5, §12: the sales reporter's settings, present only when reporting is on.
   * Absent: no sale is reported and the proxy works exactly as without it.
   */
  sales?: SalesSettings
  /** What the startup log says about sales reporting (§5). */
  salesStatus: SalesStatus
  /**
   * Settings that do not refuse startup but change what the proxy does. A
   * test network with a VAT rule and no seller details starts and sends no
   * receipt; the warning says so.
   */
  warnings: readonly string[]
}

/** §11: `on`, or why the proxy sends no receipt. */
export type ReceiptStatus = 'on' | 'off (no VAT_RULE)' | 'off (seller details missing)'

export const DEFAULT_UPSTREAM_TIMEOUT_MS = 180_000
export const DEFAULT_RESERVATION_DEADLINE_MS = 120_000
/** §6: the reserving request's worst case from `reservedAt` (read 10 + verify 30 + slot 10 + settle 30 + resolve 30). */
export const HOLDER_WORST_CASE_MS = 110_000

/**
 * §3: the networks this release is open on (#5061). Base mainnet stays in
 * `PROXY_CHAINS` — `chains.test.ts` pins its chain id and USDC address to
 * core's registry — but the kit refuses to settle on it until the regulatory
 * review in #4888 allows it (owner decision 2026-11-23). Adding
 * `eip155:8453` to this list is the go-live step; nothing else changes.
 */
export const OPEN_NETWORKS: readonly string[] = ['eip155:84532']

/**
 * The refusal for a network the chain table knows but this release is not open
 * on, or `undefined` when the network is open — or unknown, which the
 * "must be one of" problem reports instead (#5061).
 */
export function closedNetworkProblem(network: string): string | undefined {
  if (OPEN_NETWORKS.includes(network)) return undefined
  const chain = chainForNetwork(network)
  if (chain === undefined) return undefined
  return `NETWORK ${network} (${chain.label}) is not open: the merchant kit runs on Base Sepolia only until the regulatory review in #4888 allows mainnet`
}

/**
 * §12: the public node the proxy uses when `RPC_URL` is unset, per network
 * (#5006). Only a test network has one: on Base mainnet real money would rest
 * on a rate-limited public node, so `RPC_URL` stays required there. Base
 * mainnet is refused at startup in this release (#5061), and the rule stays
 * for go-live. The public Base Sepolia node serves a 200-block `eth_getLogs`
 * window, and the core already narrows its search to fit
 * (`merchant-payments/src/cdp.ts`, `LOG_CHUNK_BLOCKS`, #4866).
 */
export const DEFAULT_RPC_URLS: Readonly<Record<string, string>> = {
  'eip155:84532': 'https://sepolia.base.org',
}

/** §5: the outbox file's name when `SALES_OUTBOX` is unset; it sits beside `PAYMENTS_DB`. */
export const DEFAULT_SALES_OUTBOX_NAME = 'sales-outbox.jsonl'

type Env = Readonly<Record<string, string | undefined>>

/** Variables whose values must never be echoed, in an error or anywhere else. */
export const SECRET_VARIABLES = ['UPSTREAM_API_KEY', 'CDP_API_KEY_SECRET', 'HAVEN_MERCHANT_KEY'] as const

export function secretValues(config: Pick<ProxyConfig, 'upstream' | 'cdp'> & { sales?: SalesSettings }): string[] {
  return [config.upstream.apiKey, config.cdp.apiKeySecret, config.sales?.merchantKey ?? ''].filter(
    (value) => value.length >= 8,
  )
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
      problems.push(`NETWORK must be one of ${OPEN_NETWORKS.join(', ')} (there is no default network)`)
    } else {
      // §3: the chain facts stay resolved for a refused network, so the
      // mainnet-only rules below still report alongside the refusal (#5061).
      const refusal = closedNetworkProblem(networkRaw)
      if (refusal !== undefined) problems.push(refusal)
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

  // §4: the discovery document's `name` and `description` identify the endpoint
  // to agents and directories. `ENDPOINT_NAME` defaults to the operator's name:
  // the endpoint is the operator's, and the x402 challenge does not use it
  // (`resource.description` is the product's own description, `challenge.ts`).
  const endpointName = text('ENDPOINT_NAME') ?? operatorName
  if (endpointName && /[\u0000-\u001f\u007f]/.test(endpointName)) {
    problems.push('ENDPOINT_NAME must be a single line of text')
  }
  // §4: `ENDPOINT_DESCRIPTION` is optional. `loadConfig` never reads the
  // products file (it holds only the path), so `buildDiscoveryDocument` builds
  // the sentence from the products and the network (#5006).
  const endpointDescription = text('ENDPOINT_DESCRIPTION')
  if (endpointDescription !== undefined && /[\u0000-\u001f\u007f]/.test(endpointDescription)) {
    problems.push('ENDPOINT_DESCRIPTION must be a single line of text')
  }

  const operatorContact = text('OPERATOR_CONTACT')
  if (operatorContact !== undefined && /[\u0000-\u001f\u007f]/.test(operatorContact)) {
    problems.push('OPERATOR_CONTACT must be a single line of text')
  }

  let iconUrl: string | undefined
  const iconUrlRaw = text('ICON_URL')
  if (iconUrlRaw !== undefined) {
    try {
      const url = new URL(iconUrlRaw)
      if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('scheme')
      iconUrl = url.toString()
    } catch {
      problems.push('ICON_URL must be an http(s) URL')
    }
  }

  const productsFile = required('PRODUCTS_FILE')
  const paymentsDb = required('PAYMENTS_DB')
  const apiKey = required('UPSTREAM_API_KEY')
  const apiKeySecret = required('CDP_API_KEY_SECRET')
  const apiKeyId = required('CDP_API_KEY_ID')
  // §12: `RPC_URL` is used only for the chain reads that resolve a lost settle
  // answer and a used authorization. On Base Sepolia the public node is a safe
  // default; on Base mainnet it stays required, because real money would rest
  // on a rate-limited public node. Base mainnet is refused at startup in this
  // release (#5061), and the rule stays for go-live. With no usable NETWORK
  // there is no chain to default for, and the NETWORK problem is the one to
  // report (#5006).
  const rpcUrlRaw = text('RPC_URL')
  const defaultRpcUrl = chain === undefined ? undefined : DEFAULT_RPC_URLS[chain.network]
  let rpcUrl = ''
  let rpcUrlDefault = false
  if (rpcUrlRaw !== undefined) {
    rpcUrl = rpcUrlRaw
  } else if (defaultRpcUrl !== undefined) {
    rpcUrl = defaultRpcUrl
    rpcUrlDefault = true
  } else if (chain !== undefined) {
    problems.push('RPC_URL is required')
  }

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

  const clientIpHeader = text('CLIENT_IP_HEADER')?.toLowerCase()
  if (clientIpHeader !== undefined && !/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(clientIpHeader)) {
    problems.push('CLIENT_IP_HEADER must be a valid HTTP header name')
  }

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

  // §11: the receipt. The merchant decides its own tax treatment; the proxy
  // applies the rule it is given. With no rule there is no receipt and no
  // seller detail is required. With a rule, the seller's name, organisation
  // number and VAT number are required: on Base mainnet the proxy refuses to
  // start without them, on a test network it starts with a warning and sends
  // no receipt. Base mainnet is refused at startup in this release (#5061),
  // and the rule stays for go-live.
  const warnings: string[] = []
  const vatRuleRaw = text('VAT_RULE')
  let receipt: ReceiptSettings | undefined
  let receiptStatus: ReceiptStatus = 'off (no VAT_RULE)'
  if (vatRuleRaw !== undefined) {
    if (!(VAT_RULES as readonly string[]).includes(vatRuleRaw)) {
      problems.push(`VAT_RULE must be one of ${VAT_RULES.join(', ')}`)
    } else {
      const sellerName = text('SELLER_NAME')
      const sellerOrgNr = text('SELLER_ORG_NR')
      const sellerVatNr = text('SELLER_VAT_NR')
      const sellerAddress = text('SELLER_ADDRESS')
      const sellerIban = text('SELLER_IBAN')
      const sellerBic = text('SELLER_BIC')
      const supportContact = text('SELLER_SUPPORT_CONTACT')
      for (const [name, value] of [
        ['SELLER_NAME', sellerName],
        ['SELLER_ADDRESS', sellerAddress],
        ['SELLER_ORG_NR', sellerOrgNr],
        ['SELLER_VAT_NR', sellerVatNr],
        ['SELLER_IBAN', sellerIban],
        ['SELLER_BIC', sellerBic],
        ['SELLER_SUPPORT_CONTACT', supportContact],
      ] as const) {
        if (value !== undefined && /[\u0000-\u001f\u007f]/.test(value)) {
          problems.push(`${name} must be a single line of text`)
        }
      }
      const missing = [
        ...(sellerName === undefined ? ['SELLER_NAME'] : []),
        ...(sellerOrgNr === undefined ? ['SELLER_ORG_NR'] : []),
        ...(sellerVatNr === undefined ? ['SELLER_VAT_NR'] : []),
      ]
      if (missing.length > 0) {
        const list = missing.join(', ')
        if (chain && !chain.testnet) {
          problems.push(`with VAT_RULE set, ${list} ${missing.length === 1 ? 'is' : 'are'} required on Base mainnet`)
        } else {
          receiptStatus = 'off (seller details missing)'
          warnings.push(
            `VAT_RULE is set but ${list} ${missing.length === 1 ? 'is' : 'are'} missing: the proxy starts and sends no receipt`,
          )
        }
      } else {
        receipt = {
          vatRule: vatRuleRaw as VatRule,
          seller: {
            name: sellerName!,
            address: sellerAddress ?? '',
            org_nr: sellerOrgNr!,
            moms_nr: sellerVatNr!,
            ...(sellerIban !== undefined ? { iban: sellerIban } : {}),
            ...(sellerBic !== undefined ? { bic: sellerBic } : {}),
          },
          supportContact: supportContact ?? '',
        }
        receiptStatus = 'on'
      }
    }
  }

  // §5, §12: sales reporting. The merchant key is the switch: unset, nothing is
  // reported and the proxy starts exactly as without it. Set, reporting is on
  // and every part of it must be valid — a key that is not a Sales key or a
  // missing or unusable Haven origin refuses startup and names the variable,
  // rather than leaving the merchant silently unreported. The outbox defaults
  // to `sales-outbox.jsonl` beside `PAYMENTS_DB`, the disk the README already
  // says it belongs on (#5006).
  let sales: SalesSettings | undefined
  let salesStatus: SalesStatus = 'off (no HAVEN_MERCHANT_KEY)'
  const merchantKey = text('HAVEN_MERCHANT_KEY')
  if (merchantKey !== undefined) {
    let salesOk = true
    if (!merchantKey.startsWith(SALES_KEY_PREFIX)) {
      problems.push(`HAVEN_MERCHANT_KEY must be a Sales key (it starts with ${SALES_KEY_PREFIX})`)
      salesOk = false
    }
    const salesUrlRaw = text('HAVEN_SALES_URL')
    let havenBaseUrl: string | undefined
    if (salesUrlRaw === undefined) {
      problems.push('HAVEN_SALES_URL is required when HAVEN_MERCHANT_KEY is set')
      salesOk = false
    } else {
      try {
        const url = new URL(salesUrlRaw)
        if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('scheme')
        if (url.pathname !== '/' || url.search !== '' || url.hash !== '') throw new Error('path')
        havenBaseUrl = url.origin
      } catch {
        problems.push("HAVEN_SALES_URL must be Haven's API origin, an http(s) URL with no path (for example https://api.haven.example)")
        salesOk = false
      }
    }
    const outboxPath = text('SALES_OUTBOX') ?? join(dirname(paymentsDb), DEFAULT_SALES_OUTBOX_NAME)
    if (salesOk && havenBaseUrl !== undefined) {
      sales = { havenBaseUrl, merchantKey, outboxPath }
      salesStatus = 'on'
    }
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
    endpointName,
    ...(endpointDescription !== undefined ? { endpointDescription } : {}),
    ...(operatorContact !== undefined ? { operatorContact } : {}),
    ...(iconUrl !== undefined ? { iconUrl } : {}),
    productsFile,
    upstream: { baseUrl, apiKey, authHeader, authScheme },
    basePath,
    ...(publicBaseUrl ? { publicBaseUrl } : {}),
    ...(clientIpHeader ? { clientIpHeader } : {}),
    cdp: { apiKeyId, apiKeySecret },
    rpcUrl,
    rpcUrlDefault,
    paymentsDb,
    upstreamTimeoutMs,
    reservationDeadlineMs,
    ...(receipt !== undefined ? { receipt } : {}),
    receiptStatus,
    ...(sales !== undefined ? { sales } : {}),
    salesStatus,
    warnings,
  }
}
