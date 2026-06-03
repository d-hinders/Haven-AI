import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises'
import { homedir, platform } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { RuntimeId } from './runtime-registry.js'

export interface RuntimeConfigInput {
  runtime: RuntimeId
  hostedMcpUrl: string
  apiKey: string
  signerPath: string
  credentialDirectory: string
  homeDir?: string
}

export interface RuntimeConfigWriteResult {
  hostedConfigured: boolean
  signerConfigured: boolean
  target: string
  changed: boolean
  restartRequired: boolean
  messages: string[]
  errorCode?: string
}

export async function writeRuntimeConfig(input: RuntimeConfigInput): Promise<RuntimeConfigWriteResult> {
  switch (input.runtime) {
    case 'codex-cli':
      return writeCodexConfig(input)
    case 'cursor':
      return writeJsonRuntimeConfig(input, cursorConfigPath(input.homeDir), 'mcpServers')
    case 'vscode':
      return writeJsonRuntimeConfig(input, vscodeConfigPath(input.homeDir), 'servers')
    case 'claude-desktop':
      return writeJsonRuntimeConfig(input, claudeDesktopConfigPath(input.homeDir), 'mcpServers')
    default:
      return {
        hostedConfigured: false,
        signerConfigured: false,
        target: 'manual runtime setup',
        changed: false,
        restartRequired: true,
        messages: ['Runtime config needs to be added manually for this agent environment.'],
        errorCode: 'manual_runtime_setup_required',
      }
  }
}

export function buildHostedServer(hostedMcpUrl: string, apiKey: string, runtime: RuntimeId): Record<string, unknown> {
  if (runtime === 'vscode') {
    return {
      type: 'http',
      url: hostedMcpUrl,
      headers: { Authorization: `Bearer ${apiKey}` },
    }
  }
  return {
    url: hostedMcpUrl,
    headers: { Authorization: `Bearer ${apiKey}` },
  }
}

export function buildSignerServer(signerPath: string, runtime: RuntimeId): Record<string, unknown> {
  const server = {
    command: 'npx',
    args: ['-y', '@haven_ai/signer', '--credentials', signerPath],
  }
  if (runtime === 'vscode') return { type: 'stdio', ...server }
  return server
}

export function mergeJsonMcpConfig(
  existingJson: string | null,
  serverRoot: 'mcpServers' | 'servers',
  hostedServer: Record<string, unknown>,
  signerServer: Record<string, unknown>,
): string {
  const config = existingJson?.trim() ? parseJsonObject(existingJson) : {}
  const existingRoot = config[serverRoot]
  const servers = existingRoot && typeof existingRoot === 'object' && !Array.isArray(existingRoot)
    ? existingRoot as Record<string, unknown>
    : {}
  config[serverRoot] = {
    ...servers,
    haven: hostedServer,
    'haven-signer': signerServer,
  }
  return `${JSON.stringify(config, null, 2)}\n`
}

export function mergeCodexToml(existingToml: string, hostedMcpUrl: string, signerPath: string): string {
  let next = removeTomlTable(removeTomlTable(existingToml, 'mcp_servers.haven'), 'mcp_servers.haven_signer')
  next = next.trimEnd()
  const block = [
    '[mcp_servers.haven]',
    `url = ${tomlString(hostedMcpUrl)}`,
    'bearer_token_env_var = "HAVEN_TOKEN"',
    '',
    '[mcp_servers.haven_signer]',
    'command = "npx"',
    `args = ["-y", "@haven_ai/signer", "--credentials", ${tomlString(signerPath)}]`,
  ].join('\n')
  return `${next ? `${next}\n\n` : ''}${block}\n`
}

