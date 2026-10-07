import type { SmartAccount } from '@/context/AuthContext'

/**
 * The account a surface falls back to when it needs one and the user has not
 * chosen (#3719): the account marked `is_default`, else the first account.
 *
 * Haven has no global "active" account. Every surface shows all accounts and
 * an account-specific action picks its account locally; this is only the
 * pre-selection for those pickers and the subject of account-agnostic chrome
 * such as the header wallet pill.
 */
export function resolveDefaultAccount(
  accounts: readonly SmartAccount[] | null | undefined,
): SmartAccount | null {
  if (!accounts || accounts.length === 0) return null
  return accounts.find((account) => account.is_default) ?? accounts[0]
}
