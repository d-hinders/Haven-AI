'use client'

/**
 * Turning Sales on (#4904, epic #4885) — the dialog the approved mockup
 * (#4894, 2026-11-16) draws.
 *
 * ## What it asks, and what it does not
 *
 * The FIRST turn-on asks for a network and one passkey, and nothing else: the
 * account is created named "Sales" by the server, so there is no name field
 * (owner decision 1 on #4894). The network is permanent for the pilot, and the
 * dialog says so beside the choice.
 *
 * Turning Sales back on asks for NOTHING: the merchant account already exists,
 * so the route answers it without a network and without a passkey (owner
 * decision 5 on #4894). The dialog sends an empty body and goes straight to the
 * result.
 *
 * ## The passkey step is the New account dialog's
 *
 * `usePasskeyStep` is the step `NewAccountDialog` uses — one WebAuthn
 * assertion restricted to the source account's passkeys, whose credential id
 * becomes the `key_id` the server copies the signer from. The issue asks for
 * exactly that reuse rather than a copy.
 *
 * ## A repeat is not an error
 *
 * A double click, a retry or a second tab answers 200 with `created: false`
 * and the existing account: the route derives its idempotency key and locks
 * the setting row, so a second account cannot be created. The dialog shows the
 * RESULT state for a repeat, never an error — `created` is not something the
 * user needs to read.
 *
 * ## The result recommends a backup, and never gates on it
 *
 * After creation the dialog shows the dashboard's existing recommendation to
 * add a backup signer ("Add a backup — a backup passkey or a wallet — so a lost
 * device never means a lost account", `lib/dashboard-attention.ts`), with the
 * same "Add backup" action. It is a `NoticeRow`, not a gate: "Done" and "Open
 * Sales account" both work without it.
 *
 * ## Every refusal says what to do
 *
 * The six codes #4895 answers are mapped in `lib/merchant-services.ts` and
 * rendered here with their own sentence and next step. No raw error code is
 * ever shown.
 */

import { useMemo, useState, type ReactNode } from 'react'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { Select } from '@/components/ui/Select'
import { InlineAlert } from '@/components/ui/InlineAlert'
import { Skeleton } from '@/components/ui/Skeleton'
import { DialogActions } from '@/components/ui/DialogActions'
import { DialogResult } from '@/components/ui/DialogResult'
import { NoticeRow } from '@/components/haven/NoticeRow'
import NetworkPill from '@/components/NetworkPill'
import { useT } from '@/context/LocaleContext'
import { useMerchantServicesContext } from '@/context/MerchantServicesContext'
import { useAccounts } from '@/hooks/useAccounts'
import { useUserSigners } from '@/hooks/useUserSigners'
import { useDeployableChains } from '@/hooks/useDeployableChains'
import { usePasskeyStep } from '@/hooks/usePasskeyStep'
import { getChainConfig } from '@/lib/chains'
import { defaultSource, passkeySources } from '@/lib/new-account'
import type { MerchantAccount, TurnOnRefusal } from '@/lib/merchant-services'

export interface TurnOnSalesDialogProps {
  open: boolean
  onClose: () => void
}

export default function TurnOnSalesDialog({ open, onClose }: TurnOnSalesDialogProps) {
  if (!open) return null
  return <TurnOnSalesDialogBody onClose={onClose} />
}

type Stage = 'form' | 'passkey' | 'creating' | 'done'

