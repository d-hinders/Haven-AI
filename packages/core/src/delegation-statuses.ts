/**
 * The "still enabled" delegation status set (#3922, epic #3919).
 *
 * A budget delegation row is still enabled while the chain has not confirmed
 * it dead: `pending` (grant signed, activation not yet landed), `active`, and
 * `replaced` (an edit/re-key left the old row enabled on-chain until the
 * owner's Stop userop lands). Only `revoked` is dead.
 *
 * This is the TypeScript mirror of the backend's `stillEnabledDelegationSql`
 * (`packages/backend/src/infra/repositories/delegation-budgets.ts`), the
 * single SQL definition behind `live_delegation_count` and the revoke-all /
 * archive / account-delete guards. A backend test parses that SQL literal and
 * compares the SET to this constant, so the two cannot drift. Clients (the CLI
 * revoke gate, the dashboard remove dialog) use this instead of hand-copying
 * the list — it must work against an older backend, which is why it is a
 * status constant and not the wire `is_live` flag (that one means "spendable
 * budget in view", a different question).
 */
export const STILL_ENABLED_DELEGATION_STATUSES = ['pending', 'active', 'replaced'] as const

export type StillEnabledDelegationStatus = (typeof STILL_ENABLED_DELEGATION_STATUSES)[number]
