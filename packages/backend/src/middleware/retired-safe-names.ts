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

// ── Response twins kept for one more release (#2914 → follow-up) ──────
//
// The contraction removes the retired names from every RESPONSE, and for
// every name but two that is safe: `@haven_ai/cli@0.2.1-alpha.0`, which is
// what both `latest` and `alpha` resolve to today, reads each renamed FIELD
// new-name-first (`s.account_address ?? s.safe_address`). #2908 migrated the
// field reads. It missed two things, and independent review caught them
// against the published tarball rather than against this repo:
//
//   dist/index.js:877,891,918,1243,1363  `const { safes } = await api.get('/user/accounts')`
//   dist/index.js:1273                   `t.safeName ?? ''`
//
// The first is an ENVELOPE KEY and the second a FEED FIELD, and a published
// client can do nothing about either: unlike a request, it cannot "send
// both". Against a contracted backend the five envelope reads throw
// `Cannot read properties of undefined` and the ACCOUNT column renders blank.
//
// Why that is not just an ordering note. The backend deploys from a branch
// while the packages publish on the later `dev -> main` promotion, and per
// CLAUDE.md that promotion can be HALF GREEN — published, with `latest`
// unmoved — while a bare `npx @haven_ai/cli` resolves `latest`. So the break
// would have no bounded end, and this PR's own claim that neither side has to
// ship first would be false.
//
// So these two names, and only these two, survive one more release. The fix
// on the consumer side ships in THIS slice (`accountsEnvelope()` in
// `packages/cli/src/commands.ts`), so the next release removes them against a
// `latest` that no longer reads either. Nothing else is twinned: the request
// names are refused (above), not echoed.
//
// REMOVAL: delete both helpers and their two call sites in the release after
// the one carrying #2914, once `npm view @haven_ai/cli dist-tags` shows
// `latest` at or past that release.

/**
 * `{ accounts }` -> `{ accounts, safes }`, same array, for `GET /user/accounts`.
 *
 * @deprecated Retired name; removal is the release after #2914's.
 */
export function withRetiredAccountsEnvelopeTwin<T extends { accounts: unknown[] }>(
  body: T,
): T & { safes: T['accounts'] } {
  return { ...body, safes: body.accounts }
}

/**
 * `.accountName` -> a `.safeName` twin on one transaction row, same value.
 *
 * @deprecated Retired name; removal is the release after #2914's.
 */
export function withRetiredAccountNameTwin<T extends { accountName?: string | null }>(
  tx: T,
): T & { safeName: T['accountName'] } {
  return { ...tx, safeName: tx.accountName }
}