function TurnOnSalesDialogBody({ onClose }: { onClose: () => void }) {
  const t = useT()
  const copy = t.settings.sales.dialog
  const { merchantAccount, turnOn } = useMerchantServicesContext()
  const { accounts, refreshAccounts } = useAccounts()
  const { signers, loadError, reload } = useUserSigners()
  const { chains } = useDeployableChains()
  const passkey = usePasskeyStep()

  const sources = useMemo(() => (signers ? passkeySources(accounts, signers) : []), [accounts, signers])
  const source = useMemo(() => defaultSource(sources), [sources])

  const [chainId, setChainId] = useState<number | null>(null)
  const [stage, setStage] = useState<Stage>('form')
  const [refusal, setRefusal] = useState<TurnOnRefusal | null>(null)
  const [created, setCreated] = useState<MerchantAccount | null>(null)

  // The network the first turn-on will use: the source account's own when the
  // backend serves deploys there, else the first network it does. Turning Sales
  // back on has no choice — the account's network is the answer.
  const sourceChainServed = source !== null && chains.some((c) => c.chainId === source.account.chain_id)
  const selectedChainId = merchantAccount
    ? merchantAccount.chain_id
    : chainId ?? (sourceChainServed ? source!.account.chain_id : chains[0]?.chainId ?? null)
  const networkName = selectedChainId !== null ? getChainConfig(selectedChainId).name : ''

  const busy = stage === 'passkey' || stage === 'creating' || passkey.waiting
  const needsPasskey = merchantAccount === null && signers !== null && !loadError && sources.length === 0

  async function submit() {
    // Re-entry is blocked by the submit button's `disabled`, not here: a `busy`
    // read in this closure is the render's value.
    if (busy) return
    setRefusal(null)

    // Turning Sales back on: the account exists, so the route needs nothing.
    if (merchantAccount !== null) {
      setStage('creating')
      const result = await turnOn({})
      if (result.ok) {
        setCreated(result.state.merchant_account)
        setStage('done')
        void refreshAccounts()
      } else {
        setStage('form')
        setRefusal(result.refusal)
      }
      return
    }

    if (source === null || selectedChainId === null) return

    setStage('passkey')
    const outcome = await passkey.run(source)
    if (outcome.kind !== 'asserted') {
      setStage('form')
      // A dismissed sheet is the user changing their mind, not a failure.
      if (outcome.kind === 'cancelled') return
      setRefusal(
        outcome.kind === 'key_not_on_source'
          ? { kind: 'key_not_on_source' }
          : outcome.kind === 'unsupported'
            ? { kind: 'passkey_unsupported' }
            : { kind: 'passkey_failed' },
      )
      return
    }

    setStage('creating')
    const result = await turnOn({
      chain_id: selectedChainId,
      source_account_id: source.account.id,
      key_id: outcome.keyId,
    })
    if (result.ok) {
      setCreated(result.state.merchant_account)
      setStage('done')
      // The Sales account is a real account: re-read the session payload so the
      // account list (and the dashboard's backup recommendation) sees it.
      void refreshAccounts()
    } else {
      setStage('form')
      setRefusal(result.refusal)
    }
  }

  // ── Body ────────────────────────────────────────────────────────────────

  let body: ReactNode
  let footer: ReactNode

  if (stage === 'done' && created) {
    body = (
      <div className="space-y-4" data-testid="sales-on-result">
        <DialogResult
          state="success"
          title={copy.doneTitle}
          description={copy.doneBody(getChainConfig(created.chain_id).name)}
          announce
        />
        {/* The dashboard's existing recommendation, reused verbatim — a
            recommendation, never a gate. */}
        <NoticeRow
          action={
            <Button href={`/accounts/${created.id}`} variant="ghost" size="sm">
              {copy.addBackup}
            </Button>
          }
        >
          {copy.backupNotice}
        </NoticeRow>
      </div>
    )
    footer = (
      <DialogActions>
        <Button variant="ghost" onClick={onClose}>
          {copy.done}
        </Button>
        <Button href={`/accounts/${created.id}`}>{copy.openAccount}</Button>
      </DialogActions>
    )
  } else if (stage === 'passkey' || stage === 'creating') {
    body = <DialogResult state="busy" title={stage === 'passkey' ? copy.waiting : copy.creating} />
    footer = (
      <DialogActions>
        <Button variant="ghost" disabled>
          {copy.cancel}
        </Button>
        <Button disabled>{stage === 'passkey' ? copy.waiting : copy.creating}</Button>
      </DialogActions>
    )
  } else if (signers === null && !loadError) {
    body = (
      <div role="status" aria-busy="true" aria-live="polite" className="space-y-3">
        <span className="sr-only">{copy.passkeysLoading}</span>
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    )
    footer = (
      <DialogActions>
        <Button variant="ghost" onClick={onClose}>
          {copy.cancel}
        </Button>
        <Button disabled>{copy.submit}</Button>
      </DialogActions>
    )
  } else if (loadError) {
    body = <InlineAlert>{copy.passkeysError}</InlineAlert>
    footer = (
      <DialogActions>
        <Button variant="ghost" onClick={onClose}>
          {copy.cancel}
        </Button>
        <Button onClick={() => void reload()}>{t.settings.sales.retry}</Button>
      </DialogActions>
    )
  } else if (needsPasskey) {
    const target = accounts.find((a) => a.is_default) ?? accounts[0]
    body = (
      <div className="space-y-2" data-testid="sales-needs-passkey">
        <p className="text-sm font-medium text-[var(--v2-ink)]">{copy.needsPasskeyTitle}</p>
        <p className="text-sm text-[var(--v2-ink-2)]">{copy.needsPasskeyBody}</p>
      </div>
    )
    footer = (
      <DialogActions>
        <Button variant="ghost" onClick={onClose}>
          {copy.close}
        </Button>
        {target ? <Button href={`/accounts/${target.id}`}>{copy.openAccount}</Button> : null}
      </DialogActions>
    )
  } else {
    body = (
      <div className="space-y-5">
        {merchantAccount !== null ? (
          <div className="space-y-1.5">
            <p className="text-sm font-medium text-[var(--v2-ink)]">{copy.networkLabel}</p>
            <div className="flex items-center gap-2">
              <NetworkPill chainId={merchantAccount.chain_id} />
              <span className="text-sm text-[var(--v2-ink-2)]">{copy.networkLocked(networkName)}</span>
            </div>
          </div>
        ) : (
          <div className="space-y-1.5">
            <label htmlFor="sales-network" className="text-sm font-medium text-[var(--v2-ink)]">
              {copy.networkLabel}
            </label>
            <Select
              id="sales-network"
              value={selectedChainId ?? ''}
              onChange={(e) => {
                setChainId(Number(e.target.value))
                setRefusal(null)
              }}
              disabled={busy}
            >
              {chains.map((chain) => (
                <option key={chain.chainId} value={chain.chainId}>
                  {chain.name}
                </option>
              ))}
            </Select>
            <p className="text-xs text-[var(--v2-ink-3)]">{copy.networkHelp}</p>
          </div>
        )}

        <ul className="space-y-2 text-sm text-[var(--v2-ink-2)]" data-testid="sales-dialog-facts">
          <li>{copy.facts.account}</li>
          {merchantAccount === null ? <li>{copy.facts.passkey}</li> : null}
          <li>{copy.facts.backup}</li>
        </ul>

        {refusal ? <RefusalMessage refusal={refusal} networkName={networkName} /> : null}
      </div>
    )
    footer = (
      <DialogActions>
        <Button variant="ghost" onClick={onClose} disabled={busy}>
          {copy.cancel}
        </Button>
        <Button onClick={() => void submit()} disabled={busy || (merchantAccount === null && source === null)}>
          {copy.submit}
        </Button>
      </DialogActions>
    )
  }

  return (
    <Modal
      open
      onClose={busy ? () => undefined : onClose}
      title={copy.title}
      subtitle={copy.subtitle}
      footer={footer}
      showCloseButton
      closeButtonDisabled={busy}
      placement="top"
      panelTestId="turn-on-sales-dialog"
    >
      {body}
    </Modal>
  )
}

