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

  // Chain-specific RPC URLs
  rpcUrlBase: optionalEnv('RPC_URL_BASE', 'https://mainnet.base.org'),
  rpcUrlBaseSepolia: optionalEnv('RPC_URL_BASE_SEPOLIA', 'https://sepolia.base.org'),

  // Optional (features degrade gracefully without these)
  gnosisscanApiKey: process.env.GNOSISSCAN_API_KEY ?? '',
  basescanApiKey: process.env.BASESCAN_API_KEY ?? '',
  coingeckoApiKey: process.env.COINGECKO_API_KEY ?? '',
  relayerPrivateKey: process.env.RELAYER_PRIVATE_KEY ?? '',

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
