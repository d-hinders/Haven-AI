import { mkdtemp, readFile, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { finishRekey, startRekey } from './rekey.js'
import {
  REKEY_PENDING_FILENAME,
  readRekeyPending,
  rewriteCredentialFiles,
  writeCredentialFiles,
} from './storage.js'
import type { AgentIdentity, ConnectApiClient } from './api.js'
import type { RuntimeConfigInput } from './config-writers.js'

const AGENT_ID = 'agent-1700'
const OLD_DELEGATE = '0x1111111111111111111111111111111111111111'
const NEW_DELEGATE = '0x2222222222222222222222222222222222222222'
const OLD_KEY = `0x${'11'.repeat(32)}`
const NEW_KEY = `0x${'22'.repeat(32)}`
const OLD_API_KEY = 'sk_agent_oldsecretoldsecret'
const NEW_API_KEY = 'sk_agent_newsecretnewsecret'
const API_URL = 'https://api.haven.example'

async function seedAgent(serverName?: string): Promise<{ baseDir: string; directory: string }> {
  const baseDir = await mkdtemp(join(tmpdir(), 'haven-rekey-'))
  const paths = await writeCredentialFiles({
    baseDir,
    agentId: AGENT_ID,
    serverName,
    apiKey: OLD_API_KEY,
    delegateKey: OLD_KEY,
    delegateAddress: OLD_DELEGATE,
    safeAddress: '0x9999999999999999999999999999999999999999',
    chainId: 84532,
    network: 'Base Sepolia',
    agentBudget: [{ token_symbol: 'USDC', allowance_amount: '25.000000', reset_period_min: 1440 }],
    apiUrl: API_URL,
    hostedMcpUrl: `${API_URL}/mcp`,
    x402BindingSigner: '0x8888888888888888888888888888888888888888',
  })
  return { baseDir, directory: paths.directory }
}

function identity(overrides: Partial<AgentIdentity> = {}): AgentIdentity {
  return {
    id: AGENT_ID,
    name: 'Research agent',
    status: 'active',
    safe_address: '0x9999999999999999999999999999999999999999',
    delegate_address: OLD_DELEGATE,
    chain_id: 84532,
    execution_rail: 'delegation',
    ...overrides,
  }
}

/** Only `getAgentIdentity` is ever reached; the rest would be a test bug. */
function apiReturning(...responses: Array<AgentIdentity | Error>): ConnectApiClient {
  const queue = [...responses]
  const unreachable = () => {
    throw new Error('re-key must not call this endpoint')
  }
  return {
    getAgentIdentity: vi.fn(async () => {
      const next = queue.shift()
      if (!next) throw new Error('no queued identity response')
      if (next instanceof Error) throw next
      return next
    }),
    resolveSetup: unreachable,
    registerSetup: unreachable,
    updateInstallStatus: unreachable,
    getConnectorStatus: unreachable,
  } as unknown as ConnectApiClient
}

const generateNewKey = () => ({
  privateKey: NEW_KEY,
  address: NEW_DELEGATE,
  signChallenge: async () => '0xsig',
})

describe('startRekey (#1700)', () => {
  it('generates the key locally, parks it, and changes nothing else', async () => {
    const { baseDir, directory } = await seedAgent()
    const api = apiReturning(identity())

    const result = await startRekey(
      { credentialsDir: baseDir, agentId: AGENT_ID },
      { createApi: () => api, generateKey: generateNewKey },
    )

    expect(result.newDelegateAddress).toBe(NEW_DELEGATE)
    // The live credential set is UNTOUCHED — the agent keeps working on its
    // old key until the owner comes back. That is the whole point of phase one.
    const identityJson = JSON.parse(await readFile(join(directory, 'identity.json'), 'utf8'))
    const signerJson = JSON.parse(await readFile(join(directory, 'signer.json'), 'utf8'))
    expect(identityJson.api_key).toBe(OLD_API_KEY)
    expect(signerJson.delegate_key).toBe(OLD_KEY)

    const pending = await readRekeyPending(directory)
    expect(pending.new_delegate_address).toBe(NEW_DELEGATE)
    expect(pending.new_delegate_key).toBe(NEW_KEY)
  })

  it('parks the pending key owner-only, beside the live one', async () => {
    const { baseDir, directory } = await seedAgent()
    await startRekey(
      { credentialsDir: baseDir, agentId: AGENT_ID },
      { createApi: () => apiReturning(identity()), generateKey: generateNewKey },
    )
    const mode = (await stat(join(directory, REKEY_PENDING_FILENAME))).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('never prints or returns the private half', async () => {
    const { baseDir } = await seedAgent()
    const result = await startRekey(
      { credentialsDir: baseDir, agentId: AGENT_ID },
      { createApi: () => apiReturning(identity()), generateKey: generateNewKey },
    )
    const rendered = JSON.stringify(result)
    expect(rendered).toContain(NEW_DELEGATE)
    expect(rendered).not.toContain(NEW_KEY)
  })

  it('refuses a LEGACY-rail agent, the way the backend would', async () => {
    const { baseDir, directory } = await seedAgent()
    const api = apiReturning(identity({ execution_rail: 'legacy' }))
    await expect(
      startRekey({ credentialsDir: baseDir, agentId: AGENT_ID }, { createApi: () => api, generateKey: generateNewKey }),
    ).rejects.toThrow(/legacy rail/i)
    // Refused BEFORE any side effect: no key was parked.
    await expect(readRekeyPending(directory)).rejects.toThrow(/No re-key in progress/)
  })

  it('refuses a revoked agent', async () => {
    const { baseDir } = await seedAgent()
    const api = apiReturning(identity({ status: 'revoked' }))
    await expect(
      startRekey({ credentialsDir: baseDir, agentId: AGENT_ID }, { createApi: () => api, generateKey: generateNewKey }),
    ).rejects.toThrow(/revoked/i)
  })

  it('refuses when the stored key belongs to a different agent', async () => {
    const { baseDir } = await seedAgent()
    const api = apiReturning(identity({ id: 'agent-someone-else' }))
    await expect(
      startRekey({ credentialsDir: baseDir, agentId: AGENT_ID }, { createApi: () => api, generateKey: generateNewKey }),
    ).rejects.toThrow(/does not own/i)
  })

  it('a SECOND --rekey replaces the first, and the stale address then refuses to finish', async () => {
    // The owner runs --rekey, gets distracted, runs it again. Two addresses now
    // exist and only one is in their dashboard. Replacing the parked key is the
    // right call — keeping the first would strand them on an address this
    // machine no longer holds the key for — but the danger is finishing with
    // the WRONG one, so that has to refuse rather than write a key the
    // delegation does not name.
    const { baseDir, directory } = await seedAgent()
    const secondAddress = '0x3333333333333333333333333333333333333333'
    const secondKey = `0x${'33'.repeat(32)}`

    await startRekey(
      { credentialsDir: baseDir, agentId: AGENT_ID },
      { createApi: () => apiReturning(identity()), generateKey: generateNewKey },
    )
    await startRekey(
      { credentialsDir: baseDir, agentId: AGENT_ID },
      {
        createApi: () => apiReturning(identity()),
        generateKey: () => ({ privateKey: secondKey, address: secondAddress, signChallenge: async () => '0x' }),
      },
    )

    // Exactly one pending key, and it is the newer one.
    const pending = await readRekeyPending(directory)
    expect(pending.new_delegate_address).toBe(secondAddress)

    // The owner pastes the FIRST address into Haven. The finish must refuse:
    // writing `secondKey` here would leave the agent signing with a key its
    // delegation does not name — a payer/signer mismatch (#1690) manufactured
    // by the tool meant to prevent one.
    await expect(
      finishRekey(
        { credentialsDir: baseDir, agentId: AGENT_ID, newApiKey: NEW_API_KEY },
        { createApi: () => apiReturning(identity({ delegate_address: NEW_DELEGATE })) },
      ),
    ).rejects.toThrow(/different address|has not finished yet/)

    const identityJson = JSON.parse(await readFile(join(directory, 'identity.json'), 'utf8'))
    expect(identityJson.api_key).toBe(OLD_API_KEY)
  })

  it('refuses a directory with no credentials', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'haven-rekey-empty-'))
    await expect(
      startRekey({ credentialsDir: baseDir, agentId: 'nobody' }, { createApi: () => apiReturning(identity()) }),
    ).rejects.toThrow(/Nothing to re-key/)
  })
})

