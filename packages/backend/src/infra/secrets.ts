/**
 * Encryption at rest for provider secrets (#2860, epic #2858).
 *
 * The ONLY file that touches `HAVEN_SECRETS_KEY`. Everything else handles a
 * ciphertext blob and a key version, never the key.
 *
 * ## Shape
 *
 * AES-256-GCM. The blob is `iv (12) || tag (16) || ciphertext`, so a single
 * `bytea` column carries everything needed to decrypt, and the authentication
 * tag makes a tampered or truncated blob fail loudly rather than decrypt to
 * garbage. A fresh random IV per encryption — GCM is catastrophically broken
 * by IV reuse under one key, so the IV is never derived from the plaintext or
 * a counter.
 *
 * ## Key version
 *
 * Every row records `secrets_key_version`. `0` is reserved and means "not
 * encrypted" — the value the migration stamps on rows copied as-is from
 * `fortnox_connections`, so the migration itself reads no environment and
 * cannot brick a replica that lacks the key. Version `1` is the current key.
 * Rotation is a re-encrypt job that reads with the old version and writes with
 * the new, never a migration.
 *
 * ## Fail closed, but only where a secret would otherwise land in plaintext
 *
 * `encryptSecrets` throws `SecretsKeyMissingError` when no key is configured.
 * That is deliberate and asymmetric: a NEW connection write without a key
 * would store a live OAuth token in plaintext, which is the state this slice
 * exists to end. Reading a version-0 row without a key is fine — it is
 * plaintext already, and refusing to read it would turn "no key yet" into
 * "the feed is down".
 *
 * The key is 32 bytes, base64. A wrong-length key is a config error at first
 * use, not a silently weaker cipher.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

export const SECRETS_KEY_ENV = 'HAVEN_SECRETS_KEY'

/** `secrets_key_version` meaning "stored as plaintext; encrypt on next write". */
export const PLAINTEXT_KEY_VERSION = 0
/** The version `encryptSecrets` writes today. */
export const CURRENT_KEY_VERSION = 1

const ALGORITHM = 'aes-256-gcm'
const IV_BYTES = 12
const TAG_BYTES = 16
const KEY_BYTES = 32

export class SecretsKeyMissingError extends Error {
  readonly code = 'SECRETS_KEY_MISSING' as const
  constructor() {
    super(
      `${SECRETS_KEY_ENV} is not set. Provider secrets are encrypted at rest and a new ` +
        'connection cannot be stored without a key. Generate one with ' +
        '`openssl rand -base64 32` and set it on the backend before connecting.',
    )
    this.name = 'SecretsKeyMissingError'
  }
}

export class SecretsKeyInvalidError extends Error {
  readonly code = 'SECRETS_KEY_INVALID' as const
  constructor(detail: string) {
    super(`${SECRETS_KEY_ENV} is invalid: ${detail}. Expected 32 bytes, base64-encoded.`)
    this.name = 'SecretsKeyInvalidError'
  }
}

/**
 * Reads the key from the environment on every call rather than caching it at
 * import time, so a test can set and unset it and so a process that starts
 * without a key and later receives one (a re-encrypt job triggered after a
 * config change) sees the new value. It is a base64 decode, not a KDF; caching
 * would buy nothing.
 */
function readKey(env: NodeJS.ProcessEnv = process.env): Buffer | null {
  const raw = env[SECRETS_KEY_ENV]
  if (raw === undefined || raw === '') return null
  let key: Buffer
  try {
    key = Buffer.from(raw, 'base64')
  } catch (err) {
    throw new SecretsKeyInvalidError(err instanceof Error ? err.message : String(err))
  }
  if (key.length !== KEY_BYTES) {
    throw new SecretsKeyInvalidError(`decoded to ${key.length} bytes`)
  }
  return key
}

/** Whether a key is configured — the gate the boot-time re-encrypt job checks. */
export function secretsKeyConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return readKey(env) !== null
}

/**
 * Serialises and encrypts a secrets object. Throws `SecretsKeyMissingError`
 * without a key — the fail-closed half of the contract.
 */
export function encryptSecrets(
  secrets: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): { ciphertext: Buffer; keyVersion: number } {
  const key = readKey(env)
  if (!key) throw new SecretsKeyMissingError()
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  const plaintext = Buffer.from(JSON.stringify(secrets), 'utf8')
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()
  return { ciphertext: Buffer.concat([iv, tag, body]), keyVersion: CURRENT_KEY_VERSION }
}

/**
 * Decrypts a blob written by `encryptSecrets`. A version-0 blob is plaintext
 * JSON and needs no key; any other version needs the key and fails loudly on
 * a wrong key, a tampered tag, or a truncated blob.
 */
export function decryptSecrets<T = Record<string, unknown>>(
  ciphertext: Buffer,
  keyVersion: number,
  env: NodeJS.ProcessEnv = process.env,
): T {
  if (keyVersion === PLAINTEXT_KEY_VERSION) {
    return JSON.parse(ciphertext.toString('utf8')) as T
  }
  if (keyVersion !== CURRENT_KEY_VERSION) {
    throw new Error(`Unknown secrets key version ${keyVersion}; this build knows ${CURRENT_KEY_VERSION}`)
  }
  const key = readKey(env)
  if (!key) throw new SecretsKeyMissingError()
  if (ciphertext.length < IV_BYTES + TAG_BYTES) {
    throw new Error(`Secrets blob too short (${ciphertext.length} bytes) to carry an IV and tag`)
  }
  const iv = ciphertext.subarray(0, IV_BYTES)
  const tag = ciphertext.subarray(IV_BYTES, IV_BYTES + TAG_BYTES)
  const body = ciphertext.subarray(IV_BYTES + TAG_BYTES)
  const decipher = createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(tag)
  const plaintext = Buffer.concat([decipher.update(body), decipher.final()])
  return JSON.parse(plaintext.toString('utf8')) as T
}

/**
 * The plaintext encoding the migration uses for copied rows: the same JSON the
 * encrypted path would have serialised, so a version-0 row and a version-1
 * row decrypt to structurally identical objects and callers never branch.
 */
export function plaintextSecrets(secrets: Record<string, unknown>): {
  ciphertext: Buffer
  keyVersion: number
} {
  return { ciphertext: Buffer.from(JSON.stringify(secrets), 'utf8'), keyVersion: PLAINTEXT_KEY_VERSION }
}
