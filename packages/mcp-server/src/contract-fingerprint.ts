/**
 * #3816 — the hosted CONTRACT FINGERPRINT.
 *
 * A client that connected before a hosted deploy keeps the `tools/list` it
 * loaded, and the stateless transport (`sessionIdGenerator: undefined`,
 * `http.ts`) gives the server no way to push `notifications/tools/list_changed`.
 * The fingerprint is the stale-list DETECTOR: a short hash over exactly what
 * `tools/list` advertises for each hosted tool (name, the SDK's converted
 * input schema, description), computed at boot and carried in three places —
 * `HOSTED_INSTRUCTIONS` (delivered at `initialize`, so a client that loaded
 * the list BEFORE a deploy still has a fingerprint to compare against), every
 * tool result's JSON payload, and the SDK-generated refusals the CallTool
 * wrapper annotates (`server.ts`). The version alone cannot serve: a
 * promotion can ship a contract change without a version bump.
 *
 * The hash EXCLUDES the instructions (they carry the fingerprint, and they
 * depend on `HOSTED_CONNECTOR_CHANNEL`), so a dev and a prod server built from
 * the same source advertise the same fingerprint.
 *
 * It is computed from the same conversion the SDK's `tools/list` handler runs
 * — `normalizeObjectSchema` + `toJsonSchemaCompat` with the SDK's own options
 * — never a second converter, and `contract-fingerprint.test.ts` proves the
 * two agree by recomputing the hash from a real `tools/list` over an
 * `InMemoryTransport`.
 */
import { createHash } from 'node:crypto'
import { normalizeObjectSchema, objectFromShape } from '@modelcontextprotocol/sdk/server/zod-compat.js'
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js'
import { z } from 'zod/v3'
import { toolDescriptions, toolSchemas, type HostedToolName } from './tools.js'
import { toolInputSchema } from './tools/registry.js'

/** One row of what `tools/list` advertises, in wire shape. */
export interface HostedToolAdvertisement {
  name: string
  description: string
  inputSchema: unknown
}

/**
 * The SDK's fallback for a tool whose registered input schema is not an object
 * schema — byte-identical to the private `EMPTY_OBJECT_JSON_SCHEMA` in the
 * SDK's `McpServer` (`dist/esm/server/mcp.js`), which is what its `tools/list`
 * handler emits for an empty raw shape. Pinned against the real wire response
 * in `contract-fingerprint.test.ts`.
 */
const EMPTY_OBJECT_JSON_SCHEMA = { type: 'object', properties: {} }

/**
 * What `tools/list` advertises for one hosted tool, derived through the SDK's
 * OWN conversion — the exact calls its `ListToolsRequestSchema` handler makes
 * (`normalizeObjectSchema`, then `toJsonSchemaCompat` with `strictUnions` +
 * `pipeStrategy: 'input'`), applied to the schema AS REGISTERED. The SDK's
 * `registerTool` wraps a raw shape via `getZodSchemaObject` → `objectFromShape`
 * before storing it, so an empty shape converts to the zod4-mini object (with
 * `$schema`) rather than a bare constant — mirroring that wrap here, instead
 * of converting the shape raw, is what makes the two agree byte for byte.
 */
export function hostedToolAdvertisement(name: HostedToolName): HostedToolAdvertisement {
  const schemaOrShape = toolInputSchema(name)
  const isSchema = typeof (schemaOrShape as { safeParse?: unknown }).safeParse === 'function'
  const registered = isSchema
    ? (schemaOrShape as z.ZodTypeAny)
    : objectFromShape(schemaOrShape as z.ZodRawShape)
  const obj = normalizeObjectSchema(registered)
  return {
    name,
    description: toolDescriptions[name],
    inputSchema: obj
      ? toJsonSchemaCompat(obj, { strictUnions: true, pipeStrategy: 'input' })
      : EMPTY_OBJECT_JSON_SCHEMA,
  }
}

/**
 * Canonical, sorted-key serialisation: object keys sorted, `undefined`-valued
 * keys dropped, arrays and scalars verbatim. Same discipline as the replay-key
 * canonicalisation in `tools/plain-http-x402.ts`; local here so the fingerprint
 * does not reach into a capability module.
 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/**
 * 16 hex over the canonical serialisation of the advertisement rows — the
 * short-hash convention (`contracts.ts`, the surface-hash note). Sorted by
 * tool name so registration order cannot move it; canonicalised so key order
 * in the converted schemas cannot either. Accepts WIRE rows too: the
 * transport test feeds it a real `tools/list` response and expects the same
 * value the boot-time constant holds.
 */
export function computeContractFingerprint(
  tools: ReadonlyArray<{
    name: string
    description?: string
    inputSchema?: unknown
  }>,
): string {
  const canonical = canonicalJson(
    [...tools]
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((tool) => ({
        name: tool.name,
        description: tool.description ?? '',
        inputSchema: tool.inputSchema ?? null,
      })),
  )
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16)
}

/**
 * The boot-time fingerprint over the hosted registry. Module-level: it must
 * be identical across fresh module loads, and `HOSTED_INSTRUCTIONS` — a static
 * export — embeds it, so it is computed once at import, not per server build.
 */
export const HOSTED_CONTRACT_FINGERPRINT = computeContractFingerprint(
  (Object.keys(toolSchemas) as HostedToolName[]).map(hostedToolAdvertisement),
)
