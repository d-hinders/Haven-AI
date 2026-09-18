/**
 * Shadow mode's remaining promise, asserted rather than coincidental (#3135,
 * epic #3028 slice 2 item 0; partner review finding S5).
 *
 * The plugin injects the spec's schema on EVERY route, shadow included, and
 * `REQUEST_AJV_OPTIONS` sets `coerceTypes: 'array'` + `useDefaults: true`.
 * ajv applies both IN PLACE, so validating for measurement can rewrite the
 * payload the handler then reads.
 *
 * Half of that is already closed in code: #3082 snapshots and restores the
 * request BODY, and counts a body coercion made valid as `would_coerce`.
 * The other half is deliberately left open — querystring and params arrive as
 * strings on the wire, so coercion is what makes a typed spec parameter usable
 * at all, and the handler is MEANT to see the coerced value. That half rested
 * on a hand-check ("all the defaults agree with their handler fallbacks
 * today") written in a comment. A hand-check is not an invariant: the next
 * `default:` added to the spec silently changes what a handler receives the
 * moment its module is flipped, in every slice of epic #3028 that follows.
 *
 * So this file pins the two sets. A new request-side `default:`, or a new
 * non-string query/path parameter, reddens it until somebody writes the row —
 * which is the review step, not the test.
 *
 * MEASURED, not asserted from the epic: the epic body says 13 defaults and 18
 * coerced params. Walking the SERVED spec object at `b16be14` finds 11 and 13.
 * The tables below are the measurement; the epic's figures were a text walk.
 */
import { describe, expect, it } from 'vitest'
import { openapiSpec } from '../spec.js'
import { REQUEST_AJV_OPTIONS } from '../ajv.js'

type Json = Record<string, any>

const spec = openapiSpec as unknown as { paths: Record<string, Json> }

/**
 * Every request-side `default:` the served spec declares, as
 * `'<METHOD> <path> <in>:<name>' → default`. Walks the operation's and the
 * path item's `parameters` (query/path only, as the plugin does) and the JSON
 * request body, following `$ref`s — a text walk over `spec.ts` misses
 * constraints carried by reused TS consts.
 */
function requestSideDefaults(): Record<string, unknown> {
  const found: Record<string, unknown> = {}
  for (const [path, item] of Object.entries(spec.paths)) {
    const pathParameters: Json[] = Array.isArray(item.parameters) ? item.parameters : []
    for (const [method, operation] of Object.entries<Json>(item)) {
      if (method === 'parameters' || !operation || typeof operation !== 'object') continue
      const route = `${method.toUpperCase()} ${path}`
      for (const parameter of [...pathParameters, ...(operation.parameters ?? [])]) {
        if (!parameter || (parameter.in !== 'query' && parameter.in !== 'path')) continue
        const schema = parameter.schema ?? { type: 'string' }
        if (schema.default !== undefined) {
          found[`${route} ${parameter.in}:${parameter.name}`] = schema.default
        }
      }
      walkBody(operation.requestBody?.content?.['application/json']?.schema, `${route} body`, found)
    }
  }
  return found
}

function walkBody(schema: Json | undefined, where: string, found: Record<string, unknown>, depth = 0): void {
  if (!schema || typeof schema !== 'object' || depth > 12) return
  if (schema.$ref) {
    const name = String(schema.$ref).replace('#/components/schemas/', '')
    const resolved = (openapiSpec as unknown as { components: { schemas: Record<string, Json> } })
      .components.schemas[name]
    return walkBody(resolved, where, found, depth + 1)
  }
  if (schema.default !== undefined) found[where] = schema.default
  for (const [key, value] of Object.entries<Json>(schema.properties ?? {})) {
    walkBody(value, `${where}/${key}`, found, depth + 1)
  }
  walkBody(schema.items, `${where}[]`, found, depth + 1)
}

/** Every query/path parameter ajv will COERCE — i.e. typed as anything but a string. */
function coercionTargets(): Record<string, string> {
  const found: Record<string, string> = {}
  for (const [path, item] of Object.entries(spec.paths)) {
    const pathParameters: Json[] = Array.isArray(item.parameters) ? item.parameters : []
    for (const [method, operation] of Object.entries<Json>(item)) {
      if (method === 'parameters' || !operation || typeof operation !== 'object') continue
      for (const parameter of [...pathParameters, ...(operation.parameters ?? [])]) {
        if (!parameter || (parameter.in !== 'query' && parameter.in !== 'path')) continue
        const schema = parameter.schema ?? { type: 'string' }
        if (schema.type && schema.type !== 'string') {
          found[`${method.toUpperCase()} ${path} ${parameter.in}:${parameter.name}`] = schema.type
        }
      }
    }
  }
  return found
}

/**
 * The spec default paired with the value the handler falls back to when the
 * parameter is ABSENT. They must be equal: under `useDefaults`, ajv injects
 * the spec value before the handler runs, so a disagreement means flipping
 * that module changes the handler's answer for a request that omits the
 * parameter — silently, and on the money path in slices 3 and 4.
 */
