import { mkdtemp, readFile, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { finishRekey, startRekey } from './rekey.js'
import { parseArgs } from './args.js'
import { REKEY_FINISH_NEEDS_API_KEY } from './rekey-messages.js'
import { runCli } from './cli.js'
import {
  REKEY_PENDING_FILENAME,
  readRekeyPending,
  rewriteCredentialFiles,
  writeCredentialFiles,
} from './storage.js'
import type { AgentIdentity, ConnectApiClient } from './api.js'


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
    const writeConfig = vi.fn(async (_deps: unknown, _input: { serverName?: string; apiKey: string }) => ({
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
    const configInput = writeConfig.mock.calls[0][1]
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


// ── Driving the REAL CLI, which is where both blocking bugs lived ──────────
//
// Every test above calls startRekey/finishRekey directly with an explicit
// agentId. That is a fine way to test those functions and a useless way to
// test the command: the CLI never had an --agent-id flag to populate it with,
// so `--rekey` on an unnamed agent died before doing anything and no unit test
// could see it. These drive `runCli` end to end.

describe('the --rekey command itself (#1700)', () => {
  const io = () => {
    const out: string[] = []
    const err: string[] = []
    return { io: { stdout: (m: string) => out.push(m), stderr: (m: string) => err.push(m) }, out, err }
  }

  it('works for an UNNAMED agent, with no --name and no id to type', async () => {
    // The default setup, and the case that was broken: the unnamed directory is
    // keyed by an agent uuid the user never typed and has no way to know.
    //
    // Driven through the REAL client, with only the network stubbed — the point
    // is to exercise the argument parsing, the directory resolution and the
    // dispatch that the unit tests above all step over.
    const { baseDir, directory } = await seedAgent()
    const { io: sink, out, err } = io()
    const fetchCalls: string[] = []
    vi.stubGlobal('fetch', async (url: string) => {
      fetchCalls.push(String(url))
      return new Response(JSON.stringify(identity()), { status: 200 })
    })

    const code = await runCli(['--rekey', '--credentials-dir', baseDir, '--json'], sink)
    vi.unstubAllGlobals()
    expect(fetchCalls[0]).toBe(`${API_URL}/machine-payments/agent`)

    expect(err.join('')).toBe('')
    expect(code).toBe(0)
    const parsed = JSON.parse(out.join(''))
    expect(parsed.rekey).toBe('started')
    expect(parsed.agent_id).toBe(AGENT_ID)
    // A real address was generated and parked.
    expect(parsed.new_delegate_address).toMatch(/^0x[0-9a-fA-F]{40}$/)
    expect((await readRekeyPending(directory)).new_delegate_address).toBe(parsed.new_delegate_address)
    // …and the private half is nowhere in the output.
    expect(out.join('')).not.toMatch(/"new_delegate_key"/)
  })

  it('refuses, and NAMES the candidates, when several agents are wired', async () => {
    // Ambiguity only the user can settle. Picking the newest is the "newest
    // wins" heuristic #1695 removed, and here it would re-key the wrong agent.
    const { baseDir } = await seedAgent()
    await writeCredentialFiles({
      baseDir,
      agentId: 'agent-second',
      apiKey: 'sk_agent_second',
      delegateKey: `0x${'44'.repeat(32)}`,
      delegateAddress: '0x4444444444444444444444444444444444444444',
      apiUrl: API_URL,
      hostedMcpUrl: `${API_URL}/mcp`,
    })
    const { io: sink, err } = io()

    expect(await runCli(['--rekey', '--credentials-dir', baseDir], sink)).toBe(1)
    const message = err.join('')
    expect(message).toMatch(/Several agents are wired/)
    expect(message).toMatch(/--name <slug>/)
    expect(message).toContain('agent-second')
  })

  it('--api-key without --rekey-finish is refused, not silently dropped', async () => {
    const { io: sink, err } = io()
    expect(await runCli(['--api-key', 'sk_agent_x', '--doctor', '--runtime', 'claude-code'], sink)).toBe(1)
    expect(err.join('')).toMatch(/--api-key requires --rekey-finish/)
  })

  it('--rekey-finish without --api-key is refused', async () => {
    const { io: sink, err } = io()
    expect(await runCli(['--rekey-finish'], sink)).toBe(1)
    expect(err.join('')).toMatch(/needs --api-key/)
  })

  it('--rekey with --setup is refused rather than half-honoured', async () => {
    const { io: sink, err } = io()
    expect(await runCli(['--rekey', '--setup', 'hv_setup_x'], sink)).toBe(1)
    expect(err.join('')).toMatch(/does not take --setup/)
  })

  it('help documents the new flags', async () => {
    const { io: sink, out } = io()
    expect(await runCli(['--help'], sink)).toBe(0)
    const help = out.join('')
    expect(help).toMatch(/--rekey\b/)
    expect(help).toMatch(/--rekey-finish/)
    expect(help).toMatch(/--api-key/)
  })
})

describe('the config rewrite reaches the REAL writer (#1700)', () => {
  // The second blocking bug: `writeRuntimeConfig` has no `claude-code` case, so
  // calling it directly returns hostedConfigured:false for the most common
  // runtime while the flow reported success. These use the real dispatch and
  // only stub the two things that would touch the machine — the signer install
  // and the `claude` CLI.
  async function startedFor(serverName?: string) {
    const seeded = await seedAgent(serverName)
    await startRekey(
      { credentialsDir: seeded.baseDir, agentId: AGENT_ID, serverName },
      { createApi: () => apiReturning(identity()), generateKey: generateNewKey },
    )
    return seeded
  }

  const preparedSigner = async () => ({
    command: '/wrapper/haven-signer',
    args: [] as string[],
    messages: [] as string[],
  })

  it('configures Claude Code through `claude mcp add-json`, carrying the NEW key', async () => {
    const { baseDir } = await startedFor()
    const commands: Array<{ command: string; args: string[] }> = []

    const result = await finishRekey(
      { credentialsDir: baseDir, agentId: AGENT_ID, newApiKey: NEW_API_KEY, runtime: 'claude-code' },
      {
        createApi: () => apiReturning(identity({ delegate_address: NEW_DELEGATE })),
        prepareSigner: preparedSigner as never,
        runCommand: (async (command: string, args: string[]) => {
          commands.push({ command, args })
        }) as never,
      },
    )

    expect(result.configRewritten).toBe(true)
    const addJson = commands.filter((c) => c.args[1] === 'add-json')
    expect(addJson).toHaveLength(2)
    // The new key reaches the config. This assertion is the whole point: with
    // the old code path this array was empty and the flow still said success.
    expect(addJson[0].args.join(' ')).toContain(NEW_API_KEY)
    expect(addJson[0].args.join(' ')).not.toContain(OLD_API_KEY)
    // Only this agent's pair, by name.
    expect(commands.filter((c) => c.args[1] === 'remove').map((c) => c.args[2])).toEqual([
      'haven',
      'haven-signer',
    ])
  })

  it('scopes the Claude Code rewrite to a NAMED pair, leaving siblings alone', async () => {
    const { baseDir } = await startedFor('work')
    const commands: Array<string[]> = []
    await finishRekey(
      {
        credentialsDir: baseDir,
        agentId: AGENT_ID,
        serverName: 'work',
        newApiKey: NEW_API_KEY,
        runtime: 'claude-code',
      },
      {
        createApi: () => apiReturning(identity({ delegate_address: NEW_DELEGATE })),
        prepareSigner: preparedSigner as never,
        runCommand: (async (_c: string, args: string[]) => {
          commands.push(args)
        }) as never,
      },
    )
    const touched = commands.filter((a) => a[1] === 'remove' || a[1] === 'add-json').map((a) => a[2])
    expect(new Set(touched)).toEqual(new Set(['haven-work', 'haven-signer-work']))
  })

  it('warns loudly when the config write FAILS, instead of reporting success', async () => {
    const { baseDir } = await startedFor()
    const result = await finishRekey(
      { credentialsDir: baseDir, agentId: AGENT_ID, newApiKey: NEW_API_KEY, runtime: 'claude-code' },
      {
        createApi: () => apiReturning(identity({ delegate_address: NEW_DELEGATE })),
        prepareSigner: preparedSigner as never,
        // `claude` is not installed — the ordinary way this fails in the wild.
        runCommand: (async () => {
          throw new Error('claude: command not found')
        }) as never,
      },
    )
    expect(result.configRewritten).toBe(false)
    expect(result.messages.join('\n')).toMatch(/still carries the OLD API key/)
  })
})

// #2187: two layers legitimately refuse `--rekey-finish` without a new API key
// — the parser refuses the invocation before touching disk, the function
// refuses the call whoever made it (`newApiKey` is optional in the shared
// `RekeyOptions` only because phase one takes none). What was wrong was two
// copies of the sentence with nothing pinning them together.
describe('the missing-api-key refusal is one sentence, not two (#2187)', () => {
  /** The message each layer actually produces, driven through its real path. */
  async function messages() {
    const fromParser = (() => {
      try {
        parseArgs(['--rekey-finish'])
        return null
      } catch (err) {
        return (err as Error).message
      }
    })()
    const fromFunction = await finishRekey({}, {}).then(
      () => null,
      (err: unknown) => (err as Error).message,
    )
    return { fromParser, fromFunction }
  }

  it('both layers still refuse', async () => {
    const { fromParser, fromFunction } = await messages()

    // Neither guard may quietly disappear: the parser's is what a CLI user
    // hits, the function's is what a direct caller hits.
    expect(fromParser).not.toBeNull()
    expect(fromFunction).not.toBeNull()
  })

  it('and they say exactly the same thing', async () => {
    const { fromParser, fromFunction } = await messages()

    // Asserted between the two REAL paths rather than against the constant —
    // comparing each to `REKEY_FINISH_NEEDS_API_KEY` would pass even if one
    // site stopped importing it, which is the drift this pins.
    expect(fromParser).toBe(fromFunction)
    expect(fromParser).toBe(REKEY_FINISH_NEEDS_API_KEY)
  })
})
