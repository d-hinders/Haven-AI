/**
 * `GET /ops/users/:id/onchain` (#3513, epic #3507): the chain's view of the
 * customer's delegation-rail accounts next to the DB's, with the
 * disagreements flagged.
 *
 * ## Why the chain readers are injected (`OpsOnchainReaders`)
 *
 * This module is reached from `routes/ops.ts`, and `routes/ops.ts` is pinned
 * by the ops-console invariant-1 static walk (`__tests__/ops.invariants.test.ts`)
 * to reach no rail, no chain module and no signing module. The issue's readers
 * (`readDisabledDelegationHashes`, `readRemainingBudget`) live exactly in
 * `rails/` and `infra/chain/`, so importing them here would fail that walk.
 * They arrive instead as a constructor argument — the same seam shape as the
 * route's `readDb` and `audit` options (#3509) — and the real implementation
 * (`onchain-readers.ts`, same directory) is wired in `index.ts`, which the
 * walk never enters. The interface is READ-only by construction: no reader
 * can build, sign or submit anything.
 *
 * ## Which rows are read
 *
 * The user's `smart_accounts` rows are bucketed BEFORE any chain work:
 * - readable — `account_type='delegator_hybrid'` on a chain in
 *   `deployableChainIds()` that also has delegation pins;
 * - `legacy_safe` — any row with another `account_type`;
 * - `chain_not_served` — a delegator_hybrid row on a chain this environment
 *   does not serve (`deployableChainIds()`, dev serves Base Sepolia only);
 * - `chain_not_pinned` — a served chain with no pinned delegation contracts.
 * Every non-readable row answers `not_served` with its reason and ZERO RPC
 * calls. There are no Safe or AllowanceModule reads anywhere.
 *
 * ## Per readable row
 *
 * - Deployed vs counterfactual, from the reader's `accountHasCode`
   (`getBytecode` on the dedicated RPC — a lagging fallback node can falsely
 *   report "no code", `rails/hybrid-provisioning.ts:195`, so the resulting
 *   flag is best-effort and never acted on).
 * - Delegation disabled on-chain but active in the DB, from
 *   `readDisabledDelegationHashes` (finalized block, double read) over the
 *   account's ACTIVE stored delegations.
 * - Budget remaining this period, from `readRemainingBudget` with
 *   `delegation_json` (readable by the ops role by owner decision, #3510).
 *   When the chain read fails the reader answers the FULL budget with
 *   `fromChain: false` — that answer renders as `unavailable`, never as a
 *   remaining figure.
 * Bytecode is read on the ACCOUNT's chain; the disabled and budget reads on
 * the DELEGATION's chain — that is where the DelegationManager and the
 * period enforcer live. On this rail the two are the same chain; the split
 * keeps the reads honest if a row ever drifts.
 * The signer set is DB-only in v1 (`GET /:id/account-signers` returns the
 * stored config; no on-chain signer-set reader exists yet).
 *
 * ## RPC load
 *
 * Dev's primary RPC fails a burst of about 20 calls (#3456) and shares its
 * key with prod's fallback, so the chain reads for one (chain, user) are
 * single-flight cached for 60 s (`platform/cache`, the
 * `modules/accounts/balance-reads.ts` pattern, #3460): concurrent callers
 * share one in-flight read-set and a completed set is served for the TTL. A
 * crashed read-set is not cached; a leg that failed is answered per-chain as
 * `unavailable`, never a 500. The disabled-delegation read batches every
 * hash into one reader call (it multicalls internally); `eth_getCode` cannot
 * ride multicall3, so the bytecode check stays one cheap call per account.
 * The UI does no background polling.
 *
 * ## Masking
 *
 * Every address is masked with the shared ops `maskHex`. `delegation_hash`
 * and `delegation_json` never leave this module: the hash identifies the
 * read internally and the JSON goes only into the budget reader. A leg whose
 * stored data the cached read-set does not cover (rows created mid-TTL)
 * renders `unknown` until the TTL expires — an honest "not read yet", never
 * a guess.
 */