/**
 * One sentence per refusal, each naming what the user can do about it. The
 * codes are mapped in `lib/merchant-services.ts`; nothing here reads the
 * backend's sentence except the code-less fallback, which passes it through as
 * detail (never as a code).
 */
function RefusalMessage({ refusal, networkName }: { refusal: TurnOnRefusal; networkName: string }) {
  const copy = useT().settings.sales.dialog.refusals

  switch (refusal.kind) {
    case 'source_not_found':
      return <InlineAlert>{copy.source_not_found}</InlineAlert>
    case 'source_has_no_passkey':
      return <InlineAlert>{copy.source_has_no_passkey}</InlineAlert>
    case 'key_not_on_source':
      return <InlineAlert>{copy.key_not_on_source}</InlineAlert>
    case 'passkey_unsupported':
      return <InlineAlert>{copy.passkey_unsupported}</InlineAlert>
    case 'passkey_failed':
      return <InlineAlert>{copy.passkey_failed}</InlineAlert>
    case 'cap_reached':
      return <InlineAlert>{copy.cap_reached(refusal.cap, networkName)}</InlineAlert>
    case 'unsupported_network': {
      const names = refusal.supported.map((id) => getChainConfig(id).name).join(', ')
      return <InlineAlert>{copy.unsupported_network(names)}</InlineAlert>
    }
    case 'other_network': {
      const name = refusal.chainId !== null ? getChainConfig(refusal.chainId).name : networkName
      return <InlineAlert>{copy.other_network(name)}</InlineAlert>
    }
    case 'setup_details_required':
      return <InlineAlert>{copy.setup_details_required}</InlineAlert>
    case 'address_unavailable':
      return <InlineAlert>{copy.address_unavailable}</InlineAlert>
    case 'already_registered':
      return <InlineAlert>{copy.already_registered}</InlineAlert>
    case 'rate_limited':
      return <InlineAlert>{copy.rate_limited}</InlineAlert>
    case 'could_not_turn_on':
      return <InlineAlert>{copy.could_not_turn_on(refusal.detail)}</InlineAlert>
    case 'unknown_outcome':
      return <InlineAlert>{copy.unknown_outcome}</InlineAlert>
  }
}
