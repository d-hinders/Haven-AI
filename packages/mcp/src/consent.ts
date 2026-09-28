import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { HavenAllowance, HavenAllowanceSummary, HavenClient } from '@haven_ai/sdk'
import { formatTokenAmount, resolveTokenBySymbol } from '@haven_ai/sdk'
import { toolDescriptions, toolSchemas, type HavenMcpToolName } from './tools.js'

/**
 * First-launch consent gate for the Haven MCP server.
 *
 * Why this exists (option A of issue #163): an agent runtime that loads a
 * Haven credential file is about to expose Haven payment tools to a model.
 * Before the server starts taking JSON-RPC calls we want the operator to
 * acknowledge — exactly once per credential + tool set — what those tools
 * can do and what the on-chain budget actually is. The agent's budget
 * delegation and its caveat enforcers remain the policy primitive; this gate
 * is informational rather than enforcement.
 *
 * #2086: the copy below used to describe the legacy Safe AllowanceModule and
 * an approval queue that would catch an over-budget payment. Both are gone —
 * the AllowanceModule rail is retired (#1986) and the approval queue's table
 * with it (#2055) — so the gate was promising an operator a human backstop
 * that does not exist. It is now one accurate description of the delegation
 * rail rather than rail-aware prose, because the delegation rail is the only
 * rail that can pay at all: a legacy account gets HTTP 410 from the payment
 * paths, so a second branch here would describe a state no reader can be in.
 *
 * Resolution:
 *   - `HAVEN_MCP_ACK=<hash>` env var matching the current consent hash → pass.
 *   - `HAVEN_MCP_ACK=skip` → pass (intended for CI / scripted setups).
 *   - sidecar file `<credentials>.ack.json` containing `{ ack: <hash> }` → pass.
 *   - `--ack` CLI flag → write the sidecar file, print the consent block, pass.
 *   - otherwise → print the consent block to stderr and exit non-zero.
 *
 * The hash binds the api-key prefix to the registered tool set and the
 * agent's current allowance summary, so a configuration change re-triggers
 * the prompt.
 */

export interface ConsentInput {
  apiKeyPrefix: string
  /** Haven API base URL the credential will hit. */
  apiUrl?: string
  /** Agent identity from the credential file, when present. */
  agentId?: string
  /** Haven wallet the agent spends from. */
  accountAddress?: string
  /** Agent's delegate EOA — the local signer. */
  delegateAddress?: string
  /** Chain the agent operates on. */
  chainId?: number
  toolNames: readonly HavenMcpToolName[]
  /**
   * #3410: every amount here is ATOMIC (smallest on-chain units, e.g. 6
   * decimals for USDC — `1000000` is one USDC, never "1000000 tokens"). Both
   * producers agree: the live read takes `onchain.amount`, and the seed takes
   * the credential file's `allowance_amount` — both atomic. `renderConsentBlock`
   * converts for display through the token registry and falls back to an
   * explicit `(atomic units)` label when the token is unknown; the consent
   * hash deliberately covers the atomic string, so a display change alone
   * never re-prompts the operator.
   *
   * Known limitation (#3410, stated not fixed): the seed is setup-time data.
   * If the wallet owner edits the budget after setup AND the live read then
   * fails, the screen shows the stale seed budget as if it were current.
   */
  allowanceSummary: readonly { token: string; amount: string; resetMinutes: number | null }[]
}

export interface ConsentDecision {
  /** True if the gate is satisfied and the server may start. */
  ok: boolean
  /** Hash representing the current consent surface. */
  hash: string
  /** Reason the gate accepted (or rejected) the run. */
  reason:
    | 'env_var_match'
    | 'env_var_skip'
    | 'ack_file_match'
    | 'wrote_ack_file'
    | 'env_var_mismatch'
    | 'no_acknowledgement'
}

