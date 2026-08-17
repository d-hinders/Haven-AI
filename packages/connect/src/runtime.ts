import { createConnectApiClient, ConnectRequestError, type ConnectApiClient, type ResolvedSetup } from './api.js'
import { resolveTokenFromAddress } from '@haven_ai/sdk'
import {
  agentApiKeyPrefix,
  generateAgentApiKey,
  generateDelegateKey,
  hashAgentApiKey,
  type LocalDelegateKey,
} from './key.js'
import { redactSecrets, shortAddress } from './redact.js'
import {
  preflightCredentialStorage,
  writeCredentialFiles,
  type StoredCredentialPaths,
} from './storage.js'
import {
  installRuntime,
  runtimeInstallCapabilities,
  supportsLocalMcp,
  type RuntimeInstallResult,
} from './runtime-install.js'
import { normalizeRuntime, runtimeProfile, runtimeVerificationInstruction } from './runtime-registry.js'
import { assertSupportedNodeVersion } from './local-mcp-runtime.js'
import { MCP_RUNTIME_MANIFEST } from './runtime-manifest.js'

export const CONNECTOR_VERSION = '0.1.24-alpha.0'

export interface ConnectOptions {
  setupToken: string
  apiBaseUrl: string
  runtime?: string
  credentialsDir?: string
  environmentLabel?: string
  connectorVersion?: string
  ackSigner?: boolean
  ackLocalTools?: boolean
  localMcp?: boolean
  /**
   * #1377 D: keep the process alive after registering and poll for the
   * user's budget approval (default). Set false for structured/automation
   * runs (--json) where prompt output emission matters more than narration.
   */
  waitForApproval?: boolean
  /** Test/injection overrides for the approval poll cadence and clock. */
  approvalWait?: ApprovalWaitOptions
}

/** The stable machine-readable result emitted by `haven-connect --json`. */
export const CONNECT_OUTCOME_SCHEMA_VERSION = 1 as const

export type ConnectOutcomeStatus = 'complete' | 'action_required' | 'failed'

export interface ConnectOutcome {
  schema_version: typeof CONNECT_OUTCOME_SCHEMA_VERSION
  outcome: ConnectOutcomeStatus
  runtime: string
  topology: string
  configuration: {
    hosted_mcp: boolean
    local_signer: boolean
    local_mcp: boolean
  }
  probe: { result: string }
  activation: {
    restart_required: boolean
    instruction: string
  }
  next_action: string
  approval: { required: boolean; expires_at: string | null }
  verification: {
    tools: readonly ['haven_get_agent', 'haven_get_allowances']
    instruction: string
  }
  delegate_address?: string
  setup_challenge_expires_at?: string
  error?: { code: string; next_action: string }
}

export interface ConnectDeps {
  api?: ConnectApiClient
  generateKey?: () => LocalDelegateKey
  generateApiKey?: () => string
  preflightStorage?: typeof preflightCredentialStorage
  writeCredentials?: typeof writeCredentialFiles
  installRuntime?: typeof installRuntime
  log?: (message: string) => void
  /** JSON CLI mode must not expose owner-only credential file locations. */
  redactPaths?: boolean
  /** Overridable so the Node-floor refusal is testable without spawning a Node. */
  nodeVersion?: string
}

export interface ConnectResult {
  setupId: string
  agentId: string
  delegateAddress: string
  credentialPaths: StoredCredentialPaths
  /** Additive, secret-free completion contract shared by library callers and --json. */
  outcome: ConnectOutcome
}

