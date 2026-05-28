import { readFile, stat } from 'node:fs/promises'

/**
 * The edge signer only needs the delegate key — it signs, it does not call the
 * Haven API. Identity (the `api_key`) lives with the hosted MCP connection, not
 * here. So unlike `@haven_ai/mcp`, this loader requires *only* `delegate_key`.
 */
export interface SignerCredentials {
  delegateKey: string
  agentId?: string
  safeAddress?: string
  chainId?: number
  network?: string
  /** Absolute path the key was loaded from, if a file was used. */
  sourcePath?: string
}

interface RawCredentialFile {
  delegate_key?: unknown
  delegateKey?: unknown
  agent_id?: unknown
  agentId?: unknown
  safe_address?: unknown
  safeAddress?: unknown
  chain_id?: unknown
  chainId?: unknown
  network?: unknown
}

/**
 * Resolve the delegate key for the edge signer.
 *
 * Order — earlier wins:
 *   1. Explicit `path` (e.g. `--credentials <path>`).
 *   2. `HAVEN_CREDENTIALS` env var pointing at a credential JSON file.
 *   3. `HAVEN_DELEGATE_KEY` env var.
 *
 * The same credential JSON the dashboard emits works here — we just read its
 * `delegate_key` and ignore the rest.
 */
export async function loadSignerCredentials(
  path: string | undefined = process.env.HAVEN_CREDENTIALS,
): Promise<SignerCredentials> {
  if (path) return loadFromFile(path)

  const envKey = stringField(process.env.HAVEN_DELEGATE_KEY)
  if (envKey) {
    return {
      delegateKey: envKey,
      agentId: stringField(process.env.HAVEN_AGENT_ID),
      safeAddress: stringField(process.env.HAVEN_SAFE_ADDRESS),
      chainId: numberField(process.env.HAVEN_CHAIN_ID),
      network: stringField(process.env.HAVEN_NETWORK),
    }
  }

  throw new Error(
    'No delegate key found. Set HAVEN_DELEGATE_KEY, pass --credentials <path>, ' +
      'or set HAVEN_CREDENTIALS to a Haven agent credential JSON file.',
  )
}

async function loadFromFile(path: string): Promise<SignerCredentials> {
  let rawText: string
  try {
    rawText = await readFile(path, 'utf8')
  } catch (err) {
    throw new Error(
      `Could not read Haven credentials at ${path}: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  await warnIfCredentialFilePermissive(path)

  let raw: RawCredentialFile
  try {
    raw = JSON.parse(rawText) as RawCredentialFile
  } catch {
    throw new Error('Haven credentials must be JSON with a delegate_key field.')
  }

  const delegateKey = stringField(raw.delegate_key ?? raw.delegateKey)
  if (!delegateKey) {
    throw new Error('Haven credentials are missing delegate_key — the edge signer needs it to sign.')
  }

  const chainId = numberField(raw.chain_id ?? raw.chainId)
  return {
    delegateKey,
    agentId: stringField(raw.agent_id ?? raw.agentId),
    safeAddress: stringField(raw.safe_address ?? raw.safeAddress),
    chainId,
    network: stringField(raw.network),
    sourcePath: path,
  }
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function numberField(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

/**
 * Warn (best-effort, POSIX only) when the credential file is readable beyond
 * its owner. Mirrors `@haven_ai/mcp`'s check — the delegate key is the most
 * sensitive thing on the machine.
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
    mode = (await stat(path)).mode
  } catch {
    return
  }
  if ((mode & 0o077) !== 0) {
    const octal = (mode & 0o777).toString(8).padStart(4, '0')
    log(
      `haven-signer: warning: credential file at ${path} is readable beyond the owner ` +
        `(mode ${octal}). Run: chmod 600 ${path}`,
    )
  }
}