export interface ConsentOptions {
  /** Path to the credential file; used to locate the sidecar `<path>.ack.json`. */
  credentialsPath?: string
  /** When true, write the sidecar file with the current hash and accept. */
  writeAck?: boolean
  /** Override the environment lookup (testing). */
  env?: Record<string, string | undefined>
  /** Override the writable stream the consent block is printed to (testing). */
  out?: { write: (chunk: string) => unknown }
}

export function computeConsentHash(input: ConsentInput): string {
  const allowanceCanonical = [...input.allowanceSummary]
    .map((a) => `${a.token}:${a.amount}:${a.resetMinutes ?? 'none'}`)
    .sort()
    .join('|')
  const toolCanonical = [...input.toolNames].sort().join(',')
  // Identity fields are included in the hash so swapping the credential
  // to a different Haven wallet / delegate / chain — even one with an
  // identical allowance set — invalidates the prior sidecar and re-prompts
  // the operator. Addresses are normalised to lowercase so casing changes
  // in the credential file don't gratuitously re-prompt.
  const identity = [
    input.apiKeyPrefix,
    input.apiUrl ?? '',
    input.agentId ?? '',
    (input.accountAddress ?? '').toLowerCase(),
    (input.delegateAddress ?? '').toLowerCase(),
    input.chainId ?? '',
  ].join('|')
  return createHash('sha256')
    .update(`${identity}\n${toolCanonical}\n${allowanceCanonical}`)
    .digest('hex')
    .slice(0, 16)
}

export function renderConsentBlock(input: ConsentInput, hash: string): string {
  const lines: string[] = [
    '',
    '────────────────────────────────────────────────────────────',
    'Haven MCP server — first-launch consent',
    '────────────────────────────────────────────────────────────',
    '',
    `Credential: ${input.apiKeyPrefix}…`,
  ]
  if (input.apiUrl) lines.push(`Haven API: ${input.apiUrl}`)
  if (input.agentId) lines.push(`Agent ID:  ${input.agentId}`)
  if (input.accountAddress) lines.push(`Haven wallet: ${input.accountAddress}`)
  if (input.delegateAddress) lines.push(`Delegate (local signer): ${input.delegateAddress}`)
  if (typeof input.chainId === 'number') lines.push(`Chain ID:  ${input.chainId}`)
  lines.push('')
  lines.push('Confirm these match the Haven wallet and chain you intend the')
  lines.push('agent runtime to use. The delegate above is the only key that')
  lines.push('signs payments — it lives in this process, not on Haven\'s backend.')
  lines.push('')
  lines.push('Tools this server will expose to your agent runtime:')
  for (const name of input.toolNames) {
    lines.push(`  • ${name}`)
    lines.push(`      ${toolDescriptions[name]}`)
  }
  lines.push('')
  if (input.allowanceSummary.length === 0) {
    lines.push('On-chain budget: none configured.')
    lines.push('  Until the wallet owner grants this agent a budget in Haven,')
    lines.push('  every payment it attempts is declined on-chain.')
  } else {
    lines.push('On-chain budget (the real spend gate — enforced by the agent\'s')
    lines.push('signed delegation, not by Haven):')
    for (const a of input.allowanceSummary) {
      const reset = a.resetMinutes ? ` per ${a.resetMinutes} min` : ' (no reset)'
      lines.push(`  • up to ${describeBudgetAmount(a, input.chainId)}${reset}`)
    }
  }
  lines.push('')
  lines.push('Anything above the on-chain budget is declined before any money')
  lines.push('moves — it is not queued, and no one is asked to review it. If the')
  lines.push('agent needs more room, the wallet owner grants or raises the budget')
  lines.push('in Haven. Revoking the agent on-chain disables every MCP tool that')
  lines.push('would spend.')
  lines.push('')
  lines.push(`Consent hash: ${hash}`)
  lines.push('')
  lines.push('To acknowledge, EITHER:')
  lines.push(`  • set HAVEN_MCP_ACK=${hash} in this process\'s environment, OR`)
  lines.push('  • re-run with --ack to write the acknowledgement next to your')
  lines.push('    credential file (sidecar <credentials>.ack.json).')
  lines.push('')
  lines.push('────────────────────────────────────────────────────────────')
  lines.push('')
  return lines.join('\n')
}

