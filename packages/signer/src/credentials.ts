import { readFile } from 'node:fs/promises'
import {
  readAccountAddressEnv,
  readAccountAddressField,
  stringField,
} from '@haven_ai/sdk/edge'
import { warnIfFilePermissive } from './file-mode.js'

/**
 * The edge signer's own credential requires *only* `delegate_key` — unlike
 * `@haven_ai/mcp`, no `api_key` belongs in this file.
 *
 * That is a claim about this credential, not about the process, and the
 * difference matters: the sentence that used to stand here ("it does not call
 * the Haven API") was retired by #1263. The MCP server layer does make at
 * most two authenticated reads per signing call — a read-only
 * `GET /x402/:payment_id/sign-context` and, for a direct payment via
 * `haven_sign` since #3271, then `GET /payments/:payment_id/sign-context`, see
 * `sign-context.ts` — and it reads the `api_url` / `api_key` for them from a
 * SEPARATE `identity.json` in the same directory as the credential file
 * resolved here. That is why `sourcePath` below is load-bearing rather than
 * diagnostic, and why a key supplied through `HAVEN_DELEGATE_KEY` alone (no
 * file, so no directory) leaves that path with no identity to load and the
 * process making no network calls at all. The delegate key read here is never
 * part of any request or response either way.
 */
export interface SignerCredentials {
  delegateKey: string
  agentId?: string
  /** The Haven account (smart account) the agent spends from. */
  accountAddress?: string
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
  /** What `@haven_ai/connect` writes. */
  account_address?: unknown
  /** Pre-#2908 spelling — read PERMANENTLY (a credential file never rewrites itself), see `readAccountAddressField`. */
  safe_address?: unknown
  /** Pre-#2908 spelling — read PERMANENTLY (a credential file never rewrites itself), see `readAccountAddressField`. */
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
    const accountAddress = readAccountAddressEnv(process.env)
    return {
      delegateKey: envKey,
      agentId: stringField(process.env.HAVEN_AGENT_ID),
      accountAddress,
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

  const accountAddress = readAccountAddressField(raw)
  return {
    delegateKey,
    agentId: stringField(raw.agent_id ?? raw.agentId),
    accountAddress,
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

/**
 * The account-address readers moved to `@haven_ai/sdk/edge` (#4792) — the local
 * MCP carried a second copy of them. Re-exported here because this package's
 * tests and callers import them from `./credentials.js`.
 */
export { readAccountAddressEnv, readAccountAddressField } from '@haven_ai/sdk/edge'

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
 * its owner. The check itself is shared with `@haven_ai/mcp` (#4792); the
 * `haven-signer:` prefix and the exact message are unchanged.
 *
 * Exported for testing.
 */
export async function warnIfCredentialFilePermissive(
  path: string,
  log: (message: string) => void = (message) => process.stderr.write(`${message}\n`),
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  await warnIfFilePermissive('credential file', path, log, platform)
}
