'use client'

/**
 * The receive panel (#3333, epic #3328) — one card on the account page.
 *
 * What it shows and why:
 * - the account's USDC balance from the PERSISTED receive index (matched
 *   rows only — unmatched rows are unearned and never counted);
 * - the inbound rows with their match state. An unmatched row is "Unmatched"
 *   — the honest word for money the account has received but cannot yet
 *   treat as earned;
 * - the off-ramp hand-off: the owner saves a destination address, then
 *   prepares the owner-signed transfer to it. The destination is set by the
 *   OWNER on this page (an agent has no route to it), and the prepared op
 *   is signed with the account's own signer via the same signing flow the
 *   owner send uses (#1083).
 *
 * The signing surface is its own component (`ReceiveHandoff`, below) and
 * mounts ONLY when an op is prepared: it is the one piece that resolves the
 * active signer (`useActiveSigner` → wagmi context), and scoping it to the
 * hand-off keeps the panel renderable anywhere wagmi is not provided —
 * including tests that render the surrounding account page.
 */

import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { useToast } from '@/components/ui/Toast'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Skeleton } from '@/components/ui/Skeleton'
import { EmptyState } from '@/components/ui/EmptyState'
import { Address } from '@/components/haven'
import { useReceiveLedger } from '@/hooks/useReceiveLedger'
import { signPreparedAccountOp, type PreparedAccountOp } from '@/lib/hybridAccountOps'
import { useActiveSigner } from '@/lib/signer'
import type { AccountSigners } from '@/lib/delegationPasskeySigner'
import type { OffRampDestination, OffRampPrepareResponse } from '@/types/transactions'

interface ReceivePanelProps {
  accountAddress: string
  accountId: string
  chainId: number
}

function receivePanelCopy() {
  return {
    title: 'Receiving USDC',
    subtitle:
      'Payments others send to this Haven wallet are listed here. A transfer is Unmatched until its receipt is recorded — matched transfers count toward the balance.',
    saveDestination: 'Save deposit address',
    prepare: 'Prepare transfer',
    preparing: 'Preparing...',
    destinationLabel: 'Off-ramp deposit address',
    noDestination: 'No deposit address saved yet.',
    destinationNote:
      'The transfer goes only to this saved address. Only you can set it — your agents cannot.',
    balanceLabel: 'Matched balance',
  }
}