/** Resolve the consent gate. Does not exit the process; the caller decides. */
export async function ensureConsent(
  input: ConsentInput,
  options: ConsentOptions = {},
): Promise<ConsentDecision> {
  const env = options.env ?? process.env
  const out = options.out ?? process.stderr
  const hash = computeConsentHash(input)

  // 1) Explicit skip — for CI and scripted environments.
  if (env.HAVEN_MCP_ACK === 'skip') {
    return { ok: true, hash, reason: 'env_var_skip' }
  }

  // 2) Env var hash match.
  if (typeof env.HAVEN_MCP_ACK === 'string' && env.HAVEN_MCP_ACK.length > 0) {
    if (env.HAVEN_MCP_ACK === hash) {
      return { ok: true, hash, reason: 'env_var_match' }
    }
    out.write(renderConsentBlock(input, hash))
    out.write(
      `HAVEN_MCP_ACK was set but did not match the current consent hash.\n` +
      `Expected: ${hash}\n` +
      `Got:      ${env.HAVEN_MCP_ACK}\n` +
      `Re-acknowledge with the new hash above, or run with --ack.\n\n`,
    )
    return { ok: false, hash, reason: 'env_var_mismatch' }
  }

  // 3) Sidecar ack file (only meaningful when we loaded from a file).
  const ackPath = sidecarPath(options.credentialsPath)
  if (ackPath) {
    const stored = await readAckFile(ackPath)
    if (stored?.ack === hash) {
      return { ok: true, hash, reason: 'ack_file_match' }
    }
  }

  // 4) --ack: write the sidecar and accept.
  if (options.writeAck && ackPath) {
    out.write(renderConsentBlock(input, hash))
    await writeAckFile(ackPath, hash)
    out.write(`Wrote acknowledgement to ${ackPath}\n\n`)
    return { ok: true, hash, reason: 'wrote_ack_file' }
  }

  // 5) Otherwise: print and refuse.
  out.write(renderConsentBlock(input, hash))
  return { ok: false, hash, reason: 'no_acknowledgement' }
}

function sidecarPath(credentialsPath?: string): string | null {
  if (!credentialsPath) return null
  return resolve(`${credentialsPath}.ack.json`)
}

async function readAckFile(path: string): Promise<{ ack?: string } | null> {
  try {
    const raw = await readFile(path, 'utf8')
    const parsed = JSON.parse(raw) as { ack?: unknown }
    return { ack: typeof parsed.ack === 'string' ? parsed.ack : undefined }
  } catch {
    return null
  }
}

async function writeAckFile(path: string, hash: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(
    path,
    JSON.stringify({ ack: hash, at: new Date().toISOString() }, null, 2),
    'utf8',
  )
}

export interface CredentialIdentitySeed {
  apiKey: string
  apiUrl?: string
  agentId?: string
  /** Account address from the credential file, used as a fallback. */
  accountAddress?: string
  /** Delegate address from the credential file, used before live allowance metadata is available. */
  delegateAddress?: string
  /** Chain from the credential file, used as a fallback. */
  chainId?: number
  /**
   * Intended agent budget from the setup flow, used before on-chain approval
   * is visible. #3410: every amount is ATOMIC — the connector writes the
   * credential file's `allowance_amount` straight from the setup response's
   * `agent_budget`, and the backend puts `budget_atomic` there.
   */
  allowanceSummary?: readonly { token: string; amount: string; resetMinutes: number | null }[]
}

/**
 * Build the consent input from credential identity plus a live allowance
 * lookup. The on-chain (or configured) allowance is what the operator
 * actually cares about — that's the real spend ceiling — but we also bind
 * the hash to the Haven wallet / delegate / chain so a credential swap
 * cannot quietly reuse a prior sidecar acknowledgement.
 *
 * If `getAllowances()` fails (e.g. backend unreachable on first launch) we
 * fall through to whatever identity fields the credential file provided,
 * so the operator at least sees the tool list and the api-key prefix.
 */
