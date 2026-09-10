/**
 * #2807 — the hosted-MCP REGISTRATION seam, extracted from `tools.ts`.
 *
 * `toolInputSchema` is what `server.ts` hands `registerTool` (raw shape for a
 * permissive tool, `.strict()` ZodObject for a strict one), and
 * `strictRefusalMessage` is the refusal text both registration and
 * `parseStrict` read, so the two layers cannot drift.
 *
 * `assertHostedToolRegistry` is the RUNTIME TWIN of the compile-time
 * exhaustiveness guards. Each registry failure mode is caught at compile time
 * by a mechanism tsc sees:
 *
 *   missing schema        -> `Record<HostedToolName, z.ZodRawShape>` annotation
 *                            on `toolSchemas` (TS2739, property missing)
 *   missing description   -> `Record<HostedToolName, string>` annotation on
 *                            `toolDescriptions` (TS2739)
 *   missing input-policy  -> `_everyHostedToolCarriesAnInputDecision` in
 *                            `contracts.ts` ({ undecided: 'name' } is not
 *                            assignable to true; names the tool, #2349)
 *   missing handler       -> the `HostedToolHandlers` return annotation on
 *                            `createToolHandlers` (TS2741 for a single missing
 *                            tool, TS2739 for two or more). NOTE the direction:
 *                            this catches a tool with NO owner. A tool owned
 *                            TWICE — a key in the facade's literal shadowing
 *                            one a capability module already spreads in — is
 *                            NOT a compile error, because TS1117 does not
 *                            reach across a spread; the disjointness
 *                            assertion in
 *                            `tools/support/shared-helper-ownership.test.ts`
 *                            is what catches that (#2809)
 *   duplicated ownership  -> TS1117, an object literal cannot have multiple
 *                            properties with the same name, for a duplicated
 *                            entry within one ownership map; and
 *                            `_noHostedToolIsDecidedTwice` (TS2322) for a tool
 *                            decided on BOTH input-policy lists
 *
 * vitest does not type-check and tsc does not see a registry assembled at
 * import time, so a guard only one of the two instruments can see is half a
 * guard (#2349's rule). The twin below fails at runtime and NAMES the
 * offending tool. `buildHostedMcpServer` calls it on every server build.
 */
import { z } from 'zod/v3'
import {
  toolDescriptions,
  toolSchemas,
  STRICT_INPUT_TOOLS,
  PERMISSIVE_INPUT_TOOLS,
  type HostedToolName,
  type StrictInputToolName,
} from './contracts.js'

function isStrictInputTool(name: HostedToolName): name is StrictInputToolName {
  return Object.prototype.hasOwnProperty.call(STRICT_INPUT_TOOLS, name)
}

/**
 * The input schema `server.ts` registers for a tool.
 *
 * A raw shape for a permissive tool (what the SDK has always been given), and a
 * `.strict()` `ZodObject` for a tool on the strict list. Both advertise the same
 * JSON Schema; only the enforcement differs. Note the registration API matters:
 * the deprecated `.tool(name, description, schema, handler)` overload refuses a
 * `ZodObject` in its schema position ("received an unrecognized object"), so
 * `server.ts` uses `registerTool`, which passes a Zod schema through intact.
 */
export function toolInputSchema(name: HostedToolName): z.ZodRawShape | z.ZodTypeAny {
  if (!isStrictInputTool(name)) return toolSchemas[name]
  return z.object(toolSchemas[name]).strict(strictRefusalMessage(name))
}

export function strictRefusalMessage(name: StrictInputToolName, keys?: readonly string[]): string {
  const subject = keys && keys.length > 0
    ? `${name} does not accept ${keys.map((k) => `"${k}"`).join(', ')}.`
    : `${name} refuses an argument it does not declare.`
  return (
    `${subject} That is deliberate rather than an omission: ${STRICT_INPUT_TOOLS[name]} ` +
    'Send only the fields this tool declares.'
  )
}

export type HostedToolRegistryIssueKind =
  | 'missing-schema'
  | 'missing-description'
  | 'missing-input-policy'
  | 'missing-handler'
  | 'duplicate-ownership'

export interface HostedToolRegistryIssue {
  kind: HostedToolRegistryIssueKind
  tool: HostedToolName
}

const ISSUE_TEXT: Record<HostedToolRegistryIssueKind, string> = {
  'missing-schema': 'advertises no JSON schema',
  'missing-description': 'advertises no description',
  'missing-input-policy': 'carries no strict/permissive input-policy decision',
  'missing-handler': 'has no registered handler',
  'duplicate-ownership': 'is owned more than once',
}

