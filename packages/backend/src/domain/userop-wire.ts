/**
 * The UserOp wire encoding used by the delegation-lifecycle routes
 * (`routes/agent-delegations.ts`) — prepared and submitted as JSON bodies.
 *
 * Prepared ERC-4337 UserOperations carry bigints, which JSON.stringify cannot
 * represent. The prepare steps serialize them with the `<digits>n` marker (the
 * format `preparedUserOperation` in `openapi/spec.ts` documents: "bigints
 * travel as '<digits>n' strings"), and the submit steps revive that marker
 * back to BigInt before the treasury relays the op. #3031 moved the two
 * encoders out of the route file: the `typeof` gauge
 * (`scripts/lint-request-schemas.mjs`) counts runtime `typeof` lines in route
 * files as hand-rolled request checks, and these were never request checks —
 * they are response/response-echo codecs that merely spelled `typeof` inside
 * a replacer. One copy here, so the wire format cannot drift between the two
 * revoke flows that share it.
 *
 * NOT the `payment_intents.prepared_user_op` codec: that is
 * `serializeUserOp`/`deserializeUserOp` in `rails/execution-rail.ts`, whose
 * `__bigint__` marker format predates and differs from this one. The two
 * formats live on different wires (a stored JSONB column vs the API's
 * user_operation bodies) and neither format ever meets the other — a value
 * encoded by one and decoded by the other fails loudly (unparseable marker /
 * bare digits), which is why the duplication is stated rather than unified.
 */

/**
 * Stringify with bigints as `<digits>n` — the wire format the prepare steps
 * hand back inside `user_operation`.
 */
export function stringifyWithBigintN(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => (typeof v === 'bigint' ? `${v}n` : v))
}

/**
 * Parse a `user_operation` body back into runtime values: every `<digits>n`
 * string the marker format produced becomes a BigInt again, everything else
 * passes through untouched. Strings that merely LOOK like the marker
 * (`"5n"` typed by a caller into an unrelated field) revive too — the
 * treasury op is re-derived from server state and re-verified before relay,
 * so the submit path treats the body as transport, never as authority.
 */
export function reviveBigintN(json: unknown): unknown {
  return JSON.parse(
    stringifyWithBigintN(json),
    (_key, v: unknown) =>
      typeof v === 'string' && /^\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v,
  )
}