export async function runConnect(options: ConnectOptions, deps: ConnectDeps = {}): Promise<ConnectResult> {
  // FIRST, before anything with a side effect (#1161).
  //
  // This runs ahead of the setup-token resolve, the storage preflight, key
  // generation, the agent registration, and every credential write — so a
  // refusal cannot strand a half-created agent or burn a one-shot setup token,
  // the same discipline the hosted-MCP-URL guard adopted in #1129.
  //
  // It is checked on EVERY topology, which is the actual fix here. The guard
  // already existed but only ran inside local-MCP installation, reached solely
  // via `--local`; the default hosted-MCP + local-signer path — what nearly
  // every user runs — never touched it. The floor was enforced on the advanced
  // path and unenforced on the common one.
  //
  // Refuse rather than warn: what gets installed is the signer, which holds the
  // delegate key and produces every payment signature. An unsupported runtime
  // under a signing component is not a state to continue from, and npm's own
  // EBADENGINE notice is advisory unless the user happens to run engine-strict.
  assertSupportedNodeVersion(deps.nodeVersion, MCP_RUNTIME_MANIFEST.minimumNodeVersion)

  const connectorVersion = options.connectorVersion ?? CONNECTOR_VERSION
  const api = deps.api ?? createConnectApiClient(options.apiBaseUrl)
  const log = secureLogger(
    deps.log ?? ((message) => process.stdout.write(`${message}\n`)),
    deps.redactPaths === true,
  )
  const writeCredentials = deps.writeCredentials ?? writeCredentialFiles
  const preflightStorage = deps.preflightStorage ?? preflightCredentialStorage
  const runRuntimeInstall = deps.installRuntime ?? installRuntime
  const generateKey = deps.generateKey ?? generateDelegateKey
  const generateLocalApiKey = deps.generateApiKey ?? generateAgentApiKey
  const installCapabilities = runtimeInstallCapabilities(options.runtime)

  if (options.localMcp) {
    const resolvedRuntime = normalizeRuntime(options.runtime)
    if (!supportsLocalMcp(resolvedRuntime)) {
      throw new Error(
        `--local (fully-local Haven MCP) is only available for Claude Code and Codex. ` +
        `The detected runtime is ${runtimeProfile(resolvedRuntime).label}. ` +
        'Re-run without --local to use the default hosted MCP + local signer setup.',
      )
    }
  }

  log('Warming up your connection to Haven…')
  const setup = await api.resolveSetup({
    setupToken: options.setupToken,
    connectorVersion,
    runtime: options.runtime,
  })
  assertSetupChallengeIsUsable(setup.challenge.expires_at)
  printSetupSummary(setup, log)

  await preflightStorage({ baseDir: options.credentialsDir, warn: log })
  log('Checked local credential storage — all clear.')

  const localKey = generateKey()
  const localApiKey = generateLocalApiKey()
  log('Minting a fresh signing key and API key — both stay on this machine.')
  const proofSignature = await localKey.signChallenge(setup.challenge.message)

  log('Introducing your agent to Haven…')
  let registration: Awaited<ReturnType<ConnectApiClient['registerSetup']>>
  try {
    registration = await api.registerSetup({
      setupToken: options.setupToken,
      connectorVersion,
      runtime: options.runtime,
      challengeId: setup.challenge.id,
      delegateAddress: localKey.address,
      proofSignature,
      apiKeyHash: hashAgentApiKey(localApiKey),
      apiKeyPrefix: agentApiKeyPrefix(localApiKey),
      connectorContext: {
        environment_label: options.environmentLabel ?? 'Local workspace',
        config_target: installCapabilities.canWriteRuntimeConfig
          ? 'agent runtime MCP config'
          : 'local credential files',
      },
      installCapabilities,
    })
  } catch (err) {
    if (isExpiredSetupChallenge(err)) {
      throw new Error(
        'The Haven setup challenge expired while connecting. Return to Haven, start a fresh connection, and run its new Connect command. Do not reuse or paste credentials.',
      )
    }
    throw err
  }

  log(`Registered signing address with Haven: ${shortAddress(registration.delegate_address)}.`)

  log('Tucking your credentials away safely on disk…')
  const credentialPaths = await writeCredentials({
    baseDir: options.credentialsDir,
    agentId: registration.agent_id,
    apiKey: localApiKey,
    delegateKey: localKey.privateKey,
    delegateAddress: localKey.address,
    safeAddress: setup.haven_wallet.address,
    chainId: setup.haven_wallet.chain_id,
    network: setup.haven_wallet.network,
    agentBudget: setup.agent_budget.map((budget) => ({
      token_symbol: budget.token_symbol,
      allowance_amount: budget.allowance_amount,
      reset_period_min: budget.reset_period_min,
    })),
    apiUrl: options.apiBaseUrl,
    hostedMcpUrl: registration.hosted_mcp_url,
    x402BindingSigner: setup.x402_binding_signer ?? undefined,
    warn: log,
  })
  log(`Stored Haven identity credential locally: ${credentialPaths.identityPath}`)
  log(`Stored local signer credential locally: ${credentialPaths.signerPath}`)
  log(`Stored non-secret agent orientation locally: ${credentialPaths.agentPath}`)
  if (setup.x402_binding_signer) {
    log('Configured x402 binding signer for the local signer.')
  } else {
    // Fail loud here rather than silently at x402 sign time: without a trusted
    // binding signer the edge signer refuses to sign x402 funding hashes.
    log(
      'Warning: Haven did not provide an x402 binding signer, so x402 payments will not sign ' +
        'until HAVEN_X402_BINDING_SIGNER is set for the signer. Non-x402 payments are unaffected.',
    )
  }

  const runtimeInstall = await runRuntimeInstall({
    runtime: options.runtime,
    hostedMcpUrl: registration.hosted_mcp_url,
    apiKey: localApiKey,
    signerPath: credentialPaths.signerPath,
    identityPath: credentialPaths.identityPath,
    credentialDirectory: credentialPaths.directory,
    environmentLabel: options.environmentLabel ?? 'Local workspace',
    ackSigner: options.ackSigner,
    ackLocalTools: options.ackLocalTools,
    localMcp: options.localMcp,
  }, { onProgress: log })
  printRuntimeInstall(runtimeInstall, log)

  // Tell the user they're done and what to do next BEFORE the telemetry call —
  // the install-status report is best-effort and must not sit between them and
  // the "you're finished" signal. The agent who reported the setup couldn't tell
  // whether the connector had finished; this affirms it explicitly. Only claim
  // completion when the runtime install actually succeeded — an errorCode means
  // manual steps remain (e.g. an unrecognized runtime), so don't overstate it.
  if (runtimeInstall.errorCode) {
    log('Haven setup needs a couple more steps on this machine — see the notes above.')
  } else {
    log('Haven setup on this machine is complete.')
  }

  // Report the completed runtime state before polling for budget approval.
  // The dashboard intentionally withholds approval controls until it knows the
  // local runtime is configured; polling first would wait on controls the
  // connector itself has not made available yet. This remains best-effort
  // readiness metadata only: a failed report cannot activate the agent or
  // change its budget authority.
  try {
    await api.updateInstallStatus(registration.setup_id, localApiKey, {
      runtime: runtimeInstall.runtime,
      connectorVersion,
      runtimeMcpMode: runtimeInstall.runtimeMcpMode,
      hostedMcpConfigured: runtimeInstall.hostedMcpConfigured,
      localSignerConfigured: runtimeInstall.localSignerConfigured,
      localMcpConfigured: runtimeInstall.localMcpConfigured,
      credentialFilesWritten: true,
      signerAcknowledged: runtimeInstall.signerAcknowledged,
      localMcpAcknowledged: runtimeInstall.localMcpAcknowledged,
      activationCommandAvailable: Boolean(runtimeInstall.activationCommand),
      skillInstalled: runtimeInstall.skillInstalled,
      probeResult: runtimeInstall.probeResult,
      restartRequired: runtimeInstall.restartRequired,
      nextUserAction: runtimeInstall.nextUserAction,
      errorCode: runtimeInstall.errorCode,
      environmentLabel: options.environmentLabel ?? 'Local workspace',
    })
  } catch (err) {
    log(`Could not report install status to Haven: ${err instanceof Error ? err.message : String(err)}`)
  }

  // #1377 D: stay alive through the approval instead of going dead exactly
  // while the user acts. Skipped in structured/automation mode
  // (waitForApproval: false — the --json contract emits promptly) and when
  // the install itself needs manual completion first.
  if (options.waitForApproval !== false && !runtimeInstall.errorCode) {
    await waitForBudgetApproval(api, registration.setup_id, localApiKey, log, options.approvalWait)
  }

  printNextSteps(runtimeInstall, log)

  return {
    setupId: registration.setup_id,
    agentId: registration.agent_id,
    delegateAddress: registration.delegate_address,
    credentialPaths,
    outcome: completionOutcome({
      runtimeInstall,
      delegateAddress: registration.delegate_address,
      setupChallengeExpiresAt: setup.challenge.expires_at,
      approvalRequired: registration.agent_status === 'pending_approval',
    }),
  }
}

