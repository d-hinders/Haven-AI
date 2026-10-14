/**
 * The user-level signer view (#3825): every signer across all of the caller's
 * live Hybrid DeleGator accounts, listed ONCE, with the accounts it approves.
 *
 * Pure — no I/O. `GET /user/signers` loads each account's owner config and
 * passkey enrollment dates, then folds them through here, so dedupe and the
 * ordering the dashboard numbers "Passkey N" from are testable without a pool.
 *
 * Public-key material only: a passkey is identified by `key_id`; the x/y
 * coordinates are never carried.
 */

export interface UserSignerAccount {
  account_id: string
  account_address: string
  account_name: string | null
  chain_id: number
}

export interface UserSignerPasskey {
  kind: 'passkey'
  key_id: string
  /** Earliest enrollment known across accounts; null when none (never guessed). */
  created_at: string | null
  accounts: UserSignerAccount[]
}

export interface UserSignerWallet {
  kind: 'wallet'
  /** Lowercase, always. */
  address: string
  accounts: UserSignerAccount[]
}

export type UserSigner = UserSignerPasskey | UserSignerWallet

/** One account's resolved signer set — the input to the fold. */
export interface AccountSignerSet {
  account: UserSignerAccount
  ownerAddress: string | null
  passkeys: Array<{ keyId: string; createdAt: string | null }>
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function compareAccounts(a: UserSignerAccount, b: UserSignerAccount): number {
  return (
    a.chain_id - b.chain_id ||
    cmp(a.account_address.toLowerCase(), b.account_address.toLowerCase()) ||
    cmp(a.account_id, b.account_id)
  )
}

export function aggregateUserSigners(sets: AccountSignerSet[]): UserSigner[] {
  const passkeys = new Map<string, UserSignerPasskey>()
  const wallets = new Map<string, UserSignerWallet>()

  for (const set of sets) {
    for (const p of set.passkeys) {
      const id = p.keyId.toLowerCase()
      let entry = passkeys.get(id)
      if (!entry) {
        entry = { kind: 'passkey', key_id: id, created_at: null, accounts: [] }
        passkeys.set(id, entry)
      }
      if (p.createdAt && (entry.created_at === null || p.createdAt < entry.created_at)) {
        entry.created_at = p.createdAt
      }
      if (!entry.accounts.some((a) => a.account_id === set.account.account_id)) {
        entry.accounts.push(set.account)
      }
    }
    if (set.ownerAddress) {
      const addr = set.ownerAddress.toLowerCase()
      let entry = wallets.get(addr)
      if (!entry) {
        entry = { kind: 'wallet', address: addr, accounts: [] }
        wallets.set(addr, entry)
      }
      if (!entry.accounts.some((a) => a.account_id === set.account.account_id)) {
        entry.accounts.push(set.account)
      }
    }
  }

  const sortedPasskeys = [...passkeys.values()].sort((a, b) => {
    if (a.created_at !== b.created_at) {
      if (a.created_at === null) return 1
      if (b.created_at === null) return -1
      return cmp(a.created_at, b.created_at)
    }
    return cmp(a.key_id, b.key_id)
  })
  const sortedWallets = [...wallets.values()].sort((a, b) => cmp(a.address, b.address))

  const all: UserSigner[] = [...sortedPasskeys, ...sortedWallets]
  for (const s of all) s.accounts.sort(compareAccounts)
  return all
}
