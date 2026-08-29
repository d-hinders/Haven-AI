/**
 * Rail classification and rail-correct custody claims for `/custody` (#2106).
 *
 * WHY THIS IS NOT IN `page.tsx`. It started there, and the production build
 * rejected the file outright:
 *
 *     Type error: Page "src/app/(authenticated)/custody/page.tsx" does not
 *     match the required types of a Next.js Page.
 *
 * Next's App Router type-checks a page MODULE, not just its default export: a
 * `page.tsx` may export `default` plus a fixed set of route conventions
 * (`metadata`, `dynamic`, `revalidate`, …) and nothing else. `railOf` and
 * `havenCannotLines` were arbitrary named exports, added so the tests could
 * assert against the same predicates the page renders from — which is the
 * right instinct and the wrong file.
 *
 * `tsc --noEmit` does NOT catch this. `npm run typecheck` passed green while
 * `next build` failed, because the page-module constraint lives in Next's
 * generated route types rather than in the app's own tsconfig graph. So the
 * only local signal is a real production build.
 */

import { type UserSafe } from '@/context/AuthContext'

export type CustodyRail = 'delegation' | 'safe'

/**
 * The rail marker (#1069): `'delegator_hybrid'` is the delegation rail, and
 * anything else — including the `null` a legacy row carries, and the `'safe'`
 * the DB actually stores — is a legacy Safe.
 *
 * Exhaustive by construction: migration `041_hybrid_accounts` constrains
 * `account_type` to `CHECK (account_type IN ('safe','delegator_hybrid'))`, so
 * the two-way split covers every value the column can hold. The frontend type
 * widens to `string | null` for defensiveness only.
 */
export function railOf(safe: Pick<UserSafe, 'account_type'>): CustodyRail {
  return safe.account_type === 'delegator_hybrid' ? 'delegation' : 'safe'
}

/**
 * Two of the four "What Haven cannot do" claims are rail-independent; two are
 * not, and stating one rail's version to the other rail's user is exactly the
 * defect #2106 is about.
 */
const SHARED_CANNOT = [
  'Move your funds — every transfer needs your or your agent’s key signature; Haven only relays and pays gas.',
  'Hold your keys — no private keys, seed phrases, or agent keys are stored by Haven.',
]

const RAIL_CANNOT: Record<CustodyRail, string[]> = {
  delegation: [
    // "Caveat enforcers" was cut on design review (#2106): it is MetaMask
    // Delegation-Framework internals, undefined anywhere on the page, and the
    // claim stands without it.
    'Expand an agent’s budget without a new delegation you sign.',
    'Block you — you can stop any agent’s budget on-chain, and your account’s signers act without Haven.',
  ],
  safe: [
    'Expand an agent’s allowance without a Safe transaction you sign.',
    'Block you — you can manage this Safe from any Safe-compatible app and revoke agents on-chain.',
  ],
}

const RAIL_PREFIX: Record<CustodyRail, string> = {
  delegation: 'On your Haven account: ',
  safe: 'On your legacy Safe: ',
}

/**
 * The rail-specific pair is chosen from the rails actually present in the
 * account list, and labelled only when both are — so a single-rail user (the
 * ordinary case) still reads four unlabelled lines.
 *
 * With no accounts yet, the delegation rail is the only one a user can land
 * on — the Safe rail's four inflows have answered 410 since #1984 — so that is
 * the branch an empty list gets. Not a third "unknown rail" state.
 */
export function havenCannotLines(safes: Pick<UserSafe, 'account_type'>[]): string[] {
  const rails = new Set<CustodyRail>(safes.map(railOf))
  if (rails.size === 0) rails.add('delegation')
  const label = rails.size > 1
  const railLines = (['delegation', 'safe'] as const)
    .filter((rail) => rails.has(rail))
    .flatMap((rail) => RAIL_CANNOT[rail].map((line) => (label ? RAIL_PREFIX[rail] + line : line)))
  return [...SHARED_CANNOT, ...railLines]
}
