'use client'

/**
 * "Fund this merchant" — a merchant-locked budget from a marketplace merchant
 * page (#3331, epic #3328).
 *
 * An ordinary recipient-pinned budget whose recipient is the merchant's own
 * verified payTo: pick an agent, an amount and a period, review, then ONE
 * passkey (or owner) signature — the SAME build → sign → activate composition
 * `useDelegationBudget`'s `grant()` already runs for an open budget, extended
 * with `merchantSlug`. The recipient the owner is shown IS the recipient sent
 * (#3331 review finding F1, WYSIWYS): the server still derives the merchant's
 * recipient itself and refuses (409) if a sent one disagrees — that refusal
 * is what catches the payTo rotating between page load and Sign — but the
 * build never sends a blind `null` for a surface that has a specific address
 * to show. Nothing here forks the signing logic itself.
 *
 * Copy follows the budget-review recipe (`screen-recipes.md`) and
 * `EditBudgetModal`'s established shape (`components/EditBudgetModal.tsx`):
 * who can spend, from which Haven wallet, how much, on whom, and how the
 * owner can stop it. Outcome language only — "delegation", "caveat",
 * "recipient pin" and "ERC-7710" never appear.
 */

import { Check, X } from 'lucide-react'
import Link from 'next/link'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { parseUnits, formatUnits } from 'viem'
import type { Address } from 'viem'
import { useDelegationBudget, type BudgetResult, type DelegationBudget, type GrantInput } from '@/hooks/useDelegationBudget'
import type { Agent } from '@/hooks/useAgents'
import type { CatalogEntry, Merchant, MerchantFundingTarget } from '@/hooks/useCatalog'
import { getChainConfig } from '@/lib/chains'
import { budgetPeriodWords } from '@/lib/budget-caption'
import { needsUnpinnedBudget, networkToChainId } from '@/lib/marketplace'
import {
  classifyMerchantBudgetRefusal,
  isPermanentMerchantBudgetRefusal,
} from '@/lib/merchantBudgetRefusal'
import { truncateAddress, BudgetAmountRow } from '@/components/haven'
import { Icon } from '@/components/ui/Icon'
import { Button } from '@/components/ui/Button'
import WalletConnectAction from '@/components/WalletConnectAction'
import { Select } from '@/components/ui/Select'
import { useFocusTrap } from '@/hooks/useFocusTrap'
import { useEscapeToClose } from '@/hooks/useEscapeToClose'

interface TokenOption {
  address: string
  symbol: string
  decimals: number
}

type Step = 'select' | 'review' | 'working' | 'done' | 'error'

const PERIODS: Array<{ label: string; seconds: number }> = [86_400, 604_800, 2_592_000].map((seconds) => ({
  // #3806: the period words are the caption helper's.
  label: budgetPeriodWords(seconds),
  seconds,
}))

function periodLabel(seconds: number): string {
  return budgetPeriodWords(seconds)
}

/** A plain, no-exponent, non-negative decimal — `1e3` or `-5` are refused with a message, never silently. */
const PLAIN_DECIMAL_RE = /^\d+(\.\d+)?$/

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

/**
 * Friendly copy for the build step's named refusals (#3331 review finding
 * F9): the four merchant-locked 409s, PLUS the ordinary grant refusals
 * `POST /delegations/build` can answer for any caller (a revoked agent, an
 * account off the delegation rail, a chain the rail is not enabled on, an
 * in-flight re-key) — everything else, including a raw/unrecognised message,
 * falls to one generic sentence rather than surfacing backend prose verbatim.
 * The caller always appends "Nothing changed." once, so this never repeats it.
 * Classification itself is shared with `EditBudgetModal` (round 2 review
 * finding R2-2) via `@/lib/merchantBudgetRefusal` — only the wording (a NEW
 * budget vs. an in-place edit) differs between the two modals.
 */
