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
  x402BindingSigner?: string
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
  x402_binding_signer?: unknown
  x402BindingSigner?: unknown
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
      chainId: chainIdField(process.env.HAVEN_CHAIN_ID, 'HAVEN_CHAIN_ID'),
      network: stringField(process.env.HAVEN_NETWORK),
      x402BindingSigner: stringField(process.env.HAVEN_X402_BINDING_SIGNER),
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

  return {
    delegateKey,
    agentId: stringField(raw.agent_id ?? raw.agentId),
    safeAddress: stringField(raw.safe_address ?? raw.safeAddress),
    chainId: chainIdField(raw.chain_id ?? raw.chainId, 'chain_id'),
    network: stringField(raw.network),
    x402BindingSigner: stringField(
      raw.x402_binding_signer ??
        raw.x402BindingSigner ??
        process.env.HAVEN_X402_BINDING_SIGNER,
    ),
    sourcePath: path,
  }
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function chainIdField(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null) return undefined

  if (typeof value === 'number') {
    if (Number.isSafeInteger(value) && value > 0) return value
    throw invalidChainIdError(label)
  }

  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (/^[1-9]\d*$/.test(trimmed)) {
      const parsed = Number(trimmed)
      if (Number.isSafeInteger(parsed)) return parsed
    }
    throw invalidChainIdError(label)
  }

  throw invalidChainIdError(label)
}

function invalidChainIdError(label: string): Error {
  return new Error(`Haven signer credentials ${label} must be a positive integer.`)
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
