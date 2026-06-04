import { readFile, stat } from 'node:fs/promises'

export interface HavenCredentialFile {
  apiKey: string
  delegateKey: string
  agentId?: string
  safeAddress?: string
  delegateAddress?: string
  chainId?: number
  network?: string
  apiUrl?: string
  allowanceSummary?: readonly HavenCredentialAllowance[]
  /**
   * Absolute path the credentials were loaded from, if any. Set when the
   * caller pointed at a JSON file via `--credentials` or `HAVEN_CREDENTIALS`;
   * left undefined when credentials came purely from environment variables.
   * The MCP server uses this to locate the consent sidecar
   * (`<sourcePath>.ack.json`) so `--ack` works regardless of how the
   * credential path was supplied.
   */
  sourcePath?: string
  identityPath?: string
  signerPath?: string
}

export interface HavenCredentialAllowance {
  token: string
  amount: string
  resetMinutes: number | null
}

export interface HavenCredentialSource {
  credentialsPath?: string
  identityPath?: string
  signerPath?: string
}

interface RawCredentialFile {
  api_key?: unknown
  apiKey?: unknown
  delegate_key?: unknown
  delegateKey?: unknown
  delegate_address?: unknown
  delegateAddress?: unknown
  agent_id?: unknown
  agentId?: unknown
  safe_address?: unknown
  safeAddress?: unknown
  chain_id?: unknown
  chainId?: unknown
  network?: unknown
  api_url?: unknown
  apiUrl?: unknown
  hosted_mcp_url?: unknown
  hostedMcpUrl?: unknown
  allowance_summary?: unknown
  allowanceSummary?: unknown
  agent_budget?: unknown
  agentBudget?: unknown
}

/**
 * Load Haven agent credentials for the MCP server.
 *
 * Resolution order — earlier sources win, later sources are fallbacks:
 *
 *   1. Explicit `path` argument (typically from `--credentials <path>`).
 *   2. `HAVEN_CREDENTIALS` env var pointing at a credential JSON file.
 *   3. Inline env vars: `HAVEN_API_KEY` + `HAVEN_DELEGATE_KEY` (+ optional
 *      `HAVEN_AGENT_ID`, `HAVEN_SAFE_ADDRESS`, `HAVEN_API_URL`).
 *
 * The inline-env path exists so that runtime config snippets emitted by the
 * Haven dashboard (Claude Desktop / Cursor / generic MCP configs) can be a
 * single self-contained block — paste the snippet, restart the runtime, done.
 * The values still live only in the agent operator's process environment;
 * Haven's backend never sees the delegate key either way.
 */
export async function loadCredentials(
  source: string | HavenCredentialSource | undefined = process.env.HAVEN_CREDENTIALS,
): Promise<HavenCredentialFile> {
  if (typeof source === 'string') {
    return loadCredentialsFromFile(source)
  }
  if (source?.credentialsPath) {
    return loadCredentialsFromFile(source.credentialsPath)
  }
  if (source?.identityPath || source?.signerPath) {
    if (!source.identityPath || !source.signerPath) {
      throw new Error('Haven split credentials require both --identity and --signer paths.')
    }
    return loadCredentialsFromSplitFiles(source.identityPath, source.signerPath)
  }

  const envCreds = loadCredentialsFromEnv()
  if (envCreds) return envCreds

  throw new Error(
    'No Haven credentials found. Set HAVEN_CREDENTIALS to a Haven agent credential JSON file, ' +
    'pass --credentials <path>, or set HAVEN_API_KEY and HAVEN_DELEGATE_KEY environment variables.',
  )
}

async function loadCredentialsFromFile(path: string): Promise<HavenCredentialFile> {
  let rawText: string
  try {
    rawText = await readFile(path, 'utf8')
  } catch (err) {
    throw new Error(`Could not read Haven credentials at ${path}: ${err instanceof Error ? err.message : String(err)}`)
  }

  await warnIfCredentialFilePermissive(path)

  let raw: RawCredentialFile
  try {
    raw = JSON.parse(rawText) as RawCredentialFile
  } catch {
    throw new Error('Haven credentials must be JSON with api_key and delegate_key fields.')
  }

  const apiKey = stringField(raw.api_key ?? raw.apiKey)
  const delegateKey = stringField(raw.delegate_key ?? raw.delegateKey)

  if (!apiKey) {
    throw new Error('Haven credentials are missing api_key.')
  }
  if (!delegateKey) {
    throw new Error('Haven MCP requires delegate_key so payments can be signed locally.')
  }

  return {
      apiKey,
      delegateKey,
      agentId: stringField(raw.agent_id ?? raw.agentId),
      safeAddress: stringField(raw.safe_address ?? raw.safeAddress),
      delegateAddress: stringField(raw.delegate_address ?? raw.delegateAddress),
      chainId: numberField(raw.chain_id ?? raw.chainId),
      network: stringField(raw.network),
      apiUrl: stringField(raw.api_url ?? raw.apiUrl),
      allowanceSummary: allowanceSummaryField(raw.allowance_summary ?? raw.allowanceSummary ?? raw.agent_budget ?? raw.agentBudget),
      sourcePath: path,
    }
}

