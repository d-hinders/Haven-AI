'use client'

/**
 * Custody proof, RAIL-BRANCHED (#2106, epic #1440).
 *
 * The page's job is to show what actually constrains an agent. Until #2106 it
 * showed one rail's answer to every account. It now branches so delegation
 * budgets are shown as signed control, while legacy accounts remain readable
 * without presenting an actionable Haven spending surface.
 *
 * #2413: no rail marker is read here any more — the account list is
 * delegation-only, so every account this page renders is on the live rail.
 * Both rails live in the same `user.safes` list, so the branch is per ACCOUNT,
 * not per page — and there is no third state: an account is either on the
 * delegation rail or it is a legacy Safe.
 *
 * What each branch may claim, and what backs it:
 *
 *  - DELEGATION: signer set from `GET /accounts/hybrid/:address/signers`
 *    (`routes/hybrid-accounts.ts`), budgets from `GET /agents/:id/delegations`
 *    (`routes/agent-delegations.ts`). The caveats those delegations carry are
 *    built by `rails/delegation-policy.ts`: budget+period →
 *    ERC20PeriodTransferEnforcer, recipient pin → AllowedCalldataEnforcer,
 *    expiry → TimestampEnforcer, each pinned in `rails/delegation-contracts.ts`
 *    and enforced by the DelegationManager during redemption. The page shows
 *    the TERMS of the delegation the user signed and says so — it does not
 *    claim to have re-read them from the chain.
 *  - SAFE (legacy, retired rail): owners/threshold from
 *    `GET /safe/:address/details`, plus the read-only retirement notice.
 *
 * Two claims that were rail-blind and are now branched, because they are FALSE
 * on the delegation rail:
 *  - the Safe{Wallet} deep link and the "manage this Safe from any
 *    Safe-compatible app" line: a Hybrid DeleGator is not a Safe, and
 *    `app.safe.global` cannot open one. The delegation branch links its block
 *    explorer instead.
 *  - "Recipient is ⓘ not on-chain constrained today" and "Expand an agent's
 *    allowance without a Safe transaction you sign": on this rail the
 *    recipient pin IS a caveat enforcer, and authority is expanded by signing
 *    a new delegation, never a Safe transaction.
 */

import { ExternalLink } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { Table } from '@/components/ui/Table'
import { type ReactNode } from 'react'
import Link from 'next/link'
import { useUserSafes } from '@/hooks/useUserSafes'
import { useAgents, type Agent } from '@/hooks/useAgents'
import { useDelegationCustodyProof } from '@/hooks/useDelegationCustodyProof'
import { type DelegationBudget } from '@/hooks/useDelegationBudget'
import { type UserSafe } from '@/context/AuthContext'
// #2106: rail classification and the rail-correct claim list live in
// `lib/`, NOT here — Next type-checks a page MODULE and refuses arbitrary
// named exports from `page.tsx` (`next build` fails; `tsc --noEmit` does not).
import { havenCannotLines } from '@/lib/custody-rail'
import { getChainConfig, getExplorerUrl, getTokensForChain } from '@/lib/chains'
import { formatAllowanceForToken } from '@/lib/allowance-format'
import { budgetPeriodLabel } from '@/lib/budget-period'
import { truncate } from '@/lib/format'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { PageHeader } from '@/components/ui/PageHeader'
import { Skeleton } from '@/components/ui/Skeleton'

/** EIP-3770 short names Safe{Wallet} uses in its deep links. */
const SAFE_SHORT_NAME: Record<number, string> = { 100: 'gno', 8453: 'base', 84532: 'basesep' }

function safeWalletUrl(safe: UserSafe): string {
  const prefix = SAFE_SHORT_NAME[safe.chain_id] ?? ''
  return `https://app.safe.global/home?safe=${prefix}:${safe.safe_address}`
}

function OnChainBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-[var(--v2-success-soft)] px-2 py-0.5 text-xs font-medium text-[var(--v2-success)]">
      🔒 on-chain
    </span>
  )
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <p className="text-xs font-medium text-[var(--v2-ink-3)]">{label}</p>
      <div className="mt-0.5 text-sm text-[var(--v2-ink)]">{children}</div>
    </div>
  )
}

function tokenSymbol(address: string, chainId: number): string {
  const tokens = getTokensForChain(chainId)
  const match = Object.values(tokens).find(
    (t) => t.address && t.address.toLowerCase() === address.toLowerCase(),
  )
  return match?.symbol ?? 'token'
}

/** Card chrome shared by both rails — identity block plus one external link. */
function AccountCardHeader({
  safe,
  linkHref,
  linkLabel,
}: {
  safe: UserSafe
  linkHref?: string
  linkLabel?: ReactNode
}) {
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
      <div>
        <h2 className="v2-text-h3 text-[var(--v2-ink)]">{safe.name}</h2>
        <p className="mt-0.5 font-mono text-xs text-[var(--v2-ink-3)]">
          {truncate(safe.safe_address)} · {getChainConfig(safe.chain_id).name}
        </p>
      </div>
      {linkHref && linkLabel ? (
        <a
          href={linkHref}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex min-h-11 items-center gap-1 rounded-md text-sm font-medium text-[var(--v2-brand)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80 focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--v2-bg)]"
        >
          {linkLabel}
          <Icon icon={ExternalLink} className="h-3.5 w-3.5" />
        </a>
      ) : null}
    </div>
  )
}

// ── Delegation rail ─────────────────────────────────────────────────────────

