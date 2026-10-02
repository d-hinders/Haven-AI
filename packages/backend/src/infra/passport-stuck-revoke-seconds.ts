/**
 * `PASSPORT_STUCK_REVOKE_SECONDS` (#3514) — lifted into its own module so
 * `routes/ops.ts` (whose transitive imports the ops invariant-1 walk bounds,
 * and which must not reach `index.ts`) and `index.ts` read ONE constant. The
 * alarm threshold itself is #973's; only the shared home is new.
 *
 * A revoke still unreconciled after this long is an incident, not a retry.
 */

/** A revoke still unreconciled after this long is an incident, not a retry (#973). */
export const PASSPORT_STUCK_REVOKE_SECONDS = 60 * 60
