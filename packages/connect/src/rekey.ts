/**
 * `--rekey` — replace an agent's signing key on the machine that runs it
 * (#1700, epic #1694).
 *
 * ## Two phases, and why it cannot be one
 *
 * Re-key is authorised by the account OWNER through the dashboard: every
 * backend re-key route sits behind the dashboard session and explicitly
 * refuses an agent credential, because an agent rotating its own credentials
 * would be an agent editing its own authority (#1694). So this connector never
 * calls the re-key API at all. It brackets it:
 *
 * 1. `--rekey` generates a fresh keypair HERE and prints its public address.
 *    The owner pastes that into the dashboard, which runs the five owner-signed
 *    steps and hands back a new API key, shown once.
 * 2. `--rekey-finish --api-key <key>` writes both halves into the existing
 *    credential files and rewrites this agent's MCP config pair.
 *
 * The issue text called the input "a re-key setup token". There is no such
 * token and no endpoint that would redeem one; the shipped dashboard asks for
 * a pasted address and returns a pasted key. This follows the shipped flow.
 *
 * ## The non-custodial invariant, restated because this is where it could slip
 *
 * The new private key is generated on this machine and never leaves it. Haven
 * receives an ADDRESS. Nothing here accepts, uploads or transports key
 * material, and a design that "restores" a key to a new host is refused rather
 * than built (#1694).
 *
 * ## Why the config must be rewritten, not just the credential files
 *
 * The MCP config embeds the API key directly — `Authorization: Bearer <key>`
 * for the JSON and TOML runtimes, `MCP_HAVEN[_SLUG]_API_KEY` for Hermes. A
 * re-key that rewrote only `identity.json` would leave every wired host
 * presenting the rotated-away key and 401ing forever, which is the failure the
 * whole epic exists to remove.
 *
 * The wiring SLUG does not move, so the server names do not move, so no host
 * needs reconfiguring beyond a restart — that is the point of rewriting in
 * place at a stable path.
 */

import { createConnectApiClient, type AgentIdentity, type ConnectApiClient } from './api.js'
import { writeHostedRuntimeConfig } from './runtime-install.js'
import { prepareSignerRuntime } from './signer-runtime.js'
import { generateDelegateKey } from './key.js'
import { redactSecrets } from './redact.js'
import { serverNamesFor } from './server-names.js'
import {
  REKEY_PENDING_TTL_MS,
  clearRekeyPending,
  readRekeyPending,
  readStoredCredentials,
  rewriteCredentialFiles,
  writeRekeyPending,
  type StoredCredentialSnapshot,
} from './storage.js'

export interface RekeyOptions {
  /** Wiring slug (`--name`). Absent = the unnamed pair's directory. */
  serverName?: string
  /** Agent id, for an unnamed agent whose directory is keyed by it. */
  agentId?: string
  credentialsDir?: string
  /** Phase two only: the new API key the dashboard showed once. */
  newApiKey?: string
  /** Set for phase two when the config pair must be rewritten. */
  runtime?: string
  homeDir?: string
}

export interface RekeyDeps {
  createApi?: (baseUrl: string) => ConnectApiClient
  generateKey?: typeof generateDelegateKey
  now?: () => number
  log?: (message: string) => void
  /** Injected so the config rewrite is testable without touching a real host config. */
  writeConfig?: typeof writeHostedRuntimeConfig
  prepareSigner?: typeof prepareSignerRuntime
  runCommand?: Parameters<typeof prepareSignerRuntime>[1] extends { runCommand?: infer R } ? R : never
}

export interface RekeyStartResult {
  started: true
  agentId: string
  directory: string
  newDelegateAddress: string
  expiresAt: string
  messages: string[]
}

export interface RekeyFinishResult {
  finished: true
  agentId: string
  directory: string
  newDelegateAddress: string
  serverNames: { hosted: string; signer: string }
  /** False when no --runtime was given, so the caller can say the config is stale. */
  configRewritten: boolean
  messages: string[]
}

