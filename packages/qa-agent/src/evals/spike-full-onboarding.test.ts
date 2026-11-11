/**
 * #4682 round 2 — the spike runner's bounds and its connector child env.
 *
 * Two defects the review found:
 *
 *  1. a hung connector never resolved, so the runner's `finally` never ran and
 *     no evidence row was written. The connector spawn and the whole attempt
 *     are now bounded, and the teardown runs when either bound expires;
 *  2. the connector child inherited `{...process.env}`, handing the agent under
 *     test the eval agent's credentials. It now gets an allowlist.
 */

import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildConnectorEnv, runAttempt, type SpikeOptions } from './spike-full-onboarding.js'

const API = 'https://api.example'
const ACCOUNT = `0x${'aa'.repeat(20)}`
const SETUP_ID = '11111111-2222-3333-4444-555555555555'

const dirs: string[] = []
async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'qa-spike-'))
  dirs.push(dir)
  return dir
}
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})
beforeEach(() => vi.unstubAllGlobals())

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/**
 * The backend the stand-in talks to. The connector never gets past its spawn,
 * so the setup row stays unregistered (`agent_id: null`) — exactly the state a
 * hung connector leaves behind.
 */
function stubBackend(): void {
  vi.stubGlobal(
    'fetch',
    (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const path = url.replace(API, '')
      const method = init?.method ?? 'GET'
      if (method === 'POST' && path === '/auth/signup') return json({ token: 'signup-token-abc' }, 201)
      if (method === 'POST' && path === '/accounts/hybrid') return json({ ok: true }, 201)
      if (method === 'GET' && path === '/auth/me') {
        return json({ accounts: [{ id: 'acct-1', account_address: ACCOUNT, account_type: 'delegator_hybrid' }] })
      }
      if (method === 'POST' && path === '/agent-connection-setups') {
        return json(
          {
            setup_id: SETUP_ID,
            approval_url: `https://app.example/agents?setup=${SETUP_ID}`,
            connector_command: 'npx -y @haven_ai/connect@alpha --setup hv_setup_xyz',
          },
          201,
        )
      }
      if (method === 'GET' && path === `/agent-connection-setups/${SETUP_ID}`) {
        return json({ setup_id: SETUP_ID, agent_id: null, delegate_address: null })
      }
      return json({ error: `unexpected ${method} ${path}` }, 404)
    }) as unknown as typeof fetch,
  )
}

/** A child that never exits and never prints: the hung connector. */
function hungChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter
    stderr: EventEmitter
    kill: (signal?: string) => void
  }
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.kill = vi.fn()
  return child
}

function options(
  workDir: string,
  spawnImpl: SpikeOptions['spawnImpl'],
  overrides: Partial<SpikeOptions> = {},
): SpikeOptions {
  return {
    apiUrl: API,
    chainId: 84532,
    evalAgentApiKey: 'eval-agent-key',
    evalDelegateKey: `0x${'22'.repeat(32)}`,
    evalAccountAddress: `0x${'ee'.repeat(20)}`,
    recipient: `0x${'cc'.repeat(20)}`,
    connectorCli: '/tmp/connect-cli.js',
    fundingAtomic: '100000',
    budgetAtomic: '100000',
    periodSeconds: 86_400,
    workDir,
    readUsdcBalance: async () => 0n,
    spawnImpl,
    ...overrides,
  }
}

describe('buildConnectorEnv — the connector child never inherits the eval credentials', () => {
  it('keeps the runtime basics and drops every QA_EVAL_* / Haven secret', () => {
    const env = buildConnectorEnv({
      PATH: '/usr/bin',
      HOME: '/home/qa',
      NODE_EXTRA_CA_CERTS: '/ca.pem',
      HTTPS_PROXY: 'http://proxy.example',
      QA_EVAL_AGENT_API_KEY: 'agent-key',
      QA_EVAL_DELEGATE_KEY: '0xdelegate',
      QA_EVAL_AGENT_ACCOUNT: ACCOUNT,
      QA_EVAL_RECIPIENT: `0x${'cc'.repeat(20)}`,
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth',
      HAVEN_CREDENTIALS: '/tmp/agent.json',
    })

    expect(env.PATH).toBe('/usr/bin')
    expect(env.HOME).toBe('/home/qa')
    expect(env.NODE_EXTRA_CA_CERTS).toBe('/ca.pem')
    expect(env.HTTPS_PROXY).toBe('http://proxy.example')
    for (const name of [
      'QA_EVAL_AGENT_API_KEY',
      'QA_EVAL_DELEGATE_KEY',
      'QA_EVAL_AGENT_ACCOUNT',
      'QA_EVAL_RECIPIENT',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'HAVEN_CREDENTIALS',
    ]) {
      expect(env[name]).toBeUndefined()
    }
  })
})

describe('runAttempt — bounded, and torn down whatever happens', () => {
  it('kills a hung connector and still tears the attempt down', async () => {
    stubBackend()
    const workDir = await scratch()
    const child = hungChild()
    const spawnImpl = vi.fn(() => child) as unknown as SpikeOptions['spawnImpl']

    const row = await runAttempt(options(workDir, spawnImpl, { connectorTimeoutMs: 20 }), 1)

    expect(row.failedStep).toBe('agents connect (timeout)')
    expect(row.notes.join('\n')).toContain('did not exit within 20ms')
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
    // The teardown ran over the account the stand-in created: no warnings, and
    // no agent existed to revoke.
    expect(row.revoke).toBe('ok')
    expect(row.cleanupWarning).toBeUndefined()
  })

  it('bounds the WHOLE attempt so a step that never resolves still tears down', async () => {
    stubBackend()
    const workDir = await scratch()
    const child = hungChild()
    const spawnImpl = vi.fn(() => child) as unknown as SpikeOptions['spawnImpl']

    const row = await runAttempt(
      options(workDir, spawnImpl, { connectorTimeoutMs: 60_000, attemptTimeoutMs: 20 }),
      1,
    )

    expect(row.failedStep).toBe('runner')
    expect(row.notes.join('\n')).toContain('timed out after 20ms')
    expect(row.revoke).toBe('ok')
  })

  it('spawns the connector with the allowlist env, not the harness env', async () => {
    stubBackend()
    vi.stubEnv('QA_EVAL_AGENT_API_KEY', 'agent-key-should-not-leak')
    vi.stubEnv('QA_EVAL_DELEGATE_KEY', '0xdelegate-should-not-leak')
    const workDir = await scratch()
    const child = hungChild()
    let captured: NodeJS.ProcessEnv | undefined
    const spawnImpl = vi.fn((_command: string, _args: string[], opts: { env?: NodeJS.ProcessEnv }) => {
      captured = opts.env
      return child
    }) as unknown as SpikeOptions['spawnImpl']

    await runAttempt(options(workDir, spawnImpl, { connectorTimeoutMs: 20 }), 1)

    expect(captured).toBeDefined()
    expect(captured!.QA_EVAL_AGENT_API_KEY).toBeUndefined()
    expect(captured!.QA_EVAL_DELEGATE_KEY).toBeUndefined()
    expect(captured!.PATH).toBe(process.env.PATH)
  })
})