import { createCache, type Cache } from '../../platform/cache.js'
import { deployableChainIds } from '../../domain/chains.js'
import { readOpsOnchainView } from '../../infra/repositories/ops-reads.js'
import type { Executor } from '../../infra/transaction.js'
import { maskHex } from './masking.js'

/** The 60 s single-flight TTL for one (chain, user) read-set. */
export const OPS_ONCHAIN_CACHE_TTL_MS = 60_000

/**
 * The chain reads the ops console may make. Implemented by
 * `modules/ops/onchain-readers.ts` (which may touch rails and infra/chain)
 * and wired in `index.ts`; tests pass mocks. Reads only — nothing here can
 * write state, sign, or submit.
 */
export interface OpsOnchainReaders {
  /** Whether the chain has pinned delegation contracts (`getDelegationContracts` would not throw). */
  chainHasDelegationPins(chainId: number): boolean
  /**
   * Whether code exists at `accountAddress` on `chainId` — the
   * deployed-vs-counterfactual check. `false` when `getBytecode` answers
   * `0x`; throws on RPC failure.
   */
  accountHasCode(chainId: number, accountAddress: string): Promise<boolean>
  /**
   * Which of `hashes` the pinned DelegationManager already reports disabled
   * (`readDisabledDelegationHashes`: finalized block, double read). Throws
   * on RPC failure.
   */
  readDisabledDelegationHashes(
    chainId: number,
    hashes: readonly `0x${string}`[],
  ): Promise<Set<`0x${string}`>>
  /**
   * The enforcer's remaining period budget for one stored delegation
   * (`readRemainingBudget`). `fromChain: false` means the number is the
   * FALLBACK (the full budget), not the chain's answer — this module renders
   * that `unavailable`.
   */
  readRemainingBudget(
    chainId: number,
    delegationJson: string,
    budgetAtomic: string,
  ): Promise<{ remainingAtomic: string; fromChain: boolean }>
}

/** The chain's answer on whether the account's code exists on-chain. */
export type OnchainDeployStatus = 'deployed' | 'counterfactual' | 'unknown' | 'unavailable'

/** The chain's answer on one stored delegation's disabled flag. */
export type OnchainDelegationState = 'enabled' | 'disabled' | 'unknown' | 'unavailable'

/** The chain's answer on one stored delegation's remaining period budget. */
export type OnchainBudgetStatus = 'from_chain' | 'unknown' | 'unavailable'

/**
 * One ACTIVE stored delegation as the on-chain view sees it, in
 * `db.active_delegations` order — position identifies the delegation; the
 * raw delegation hash and body never leave the module.
 */
export interface OnchainAccountDelegation {
  budget_atomic: string
  onchain: OnchainDelegationState
  budget_status: OnchainBudgetStatus
  /** Set only when `budget_status` is `from_chain`; never a fallback figure. */
  budget_remaining_atomic: string | null
}

/** One `smart_accounts` row that WAS read on-chain. */
export interface OnchainAccount {
  account_id: string
  chain_id: number
  /** Masked. */
  account_address: string
  account_type: 'delegator_hybrid'
  execution_rail: string
  name: string
  /** The account's ACTIVE stored delegations, in the response's stable order. */
  db: {
    active_delegations: { budget_atomic: string }[]
  }
  /** Same order as `db.active_delegations` — position identifies the delegation. */
  chain: {
    deploy_status: OnchainDeployStatus
    delegations: OnchainAccountDelegation[]
  }
  flags: {
    /**
     * Chain reports no code while the DB still holds an active delegation.
     * Best-effort: a lagging fallback node can answer `0x` for a deployed
     * account — labelled, never acted on.
     */
    counterfactual_with_active_delegation: boolean
    /** At least one delegation disabled on-chain while active in the DB. */
    delegation_disabled_onchain_active_in_db: boolean
  }
}

/** A `smart_accounts` row this environment deliberately does NOT read (zero RPC). */
export interface OnchainNotServedAccount {
  account_id: string
  chain_id: number
  /** Masked. */
  account_address: string
  account_type: string
  execution_rail: string
  status: 'not_served'
  reason: 'legacy_safe' | 'chain_not_served' | 'chain_not_pinned'
}

