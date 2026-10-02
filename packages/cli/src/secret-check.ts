/**
 * The secret check `haven feedback submit` runs before any request carrying
 * the text is sent (#3597, owner decision 2026-10-02).
 *
 * A raw private key and a transaction/delegation/schema hash share one shape
 * — 64 hex characters, with or without `0x` — so shape alone cannot decide.
 * The check asks what a string would DO. Every layer below runs locally
 * first; layer 3's network reads fetch this user's own addresses to compare
 * against, and never carry the submitted text itself.
 *
 * **Zero runtime dependencies stays true at the `dependencies` field.**
 * `@noble/hashes` (Keccak-256 — `node:crypto` has secp256k1 but not that) and
 * `@scure/bip39` (the English wordlist) are devDependencies, bundled by tsup
 * into `dist/*` (see `agent-guidance-text.test.ts`'s sibling guard, and the
 * CLI README's zero-deps note). This file must never import
 * `@haven_ai/connect` — that package pulls in ethers, which is exactly the
 * install-weight problem the zero-deps rule exists to avoid, and it is also
 * simply unnecessary: the credential files this reads are plain JSON.
 */
import { readFile, readdir } from 'node:fs/promises'
import { createECDH } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { keccak_256 } from '@noble/hashes/sha3'
import { wordlist as BIP39_ENGLISH } from '@scure/bip39/wordlists/english'
import { CliApiError, type CliApi } from './api.js'

/** Mirrors the backend's own cap (`routes/feedback.ts`'s `MAX_FEEDBACK_TEXT_LENGTH`). */
export const MAX_FEEDBACK_TEXT_LENGTH = 4000

export type SecretCheckReason =
  | 'agent_api_key'
  | 'setup_token'
  | 'session_jwt'
  | 'labelled_parameter'
  | 'url_credentials'
  | 'rpc_path_key'
  | 'local_credential'
  | 'private_key'
  | 'address_check_unavailable'
  | 'recovery_phrase'

export interface SecretCheckRefusal {
  layer: 1 | 2 | 3 | 4
  reason: SecretCheckReason
  /** Human-readable; never includes the refused text itself. */
  message: string
}

function refusal(layer: SecretCheckRefusal['layer'], reason: SecretCheckReason, message: string): SecretCheckRefusal {
  return { layer, reason, message }
}

// ── Layer 1 — prefixed and labelled secrets ─────────────────────────
//
// A superset of `redactVendorSecrets` (`packages/backend/src/domain/redact-vendor-secrets.ts`)
// — the backend re-runs the identical list server-side
// (`packages/backend/src/modules/feedback/secret-check.ts`), so stored text
// can never trip the ops grant script's vendor-secret refusal.
// No false positives: every pattern here is a label or a prefix, never a bare
// shape (a bare 64-hex token is layer 3).

const LABELLED_PATTERNS: ReadonlyArray<{ reason: SecretCheckReason; re: RegExp }> = [
  { reason: 'agent_api_key', re: /sk_agent_[A-Za-z0-9]/ },
  { reason: 'setup_token', re: /hv_setup_[A-Za-z0-9]/ },
  // A session JWT: three dot-separated base64url parts, each non-empty.
  // `\beyJ` (not the looser `\bey`), which is the base64url encoding of `{"`
  // — every real JWT header starts there, and the tighter anchor stops
  // ordinary words like "eyebrow" or "eyelet" from matching their own tail.
  { reason: 'session_jwt', re: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/ },
  // key= / api_key= / api-key= / apikey= / token= / secret=, `\b`-bounded —
  // the same boundary `redact-vendor-secrets.ts:19` uses.
  { reason: 'labelled_parameter', re: /\b(api[_-]?key|key|token|secret)=[^&\s"'\\)]+/i },
  { reason: 'url_credentials', re: /https?:\/\/[^\s/@]+:[^\s@]+@/i },
  { reason: 'rpc_path_key', re: /\/(?:rpc|v2)\/[A-Za-z0-9_-]{16,}/ },
]

export function checkLabelledSecrets(text: string): SecretCheckRefusal | null {
  for (const { reason, re } of LABELLED_PATTERNS) {
    if (re.test(text)) {
      return refusal(
        1,
        reason,
        'Refusing to send: the text looks like it contains a secret (a credential label or prefix matched). Remove it and try again.',
      )
    }
  }
  return null
}

// ── Layer 2 — secrets this machine holds, exact match ───────────────
//
// Read with `node:fs` only — never `@haven_ai/connect`. Case-insensitive,
// `0x`-normalised, never printed. A custom `--credentials-dir` cannot be
// discovered; that is accepted residual risk (the issue's own words).

export interface LocalSecretSources {
  /** Overrides `~/.haven/agents` — tests only. */
  baseDir?: string
  env?: NodeJS.ProcessEnv
  /** This CLI's own `~/.haven/session.json` token, passed in by the caller. */
  sessionToken?: string
}

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/^0x/, '')
}