export function completionOutcome(input: {
  runtimeInstall: RuntimeInstallResult
  delegateAddress: string
  setupChallengeExpiresAt?: string
  approvalRequired: boolean
}): ConnectOutcome {
  const { runtimeInstall } = input
  const manualSetup = runtimeInstall.errorCode === 'manual_runtime_setup_required'
  const nextAction = runtimeInstall.nextUserAction
  const outcome: ConnectOutcome = {
    schema_version: CONNECT_OUTCOME_SCHEMA_VERSION,
    outcome: runtimeInstall.errorCode ? 'action_required' : 'complete',
    runtime: runtimeInstall.runtime,
    topology: runtimeInstall.runtimeMcpMode,
    configuration: {
      hosted_mcp: runtimeInstall.hostedMcpConfigured,
      local_signer: runtimeInstall.localSignerConfigured,
      local_mcp: runtimeInstall.localMcpConfigured,
    },
    probe: { result: runtimeInstall.probeResult },
    activation: {
      restart_required: runtimeInstall.restartRequired,
      instruction: manualSetup
        ? 'Finish the manual MCP setup using the secret-free references shown in normal Connect output, then start a fresh session.'
        : runtimeProfile(runtimeInstall.runtime).activationInstruction,
    },
    next_action: nextAction,
    approval: { required: input.approvalRequired, expires_at: null },
    verification: {
      tools: ['haven_get_agent', 'haven_get_allowances'] as const,
      instruction: runtimeVerificationInstruction(runtimeInstall.runtime),
    },
    // The backend contract supplies a 20-byte address. If an unexpected
    // malformed value arrives, do not echo it into an automation-facing
    // record; the human log has already been redacted separately.
    delegate_address: /^0x[0-9a-fA-F]{40}$/.test(input.delegateAddress)
      ? shortAddress(input.delegateAddress)
      : '[delegate-address-redacted]',
    ...(input.setupChallengeExpiresAt ? { setup_challenge_expires_at: input.setupChallengeExpiresAt } : {}),
    ...(runtimeInstall.errorCode
      ? { error: { code: runtimeInstall.errorCode, next_action: nextAction } }
      : {}),
  }
  return outcome
}

