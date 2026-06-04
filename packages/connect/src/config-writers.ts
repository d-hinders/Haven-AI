import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises'
import { homedir, platform } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { signerPackageSpec } from './runtime-manifest.js'
import type { RuntimeId } from './runtime-registry.js'

export type RuntimeMcpMode = 'local_stdio' | 'hosted_plus_signer' | 'manual'

export interface RuntimeConfigInput {
  runtime: RuntimeId
  hostedMcpUrl: string
  apiKey: string
  identityPath: string
  signerPath: string
  credentialDirectory: string
  localMcpCommand?: string
  homeDir?: string
}

export interface RuntimeConfigWriteResult {
  hostedConfigured: boolean
  signerConfigured: boolean
  localMcpConfigured: boolean
  runtimeMcpMode: RuntimeMcpMode
  target: string
  changed: boolean
  restartRequired: boolean
  messages: string[]
  errorCode?: string
  activationCommand?: string
}

export class InvalidCodexTomlError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidCodexTomlError'
  }
}

export async function writeRuntimeConfig(input: RuntimeConfigInput): Promise<RuntimeConfigWriteResult> {
  switch (input.runtime) {
    case 'codex-cli':
    case 'codex-desktop':
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
        localMcpConfigured: false,
        runtimeMcpMode: 'manual',
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
    args: ['-y', signerPackageName(), '--credentials', signerPath],
  }
  if (runtime === 'vscode') return { type: 'stdio', ...server }
  return server
}