/**
 * The registry the completeness twin reads, as ENTRY LISTS rather than maps.
 *
 * Entries, not `Record`s, because a duplicated object-literal key collapses
 * last-wins at construction: by the time a map exists, the duplicate is
 * invisible to `Object.keys`. An entries list preserves it, so the twin can
 * see — and name — a tool an ownership map lists twice. The compile-time
 * counterpart of that case is TS1117 on the source literal.
 */
export type HostedToolRegistryEntries = ReadonlyArray<readonly [HostedToolName, unknown]>

export interface HostedToolRegistryInputs {
  schemas: HostedToolRegistryEntries
  descriptions: HostedToolRegistryEntries
  strictInputTools: HostedToolRegistryEntries
  permissiveInputTools: HostedToolRegistryEntries
  handlers: HostedToolRegistryEntries
}

/**
 * Collect every registry failure mode tsc cannot see, naming the offending
 * tool. Ownership duplication is measured two ways: a tool listed twice within
 * one ownership map, and a tool claimed by BOTH input-policy lists — the
 * #2349 double-decision, whose compile-time twin is
 * `_noHostedToolIsDecidedTwice`.
 */
export function findHostedToolRegistryIssues(
  inputs: HostedToolRegistryInputs,
): HostedToolRegistryIssue[] {
  const schemas = countNames(inputs.schemas)
  const descriptions = countNames(inputs.descriptions)
  const strict = countNames(inputs.strictInputTools)
  const permissive = countNames(inputs.permissiveInputTools)
  const handlers = countNames(inputs.handlers)
  const names = new Set<HostedToolName>([
    ...schemas.keys(),
    ...descriptions.keys(),
    ...strict.keys(),
    ...permissive.keys(),
    ...handlers.keys(),
  ])
  const issues: HostedToolRegistryIssue[] = []
  for (const name of names) {
    if (!schemas.has(name)) issues.push({ kind: 'missing-schema', tool: name })
    if (!descriptions.has(name)) issues.push({ kind: 'missing-description', tool: name })
    if (!strict.has(name) && !permissive.has(name)) {
      issues.push({ kind: 'missing-input-policy', tool: name })
    }
    if (!handlers.has(name)) issues.push({ kind: 'missing-handler', tool: name })
    if (strict.has(name) && permissive.has(name)) {
      issues.push({ kind: 'duplicate-ownership', tool: name })
    }
  }
  // Within-unit duplicates: an ownership map listing the same tool twice.
  // Impossible in a shipped object literal (keys collapse), reachable through
  // the injectable entries this function accepts — which is how the mutation
  // proof drives it.
  for (const count of [schemas, descriptions, strict, permissive, handlers]) {
    for (const [name, n] of count) {
      if (n > 1) issues.push({ kind: 'duplicate-ownership', tool: name })
    }
  }
  return issues
}

function countNames(entries: HostedToolRegistryEntries): Map<HostedToolName, number> {
  const counts = new Map<HostedToolName, number>()
  for (const [name] of entries) {
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  return counts
}

/**
 * The production view: the shipped contract maps plus the handlers about to be
 * registered. The pure `findHostedToolRegistryIssues` above exists so the
 * runtime twin can be driven against deliberately broken registry inputs in
 * tests; production callers go through here or `assertHostedToolRegistry`.
 */
export function findHostedToolRegistryIssuesFor(
  handlers: Partial<Record<HostedToolName, unknown>>,
): HostedToolRegistryIssue[] {
  return findHostedToolRegistryIssues({
    schemas: Object.entries(toolSchemas) as HostedToolRegistryEntries,
    descriptions: Object.entries(toolDescriptions) as HostedToolRegistryEntries,
    strictInputTools: Object.entries(STRICT_INPUT_TOOLS) as HostedToolRegistryEntries,
    permissiveInputTools: Object.entries(PERMISSIVE_INPUT_TOOLS) as HostedToolRegistryEntries,
    handlers: Object.entries(handlers) as HostedToolRegistryEntries,
  })
}

/**
 * Fail loud: throw an Error naming every offending tool and failure mode.
 * `buildHostedMcpServer` calls this before registration so an incomplete
 * registry cannot boot.
 */
export function assertHostedToolRegistry(
  handlers: Partial<Record<HostedToolName, unknown>>,
): void {
  const issues = findHostedToolRegistryIssuesFor(handlers)
  if (issues.length > 0) {
    const detail = issues
      .map((issue) => `  - ${issue.tool} ${ISSUE_TEXT[issue.kind]} (${issue.kind})`)
      .join('\n')
    throw new Error(`Hosted MCP tool registry is incomplete:\n${detail}`)
  }
}
