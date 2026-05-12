'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useState, type ReactNode } from 'react'
import { useAuth, type UserSafe } from '@/context/AuthContext'
import { useOwnerDirectory } from '@/context/OwnerDirectoryContext'
import { usePreferences } from '@/hooks/usePreferences'
import { api, ApiRequestError, type OwnerAlias } from '@/lib/api'
import { displayName } from '@/lib/user'
import { getChainConfig, getExplorerUrl } from '@/lib/chains'
import { truncate } from '@/lib/format'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'

const MAX_NAME_LENGTH = 80
const CONTROL_CHAR_RE = /[\u0000-\u001F\u007F]/

function formatDate(value?: string): string {
  if (!value) return 'Not available'
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(new Date(value))
}

function Section({
  title,
  description,
  children,
}: {
  title: string
  description?: string
  children: ReactNode
}) {
  return (
    <section className="rounded-[10px] border border-[var(--v2-border)] bg-white shadow-[var(--v2-shadow-card)]">
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
  onClear,
}: {
  owner: OwnerAlias
  type: 'Passkey' | 'Connected wallet' | 'Wallet'
  onRename: (ownerAddress: string, name: string) => Promise<void>
  onClear: (ownerAddress: string) => Promise<void>
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

  async function clearAlias() {
    setSaving(true)
    setError('')
    try {
      await onClear(owner.owner_address)
      setEditing(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'We could not clear this approver name.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="rounded-lg border border-[var(--v2-border)] bg-[var(--v2-surface)] px-4 py-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
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
          </div>
          {!editing && owner.name ? (
            <p className="mt-1 font-mono text-xs text-[var(--v2-ink-3)]">
              {truncate(owner.owner_address)}
            </p>
          ) : null}
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <CopyAddressButton address={owner.owner_address} />
            <a
              href={getExplorerUrl(owner.accounts[0]?.chain_id ?? 100, 'address', owner.owner_address)}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs font-medium text-[var(--v2-brand)] hover:text-[var(--v2-brand-strong)]"
            >
              View on explorer
            </a>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {owner.accounts.map((account) => {
              const chain = getChainConfig(account.chain_id ?? 100)
              return (
                <span
                  key={`${account.id}-${owner.owner_address}`}
                  className="rounded-md border border-[var(--v2-border)] bg-white px-2 py-1 text-xs text-[var(--v2-ink-3)]"
                >
                  {account.name} · {chain.name}
                </span>
              )
            })}
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
            {owner.name ? (
              <Button variant="tertiary" size="sm" disabled={saving} onClick={() => void clearAlias()}>
                Clear
              </Button>
            ) : null}
            <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
              {owner.name ? 'Edit' : 'Name'}
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}

function SafeLink({ safe }: { safe: UserSafe }) {
  const chain = getChainConfig(safe.chain_id ?? 100)

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-[var(--v2-border)] bg-[var(--v2-surface)] px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <Link
            href={`/accounts/${safe.id}`}
            className="text-sm font-medium text-[var(--v2-ink)] hover:text-[var(--v2-brand)]"
          >
            {safe.name}
          </Link>
        </div>
        <p className="mt-1 text-xs text-[var(--v2-ink-3)]">
          {chain.name} · <span className="font-mono">{truncate(safe.safe_address)}</span>
        </p>
        <p className="mt-1 text-xs text-[var(--v2-ink-3)]">
          Added {formatDate(safe.created_at)}
        </p>
      </div>
      <a
        href={getExplorerUrl(safe.chain_id ?? 100, 'address', safe.safe_address)}
        target="_blank"
        rel="noopener noreferrer"
        className="text-xs font-medium text-[var(--v2-brand)] hover:text-[var(--v2-brand-strong)]"
      >
        View on explorer
      </a>
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
  const router = useRouter()
  const { user, passkeys = [], logout, updateUser } = useAuth()
  const {
    owners,
    loading: ownersLoading,
    error: ownersError,
    partialFailure: ownersPartialFailure,
    renameOwner,
    clearOwner,
  } = useOwnerDirectory()
  const { currency, setCurrency, saving } = usePreferences()
  const [editingName, setEditingName] = useState(false)
  const [nameDraft, setNameDraft] = useState('')
  const [nameError, setNameError] = useState('')
  const [nameSaved, setNameSaved] = useState(false)
  const [savingName, setSavingName] = useState(false)

  const hasWallet = Boolean(user?.wallet_address)
  const hasPasskey = passkeys.length > 0
  const passkeyAddresses = new Set(passkeys.map((passkey) => passkey.signer_address.toLowerCase()))
  const walletAddress = user?.wallet_address?.toLowerCase()
  const linkedAccounts = user?.safes ?? []
  const accountsWithVerifiedApprovalMethods = new Set(
    owners.flatMap((owner) => owner.accounts.map((account) => account.id)),
  )
  const verifiedAccountCount = linkedAccounts.filter((safe) => accountsWithVerifiedApprovalMethods.has(safe.id)).length
  const approvalAccessStatus = ownersLoading
    ? { label: 'Checking', tone: 'neutral' as const }
    : ownersError || ownersPartialFailure
      ? { label: 'Needs review', tone: 'warning' as const }
      : linkedAccounts.length === 0
        ? { label: 'No accounts', tone: 'neutral' as const }
        : verifiedAccountCount === linkedAccounts.length
          ? { label: 'Listed', tone: 'success' as const }
          : { label: 'Needs review', tone: 'warning' as const }
  const approvalAccessDetail = ownersLoading
    ? 'Checking approvers for your linked Haven accounts.'
    : ownersError || ownersPartialFailure
      ? 'Some approvers could not be verified. Review the approvers section below.'
      : linkedAccounts.length === 0
        ? 'Create or import a Haven account before relying on Haven for payments.'
        : verifiedAccountCount === linkedAccounts.length
          ? 'Haven listed approvers for your linked accounts. Keep access to every wallet or passkey needed to approve payments.'
          : 'Review approvers before relying on these accounts for payments.'

  useEffect(() => {
    if (!editingName) {
      setNameDraft(user?.name ?? '')
    }
  }, [editingName, user?.name])

  function validateName(value: string): string | null {
    const normalized = value.trim().replace(/\s+/g, ' ')

    if (!normalized) return null
    if (normalized.length > MAX_NAME_LENGTH || CONTROL_CHAR_RE.test(value)) return null

    return normalized
  }

  function handleLogout() {
    logout()
    router.push('/login')
  }

  async function saveName() {
    const normalizedName = validateName(nameDraft)
    setNameSaved(false)

    if (!normalizedName) {
      setNameError('Enter a name using 80 characters or fewer.')
      return
    }

    setSavingName(true)
    setNameError('')
    try {
      const updated = await api.put<{ name: string }>('/user/profile', { name: normalizedName })
      updateUser({ name: updated.name })
      setEditingName(false)
      setNameSaved(true)
    } catch (err) {
      if (err instanceof ApiRequestError) {
        setNameError(err.message)
      } else {
        setNameError('We could not save your name. Please try again.')
      }
    } finally {
      setSavingName(false)
    }
  }

  return (
    <div className="max-w-5xl">
      <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight mb-1">Settings</h1>
          <p className="text-sm text-[var(--v2-ink-3)]">
            Manage your profile, sign-in methods, approvers, and recovery context.
          </p>
        </div>
        <Button variant="ghost" onClick={handleLogout}>
          Sign out
        </Button>
      </div>

      <div className="grid gap-6">
        <Section
          title="Profile"
          description="Basic information for your Haven account."
        >
          <div className="px-6 py-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-[var(--v2-ink)]">Name</p>
                {editingName ? (
                  <div className="mt-2 max-w-sm">
                    <Input
                      value={nameDraft}
                      onChange={(e) => {
                        setNameDraft(e.target.value)
                        setNameError('')
                        setNameSaved(false)
                      }}
                      autoComplete="name"
                      aria-label="Name"
                      aria-invalid={Boolean(nameError)}
                      aria-describedby={nameError ? 'settings-name-error' : undefined}
                    />
                    {nameError ? (
                      <p id="settings-name-error" className="mt-1.5 text-xs text-[var(--v2-danger)]">
                        {nameError}
                      </p>
                    ) : null}
                  </div>
                ) : (
                  <>
                    <p className="mt-1 text-sm text-[var(--v2-ink-2)]">{displayName(user)}</p>
                    {nameSaved ? (
                      <p className="mt-1 text-xs text-[var(--v2-success)]">Name updated.</p>
                    ) : null}
                  </>
                )}
              </div>
              {editingName ? (
                <div className="flex shrink-0 items-center gap-2">
                  <Button
                    variant="tertiary"
                    size="sm"
                    disabled={savingName}
                    onClick={() => {
                      setEditingName(false)
                      setNameDraft(user?.name ?? '')
                      setNameError('')
                    }}
                  >
                    Cancel
                  </Button>
                  <Button size="sm" disabled={savingName} onClick={() => void saveName()}>
                    {savingName ? 'Saving...' : 'Save'}
                  </Button>
                </div>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setEditingName(true)
                    setNameSaved(false)
                  }}
                >
                  Edit
                </Button>
              )}
            </div>
          </div>
          <SettingRow
            label="Email"
            value={user?.email ?? 'Not available'}
            detail="Used for sign-in and account recovery support."
          />
          <SettingRow
            label="Account created"
            value={formatDate(user?.created_at)}
          />
        </Section>

        <Section
          title="Preferences"
          description="Personalize how values and updates appear across Haven."
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
            label="Default landing page"
            detail="Choose where Haven opens after sign-in."
            action={<ComingSoonToggle label="Default landing page coming soon" />}
          />
        </Section>

        <Section
          title="Sign-in and approvals"
          description="Review how you sign in and how account actions are approved."
        >
          <SettingRow
            label="Connected wallet"
            value={hasWallet ? truncate(user!.wallet_address!) : 'Passkey-managed account'}
            detail={hasWallet ? 'This wallet can approve actions for accounts it controls.' : 'This account uses passkeys for approvals when available.'}
          />
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
          <SettingRow
            label="Active sessions"
            detail="Review signed-in devices and revoke sessions."
            action={<StatusPill>Coming soon</StatusPill>}
          />
        </Section>

        <Section
          title="Recovery and safety"
          description="Understand what to keep available before you rely on a Haven account for payments."
        >
          <SettingRow
            label="Approver access"
            detail={approvalAccessDetail}
            value={<StatusPill tone={approvalAccessStatus.tone}>{approvalAccessStatus.label}</StatusPill>}
          />
          <SettingRow
            label="Recovery limitations"
            detail="Haven can help you find account details, but it cannot bypass your wallets or passkeys or recover funds sent on the wrong network."
          />
          <SettingRow
            label="Backup approver"
            detail="Adding backup approvers is not available yet."
            action={<StatusPill>Coming soon</StatusPill>}
          />
        </Section>

        <Section
          title="Approvers"
          description="Name the wallets and passkeys that approve actions for your linked Haven accounts."
        >
          <div className="px-6 py-4">
            {ownersLoading ? (
              <p className="text-sm text-[var(--v2-ink-3)]">Loading approvers...</p>
            ) : owners.length > 0 ? (
              <div className="space-y-3">
                {ownersPartialFailure ? (
                  <div className="rounded-lg border border-[var(--v2-warning)]/25 bg-[var(--v2-warning-soft)] px-4 py-3 text-sm text-[var(--v2-ink-2)]">
                    Some approvers could not be refreshed. Showing the wallets and passkeys Haven could verify.
                  </div>
                ) : null}
                {ownersError ? (
                  <div className="rounded-lg border border-[var(--v2-danger)]/25 bg-[var(--v2-danger-soft)] px-4 py-3 text-sm text-[var(--v2-danger)]">
                    {ownersError}
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
                      onClear={clearOwner}
                    />
                  )
                })}
              </div>
            ) : ownersError ? (
              <div className="rounded-lg border border-[var(--v2-danger)]/25 bg-[var(--v2-danger-soft)] px-4 py-3 text-sm text-[var(--v2-danger)]">
                {ownersError}
              </div>
            ) : (
              <p className="text-sm text-[var(--v2-ink-3)]">
                Link a Haven account to review and name its approvers.
              </p>
            )}
          </div>
        </Section>

        <Section
          title="Accounts & networks"
          description="Your Haven accounts and the networks they use."
        >
          <div className="px-6 py-4">
            {user?.safes?.length ? (
              <div className="space-y-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="text-sm font-medium text-[var(--v2-ink)]">
                      {user.safes.length} linked account{user.safes.length !== 1 ? 's' : ''}
                    </p>
                    <p className="mt-1 text-sm text-[var(--v2-ink-3)]">
                      Each account can hold funds and be linked to agents independently.
                    </p>
                  </div>
                  <Button href="/accounts" variant="ghost" size="sm">Manage accounts</Button>
                </div>
                <div className="grid gap-3">
                  {user.safes.map((safe) => (
                    <SafeLink key={safe.id} safe={safe} />
                  ))}
                </div>
              </div>
            ) : (
              <div className="rounded-lg border border-dashed border-[var(--v2-border-strong)] bg-[var(--v2-surface)] px-4 py-6 text-center">
                <p className="text-sm font-medium text-[var(--v2-ink)]">No accounts yet</p>
                <p className="mt-1 text-sm text-[var(--v2-ink-3)]">Create or import an account to start using Haven.</p>
                <Button href="/accounts" size="sm" className="mt-4">
                  Add account
                </Button>
              </div>
            )}
          </div>
        </Section>

        <Section
          title="Notifications"
          description="Choose what Haven should alert you about."
        >
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
          <SettingRow
            label="Failed transaction alerts"
            detail="Know when an on-chain transaction fails or expires."
            action={<ComingSoonToggle label="Failed transaction alerts coming soon" />}
          />
        </Section>

        <Section
          title="Data & privacy"
          description="Export and privacy controls for your Haven activity."
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
