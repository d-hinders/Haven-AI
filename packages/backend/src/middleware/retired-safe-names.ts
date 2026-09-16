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

/** The 400 body for a request still sending a retired QUERY parameter. */
export function retiredSafeQuery(
  oldName: string,
  newName: string,
): { error: string; replacement: string } {
  return {
    error:
      `The \`${oldName}\` query parameter is retired (#2906) — Haven accounts are addressed ` +
      `as accounts, not Safes. Use \`${newName}\`, which takes the same value. Refusing ` +
      'rather than ignoring the parameter, because an ignored filter returns every row ' +
      'instead of none and looks like a successful query.',
    replacement: newName,
  }
}

/** The 400 body for a request still sending a retired BODY field. */
export function retiredSafeField(
  oldName: string,
  newName: string,
): { error: string; replacement: string } {
  return {
    error:
      `The \`${oldName}\` field is retired (#2906) — Haven accounts are addressed as ` +
      `accounts, not Safes. Send \`${newName}\` instead, with the same value. Refusing ` +
      'rather than ignoring the field, because an ignored field is indistinguishable ' +
      'from one that was never sent.',
    replacement: newName,
  }
}
