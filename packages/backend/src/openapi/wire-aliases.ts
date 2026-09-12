/**
 * #2907 (naming epic #2906, phase 0): dual-emit mappers for the additive
 * `safe` -> `account` wire rename.
 *
 * One mapper per response shape, each equality-tested (old value === new
 * value) so a dropped twin field fails a test rather than shipping silently.
 * These are pure, side-effect-free projections over already-fetched rows —
 * no new query, no new authority, no change to what was fetched or why.
 *
 * `deprecated: true` on the old field in `openapi/spec.ts` documents the
 * removal window; these functions are what actually puts both names on the
 * wire. Removed one release after #2908 ships (#2914).
 */

/** The shape every linked-Safe/account row carries at minimum. */
interface SafeAddressed {
  safe_address: string
}

/** `GET /user/safes` and `/user/accounts`, and the rename/unlink writes. */
export function withAccountAddressAlias<T extends SafeAddressed>(
  row: T,
): T & { account_address: string } {
  return { ...row, account_address: row.safe_address }
}

interface SafeIdentified {
  safe_id: string | null
  safe_address: string | null
  safe_name: string | null
  safe_chain_id: number | null
}

/** `Agent` — dual-emits the four safe_* fields as their account_* twins. */
export function withAgentAccountAlias<T extends SafeIdentified>(
  agent: T,
): T & {
  account_id: string | null
  account_address: string | null
  account_name: string | null
  account_chain_id: number | null
} {
  return {
    ...agent,
    account_id: agent.safe_id,
    account_address: agent.safe_address,
    account_name: agent.safe_name,
    account_chain_id: agent.safe_chain_id,
  }
}

interface TransactionSafeScoped {
  safeId: string
  safeAddress: string
  safeName: string
}

/** `Transaction` (the aggregated feed shape) — chainId is unaffected. */
export function withTransactionAccountAlias<T extends TransactionSafeScoped>(
  tx: T,
): T & { accountId: string; accountAddress: string; accountName: string } {
  return {
    ...tx,
    accountId: tx.safeId,
    accountAddress: tx.safeAddress,
    accountName: tx.safeName,
  }
}

interface DashboardAgentSafeScoped {
  safeId: string | null
  safeName: string | null
  safeChainId: number | null
}

/** `DashboardAgentPreview`. */
export function withDashboardAgentAccountAlias<T extends DashboardAgentSafeScoped>(
  agent: T,
): T & { accountId: string | null; accountName: string | null; accountChainId: number | null } {
  return {
    ...agent,
    accountId: agent.safeId,
    accountName: agent.safeName,
    accountChainId: agent.safeChainId,
  }
}

/** `TransactionsResponse.failedSafeIds` -> `.failedAccountIds`, same list. */
export function withFailedAccountIdsAlias<T extends { failedSafeIds: string[] }>(
  body: T,
): T & { failedAccountIds: string[] } {
  return { ...body, failedAccountIds: body.failedSafeIds }
}

/** `sessionUser.safe_address` -> `.account_address`, same value. */
export function withSessionAccountAddressAlias<T extends { safe_address: string | null }>(
  user: T,
): T & { account_address: string | null } {
  return { ...user, account_address: user.safe_address }
}
