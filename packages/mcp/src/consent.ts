import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { HavenAllowance, HavenClient } from '@haven_ai/sdk'
import { toolDescriptions, toolSchemas, type HavenMcpToolName } from './tools.js'

/**
 * First-launch consent gate for the Haven MCP server.
 *
 * Why this exists (option A of issue #163): an agent runtime that loads a
 * Haven credential file is about to expose Haven payment tools to a model.
 * Before the server starts taking JSON-RPC calls we want the operator to
 * acknowledge — exactly once per credential + tool set — what those tools
 * can do and what the on-chain allowance cap actually is. The on-chain
 * AllowanceModule remains the policy primitive; this gate is informational
 * rather than enforcement.
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
  toolNames: readonly HavenMcpToolName[]
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
  return createHash('sha256')
    .update(`${input.apiKeyPrefix}\n${toolCanonical}\n${allowanceCanonical}`)
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
    '',
    'Tools this server will expose to your agent runtime:',
  ]
  for (const name of input.toolNames) {
    lines.push(`  • ${name}`)
    lines.push(`      ${toolDescriptions[name]}`)
  }
  lines.push('')
  if (input.allowanceSummary.length === 0) {
    lines.push('On-chain allowance: none configured.')
    lines.push('  Any payment will queue for manual approval. The on-chain')
    lines.push('  Safe AllowanceModule is the real spend gate.')
  } else {
    lines.push('On-chain allowance (the real spend gate, Safe AllowanceModule):')
    for (const a of input.allowanceSummary) {
      const reset = a.resetMinutes ? ` per ${a.resetMinutes} min` : ' (no reset)'
      lines.push(`  • up to ${a.amount} ${a.token}${reset}`)
    }
  }
  lines.push('')
  lines.push('Anything above the on-chain allowance pauses for owner approval')
  lines.push('in the Haven dashboard. Revoking the agent on-chain disables')
  lines.push('every MCP tool that would spend.')
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

/**
 * Build the consent input from the credential prefix and a live allowance
 * lookup. The on-chain (or configured) allowance is what the operator
 * actually cares about — that's the real spend ceiling.
 *
 * If `getAllowances()` fails (e.g. backend unreachable on first launch) we
 * fall through to an empty summary so the operator at least sees the tool
 * list and the apiKey prefix. The consent block makes it explicit that no
 * allowance was found.
 */
export async function consentInputFromClient(
  haven: HavenClient,
  apiKey: string,
  toolNames: readonly HavenMcpToolName[],
): Promise<ConsentInput> {
  let allowanceSummary: ConsentInput['allowanceSummary'] = []

  try {
    const summary = await haven.getAllowances()
    const list: HavenAllowance[] = Array.isArray(summary)
      ? (summary as HavenAllowance[])
      : (summary?.allowances ?? [])
    allowanceSummary = list.map((a) => ({
      token: a.tokenSymbol ?? 'UNKNOWN',
      amount: a.onchain?.amount ?? a.configuredAmount ?? '0',
      resetMinutes:
        typeof a.onchain?.resetTimeMin === 'number'
          ? a.onchain.resetTimeMin
          : typeof a.resetPeriodMin === 'number'
            ? a.resetPeriodMin
            : null,
    }))
  } catch {
    // Leave the empty array; the operator will see the no-allowance message.
  }

  return {
    apiKeyPrefix: derivePrefix(apiKey),
    toolNames,
    allowanceSummary,
  }
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

/** Convenience: the canonical tool list registered by the server. */
export function registeredToolNames(): HavenMcpToolName[] {
  return Object.keys(toolSchemas) as HavenMcpToolName[]
}
