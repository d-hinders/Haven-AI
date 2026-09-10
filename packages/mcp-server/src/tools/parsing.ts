/**
 * #2807 — hosted-MCP argument PARSING, extracted verbatim from `tools.ts`.
 *
 * `parse` is the permissive raw-shape parse; `parseStrict` is the
 * unknown-keys-REFUSED second line of defence behind the strict registration
 * schema (#2292/#2312 — its docstring below records the measured wire
 * behaviour that fixed its layer).
 *
 * `HostedToolError` stays in `tools.ts` (#2808 owns its move to shared safety
 * support). To keep the refusal a single class — duplicating it here would
 * fork `normalizeError`'s instanceof branch — the throw site is injected:
 * `tools.ts` calls `setStrictRefusalThrower` at module load and `parseStrict`
 * throws through it. The default below keeps the structured fields on a plain
 * Error and exists only for direct `parsing.ts` imports that never wire the
 * real thrower (the server always wires it).
 */
import { z } from 'zod/v3'
import { toolSchemas, type HostedToolName, type StrictInputToolName } from './contracts.js'
import { strictRefusalMessage } from './registry.js'

export interface HostedStrictRefusalDetails {
  code: string
  message: string
  statusCode?: number
  status?: string
  phase?: string
}

export type StrictRefusalThrower = (details: HostedStrictRefusalDetails) => never

let strictRefusalThrower: StrictRefusalThrower = (details) => {
  const err = new Error(details.message) as Error & HostedStrictRefusalDetails
  err.name = 'HostedStrictRefusal'
  Object.assign(err, details)
  throw err
}

/** Called once by `tools.ts` at module load; wires the real HostedToolError. */
export function setStrictRefusalThrower(thrower: StrictRefusalThrower): void {
  strictRefusalThrower = thrower
}

export function parse<TName extends HostedToolName>(name: TName, input: unknown): Record<string, any> {
  return z.object(toolSchemas[name]).parse(input ?? {})
}

/**
 * #2292/#2312: `parse` with unknown keys REFUSED instead of stripped.
 *
 * `parse` above is a bare `z.object`, which silently drops anything it does
 * not recognise — the exact shape #2282 found on `mcp_transport`, where a
 * caller's argument was edited rather than validated and an unrecognised
 * input parsed to the same value as an absent one.
 *
 * **This is the SECOND line of defence, not the first, and #2292 shipped it
 * believing it was the only one.** Over the MCP transport the SDK has already
 * validated and STRIPPED the arguments before a handler is called, so an
 * unrecognised key never reaches here; the guard that actually fires on the
 * wire is the strict registration schema (`toolInputSchema`, see
 * `STRICT_INPUT_TOOLS` above for the measurement). What this still covers is
 * the direct-embedder path — `createToolHandlers` is exported from `index.ts`
 * — plus the unit tests, which call handlers directly.
 *
 * Which tools are strict, and why each, is declared once in
 * `STRICT_INPUT_TOOLS`; both layers read their refusal text from there so they
 * cannot drift into saying different things about the same tool.
 */
export function parseStrict<TName extends StrictInputToolName>(name: TName, input: unknown): Record<string, any> {
  const result = z.object(toolSchemas[name]).strict().safeParse(input ?? {})
  if (result.success) return result.data
  // TOP-LEVEL keys only. A nested strict object — `mcp_transport`, whose
  // `.strict(MCP_TRANSPORT_CASE_HINT)` explains the snake_case boundary #2282
  // found — also raises `unrecognized_keys`, at a non-empty path. Collecting
  // those here would replace that tool-specific hint with this generic one and
  // silently regress #2282's refusal message; the nested case falls through to
  // `throw result.error`, exactly as the permissive `parse` did.
  const unrecognized = result.error.issues.flatMap((issue) =>
    issue.code === 'unrecognized_keys' && issue.path.length === 0 ? issue.keys : [],
  )
  if (unrecognized.length > 0) {
    strictRefusalThrower({
      code: 'INVALID_INPUT',
      message: strictRefusalMessage(name, unrecognized),
      statusCode: 400,
      status: 'invalid_input',
      phase: 'not_started',
    })
  }
  throw result.error
}
