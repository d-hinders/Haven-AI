import { createConfig, http } from 'wagmi'
import { gnosis, base } from 'wagmi/chains'
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

export const config = createConfig({
  chains: [gnosis, base],
  connectors,
  transports: {
    [gnosis.id]: http(),
    [base.id]: http(),
  },
  ssr: true,
})
