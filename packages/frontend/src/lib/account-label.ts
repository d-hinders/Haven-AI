import type { SmartAccount } from '@/context/AuthContext'
import { resolveChainOrNull } from '@/lib/chains'

/**
 * How a local account picker names an account (#3719): the account, with its
 * chain as the secondary half — `Treasury · Base`. One shape for every place
 * the user chooses an account, so the same account never reads two ways.
 */
export function accountWithChainLabel(account: Pick<SmartAccount, 'name' | 'chain_id'>): string {
  const chain = resolveChainOrNull(account.chain_id)?.name
  return chain ? `${account.name} · ${chain}` : account.name
}