/** Phase one: generate the key, park it, print the address to paste. */
export async function startRekey(
  options: RekeyOptions,
  deps: RekeyDeps = {},
): Promise<RekeyStartResult> {
  const now = deps.now ?? (() => Date.now())
  const stored = await readStoredCredentials(
    options.serverName,
    options.agentId,
    options.credentialsDir,
  )

  const api = (deps.createApi ?? ((url: string) => createConnectApiClient(url)))(stored.apiUrl)
  const identity = await probeIdentity(api, stored.apiKey, 'current')
  assertRekeyable(identity, stored)

  // Generated HERE. The address is the only half that will ever be sent.
  const key = (deps.generateKey ?? generateDelegateKey)()
  const startedAt = new Date(now()).toISOString()
  const expiresAt = new Date(now() + REKEY_PENDING_TTL_MS).toISOString()

  await writeRekeyPending(stored.directory, {
    agent_id: stored.agentId,
    new_delegate_address: key.address,
    new_delegate_key: key.privateKey,
    started_at: startedAt,
    expires_at: expiresAt,
  })

  const finishCommand = [
    'npx @haven_ai/connect@alpha --rekey-finish',
    options.serverName ? `--name ${options.serverName}` : undefined,
    '--api-key <the key the dashboard showed you>',
    options.runtime ? `--runtime ${options.runtime}` : '--runtime <your runtime>',
  ]
    .filter(Boolean)
    .join(' ')

  return {
    started: true,
    agentId: stored.agentId,
    directory: stored.directory,
    newDelegateAddress: key.address,
    expiresAt,
    messages: [
      `New signing key generated on this machine for agent ${identity.name || stored.agentId}.`,
      '',
      `  New signing address:  ${key.address}`,
      '',
      'The private half stays here — Haven never receives it, and there is no way to move it',
      'between machines. That is what keeps the account non-custodial.',
      '',
      'Next, on the Haven agent page: choose "Replace signing key" and paste that address.',
      'When it finishes it shows a new API key ONCE. Come back here and run:',
      '',
      `  ${finishCommand}`,
      '',
      `Nothing has changed yet — the agent keeps working on its old key until you finish.`,
      `This pending re-key expires ${expiresAt}.`,
    ],
  }
}

/** Phase two: verify the pasted key, then rewrite credentials and config. */
export async function finishRekey(
  options: RekeyOptions,
  deps: RekeyDeps = {},
): Promise<RekeyFinishResult> {
  const now = deps.now ?? (() => Date.now())
  if (!options.newApiKey) {
    throw new Error('--rekey-finish needs --api-key <key> — the one the Haven agent page showed once.')
  }
  const stored = await readStoredCredentials(
    options.serverName,
    options.agentId,
    options.credentialsDir,
  )
  const pending = await readRekeyPending(stored.directory, now())

  if (pending.agent_id !== stored.agentId) {
    throw new Error(
      `The pending re-key at ${stored.directory} belongs to agent ${pending.agent_id}, but that ` +
        `directory now holds ${stored.agentId}. Refusing to write a key into the wrong agent.`,
    )
  }

  const api = (deps.createApi ?? ((url: string) => createConnectApiClient(url)))(stored.apiUrl)
  const identity = await probeIdentity(api, options.newApiKey, 'new')

  // The load-bearing check, and the reason this phase talks to Haven at all.
  // It proves three things at once with one read: the pasted key authenticates,
  // it belongs to THIS agent, and the backend re-key actually completed against
  // the address this machine generated. Any of those being false and writing
  // anyway produces a credential set that fails at the next payment instead of
  // here, with the old key already gone.
  if (identity.id !== stored.agentId) {
    throw new Error(
      `That API key belongs to agent ${identity.id}, not ${stored.agentId}. Nothing was changed.`,
    )
  }
  const onChain = (identity.delegate_address ?? '').toLowerCase()
  const expected = pending.new_delegate_address.toLowerCase()
  if (onChain !== expected) {
    throw new Error(
      `Haven says this agent's signing address is ${identity.delegate_address ?? 'unset'}, but this ` +
        `machine generated ${pending.new_delegate_address}. Nothing was changed. Either the ` +
        're-key on the agent page used a different address, or it has not finished yet.',
    )
  }

  await rewriteCredentialFiles({
    baseDir: options.credentialsDir,
    agentId: stored.agentId,
    serverName: options.serverName,
    apiKey: options.newApiKey,
    delegateKey: pending.new_delegate_key,
    delegateAddress: pending.new_delegate_address,
    safeAddress: stored.safeAddress ?? identity.safe_address ?? undefined,
    chainId: stored.chainId ?? identity.chain_id ?? undefined,
    network: stored.network,
    agentBudget: stored.agentBudget,
    apiUrl: stored.apiUrl,
    hostedMcpUrl: stored.hostedMcpUrl,
    x402BindingSigner: stored.x402BindingSigner,
    warn: deps.log,
  })

  // Only now. A pending key deleted before the rewrite lands would make a
  // failed rewrite unrecoverable — the private half would be gone with the
  // credential files still naming the old one.
  await clearRekeyPending(stored.directory)

  const names = serverNamesFor(options.serverName)
  const messages = [
    `Agent ${identity.name || stored.agentId} is now on its new signing key.`,
    `  Signing address:  ${pending.new_delegate_address}`,
    `  Credentials:      ${stored.directory} (rewritten in place)`,
    `  MCP servers:      ${names.hosted} / ${names.signer} (unchanged names)`,
  ]

  // ── The MCP config, which is NOT optional bookkeeping ────────────────────
  //
  // The API key is embedded in the config itself — `Authorization: Bearer
  // <key>` for the JSON and TOML runtimes, `MCP_HAVEN[_SLUG]_API_KEY` for
  // Hermes. Rewriting only the credential files would leave every wired host
  // presenting the key the backend just retired, 401ing on every call, with a
  // credential set on disk that looks perfectly correct.
  //
  // Only THIS agent's pair is touched: the writers key off `serverName`, so a
  // sibling agent's entries in the same config file are carried through
  // untouched (#1695).
  let configRewritten = false
  if (options.runtime) {
    const prepared = await (deps.prepareSigner ?? prepareSignerRuntime)(
      {
        credentialDirectory: stored.directory,
        signerPath: `${stored.directory}/signer.json`,
        homeDir: options.homeDir,
      },
      { runCommand: deps.runCommand },
    )
    // `writeHostedRuntimeConfig`, NOT `writeRuntimeConfig`. The latter has no
    // `claude-code` case — that runtime is configured by shelling out to
    // `claude mcp add-json` — so calling it directly returns a
    // `hostedConfigured: false` result for the single most common runtime while
    // reporting like a success. Review of this slice caught exactly that.
    const result = await (deps.writeConfig ?? writeHostedRuntimeConfig)(
      { runCommand: deps.runCommand, homeDir: options.homeDir },
      {
        runtime: options.runtime,
        hostedMcpUrl: stored.hostedMcpUrl,
        apiKey: options.newApiKey,
        identityPath: `${stored.directory}/identity.json`,
        signerPath: `${stored.directory}/signer.json`,
        credentialDirectory: stored.directory,
        serverName: options.serverName,
      },
      { command: prepared.command, args: prepared.args },
    )
    configRewritten = result.hostedConfigured
    messages.push(`  Config:           ${result.target}`)
    messages.push(...result.messages.map((line) => `  ${line}`))
    if (!configRewritten) {
      // The write reported failure — a runtime with no writer, or a `claude`
      // CLI that is not on PATH. Say what it costs, in the same words as the
      // no-runtime case: a credential set that is correct on disk while every
      // wired host presents the retired key reads as "the re-key broke my
      // agent", and the generic writer message does not say that.
      messages.push(
        '',
        'WARNING: the MCP config was NOT updated, so it still carries the OLD API key and every',
        `wired host will fail with 401. Fix the cause above and re-run with --runtime ${options.runtime},`,
        'or update the config by hand. The credential files on disk are already on the new key.',
      )
    }
  } else {
    // Said loudly rather than skipped quietly: without this the user has a
    // rotated credential file and a config still carrying the dead key, which
    // presents as "the re-key broke my agent".
    messages.push(
      '',
      'NOTE: no --runtime was given, so the MCP config still carries the OLD API key and every',
      'wired host will fail with 401. Re-run with --runtime <name> to rewrite it.',
    )
  }

  return {
    finished: true,
    agentId: stored.agentId,
    directory: stored.directory,
    newDelegateAddress: pending.new_delegate_address,
    serverNames: { hosted: names.hosted, signer: names.signer },
    configRewritten,
    messages,
  }
}