function refusalCopy(detail: string | undefined, merchantName: string): string {
  switch (classifyMerchantBudgetRefusal(detail)) {
    case 'no_verified_pay_to':
      return `${merchantName} hasn't confirmed where it is paid on this network yet, so no budget can be set up for it. Reload the page later to check again.`
    case 'not_erc7710':
      // #3331 review finding F7: the agent's open budget, not the merchant's.
      return `${merchantName}'s payments here now go through the agent's open budget instead — a merchant-locked budget is no longer offered.`
    case 'own_address':
      return `${merchantName}'s payment address is this agent's own wallet — Haven cannot pin a budget to it.`
    case 'pay_to_changed':
      return `${merchantName}'s payment address changed. Reload the page to see the current one.`
    case 'merchant_not_found':
      return `${merchantName} could not be found — it may have been removed. Reload the page.`
    case 'revoked_agent':
      return 'This agent was revoked and cannot receive a new budget.'
    case 'rekey_in_flight':
      return "A key change for this agent's Haven wallet is already in progress. Finish or cancel it, then try again."
    case 'account_unavailable':
      return "This agent's Haven wallet is temporarily unavailable. Try again shortly."
    case 'off_rail':
      return "This agent cannot receive this kind of budget on its current network."
    default:
      return `Haven could not set up this budget.`
  }
}

/**
 * The active budget (#3331 review finding F8) a new grant to `payTo`/`token`
 * would replace — ONE (agent, token, recipient) slot per the lifecycle API,
 * regardless of whose merchant label (if any) currently occupies it. A row
 * locked to a DIFFERENT merchant in the same slot matched neither of the two
 * predicates this used to be split into; it is replaced exactly the same as
 * a plain budget or one already locked to THIS merchant, so it must warn too
 * — the copy just names whichever merchant (or none) it is about to retire.
 */
