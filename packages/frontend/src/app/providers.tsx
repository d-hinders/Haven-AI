'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { AuthProvider } from '@/context/AuthContext'
import { WagmiProvider } from 'wagmi'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RainbowKitProvider, lightTheme } from '@rainbow-me/rainbowkit'
import { config } from '@/lib/wagmi'

import '@rainbow-me/rainbowkit/styles.css'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Keep data fresh for 10 s before treating it as stale. wagmi fires many
      // queries (account, block, wallet client) on MetaMask connect — without
      // a staleTime they all refetch immediately on every component mount,
      // causing a burst of RPC calls that makes the UI feel sluggish.
      staleTime: 10_000,
      // One retry is enough for transient RPC hiccups; three (the default)
      // adds unnecessary delay before the error state is shown.
      retry: 1,
    },
  },
})

/**
 * The wallet provider tree (wagmi connectors / RainbowKit) must not render
 * during SSR/prerender — the connectors touch `localStorage` at mount, which
 * throws during static generation. So it stays gated behind a client `mounted`
 * flag.
 *
 * `AuthProvider` is the *stable root* in both states (it uses no wagmi context
 * and is already SSR-safe). The previous version swapped the root element type
 * on hydration (AuthProvider → WagmiProvider), which made React discard and
 * rebuild the entire app fiber tree — re-running every component's mount, and
 * re-initialising the wallet connectors (WalletConnect/Coinbase, via the
 * `events` polyfill, add `close` listeners) more than once. Under React Strict
 * Mode that churn is what surfaces the "Possible EventEmitter memory leak … N
 * close listeners" warning. Keeping AuthProvider stable means only the wallet
 * subtree mounts on hydration, not the whole app. (#410)
 */
export default function Providers({ children }: { children: ReactNode }) {
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  return (
    <AuthProvider>
      {mounted ? (
        <WagmiProvider config={config}>
          <QueryClientProvider client={queryClient}>
            <RainbowKitProvider
              theme={lightTheme({
                accentColor: '#4f46e5',
                accentColorForeground: 'white',
                borderRadius: 'medium',
                overlayBlur: 'small',
              })}
            >
              {children}
            </RainbowKitProvider>
          </QueryClientProvider>
        </WagmiProvider>
      ) : (
        children
      )}
    </AuthProvider>
  )
}
