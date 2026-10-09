'use client'

/**
 * Settings → Signers (#3825): every passkey and wallet that can approve
 * actions on the user's accounts, once each, with the accounts it approves.
 *
 * Why it lives here and not on an account page: a signer is its own object
 * (owner decision 2026-10-09) — one passkey approves the account on every
 * network, and a user with several accounts would otherwise read the same
 * signer once per account. The top bar no longer carries a wallet pill
 * either (#3825), so connecting and disconnecting a browser wallet is a row
 * here; every signing flow keeps its own in-flow connect (#3812).
 *
 * Addresses stay hidden by default — most users have only a passkey, and a
 * raw address on the list is the wrong level of detail. A wallet row offers
 * "Show address" for the user who needs to tell two wallets apart. Passkeys
 * are named "Passkey · added {date}", never a platform brand (#1679), and
 * the ordinal fallback numbers across the deduplicated list.
 */

import { useConnectModal } from '@rainbow-me/rainbowkit'
import { useAccount, useDisconnect } from 'wagmi'
import { useT } from '@/context/LocaleContext'
import { useUserSigners, type UserSigner, type UserSignerAccount } from '@/hooks/useUserSigners'
import { passkeyRowLabel } from '@/lib/passkeyLabels'
import { chainName } from '@/lib/marketplace'
import { Button } from '@/components/ui/Button'
import { SettingsSection, SettingsRow } from '@/app/(authenticated)/settings/SettingsSection'

function accountsLine(accounts: UserSignerAccount[], fallbackName: string): string {
  return accounts
    .map((a) => `${a.account_name?.trim() || fallbackName} (${chainName(a.chain_id)})`)
    .join(', ')
}

function SignerRow({
  signer,
  label,
  connectedLabel,
}: {
  signer: UserSigner
  label: string
  /** The connector's name when THIS wallet is the one connected here. */
  connectedLabel?: string
}) {
  const t = useT().settings.signers
  const approves =
    signer.accounts.length > 0
      ? `${t.approves} ${accountsLine(signer.accounts, t.accountFallbackName)}`
      : t.noAccounts
  return (
    <SettingsRow
      data-testid={`signer-row-${signer.kind}`}
      label={connectedLabel ?? label}
      detail={
        <>
          <p>{approves}</p>
          {signer.kind === 'wallet' ? (
            <details className="mt-1">
              <summary className="cursor-pointer text-xs text-[var(--v2-ink-3)] hover:text-[var(--v2-ink-2)]">
                {t.showAddress}
              </summary>
              <p className="mt-1 break-all font-mono text-xs text-[var(--v2-ink-2)]">{signer.address}</p>
            </details>
          ) : null}
        </>
      }
    />
  )
}

function WalletConnectionRow() {
  const t = useT().settings.signers
  const { isConnected, connector } = useAccount()
  const { disconnect } = useDisconnect()
  const { openConnectModal } = useConnectModal()
  const name = connector?.name ?? t.walletLabel
  return (
    <SettingsRow
      data-testid="signer-wallet-connection"
      label={t.connectionLabel}
      detail={isConnected ? t.connectionConnected(name) : t.connectionNone}
      action={
        isConnected ? (
          <Button size="sm" variant="ghost" onClick={() => disconnect()}>
            {t.disconnect}
          </Button>
        ) : (
          <Button size="sm" variant="ghost" onClick={() => openConnectModal?.()} disabled={!openConnectModal}>
            {t.connect}
          </Button>
        )
      }
    />
  )
}

export function SignersSection() {
  const t = useT().settings.signers
  const { signers, loadError, reload } = useUserSigners()
  const { address: connectedAddress, isConnected, connector } = useAccount()

  let passkeyIndex = 0
  return (
    <div id="signers" className="scroll-mt-24">
      <SettingsSection title={t.title} description={t.description}>
        {loadError ? (
          <SettingsRow
            label={t.loadError}
            action={
              <Button size="sm" variant="ghost" onClick={() => void reload()}>
                {t.retry}
              </Button>
            }
          />
        ) : signers === null ? (
          <SettingsRow label={t.loading} />
        ) : signers.length === 0 ? (
          <SettingsRow label={t.empty} />
        ) : (
          signers.map((signer) => {
            if (signer.kind === 'passkey') {
              const label = passkeyRowLabel(signer.created_at, passkeyIndex++)
              return <SignerRow key={`passkey-${signer.key_id}`} signer={signer} label={label} />
            }
            const isThisConnected =
              isConnected &&
              !!connectedAddress &&
              connectedAddress.toLowerCase() === signer.address.toLowerCase()
            return (
              <SignerRow
                key={`wallet-${signer.address}`}
                signer={signer}
                label={t.walletLabel}
                connectedLabel={isThisConnected && connector?.name ? t.walletLabelConnected(connector.name) : undefined}
              />
            )
          })
        )}
        <WalletConnectionRow />
      </SettingsSection>
    </div>
  )
}
