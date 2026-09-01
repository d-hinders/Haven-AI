/**
 * Environment configuration with validation.
 * Import this module early — it throws on missing required vars.
 * Dotenv is loaded here so env vars are available before validation.
 */
import dotenv from 'dotenv'
import path from 'path'

const envPaths = [
  path.resolve(process.cwd(), '.env'),
  path.resolve(import.meta.dirname ?? '.', '../../..', '.env'),
]
for (const p of envPaths) {
  const result = dotenv.config({ path: p })
  if (!result.error) break
}

function requireEnv(key: string): string {
  const value = process.env[key]
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${key}. ` +
      `Check your .env file or environment configuration.`,
    )
  }
  return value
}

function optionalEnv(key: string, fallback: string): string {
  return process.env[key] || fallback
}

/**
 * Parse TRUST_PROXY_HOPS defensively (#1670). The failure mode this guards is
 * SILENT disarming: the auth rate-limit tier deliberately returns no limit at
 * 0 hops, so a value that fails to parse — pasted with quotes, a stray word,
 * "true" — would leave the front door unthrottled while the operator believes
 * it is protected, and nothing would say so. Quotes and whitespace are
 * stripped (dashboard paste artefacts); anything else non-numeric warns
 * LOUDLY at boot and disarms, because guessing a hop count is worse than
 * refusing one — `true` in particular is the spoofable Fastify mode this
 * setting exists to avoid, and must never be coerced into a count.
 */
export function parseTrustProxyHops(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return 0
  const cleaned = raw.trim().replace(/^["']+|["']+$/g, '').trim()
  const hops = Number(cleaned)
  if (!Number.isFinite(hops) || !Number.isInteger(hops) || hops < 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `TRUST_PROXY_HOPS is set to ${JSON.stringify(raw)}, which is not a non-negative integer — ` +
      'treating it as 0: the proxy stays UNTRUSTED and the per-IP auth rate limits stay DISARMED. ' +
      'Set a plain hop count (e.g. 1), never "true".',
    )
    return 0
  }
  return hops
}

// Validate on import — fail fast at startup
export const config = {
  // Required
  databaseUrl: requireEnv('DATABASE_URL'),
  jwtSecret: requireEnv('JWT_SECRET'),

  // Optional with defaults
  port: Number(process.env.PORT) || 3001,
  frontendUrl: optionalEnv('FRONTEND_URL', 'http://localhost:3000'),
  rpcUrl: optionalEnv('RPC_URL', 'https://rpc.gnosischain.com'),
  logLevel: optionalEnv('LOG_LEVEL', 'info'),

  // #1670: how many proxy hops in front of this process are TRUSTED to have
  // appended the real client address to X-Forwarded-For. 0 (the default)
  // means "trust nothing": request.ip is the socket peer, which behind a
  // deployment proxy is the proxy itself — every external caller collapses
  // into one address. Railway terminates in exactly one edge proxy, so the
  // operator sets TRUST_PROXY_HOPS=1 there. A HOP COUNT rather than `true`
  // on purpose: Fastify's `trustProxy: true` takes the LEFTMOST
  // X-Forwarded-For entry, which is whatever the client typed — with a
  // count, proxy-addr walks from the right through exactly that many trusted
  // hops, so a client-supplied header cannot spoof its own bucket.
  // Per-IP rate limiting (routes/auth.ts) keys on request.ip ONLY when this
  // is > 0; ungated it would be one shared bucket and a cheap global
  // signup/login denial-of-service. Flipping this in an environment is an
  // OPERATOR action, never an agent's.
  trustProxyHops: parseTrustProxyHops(process.env.TRUST_PROXY_HOPS),

  // Chain-specific RPC URLs
  rpcUrlBase: optionalEnv('RPC_URL_BASE', 'https://mainnet.base.org'),
  rpcUrlBaseSepolia: optionalEnv('RPC_URL_BASE_SEPOLIA', 'https://sepolia.base.org'),

  // Optional (features degrade gracefully without these)
  gnosisscanApiKey: process.env.GNOSISSCAN_API_KEY ?? '',
  basescanApiKey: process.env.BASESCAN_API_KEY ?? '',
  coingeckoApiKey: process.env.COINGECKO_API_KEY ?? '',
  relayerPrivateKey: process.env.RELAYER_PRIVATE_KEY ?? '',

  // Sweep recovery floor in USDC (#700, recalibrated #2293). The delegate sweep
  // is a relayer-paid, gasless EIP-3009 transfer on Base, so ordinary 0.01 USDC
  // x402 micropayments remain recoverable. Human USDC string (6 decimals).
  // Dev sets SWEEP_MIN_USDC=0 so QA's tiniest stranded amounts still sweep.
  sweepMinUsdc: process.env.SWEEP_MIN_USDC ?? '0.01',

  // Chains this environment actually serves account deploys on (#679). Comma-
  // separated chain ids; **unset = all supported** (backward-compatible). Dev
  // sets `84532` (Base Sepolia); prod sets `8453,84532`. A chain not listed is
  // rejected up front with a clear message instead of failing on an empty relayer.
  deployChainIds: (process.env.HAVEN_DEPLOY_CHAIN_IDS ?? '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0),

  // Fortnox bookkeeping integration (P2 #465). Disabled unless all three are
  // set. Secrets — env only, never commit.
  fortnoxClientId: process.env.FORTNOX_CLIENT_ID ?? '',
  fortnoxClientSecret: process.env.FORTNOX_CLIENT_SECRET ?? '',
  fortnoxRedirectUri: process.env.FORTNOX_REDIRECT_URI ?? '',

  // Merchant-catalog auto-discovery from the x402 Bazaar (#473). Off by
  // default — it calls an external catalog API and inserts rows, so it's
  // opt-in. The URL is overridable for testing/self-hosted facilitators.
  catalogDiscoveryEnabled: process.env.CATALOG_DISCOVERY_ENABLED === 'true',
  catalogDiscoveryUrl: optionalEnv(
    'CATALOG_DISCOVERY_URL',
    'https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources',
  ),

  // HMAC key behind the catalogue domain-ownership proof (epic #1717, #1712).
  // Deliberately NOT `requireEnv`: an existing deployment must not fail to
  // boot for a feature it has not enabled. It is deliberately NOT given a
  // fallback value either — an empty secret makes `verifyDomainOwnership`
  // refuse everything with `not_configured`, so ingestion fails CLOSED and no
  // domain can ever reach `ownership_verified` on an unconfigured host. A
  // derived-from-something-else default would be worse than no default: it
  // would let a deployment believe it was verifying domains while producing
  // proofs an attacker who knows the derivation could compute.
  catalogOwnershipSecret: process.env.CATALOG_OWNERSHIP_SECRET ?? '',

  // Platform fee module (#386). Dark by default — when false the fee is always
  // zero and no funds move. Real pricing + on-chain collection are deferred.
  feeEnabled: process.env.HAVEN_FEE_ENABLED === 'true',

  // Legacy asserting bookkeeping (epic #462). Dark by default — superseded by
  // the non-asserting reporting feed (#491). Code retained; surfaces gated:
  // SIE export, finished voucher push, and any asserted-VAT output.
  legacyBookkeepingEnabled: process.env.HAVEN_LEGACY_BOOKKEEPING_ENABLED === 'true',

  // Managed-deployment marker — true only on Haven's hosted backend. The
  // reporting feed (#491) is a hosted-only paid add-on and never runs elsewhere.
  hosted: process.env.HAVEN_HOSTED === 'true',
  // Global kill-switch for the reporting feed; dark by default.
  reportingFeedEnabled: process.env.HAVEN_REPORTING_FEED_ENABLED === 'true',

  // Database pool
  dbPoolMax: Number(process.env.DB_POOL_MAX) || 20,
  dbPoolIdleTimeout: Number(process.env.DB_POOL_IDLE_TIMEOUT) || 30000,
  dbPoolConnectionTimeout: Number(process.env.DB_POOL_CONNECTION_TIMEOUT) || 5000,
} as const

/**
 * The relayer key to use for a given chain (#640, epic #625).
 *
 * Lets a single backend serve multiple chains while keeping relayers **isolated
 * per chain**: a `RELAYER_PRIVATE_KEY_<chainId>` (e.g. `RELAYER_PRIVATE_KEY_84532`)
 * overrides the global `RELAYER_PRIVATE_KEY` for that chain. Prod uses this to run
 * a dedicated, testnet-only Base Sepolia relayer that can never touch the mainnet
 * relayer's funds (mirrors the dev/prod isolation, #613). Falls back to the global
 * key, so existing single-chain deployments are unchanged.
 */
export function relayerPrivateKeyForChain(chainId: number): string {
  return process.env[`RELAYER_PRIVATE_KEY_${chainId}`] || config.relayerPrivateKey
}