export default function ReceivePanel({ accountAddress, chainId }: ReceivePanelProps) { // design-system-exempt: a live-data account-page composite — its visual pieces (Card, Button, Address, EmptyState, Skeleton) are the registered primitives; the panel itself is a screen section, not a primitive
  const { ledger, loading, error, refetch } = useReceiveLedger(accountAddress, chainId)
  const { toast } = useToast()
  const copy = receivePanelCopy()

  const [destinationInput, setDestinationInput] = useState('')
  const [savingDestination, setSavingDestination] = useState(false)
  const [destination, setDestination] = useState<OffRampDestination | null>(null)
  const [prepareBusy, setPrepareBusy] = useState(false)
  const [prepared, setPrepared] = useState<OffRampPrepareResponse | null>(null)

  // The destination arrives ON the ledger response; keep a local mirror so
  // a save can update it without refetching the whole ledger.
  useEffect(() => {
    if (ledger) setDestination(ledger.off_ramp_destination)
  }, [ledger])

  async function saveDestination() {
    if (destinationInput === '') return
    setSavingDestination(true)
    try {
      const saved = await api.put<OffRampDestination>(
        `/receive/${accountAddress}/off-ramp-destination?chain_id=${chainId}`,
        { destination_address: destinationInput },
      )
      setDestination(saved)
      setDestinationInput('')
      toast.success('Deposit address saved')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save the deposit address')
    } finally {
      setSavingDestination(false)
    }
  }

  async function prepareHandoff() {
    // The amount is the FULL matched balance: the hand-off prepares the
    // owner's own transfer of what they have earned.
    const amount = ledger?.balance_atomic ?? '0'
    if (amount === '0') return
    setPrepareBusy(true)
    try {
      const result = await api.post<OffRampPrepareResponse>(
        `/receive/${accountAddress}/off-ramp/prepare?chain_id=${chainId}`,
        { amount_atomic: amount },
      )
      setPrepared(result)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not prepare the transfer')
    } finally {
      setPrepareBusy(false)
    }
  }

  if (loading && !ledger) {
    return (
      <Card hover={false}>
        <div className="px-5 pt-5 sm:px-6 sm:pt-6" role="status" aria-busy="true" aria-label="Loading receive panel">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="mt-3 h-9 w-44" />
          <Skeleton className="mt-4 h-4 w-full" />
        </div>
      </Card>
    )
  }

  if (error && !ledger) {
    return (
      <Card hover={false}>
        <EmptyState
          title="Receive panel could not load"
          body={error}
          // The account page carries other retry affordances (agent access,
          // the unlink dialog); the accessible name says WHICH one this is.
          action={
            <Button variant="ghost" size="sm" aria-label="Retry loading the receive panel" onClick={refetch}>
              Try again
            </Button>
          }
        />
      </Card>
    )
  }

  if (!ledger) return null

  const transfers = ledger.transfers ?? []

  return (
    <Card hover={false}>
      <Card.Header padding="none" className="px-5 py-5 sm:px-6">
        <div className="flex flex-col gap-2">
          <h2 className="text-base font-semibold text-[var(--v2-ink)]">{copy.title}</h2>
          <p className="max-w-2xl text-sm leading-relaxed text-[var(--v2-ink-2)]">{copy.subtitle}</p>
        </div>
      </Card.Header>

      <div className="px-5 pb-5 sm:px-6 sm:pb-6">
        <div className="flex flex-wrap items-baseline gap-3">
          <p className="text-xs font-medium uppercase tracking-widest text-[var(--v2-ink-3)]">{copy.balanceLabel}</p>
          <p className="text-3xl font-semibold tracking-tight text-[var(--v2-ink)] v2-tabular">
            {ledger.balance_formatted} USDC
          </p>
        </div>

        {transfers.length === 0 ? (
          <p className="mt-4 text-sm text-[var(--v2-ink-3)]">No incoming transfers yet.</p>
        ) : (
          <div className="mt-4">
            <div className="mb-2 grid grid-cols-[1fr_auto_auto] gap-4 px-2 text-xs text-[var(--v2-ink-3)]">
              <span>From</span>
              <span className="text-right">Amount</span>
              <span className="text-right">Status</span>
            </div>
            {transfers.slice(0, 5).map((row) => (
              <div
                key={row.tx_hash}
                className="grid grid-cols-[1fr_auto_auto] items-center gap-4 rounded-md px-2 py-2 hover:bg-[var(--v2-surface)] transition-colors"
              >
                <span className="min-w-0 text-sm text-[var(--v2-ink)]">
                  <Address value={row.payer_address} truncate />
                </span>
                <span className="text-sm text-[var(--v2-ink-2)] text-right font-mono v2-tabular">
                  {row.amount_formatted}
                </span>
                {row.earned ? (
                  <span className="rounded-full bg-[var(--v2-brand-soft)] px-2 py-0.5 text-xs font-medium text-[var(--v2-brand)]">
                    Matched
                  </span>
                ) : (
                  <span className="rounded-full bg-[var(--v2-surface-2)] px-2 py-0.5 text-xs font-medium text-[var(--v2-ink-3)]">
                    Unmatched
                  </span>
                )}
              </div>
            ))}
          </div>
        )}

        <div className="mt-6 rounded-[10px] border border-[var(--v2-border)] bg-[var(--v2-bg)] p-4">
          <p className="text-xs font-medium text-[var(--v2-ink-3)]">{copy.destinationLabel}</p>
          {destination ? (
            <p className="mt-2 break-all text-sm text-[var(--v2-ink)]">
              <Address value={destination.destination_address} truncate={false} />
            </p>
          ) : (
            <p className="mt-2 text-sm text-[var(--v2-ink-2)]">{copy.noDestination}</p>
          )}
          <p className="mt-2 text-xs leading-relaxed text-[var(--v2-ink-3)]">{copy.destinationNote}</p>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <input
              value={destinationInput}
              onChange={(event) => setDestinationInput(event.target.value)}
              placeholder="0x… venue deposit address"
              aria-label="Off-ramp deposit address"
              className="h-9 w-full max-w-md rounded-md border border-[var(--v2-border)] bg-[var(--v2-surface)] px-3 text-sm text-[var(--v2-ink)] placeholder:text-[var(--v2-ink-3)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80"
            />
            <Button size="sm" onClick={saveDestination} disabled={savingDestination || destinationInput === ''}>
              {savingDestination ? 'Saving...' : copy.saveDestination}
            </Button>
          </div>
        </div>

        {prepared ? (
          <ReceiveHandoff
            accountAddress={accountAddress}
            chainId={chainId}
            prepared={prepared}
            onDone={() => {
              setPrepared(null)
              toast.success('Transfer submitted')
              refetch()
            }}
            onCancel={() => setPrepared(null)}
          />
        ) : (
          <div className="mt-4">
            <Button size="sm" onClick={prepareHandoff} disabled={prepareBusy || !destination || ledger.balance_atomic === '0'}>
              {prepareBusy ? copy.preparing : copy.prepare}
            </Button>
            {!destination && (
              <p className="mt-2 text-xs text-[var(--v2-ink-3)]">Save a deposit address first.</p>
            )}
          </div>
        )}
      </div>
    </Card>
  )
}

