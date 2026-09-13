import { readFile, stat } from 'node:fs/promises'

/**
 * The edge signer's own credential requires *only* `delegate_key` — unlike
 * `@haven_ai/mcp`, no `api_key` belongs in this file.
 *
 * That is a claim about this credential, not about the process, and the
 * difference matters: the sentence that used to stand here ("it does not call
 * the Haven API") was retired by #1263. The MCP server layer does make one
 * authenticated call — a read-only `GET /x402/:payment_id/sign-context`, see
 * `sign-context.ts` — and it reads the `api_url` / `api_key` for it from a
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
  /**
   * The Haven account (smart account) the agent spends from — #2908, the
   * account-vocabulary name. Same value as `safeAddress`.
   */
  accountAddress?: string
  /**
   * @deprecated #2908 — same value as {@link SignerCredentials.accountAddress}.
   * Removed from this shape in the release after the one carrying #2908
   * (#2914). The credential-FILE keys it was read from are a different
   * matter — see `readAccountAddressField`.
   */
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
  /** #2908: what `@haven_ai/connect` writes from this release on. */
  account_address?: unknown
  /** Pre-#2908 spelling — read PERMANENTLY, see `readAccountAddressField`. */
  safe_address?: unknown
  /** Pre-#2908 spelling — read PERMANENTLY, see `readAccountAddressField`. */
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
      safeAddress: accountAddress,
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
    safeAddress: accountAddress,
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
 * The account address off a credential FILE: `account_address` (what
 * `@haven_ai/connect` writes from #2908 on) first, then the two pre-#2908
 * spellings.
 *
 * The two old fallbacks are PERMANENT, not part of the one-release naming
 * window (#2906, decision 2a): a credential file on disk was written once and
 * never rewrites itself, so a signer that stopped reading `safe_address`
 * would silently lose the address for every agent connected before this
 * release — the consent hash would change and the spend-context prompt would
 * say "not provided". Two lines, kept for as long as the file format exists.
 *
 * Exported for the mutation tests: dropping `account_address` fails the
 * new-shape test, dropping either old key fails the old-shape test.
 */
export function readAccountAddressField(raw: Pick<RawCredentialFile, 'account_address' | 'safe_address' | 'safeAddress'>): string | undefined {
  return stringField(raw.account_address ?? raw.safe_address ?? raw.safeAddress)
}

/**
 * The account address off the process environment, new name first:
 * `HAVEN_ACCOUNT_ADDRESS` (the survivor, decided on #2906) then the two
 * names the dashboard handoff emitted before #2908 — `HAVEN_WALLET_ADDRESS`
 * and `HAVEN_SAFE_ADDRESS`. Unlike the file fallbacks these two ARE
 * window-scoped: they are dropped at #2914, one release after this one.
 */
export function readAccountAddressEnv(env: NodeJS.ProcessEnv): string | undefined {
  return stringField(env.HAVEN_ACCOUNT_ADDRESS ?? env.HAVEN_WALLET_ADDRESS ?? env.HAVEN_SAFE_ADDRESS)
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