async function writeJsonRuntimeConfig(
  input: RuntimeConfigInput,
  target: string,
  serverRoot: 'mcpServers' | 'servers',
): Promise<RuntimeConfigWriteResult> {
  try {
    const existing = await readOptional(target)
    const merged = mergeJsonMcpConfig(
      existing,
      serverRoot,
      buildHostedServer(input.hostedMcpUrl, input.apiKey, input.runtime),
      buildSignerServer(input.signerPath, input.runtime),
    )
    await writeOwnerOnlyText(target, merged)
    return {
      hostedConfigured: true,
      signerConfigured: true,
      target: configTargetLabel(input.runtime),
      changed: existing !== merged,
      restartRequired: input.runtime === 'claude-desktop',
      messages: [`Updated Haven MCP entries in ${configTargetLabel(input.runtime)}.`],
    }
  } catch (err) {
    return {
      hostedConfigured: false,
      signerConfigured: false,
      target: configTargetLabel(input.runtime),
      changed: false,
      restartRequired: true,
      messages: [`Could not update ${configTargetLabel(input.runtime)}: ${err instanceof Error ? err.message : String(err)}`],
      errorCode: 'runtime_config_write_failed',
    }
  }
}

async function writeCodexConfig(input: RuntimeConfigInput): Promise<RuntimeConfigWriteResult> {
  const target = codexConfigPath(input.homeDir)
  const envTarget = join(input.credentialDirectory, 'identity.env')
  try {
    const existing = await readOptional(target)
    const merged = mergeCodexToml(existing ?? '', input.hostedMcpUrl, input.signerPath)
    await writeOwnerOnlyText(target, merged)
    await writeOwnerOnlyText(envTarget, `HAVEN_TOKEN=${shellToken(input.apiKey)}\n`)
    return {
      hostedConfigured: false,
      signerConfigured: true,
      target: 'Codex CLI config',
      changed: existing !== merged,
      restartRequired: true,
      messages: [
        'Updated Haven MCP entries in Codex CLI config.',
        'Wrote the hosted MCP token to a private env file. Launch Codex with that env file before using Haven tools.',
      ],
      errorCode: 'codex_env_activation_required',
    }
  } catch (err) {
    return {
      hostedConfigured: false,
      signerConfigured: false,
      target: 'Codex CLI config',
      changed: false,
      restartRequired: true,
      messages: [`Could not update Codex CLI config: ${err instanceof Error ? err.message : String(err)}`],
      errorCode: 'runtime_config_write_failed',
    }
  }
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') return null
    throw err
  }
}

async function writeOwnerOnlyText(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(path, value, { mode: 0o600 })
  await chmod(path, 0o600).catch(() => undefined)
}

function parseJsonObject(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('runtime config must be a JSON object')
  }
  return parsed as Record<string, unknown>
}

function removeTomlTable(toml: string, table: string): string {
  const lines = toml.split(/\r?\n/)
  const start = `[${table}]`
  const kept: string[] = []
  let skipping = false
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === start) {
      skipping = true
      continue
    }
    if (skipping && trimmed.startsWith('[') && trimmed.endsWith(']')) {
      skipping = false
    }
    if (!skipping) kept.push(line)
  }
  return kept.join('\n')
}

function tomlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function shellToken(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function cursorConfigPath(homeDir = homedir()): string {
  return resolve(homeDir, '.cursor', 'mcp.json')
}

function codexConfigPath(homeDir = homedir()): string {
  return resolve(homeDir, '.codex', 'config.toml')
}

function vscodeConfigPath(homeDir = homedir()): string {
  if (platform() === 'darwin') return resolve(homeDir, 'Library', 'Application Support', 'Code', 'User', 'mcp.json')
  if (platform() === 'win32') {
    return resolve(process.env.APPDATA ?? join(homeDir, 'AppData', 'Roaming'), 'Code', 'User', 'mcp.json')
  }
  return resolve(homeDir, '.config', 'Code', 'User', 'mcp.json')
}

function claudeDesktopConfigPath(homeDir = homedir()): string {
  if (platform() === 'darwin') {
    return resolve(homeDir, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
  }
  if (platform() === 'win32') {
    return resolve(process.env.APPDATA ?? join(homeDir, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json')
  }
  return resolve(homeDir, '.config', 'Claude', 'claude_desktop_config.json')
}

function configTargetLabel(runtime: RuntimeId): string {
  switch (runtime) {
    case 'cursor':
      return 'Cursor MCP config'
    case 'vscode':
      return 'VS Code MCP config'
    case 'claude-desktop':
      return 'Claude Desktop config'
    default:
      return 'runtime MCP config'
  }
}