describe('finishRekey (#1700)', () => {
  const finishDeps = (api: ConnectApiClient) => ({
    createApi: () => api,
    // No --runtime in most cases, so neither of these should be reached.
    writeConfig: vi.fn(),
    prepareSigner: vi.fn(),
  })

  async function started(serverName?: string) {
    const seeded = await seedAgent(serverName)
    await startRekey(
      { credentialsDir: seeded.baseDir, agentId: AGENT_ID, serverName },
      { createApi: () => apiReturning(identity()), generateKey: generateNewKey },
    )
    return seeded
  }

  it('writes both halves of the new credential set, in place', async () => {
    const { baseDir, directory } = await started()
    const api = apiReturning(identity({ delegate_address: NEW_DELEGATE }))

    const result = await finishRekey(
      { credentialsDir: baseDir, agentId: AGENT_ID, newApiKey: NEW_API_KEY },
      finishDeps(api),
    )

    expect(result.directory).toBe(directory) // the path did NOT move
    const identityJson = JSON.parse(await readFile(join(directory, 'identity.json'), 'utf8'))
    const signerJson = JSON.parse(await readFile(join(directory, 'signer.json'), 'utf8'))
    const agentJson = JSON.parse(await readFile(join(directory, 'agent.json'), 'utf8'))
    expect(identityJson.api_key).toBe(NEW_API_KEY)
    expect(signerJson.delegate_key).toBe(NEW_KEY)
    expect(signerJson.delegate_address).toBe(NEW_DELEGATE)
    expect(agentJson.delegate_address).toBe(NEW_DELEGATE)
    // Carried through rather than dropped — a re-key must not quietly shrink
    // the credential set setup produced.
    expect(signerJson.x402_binding_signer).toBe('0x8888888888888888888888888888888888888888')
    expect(identityJson.agent_budget).toHaveLength(1)
    expect(identityJson.api_url).toBe(API_URL)
  })

  it('consumes the pending key, so a second finish cannot replay it', async () => {
    const { baseDir, directory } = await started()
    await finishRekey(
      { credentialsDir: baseDir, agentId: AGENT_ID, newApiKey: NEW_API_KEY },
      finishDeps(apiReturning(identity({ delegate_address: NEW_DELEGATE }))),
    )
    await expect(readRekeyPending(directory)).rejects.toThrow(/No re-key in progress/)
  })

  it('REFUSES when Haven still names the old address — the re-key has not landed', async () => {
    const { baseDir, directory } = await started()
    // The backend flow was never completed, so the agent still holds the old key.
    const api = apiReturning(identity({ delegate_address: OLD_DELEGATE }))

    await expect(
      finishRekey({ credentialsDir: baseDir, agentId: AGENT_ID, newApiKey: NEW_API_KEY }, finishDeps(api)),
    ).rejects.toThrow(/has not finished yet|different address/)

    // Nothing was written, and the pending key SURVIVES so the owner can
    // finish once the dashboard flow completes.
    const identityJson = JSON.parse(await readFile(join(directory, 'identity.json'), 'utf8'))
    expect(identityJson.api_key).toBe(OLD_API_KEY)
    expect((await readRekeyPending(directory)).new_delegate_key).toBe(NEW_KEY)
  })

  it('REFUSES an API key belonging to another agent', async () => {
    const { baseDir, directory } = await started()
    const api = apiReturning(identity({ id: 'agent-other', delegate_address: NEW_DELEGATE }))
    await expect(
      finishRekey({ credentialsDir: baseDir, agentId: AGENT_ID, newApiKey: NEW_API_KEY }, finishDeps(api)),
    ).rejects.toThrow(/belongs to agent agent-other/)
    const identityJson = JSON.parse(await readFile(join(directory, 'identity.json'), 'utf8'))
    expect(identityJson.api_key).toBe(OLD_API_KEY)
  })

  it('refuses without a pending re-key', async () => {
    const { baseDir } = await seedAgent()
    await expect(
      finishRekey(
        { credentialsDir: baseDir, agentId: AGENT_ID, newApiKey: NEW_API_KEY },
        finishDeps(apiReturning(identity({ delegate_address: NEW_DELEGATE }))),
      ),
    ).rejects.toThrow(/No re-key in progress/)
  })

  it('refuses an expired pending re-key rather than silently restarting', async () => {
    const { baseDir, directory } = await started()
    const pendingPath = join(directory, REKEY_PENDING_FILENAME)
    const pending = JSON.parse(await readFile(pendingPath, 'utf8'))
    pending.expires_at = new Date(Date.now() - 1000).toISOString()
    await writeFile(pendingPath, JSON.stringify(pending), { mode: 0o600 })

    await expect(
      finishRekey(
        { credentialsDir: baseDir, agentId: AGENT_ID, newApiKey: NEW_API_KEY },
        finishDeps(apiReturning(identity({ delegate_address: NEW_DELEGATE }))),
      ),
    ).rejects.toThrow(/expired/)
  })

  it('rewrites only THIS agent’s MCP pair, and says so', async () => {
    const { baseDir } = await started('work')
    const writeConfig = vi.fn(async (_input: RuntimeConfigInput) => ({
      hostedConfigured: true,
      signerConfigured: true,
      localMcpConfigured: false,
      runtimeMcpMode: 'hosted' as const,
      target: 'Claude Code MCP config',
      changed: true,
      restartRequired: true,
      messages: [],
    }))
    const prepareSigner = vi.fn(async () => ({
      command: '/wrapper/haven-signer',
      args: [] as string[],
      messages: [] as string[],
    }))

    const result = await finishRekey(
      {
        credentialsDir: baseDir,
        agentId: AGENT_ID,
        serverName: 'work',
        newApiKey: NEW_API_KEY,
        runtime: 'claude-code',
      },
      {
        createApi: () => apiReturning(identity({ delegate_address: NEW_DELEGATE })),
        writeConfig: writeConfig as never,
        prepareSigner: prepareSigner as never,
      },
    )

    expect(result.configRewritten).toBe(true)
    // The slug is what scopes the write to one pair, and the names it produces
    // are unchanged by the rotation — that is why wired hosts need only a restart.
    expect(result.serverNames).toEqual({ hosted: 'haven-work', signer: 'haven-signer-work' })
    const configInput = writeConfig.mock.calls[0][0]
    expect(configInput.serverName).toBe('work')
    // The NEW key reaches the config. Without this the credential files would
    // be correct and every wired host would still 401 forever.
    expect(configInput.apiKey).toBe(NEW_API_KEY)
  })

  it('warns loudly when no --runtime was given, instead of leaving a dead config', async () => {
    const { baseDir } = await started()
    const result = await finishRekey(
      { credentialsDir: baseDir, agentId: AGENT_ID, newApiKey: NEW_API_KEY },
      finishDeps(apiReturning(identity({ delegate_address: NEW_DELEGATE }))),
    )
    expect(result.configRewritten).toBe(false)
    expect(result.messages.join('\n')).toMatch(/still carries the OLD API key/)
  })
})

