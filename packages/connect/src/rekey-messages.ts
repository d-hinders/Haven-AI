/**
 * Refusal prose shared between the argument parser and the re-key
 * implementation (#2187).
 *
 * Both layers legitimately refuse a `--rekey-finish` with no new API key, and
 * neither is redundant:
 *
 * - `args.ts` refuses the bad INVOCATION at parse time, before anything is read
 *   from disk — the #1161 fail-early ordering this package holds to elsewhere.
 * - `rekey.ts` refuses the bad CALL whoever made it. `startRekey` and
 *   `finishRekey` share one `RekeyOptions`, so `newApiKey` is optional in the
 *   type only because phase one does not take one; for `finishRekey` it is
 *   required in practice, and this is what makes that contract honest at
 *   runtime. `rekey.test.ts` calls the function directly, and a plain-JS caller
 *   could pass `undefined` past any type we could write.
 *
 * What was NOT legitimate was two copies of the sentence, with nothing pinning
 * them together — edit one and they drift silently, and the copy a user
 * actually sees is the parser's.
 *
 * This module deliberately imports nothing: `args.ts` is loaded on every CLI
 * invocation while `rekey.ts` is dynamically imported only for `--rekey`, so a
 * shared home with any dependency of its own would pull the re-key graph into
 * the parse path and defeat that lazy load.
 */
export const REKEY_FINISH_NEEDS_API_KEY =
  '--rekey-finish needs --api-key <key> — the one the Haven agent page showed once.'
