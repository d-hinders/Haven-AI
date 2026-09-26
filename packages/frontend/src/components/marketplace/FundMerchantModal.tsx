'use client'

/**
 * "Fund this merchant" — a merchant-locked budget from a marketplace merchant
 * page (#3331, epic #3328).
 *
 * An ordinary recipient-pinned budget whose recipient is the merchant's own
 * verified payTo: pick an agent, an amount and a period, review, then ONE
 * passkey (or owner) signature — the SAME build → sign → activate composition
 * `useDelegationBudget`'s `grant()` already runs for an open budget, extended
 * with `merchantSlug` so the server derives the recipient itself. Nothing here
 * forks that signing logic.
 *
 * Copy follows the budget-review recipe (`screen-recipes.md`) and
 * `EditBudgetModal`'s established shape (`components/EditBudgetModal.tsx`):
 * who can spend, from which Haven wallet, how much, on whom, and how the
 * owner can stop it. Outcome language only — "delegation", "caveat",
 * "recipient pin" and "ERC-7710" never appear.
 */

import { Check, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { parseUnits, formatUnits } from 'viem'
import type { Address } from 'viem'
import { useDelegationBudget, type BudgetResult, type GrantInput } from '@/hooks/useDelegationBudget'
import type { Agent } from '@/hooks/useAgents'
import type { CatalogEntry, Merchant, MerchantFundingTarget } from '@/hooks/useCatalog'
import { getChainConfig } from '@/lib/chains'
import { needsUnpinnedBudget, networkToChainId } from '@/lib/marketplace'
import { truncateAddress } from '@/components/haven'
import { Icon } from '@/components/ui/Icon'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { useFocusTrap } from '@/hooks/useFocusTrap'
import { useEscapeToClose } from '@/hooks/useEscapeToClose'

interface TokenOption {
  address: string
  symbol: string
  decimals: number
}

type Step = 'select' | 'review' | 'working' | 'done' | 'error'

const PERIODS: Array<{ label: string; seconds: number }> = [
  { label: 'per day', seconds: 86_400 },
  { label: 'per week', seconds: 604_800 },
  { label: 'per month', seconds: 2_592_000 },
]

function periodLabel(seconds: number): string {
  return PERIODS.find((p) => p.seconds === seconds)?.label ?? `every ${seconds}s`
}

/**
 * Agents this action can offer (#3331 acceptance): delegation-rail agents
 * (an `account_chain_id`, so a budget is even possible) whose chain carries a
 * funding entry the merchant can be pinned to — a `verified` payTo, every
 * offer there ERC-7710. Exported for the merchant page, which needs the same
 * predicate to decide whether to render the action at all.
 */
export function eligibleFundingAgents(agents: Agent[], funding: MerchantFundingTarget[]): Agent[] {
  return agents.filter((agent) => {
    if (agent.status === 'revoked' || agent.archived_at) return false
    if (agent.account_chain_id == null) return false
    const target = funding.find((f) => f.chain_id === agent.account_chain_id)
    return !!target && target.pay_to_status === 'verified' && target.erc7710
  })
}

/**
 * The token options this merchant actually sells in, on one chain, restricted
 * to offers that advertise ERC-7710 — a pinned budget cannot fund an
 * EIP-3009-only offer (`docs/product/marketplace.md` "Merchant-locked
 * budgets"). Resolved through the chain registry so the address and decimals
 * are never guessed; an asset the registry does not know is left out rather
 * than offered unsized.
 */
export function merchantTokenOptions(chainId: number, offers: CatalogEntry[]): TokenOption[] {
  const symbols = new Set<string>()
  for (const offer of offers) {
    if (networkToChainId(offer.network) !== chainId) continue
    if (needsUnpinnedBudget(offer.asset_transfer_methods)) continue
    if (offer.asset) symbols.add(offer.asset)
  }
  const chainCfg = (() => {
    try {
      return getChainConfig(chainId)
    } catch {
      return null
    }
  })()
  if (!chainCfg) return []
  const options: TokenOption[] = []
  for (const symbol of symbols) {
    const token = chainCfg.tokens[symbol]
    if (token?.address) options.push({ address: token.address, symbol: token.symbol, decimals: token.decimals })
  }
  return options
}

/** Friendly copy for the merchant-locked build's named 409s (#3331). */
function refusalCopy(detail: string | undefined, merchantName: string): string {
  const d = detail ?? ''
  if (/no verified payTo/i.test(d)) {
    return `${merchantName} does not have a confirmed payment address on this network yet. Reload the page and try again shortly.`
  }
  if (/does not accept ERC-7710/i.test(d) || /not.*erc-7710/i.test(d)) {
    return `${merchantName}'s payments here now go through its open budget instead — a merchant-locked budget is no longer offered.`
  }
  if (/agent's own addresses/i.test(d)) {
    return `${merchantName}'s payment address is this agent's own wallet — Haven cannot pin a budget to it.`
  }
  if (/does not match the merchant's current verified payTo/i.test(d)) {
    return `${merchantName}'s payment address changed. Reload the page to see the current one.`
  }
  return d || `Haven could not set up this budget.`
}

interface Props {
  open: boolean
  onClose: () => void
  merchant: Merchant
  funding: MerchantFundingTarget[]
  offers: CatalogEntry[]
  agents: Agent[]
  onGranted?: () => void
}

export default function FundMerchantModal({ open, onClose, merchant, funding, offers, agents, onGranted }: Props) {
  const panelRef = useRef<HTMLDivElement>(null)
  useFocusTrap(panelRef, open)

  const eligibleAgents = useMemo(() => eligibleFundingAgents(agents, funding), [agents, funding])

  const [step, setStep] = useState<Step>('select')
  const [agentId, setAgentId] = useState('')
  const [tokenAddress, setTokenAddress] = useState('')
  const [amount, setAmount] = useState('')
  const [period, setPeriod] = useState(2_592_000)
  const [outcome, setOutcome] = useState<BudgetResult | null>(null)

  useEffect(() => {
    if (!open) return
    setStep('select')
    setOutcome(null)
    setAgentId(eligibleAgents[0]?.id ?? '')
    setAmount('')
    setPeriod(2_592_000)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset only on open
  }, [open])

  const selectedAgent = eligibleAgents.find((a) => a.id === agentId) ?? null
  const chainId = selectedAgent?.account_chain_id ?? null
  const fundingTarget = chainId != null ? funding.find((f) => f.chain_id === chainId) ?? null : null
  const payTo = fundingTarget?.pay_to ?? null

  const tokenOptions = useMemo(
    () => (chainId != null ? merchantTokenOptions(chainId, offers) : []),
    [chainId, offers],
  )

  useEffect(() => {
    if (!open) return
    if (tokenOptions.length === 0) {
      setTokenAddress('')
      return
    }
    if (!tokenOptions.some((t) => t.address.toLowerCase() === tokenAddress.toLowerCase())) {
      setTokenAddress(tokenOptions[0]!.address)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-derive when the option set itself changes
  }, [open, tokenOptions])

  const token = tokenOptions.find((t) => t.address.toLowerCase() === tokenAddress.toLowerCase()) ?? null

  // The selected agent's own delegation-rail budgets — read only once an
  // agent is chosen, so the "replaces" warning (#3331 acceptance) can compare
  // against its ACTIVE rows. Also what signs the grant.
  const { budgets, grant, busy, ready } = useDelegationBudget(selectedAgent?.id ?? '', chainId ?? 0, {
    enabled: open && !!selectedAgent,
  })

  const replacesPlainBudget = useMemo(() => {
    if (!payTo || !token) return false
    return (budgets ?? []).some(
      (b) =>
        b.status === 'active' &&
        !b.merchant_id &&
        (b.recipient_address ?? '').toLowerCase() === payTo.toLowerCase() &&
        b.token_address.toLowerCase() === token.address.toLowerCase(),
    )
  }, [budgets, payTo, token])

  // Replacement is per (agent, token, recipient) slot, not per merchant: a
  // budget for this merchant in another token, or one still pinned to a
  // rotated-away payTo (`stale`), sits in a different slot and survives.
  const replacesMerchantBudget = useMemo(() => {
    if (!payTo || !token) return false
    return (budgets ?? []).some(
      (b) =>
        b.status === 'active' &&
        b.merchant_id === merchant.id &&
        (b.recipient_address ?? '').toLowerCase() === payTo.toLowerCase() &&
        b.token_address.toLowerCase() === token.address.toLowerCase(),
    )
  }, [budgets, merchant.id, payTo, token])

  const amountValid = amount.trim() !== '' && Number(amount) > 0

  const input = useMemo<GrantInput | null>(() => {
    if (!token || !selectedAgent || !amountValid) return null
    let budgetAtomic: string
    try {
      budgetAtomic = parseUnits(amount, token.decimals).toString()
    } catch {
      return null
    }
    return {
      tokenAddress: token.address as Address,
      // The server derives the recipient from the merchant's verified payTo —
      // never sent here (a sent one that disagreed would be a 409).
      recipientAddress: null,
      budgetAtomic,
      periodSeconds: period,
      merchantSlug: merchant.slug,
    }
  }, [amount, amountValid, merchant.slug, period, selectedAgent, token])

  const handleClose = useCallback(() => {
    if (busy) return
    onClose()
  }, [busy, onClose])

  useEscapeToClose(open, handleClose, { enabled: !busy })

  const run = useCallback(async () => {
    if (!input) return
    setStep('working')
    const result = await grant(input)
    setOutcome(result)
    if (result.ok) {
      setStep('done')
      onGranted?.()
    } else if (result.reason === 'cancelled') {
      setStep('review')
    } else {
      setStep('error')
    }
  }, [grant, input, onGranted])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-[var(--v2-z-modal)] flex items-center justify-center v2-safe-overlay [--v2-safe-gutter:1rem] v2-modal-backdrop">
      <div className="absolute inset-0" onClick={busy ? undefined : handleClose} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Fund this merchant"
        data-testid="fund-merchant-modal"
        className="relative max-h-[calc(90vh-var(--v2-safe-top)-var(--v2-safe-bottom))] w-full max-w-lg overflow-y-auto rounded-2xl border border-[var(--v2-border)] bg-[var(--v2-bg)] shadow-modal"
      >
        <div className="flex items-center justify-between border-b border-[var(--v2-border)] px-6 py-5">
          <div>
            <h2 className="text-lg font-semibold text-[var(--v2-ink)]">Fund {merchant.name}</h2>
            <p className="mt-0.5 text-xs text-[var(--v2-ink-3)]">
              Give an agent a budget that pays only {merchant.name}. Nothing changes until you sign.
            </p>
          </div>
          <button
            type="button"
            onClick={handleClose}
            disabled={busy}
            aria-label="Close"
            className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md text-[var(--v2-ink-3)] transition-colors hover:bg-[var(--v2-surface-2)] hover:text-[var(--v2-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80 disabled:opacity-50"
          >
            <Icon icon={X} className="h-4 w-4" />
          </button>
        </div>

        <div className="p-6">
          {step === 'select' && (
            <div className="space-y-5">
              {eligibleAgents.length === 0 ? (
                <p className="text-sm text-[var(--v2-ink-2)]">
                  No connected agent can be pinned to {merchant.name} yet — connect an agent on a network
                  {merchant.name} accepts, or check the merchant's networks above.
                </p>
              ) : (
                <>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-[var(--v2-ink-3)]" htmlFor="fund-merchant-agent">
                      Agent
                    </label>
                    <Select
                      id="fund-merchant-agent"
                      value={agentId}
                      onChange={(e) => setAgentId(e.target.value)}
                      aria-label="Agent"
                    >
                      {eligibleAgents.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name}
                        </option>
                      ))}
                    </Select>
                  </div>

                  {tokenOptions.length === 0 ? (
                    <p className="text-sm text-[var(--v2-ink-2)]">
                      {merchant.name} does not sell in a token Haven can budget on this agent's network.
                    </p>
                  ) : (
                    <>
                      <div className="flex flex-col gap-2 sm:flex-row">
                        <Input
                          value={amount}
                          onChange={(e) => setAmount(e.target.value)}
                          placeholder="Amount"
                          className="sm:w-32"
                          aria-label="Budget amount"
                        />
                        {tokenOptions.length > 1 ? (
                          <Select
                            value={tokenAddress}
                            onChange={(e) => setTokenAddress(e.target.value)}
                            aria-label="Token"
                            className="sm:w-28"
                          >
                            {tokenOptions.map((t) => (
                              <option key={t.address} value={t.address}>
                                {t.symbol}
                              </option>
                            ))}
                          </Select>
                        ) : (
                          <span className="self-center text-sm text-[var(--v2-ink-muted)]">{token?.symbol}</span>
                        )}
                        <Select
                          value={String(period)}
                          onChange={(e) => setPeriod(Number(e.target.value))}
                          aria-label="Period"
                          className="sm:w-36"
                        >
                          {PERIODS.map((p) => (
                            <option key={p.seconds} value={p.seconds}>
                              {p.label}
                            </option>
                          ))}
                        </Select>
                      </div>
                      <p className="text-xs leading-relaxed text-[var(--v2-ink-2)]">
                        Pays only {merchant.name}
                        {payTo ? ` (${truncateAddress(payTo)})` : ''} — this budget is preferred for that merchant.
                        The agent's open budget, if it has one, still covers everything else.
                      </p>
                      {!amountValid && (
                        <p className="text-xs text-[var(--v2-ink-3)]">Enter an amount above zero to continue.</p>
                      )}
                    </>
                  )}
                </>
              )}
              <div className="flex gap-3">
                <Button variant="ghost" onClick={handleClose} className="flex-1" disabled={busy}>
                  Cancel
                </Button>
                <Button onClick={() => setStep('review')} disabled={!input} className="flex-1">
                  Review
                </Button>
              </div>
            </div>
          )}

          {step === 'review' && input && selectedAgent && token && (
            <div className="space-y-5">
              <div className="space-y-3 rounded-xl border border-[var(--v2-border)] bg-[var(--v2-surface)] p-4">
                <div>
                  <p className="mb-1 text-xs font-medium text-[var(--v2-ink-3)]">Agent</p>
                  <p className="text-sm text-[var(--v2-ink)]">{selectedAgent.name}</p>
                </div>
                <div>
                  <p className="mb-1 text-xs font-medium text-[var(--v2-ink-3)]">Budget</p>
                  <p className="text-sm font-medium text-[var(--v2-ink)]">
                    {amount} {token.symbol} {periodLabel(period)}
                  </p>
                </div>
                <div>
                  <p className="mb-1 text-xs font-medium text-[var(--v2-ink-3)]">Pays</p>
                  <p className="text-sm text-[var(--v2-ink)]">
                    {merchant.name} only{payTo ? ` · ${truncateAddress(payTo)}` : ''}
                  </p>
                </div>
                <p className="text-xs leading-relaxed text-[var(--v2-ink-2)]">
                  This budget is preferred for payments to {merchant.name}; the agent's open budget still covers
                  everything else. Payments above it are refused on-chain — they are not held for approval.
                </p>
              </div>

              {(replacesPlainBudget || replacesMerchantBudget) && (
                <div className="space-y-1 rounded-xl border border-warning/30 bg-[var(--v2-warning-soft)] p-4 text-xs leading-relaxed text-[var(--v2-ink)]">
                  <p className="font-medium">
                    {replacesMerchantBudget
                      ? `This replaces this agent's current budget for ${merchant.name}.`
                      : `This replaces this agent's current budget to the same address.`}
                  </p>
                  <p>
                    {selectedAgent.name} already has an active budget in the same slot — signing below activates the
                    new one in its place.
                  </p>
                </div>
              )}

              <div className="flex gap-3">
                <Button variant="ghost" onClick={() => setStep('select')} className="flex-1" disabled={busy}>
                  Back
                </Button>
                <Button onClick={() => void run()} disabled={busy || !ready} className="flex-1">
                  Sign budget
                </Button>
              </div>
              {!ready && (
                <p className="text-xs text-[var(--v2-ink-3)]">
                  Connect the wallet or passkey that approves actions for this agent's Haven wallet.
                </p>
              )}
            </div>
          )}

          {step === 'working' && (
            <div className="space-y-4 py-8 text-center">
              <div className="mx-auto h-10 w-10 animate-spin rounded-full border-2 border-[var(--v2-brand)] border-t-transparent" />
              <p className="text-sm font-medium text-[var(--v2-ink)]">Waiting for your signature…</p>
              <p className="mx-auto max-w-xs text-xs text-[var(--v2-ink-3)]">
                Approve with Face ID, Touch ID, or your device passkey. The budget is set only after you sign.
              </p>
            </div>
          )}

          {step === 'done' && (
            <div className="space-y-5">
              <div className="py-4 text-center">
                <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-[var(--v2-success-soft)]">
                  <Icon icon={Check} className="h-6 w-6 text-[var(--v2-success)]" />
                </div>
                <p className="text-sm font-medium text-[var(--v2-ink)]">Budget set</p>
                <p className="mt-1 text-xs text-[var(--v2-ink-3)]">
                  {selectedAgent?.name} can now pay {merchant.name}, within this budget.
                </p>
              </div>
              <Button variant="ghost" onClick={handleClose} className="w-full">
                Done
              </Button>
            </div>
          )}

          {step === 'error' && outcome && !outcome.ok && (
            <div className="space-y-5">
              <div className="space-y-3 py-2 text-center">
                <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-[var(--v2-danger-soft)]">
                  <Icon icon={X} className="h-5 w-5 text-[var(--v2-danger)]" />
                </div>
                {outcome.reason === 'refused' ? (
                  <>
                    <p className="text-sm font-medium text-[var(--v2-ink)]">The budget could not be set</p>
                    <p className="mx-auto max-w-xs text-xs leading-relaxed text-[var(--v2-ink-3)]">
                      {refusalCopy(outcome.detail, merchant.name)}
                    </p>
                  </>
                ) : (
                  <>
                    <p className="text-sm font-medium text-[var(--v2-ink)]">Budget could not be set</p>
                    <p className="mx-auto max-w-xs text-xs leading-relaxed text-[var(--v2-ink-3)]">
                      Nothing changed. Try again.
                    </p>
                  </>
                )}
              </div>
              <div className="flex gap-3">
                <Button variant="ghost" onClick={handleClose} className="flex-1">
                  Close
                </Button>
                <Button onClick={() => setStep('review')} className="flex-1" disabled={busy}>
                  Try again
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

