/**
 * The "What Haven cannot do" claims for the custody page.
 *
 * **#2413 collapsed this module.** It used to key its claims by rail — a
 * `railOf()` marker plus a `Record<CustodyRail, string[]>` — because a legacy
 * Safe user and a delegation user needed different wording, and stating one
 * rail's version to the other rail's user was exactly the defect #2106 was
 * about. That branch is unreachable now: the account-list queries filter the
 * retired rail out (`infra/repositories/user-safes.ts`), so no legacy account
 * reaches this page and `railOf` could only ever have returned one value.
 *
 * The rail-labelling logic went with it. A single-rail user was the ordinary
 * case and is now the only case, so the prefixes ("On your Haven account: ")
 * that disambiguated a mixed list have no second rail to disambiguate from.
 *
 * The Safe-rail wording is not archived here. It is in git history and in the
 * #2106 record; keeping a dead string table next to a live one is how the next
 * reader concludes both are reachable.
 */

const CANNOT_LINES = [
  'Move your funds — every transfer needs your or your agent’s key signature; Haven only relays and pays gas.',
  'Hold your keys — no private keys, seed phrases, or agent keys are stored by Haven.',
  // "Caveat enforcers" was cut on design review (#2106): it is MetaMask
  // Delegation-Framework internals, undefined anywhere on the page, and the
  // claim stands without it.
  'Expand an agent’s budget without a new delegation you sign.',
  'Block you — you can stop any agent’s budget on-chain, and your account’s signers act without Haven.',
]

/**
 * Every account that reaches the custody page is on the delegation rail, so
 * this no longer depends on the account list. The parameter is gone rather
 * than ignored: a function that accepts an argument it cannot use invites the
 * next caller to believe it still branches.
 */
export function havenCannotLines(): string[] {
  return [...CANNOT_LINES]
}
