/**
 * #3303: `@haven_ai/mcp` names itself on every Haven API request and surfaces
 * the backend's `client_update` hint — and its 426 refusal — in the tool
 * result the agent reads.
 */
import { chmod, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHavenMcpServer, MCP_NAME, MCP_VERSION, withClientUpdate } from './server.js'

const baseUrl = 'https://haven.example'

const HINT = {
  package: '@haven_ai/mcp',
  current: MCP_VERSION,
  recommended: '9.0.0',
  min_version: null,
  required: false,
  upgrade_command: 'npx -y @haven_ai/connect@alpha',
  notes_url: null,
}

const AGENT = {
  id: 'agt_1',
  name: 'Test',
  delegate_address: '0xdeadbeef',
  account_address: '0xaccount',
  chain_id: 8453,
  status: 'active',
}

const ALLOWANCES = { agent_id: 'agt_1', delegate_address: '0xdeadbeef', chain_id: 8453, allowances: [] }

/** A well-formed agent + allowances pair, so haven_get_agent SUCCEEDS; `extra` rides on both reads. */
function agentReads(extra: Record<string, unknown> = {}) {
  return (url: string) =>
    jsonResponse(url.endsWith('/machine-payments/allowances') ? { ...ALLOWANCES, ...extra } : { ...AGENT, ...extra })
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

async function serverWithFetch(respond: (url: string) => Response) {
  const clientHeaders: Array<string | null> = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    if (String(url).startsWith(baseUrl)) clientHeaders.push(new Headers(init?.headers).get('x-haven-client'))
    return respond(String(url))
  })
  const dir = await mkdtemp(join(tmpdir(), 'haven-mcp-client-update-'))
  const identityPath = join(dir, 'identity.json')
  const signerPath = join(dir, 'signer.json')
  await writeFile(identityPath, JSON.stringify({ api_key: 'sk_agent_x', api_url: baseUrl, agent_id: 'agent-1', chain_id: 8453 }))
  await writeFile(signerPath, JSON.stringify({
    delegate_key: `0x${'11'.repeat(32)}`,
    delegate_address: '0x1111111111111111111111111111111111111111',
  }))
  await chmod(identityPath, 0o600)
  await chmod(signerPath, 0o600)
  const server = await createHavenMcpServer({ identityPath, signerPath, skipConsent: true, nodeVersion: '22.0.0' })
  type ToolResult = { content: { text: string }[]; isError: boolean }
  type Entry = { callback?: (a: unknown) => Promise<ToolResult>; handler?: (a: unknown) => Promise<ToolResult> }
  const tools = (server as unknown as { _registeredTools: Record<string, Entry> })._registeredTools
  const call = async (name: string) => {
    const entry = tools[name]
    const run = entry.handler ?? entry.callback
    if (!run) throw new Error(`tool ${name} has no callback`)
    const result = await run({})
    return { isError: result.isError, payload: JSON.parse(result.content[0].text) as Record<string, unknown> }
  }
  return { call, clientHeaders }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('@haven_ai/mcp client identity and update hint (#3303)', () => {
  it('names @haven_ai/mcp at its own version on every Haven API request', async () => {
    const { call, clientHeaders } = await serverWithFetch(agentReads())
    await call('haven_get_agent')
    expect(clientHeaders.length).toBeGreaterThan(0)
    expect(new Set(clientHeaders)).toEqual(new Set([`${MCP_NAME}/${MCP_VERSION}`]))
  })

  it('puts the backend\'s hint on a successful tool result', async () => {
    const { call } = await serverWithFetch(agentReads({ client_update: HINT }))
    const { isError, payload } = await call('haven_get_agent')
    expect(isError).toBe(false)
    expect(payload.client_update).toEqual(HINT)
  })

  it('adds nothing when the backend sent no hint', async () => {
    const { call } = await serverWithFetch(agentReads())
    const { isError, payload } = await call('haven_get_agent')
    expect(isError).toBe(false)
    expect(payload).not.toHaveProperty('client_update')
  })

  it('surfaces a 426 client_outdated refusal with the update command and the reason no tool follows', async () => {
    const refusal = {
      error: `@haven_ai/mcp ${MCP_VERSION} is below the minimum version`,
      error_code: 'client_outdated',
      client_update: { ...HINT, required: true, min_version: '9.0.0' },
      next_action: 'stop_and_tell_user',
      next_tool_omitted_reason: 'the client must be updated before any tool can succeed — tell the user to run npx -y @haven_ai/connect@alpha',
    }
    const { call } = await serverWithFetch(() => jsonResponse(refusal, 426))
    const { isError, payload } = await call('haven_get_agent')
    expect(isError).toBe(true)
    expect(payload.statusCode).toBe(426)
    expect(payload.next_action).toBe('stop_and_tell_user')
    expect(payload.next_tool_omitted_reason).toBe(refusal.next_tool_omitted_reason)
    expect(payload.client_update).toEqual(refusal.client_update)
  })

  it('withClientUpdate never overwrites a hint the payload already carries', () => {
    const own = { ...HINT, current: 'own' }
    expect(withClientUpdate({ success: true, data: 1, client_update: own }, HINT)).toEqual({
      success: true,
      data: 1,
      client_update: own,
    })
    expect(withClientUpdate({ success: true, data: 1 }, undefined)).toEqual({ success: true, data: 1 })
  })
})