const DEFAULT_VS_HANDLER_FALLBACK: Record<string, { spec: unknown; handler: unknown; site: string }> = {
  'GET /agent-activity/{id}/activity query:limit': { spec: 30, handler: 30, site: 'routes/agent-activity.ts — `Number(query.limit) || 30`' },
  'GET /agent-activity/{id}/activity query:offset': { spec: 0, handler: 0, site: 'routes/agent-activity.ts — `Number(query.offset) || 0`' },
  'GET /agent-activity/feed query:limit': { spec: 30, handler: 30, site: 'routes/agent-activity.ts — `Number(query.limit) || 30`' },
  'GET /agent-activity/feed query:offset': { spec: 0, handler: 0, site: 'routes/agent-activity.ts — `Number(query.offset) || 0`' },
  'GET /analytics/overview query:currency': { spec: 'usd', handler: 'usd', site: "routes/analytics-overview.ts — `(currencyParam ?? 'usd').toLowerCase()`" },
  'GET /analytics/overview query:tz': { spec: 'UTC', handler: 'UTC', site: "routes/analytics-overview.ts — `tzParam ?? 'UTC'`" },
  'GET /machine-payments/receipts query:limit': { spec: 25, handler: 25, site: 'routes/machine-payments.ts — `query.limit ? Number(query.limit) : 25`' },
  'GET /transactions query:limit': { spec: 25, handler: 25, site: 'routes/transactions.ts — `parsePositiveInt(query.limit, 25, 1, 100)`' },
  'GET /transactions query:offset': { spec: 0, handler: 0, site: 'routes/transactions.ts — `parsePositiveInt(query.offset, 0, 0, MAX_SAFE_INTEGER)`' },
  'GET /transactions/{accountAddress} query:limit': { spec: 25, handler: 25, site: 'routes/transactions.ts — `parsePositiveInt(query.limit, 25, 1, 100)`' },
  'GET /transactions/{accountAddress} query:page': { spec: 1, handler: 1, site: 'routes/transactions.ts — `parsePositiveInt(query.page, 1, 1, MAX_SAFE_INTEGER)`' },
}

/**
 * Every parameter ajv coerces, with the type the handler reads it as. Each
 * handler reads these through `Number(...)`/`parsePositiveInt(...)`, which
 * accept the coerced number as readily as the wire string — so coercion is a
 * no-op for them, which is exactly the claim being pinned.
 */
const COERCION_TARGETS: Record<string, string> = {
  'GET /agent-activity/{id}/activity query:limit': 'integer',
  'GET /agent-activity/{id}/activity query:offset': 'integer',
  'GET /agent-activity/feed query:limit': 'integer',
  'GET /agent-activity/feed query:offset': 'integer',
  'GET /balances/{accountAddress} query:chain_id': 'integer',
  'GET /machine-payments/receipts query:limit': 'integer',
  'GET /portfolio/{accountAddress} query:chain_id': 'integer',
  'GET /transactions query:limit': 'integer',
  'GET /transactions query:offset': 'integer',
  'GET /transactions/export.csv query:chainId': 'integer',
  'GET /transactions/{accountAddress} query:chain_id': 'integer',
  'GET /transactions/{accountAddress} query:limit': 'integer',
  'GET /transactions/{accountAddress} query:page': 'integer',
}

describe('shadow-mutation invariants (#3135, partner finding S5)', () => {
  it('the ajv options that make this file necessary are still set', () => {
    // If either of these is ever turned off, the invariant below stops being
    // load-bearing and this file should be re-read rather than left passing.
    expect(REQUEST_AJV_OPTIONS.useDefaults).toBe(true)
    expect(REQUEST_AJV_OPTIONS.coerceTypes).toBe('array')
  })

  it('every request-side `default:` in the served spec has a reviewed row', () => {
    expect(Object.keys(requestSideDefaults()).sort()).toEqual(
      Object.keys(DEFAULT_VS_HANDLER_FALLBACK).sort(),
    )
  })

  it('every spec default EQUALS the handler fallback for that parameter', () => {
    const measured = requestSideDefaults()
    for (const [key, row] of Object.entries(DEFAULT_VS_HANDLER_FALLBACK)) {
      expect(measured[key], `${key} — spec default drifted`).toEqual(row.spec)
      expect(row.handler, `${key} — ${row.site}`).toEqual(row.spec)
    }
  })

  it('NO request BODY declares a default — ajv would inject it into a payload', () => {
    // The restore in #3082 undoes a body coercion, and a `useDefaults`
    // injection is a body rewrite of exactly the same kind. None exists today;
    // this is what says so out loud rather than in a comment.
    const bodyDefaults = Object.keys(requestSideDefaults()).filter((k) => k.includes(' body'))
    expect(bodyDefaults).toEqual([])
  })

  it('every coerced query/path parameter has a reviewed row', () => {
    expect(coercionTargets()).toEqual(COERCION_TARGETS)
  })

  it('CONTROL: the walk can find a default and a coercion target at all', () => {
    // The instrument proves it says yes before its no is worth anything
    // (#2444). These two are known-present rows drawn from different modules.
    expect(requestSideDefaults()['GET /transactions query:limit']).toBe(25)
    expect(coercionTargets()['GET /transactions query:limit']).toBe('integer')
    expect(Object.keys(requestSideDefaults()).length).toBeGreaterThan(0)
  })
})