export async function consentInputFromClient(
  haven: HavenClient,
  seed: CredentialIdentitySeed,
  toolNames: readonly HavenMcpToolName[],
): Promise<ConsentInput> {
  let allowanceSummary: ConsentInput['allowanceSummary'] = seed.allowanceSummary ?? []
  let accountAddress = seed.accountAddress
  let delegateAddress: string | undefined = seed.delegateAddress
  let chainId: number | undefined = seed.chainId

  try {
    const summary = await haven.getAllowances()
    const list: HavenAllowance[] = isAllowanceSummary(summary)
      ? summary.allowances
      : Array.isArray(summary)
        ? (summary as HavenAllowance[])
        : []
    if (isAllowanceSummary(summary)) {
      accountAddress = summary.accountAddress ?? accountAddress
      delegateAddress = summary.delegateAddress
      chainId = typeof summary.chainId === 'number' ? summary.chainId : chainId
    }
    const liveAllowanceSummary = list.map((a) => ({
      token: a.tokenSymbol ?? 'UNKNOWN',
      // #3410: `onchain.amount` is the atomic budget (`budget_atomic` on the
      // backend). The old `a.configuredAmount` fallback here was unreachable
      // — `onchain` is required in the SDK types and dereferenced
      // unconditionally, so a response without it throws into the seed path —
      // and it was the one HUMAN-decimal value in this chain; a human number
      // must never reach an atomic field. '0' keeps the (defensive) shape for
      // a malformed onchain object without inventing a unit.
      amount: a.onchain?.amount ?? '0',
      resetMinutes:
        typeof a.onchain?.resetTimeMin === 'number'
          ? a.onchain.resetTimeMin
          : typeof a.resetPeriodMin === 'number'
            ? a.resetPeriodMin
            : null,
    }))
    allowanceSummary = liveAllowanceSummary
  } catch {
    // Identity falls back to what the credential file gave us.
  }

  return {
    apiKeyPrefix: derivePrefix(seed.apiKey),
    apiUrl: seed.apiUrl,
    agentId: seed.agentId,
    accountAddress,
    delegateAddress,
    chainId,
    toolNames,
    allowanceSummary,
  }
}

function isAllowanceSummary(value: unknown): value is HavenAllowanceSummary {
  return (
    typeof value === 'object' &&
    value !== null &&
    'allowances' in value &&
    Array.isArray((value as { allowances: unknown }).allowances)
  )
}

/**
 * Use the leading characters of the api key (which already begins with the
 * non-secret `sk_agent_` prefix) as a stable, low-information identifier.
 * Twelve characters is enough to disambiguate credentials in front of a
 * human but not enough to reveal the secret.
 */
function derivePrefix(apiKey: string): string {
  return apiKey.slice(0, 12)
}

/**
 * #3410: one budget, one display form. The consent screen is the surface
 * whose job is informed consent — an atomic number printed as whole tokens
 * overstates the budget a millionfold — so every amount is rendered in whole
 * tokens when the token is known (`resolveTokenBySymbol` over the same
 * registry the SDK's address-based reads use) and carries an explicit
 * `(atomic units)` label when it is not, mirroring connect's
 * `describeApprovedBudget` fallback. This is DISPLAY ONLY: the consent hash
 * keeps covering the raw atomic string, byte-identical to what every
 * installed sidecar acknowledged before this change.
 */
function describeBudgetAmount(a: { token: string; amount: string }, chainId: number | undefined): string {
  const token = chainId === undefined ? null : resolveTokenBySymbol(chainId, a.token)
  if (!token) return `${a.amount} ${a.token} (atomic units)`
  return `${formatTokenAmount(a.amount, token.decimals)} ${a.token}`
}

/** Convenience: the canonical tool list registered by the server. */
export function registeredToolNames(): HavenMcpToolName[] {
  return Object.keys(toolSchemas) as HavenMcpToolName[]
}
