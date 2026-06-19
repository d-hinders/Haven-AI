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

  // Optional (features degrade gracefully without these)
  gnosisscanApiKey: process.env.GNOSISSCAN_API_KEY ?? '',
  basescanApiKey: process.env.BASESCAN_API_KEY ?? '',
  coingeckoApiKey: process.env.COINGECKO_API_KEY ?? '',
  relayerPrivateKey: process.env.RELAYER_PRIVATE_KEY ?? '',

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

  // Database pool
  dbPoolMax: Number(process.env.DB_POOL_MAX) || 20,
  dbPoolIdleTimeout: Number(process.env.DB_POOL_IDLE_TIMEOUT) || 30000,
  dbPoolConnectionTimeout: Number(process.env.DB_POOL_CONNECTION_TIMEOUT) || 5000,
} as const
