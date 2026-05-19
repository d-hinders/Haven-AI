'use client'

import dynamic from 'next/dynamic'
import ProtectedRoute from '@/components/ProtectedRoute'
import ErrorBoundary from '@/components/ErrorBoundary'
import TopBar from '@/components/TopBar'
import { OwnerDirectoryProvider } from '@/context/OwnerDirectoryContext'
import { ToastProvider, Toaster } from '@/components/ui/Toast'

const Sidebar = dynamic(() => import('@/components/sidebar/Sidebar'), {
  ssr: false,
})

export default function AuthenticatedLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <ProtectedRoute>
      <OwnerDirectoryProvider>
        <ToastProvider>
          <a
            href="#main-content"
            className="sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-[9999] focus:rounded-md focus:bg-[var(--v2-ink)] focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-white focus:shadow-[var(--v2-shadow-popover)] focus:outline-none focus:ring-2 focus:ring-[var(--v2-brand)]/30"
          >
            Skip to main content
          </a>
          <div className="flex h-screen bg-[var(--v2-bg)] text-[var(--v2-ink)] overflow-hidden">
            <Sidebar />
            <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
              <TopBar />
              <main
                id="main-content"
                tabIndex={-1}
                className="flex-1 bg-[var(--v2-bg)] p-6 lg:p-8 overflow-y-auto focus:outline-none"
              >
                <ErrorBoundary>{children}</ErrorBoundary>
              </main>
            </div>
          </div>
          <Toaster />
        </ToastProvider>
      </OwnerDirectoryProvider>
    </ProtectedRoute>
  )
}
