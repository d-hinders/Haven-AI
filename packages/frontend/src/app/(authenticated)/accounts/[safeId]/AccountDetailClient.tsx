'use client'

import { useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { useAuth } from '@/context/AuthContext'
import { useBalances } from '@/hooks/useBalances'
import { useTransactions } from '@/hooks/useTransactions'
import { usePortfolio } from '@/hooks/usePortfolio'
import { useSafeDetails } from '@/hooks/useSafeDetails'
import { usePreferences } from '@/hooks/usePreferences'
import { useContacts } from '@/hooks/useContacts'
import { useAgents } from '@/hooks/useAgents'
import BalanceCards from '@/components/BalanceCards'
import TransactionList from '@/components/TransactionList'
import SendButton from '@/components/SendButton'
import AccountInfo from '@/components/AccountInfo'

function truncate(addr: string) {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }
  return (
    <button
      onClick={copy}
      className="text-zinc-600 hover:text-zinc-400 transition-colors"
      title="Copy"
    >
      {copied ? (
        <svg className="w-3.5 h-3.5 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
        </svg>
      ) : (
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M15.666 3.888A2.25 2.25 0 0013.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9.75a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184" />
        </svg>
      )}
    </button>
  )
}

export default function AccountDetailClient() {
  const params = useParams()
  const router = useRouter()
  const safeId = params.safeId as string

  const { user, activeSafe, setActiveSafe } = useAuth()
  const { currency } = usePreferences()
  const { contacts, resolveAddress } = useContacts()
  const { agents } = useAgents()

  // Find this Safe from user's list
  const safe = user?.safes?.find((s) => s.id === safeId)
  const safeAddress = safe?.safe_address ?? null

  // Set as active safe when viewing
  if (safe && activeSafe?.id !== safe.id) {
    setActiveSafe(safe)
  }

  // Build agent lookup
  const agentsByDelegate = new Map<string, string>()
  const safeAgents = agents.filter((a) => a.safe_id === safeId && a.status === 'active')
  for (const agent of agents) {
    if (agent.delegate_address && agent.status === 'active') {
      agentsByDelegate.set(agent.delegate_address.toLowerCase(), agent.name)
    }
  }

  const { details, loading: detailsLoading } = useSafeDetails(safeAddress)

  const {
    totalUsd,
    totalEur,
    breakdown,
    loading: portfolioLoading,
  } = usePortfolio(safeAddress)

  const {
    balances,
    loading: balancesLoading,
    error: balancesError,
    refetch: refetchBalances,
  } = useBalances(safeAddress)

  const {
    transactions,
    loading: txLoading,
    error: txError,
    page,
    pages,
    total,
    setPage,
    refetch: refetchTx,
  } = useTransactions(safeAddress, 25)

  const totalFiat = currency === 'EUR' ? totalEur : totalUsd

  const [infoOpen, setInfoOpen] = useState(false)

  const handleSendSuccess = () => {
    refetchBalances()
    refetchTx()
  }

  if (!safe) {
    return (
      <div className="max-w-5xl py-16 text-center">
        <p className="text-sm text-zinc-500">Account not found</p>
        <Link href="/accounts" className="text-sm text-indigo-400 hover:text-indigo-300 mt-2 inline-block">
          Back to accounts
        </Link>
      </div>
    )
  }

  return (
    <div className="max-w-5xl">
      {/* Header */}
      <div className="mb-8 flex items-center justify-between">
        <div className="flex items-center gap-3">
          {(user?.safes?.length ?? 0) > 1 && (
            <Link
              href="/accounts"
              className="text-zinc-600 hover:text-zinc-400 transition-colors"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                <path d="M19 12H5M12 19l-7-7 7-7" />
              </svg>
            </Link>
          )}
          <div>
            <div className="flex items-center gap-2 mb-1">
              <h1 className="text-2xl font-bold tracking-tight">{safe.name}</h1>
              {safe.is_default && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-500/10 text-indigo-400 font-medium">
                  default
                </span>
              )}
            </div>
            <p className="text-sm text-zinc-500">
              Safe details, balances, and transaction history
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setInfoOpen(true)}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-white/[0.08] bg-white/[0.02] text-zinc-400 text-sm font-medium hover:bg-white/[0.05] hover:text-zinc-300 transition-all duration-200"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
            How it works
          </button>
          {safeAddress && (
            <SendButton
              safeAddress={safeAddress}
              safeDetails={details}
              balances={balances}
              onSuccess={handleSendSuccess}
              contacts={contacts}
              resolveAddress={resolveAddress}
            />
          )}
        </div>
      </div>

      {/* Safe info */}
      <div className="rounded-lg border border-white/[0.06] bg-white/[0.01] p-6 mb-6">
        <h2 className="text-xs text-zinc-500 uppercase tracking-widest mb-5">
          Safe Details
        </h2>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
          {/* Address */}
          <div>
            <p className="text-xs text-zinc-500 mb-1">Address</p>
            <div className="flex items-center gap-2">
              <span className="text-sm font-mono text-zinc-300">
                {safeAddress ? truncate(safeAddress) : '—'}
              </span>
              {safeAddress && <CopyButton text={safeAddress} />}
              {safeAddress && (
                <a
                  href={`https://gnosisscan.io/address/${safeAddress}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-zinc-600 hover:text-zinc-400 transition-colors"
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
                  </svg>
                </a>
              )}
            </div>
          </div>

          {/* Threshold */}
          <div>
            <p className="text-xs text-zinc-500 mb-1">Threshold</p>
            {detailsLoading ? (
              <div className="h-5 w-24 bg-white/[0.06] rounded animate-pulse" />
            ) : details ? (
              <span className="text-sm text-zinc-300">
                {details.threshold} of {details.owners.length} owner
                {details.owners.length !== 1 ? 's' : ''}
              </span>
            ) : (
              <span className="text-sm text-zinc-600">—</span>
            )}
          </div>

          {/* Nonce */}
          <div>
            <p className="text-xs text-zinc-500 mb-1">Nonce</p>
            {detailsLoading ? (
              <div className="h-5 w-12 bg-white/[0.06] rounded animate-pulse" />
            ) : details ? (
              <span className="text-sm text-zinc-300">{details.nonce}</span>
            ) : (
              <span className="text-sm text-zinc-600">—</span>
            )}
          </div>

          {/* Network */}
          <div>
            <p className="text-xs text-zinc-500 mb-1">Network</p>
            <span className="text-sm text-zinc-300">Gnosis Chain</span>
          </div>
        </div>

        {/* Owners */}
        {details && details.owners.length > 0 && (
          <div className="mt-6 pt-5 border-t border-white/[0.06]">
            <p className="text-xs text-zinc-500 mb-3">Owners</p>
            <div className="space-y-2">
              {details.owners.map((owner) => {
                const isYou =
                  user?.wallet_address?.toLowerCase() === owner.toLowerCase()
                return (
                  <div
                    key={owner}
                    className="flex items-center gap-2 py-1.5"
                  >
                    <span className="text-sm font-mono text-zinc-300">
                      {truncate(owner)}
                    </span>
                    <CopyButton text={owner} />
                    <a
                      href={`https://gnosisscan.io/address/${owner}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-zinc-600 hover:text-zinc-400 transition-colors"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
                      </svg>
                    </a>
                    {isYou && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded-sm bg-indigo-500/10 text-indigo-400 font-medium">
                        You
                      </span>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* Linked agents */}
        {safeAgents.length > 0 && (
          <div className="mt-6 pt-5 border-t border-white/[0.06]">
            <p className="text-xs text-zinc-500 mb-3">
              Linked Agents ({safeAgents.length})
            </p>
            <div className="flex flex-wrap gap-2">
              {safeAgents.map((agent) => (
                <span
                  key={agent.id}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-white/[0.03] border border-white/[0.06] text-xs text-zinc-400"
                >
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 3.104v5.714a2.25 2.25 0 01-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 014.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15.3M14.25 3.104c.251.023.501.05.75.082M19.8 15.3l-1.57.393A9.065 9.065 0 0112 15a9.065 9.065 0 00-6.23.693L5 14.5m14.8.8l1.402 1.402c1.232 1.232.65 3.318-1.067 3.611A48.309 48.309 0 0112 21c-2.773 0-5.491-.235-8.135-.687-1.718-.293-2.3-2.379-1.067-3.61L5 14.5" />
                  </svg>
                  {agent.name}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Balances with fiat values */}
      <div className="mb-4">
        <h2 className="text-sm font-semibold text-zinc-300">Token Balances</h2>
      </div>
      <BalanceCards
        balances={balances}
        loading={balancesLoading}
        error={balancesError}
        onRefresh={refetchBalances}
      />

      {/* Portfolio breakdown */}
      {!portfolioLoading && breakdown.length > 0 && (
        <div className="rounded-lg border border-white/[0.06] bg-white/[0.01] p-4 mb-8 -mt-4">
          <div className="grid grid-cols-3 gap-4 text-xs text-zinc-500 mb-2 px-2">
            <span>Asset</span>
            <span className="text-right">Balance</span>
            <span className="text-right">
              Value ({currency})
            </span>
          </div>
          {breakdown.map((item) => {
            const fiatValue = currency === 'EUR' ? item.eurValue : item.usdValue
            return (
              <div
                key={item.symbol}
                className="grid grid-cols-3 gap-4 px-2 py-2 rounded-md hover:bg-white/[0.02] transition-colors"
              >
                <span className="text-sm text-zinc-300">{item.symbol}</span>
                <span className="text-sm text-zinc-400 text-right font-mono">
                  {item.formatted}
                </span>
                <span className="text-sm text-zinc-300 text-right">
                  {new Intl.NumberFormat(
                    currency === 'EUR' ? 'de-DE' : 'en-US',
                    {
                      style: 'currency',
                      currency,
                      minimumFractionDigits: 2,
                    },
                  ).format(fiatValue)}
                </span>
              </div>
            )
          })}
          <div className="grid grid-cols-3 gap-4 px-2 pt-3 mt-2 border-t border-white/[0.06]">
            <span className="text-sm font-medium text-zinc-200">Total</span>
            <span />
            <span className="text-sm font-medium text-zinc-200 text-right">
              {new Intl.NumberFormat(currency === 'EUR' ? 'de-DE' : 'en-US', {
                style: 'currency',
                currency,
                minimumFractionDigits: 2,
              }).format(totalFiat)}
            </span>
          </div>
        </div>
      )}

      {/* Full transaction history */}
      <div className="mb-4">
        <h2 className="text-sm font-semibold text-zinc-300">
          Transaction History
        </h2>
      </div>
      <div className="rounded-lg border border-white/[0.06] bg-white/[0.01] p-4">
        <TransactionList
          transactions={transactions}
          loading={txLoading}
          error={txError}
          page={page}
          pages={pages}
          total={total}
          onPageChange={setPage}
          onRefresh={refetchTx}
          resolveAddress={resolveAddress}
          agentsByDelegate={agentsByDelegate}
        />
      </div>

      <AccountInfo open={infoOpen} onClose={() => setInfoOpen(false)} />
    </div>
  )
}
