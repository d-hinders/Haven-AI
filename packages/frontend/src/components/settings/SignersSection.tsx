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
 *
 * #4472: each approved account is an outline pill link (`LinkChip`) to its
 * Security & details tab, as the approved #4356 mockup draws it — not the
 * comma-joined run of inline text links #4358's slice spec named. A passkey
 * whose credential this device holds also carries a neutral "This device"
 * badge beside its label.
 */

import { useConnectModal } from '@rainbow-me/rainbowkit'
import { useAccount, useDisconnect } from 'wagmi'
import { useT } from '@/context/LocaleContext'
import { useUserSigners, type UserSigner, type UserSignerAccount } from '@/hooks/useUserSigners'
import { passkeyRowLabel } from '@/lib/passkeyLabels'
import { chainName } from '@/lib/marketplace'
import { credentialIdFromKeyId, hasPasskeyCredentialOnDevice } from '@/lib/signer'
import { Button } from '@/components/ui/Button'
import { LinkChip } from '@/components/ui/LinkChip'
import { SettingsSection, SettingsRow } from '@/components/ui/SettingsSection'
import { StatusBadge } from '@/components/ui/StatusBadge'

/**
 * The visible label of one approved account (#4472). The name alone, unless
 * the user's signer-listed accounts span more than one network — then every
 * pill in the section carries its `(network)` suffix, so one account reads
 * the same on every row (owner decision 2026-10-27). The suffix is decided
 * for the SECTION, never per signer.
 */
function accountLabel(
  account: UserSignerAccount,
  fallbackName: string,
  withNetwork: boolean,
): string {
  const name = account.account_name?.trim() || fallbackName
  return withNetwork ? `${name} (${chainName(account.chain_id)})` : name
}

function SignerRow({
  signer,
  label,
  connectedLabel,
  withNetwork,
  onThisDevice,
}: {
  signer: UserSigner
  label: string
  /** The connector's name when THIS wallet is the one connected here. */
  connectedLabel?: string
  /** True when the section's accounts span more than one chain (#4472). */
  withNetwork: boolean
  /** True when this device holds the passkey's credential (#4472). */
  onThisDevice?: boolean
}) {
  const t = useT().settings.signers
  return (
    <SettingsRow
      data-testid={`signer-row-${signer.kind}`}
      label={
        onThisDevice ? (
          // The badge is a sibling span, so the label text stays its own node
          // (`SettingsRow` renders the label inside a `<p>`).
          <span className="inline-flex flex-wrap items-center gap-2">
            <span>{connectedLabel ?? label}</span>
            <StatusBadge tone="neutral">{t.thisDevice}</StatusBadge>
          </span>
        ) : (
          connectedLabel ?? label
        )
      }
      detail={
        <>
          {signer.accounts.length > 0 ? (
            // A flex row, not a `<p>`: a flex `div` inside a `p` is invalid
            // HTML, and the pills wrap as a group on a phone (#4472).
            <div className="flex flex-wrap gap-2">
              {signer.accounts.map((account) => (
                <LinkChip
                  key={`${account.account_id}-${account.chain_id}`}
                  href={`/accounts/${account.account_id}?tab=security`}
                >
                  {accountLabel(account, t.accountFallbackName, withNetwork)}
                </LinkChip>
              ))}
            </div>
          ) : (
            <p>{t.noAccounts}</p>
          )}
          {signer.kind === 'wallet' ? (
            <details className="mt-1">
              <summary className="cursor-pointer rounded-sm text-xs text-[var(--v2-ink-3)] hover:text-[var(--v2-ink-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80">
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

/**
 * The browser-wallet connect / disconnect control (#3825), now that the top
 * bar carries no wallet pill. Deliberately NOT a `SettingsRow`: in a list
 * titled Signers a row with the same bold label reads as one more signer —
 * for the passkey-only majority, as a missing one to fix (#3825 design
 * review). It is a quiet footer line instead: secondary ink, no label, the
 * sentence saying what connecting is for.
 */
function WalletConnectionRow() {
  const t = useT().settings.signers
  const { isConnected, connector } = useAccount()
  const { disconnect } = useDisconnect()
  const { openConnectModal } = useConnectModal()
  const name = connector?.name ?? t.walletLabel
  return (
    <div
      data-testid="signer-wallet-connection"
      className="flex flex-col gap-2 px-6 py-3 sm:flex-row sm:items-center sm:justify-between"
    >
      <p className="text-xs text-[var(--v2-ink-3)]">
        {isConnected ? t.connectionConnected(name) : t.connectionNone}
      </p>
      <div className="shrink-0">
        {isConnected ? (
          <Button size="sm" variant="ghost" onClick={() => disconnect()}>
            {t.disconnect}
          </Button>
        ) : (
          <Button size="sm" variant="ghost" onClick={() => openConnectModal?.()} disabled={!openConnectModal}>
            {t.connect}
          </Button>
        )}
      </div>
    </div>
  )
}

export function SignersSection() {
  const t = useT().settings.signers
  const { signers, loadError, reload } = useUserSigners()
  const { address: connectedAddress, isConnected, connector } = useAccount()

  // #4472: the network suffix is a SECTION decision — every pill carries it
  // when the listed accounts span more than one chain, so one account reads
  // the same on every row.
  const withNetwork =
    new Set(signers?.flatMap((s) => s.accounts.map((a) => a.chain_id)) ?? []).size > 1

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
              // Rows render only after the client fetch, so reading the
              // device marker here cannot mismatch hydration. The check is
              // not reactive: a passkey enrolled in another tab shows up on
              // the next load, which is acceptable (#4472).
              const onThisDevice = hasPasskeyCredentialOnDevice(credentialIdFromKeyId(signer.key_id))
              return (
                <SignerRow
                  key={`passkey-${signer.key_id}`}
                  signer={signer}
                  label={label}
                  withNetwork={withNetwork}
                  onThisDevice={onThisDevice}
                />
              )
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
                withNetwork={withNetwork}
              />
            )
          })
        )}
        <WalletConnectionRow />
      </SettingsSection>
    </div>
  )
}