export function buildLocalMcpServer(command: string, runtime: RuntimeId): Record<string, unknown> {
  const server = {
    command,
    args: [],
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

export function mergeCodexToml(existingToml: string, localMcpCommand: string): string {
  let next = removeTomlTableTree(removeTomlTableTree(existingToml, 'mcp_servers.haven'), 'mcp_servers.haven_signer')
  next = next.trimEnd()
  const block = [
    '[mcp_servers.haven]',
    `command = ${tomlString(localMcpCommand)}`,
    'args = []',
    'startup_timeout_sec = 120',
  ].join('\n')
  validateCodexToml(block, 'Generated Codex Haven config')
  const merged = `${next ? `${next}\n\n` : ''}${block}\n`
  return merged
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
      localMcpConfigured: false,
      runtimeMcpMode: 'hosted_plus_signer',
      target: configTargetLabel(input.runtime),
      changed: existing !== merged,
      restartRequired: input.runtime === 'claude-desktop',
      messages: [`Updated Haven MCP entries in ${configTargetLabel(input.runtime)}.`],
    }
  } catch (err) {
    return {
      hostedConfigured: false,
      signerConfigured: false,
      localMcpConfigured: false,
      runtimeMcpMode: 'hosted_plus_signer',
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
  try {
    const existing = await readOptional(target)
    if (!input.localMcpCommand) {
      throw new Error('local MCP wrapper command is required')
    }
    const merged = mergeCodexToml(existing ?? '', input.localMcpCommand)
    await writeOwnerOnlyText(target, merged)
    return {
      hostedConfigured: false,
      signerConfigured: true,
      localMcpConfigured: true,
      runtimeMcpMode: 'local_stdio',
      target: configTargetLabel(input.runtime),
      changed: existing !== merged,
      restartRequired: true,
      messages: [
        `Updated local Haven MCP entry in ${configTargetLabel(input.runtime)}.`,
        'After Haven approval, restart Codex normally so it can load Haven tools.',
      ],
    }
  } catch (err) {
    const invalidToml = err instanceof InvalidCodexTomlError
    return {
      hostedConfigured: false,
      signerConfigured: false,
      localMcpConfigured: false,
      runtimeMcpMode: 'local_stdio',
      target: configTargetLabel(input.runtime),
      changed: false,
      restartRequired: true,
      messages: [`Could not update ${configTargetLabel(input.runtime)}: ${err instanceof Error ? err.message : String(err)}`],
      errorCode: invalidToml ? 'codex_config_invalid' : 'runtime_config_write_failed',
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

function removeTomlTableTree(toml: string, table: string): string {
  const lines = toml.split(/\r?\n/)
  const kept: string[] = []
  let skipping = false
  for (const line of lines) {
    const trimmed = line.trim()
    const tableName = tomlTableName(trimmed)
    if (tableName) {
      skipping = tableName === table || tableName.startsWith(`${table}.`)
      if (skipping) continue
    }
    if (!skipping) kept.push(line)
  }
  return kept.join('\n')
}

function tomlTableName(line: string): string | null {
  if (line.startsWith('[[') && line.endsWith(']]')) return line.slice(2, -2).trim()
  if (line.startsWith('[') && line.endsWith(']')) return line.slice(1, -1).trim()
  return null
}

export function validateCodexToml(toml: string, label = 'Codex config'): void {
  const lines = toml.split(/\r?\n/)
  let pendingValue: { value: string; line: number } | null = null
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index]
    const line = stripTomlComment(raw).trim()
    if (!line) continue

    if (pendingValue) {
      pendingValue.value = `${pendingValue.value}\n${line}`
      if (hasBalancedTomlContainers(pendingValue.value)) {
        if (!isTomlValue(pendingValue.value)) {
          throw new InvalidCodexTomlError(`${label} has invalid TOML near line ${pendingValue.line}.`)
        }
        pendingValue = null
      }
      continue
    }

    if (isTomlTable(line)) continue

    const equalsIndex = line.indexOf('=')
    if (equalsIndex <= 0) {
      throw new InvalidCodexTomlError(`${label} has invalid TOML near line ${index + 1}.`)
    }

    const key = line.slice(0, equalsIndex).trim()
    const value = line.slice(equalsIndex + 1).trim()
    if (!isTomlKey(key)) {
      throw new InvalidCodexTomlError(`${label} has invalid TOML near line ${index + 1}.`)
    }
    if (startsTomlContainer(value) && !hasBalancedTomlContainers(value)) {
      pendingValue = { value, line: index + 1 }
      continue
    }
    if (!isTomlValue(value)) {
      throw new InvalidCodexTomlError(`${label} has invalid TOML near line ${index + 1}.`)
    }
  }
  if (pendingValue) {
    throw new InvalidCodexTomlError(`${label} has invalid TOML near line ${pendingValue.line}.`)
  }
}

function isTomlTable(line: string): boolean {
  const table = tomlTableName(line)
  return Boolean(table && splitTomlDottedKey(table).every(isTomlKeyPart))
}

function isTomlKey(value: string): boolean {
  return splitTomlDottedKey(value).every(isTomlKeyPart)
}

function splitTomlDottedKey(value: string): string[] {
  const parts: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let escaped = false
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i]
    if (quote) {
      current += char
      if (quote === '"' && char === '\\' && !escaped) {
        escaped = true
        continue
      }
      if (char === quote && !escaped) quote = null
      escaped = false
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      current += char
      continue
    }
    if (char === '.') {
      parts.push(current.trim())
      current = ''
      continue
    }
    current += char
  }
  parts.push(current.trim())
  return quote ? [] : parts
}

function isTomlKeyPart(value: string): boolean {
  return isTomlBareKey(value) || isTomlQuotedString(value)
}

function isTomlBareKey(value: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(value)
}

function isTomlValue(value: string): boolean {
  if (!value) return false
  if (isTomlQuotedString(value)) return true
  if (/^(true|false)$/i.test(value)) return true
  if (/^[+-]?(?:inf|nan)$/i.test(value)) return true
  if (/^[+-]?(?:0|[1-9][0-9_]*)(?:\.[0-9_]+)?(?:[eE][+-]?[0-9_]+)?$/.test(value)) return true
  if (/^\d{4}-\d{2}-\d{2}(?:[Tt ][0-9:.+-Zz]+)?$/.test(value)) return true
  if ((value.startsWith('[') && value.endsWith(']')) || (value.startsWith('{') && value.endsWith('}'))) {
    return hasBalancedTomlContainers(value)
  }
  return false
}

function startsTomlContainer(value: string): boolean {
  return value.startsWith('[') || value.startsWith('{')
}

function isTomlQuotedString(value: string): boolean {
  if (value.startsWith('"""') || value.startsWith("'''")) {
    const marker = value.slice(0, 3)
    return value.length >= 6 && value.endsWith(marker)
  }
  if ((!value.startsWith('"') || !value.endsWith('"')) && (!value.startsWith("'") || !value.endsWith("'"))) {
    return false
  }
  return hasBalancedTomlContainers(value)
}

function stripTomlComment(value: string): string {
  let quote: '"' | "'" | null = null
  let escaped = false
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i]
    if (quote) {
      if (quote === '"' && char === '\\' && !escaped) {
        escaped = true
        continue
      }
      if (char === quote && !escaped) quote = null
      escaped = false
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '#') return value.slice(0, i)
  }
  return value
}

function hasBalancedTomlContainers(value: string): boolean {
  const stack: string[] = []
  let quote: '"' | "'" | null = null
  let escaped = false
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i]
    if (quote) {
      if (quote === '"' && char === '\\' && !escaped) {
        escaped = true
        continue
      }
      if (char === quote && !escaped) quote = null
      escaped = false
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '[' || char === '{') {
      stack.push(char)
      continue
    }
    if (char === ']') {
      if (stack.pop() !== '[') return false
      continue
    }
    if (char === '}') {
      if (stack.pop() !== '{') return false
    }
  }
  return stack.length === 0 && quote === null
}

function tomlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
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
    case 'codex-cli':
      return 'Codex CLI config'
    case 'codex-desktop':
      return 'Codex Desktop config'
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

function signerPackageName(): string {
  return signerPackageSpec()
}
