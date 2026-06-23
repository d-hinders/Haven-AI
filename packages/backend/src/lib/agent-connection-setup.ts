import crypto from 'crypto'
import { verifyMessage } from 'ethers'

export const SETUP_TOKEN_PREFIX = 'hv_setup_'
export const SETUP_TOKEN_BYTES = 24
export const SETUP_TOKEN_TTL_MINUTES = 30

export const CONNECT_AGENT_2_STATUSES = [
  'awaiting_connection',
  'connected_local',
  'awaiting_wallet_approval',
  'approval_in_progress',
  'proposed',
  'active',
  'expired',
  'cancelled',
  'failed',
] as const

const FORBIDDEN_PRIVATE_KEY_FIELDS = new Set([
  'delegate_key',
  'delegatekey',
  'delegateprivatekey',
  'private_key',
  'privatekey',
])

const FORBIDDEN_INSTALL_STATUS_FIELDS = new Set([
  ...FORBIDDEN_PRIVATE_KEY_FIELDS,
  'api_key',
  'apikey',
  'credentials',
  'credential_json',
  'credentialjson',
  'hostname',
  'host_name',
  'username',
  'user_name',
  'path',
  'raw_path',
  'transcript',
  'chat_transcript',
])

export interface SetupChallengeInput {
  setupId: string
  challengeId: string
  nonce: string
  expiresAt: string
}

export function generateSetupToken(): string {
  return `${SETUP_TOKEN_PREFIX}${crypto.randomBytes(SETUP_TOKEN_BYTES).toString('hex')}`
}

export function hashSetupSecret(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex')
}

export function apiKeyHash(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex')
}

export function generateAgentApiKey(): string {
  return `sk_agent_${crypto.randomBytes(24).toString('hex')}`
}

export function buildSetupChallengeMessage(input: SetupChallengeInput): string {
  return [
    'Haven Connect Agent 2',
    `setup_id: ${input.setupId}`,
    `challenge_id: ${input.challengeId}`,
    `challenge: ${input.nonce}`,
    `expires_at: ${input.expiresAt}`,
  ].join('\n')
}

export function verifySetupProof(
  message: string,
  signature: string,
  expectedAddress: string,
): boolean {
  try {
    const recovered = verifyMessage(message, signature)
    return recovered.toLowerCase() === expectedAddress.toLowerCase()
  } catch {
    return false
  }
}

export function containsForbiddenPrivateKeyField(value: unknown): boolean {
  return containsForbiddenField(value, FORBIDDEN_PRIVATE_KEY_FIELDS)
}

export function containsForbiddenInstallStatusField(value: unknown): boolean {
  return containsForbiddenField(value, FORBIDDEN_INSTALL_STATUS_FIELDS)
}

export function sanitizeConnectorContext(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const raw = value as Record<string, unknown>
  const context: Record<string, string> = {}
  for (const key of ['environment_label', 'runtime_version', 'config_target']) {
    const field = raw[key]
    if (typeof field !== 'string') continue
    const trimmed = field.trim()
    if (!trimmed) continue
    if (looksLikeRawPathOrSecret(trimmed)) continue
    context[key] = trimmed.slice(0, 120)
  }
  return context
}

export function sanitizeInstallStatus(value: unknown): Record<string, unknown> {
  const raw = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
  const status: Record<string, unknown> = {}
  if ('error_code' in raw && raw.error_code === null) {
    status.error_code = null
  }
  for (const key of [
    'runtime',
    'runtime_mcp_mode',
    'connector_version',
    'probe_result',
    'next_user_action',
    'error_code',
    'environment_label',
  ]) {
    const field = raw[key]
    if (typeof field !== 'string') continue
    const trimmed = field.trim()
    if (!trimmed) continue
    if (looksLikeRawPathOrSecret(trimmed)) continue
    status[key] = trimmed.slice(0, 120)
  }
  for (const key of [
    'hosted_mcp_configured',
    'local_signer_configured',
    'local_mcp_configured',
    'credential_files_written',
    'signer_acknowledged',
    'local_mcp_acknowledged',
    'activation_command_available',
    'skill_installed',
    'restart_required',
  ]) {
    if (typeof raw[key] === 'boolean') status[key] = raw[key]
  }
  status.last_probe_at = new Date().toISOString()
  return status
}

export { isAddress as isValidAddress } from './address.js'

export function isValidHexHash(value: unknown): value is string {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value)
}

function containsForbiddenField(value: unknown, forbidden: ReadonlySet<string>): boolean {
  if (!value || typeof value !== 'object') return false
  if (Array.isArray(value)) return value.some((item) => containsForbiddenField(item, forbidden))
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (forbidden.has(key.replace(/[-_\s]/g, '').toLowerCase()) || forbidden.has(key.toLowerCase())) {
      return true
    }
    if (containsForbiddenField(child, forbidden)) return true
  }
  return false
}

function looksLikeRawPathOrSecret(value: string): boolean {
  if (/sk_agent_[0-9a-f]/i.test(value)) return true
  if (/0x[0-9a-fA-F]{64}/.test(value)) return true
  if (value.includes('/') || value.includes('\\')) return true
  return false
}