async function readJsonStringField(path: string, field: string): Promise<string | null> {
  try {
    const raw = await readFile(path, 'utf8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const value = parsed[field]
    return typeof value === 'string' && value.length > 0 ? value : null
  } catch {
    return null
  }
}

/**
 * Every local secret source the issue names:
 * `~/.haven/agents/<slug>/signer.json` (`delegate_key`), `identity.json`
 * (`api_key`), `rekey-pending.json` (`new_delegate_key`) — including
 * TOMBSTONED directories, which keep their keys and are deliberately NOT
 * skipped here (unlike agent discovery for a `--rekey` target) — the
 * `HAVEN_DELEGATE_KEY` env var, and this CLI's own session token.
 */
export async function readLocalSecrets(sources: LocalSecretSources = {}): Promise<Set<string>> {
  const secrets = new Set<string>()
  const env = sources.env ?? process.env
  const envKey = env.HAVEN_DELEGATE_KEY
  if (envKey) secrets.add(normalize(envKey))
  if (sources.sessionToken) secrets.add(normalize(sources.sessionToken))

  const root = sources.baseDir ?? join(homedir(), '.haven', 'agents')
  let entries: string[] = []
  try {
    entries = await readdir(root)
  } catch {
    return secrets
  }

  for (const entry of entries) {
    const dir = join(root, entry)
    const delegateKey = await readJsonStringField(join(dir, 'signer.json'), 'delegate_key')
    if (delegateKey) secrets.add(normalize(delegateKey))
    const apiKey = await readJsonStringField(join(dir, 'identity.json'), 'api_key')
    if (apiKey) secrets.add(normalize(apiKey))
    const pendingKey = await readJsonStringField(join(dir, 'rekey-pending.json'), 'new_delegate_key')
    if (pendingKey) secrets.add(normalize(pendingKey))
  }
  return secrets
}

export function checkExactSecretMatch(text: string, secrets: ReadonlySet<string>): SecretCheckRefusal | null {
  if (secrets.size === 0) return null
  const haystack = text.toLowerCase()
  for (const secret of secrets) {
    // A short needle risks matching unrelated text; every real secret here
    // (a key, an API key, a session token) is far longer than this.
    if (secret.length >= 8 && haystack.includes(secret)) {
      return refusal(
        2,
        'local_credential',
        'Refusing to send: the text contains a credential this machine holds (an agent delegate key, an agent API key, a pending re-key, or your own session token). Remove it and try again.',
      )
    }
  }
  return null
}

// ── Layer 3 — any other 64-hex token: derive and compare ────────────

/**
 * A token is exactly 64 hex characters, optional `0x`, bounded by a
 * non-hex character on both sides — so a 128-hex calldata run yields ZERO
 * candidates rather than being windowed into two.
 */
export function findHexTokenCandidates(text: string): string[] {
  const matches = text.matchAll(/(?<![0-9a-fA-F])(0x)?([0-9a-fA-F]{64})(?![0-9a-fA-F])/g)
  return [...matches].map((m) => m[2])
}

/**
 * Treat a 64-hex token as a secp256k1 private key and derive its Ethereum
 * address, or `null` when it is not a valid key — a zero key or a key ≥ the
 * curve order `n` makes `createECDH.setPrivateKey` throw, and that token
 * simply passes (most real tokens here are hashes, not keys).
 */
export function deriveAddressFromHexToken(token: string): string | null {
  try {
    const ecdh = createECDH('secp256k1')
    ecdh.setPrivateKey(Buffer.from(token, 'hex'))
    const uncompressed = ecdh.getPublicKey() // 65 bytes, 0x04 prefix
    const hash = keccak_256(uncompressed.subarray(1))
    return `0x${Buffer.from(hash.subarray(12)).toString('hex')}`
  } catch {
    return null
  }
}

interface AgentsResponse {
  agents: Array<{ delegate_address?: string }>
}
interface AccountsResponse {
  accounts: Array<{ account_address?: string; chain_id: number }>
}
interface HybridAccountSignersResponse {
  owner_address: string | null
}

/**
 * This user's key-backed addresses: every agent's `delegate_address` (from
 * `GET /agents`) and every account's `owner_address` (from
 * `GET /accounts/hybrid/{address}/signers?chain_id=`, one call per account
 * per chain). Smart-account addresses (CREATE2, no private key) and
 * passkeys (P-256) can never match a derived secp256k1 address, so they are
 * not in the set.
 */
export async function collectKeyBackedAddresses(api: CliApi): Promise<Set<string>> {
  const addresses = new Set<string>()
  const { agents } = await api.get<AgentsResponse>('/agents')
  for (const agent of agents) {
    if (agent.delegate_address) addresses.add(agent.delegate_address.toLowerCase())
  }
  const { accounts } = await api.get<AccountsResponse>('/user/accounts')
  for (const account of accounts) {
    if (!account.account_address) continue
    const signers = await api.get<HybridAccountSignersResponse>(
      `/accounts/hybrid/${account.account_address}/signers?chain_id=${account.chain_id}`,
    )
    if (signers.owner_address) addresses.add(signers.owner_address.toLowerCase())
  }
  return addresses
}

/**
 * The address reads happen ONLY when at least one 64-hex candidate exists.
 * If a read fails, this fails CLOSED — refuses to send, with a message that
 * fits what actually failed. A transient/network failure gets a retry hint;
 * a 401/403 (the session cannot read this — the owner-cli allow-list refused
 * it, or the session itself is bad) or a 409 (the account's signer
 * configuration is unknown — nothing to compare against) are NOT fixed by
 * retrying the same call, so each gets its own distinct wording rather than
 * a reachability hint that would just repeat.
 */
export async function checkKeyBackedAddresses(text: string, api: CliApi): Promise<SecretCheckRefusal | null> {
  const candidates = findHexTokenCandidates(text)
  if (candidates.length === 0) return null

  let keyBacked: Set<string>
  try {
    keyBacked = await collectKeyBackedAddresses(api)
  } catch (err) {
    if (err instanceof CliApiError && (err.status === 401 || err.status === 403)) {
      return refusal(
        3,
        'address_check_unavailable',
        'Refusing to send: could not verify whether the text contains a private key — your session cannot read the data this check needs. Run `haven login` again; retrying this submission will not help.',
      )
    }
    if (err instanceof CliApiError && err.status === 409) {
      return refusal(
        3,
        'address_check_unavailable',
        "Refusing to send: could not verify whether the text contains a private key — one of your accounts' signer configuration is unknown, so there is nothing to compare against. Retrying this submission will not help; contact support.",
      )
    }
    return refusal(
      3,
      'address_check_unavailable',
      'Refusing to send: could not verify whether the text contains a private key (the address check failed). Retry once Haven is reachable.',
    )
  }

  for (const token of candidates) {
    const address = deriveAddressFromHexToken(token)
    if (address && keyBacked.has(address.toLowerCase())) {
      return refusal(
        3,
        'private_key',
        'Refusing to send: the text contains what looks like the private key for one of your agents or accounts. Remove it and try again.',
      )
    }
  }
  return null
}

// ── Layer 4 — recovery phrases ───────────────────────────────────────

const BIP39_WORDS = new Set(BIP39_ENGLISH.map((word) => word.toLowerCase()))
/** The shortest mnemonic BIP-39 mints. Any run at least this long contains one. */
const MIN_RECOVERY_PHRASE_WORDS = 12

/**
 * A run of 12, 15, 18, 21 or 24 CONSECUTIVE BIP-39 English words. Checking
 * for a run of at least 12 is sufficient: a longer run CONTAINS a 12-word
 * run, which is itself refusable — there is no case where a longer run
 * should pass that a 12-word one would refuse.
 */
export function checkRecoveryPhrase(text: string): SecretCheckRefusal | null {
  const tokens = text.split(/\s+/).map((t) => t.replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, '').toLowerCase())
  let run = 0
  for (const token of tokens) {
    if (token && BIP39_WORDS.has(token)) {
      run += 1
      if (run >= MIN_RECOVERY_PHRASE_WORDS) {
        return refusal(
          4,
          'recovery_phrase',
          'Refusing to send: the text looks like it contains a recovery phrase (12 or more consecutive seed words). Remove it and try again.',
        )
      }
    } else {
      run = 0
    }
  }
  return null
}

// ── Composition ───────────────────────────────────────────────────────

export interface SecretCheckDeps {
  api: CliApi
  localSecrets?: LocalSecretSources
}

/**
 * Run every layer, in order, and return the first refusal — or `null` when
 * the text may be sent. Every layer except 3's address reads is local; none
 * of them, including layer 3, ever transmits the text itself.
 */
export async function checkTextForSecrets(text: string, deps: SecretCheckDeps): Promise<SecretCheckRefusal | null> {
  const layer1 = checkLabelledSecrets(text)
  if (layer1) return layer1

  const localSecrets = await readLocalSecrets(deps.localSecrets)
  const layer2 = checkExactSecretMatch(text, localSecrets)
  if (layer2) return layer2

  const layer3 = await checkKeyBackedAddresses(text, deps.api)
  if (layer3) return layer3

  return checkRecoveryPhrase(text)
}