export interface OpsOnchainView {
  user_id: string
  accounts: (OnchainAccount | OnchainNotServedAccount)[]
  generated_at: string
}

/** One (chain, user) read-set: every leg pre-settled, so failures never reject the cache load. */
interface ChainReadSet {
  /** Account address (lowercased) → the bytecode answer, for accounts ON this chain. */
  bytecode: Map<string, PromiseSettledResult<boolean>>
  /** Delegation hash → the chain's disabled answer, for delegations ON this chain. */
  disabled: Map<string, PromiseSettledResult<boolean>>
  /** Delegation hash → the enforcer's remaining-budget answer. */
  budget: Map<string, PromiseSettledResult<{ remainingAtomic: string; fromChain: boolean }>>
  /** True when the read-set crashed before the maps were populated: every leg renders `unavailable`. */
  failed: boolean
}

const onchainCache: Cache<ChainReadSet> = createCache<ChainReadSet>(OPS_ONCHAIN_CACHE_TTL_MS)

/** The single-flight cache key for one (chain, user) read-set. */
export function onchainCacheKey(chainId: number, userId: string): string {
  return `ops-onchain:${chainId}:${userId}`
}

/** A fresh cache with the production TTL — for tests, so they do not share module state. */
export function createTestCache(): Cache<ChainReadSet> {
  return createCache<ChainReadSet>(OPS_ONCHAIN_CACHE_TTL_MS)
}

export interface BuildOpsOnchainViewOptions {
  /** Chain readers — required; the route 404s without a wired implementation. */
  readers: OpsOnchainReaders
  /** Cache override for tests; the default is the module-level 60 s single-flight cache. */
  cache?: Cache<ChainReadSet>
  now?: () => number
}

/** What one chain's read-set has to cover for this user. */
interface ChainWork {
  /** Delegator-hybrid accounts ON this chain: bytecode targets. */
  accounts: { account_id: string; address: string }[]
  /** ACTIVE stored delegations ON this chain: disabled + budget targets. */
  delegations: { hash: string; json: string; budget: string }[]
}

const emptyReadSet = (): ChainReadSet => ({
  bytecode: new Map(),
  disabled: new Map(),
  budget: new Map(),
  failed: true,
})

/**
 * The per-account DB+chain view for one user, or `null` when no user has
 * that id. Rows the environment does not read are listed with their reason
 * and never trigger an RPC call; a per-chain RPC failure renders that
 * chain's entries `unavailable` instead of failing the request.
 */
