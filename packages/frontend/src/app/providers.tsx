'use client'

import { useState, useEffect, type ReactNode } from 'react'
import { AuthProvider } from '@/context/AuthContext'
import { WagmiProvider } from 'wagmi'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RainbowKitProvider, lightTheme } from '@rainbow-me/rainbowkit'
import { config } from '@/lib/wagmi'

import '@rainbow-me/rainbowkit/styles.css'

const queryClient = new QueryClient()

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
