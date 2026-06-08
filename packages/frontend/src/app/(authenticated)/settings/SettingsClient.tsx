'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { useAuth } from '@/context/AuthContext'
import { useOwnerDirectory } from '@/context/OwnerDirectoryContext'
import { usePreferences } from '@/hooks/usePreferences'
import { type OwnerAlias } from '@/lib/api'
import { getChainConfig, getExplorerUrl, DEFAULT_CHAIN_ID } from '@/lib/chains'
import { truncate } from '@/lib/format'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { PageHeader } from '@/components/ui/PageHeader'

const MAX_NAME_LENGTH = 80
const CONTROL_CHAR_RE = /[\u0000-\u001F\u007F]/

function Section({
  title,
  description,
  children,
  className = '',
}: {
  title: string
  description?: string
  children: ReactNode
  className?: string
}) {
  return (
    <section className={`rounded-[10px] border border-[var(--v2-border)] bg-white shadow-[var(--v2-shadow-card)] ${className}`}>
      <div className="rounded-t-[10px] border-b border-[var(--v2-border)] bg-[var(--v2-surface)] px-6 py-5">
        <h2 className="text-[13px] font-semibold uppercase tracking-widest text-[var(--v2-ink)]">{title}</h2>
        {description ? (
          <p className="mt-1 text-sm text-[var(--v2-ink-3)]">{description}</p>
        ) : null}
      </div>
      <div className="divide-y divide-[var(--v2-border)]">{children}</div>
    </section>
  )
}