/**
 * A deliberately terse failure record: error messages can contain server or
 * filesystem detail, while this public contract must remain safe to serialize.
 */
export function failedConnectOutcome(runtimeHint: string | undefined, error: unknown): ConnectOutcome {
  const message = error instanceof Error ? error.message : ''
  const code = /Node\.js >=/i.test(message)
    ? 'unsupported_node_version'
    : /setup challenge.*expired|expired or invalid/i.test(message)
      ? 'setup_challenge_expired_or_invalid'
      : /only available for Claude Code and Codex/i.test(message)
        ? 'local_mcp_unsupported_runtime'
        : 'connect_failed'
  const runtime = normalizeRuntime(runtimeHint)
  const nextAction = code === 'setup_challenge_expired_or_invalid'
    ? 'return_to_haven_for_fresh_setup'
    : code === 'unsupported_node_version'
      ? 'install_supported_node_and_rerun_connect'
      : code === 'local_mcp_unsupported_runtime'
        ? 'rerun_without_local_mcp'
        : 'review_the_safe_error_output_and_start_a_fresh_haven_setup_if_needed'
  return {
    schema_version: CONNECT_OUTCOME_SCHEMA_VERSION,
    outcome: 'failed',
    runtime,
    topology: 'unknown',
    configuration: { hosted_mcp: false, local_signer: false, local_mcp: false },
    probe: { result: 'not_run' },
    activation: { restart_required: false, instruction: 'Resolve the reported problem before activating Haven tools.' },
    next_action: nextAction,
    approval: { required: false, expires_at: null },
    verification: {
      tools: ['haven_get_agent', 'haven_get_allowances'] as const,
      instruction: 'After a successful setup and activation, verify only with haven_get_agent and haven_get_allowances.',
    },
    error: { code, next_action: nextAction },
  }
}

function printSetupSummary(setup: ResolvedSetup, log: (message: string) => void): void {
  log(`Fetched Haven setup for ${setup.agent.name}.`)
  log(`Haven wallet: ${setup.haven_wallet.name} on ${setup.haven_wallet.network}.`)
  if (setup.agent_budget.length > 0) {
    for (const budget of setup.agent_budget) {
      log(
        `Agent budget: ${budget.allowance_amount} atomic ${budget.token_symbol} / ${budget.reset_period_min} minute reset.`,
      )
    }
  }
  log(`Setup challenge expires at ${setup.challenge.expires_at}. If it expires, return to Haven for a fresh setup and rerun Connect — do not reuse or paste credentials.`)
}