function expiryLabel(expiresAt: number): string {
  if (!expiresAt) return 'no expiry set'
  return new Date(expiresAt * 1000).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

/**
 * Whether a delegation still constrains anything RIGHT NOW.
 *
 * `status` alone is not enough (#2106 review finding). Nothing in
 * `routes/agent-delegations.ts` flips a row's status on expiry — it only moves
 * pending → active → replaced/revoked — so a delegation whose TimestampEnforcer
 * window has closed still reads `'active'` in the database. The enforcer
 * rejects it on-chain, so presenting it as live spend control would be exactly
 * the kind of false claim this page exists to prevent.
 */
function isLiveBudget(budget: DelegationBudget, nowSec: number): boolean {
  if (budget.status !== 'active') return false
  return budget.expires_at === 0 || budget.expires_at > nowSec
}

function DelegationControlCard({ safe, agents }: { safe: UserSafe; agents: Agent[] }) {
  const safeAgents = agents.filter((a) => a.safe_id === safe.id)
  const { signers, signersLoading, budgetsByAgent, budgetsLoading, budgetsError, reloadBudgets } =
    useDelegationCustodyProof(safe.safe_address, safe.chain_id, safeAgents.map((a) => a.id))

  // Only ACTIVE delegations constrain anything — a pending one is not yet
  // signed onto the account, and a replaced/revoked one enforces nothing. An
  // expired-but-still-'active' row is KEPT and tagged rather than hidden: it
  // is real history the user may be looking for, and silently dropping a row
  // is its own kind of dishonesty.
  const nowSec = Math.floor(Date.now() / 1000)
  const rows = safeAgents.flatMap((agent) =>
    (budgetsByAgent.get(agent.id) ?? [])
      .filter((b) => b.status === 'active')
      .map((budget) => ({ agent, budget, live: isLiveBudget(budget, nowSec) })),
  )
  const liveRows = rows.filter((r) => r.live)

  const signerCount = signers ? signers.passkeys.length + (signers.owner_address ? 1 : 0) : 0

  return (
    <Card className="p-5" hover={false}>
      <AccountCardHeader
        safe={safe}
        linkHref={getExplorerUrl(safe.chain_id, 'address', safe.safe_address)}
        linkLabel="View on block explorer"
      />

      <div className="grid gap-4 sm:grid-cols-2">
        <Stat label="Signers (control this account — Haven is not one)">
          {signersLoading ? (
            <Skeleton variant="text" className="h-4 w-40" />
          ) : signers ? (
            <div className="space-y-1">
              {signers.owner_address ? (
                <p className="font-mono text-xs text-[var(--v2-ink-2)]">
                  {truncate(signers.owner_address)} · wallet
                </p>
              ) : null}
              {signers.passkeys.map((p, i) => (
                <p key={p.key_id} className="text-xs text-[var(--v2-ink-2)]">
                  Passkey {i + 1}
                </p>
              ))}
              <p className="text-xs text-[var(--v2-ink-3)]">
                {signerCount === 1
                  ? 'Any 1 of 1 signers can approve'
                  : `Any 1 of ${signerCount} signers can approve`}
              </p>
            </div>
          ) : (
            <span className="text-[var(--v2-ink-3)]">—</span>
          )}
        </Stat>

        <Stat label="Spend control">
          {budgetsLoading ? (
            <Skeleton variant="text" className="h-4 w-32" />
          ) : liveRows.length > 0 ? (
            <span className="inline-flex items-center gap-2">
              Signed budget delegation <OnChainBadge />
            </span>
          ) : budgetsError ? (
            // Never "no budget" on a failed read — that is a claim, and this
            // page must not make one it cannot back.
            <span className="text-[var(--v2-ink-3)]">—</span>
          ) : (
            <span className="text-[var(--v2-ink-3)]">No agent budget granted</span>
          )}
        </Stat>
      </div>

      <div className="mt-5">
        <p className="mb-2 text-xs font-medium text-[var(--v2-ink-3)]">
          Agent spend authority (enforced on-chain)
        </p>
        {budgetsLoading ? (
          <Skeleton variant="text" className="h-4 w-48" />
        ) : budgetsError && rows.length === 0 ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--v2-border)] bg-[var(--v2-surface)] px-4 py-3">
            <p className="text-sm text-[var(--v2-ink-2)]">
              Haven could not load this account&rsquo;s agent budgets. This is not a statement that
              none exist.
            </p>
            <Button size="sm" variant="ghost" onClick={() => void reloadBudgets()}>
              Try again
            </Button>
          </div>
        ) : rows.length === 0 ? (
          <p className="text-sm text-[var(--v2-ink-3)]">
            No agent budget granted on this account.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-[var(--v2-border)]">
            {/* Same dense admin shape as the legacy table below: it SCROLLS
                inside its `overflow-x-auto` wrapper rather than collapsing
                columns, because these rows carry no self-labelling content
                (#1999). No `revealAt` columns, so it queries nothing. */}
            {/* FOUR columns, not five, and Recipient before Expires — a
                design-review finding (#2106). At 390 this table scrolls
                inside its wrapper rather than collapsing (the #1999 dense
                admin shape), and with five columns the RECIPIENT PIN — the
                row-level proof unique to this rail, the thing the legacy
                table never carried — was the cell clipped off-screen by
                default. Token folded into the Budget cell ("250.00 USDC per
                week"), which reads better anyway and buys back the width. */}
            <Table className="text-sm">
              <Table.Head collapseWhenNarrow={false}>
                <tr>
                  <Table.HeaderCell align="left">Agent / delegation</Table.HeaderCell>
                  <Table.HeaderCell align="left">Budget</Table.HeaderCell>
                  <Table.HeaderCell align="left">Recipient</Table.HeaderCell>
                  <Table.HeaderCell align="left">Expires</Table.HeaderCell>
                </tr>
              </Table.Head>
              <Table.Body>
                {rows.map(({ agent, budget, live }) => (
                  <DelegationRow
                    key={budget.delegation_hash}
                    agentName={agent.name}
                    budget={budget}
                    chainId={safe.chain_id}
                    live={live}
                  />
                ))}
              </Table.Body>
            </Table>
          </div>
        )}
        {/* Trimmed on design review (#2106): the "Haven cannot widen them"
            sentence repeated the "What Haven cannot do" bullet verbatim in
            other words, and "caveat enforcers" is Delegation-Framework
            internals with no meaning to the reader. What SURVIVES the trim is
            the honesty caveat — these are the signed terms, not a fresh
            on-chain read — because that is the one sentence keeping the card
            from overclaiming. */}
        <p className="mt-2 text-xs text-[var(--v2-ink-3)]">
          Budget, period, expiry and any pinned recipient are <OnChainBadge /> enforced — a payment
          outside them reverts on-chain instead of waiting for anyone&rsquo;s approval. These are
          the terms of the delegation you signed. Stop an agent&rsquo;s budget on-chain from{' '}
          <Link href="/agents" className="text-[var(--v2-brand)] hover:underline">
            Agents
          </Link>
          .
        </p>
      </div>
    </Card>
  )
}

