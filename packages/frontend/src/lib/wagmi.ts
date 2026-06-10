import { createConfig, fallback, http } from 'wagmi'
import { base } from 'wagmi/chains'
import { injected, walletConnect, coinbaseWallet } from 'wagmi/connectors'

const projectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID

// Build connectors list — only include WalletConnect if a real project ID exists
const connectors = [
  injected(),
  coinbaseWallet({ appName: 'Haven' }),
  ...(projectId && projectId !== 'PLACEHOLDER'
    ? [walletConnect({ projectId })]
    : []),
]

// Read-heavy pages (Safe details, on-chain allowance polling, nonce reads on
// send/revoke) hammer the RPC. viem's default Base endpoint
// (https://mainnet.base.org) is aggressively rate-limited and surfaces as
// "over rate limit" errors — e.g. when revoking an agent.
//
// Use a fallback transport: prefer a dedicated provider via env, then rotate
// through reliable public nodes. If one endpoint rate-limits or fails, viem
// automatically falls through to the next. Set NEXT_PUBLIC_BASE_RPC_URL in
// production to a dedicated provider (Alchemy/Infura/etc.) for best results.
const baseRpcUrls = [
  process.env.NEXT_PUBLIC_BASE_RPC_URL?.trim(),
  'https://base-rpc.publicnode.com',
  'https://base.llamarpc.com',
  'https://mainnet.base.org',
].filter((url): url is string => Boolean(url))

// TEMPORARY: Base-only while we ship a single-chain UX. To re-enable
// multichain, add the chain back to `chains` and `transports` here and to
// ENABLED_CHAIN_IDS in lib/chains.ts (e.g. `import { gnosis } from
// 'wagmi/chains'`, `chains: [base, gnosis]`, `[gnosis.id]: fallback(...)`).
export const config = createConfig({
  chains: [base],
  connectors,
  transports: {
    [base.id]: fallback(baseRpcUrls.map((url) => http(url))),
  },
  ssr: true,
})