function assertSetupChallengeIsUsable(expiresAt: string): void {
  const expiresAtMs = Date.parse(expiresAt)
  if (!Number.isNaN(expiresAtMs) && expiresAtMs > Date.now()) return
  throw new Error(
    'This Haven setup challenge is expired or invalid. Return to Haven, start a fresh connection, and rerun Connect. No local credentials were written.',
  )
}

function isExpiredSetupChallenge(err: unknown): boolean {
  return err instanceof Error && /(?:setup )?challenge.*expir|expir.*(?:setup )?challenge/i.test(err.message)
}

function secureLogger(log: (message: string) => void, redactPaths = false): (message: string) => void {
  return (message) => {
    let safe = redactSecrets(message)
    if (redactPaths) {
      safe = safe
        .replace(/(?:~|\/)[^\s`"']*\/(?:identity|signer|agent)\.json\b/g, '[credential-file-redacted]')
        .replace(/(?:~|\/)[^\s`"']*\/\.env\b/g, '[credential-env-redacted]')
    }
    log(safe)
  }
}

function printRuntimeInstall(result: RuntimeInstallResult, log: (message: string) => void): void {
  for (const message of result.messages) log(message)
  if (result.localMcpConfigured) {
    log('Configured local Haven MCP tools.')
  } else if (result.hostedMcpConfigured) {
    log('Configured hosted Haven MCP identity.')
  } else {
    log('Haven MCP tools still need runtime setup.')
  }
  if (result.localSignerConfigured) {
    log('Configured local Haven signer.')
  } else {
    log('Local Haven signer still needs runtime setup.')
  }
}

/**
 * #1377 D: after registering, the connector no longer goes dead while the
 * user approves in Haven — it polls the narrow connector-status endpoint
 * (agent-API-key auth, works during `setup_pending`) and narrates progress in
 * the flow's voice, ending in a concrete celebration naming the granted
 * authority. Bounds (stated per the issue): poll every 5 s, give up after
 * 3 minutes — the connector ALWAYS terminates on its own; a timeout is a
 * clean exit with guidance, never a hang. Injectable clock/cadence for tests.
 */
export interface ApprovalWaitOptions {
  intervalMs?: number
  timeoutMs?: number
  sleep?: (ms: number) => Promise<void>
}

/** Human form of an atomic amount — whole numbers stay whole ("25", not "25.0"). */
function formatAtomicAmount(atomic: bigint, decimals: number): string {
  const s = atomic.toString().padStart(decimals + 1, '0')
  const intPart = s.slice(0, s.length - decimals) || '0'
  const fracPart = s.slice(s.length - decimals).replace(/0+$/, '')
  return fracPart ? `${intPart}.${fracPart}` : intPart
}

/**
 * #1426: one voice with the dashboard. The celebration line renders next to
 * the dashboard's approved screen describing the SAME grant, so every period
 * the dashboard offers (RESET_PERIODS: 0/1440/10080/43200) must phrase
 * identically to `budgetPeriodLabel`'s sentence form — "per 10080 minutes"
 * made the user do arithmetic on a reassurance message. `0` says "in total"
 * (the dashboard's sentence form), not "with no automatic reset" — one voice,
 * decided here rather than left as a recorded divergence.
 *
 * Deliberately NOT one source of truth with the frontend: the shared mapping
 * lives in dashboard code, and the only shared home would be
 * `@haven_ai/core` — a PRIVATE workspace package that published packages
 * (this one) must never depend on. Same structural reason the frontend keeps
 * an inline copy of the skill content; the parity tests are the coupling.
 */
function describeResetPeriod(resetPeriodMin: number): string {
  if (resetPeriodMin === 1440) return 'per day'
  if (resetPeriodMin === 10080) return 'per week'
  if (resetPeriodMin === 43200) return 'per month'
  if (resetPeriodMin === 60) return 'per hour'
  if (resetPeriodMin === 0) return 'in total'
  return `every ${resetPeriodMin} minutes`
}

function describeApprovedBudget(budget: {
  token_symbol: string
  token_address: string
  amount: string
  reset_period_min: number
}): string {
  const token = resolveTokenFromAddress(budget.token_address)
  const amount = token
    ? `${formatAtomicAmount(BigInt(budget.amount), token.decimals)} ${budget.token_symbol}`
    : `${budget.amount} ${budget.token_symbol} (atomic units)`
  return `${amount} ${describeResetPeriod(budget.reset_period_min)}`
}

export async function waitForBudgetApproval(
  api: Pick<ConnectApiClient, 'getConnectorStatus'>,
  setupId: string,
  apiKey: string,
  log: (message: string) => void,
  options: ApprovalWaitOptions = {},
): Promise<'approved' | 'pending' | 'ended'> {
  const intervalMs = options.intervalMs ?? 5_000
  const timeoutMs = options.timeoutMs ?? 180_000
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))
  const maxPolls = Math.max(1, Math.floor(timeoutMs / intervalMs))
  const remindEvery = Math.max(1, Math.floor(30_000 / intervalMs))

  log('Registered with Haven — waiting for you to approve the budget in the dashboard…')
  for (let i = 0; i < maxPolls; i++) {
    await sleep(intervalMs)
    let status: Awaited<ReturnType<ConnectApiClient['getConnectorStatus']>>
    try {
      status = await api.getConnectorStatus(setupId, apiKey)
    } catch (err) {
      // 401/404 are verdicts, not noise: the user cancelled the setup from
      // the dashboard (key revoked) or the setup is gone. Retrying for the
      // rest of the window and then saying "still pending" would be wrong —
      // there is nothing left to approve.
      if (err instanceof ConnectRequestError && (err.status === 401 || err.status === 404)) {
        log('This setup ended in Haven — start a fresh connection from the dashboard when ready.')
        return 'ended'
      }
      // A flaky poll is not a verdict — keep waiting inside the same bound.
      continue
    }
    if (status.status === 'active') {
      log(
        status.approved_budget
          ? `Budget approved 🎉 — I can now spend up to ${describeApprovedBudget(status.approved_budget)} from your Haven wallet.`
          : 'Budget approved 🎉 — the agent can now spend within its Haven rules.',
      )
      return 'approved'
    }
    if (status.status === 'cancelled' || status.status === 'expired' || status.status === 'failed') {
      log(`This setup ended in Haven (${status.status}) — start a fresh connection from the dashboard when ready.`)
      return 'ended'
    }
    if ((i + 1) % remindEvery === 0) {
      log('Still waiting for budget approval in Haven…')
    }
  }
  log(
    'Budget approval is still pending in Haven. Approve it in the dashboard whenever you are ready — ' +
      'the agent tools unlock the moment you do. Verify later with the read-only haven_get_agent tool.',
  )
  return 'pending'
}