interface ReceiveHandoffProps {
  accountAddress: string
  chainId: number
  prepared: OffRampPrepareResponse
  onDone: () => void
  onCancel: () => void
}

/**
 * The sign step of the off-ramp hand-off: the owner signs the prepared op
 * with the account's own signer and submits it. Mounted only when an op is
 * prepared — it is the only part of the receive panel that touches wagmi
 * (`useActiveSigner`), so the panel above never requires a wagmi provider
 * to render.
 */
function ReceiveHandoff({ accountAddress, chainId, prepared, onDone, onCancel }: ReceiveHandoffProps) {
  const { toast } = useToast()
  const [signBusy, setSignBusy] = useState(false)

  const signer = useActiveSigner({
    accountAddress: accountAddress as `0x${string}` | undefined,
    chainId,
  })
  const [signers, setSigners] = useState<AccountSigners | null>(null)
  useEffect(() => {
    let cancelled = false
    api
      .get<AccountSigners>(`/accounts/hybrid/${accountAddress}/signers?chain_id=${chainId}`)
      .then((rows) => {
        if (!cancelled) setSigners(rows)
      })
      .catch(() => {
        if (!cancelled) setSigners(null)
      })
    return () => {
      cancelled = true
    }
  }, [accountAddress, chainId])

  async function signAndSubmit() {
    setSignBusy(true)
    try {
      const submitBody = {
        token_address: prepared.submit.token_address,
        to: prepared.submit.to,
        amount_atomic: prepared.submit.amount_atomic,
        // The device decides the scheme (#1086): a secure passkey signs the
        // user op with webauthn, EOA owners with eip712 typed data.
        signature_scheme: signer?.type === 'eoa' ? 'eip712_userop' : 'webauthn_userop',
        signature: '' as string,
        user_operation: prepared.prepared,
      }
      const preparedOp = prepared.prepared as unknown as PreparedAccountOp
      const signature = await signPreparedAccountOp(preparedOp, signers, signer)
      submitBody.signature = signature
      const done = await api.post<{ tx_hash?: string | null }>(
        `/accounts/hybrid/${accountAddress}/transfers/submit?chain_id=${chainId}`,
        submitBody,
      )
      onDone()
      return done
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Signing was cancelled or failed')
      return null
    } finally {
      setSignBusy(false)
    }
  }

  return (
    <div className="mt-4 rounded-[10px] border border-[var(--v2-border)] bg-[var(--v2-surface)] p-4">
      <p className="text-sm font-semibold text-[var(--v2-ink)]">
        Ready to sign: {prepared.submit.amount_atomic} atomic units to{' '}
        <Address value={prepared.submit.to} truncate />
      </p>
      <p className="mt-1 text-xs text-[var(--v2-ink-3)]">
        You sign with this account&apos;s own signer. The transfer can only go to the saved address.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" onClick={signAndSubmit} disabled={signBusy}>
          {signBusy ? 'Waiting for signature...' : 'Sign transfer'}
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={signBusy}>
          Cancel
        </Button>
      </div>
    </div>
  )
}
