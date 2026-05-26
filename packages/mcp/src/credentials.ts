import { readFile, stat } from 'node:fs/promises'

export interface HavenCredentialFile {
  apiKey: string
  delegateKey: string
  agentId?: string
  safeAddress?: string
  apiUrl?: string
  /**
   * Absolute path the credentials were loaded from, if any. Set when the
   * caller pointed at a JSON file via `--credentials` or `HAVEN_CREDENTIALS`;
   * left undefined when credentials came purely from environment variables.
   * The MCP server uses this to locate the consent sidecar
   * (`<sourcePath>.ack.json`) so `--ack` works regardless of how the
   * credential path was supplied.
   */
  sourcePath?: string
}

interface RawCredentialFile {
  api_key?: unknown
  apiKey?: unknown
  delegate_key?: unknown
  delegateKey?: unknown
  agent_id?: unknown
  agentId?: unknown
  safe_address?: unknown
  safeAddress?: unknown
  api_url?: unknown
  apiUrl?: unknown
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
  path: string | undefined = process.env.HAVEN_CREDENTIALS,
): Promise<HavenCredentialFile> {
  if (path) {
    return loadCredentialsFromFile(path)
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
    apiUrl: stringField(raw.api_url ?? raw.apiUrl),
    sourcePath: path,
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
    apiUrl: stringField(process.env.HAVEN_API_URL),
  }
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
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