/**
 * The two remaining gates after the local connector finishes: approve the rules
 * in Haven, then (for most runtimes) restart so the freshly-written MCP config
 * is loaded. The approval line states the dependency explicitly — tools never
 * appear before approval, restart or not — because an agent that had already
 * approved still couldn't tell whether missing tools meant "not approved" or
 * "needs restart."
 */
export function completionHandoffLines(result: RuntimeInstallResult): string[] {
  if (result.errorCode === 'manual_runtime_setup_required') {
    return [
      'Next steps:',
      '1. Return to Haven and approve the agent rules. Approval — not restarting — unlocks Haven tools.',
      '2. Finish the manual MCP setup using the secret-free file references printed above, then start a fresh session in your runtime.',
      `3. ${runtimeVerificationInstruction(result.runtime)}`,
    ]
  }
  if (result.errorCode) {
    return [
      'Recovery: runtime setup is not complete. Resolve the reported problem, then return to Haven for a fresh connection and run its new Connect command. Do not manually edit runtime config or paste credentials into prompts, logs, or config.',
    ]
  }

  const profile = runtimeProfile(result.runtime)
  return [
    'Next steps:',
    '1. Return to Haven and approve the agent rules. Approval — not restarting — unlocks Haven tools.',
    `2. ${profile.activationInstruction}`,
    `3. ${runtimeVerificationInstruction(result.runtime)}`,
  ]
}

function printNextSteps(result: RuntimeInstallResult, log: (message: string) => void): void {
  for (const line of completionHandoffLines(result)) log(line)
}
