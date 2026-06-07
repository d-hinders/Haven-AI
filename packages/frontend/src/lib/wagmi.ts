import { createConfig, http } from 'wagmi'
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

// TEMPORARY: Base-only while we ship a single-chain UX. To re-enable
// multichain, add the chain back to `chains` and `transports` here and to
// ENABLED_CHAIN_IDS in lib/chains.ts (e.g. `import { gnosis } from
// 'wagmi/chains'`, `chains: [base, gnosis]`, `[gnosis.id]: http()`).
export const config = createConfig({
  chains: [base],
  connectors,
  transports: {
    [base.id]: http(),
  },
  ssr: true,
})