function DelegationRow({
  agentName,
  budget,
  chainId,
  live,
}: {
  agentName: string
  budget: DelegationBudget
  chainId: number
  live: boolean
}) {
  const sym = tokenSymbol(budget.token_address, chainId)
  return (
    <tr>
      <td className="px-4 py-3">
        <span className="text-[var(--v2-ink)]">{agentName}</span>
        <span className="ml-1 font-mono text-xs text-[var(--v2-ink-3)]">
          {truncate(budget.delegation_hash)}
        </span>
      </td>
      <td className="px-4 py-3 text-[var(--v2-ink-2)]">
        {formatAllowanceForToken(budget.budget_atomic, chainId, sym)} {sym}{' '}
        {budgetPeriodLabel(Math.round(budget.period_seconds / 60))}
      </td>
      <td className="px-4 py-3 text-[var(--v2-ink-2)]">
        {budget.recipient_address ? (
          <span className="inline-flex items-center gap-2">
            <span className="font-mono text-xs">{truncate(budget.recipient_address)}</span>
            <OnChainBadge />
          </span>
        ) : (
          <span className="text-[var(--v2-ink-3)]">Any recipient</span>
        )}
      </td>
      <td className="px-4 py-3 text-[var(--v2-ink-2)]">
        {expiryLabel(budget.expires_at)}
        {live ? null : (
          <span className="ml-2 rounded-full bg-[var(--v2-surface-2)] px-2 py-0.5 text-xs font-medium text-[var(--v2-ink-3)]">
            expired
          </span>
        )}
      </td>
    </tr>
  )
}

// ── "What Haven cannot do" ──────────────────────────────────────────────────

export default function CustodyPage() {
  const { safes, loading: safesLoading } = useUserSafes()
  const { agents } = useAgents()

  return (
    <div className="max-w-5xl">
      <PageHeader
        title="Custody"
        subtitle="Proof that you — not Haven — control your funds. Your agents’ limits are enforced on-chain by your account, not by Haven’s database."
      />

      <Card className="mb-5 p-5" elevation="anchor" hover={false}>
        <p className="mb-2 text-sm font-medium text-[var(--v2-ink)]">What Haven cannot do</p>
        <ul className="space-y-1.5">
          {havenCannotLines().map((line) => (
            <li key={line} className="flex gap-2 text-sm text-[var(--v2-ink-2)]">
              <span className="text-[var(--v2-success)]">✓</span>
              <span>{line}</span>
            </li>
          ))}
        </ul>
      </Card>

      {safesLoading ? (
        <Skeleton variant="text" className="h-5 w-56" />
      ) : safes.length === 0 ? (
        <p className="text-sm text-[var(--v2-ink-3)]">No accounts linked yet.</p>
      ) : (
        <div className="space-y-5">
          {/* #2413: only delegation accounts reach this page — the account
              list queries filter the retired rail out — so there is no rail
              branch left to make. */}
          {safes.map((safe) => (
            <DelegationControlCard key={safe.id} safe={safe} agents={agents} />
          ))}
        </div>
      )}
    </div>
  )
}