export async function buildOpsOnchainView(
  db: Executor,
  userId: string,
  opts: BuildOpsOnchainViewOptions,
): Promise<OpsOnchainView | null> {
  const rows = await readOpsOnchainView(db, userId)
  if (!rows) return null
  const served = new Set(deployableChainIds())
  const { readers } = opts
  const cache = opts.cache ?? onchainCache

  // ── Bucket the rows before any chain work: non-readable rows never RPC ──
  const work = new Map<number, ChainWork>()
  const chainWorkFor = (chainId: number): ChainWork => {
    const existing = work.get(chainId)
    if (existing) return existing
    const fresh: ChainWork = { accounts: [], delegations: [] }
    work.set(chainId, fresh)
    return fresh
  }
  const readable: (typeof rows.accounts)[number][] = []
  const notServedAccounts: OnchainNotServedAccount[] = []
  for (const row of rows.accounts) {
    if (row.account_type !== 'delegator_hybrid') {
      notServedAccounts.push(notServed(row, 'legacy_safe'))
      continue
    }
    if (!served.has(row.chain_id)) {
      notServedAccounts.push(notServed(row, 'chain_not_served'))
      continue
    }
    if (!readers.chainHasDelegationPins(row.chain_id)) {
      notServedAccounts.push(notServed(row, 'chain_not_pinned'))
      continue
    }
    readable.push(row)
    chainWorkFor(row.chain_id).accounts.push({ account_id: row.id, address: row.account_address })
    for (const delegation of row.delegations) {
      // The disabled and budget reads happen where the delegation LIVES —
      // the DelegationManager and the period enforcer of ITS chain — and
      // ONLY when that chain is itself served and pinned: an unserved chain
      // is never read, by policy, exactly like an unserved account row.
      if (!served.has(delegation.chain_id) || !readers.chainHasDelegationPins(delegation.chain_id)) {
        continue
      }
      chainWorkFor(delegation.chain_id).delegations.push({
        hash: delegation.delegation_hash,
        json: delegation.delegation_json,
        budget: delegation.budget_atomic,
      })
    }
  }

  // ── One single-flight cached read-set per (chain, user) ────────────────
  const readSets = new Map<number, ChainReadSet>()
  await Promise.all(
    [...work.keys()].map(async (chainId) => {
      try {
        const readSet = await cache.getOrFetch(onchainCacheKey(chainId, userId), () =>
          performChainReads(readers, chainId, work.get(chainId) as ChainWork),
        )
        readSets.set(chainId, readSet)
      } catch {
        // The loader itself crashed: answer this chain as unreadable rather
        // than failing the request (AC: per-chain failure, not a 500).
        readSets.set(chainId, emptyReadSet())
      }
    }),
  )

  // ── Merge the DB and chain views ────────────────────────────────────────
  const accounts: (OnchainAccount | OnchainNotServedAccount)[] = [
    ...notServedAccounts,
    ...readable.map((row) =>
      mergeAccount(
        row,
        (chainId) => readSets.get(chainId) ?? null,
      ),
    ),
  ]
  accounts.sort(
    (a, b) => a.chain_id - b.chain_id || a.account_address.localeCompare(b.account_address),
  )

  return {
    user_id: userId,
    accounts,
    generated_at: new Date((opts.now ?? Date.now)()).toISOString(),
  }
}

function notServed(
  row: { id: string; chain_id: number; account_address: string; account_type: string; execution_rail: string },
  reason: OnchainNotServedAccount['reason'],
): OnchainNotServedAccount {
  return {
    account_id: row.id,
    chain_id: row.chain_id,
    account_address: maskHex(row.account_address),
    account_type: row.account_type,
    execution_rail: row.execution_rail,
    status: 'not_served',
    reason,
  }
}

/** Fold one readable account row against its chains' read-sets. */
function mergeAccount(
  row: {
    id: string
    chain_id: number
    account_address: string
    execution_rail: string
    name: string
    delegations: { chain_id: number; delegation_hash: string; delegation_json: string; budget_atomic: string }[]
  },
  readSetFor: (chainId: number) => ChainReadSet | null,
): OnchainAccount {
  const active = row.delegations
  const accountReadSet = readSetFor(row.chain_id)
  const deployed = accountReadSet?.bytecode.get(row.account_address.toLowerCase())
  let deployStatus: OnchainDeployStatus
  if (accountReadSet === null) deployStatus = 'unknown'
  else if (deployed === undefined) deployStatus = 'unknown'
  else if (deployed.status === 'rejected') deployStatus = 'unavailable'
  else deployStatus = deployed.value ? 'deployed' : 'counterfactual'

  const chainDelegations: OnchainAccountDelegation[] = active.map((d) => {
    const readSet = readSetFor(d.chain_id)
    if (readSet === null || readSet.failed) {
      return {
        budget_atomic: d.budget_atomic,
        // `null` read-set: the chain was never read (unserved or unpinned —
        // a policy answer, not a failure) → `unknown`. A read-set that
        // crashed mid-read → `unavailable`.
        onchain: readSet === null ? 'unknown' : 'unavailable',
        budget_status: readSet === null ? 'unknown' : 'unavailable',
        budget_remaining_atomic: null,
      }
    }
    const disabledLeg = readSet.disabled.get(d.delegation_hash)
    const onchain: OnchainDelegationState =
      disabledLeg === undefined
        ? 'unknown'
        : disabledLeg.status === 'rejected'
          ? 'unavailable'
          : disabledLeg.value
            ? 'disabled'
            : 'enabled'
    const budgetLeg = readSet.budget.get(d.delegation_hash)
    let budgetStatus: OnchainBudgetStatus
    let remaining: string | null = null
    if (budgetLeg === undefined) budgetStatus = 'unknown'
    else if (budgetLeg.status === 'rejected') budgetStatus = 'unavailable'
    else if (budgetLeg.value.fromChain) {
      budgetStatus = 'from_chain'
      remaining = budgetLeg.value.remainingAtomic
    } else {
      // The reader's fallback — the full budget, not the chain's answer —
      // must never be shown as a remaining figure (#3513 AC).
      budgetStatus = 'unavailable'
    }
    return {
      budget_atomic: d.budget_atomic,
      onchain,
      budget_status: budgetStatus,
      budget_remaining_atomic: remaining,
    }
  })

  return {
    account_id: row.id,
    chain_id: row.chain_id,
    account_address: maskHex(row.account_address),
    account_type: 'delegator_hybrid',
    execution_rail: row.execution_rail,
    name: row.name,
    db: {
      active_delegations: active.map((d) => ({ budget_atomic: d.budget_atomic })),
    },
    chain: {
      deploy_status: deployStatus,
      delegations: chainDelegations,
    },
    flags: {
      counterfactual_with_active_delegation:
        deployStatus === 'counterfactual' && active.length > 0,
      delegation_disabled_onchain_active_in_db: chainDelegations.some(
        (d) => d.onchain === 'disabled',
      ),
    },
  }
}