describe('the in-place rewrite never leaves a mixed credential set', () => {
  it('restores the ORIGINAL set when a rename fails PART WAY THROUGH', async () => {
    const { baseDir, directory } = await seedAgent()

    // A real filesystem failure, injected without mocking: replace agent.json
    // with a DIRECTORY of the same name. `rename(temp -> agent.json)` then
    // fails EISDIR — and it fails on the THIRD rename, after signer.json and
    // identity.json have already been replaced with their new contents.
    //
    // That is the dangerous window, not a convenient one: at the moment of
    // failure the on-disk set really does hold the new signer key beside the
    // new API key, and the rollback has to put BOTH back. A test that only
    // failed the serialisation step would never enter this state.
    const { rm, mkdir } = await import('node:fs/promises')
    await rm(join(directory, 'agent.json'), { force: true })
    await mkdir(join(directory, 'agent.json'))

    await expect(
      rewriteCredentialFiles({
        baseDir,
        agentId: AGENT_ID,
        apiKey: NEW_API_KEY,
        delegateKey: NEW_KEY,
        delegateAddress: NEW_DELEGATE,
        apiUrl: API_URL,
        hostedMcpUrl: `${API_URL}/mcp`,
      }),
    ).rejects.toThrow()

    // Coherent, and coherently OLD. The pairing this asserts against — a new
    // signer key with the old API key, or the reverse — is worse than either
    // generation intact: the agent would authenticate as itself and sign with
    // a key its delegation no longer names, the #1690 payer/signer mismatch.
    const identityJson = JSON.parse(await readFile(join(directory, 'identity.json'), 'utf8'))
    const signerJson = JSON.parse(await readFile(join(directory, 'signer.json'), 'utf8'))
    expect(identityJson.api_key).toBe(OLD_API_KEY)
    expect(signerJson.delegate_key).toBe(OLD_KEY)
    expect(signerJson.delegate_address).toBe(OLD_DELEGATE)

    // And the temps are swept, so the next attempt starts clean.
    const { readdir } = await import('node:fs/promises')
    expect((await readdir(directory)).filter((n) => n.includes('.tmp'))).toEqual([])
  })

  it('leaves no .tmp files behind on success', async () => {
    const { baseDir, directory } = await seedAgent()
    await rewriteCredentialFiles({
      baseDir,
      agentId: AGENT_ID,
      apiKey: NEW_API_KEY,
      delegateKey: NEW_KEY,
      delegateAddress: NEW_DELEGATE,
      apiUrl: API_URL,
      hostedMcpUrl: `${API_URL}/mcp`,
    })
    const { readdir } = await import('node:fs/promises')
    const entries = await readdir(directory)
    expect(entries.filter((name) => name.includes('.tmp'))).toEqual([])
  })
})