async function loadCredentialsFromSplitFiles(identityPath: string, signerPath: string): Promise<HavenCredentialFile> {
  const identity = await readJsonFile(identityPath, 'Haven identity credentials')
  const signer = await readJsonFile(signerPath, 'Haven signer credentials')

  await warnIfCredentialFilePermissive(identityPath)
  await warnIfCredentialFilePermissive(signerPath)

  const apiKey = stringField(identity.api_key ?? identity.apiKey)
  const delegateKey = stringField(signer.delegate_key ?? signer.delegateKey)

  if (!apiKey) {
    throw new Error('Haven identity credentials are missing api_key.')
  }
  if (!delegateKey) {
    throw new Error('Haven signer credentials are missing delegate_key.')
  }

  return {
    apiKey,
    delegateKey,
    agentId: stringField(identity.agent_id ?? identity.agentId ?? signer.agent_id ?? signer.agentId),
    safeAddress: stringField(identity.safe_address ?? identity.safeAddress ?? signer.safe_address ?? signer.safeAddress),
    delegateAddress: stringField(signer.delegate_address ?? signer.delegateAddress ?? identity.delegate_address ?? identity.delegateAddress),
    chainId: numberField(identity.chain_id ?? identity.chainId ?? signer.chain_id ?? signer.chainId),
    network: stringField(identity.network ?? signer.network),
    apiUrl: stringField(identity.api_url ?? identity.apiUrl),
    allowanceSummary: allowanceSummaryField(
      identity.allowance_summary ??
        identity.allowanceSummary ??
        identity.agent_budget ??
        identity.agentBudget,
    ),
    sourcePath: identityPath,
    identityPath,
    signerPath,
  }
}

async function readJsonFile(path: string, label: string): Promise<RawCredentialFile> {
  let rawText: string
  try {
    rawText = await readFile(path, 'utf8')
  } catch (err) {
    throw new Error(`Could not read ${label} at ${path}: ${err instanceof Error ? err.message : String(err)}`)
  }

  try {
    return JSON.parse(rawText) as RawCredentialFile
  } catch {
    throw new Error(`${label} must be JSON.`)
  }
}

function loadCredentialsFromEnv(): HavenCredentialFile | null {
  const apiKey = stringField(process.env.HAVEN_API_KEY)
  const delegateKey = stringField(process.env.HAVEN_DELEGATE_KEY)

  if (!apiKey && !delegateKey) return null

  if (!apiKey) {
    throw new Error('HAVEN_DELEGATE_KEY is set but HAVEN_API_KEY is missing.')
  }
  if (!delegateKey) {
    throw new Error('HAVEN_API_KEY is set but HAVEN_DELEGATE_KEY is missing. Haven MCP requires a delegate key so payments can be signed locally.')
  }

  return {
    apiKey,
    delegateKey,
      agentId: stringField(process.env.HAVEN_AGENT_ID),
      safeAddress: stringField(process.env.HAVEN_SAFE_ADDRESS),
      chainId: numberField(process.env.HAVEN_CHAIN_ID),
      network: stringField(process.env.HAVEN_NETWORK),
      apiUrl: stringField(process.env.HAVEN_API_URL),
    }
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function numberField(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() && /^\d+$/.test(value.trim())) return Number(value.trim())
  return undefined
}

function allowanceSummaryField(value: unknown): HavenCredentialAllowance[] | undefined {
  if (!Array.isArray(value)) return undefined
  const allowances = value.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const raw = item as Record<string, unknown>
    const token = stringField(raw.token ?? raw.token_symbol ?? raw.tokenSymbol)
    const amount = stringField(raw.amount ?? raw.allowance_amount ?? raw.allowanceAmount)
    const reset = raw.resetMinutes ?? raw.reset_minutes ?? raw.reset_period_min ?? raw.resetPeriodMin
    if (!token || !amount) return []
    return [{
      token,
      amount,
      resetMinutes: reset === null ? null : numberField(reset) ?? null,
    }]
  })
  return allowances.length > 0 ? allowances : undefined
}

/**
 * Warn (but do not block) when the credential file is readable by users
 * other than the owner. The check is best-effort: it only runs on POSIX
 * filesystems where the stat mode bits map cleanly. Windows ACLs require
 * `icacls`-style introspection that doesn't fit a single stat call, so we
 * skip the check there and the dashboard handoff text guides the user
 * separately.
 *
 * Exported for testing.
 */
export async function warnIfCredentialFilePermissive(
  path: string,
  log: (message: string) => void = (message) => process.stderr.write(`${message}\n`),
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  if (platform === 'win32') return

  let mode: number
  try {
    const stats = await stat(path)
    mode = stats.mode
  } catch {
    // The credential read already failed cleanly above if the file is
    // unreadable. A stat failure here is not worth blocking on.
    return
  }

  const groupOrOther = mode & 0o077
  if (groupOrOther !== 0) {
    const octal = (mode & 0o777).toString(8).padStart(4, '0')
    log(
      `haven-mcp: warning: credential file at ${path} is readable beyond the owner ` +
      `(mode ${octal}). Run: chmod 600 ${path}`,
    )
  }
}
