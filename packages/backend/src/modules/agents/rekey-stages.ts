/**
 * The re-key ordering invariant, as a state machine (#1698, epic #1694).
 *
 * > "Revoke must precede issue, never the reverse." (#1694, owner)
 *
 * Both halves are on-chain and owner-signed, so a re-key spans several
 * requests and the ordering has to hold BETWEEN them. Written as the order of
 * statements inside one handler it would hold only for a client that called
 * the handlers in order — which is not a guarantee, it is a hope about
 * clients. Written here it is a predicate every route asks before acting, and
 * the migration's CHECK constraints are the same predicate a layer down.
 *
 * Two failure postures, and the asymmetry is the entire reason for the rule:
 *
 * - **revoke-then-issue** fails to *the agent has no authority*. Recoverable
 *   — the owner re-runs the issue half — and it is the correct posture when
 *   the key is lost, because the lost key is already inert.
 * - **issue-then-revoke** fails to *two simultaneously live keys*. Nothing
 *   about that is recoverable by retrying; it is a second live credential set
 *   on a funded account, which is the failure mode this whole epic exists to
 *   remove.
 *
 * So the guard is deliberately one-directional and deliberately not
 * symmetric-looking: it is not "do these in a sensible order", it is "never
 * be in a state where two keys can spend".
 */

export const REKEY_STAGES = [
  'preflight',
  'revoked',
  'metered',
  'issued',
  'completed',
  'abandoned',
] as const

export type RekeyStage = (typeof REKEY_STAGES)[number]

/**
 * Forward-only, and the missing edges are the point.
 *
 * There is no `revoked → preflight`: the revoke landed on-chain and no row
 * update un-lands it. There is no `preflight → metered` and no
 * `preflight → issued`: skipping the revoke is exactly the ordering breach.
 * `abandoned` is reachable from every live stage because an owner may stop,
 * and a stopped re-key must be recorded rather than erased — one that got as
 * far as `revoked` left an agent with no authority, and the dashboard has to
 * be able to say so.
 */
const ALLOWED_TRANSITIONS: Record<RekeyStage, readonly RekeyStage[]> = {
  preflight: ['revoked', 'abandoned'],
  revoked: ['metered', 'abandoned'],
  metered: ['issued', 'abandoned'],
  issued: ['completed', 'abandoned'],
  completed: [],
  abandoned: [],
}

/** The stage each action requires. A route asks; it does not re-derive. */
export const STAGE_REQUIRED_FOR = {
  /** Land the owner-signed disableDelegation. */
  submitRevoke: 'preflight',
  /** Read the now-frozen meter. STRICTLY after the revoke — see below. */
  readMeter: 'revoked',
  /** Build the new delegations against the carried terms. */
  issue: 'metered',
  /** Activate them, rotate the API key, invalidate old-payer intents. */
  complete: 'issued',
} as const satisfies Record<string, RekeyStage>

export class RekeyOrderingError extends Error {
  constructor(
    readonly action: keyof typeof STAGE_REQUIRED_FOR,
    readonly actual: RekeyStage,
    readonly required: RekeyStage,
  ) {
    super(
      `re-key ordering: ${action} requires stage '${required}', but this re-key is '${actual}'. ` +
        ORDERING_EXPLANATIONS[action],
    )
    this.name = 'RekeyOrderingError'
  }
}

/**
 * Why each refusal exists, in the refusal itself. A client hitting this is
 * mid-way through a money-path operation, and "409 wrong stage" tells it
 * nothing about whether it is safe to retry.
 */
const ORDERING_EXPLANATIONS: Record<keyof typeof STAGE_REQUIRED_FOR, string> = {
  submitRevoke:
    'The revoke is the first retiring step; a re-key past it has already retired the old authority.',
  readMeter:
    'The remaining budget is read only after the revoke has landed, so the on-chain meter cannot ' +
    'move while it is being carried. Reading it earlier would over-count a payment that lands in ' +
    'the gap.',
  issue:
    'A new delegation may not be issued before the old one is revoked and its meter frozen — ' +
    'issuing first would leave two live keys, which is the one failure this ordering forbids. ' +
    'If the revoke has not landed, submit it and retry.',
  complete:
    'Credentials rotate only once the replacement delegations exist and are signed; rotating ' +
    'earlier would strand the agent with neither a working key nor a new grant.',
}

/** Throws unless `action` is legal at `actual`. */
export function assertStageAllows(
  action: keyof typeof STAGE_REQUIRED_FOR,
  actual: RekeyStage,
): void {
  const required = STAGE_REQUIRED_FOR[action]
  if (actual !== required) throw new RekeyOrderingError(action, actual, required)
}

/** True when `to` is a legal next stage from `from`. */
export function canTransition(from: RekeyStage, to: RekeyStage): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to)
}

export class RekeyTransitionError extends Error {
  constructor(from: RekeyStage, to: RekeyStage) {
    super(`re-key stage cannot move ${from} → ${to}`)
    this.name = 'RekeyTransitionError'
  }
}

export function assertTransition(from: RekeyStage, to: RekeyStage): void {
  if (!canTransition(from, to)) throw new RekeyTransitionError(from, to)
}

/** Stages at which a re-key is still holding the agent's one in-flight slot. */
export const IN_FLIGHT_STAGES: readonly RekeyStage[] = ['preflight', 'revoked', 'metered', 'issued']

/**
 * True when the agent currently has NO spend authority because of this
 * re-key. The dashboard and the doctor need to say this out loud rather than
 * let it read as a mysterious 403 (#1688's lesson about silent drift).
 */
export function leavesAgentWithoutAuthority(stage: RekeyStage): boolean {
  return stage === 'revoked' || stage === 'metered' || stage === 'issued'
}
