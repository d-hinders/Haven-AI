'use client'

import { useState, useEffect, type ReactNode } from 'react'
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

export default function Providers({ children }: { children: ReactNode }) {
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
  }, [])

  // During SSR / static prerender, render children without wallet providers
  // This avoids WagmiProviderNotFoundError during next build
  if (!mounted) {
    return <AuthProvider>{children}</AuthProvider>
  }

  return (
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
          <AuthProvider>{children}</AuthProvider>
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  )
}
