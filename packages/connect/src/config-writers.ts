import { mkdir, readFile, writeFile, chmod, unlink } from 'node:fs/promises'
import { homedir, platform } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { isMap, parseDocument, stringify } from 'yaml'
import { signerPackageSpec } from './runtime-manifest.js'
import { type RuntimeId } from './runtime-registry.js'

export type RuntimeMcpMode = 'local_stdio' | 'hosted_plus_signer' | 'manual'

const HERMES_API_KEY_ENV = 'MCP_HAVEN_API_KEY'

/** How to launch the local edge signer as an MCP stdio server. */
export interface SignerLaunchSpec {
  command: string
  args: string[]
}

export interface RuntimeConfigInput {
  runtime: RuntimeId
  hostedMcpUrl: string
  apiKey: string
  identityPath: string
  signerPath: string
  credentialDirectory: string
  localMcpCommand?: string
  /**
   * Prepared signer launch command (absolute wrapper from prepareSignerRuntime).
   * When absent, falls back to a runtime `npx -y @haven_ai/signer@…` invocation,
   * which is fragile under the agent runtime's MCP-spawn environment — prefer
   * always passing a prepared command.
   */
  signerCommand?: SignerLaunchSpec
  homeDir?: string
  /**
   * Topology to write. 'hosted' (default) configures the keyless hosted MCP
   * server plus the local signer; 'local' restores the local-stdio MCP for
   * runtimes that support it (explicit opt-in only).
   */
  mode?: 'hosted' | 'local'
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

/** Injectable file operations for failure-safe runtime-config tests. */
export interface RuntimeConfigWriteDeps {
  writeOwnerOnlyText?: (path: string, value: string) => Promise<void>
}

class HermesConfigRecoveryError extends Error {
  constructor() {
    super('Hermes configuration recovery did not complete')
    this.name = 'HermesConfigRecoveryError'
  }
}

export class InvalidCodexTomlError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidCodexTomlError'
  }
}