/**
 * Run the chain reads for one (chain, user): one `accountHasCode` per
 * account ON this chain, one batched disabled-hash read over every stored
 * hash ON this chain, one budget read per distinct stored delegation. Every
 * leg settles inside `Promise.allSettled`, so this loader rejects only on an
 * unexpected crash — a failed leg is data, not an exception.
 */
async function performChainReads(
  readers: OpsOnchainReaders,
  chainId: number,
  work: ChainWork,
): Promise<ChainReadSet> {
  const bytecode = new Map<string, PromiseSettledResult<boolean>>()
  const disabled = new Map<string, PromiseSettledResult<boolean>>()
  const budget = new Map<string, PromiseSettledResult<{ remainingAtomic: string; fromChain: boolean }>>()

  const addresses = [...new Set(work.accounts.map((account) => account.address.toLowerCase()))]
  const settledBytecode = await Promise.allSettled(
    addresses.map((address) => readers.accountHasCode(chainId, address)),
  )
  addresses.forEach((address, i) => bytecode.set(address, settledBytecode[i]))

  const hashes = [...new Set(work.delegations.map((d) => d.hash as `0x${string}`))]
  if (hashes.length > 0) {
    // One reader call for the whole chain: the implementation multicalls the
    // per-hash reads internally and double-reads at the finalized block.
    const settledDisabled = await Promise.allSettled([
      readers.readDisabledDelegationHashes(chainId, hashes),
    ])
    const outcome = settledDisabled[0]
    if (outcome.status === 'fulfilled') {
      const disabledSet = outcome.value
      for (const hash of hashes) disabled.set(hash, { status: 'fulfilled', value: disabledSet.has(hash) })
    } else {
      const reason = outcome.reason
      for (const hash of hashes) disabled.set(hash, { status: 'rejected', reason })
    }
  }

  const budgetTargets = new Map<string, { json: string; budget: string }>()
  for (const delegation of work.delegations) {
    if (!budgetTargets.has(delegation.hash)) {
      budgetTargets.set(delegation.hash, { json: delegation.json, budget: delegation.budget })
    }
  }
  if (budgetTargets.size > 0) {
    const targets = [...budgetTargets.values()]
    const settledBudgets = await Promise.allSettled(
      targets.map((target) => readers.readRemainingBudget(chainId, target.json, target.budget)),
    )
    ;[...budgetTargets.keys()].forEach((hash, i) => budget.set(hash, settledBudgets[i]))
  }

  return { bytecode, disabled, budget, failed: false }
}
