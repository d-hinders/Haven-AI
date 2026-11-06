/**
 * Do two env values denote the SAME private key?
 *
 * Compared on the key's VALUE, not its text. The threat is an operator pasting
 * one key into two variables, and a paste routinely differs in casing or the
 * `0x` prefix while being cryptographically identical — a text comparison would
 * wave exactly the mistake it exists to catch straight through.
 *
 * Lives here rather than in `modules/passport/receipt.ts`, where it was written
 * for the receipt-key collision check (#974): #4655's binding-key refusal is in
 * `infra/`, and the dependency-boundary lint forbids an `infra/` file importing a
 * module's private file (`no-deep-cross-module-import`), while importing the
 * passport barrel would pull the whole module into the boot path. One
 * implementation, two callers. `modules/passport/receipt.ts` re-exports it so the
 * receipt module's public surface is unchanged.
 */
export function sameKey(a: string, b: string): boolean {
  const normalize = (k: string) => k.trim().toLowerCase().replace(/^0x/, '')
  return normalize(a) === normalize(b)
}
