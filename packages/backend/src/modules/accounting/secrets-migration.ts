/**
 * Boot-time re-encryption of plaintext provider secrets (#2860).
 *
 * Migration 080 copied `fortnox_connections` rows into
 * `accounting_connections` AS-IS, stamped `secrets_key_version = 0`, because
 * a migration must not read the environment — it runs on every replica
 * including prod, and in CI with only `DATABASE_URL` set. So the encryption
 * happens here, at the application layer, on the first boot that has a key.
 *
 * ## Properties
 *
 * - **Inert without a key.** No key configured → one log line, nothing
 *   touched. The rows stay exactly as exposed as they were before this
 *   slice; no worse, one config change away from better.
 * - **Idempotent.** Only `secrets_key_version = 0` rows are read; after a
 *   successful pass there are none, and the next boot does nothing.
 * - **Per-row, not all-or-nothing.** A row whose plaintext blob does not parse
 *   is logged and skipped, not allowed to abort the others. It stays at
 *   version 0, visible to the next boot and to the on-call schema query.
 * - **Never overwrites a rotated credential.** The write is a compare-and-swap
 *   on `secrets_key_version = 0`. A refresh committed by a serving replica
 *   between this job's read and its write has already rotated the secrets to
 *   version 1; the job's copy is then STALE — it holds a refresh token Fortnox
 *   has already consumed — and writing it back would brick the connection.
 *   Reproduced in review before the guard existed. A zero-row update is
 *   counted as `moved`, not retried and not an error.
 * - **Never blocks boot.** Called after migrations and before `listen()`, but
 *   its own failure is caught and logged — a re-encrypt hiccup must not turn
 *   into "the backend will not start".
 *
 * Returns counts so the boot log and the test can both see what happened.
 */
import {
  listPlaintextConnections,
  reencryptIfStillPlaintext,
  type AccountingConnectionRow,
  type Executor,
} from '../../infra/repositories/accounting-connections.js'
import { decryptSecrets, encryptSecrets, secretsKeyConfigured } from '../../infra/secrets.js'

export interface ReencryptOutcome {
  /** No key configured; nothing was read or written. */
  skipped: boolean
  considered: number
  encrypted: number
  /** Rows that were no longer at version 0 by the time the job wrote: someone
   *  (a refresh, a reconnect) encrypted them first. Left exactly as they found them. */
  moved: number
  failed: number
}

export async function reencryptPlaintextSecrets(
  opts: { db?: Executor; env?: NodeJS.ProcessEnv; log?: (msg: string) => void } = {},
): Promise<ReencryptOutcome> {
  // No pool import here (`pg-only-in-infra`): the repository functions default
  // to the pool themselves when `db` is undefined.
  const db = opts.db
  const env = opts.env ?? process.env
  const log = opts.log ?? ((m: string) => console.log(m))

  if (!secretsKeyConfigured(env)) {
    log('[accounting] HAVEN_SECRETS_KEY not set — plaintext connection secrets left as-is (#2860)')
    return { skipped: true, considered: 0, encrypted: 0, moved: 0, failed: 0 }
  }

  const rows = await listPlaintextConnections(db)
  let encrypted = 0
  let moved = 0
  let failed = 0
  for (const row of rows) {
    try {
      const secrets = decryptSecrets<Record<string, unknown>>(row.secrets_ciphertext as Buffer, row.secrets_key_version, env)
      const { ciphertext, keyVersion } = encryptSecrets(secrets, env)
      const written = await reencryptIfStillPlaintext(
        row.user_id,
        row.provider,
        { secretsCiphertext: ciphertext, secretsKeyVersion: keyVersion },
        db,
      )
      if (written) encrypted += 1
      else moved += 1
    } catch (err) {
      failed += 1
      // The row id and the error NAME only — never `err.message`. A JSON
      // parse error embeds a prefix of the input, and the input is a secret.
      log(
        `[accounting] could not re-encrypt secrets for connection=${row.id} ` +
          `(${err instanceof Error ? err.name : 'Error'}) — row left at key version 0`,
      )
    }
  }
  if (rows.length > 0) {
    log(`[accounting] re-encrypted ${encrypted}/${rows.length} plaintext connection secret(s); ${moved} moved by a concurrent write, ${failed} failed`)
  }
  return { skipped: false, considered: rows.length, encrypted, moved, failed }
}

/** The boot hook: never throws. */
export async function reencryptPlaintextSecretsAtBoot(log: (msg: string) => void): Promise<void> {
  try {
    await reencryptPlaintextSecrets({ log })
  } catch (err) {
    log(`[accounting] secrets re-encryption failed, continuing boot: ${err instanceof Error ? err.message : String(err)}`)
  }
}

export type { AccountingConnectionRow }