export async function writeRuntimeConfig(
  input: RuntimeConfigInput,
  deps: RuntimeConfigWriteDeps = {},
): Promise<RuntimeConfigWriteResult> {
  switch (input.runtime) {
    case 'codex-cli':
    case 'codex-desktop':
      return writeCodexConfig(input)
    case 'cursor':
      return writeJsonRuntimeConfig(input, cursorConfigPath(input.homeDir), 'mcpServers')
    case 'vscode':
      return writeJsonRuntimeConfig(input, vscodeConfigPath(input.homeDir), 'servers')
    case 'vscode-insiders':
      return writeJsonRuntimeConfig(input, vscodeInsidersConfigPath(input.homeDir), 'servers')
    case 'claude-desktop':
      return writeJsonRuntimeConfig(input, claudeDesktopConfigPath(input.homeDir), 'mcpServers')
    case 'hermes':
      return writeHermesConfig(input, deps)
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
  if (runtime === 'vscode' || runtime === 'vscode-insiders') {
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

/**
 * Resolve how to launch the signer: the prepared absolute-path wrapper when
 * available, otherwise a runtime npx invocation (fallback only).
 */
export function resolveSignerLaunchSpec(input: RuntimeConfigInput): SignerLaunchSpec {
  return (
    input.signerCommand ?? {
      command: 'npx',
      args: ['-y', signerPackageSpec(), '--credentials', input.signerPath],
    }
  )
}

export function buildSignerServer(spec: SignerLaunchSpec, runtime: RuntimeId): Record<string, unknown> {
  const server = {
    command: spec.command,
    args: spec.args,
  }
  if (runtime === 'vscode' || runtime === 'vscode-insiders') return { type: 'stdio', ...server }
  return server
}

export function buildLocalMcpServer(command: string, runtime: RuntimeId): Record<string, unknown> {
  const server = {
    command,
    args: [],
  }
  if (runtime === 'vscode' || runtime === 'vscode-insiders') return { type: 'stdio', ...server }
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

/** Merge Haven's managed MCP entries into Hermes's YAML configuration. */
export function mergeHermesYaml(
  existingYaml: string | null,
  hostedServer: Record<string, unknown>,
  signerServer: Record<string, unknown>,
): string {
  if (!existingYaml?.trim()) return renderHermesYaml({ haven: hostedServer, 'haven-signer': signerServer })

  const doc = parseDocument(existingYaml, { keepSourceTokens: true })
  if (doc.errors.length > 0 || !isMap(doc.contents)) {
    throw new Error('Hermes config must be a YAML object')
  }

  const mcpPair = doc.contents.items.find((item) => item.key?.toString() === 'mcp_servers')
  const existingServers = mcpPair && isMap(mcpPair.value) ? mcpPair.value.toJSON() : {}
  const servers = isRecord(existingServers) ? existingServers : {}
  const mergedServers = {
    ...servers,
    haven: hostedServer,
    'haven-signer': signerServer,
  }

  if (!mcpPair) {
    return appendHermesMcpServers(existingYaml, mergedServers)
  }
  if (!mcpPair.value?.range) return replaceEmptyHermesMcpServers(existingYaml, mcpPair.key?.range, mergedServers)
  return replaceHermesMcpServers(existingYaml, mcpPair.key?.range, mcpPair.value.range, mergedServers)
}

/**
 * Upsert the hosted MCP identity in Hermes's dotenv file without evaluating
 * arbitrary dotenv syntax or rewriting unrelated lines.
 */
export function mergeHermesEnv(existingEnv: string | null, apiKey: string): string {
  if (/[\r\n]/.test(apiKey)) throw new Error('Hermes API key must be a single line')

  const assignment = `${HERMES_API_KEY_ENV}=${apiKey}`
  if (!existingEnv) return `${assignment}\n`

  const lineEnding = existingEnv.includes('\r\n') ? '\r\n' : '\n'
  const hasTrailingNewline = /\r?\n$/.test(existingEnv)
  const lines = existingEnv.split(/\r?\n/)
  if (hasTrailingNewline) lines.pop()

  let found = false
  const merged = lines.flatMap((line) => {
    if (isHermesEnvAssignment(line)) {
      if (found) return []
      found = true
      return [assignment]
    }
    if (isAmbiguousHermesEnvLine(line)) {
      throw new Error('Hermes environment contains an ambiguous managed key')
    }
    return [line]
  })

  if (!found) {
    return `${existingEnv}${hasTrailingNewline ? '' : lineEnding}${assignment}${lineEnding}`
  }
  return `${merged.join(lineEnding)}${hasTrailingNewline ? lineEnding : ''}`
}

function isHermesEnvAssignment(line: string): boolean {
  return /^\s*(?:export[ \t]+)?MCP_HAVEN_API_KEY[ \t]*=/.test(line)
}

function isAmbiguousHermesEnvLine(line: string): boolean {
  return /^\s*(?:export[ \t]+)?MCP_HAVEN_API_KEY\b/.test(line)
}

function appendHermesMcpServers(source: string, servers: Record<string, unknown>): string {
  const documentEnd = /(?:^|\n)[ \t]*\.\.\.[ \t]*(?:#[^\n]*)?\r?\n?$/.exec(source)
  if (documentEnd) {
    const markerStart = documentEnd.index + (documentEnd[0].startsWith('\n') ? 1 : 0)
    const beforeMarker = source.slice(0, markerStart)
    return `${beforeMarker}${beforeMarker.endsWith('\n') ? '' : '\n'}${renderHermesMcpServers(servers, '')}\n${source.slice(markerStart)}`
  }
  const separator = source.endsWith('\n') ? '' : '\n'
  return `${source}${separator}${renderHermesMcpServers(servers, '')}\n`
}

function replaceHermesMcpServers(
  source: string,
  keyRange: readonly number[] | undefined,
  valueRange: readonly number[],
  servers: Record<string, unknown>,
): string {
  const valueStart = valueRange[0]
  const valueEnd = valueRange[1]
  const valueLineStart = source.lastIndexOf('\n', valueStart - 1) + 1
  const keyStartsOnValueLine = keyRange?.[0] !== undefined && keyRange[0] >= valueLineStart
  const nestedIndent = `${source.slice(valueLineStart, keyRange?.[0] ?? valueLineStart)}  `

  if (keyStartsOnValueLine) {
    const keyStart = keyRange![0]
    const keyEnd = keyRange![1]
    const replacement = `${source.slice(keyStart, keyEnd)}:\n${renderHermesMcpServerEntries(servers, nestedIndent)}`
    const needsTrailingNewline = valueEnd < source.length && !source.slice(valueEnd).startsWith('\n')
    return `${source.slice(0, keyStart)}${replacement}${needsTrailingNewline ? '\n' : ''}${source.slice(valueEnd)}`
  }

  const indent = source.slice(valueLineStart, valueStart)
  const rendered = stringify(servers, { lineWidth: 120 }).trimEnd()
  const replacement = rendered.split('\n').map((line, index) => index === 0 ? line : `${indent}${line}`).join('\n')
  const needsTrailingNewline = valueEnd < source.length && !source.slice(valueEnd).startsWith('\n')
  return `${source.slice(0, valueStart)}${replacement}${needsTrailingNewline ? '\n' : ''}${source.slice(valueEnd)}`
}

function replaceEmptyHermesMcpServers(
  source: string,
  keyRange: readonly number[] | undefined,
  servers: Record<string, unknown>,
): string {
  if (!keyRange) throw new Error('Hermes config mcp_servers key is invalid')
  const keyStart = keyRange[0]
  const keyEnd = keyRange[1]
  const lineStart = source.lastIndexOf('\n', keyStart - 1) + 1
  const lineEnd = source.indexOf('\n', keyEnd)
  const nestedIndent = `${source.slice(lineStart, keyStart)}  `
  const replacement = `${source.slice(keyStart, keyEnd)}:\n${renderHermesMcpServerEntries(servers, nestedIndent)}`
  return `${source.slice(0, keyStart)}${replacement}${lineEnd === -1 ? '\n' : source.slice(lineEnd)}`
}

function renderHermesYaml(servers: Record<string, unknown>): string {
  return `${renderHermesMcpServers(servers, '')}\n`
}

function renderHermesMcpServers(servers: Record<string, unknown>, indent: string): string {
  return `mcp_servers:\n${renderHermesMcpServerEntries(servers, `${indent}  `)}`
}

function renderHermesMcpServerEntries(servers: Record<string, unknown>, indent: string): string {
  return stringify(servers, { lineWidth: 120 })
    .trimEnd()
    .split('\n')
    .map((line) => `${indent}${line}`)
    .join('\n')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
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

export function mergeCodexTomlHosted(
  existingToml: string,
  hostedMcpUrl: string,
  apiKey: string,
  signerSpec: SignerLaunchSpec,
): string {
  let next = removeTomlTableTree(removeTomlTableTree(existingToml, 'mcp_servers.haven'), 'mcp_servers.haven_signer')
  next = next.trimEnd()
  const block = [
    '[mcp_servers.haven]',
    `url = ${tomlString(hostedMcpUrl)}`,
    `http_headers = { "Authorization" = ${tomlString(`Bearer ${apiKey}`)} }`,
    '',
    '[mcp_servers.haven_signer]',
    `command = ${tomlString(signerSpec.command)}`,
    `args = [${signerSpec.args.map((arg) => tomlString(arg)).join(', ')}]`,
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
      buildSignerServer(resolveSignerLaunchSpec(input), input.runtime),
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

async function writeHermesConfig(input: RuntimeConfigInput, deps: RuntimeConfigWriteDeps): Promise<RuntimeConfigWriteResult> {
  const target = hermesConfigPath(input.homeDir)
  const envTarget = hermesEnvPath(input.homeDir)
  try {
    const [existing, existingEnv] = await Promise.all([readOptional(target), readOptional(envTarget)])
    const hostedServer = {
      ...buildHostedServer(input.hostedMcpUrl, `\${${HERMES_API_KEY_ENV}}`, input.runtime),
      enabled: true,
    }
    const signerServer = {
      ...buildSignerServer(resolveSignerLaunchSpec(input), input.runtime),
      enabled: true,
    }
    const merged = mergeHermesYaml(
      existing,
      hostedServer,
      signerServer,
    )
    const mergedEnv = mergeHermesEnv(existingEnv, input.apiKey)
    const writeText = deps.writeOwnerOnlyText ?? writeOwnerOnlyText
    await writeText(envTarget, mergedEnv)
    try {
      await writeText(target, merged)
    } catch (err) {
      const recovered = await restoreHermesFiles(target, existing, envTarget, existingEnv, writeText)
      if (!recovered) throw new HermesConfigRecoveryError()
      throw err
    }
    return {
      hostedConfigured: true,
      signerConfigured: true,
      localMcpConfigured: false,
      runtimeMcpMode: 'hosted_plus_signer',
      target: 'Hermes Agent config',
      changed: existing !== merged || existingEnv !== mergedEnv,
      restartRequired: true,
      messages: [
        `Updated Haven MCP entries in ${target}; stored the hosted MCP identity in ${envTarget}.`,
        'Restart Hermes (start a new session; gateway users: /restart), then verify with `hermes mcp list`, `hermes mcp test haven`, and `hermes mcp test haven-signer`.',
        'If no mcp_* tools appear after restart, ensure the MCP SDK is installed in Hermes: pip install mcp',
      ],
    }
  } catch (err) {
    const recoveryIncomplete = err instanceof HermesConfigRecoveryError
    return {
      hostedConfigured: false,
      signerConfigured: false,
      localMcpConfigured: false,
      runtimeMcpMode: 'hosted_plus_signer',
      target: 'Hermes Agent config',
      changed: false,
      restartRequired: true,
      messages: [recoveryIncomplete
        ? 'Could not update Hermes Agent config. Recovery did not complete; inspect the Hermes configuration before retrying.'
        : 'Could not update Hermes Agent config. Existing configuration was left unchanged.'],
      errorCode: 'runtime_config_write_failed',
    }
  }
}

async function restoreHermesFiles(
  configPath: string,
  existingConfig: string | null,
  envPath: string,
  existingEnv: string | null,
  writeText: (path: string, value: string) => Promise<void>,
): Promise<boolean> {
  const [envResult, configResult] = await Promise.allSettled([
    restoreOptionalText(envPath, existingEnv, writeText),
    restoreOptionalText(configPath, existingConfig, writeText),
  ])
  return envResult.status === 'fulfilled' && configResult.status === 'fulfilled'
}

async function restoreOptionalText(
  path: string,
  existing: string | null,
  writeText: (path: string, value: string) => Promise<void>,
): Promise<void> {
  if (existing !== null) {
    await writeText(path, existing)
    return
  }
  try {
    await unlink(path)
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') return
    throw err
  }
}

async function writeCodexConfig(input: RuntimeConfigInput): Promise<RuntimeConfigWriteResult> {
  const target = codexConfigPath(input.homeDir)
  const local = input.mode === 'local'
  try {
    const existing = await readOptional(target)
    if (local) {
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
        ],
      }
    }
    const merged = mergeCodexTomlHosted(existing ?? '', input.hostedMcpUrl, input.apiKey, resolveSignerLaunchSpec(input))
    await writeOwnerOnlyText(target, merged)
    return {
      hostedConfigured: true,
      signerConfigured: true,
      localMcpConfigured: false,
      runtimeMcpMode: 'hosted_plus_signer',
      target: configTargetLabel(input.runtime),
      changed: existing !== merged,
      restartRequired: true,
      messages: [
        `Updated Haven MCP entries in ${configTargetLabel(input.runtime)}.`,
      ],
    }
  } catch (err) {
    const invalidToml = err instanceof InvalidCodexTomlError
    return {
      hostedConfigured: false,
      signerConfigured: false,
      localMcpConfigured: false,
      runtimeMcpMode: local ? 'local_stdio' : 'hosted_plus_signer',
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

function vscodeInsidersConfigPath(homeDir = homedir()): string {
  if (platform() === 'darwin') return resolve(homeDir, 'Library', 'Application Support', 'Code - Insiders', 'User', 'mcp.json')
  if (platform() === 'win32') {
    return resolve(process.env.APPDATA ?? join(homeDir, 'AppData', 'Roaming'), 'Code - Insiders', 'User', 'mcp.json')
  }
  return resolve(homeDir, '.config', 'Code - Insiders', 'User', 'mcp.json')
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

export function hermesConfigPath(homeDir?: string): string {
  return join(hermesHomePath(homeDir), 'config.yaml')
}

export function hermesEnvPath(homeDir?: string): string {
  return join(hermesHomePath(homeDir), '.env')
}

function hermesHomePath(homeDir?: string): string {
  return process.env.HERMES_HOME ?? join(homeDir ?? homedir(), '.hermes')
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
    case 'vscode-insiders':
      return 'VS Code Insiders MCP config'
    case 'claude-desktop':
      return 'Claude Desktop config'
    default:
      return 'runtime MCP config'
  }
}