async function probeIdentity(
  api: ConnectApiClient,
  apiKey: string,
  which: 'current' | 'new',
): Promise<AgentIdentity> {
  try {
    return await api.getAgentIdentity(apiKey)
  } catch (err) {
    const status = (err as { status?: number } | null)?.status
    if (status === 401 || status === 403) {
      throw new Error(
        which === 'current'
          ? 'This machine\'s Haven API key is no longer accepted. If a re-key already finished ' +
            'elsewhere, run --rekey-finish with the key that re-key produced instead of starting a new one.'
          : 'Haven rejected that API key. Check you pasted the whole key from the agent page — ' +
            'nothing was changed.',
      )
    }
    throw new Error(
      `Could not reach Haven to check this agent (${redactSecrets(
        err instanceof Error ? err.message : String(err),
      )}). Nothing was changed.`,
    )
  }
}

/**
 * Refuse what the backend would refuse, before the owner starts anything.
 *
 * The legacy AllowanceModule rail is import-only and its authority is per-token
 * allowances rather than a signed delegation, so there is no delegation to
 * revoke and re-issue — the backend answers a 409 naming re-onboarding as the
 * path (#1694). Finding that out here costs one read; finding it out from the
 * dashboard costs the owner a wallet prompt first.
 */
function assertRekeyable(identity: AgentIdentity, stored: StoredCredentialSnapshot): void {
  if (identity.id !== stored.agentId) {
    throw new Error(
      `The credentials at ${stored.directory} say agent ${stored.agentId}, but Haven says that key ` +
        `belongs to ${identity.id}. Refusing to re-key an agent this directory does not own.`,
    )
  }
  if (identity.execution_rail === 'legacy') {
    throw new Error(
      `Agent ${identity.name || identity.id} is on the legacy rail, which cannot be re-keyed — its ` +
        'authority is per-token Safe allowances, not a signed delegation there is anything to ' +
        're-issue. Re-onboard the agent on the delegation rail instead.',
    )
  }
  if (identity.status === 'revoked') {
    throw new Error(
      `Agent ${identity.name || identity.id} is revoked. Re-keying would hand a revoked agent fresh ` +
        'credentials — create a new agent instead.',
    )
  }
}