function findReplacedBudget(
  budgets: DelegationBudget[] | null,
  payTo: string | null,
  token: TokenOption | null,
): DelegationBudget | null {
  if (!payTo || !token) return null
  return (
    (budgets ?? []).find(
      (b) =>
        b.status === 'active' &&
        (b.recipient_address ?? '').toLowerCase() === payTo.toLowerCase() &&
        b.token_address.toLowerCase() === token.address.toLowerCase(),
    ) ?? null
  )
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

  // #3331 review finding F11 (a11y): move focus to the current step's region
  // on a STEP CHANGE, never on the initial render (the focus trap already
  // places initial focus on open). A wizard whose next screen renders with no
  // focus move is silent to a screen-reader user.
  const stepRegionRef = useRef<HTMLDivElement>(null)
  const previousStepRef = useRef<Step>(step)
  useEffect(() => {
    if (previousStepRef.current !== step) {
      stepRegionRef.current?.focus()
    }
    previousStepRef.current = step
  }, [step])

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
  // against its ACTIVE rows. Also what signs the grant. #3331 review finding
  // F4: this hook resets its own state the instant `selectedAgent?.id`/
  // `chainId` change (agent picker inside one mounted instance), so `budgets`
  // and `ready` below are never the PREVIOUS agent's while the new read is in
  // flight — they read `null`/`false` instead.
  const { budgets, budgetsError, reload, grant, busy, ready, signersError, signersLoading } = useDelegationBudget(
    selectedAgent?.id ?? '',
    chainId ?? 0,
    { enabled: open && !!selectedAgent },
  )

  // #3331 review finding F4: the selected agent's current budgets must be
  // KNOWN before Review is offered — `budgets === null` covers both "still
  // loading" and "the read failed" (the hook collapses both, like
  // `DelegationBudgetCard` already does), so a replace warning is never
  // computed from data that might not be this agent's.
  const budgetsKnown = budgets !== null

  const replacedBudget = useMemo(() => findReplacedBudget(budgets, payTo, token), [budgets, payTo, token])

  const amountTrimmed = amount.trim()

  // #3331 review finding F5: reject a malformed amount with a MESSAGE rather
  // than silently disabling Review — scientific notation (`1e3`), letters, or
  // more fraction digits than the token supports all read as "nothing typed"
  // otherwise, which looks like a stuck button rather than an invalid value.
  const amountFormatError = useMemo(() => {
    if (amountTrimmed === '') return null
    if (!PLAIN_DECIMAL_RE.test(amountTrimmed)) {
      return 'Enter a plain number, like 5 or 5.25 — no letters or scientific notation.'
    }
    if (token) {
      const fractionDigits = amountTrimmed.includes('.') ? amountTrimmed.split('.')[1]!.length : 0
      if (fractionDigits > token.decimals) {
        return `${token.symbol} supports up to ${token.decimals} decimal place${token.decimals === 1 ? '' : 's'}.`
      }
    }
    return null
  }, [amountTrimmed, token])

  const amountAtomic = useMemo(() => {
    if (!token || amountFormatError || amountTrimmed === '') return null
    try {
      const v = parseUnits(amountTrimmed, token.decimals)
      return v > 0n ? v : null
    } catch {
      return null
    }
  }, [amountTrimmed, amountFormatError, token])

  const amountValid = amountAtomic !== null

  const input = useMemo<GrantInput | null>(() => {
    if (!token || !selectedAgent || !payTo || amountAtomic === null || !budgetsKnown) return null
    return {
      tokenAddress: token.address as Address,
      // #3331 review finding F1 (WYSIWYS): the DISPLAYED payTo is sent, not a
      // blind null — a payTo that rotated between page load and Sign now
      // fails the server's own comparison (409, "payment address changed")
      // instead of silently landing wherever the server resolves to.
      recipientAddress: payTo as Address,
      budgetAtomic: amountAtomic.toString(),
      periodSeconds: period,
      merchantSlug: merchant.slug,
    }
  }, [amountAtomic, budgetsKnown, merchant.slug, payTo, period, selectedAgent, token])

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

  // Design review round 2, finding 2: a refusal a same-input retry cannot
  // ever turn into a success must not offer "Try again" as its primary
  // action — "Reload page" for a moved payTo (reloading the merchant page IS
  // the fix), otherwise a single "Close". Transient/unknown refusals keep
  // Close + Try again exactly as before.
  const refusalKind =
    outcome && !outcome.ok && outcome.reason === 'refused' ? classifyMerchantBudgetRefusal(outcome.detail) : null
  const permanentRefusal = refusalKind !== null && isPermanentMerchantBudgetRefusal(refusalKind)

  if (!open) return null

  return (
    <div className="fixed inset-0 z-[var(--v2-z-modal)] flex items-center justify-center v2-safe-overlay [--v2-safe-gutter:1rem] v2-modal-backdrop">
      <div className="absolute inset-0" onClick={busy ? undefined : handleClose} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="fund-merchant-title"
        data-testid="fund-merchant-modal"
        className="relative max-h-[calc(90vh-var(--v2-safe-top)-var(--v2-safe-bottom))] w-full max-w-lg overflow-y-auto rounded-2xl border border-[var(--v2-border)] bg-[var(--v2-bg)] shadow-modal"
      >
        <div className="flex items-center justify-between border-b border-[var(--v2-border)] px-6 py-5">
          <div>
            <h2 id="fund-merchant-title" className="text-lg font-semibold text-[var(--v2-ink)]">
              Fund {merchant.name}
            </h2>
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
          {step === 'select' &&
            (eligibleAgents.length === 0 ? (
              <div ref={stepRegionRef} tabIndex={-1} className="space-y-5 outline-none">
                <p className="text-sm text-[var(--v2-ink-2)]">None of your agents can be pinned to {merchant.name} yet.</p>
                <p className="text-sm leading-relaxed text-[var(--v2-ink-2)]">
                  <Link href="/agents" className="font-medium text-[var(--v2-brand)] hover:underline">
                    Connect or set up an agent
                  </Link>{' '}
                  on a network {merchant.name} accepts, then come back here.
                </p>
                <Button variant="ghost" onClick={handleClose} className="w-full">
                  Close
                </Button>
              </div>
            ) : (
              <div ref={stepRegionRef} tabIndex={-1} className="space-y-5 outline-none">
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
                    {/* #3398: the amount row is the shared `BudgetAmountRow` —
                        one markup for both branches below. The token symbol
                        rides inside the amount input as a suffix (no more
                        stacked "USDC" orphan line, design finding 14), and a
                        multi-token offer keeps a real token Select beside the
                        amount on the same line. The row is `sm:items-end`, so
                        the label wrapper keeps the input's bottom edge as the
                        row's reference line — the symbol text shares the
                        input's box instead of hanging below its baseline (the
                        ~9 px desktop offset the #3331 design review measured). */}
                    <BudgetAmountRow
                      amount={amount}
                      onAmountChange={setAmount}
                      tokens={tokenOptions}
                      selectedTokenAddress={token?.address ?? null}
                      onTokenChange={setTokenAddress}
                      period={period}
                      onPeriodChange={setPeriod}
                      periods={PERIODS}
                      amountLabel="Amount"
                      amountLabelHtmlFor="fund-merchant-amount"
                      inputId="fund-merchant-amount"
                      amountAriaLabel="Budget amount"
                      amountInvalid={!!amountFormatError}
                      amountAriaDescribedBy={amountFormatError ? 'fund-merchant-amount-error' : undefined}
                      // w-40, not w-32: the symbol now lives INSIDE the input,
                      // and a 128px box (minus padding and the suffix
                      // reservation) cannot hold the "Amount" placeholder
                      // beside it — it truncated to "Amo". 160px keeps
                      // placeholder and symbol in one box.
                      inputClassName="sm:w-40"
                      periodSelectClassName="sm:w-36"
                    />
                    <p className="text-xs leading-relaxed text-[var(--v2-ink-2)]">
                      Pays only {merchant.name}
                      {payTo ? ` (${truncateAddress(payTo)})` : ''}.
                    </p>
                    {amountFormatError ? (
                      <p id="fund-merchant-amount-error" role="alert" className="text-xs text-[var(--v2-danger)]">
                        {amountFormatError}
                      </p>
                    ) : !amountValid ? (
                      <p className="text-xs text-[var(--v2-ink-3)]">Enter an amount above zero to continue.</p>
                    ) : null}
                    {budgetsError ? (
                      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--v2-border)] bg-[var(--v2-surface)] px-3 py-2">
                        <p className="text-xs text-[var(--v2-ink-2)]">
                          Haven could not check this agent's existing budgets.
                        </p>
                        <Button size="sm" variant="ghost" onClick={() => void reload()}>
                          Try again
                        </Button>
                      </div>
                    ) : !budgetsKnown ? (
                      <p className="text-xs text-[var(--v2-ink-3)]">Checking this agent's current budgets…</p>
                    ) : null}
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
            ))}

          {step === 'review' && input && selectedAgent && token && (
            <div ref={stepRegionRef} tabIndex={-1} className="space-y-5 outline-none">
              <div className="space-y-3 rounded-xl border border-[var(--v2-border)] bg-[var(--v2-surface)] p-4">
                <div>
                  <p className="mb-1 text-xs font-medium text-[var(--v2-ink-3)]">Agent</p>
                  <p className="text-sm text-[var(--v2-ink)]">{selectedAgent.name}</p>
                </div>
                <div>
                  <p className="mb-1 text-xs font-medium text-[var(--v2-ink-3)]">Budget</p>
                  {/* #3331 review finding F5: the SIGNED amount, not the typed
                      string — the same `formatUnits(atomic)` read
                      `EditBudgetModal.tsx` shows in its own review step. */}
                  <p className="v2-tabular text-sm font-medium text-[var(--v2-ink)]">
                    {formatUnits(amountAtomic ?? 0n, token.decimals)} {token.symbol} {periodLabel(period)}
                  </p>
                </div>
                <div>
                  <p className="mb-1 text-xs font-medium text-[var(--v2-ink-3)]">Pays</p>
                  <p className="text-sm text-[var(--v2-ink)]">
                    {merchant.name} only{payTo ? ` · ${truncateAddress(payTo)}` : ''}
                  </p>
                </div>
                {/* #3331 review finding F2, corrected round 3 (code F1, design
                    B, doc F1/F2 — the captain's final copy): selection keys on
                    the payment's RECIPIENT, not the checkout path — a direct
                    (ERC-7710) payment straight to the merchant's own address
                    uses this budget with no fallback once it runs out; a
                    checkout that funds the agent's own wallet first (the
                    EIP-3009 funding leg) selects the open budget instead
                    because the on-chain recipient there is the agent, not the
                    merchant; a task budget pays from whichever budget it was
                    carved from at creation, independent of this row. Stated
                    once, here on the review step (the select step keeps only
                    the short "pays only" line); `docs/product/marketplace.md`
                    "Which budget pays" states the same rule and exceptions. */}
                <p className="text-xs leading-relaxed text-[var(--v2-ink-2)]">
                  Payments this agent sends straight to {merchant.name} use this budget. Once it runs out, those
                  payments are refused until the next period — they are not held for approval. It does not cap
                  everything the agent spends at {merchant.name}: checkout payments that pass through the agent
                  first still use its open budget, and a task budget pays from whichever budget it was set up from.
                </p>
              </div>

              {replacedBudget && (
                <div className="space-y-1 rounded-xl border border-warning/30 bg-[var(--v2-warning-soft)] p-4 text-xs leading-relaxed text-[var(--v2-ink)]">
                  <p className="font-medium">
                    {replacedBudget.merchant_id === merchant.id
                      ? `This replaces this agent's current budget for ${merchant.name}.`
                      : replacedBudget.merchant_id
                        ? `This replaces this agent's current budget for ${replacedBudget.merchant_name ?? 'another merchant'}, which uses the same payment address.`
                        : `This replaces this agent's current budget to the same address.`}
                  </p>
                  <p className="v2-tabular">
                    {formatUnits(BigInt(replacedBudget.budget_atomic), token.decimals)} {token.symbol}{' '}
                    {periodLabel(replacedBudget.period_seconds)} — signing below activates the new budget in its
                    place.
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
                <div className="space-y-2">
                  <p className="text-xs text-[var(--v2-ink-3)]">
                    Connect the wallet or passkey that approves actions for this agent's Haven wallet.
                  </p>
                  {/* #3812: connect or switch in place, not only from the header. */}
                  {!signersError && !signersLoading ? <WalletConnectAction /> : null}
                </div>
              )}
            </div>
          )}

          {step === 'working' && (
            <div ref={stepRegionRef} tabIndex={-1} role="status" aria-live="polite" className="space-y-4 py-8 text-center outline-none">
              <div className="mx-auto h-10 w-10 animate-spin rounded-full border-2 border-[var(--v2-brand)] border-t-transparent" />
              <p className="text-sm font-medium text-[var(--v2-ink)]">Waiting for your signature…</p>
              <p className="mx-auto max-w-xs text-xs text-[var(--v2-ink-3)]">
                {/* #3331 review finding design-9: never assume a passkey — the
                    same copy `EditBudgetModal.tsx` uses for its own waiting step. */}
                Approve in your wallet or with your passkey. The budget is set only after you sign.
              </p>
            </div>
          )}

          {step === 'done' && (
            <div ref={stepRegionRef} tabIndex={-1} className="space-y-5 outline-none">
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
            <div ref={stepRegionRef} tabIndex={-1} role="alert" className="space-y-5 outline-none">
              <div className="space-y-3 py-2 text-center">
                <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-[var(--v2-danger-soft)]">
                  <Icon icon={X} className="h-5 w-5 text-[var(--v2-danger)]" />
                </div>
                {/* #3331 review finding F9: ONE heading for every failure shape
                    — "the budget could not be set" — followed by named copy
                    for a recognised refusal or a generic sentence otherwise,
                    always closing with "Nothing changed." */}
                <p className="text-sm font-medium text-[var(--v2-ink)]">The budget could not be set</p>
                <p className="mx-auto max-w-xs text-xs leading-relaxed text-[var(--v2-ink-3)]">
                  {`${
                    outcome.reason === 'refused'
                      ? refusalCopy(outcome.detail, merchant.name)
                      : 'Haven could not set up this budget.'
                  } Nothing changed.`}
                </p>
              </div>
              <div className="flex gap-3">
                {permanentRefusal ? (
                  // Design review round 3, finding A (code F2): a refusal that
                  // a reload CAN resolve — the payTo moved, it isn't confirmed
                  // yet, or the merchant vanished — offers "Reload page" as its
                  // primary action, not just "Close". "Close" alone stays for
                  // the refusals a reload cannot fix (this agent IS the payTo,
                  // the offer stopped taking this kind of budget, the agent was
                  // revoked, or the account is off the delegation rail).
                  refusalKind === 'pay_to_changed' ||
                  refusalKind === 'no_verified_pay_to' ||
                  refusalKind === 'merchant_not_found' ? (
                    <Button onClick={() => window.location.reload()} className="flex-1">
                      Reload page
                    </Button>
                  ) : (
                    <Button onClick={handleClose} className="flex-1">
                      Close
                    </Button>
                  )
                ) : (
                  <>
                    <Button variant="ghost" onClick={handleClose} className="flex-1">
                      Close
                    </Button>
                    <Button onClick={() => setStep('review')} className="flex-1" disabled={busy}>
                      Try again
                    </Button>
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