function SettingRow({
  label,
  value,
  detail,
  action,
}: {
  label: string
  value?: ReactNode
  detail?: ReactNode
  action?: ReactNode
}) {
  return (
    <div className="flex flex-col gap-3 px-6 py-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="text-sm font-medium text-[var(--v2-ink)]">{label}</p>
        {detail ? (
          <div className="mt-1 text-sm text-[var(--v2-ink-3)]">{detail}</div>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-3">
        {value ? <div className="text-sm text-[var(--v2-ink-2)]">{value}</div> : null}
        {action}
      </div>
    </div>
  )
}

function StatusPill({
  children,
  tone = 'neutral',
}: {
  children: ReactNode
  tone?: 'neutral' | 'success' | 'brand' | 'warning'
}) {
  const classes = {
    neutral: 'bg-[var(--v2-surface)] text-[var(--v2-ink-2)] border-[var(--v2-border)]',
    success: 'bg-[var(--v2-success-soft)] text-[var(--v2-success)] border-[var(--v2-success)]/20',
    brand: 'bg-[var(--v2-brand-soft)] text-[var(--v2-brand)] border-[var(--v2-brand)]/20',
    warning: 'bg-[var(--v2-warning-soft)] text-[var(--v2-warning)] border-[var(--v2-warning)]/20',
  }

  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${classes[tone]}`}>
      {children}
    </span>
  )
}

function ComingSoonToggle({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3">
      <StatusPill>Coming soon</StatusPill>
      <button
        type="button"
        disabled
        aria-label={label}
        className="relative h-6 w-11 cursor-not-allowed rounded-full bg-[var(--v2-surface-2)] opacity-70"
      >
        <span className="absolute left-1 top-1 h-4 w-4 rounded-full bg-white shadow-sm" />
      </button>
    </div>
  )
}

function CopyAddressButton({ address }: { address: string }) {
  const [copied, setCopied] = useState(false)

  async function copyAddress() {
    try {
      await navigator.clipboard.writeText(address)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      /* ignore */
    }
  }

  return (
    <button
      type="button"
      onClick={() => void copyAddress()}
      className="text-xs font-medium text-[var(--v2-ink-3)] hover:text-[var(--v2-ink)]"
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  )
}

function OwnerRow({
  owner,
  type,
  onRename,
}: {
  owner: OwnerAlias
  type: 'Passkey' | 'Connected wallet' | 'Wallet'
  onRename: (ownerAddress: string, name: string) => Promise<void>
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(owner.name ?? '')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!editing) {
      setDraft(owner.name ?? '')
    }
  }, [editing, owner.name])

  async function saveAlias() {
    const normalized = validateOwnerName(draft)
    if (!normalized) {
      setError('Enter a name using 80 characters or fewer.')
      return
    }

    setSaving(true)
    setError('')
    try {
      await onRename(owner.owner_address, normalized)
      setEditing(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'We could not save this approver name.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="px-6 py-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
            {editing ? (
              <div className="w-full max-w-sm">
                <Input
                  value={draft}
                  onChange={(event) => {
                    setDraft(event.target.value)
                    setError('')
                  }}
                  aria-label={`Name for ${truncate(owner.owner_address)}`}
                  aria-invalid={Boolean(error)}
                />
                {error ? (
                  <p className="mt-1.5 text-xs text-[var(--v2-danger)]">{error}</p>
                ) : null}
              </div>
            ) : (
              <p className="text-sm font-medium text-[var(--v2-ink)]">
                {owner.name ?? truncate(owner.owner_address)}
              </p>
            )}
            <StatusPill tone={type === 'Wallet' ? 'neutral' : 'brand'}>{type}</StatusPill>
            {!editing && owner.accounts.map((account) => {
              const chain = getChainConfig(account.chain_id ?? DEFAULT_CHAIN_ID)
              return (
                <span
                  key={`${account.id}-${owner.owner_address}`}
                  className="rounded-md border border-[var(--v2-border)] bg-[var(--v2-surface)] px-2 py-0.5 text-xs text-[var(--v2-ink-2)]"
                >
                  {account.name} · {chain.name}
                </span>
              )
            })}
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
            {!editing && owner.name ? (
              <span className="font-mono text-xs text-[var(--v2-ink-3)]">
                {truncate(owner.owner_address)}
              </span>
            ) : null}
            <CopyAddressButton address={owner.owner_address} />
            <a
              href={getExplorerUrl(owner.accounts[0]?.chain_id ?? DEFAULT_CHAIN_ID, 'address', owner.owner_address)}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs font-medium text-[var(--v2-brand)] hover:text-[var(--v2-brand-strong)]"
            >
              View on explorer
            </a>
          </div>
        </div>
        {editing ? (
          <div className="flex shrink-0 items-center gap-2">
            <Button
              variant="tertiary"
              size="sm"
              disabled={saving}
              onClick={() => {
                setEditing(false)
                setDraft(owner.name ?? '')
                setError('')
              }}
            >
              Cancel
            </Button>
            <Button size="sm" disabled={saving} onClick={() => void saveAlias()}>
              {saving ? 'Saving...' : 'Save'}
            </Button>
          </div>
        ) : (
          <div className="flex shrink-0 items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
              {owner.name ? 'Edit' : 'Name'}
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}

function validateOwnerName(value: string): string | null {
  const normalized = value.trim().replace(/\s+/g, ' ')

  if (!normalized) return null
  if (normalized.length > MAX_NAME_LENGTH || CONTROL_CHAR_RE.test(value)) return null

  return normalized
}

export default function SettingsClient() {
  const { user, passkeys = [] } = useAuth()
  const {
    owners,
    loading: ownersLoading,
    error: ownersError,
    partialFailure: ownersPartialFailure,
    renameOwner,
  } = useOwnerDirectory()
  const { currency, setCurrency, saving } = usePreferences()

  const hasPasskey = passkeys.length > 0
  const passkeyAddresses = new Set(passkeys.map((passkey) => passkey.signer_address.toLowerCase()))
  const walletAddress = user?.wallet_address?.toLowerCase()

  return (
    <div className="max-w-4xl">
      <PageHeader
        title="Settings"
        subtitle="Manage preferences, account access, notifications, and data controls."
        actions={
          <Button href="/profile" variant="ghost">
            View profile
          </Button>
        }
      />

      <div className="space-y-6">
        <Section
          title="Preferences"
          description="Choose how Haven displays values and future alerts."
        >
          <SettingRow
            label="Preferred currency"
            detail="Used for balances, spending limits, and portfolio totals."
            action={(
              <div className="flex rounded-md border border-[var(--v2-border)] bg-[var(--v2-surface)] p-1">
                {(['USD', 'EUR'] as const).map((c) => (
                  <button
                    key={c}
                    onClick={() => setCurrency(c)}
                    disabled={saving}
                    className={`rounded px-3 py-1.5 text-sm font-medium transition-colors ${
                      currency === c
                        ? 'bg-white text-[var(--v2-ink)] shadow-sm'
                        : 'text-[var(--v2-ink-3)] hover:text-[var(--v2-ink)]'
                    } disabled:opacity-50`}
                  >
                    {c === 'USD' ? '$ USD' : '€ EUR'}
                  </button>
                ))}
              </div>
            )}
          />
          <SettingRow
            label="Approval alerts"
            detail="Get notified when a transaction needs approval."
            action={<ComingSoonToggle label="Approval alerts coming soon" />}
          />
          <SettingRow
            label="Agent spend alerts"
            detail="Receive updates when agents use their budget."
            action={<ComingSoonToggle label="Agent spend alerts coming soon" />}
          />
        </Section>

        <Section
          title="Access"
          description="How you sign in to Haven and approve actions on your accounts."
        >
          <SettingRow
            label="Passkey status"
            value={hasPasskey ? <StatusPill tone="success">Enrolled</StatusPill> : <StatusPill>No passkey</StatusPill>}
            detail={hasPasskey ? `${passkeys.length} passkey${passkeys.length !== 1 ? 's' : ''} registered for approving actions in Haven.` : 'Set up a passkey during onboarding for faster approvals.'}
          />
          <SettingRow
            label="Password"
            detail="Password changes are not available yet."
            action={<StatusPill>Coming soon</StatusPill>}
          />
        </Section>

        <Section
          title="Approvers"
          description="Wallets and passkeys that can approve actions on your linked Haven accounts."
        >
          {ownersLoading ? (
            <div className="px-6 py-4">
              <p className="text-sm text-[var(--v2-ink-3)]">Loading approvers...</p>
            </div>
          ) : owners.length > 0 ? (
            <>
              {ownersPartialFailure ? (
                <div className="px-6 py-3">
                  <div className="rounded-lg border border-[var(--v2-warning)]/25 bg-[var(--v2-warning-soft)] px-4 py-3 text-sm text-[var(--v2-ink-2)]">
                    Some approvers could not be refreshed. Showing the wallets and passkeys Haven could verify.
                  </div>
                </div>
              ) : null}
              {ownersError ? (
                <div className="px-6 py-3">
                  <div className="rounded-lg border border-[var(--v2-danger)]/25 bg-[var(--v2-danger-soft)] px-4 py-3 text-sm text-[var(--v2-danger)]">
                    {ownersError}
                  </div>
                </div>
              ) : null}
              {owners.map((owner) => {
                const normalizedOwner = owner.owner_address.toLowerCase()
                const type = passkeyAddresses.has(normalizedOwner)
                  ? 'Passkey'
                  : walletAddress === normalizedOwner
                    ? 'Connected wallet'
                    : 'Wallet'

                return (
                  <OwnerRow
                    key={owner.owner_address}
                    owner={owner}
                    type={type}
                    onRename={renameOwner}
                  />
                )
              })}
            </>
          ) : ownersError ? (
            <div className="px-6 py-3">
              <div className="rounded-lg border border-[var(--v2-danger)]/25 bg-[var(--v2-danger-soft)] px-4 py-3 text-sm text-[var(--v2-danger)]">
                {ownersError}
              </div>
            </div>
          ) : (
            <div className="px-6 py-4">
              <p className="text-sm text-[var(--v2-ink-3)]">
                Link a Haven account to review and name its approvers.
              </p>
            </div>
          )}
        </Section>

        <Section
          title="Recovery and safety"
          description="Know what Haven can and cannot recover."
        >
          <SettingRow
            label="Recovery limitations"
            detail="Haven can help you find account details, but it cannot bypass your wallets or passkeys or recover funds sent on the wrong network."
          />
          <SettingRow
            label="Backup approver"
            detail="Adding backup approvers is not available yet."
            action={<StatusPill>Coming soon</StatusPill>}
          />
          <SettingRow
            label="Active sessions"
            detail="Review signed-in devices and revoke sessions."
            action={<StatusPill>Coming soon</StatusPill>}
          />
        </Section>

        <Section
          title="Data and privacy"
          description="Controls for activity history and product preferences."
        >
          <SettingRow
            label="Export transactions"
            detail="Download a CSV of account and agent activity."
            action={<StatusPill>Coming soon</StatusPill>}
          />
          <SettingRow
            label="Privacy controls"
            detail="Manage analytics and product improvement preferences."
            action={<StatusPill>Coming soon</StatusPill>}
          />
        </Section>
      </div>
    </div>
  )
}
