/**
 * The retired Safe-vocabulary REQUEST names (#2914, naming epic #2906 phase 5).
 *
 * #2907 added an `account`-named twin beside every `safe`-named query
 * parameter and body field, and both were accepted for one release. The
 * contraction drops the old names — but dropping a name is not enough on its
 * own, and that is the whole reason this file exists rather than a few
 * deleted lines.
 *
 * **Fastify ignores a key it was not told about.** Deleting `safeId` from a
 * querystring type does not make `?safeId=<uuid>` an error; it makes it
 * nothing. The filter silently stops filtering and the response carries every
 * row the user owns instead of one account's. The same shape applies to a
 * body field: an ignored `safe_id` on `POST /agents` creates an UNLINKED
 * agent that looks successfully created, and the caller finds out when a
 * payment has nothing to spend from.
 *
 * So the old names stay DECLARED and are REFUSED with a 400 that names the
 * replacement — the same "loudly, typed" bar the `/user/safes` path
 * tombstones meet, and the epic's stated acceptance criterion for an old
 * client meeting a new server.
 *
 * Both bodies carry `replacement` as a field, not only in prose, so a client
 * can route on it without parsing a sentence.
 */

/**
 * Decide what to do with a retired request name, given BOTH values.
 *
 * Refusing on presence alone was wrong, and the way it was wrong is worth
 * keeping written down. #2908 told every published client to send both names
 * for the window — `@haven_ai/cli` on `latest` does exactly that
 * (`params.set('accountId', id); params.set('safeId', id)` and
 * `{ account_id: id, safe_id: id }`). A presence check fires before the new
 * name is ever read, so the contraction would have 400'd the clients that
 * followed the migration instruction most faithfully, on `activity list`,
 * `activity export` and `agents connect`.
 *
 * So the rule is about what the caller is RELYING on:
 *
 *  - retired name alone  → refuse. That caller has not migrated, and ignoring
 *    it would silently widen a filter or unlink an agent.
 *  - both, same value    → accept, read the new one. This is the dual-send
 *    #2908 mandated; it is a migrated client, not a stale one.
 *  - both, different     → refuse. Two different answers to one question is a
 *    caller bug, and picking either silently would hide it (the #2907 rule,
 *    kept).
 *
 * The acceptance bar is unchanged: a client that only knows the old name
 * still fails loudly and typed. What changes is that a client which knows
 * both no longer does.
 */
export type RetiredNameVerdict =
  | { kind: 'ok' }
  | { kind: 'refuse'; reason: 'retired-only' | 'disagree' }

export function retiredNameVerdict(
  retiredValue: string | undefined,
  currentValue: string | undefined,
): RetiredNameVerdict {
  if (retiredValue === undefined) return { kind: 'ok' }
  if (currentValue === undefined) return { kind: 'refuse', reason: 'retired-only' }
  if (retiredValue !== currentValue) return { kind: 'refuse', reason: 'disagree' }
  return { kind: 'ok' }
}

function disagreementNote(oldName: string, newName: string): string {
  return (
    `\`${oldName}\` and \`${newName}\` were both sent with different values. ` +
    'Send only the new name, or make them match — picking one silently would hide the mismatch.'
  )
}

/** The 400 body for a request relying on a retired QUERY parameter. */
export function retiredSafeQuery(
  oldName: string,
  newName: string,
  reason: 'retired-only' | 'disagree' = 'retired-only',
): { error: string; replacement: string } {
  return {
    error:
      reason === 'disagree'
        ? disagreementNote(oldName, newName)
        : `The \`${oldName}\` query parameter is retired (#2906) — Haven accounts are addressed ` +
          `as accounts, not Safes. Use \`${newName}\`, which takes the same value. Refusing ` +
          'rather than ignoring the parameter, because an ignored filter returns every row ' +
          'instead of none and looks like a successful query.',
    replacement: newName,
  }
}

/** The 400 body for a request relying on a retired BODY field. */
export function retiredSafeField(
  oldName: string,
  newName: string,
  reason: 'retired-only' | 'disagree' = 'retired-only',
): { error: string; replacement: string } {
  return {
    error:
      reason === 'disagree'
        ? disagreementNote(oldName, newName)
        : `The \`${oldName}\` field is retired (#2906) — Haven accounts are addressed as ` +
          `accounts, not Safes. Send \`${newName}\` instead, with the same value. Refusing ` +
          'rather than ignoring the field, because an ignored field is indistinguishable ' +
          'from one that was never sent.',
    replacement: newName,
  }
}
