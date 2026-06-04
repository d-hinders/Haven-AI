import { access, chmod, mkdir, rm, writeFile } from 'node:fs/promises'
import crypto from 'node:crypto'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export interface StoredCredentialPaths {
  directory: string
  identityPath: string
  signerPath: string
}

export interface WriteCredentialInput {
  baseDir?: string
  agentId: string
  apiKey: string
  delegateKey: string
  delegateAddress: string
  safeAddress?: string
  chainId?: number
  network?: string
  agentBudget?: Array<{
    token_symbol: string
    allowance_amount: string
    reset_period_min: number
  }>
  apiUrl: string
  hostedMcpUrl: string
  warn?: (message: string) => void
}

export interface PreflightCredentialStorageInput {
  baseDir?: string
  warn?: (message: string) => void
}

export async function preflightCredentialStorage(
  input: PreflightCredentialStorageInput = {},
): Promise<string> {
  const directory = defaultCredentialRoot(input.baseDir)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await restrictPermissions(directory, 0o700, input.warn)

  const probePath = join(directory, `.haven-connect-preflight-${crypto.randomBytes(8).toString('hex')}`)
  try {
    await writeOwnerOnlyJson(probePath, { ok: true }, input.warn)
  } finally {
    await rm(probePath, { force: true }).catch(() => undefined)
  }

  return directory
}

export async function writeCredentialFiles(input: WriteCredentialInput): Promise<StoredCredentialPaths> {
  const directory = defaultAgentDirectory(input.agentId, input.baseDir)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await restrictPermissions(directory, 0o700, input.warn)

  const identityPath = join(directory, 'identity.json')
  const signerPath = join(directory, 'signer.json')

  await assertDoesNotExist(identityPath)
  await assertDoesNotExist(signerPath)

  await writeOwnerOnlyJson(
    signerPath,
      {
        delegate_key: input.delegateKey,
        delegate_address: input.delegateAddress,
        agent_id: input.agentId,
        safe_address: input.safeAddress,
        chain_id: input.chainId,
      network: input.network,
      note: 'Local signer credential. Haven backend never receives this private key.',
    },
    input.warn,
  )

  try {
    await writeOwnerOnlyJson(
      identityPath,
      {
        api_key: input.apiKey,
        agent_id: input.agentId,
        safe_address: input.safeAddress,
        chain_id: input.chainId,
        network: input.network,
        api_url: input.apiUrl,
        hosted_mcp_url: input.hostedMcpUrl,
        agent_budget: input.agentBudget,
        note: 'Haven API key identifies the agent only. It cannot spend without the local signer key and on-chain Haven wallet rules.',
      },
      input.warn,
    )
  } catch (err) {
    await rm(signerPath, { force: true }).catch(() => undefined)
    throw err
  }

  return { directory, identityPath, signerPath }
}

export function defaultAgentDirectory(agentId: string, baseDir = join(homedir(), '.haven', 'agents')): string {
  return resolve(defaultCredentialRoot(baseDir), safePathPart(agentId))
}

export function defaultCredentialRoot(baseDir = join(homedir(), '.haven', 'agents')): string {
  return resolve(baseDir)
}

async function writeOwnerOnlyJson(
  path: string,
  value: Record<string, unknown>,
  warn: ((message: string) => void) | undefined,
): Promise<void> {
  const json = JSON.stringify(dropUndefined(value), null, 2)
  await writeFile(path, `${json}\n`, { mode: 0o600, flag: 'wx' })
  await restrictPermissions(path, 0o600, warn)
}

function safePathPart(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, '_')
}

function dropUndefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined))
}

async function assertDoesNotExist(path: string): Promise<void> {
  try {
    await access(path)
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') return
    throw err
  }
  throw new Error(`Refusing to overwrite existing Haven credential file: ${path}`)
}

async function restrictPermissions(
  path: string,
  mode: 0o600 | 0o700,
  warn: ((message: string) => void) | undefined,
): Promise<void> {
  try {
    await chmod(path, mode)
  } catch (err) {
    warn?.(
      `Warning: could not restrict permissions on ${path} to ${mode.toString(8)}. ` +
        `Move this credential to a private location or run chmod ${mode.toString(8)} ${path}. ` +
        `${err instanceof Error ? err.message : String(err)}`,
    )
  }
}
