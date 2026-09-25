/**
 * #3032 (epic #3028 slice 4, independent prep) — the connection-setup request
 * bodies the SHIPPED clients send, against the REAL spec and the REAL request
 * ajv the plugin installs.
 *
 * Slice 4 will enforce `routes/agent-connection-setups.ts`. Before that can
 * happen, every field today's clients send has to be declared, or enforcement
 * refuses a working connector with a 400. Four were missing:
 *
 *   - `local_mcp`            — dashboard, `useAgentConnectionSetup.ts`
 *   - `mcp_server_name`      — `@haven_ai/connect`, `api.ts` `registerSetup`
 *   - `skill_installed`      — `@haven_ai/connect`, `api.ts` `updateInstallStatus`
 *   - `superseded_agent_ids` — same; a tri-state (list / [] / null)
 *
 * Each case pairs a body that must VALIDATE with a control that must NOT (an
 * undeclared key), so a schema that stopped being closed could not pass these
 * vacuously.
 */
import { describe, expect, it } from 'vitest'
import { requestSchemaForOperation } from '../request-validation.js'
import { openapiSpec } from '../spec.js'
import { makeSpecAjv, REQUEST_AJV_OPTIONS } from '../ajv.js'

function compileBody(path: string) {
  const operation = (openapiSpec.paths as Record<string, Record<string, unknown>>)[path].post
  const schema = requestSchemaForOperation(operation as never)
  expect(schema?.body, `${path} must declare a request body`).toBeTruthy()
  const ajv = makeSpecAjv({ ...REQUEST_AJV_OPTIONS, closeObjects: false }, openapiSpec.components.schemas as never)
  return ajv.compile(schema!.body as never)
}

describe('POST /agent-connection-setups — the dashboard body (#3032)', () => {
  const validate = compileBody('/agent-connection-setups')
  const DASHBOARD = { name: 'Research agent', runtime: 'claude-code', local_mcp: true }

  it('`local_mcp` VALIDATES', () => {
    expect(validate(structuredClone(DASHBOARD)), JSON.stringify(validate.errors)).toBe(true)
  })

  it('CONTROL: an undeclared key is still refused — the schema is closed', () => {
    expect(validate({ ...DASHBOARD, not_a_field: true })).toBe(false)
  })
})

describe('POST /agent-connection-setups/register — the connector body (#3032)', () => {
  const validate = compileBody('/agent-connection-setups/register')
  const CONNECTOR = {
    setup_token: 'hv_setup_abc',
    challenge_id: '11111111-1111-4111-8111-111111111111',
    delegate_address: '0x' + 'ab'.repeat(20),
    proof_signature: '0x' + 'cd'.repeat(65),
    api_key_hash: 'ef'.repeat(32),
    api_key_prefix: 'sk_agent_1a2',
    runtime: 'claude-code',
    connector_version: '0.4.0',
    mcp_server_name: 'haven-research',
  }

  it('`mcp_server_name` VALIDATES', () => {
    expect(validate(structuredClone(CONNECTOR)), JSON.stringify(validate.errors)).toBe(true)
  })

  it('a malformed name is NOT refused by the schema — the handler normalises it to null', () => {
    // The spec must not be stricter than `normalizeMcpServerName`, which
    // stores an empty or malformed name as null rather than refusing.
    expect(validate({ ...CONNECTOR, mcp_server_name: '   ' })).toBe(true)
    expect(validate({ ...CONNECTOR, mcp_server_name: 'x'.repeat(200) })).toBe(true)
  })

  it('CONTROL: an undeclared key is still refused', () => {
    expect(validate({ ...CONNECTOR, not_a_field: 'x' })).toBe(false)
  })
})

describe('POST /agent-connection-setups/{setupId}/install-status — the connector body (#3032)', () => {
  const validate = compileBody('/agent-connection-setups/{setupId}/install-status')
  const STATUS = {
    setup_token: 'hv_setup_abc',
    runtime: 'claude-code',
    hosted_mcp_configured: true,
    local_signer_configured: true,
    skill_installed: true,
  }

  it('`skill_installed` VALIDATES', () => {
    expect(validate(structuredClone(STATUS)), JSON.stringify(validate.errors)).toBe(true)
  })

  it('`superseded_agent_ids` VALIDATES in all three states: a list, [], and null', () => {
    for (const ids of [['agent-a', 'agent-b'], [], null]) {
      expect(validate({ ...STATUS, superseded_agent_ids: ids }), JSON.stringify(validate.errors)).toBe(true)
    }
  })

  it('`superseded_agent_ids`: a bare string is COERCED to a one-item list (the request ajv\'s `coerceTypes: \'array\'`), an object is refused', () => {
    // Pinned so the behaviour is a decision, not a surprise: Fastify's request
    // defaults wrap a scalar into an array, and the handler accepts the list.
    const body: Record<string, unknown> = { ...STATUS, superseded_agent_ids: 'agent-a' }
    expect(validate(body)).toBe(true)
    expect(body.superseded_agent_ids).toEqual(['agent-a'])
    expect(validate({ ...STATUS, superseded_agent_ids: { id: 'agent-a' } })).toBe(false)
  })

  it('CONTROL: an undeclared key is still refused', () => {
    expect(validate({ ...STATUS, not_a_field: true })).toBe(false)
  })
})