describe('the assertDoesNotExist guard is bypassed ONLY by re-key', () => {
  it('the ordinary setup flow still refuses to overwrite', async () => {
    // The control for the whole slice. `rewriteCredentialFiles` skipping the
    // guard is only safe while the ordinary path still has it — a regression
    // that dropped it there would make every re-run silently replace a live
    // agent's keys, which is what the guard was added for.
    const { baseDir } = await seedAgent()
    await expect(
      writeCredentialFiles({
        baseDir,
        agentId: AGENT_ID,
        apiKey: NEW_API_KEY,
        delegateKey: NEW_KEY,
        delegateAddress: NEW_DELEGATE,
        apiUrl: API_URL,
        hostedMcpUrl: `${API_URL}/mcp`,
      }),
    ).rejects.toThrow(/Refusing to overwrite existing Haven credential file/)
  })

  it('re-key overwrites the same path the ordinary flow refuses', async () => {
    const { baseDir, directory } = await seedAgent()
    await rewriteCredentialFiles({
      baseDir,
      agentId: AGENT_ID,
      apiKey: NEW_API_KEY,
      delegateKey: NEW_KEY,
      delegateAddress: NEW_DELEGATE,
      apiUrl: API_URL,
      hostedMcpUrl: `${API_URL}/mcp`,
    })
    const identityJson = JSON.parse(await readFile(join(directory, 'identity.json'), 'utf8'))
    expect(identityJson.api_key).toBe(NEW_API_KEY)
  })

  it('writes no tombstone — there is no dead path to mark', async () => {
    const { baseDir, directory } = await seedAgent()
    await startRekey(
      { credentialsDir: baseDir, agentId: AGENT_ID },
      { createApi: () => apiReturning(identity()), generateKey: generateNewKey },
    )
    await finishRekey(
      { credentialsDir: baseDir, agentId: AGENT_ID, newApiKey: NEW_API_KEY },
      { createApi: () => apiReturning(identity({ delegate_address: NEW_DELEGATE })) },
    )
    const { readdir } = await import('node:fs/promises')
    const entries = await readdir(directory)
    expect(entries).not.toContain('TOMBSTONE.json')
  })
})
