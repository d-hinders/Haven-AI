/**
 * Purge throwaway QA identities from the dev database (#4679, epic #4674).
 *
 * Five deterministic money-flow scenarios provision a throwaway identity on
 * every run (`packages/qa-agent/src/lib/throwaway-identity.ts`) and only revoke
 * its agent, so the user, account, agent, budget and payment rows accumulate.
 * No route deletes a user, and `DELETE /user/accounts/:id` only unlinks, so the
 * clean-up is a manual, dev-only workflow rather than an ops-console action
 * (owner decision 2026-11-05; `/ops` stays read-only, epic #3507).
 *
 * ## Why this lives in `infra/repositories/`
 *
 * `pg-only-in-infra` (`.dependency-cruiser.cjs`, rule 3) makes this directory
 * the only place under `src/` that may reach the database. A destructive
 * maintenance routine is exactly the kind of caller that rule exists for: the
 * SQL is importable by a real-Postgres test instead of being inlined in a
 * script no CI routing reaches.
 *
 * ## The match is two conditions, never one
 *
 * The runbook's recipe writes `SEED_QA_EMAIL=qa-delegation-<hex>@haven.test`
 * (`docs/operations/agent-qa.md`), which fits `qa-%@haven.test` and has the
 * same shape as the harness's `qa-<label>-<rand>@haven.test`. That standing
 * identity is what `qa-dev.yml` and the release gate depend on, so an email
 * pattern alone would delete it. A row matches only when BOTH hold:
 *
 *   - `lower(email) LIKE 'qa-%@haven.test'`
 *   - `name ~ '^QA .+ \(throwaway\)$'` — the harness signs up as
 *     `QA <label> (throwaway)`; the seed's user is named `QA Bot`.
 *
 * ## Deletion order
 *
 * Measured from a migrated database (`pg_constraint`, 123 migrations): the
 * restricting (NO ACTION / RESTRICT) references in a throwaway's graph are
 *
 *   - `payment_intents.user_id` -> `users`            (NO ACTION)
 *   - `payment_intents.agent_id` -> `agents`          (NO ACTION)
 *   - `agent_rekeys.initiated_by_user_id` -> `users`  (NO ACTION)
 *   - `agent_delegations.rekey_id` -> `agent_rekeys`  (NO ACTION)
 *   - `payment_intents.task_budget_id` -> `agent_task_budgets` (NO ACTION)
 *   - `payment_intents.sub_budget_id` -> `agent_sub_budgets`   (NO ACTION)
 *   - `agent_organizations.parent_organization_id` -> `agent_organizations`
 *     (RESTRICT)
 *
 * so the order is: payment intents, delegations, rekeys, organizations
 * (leaves first), agents, then the user. Everything else cascades.
 *
 * `outbound_txs.replaced_by` is also NO ACTION, but `outbound_txs` has no
 * foreign key to `users` or `agents` (`submitter` is free text), so no row of
 * it is in a throwaway's graph and the purge never deletes one. It is listed
 * here because a future migration that links the queue to a user would make
 * the self-reference reachable, and the `pg_constraint` test in
 * `__tests__/qa-throwaway-purge.test.ts` is what would notice.
 *
 * ## What stays, on purpose
 *
 * `machine_payment_receipts` and `accounting_webhook_deliveries` survive via
 * `ON DELETE SET NULL`, and the gas ledgers (`relayer_gas_events`,
 * `sponsored_userop_gas_events`) have no foreign key at all. Dev's gas
 * accounting stays true; the runbook says so.
 */

import { withTransaction, type Executor, type QueryRow } from '../transaction.js'

/** Retention bounds. `0` is refused: there is no zero-day override (#4679). */
export const RETENTION_MIN_DAYS = 1
export const RETENTION_MAX_DAYS = 365
export const DEFAULT_RETENTION_DAYS = 7

/** The two conditions a row must meet. Exported so the test pins the shapes. */
export const THROWAWAY_EMAIL_LIKE = 'qa-%@haven.test'
export const THROWAWAY_NAME_REGEX = '^QA .+ \\(throwaway\\)$'

/** Tables the purge deletes from, in the order it touches them. */
export const PURGED_TABLES = [
  'payment_intents',
  'agent_delegations',
  'agent_rekeys',
  'agent_organizations',
  'agents',
  'users',
] as const

/** Tables that survive a purge by design, with the mechanism that keeps them. */
export const KEPT_TABLES = ['machine_payment_receipts', 'accounting_webhook_deliveries'] as const

/** A refusal the operator can act on. Never a partial run. */
export class PurgeRefusal extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PurgeRefusal'
  }
}

// ── Retention ────────────────────────────────────────────────────────────────

/**
 * Validate the retention input BEFORE any connection is opened.
 *
 * A malformed or negative value must never widen the deletion window, and `0`
 * is refused outright: "delete everything created before now" is not a
 * retention policy, it is an accident waiting for a typo.
 */
export function parseRetentionDays(raw: string | number | undefined | null): number {
  if (raw === undefined || raw === null) {
    throw new PurgeRefusal(`retention days is required (an integer from ${RETENTION_MIN_DAYS} to ${RETENTION_MAX_DAYS})`)
  }
  const text = String(raw).trim()
  if (text === '') {
    throw new PurgeRefusal(`retention days is required (an integer from ${RETENTION_MIN_DAYS} to ${RETENTION_MAX_DAYS})`)
  }
  if (!/^\d+$/.test(text)) {
    throw new PurgeRefusal(`retention days must be a whole number, got ${JSON.stringify(text)}`)
  }
  const days = Number(text)
  if (!Number.isSafeInteger(days) || days < RETENTION_MIN_DAYS || days > RETENTION_MAX_DAYS) {
    throw new PurgeRefusal(
      `retention days must be between ${RETENTION_MIN_DAYS} and ${RETENTION_MAX_DAYS}, got ${text}`,
    )
  }
  return days
}

// ── Secondary guard: identify the DATABASE, not only its endpoint ────────────

/**
 * The allowlisted target, held in the protected GitHub environment and never
 * committed (the repo is public).
 *
 * `systemIdentifier` is the cluster's `pg_control_system().system_identifier`,
 * assigned at `initdb` and unique per cluster. It is here because the database
 * NAME alone proves nothing: Railway's default database is called `railway` in
 * both the dev and the production project, so `current_database()` would agree
 * with a production credential that was pasted into the dev environment. The
 * system identifier is what actually distinguishes the two clusters.
 */
export interface AllowedTarget {
  host: string
  port: string
  database: string
  systemIdentifier: string
}

export const ALLOWED_TARGET_ENV = {
  host: 'QA_PURGE_ALLOWED_HOST',
  port: 'QA_PURGE_ALLOWED_PORT',
  database: 'QA_PURGE_ALLOWED_DATABASE',
  systemIdentifier: 'QA_PURGE_ALLOWED_SYSTEM_IDENTIFIER',
} as const

export function allowedTargetFromEnv(env: NodeJS.ProcessEnv = process.env): AllowedTarget {
  const missing = Object.values(ALLOWED_TARGET_ENV).filter((key) => !env[key]?.trim())
  if (missing.length > 0) {
    throw new PurgeRefusal(
      `refusing to run: the protected environment must set ${missing.join(', ')} ` +
        '(the allowlisted host, port, database name and cluster system identifier)',
    )
  }
  return {
    host: env[ALLOWED_TARGET_ENV.host]!.trim(),
    port: env[ALLOWED_TARGET_ENV.port]!.trim(),
    database: env[ALLOWED_TARGET_ENV.database]!.trim(),
    systemIdentifier: env[ALLOWED_TARGET_ENV.systemIdentifier]!.trim(),
  }
}

/**
 * Compare the connection URL's exact host, port and database name with the
 * allowlisted tuple. Exact equality, never a suffix match: a shared proxy
 * suffix (`*.proxy.rlwy.net`) is the same string for dev and production, so
 * matching on it would accept the wrong endpoint.
 */
export function assertUrlMatchesTarget(connectionString: string, target: AllowedTarget): void {
  let url: URL
  try {
    url = new URL(connectionString)
  } catch {
    throw new PurgeRefusal('refusing to run: the database URL is not a valid URL')
  }
  const host = url.hostname
  const port = url.port || '5432'
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''))
  if (host !== target.host) {
    throw new PurgeRefusal(`refusing to run: database host ${host} is not the allowlisted ${target.host}`)
  }
  if (port !== target.port) {
    throw new PurgeRefusal(`refusing to run: database port ${port} is not the allowlisted ${target.port}`)
  }
  if (database !== target.database) {
    throw new PurgeRefusal(
      `refusing to run: database name ${database} is not the allowlisted ${target.database} ` +
        '(same host and port is not enough — two databases can share one endpoint)',
    )
  }
}

export interface ServerIdentity {
  database: string
  systemIdentifier: string
}

/** Read what the server says it is. One query, no writes. */
export async function readServerIdentity(db: Executor): Promise<ServerIdentity> {
  const result = await db.query<{ database: string; system_identifier: string }>(
    `SELECT current_database() AS database,
            (SELECT system_identifier::text FROM pg_control_system()) AS system_identifier`,
  )
  const row = result.rows[0]
  if (!row) throw new PurgeRefusal('refusing to run: the server did not report an identity')
  return { database: row.database, systemIdentifier: row.system_identifier }
}

/**
 * Verify the server-side identity AFTER connecting and BEFORE any purge query,
 * dry run included. The URL can name one database while the credential lands
 * on another (a proxy, a pooler, a stale secret); this is the check that
 * catches it.
 */
export async function assertServerIdentity(db: Executor, target: AllowedTarget): Promise<ServerIdentity> {
  const identity = await readServerIdentity(db)
  if (identity.database !== target.database) {
    throw new PurgeRefusal(
      `refusing to run: the server reports database ${identity.database}, not the allowlisted ${target.database}`,
    )
  }
  if (identity.systemIdentifier !== target.systemIdentifier) {
    throw new PurgeRefusal(
      'refusing to run: the server reports a different cluster system identifier than the allowlisted one ' +
        '(the URL and the credential disagree about which database this is)',
    )
  }
  return identity
}

// ── Candidates ───────────────────────────────────────────────────────────────

export interface PurgeCandidate {
  userId: string
  createdAt: Date
}

const CANDIDATE_SQL = `
  SELECT id, created_at
  FROM users
  WHERE lower(email) LIKE $1
    AND name ~ $2
    AND created_at < $3
  ORDER BY created_at, id
`

export async function selectCandidates(db: Executor, cutoff: Date): Promise<PurgeCandidate[]> {
  const result = await db.query<{ id: string; created_at: Date }>(CANDIDATE_SQL, [
    THROWAWAY_EMAIL_LIKE,
    THROWAWAY_NAME_REGEX,
    cutoff,
  ])
  return result.rows.map((row) => ({ userId: row.id, createdAt: row.created_at }))
}

export type PurgeCounts = Record<string, number>

function emptyCounts(): PurgeCounts {
  return Object.fromEntries(PURGED_TABLES.map((table) => [table, 0]))
}

function addCounts(into: PurgeCounts, from: PurgeCounts): void {
  for (const [table, count] of Object.entries(from)) into[table] = (into[table] ?? 0) + count
}

/**
 * Dry-run counts for the whole candidate set, in one query. Same predicates as
 * the delete path, so the report is what the apply run would do.
 */
export async function countCandidates(db: Executor, cutoff: Date): Promise<{ purged: PurgeCounts; kept: PurgeCounts }> {
  const result = await db.query<QueryRow>(
    `
    WITH candidates AS (
      SELECT id FROM users
      WHERE lower(email) LIKE $1 AND name ~ $2 AND created_at < $3
    ),
    agents_of AS (
      SELECT id FROM agents WHERE user_id IN (SELECT id FROM candidates)
    ),
    intents_of AS (
      SELECT id FROM payment_intents
      WHERE user_id IN (SELECT id FROM candidates) OR agent_id IN (SELECT id FROM agents_of)
    )
    SELECT
      (SELECT count(*) FROM candidates) AS users,
      (SELECT count(*) FROM agents_of) AS agents,
      (SELECT count(*) FROM intents_of) AS payment_intents,
      (SELECT count(*) FROM agent_delegations WHERE agent_id IN (SELECT id FROM agents_of)) AS agent_delegations,
      (SELECT count(*) FROM agent_rekeys
        WHERE initiated_by_user_id IN (SELECT id FROM candidates) OR agent_id IN (SELECT id FROM agents_of)) AS agent_rekeys,
      (SELECT count(*) FROM agent_organizations WHERE user_id IN (SELECT id FROM candidates)) AS agent_organizations,
      (SELECT count(*) FROM machine_payment_receipts WHERE payment_intent_id IN (SELECT id FROM intents_of)) AS machine_payment_receipts,
      (SELECT count(*) FROM accounting_webhook_deliveries WHERE user_id IN (SELECT id FROM candidates)) AS accounting_webhook_deliveries
    `,
    [THROWAWAY_EMAIL_LIKE, THROWAWAY_NAME_REGEX, cutoff],
  )
  const row = result.rows[0] ?? {}
  const purged = emptyCounts()
  for (const table of PURGED_TABLES) purged[table] = Number(row[table] ?? 0)
  const kept: PurgeCounts = {}
  for (const table of KEPT_TABLES) kept[table] = Number(row[table] ?? 0)
  return { purged, kept }
}

// ── Deletion ─────────────────────────────────────────────────────────────────

/**
 * Delete one throwaway identity, inside the caller's transaction.
 *
 * Every statement is scoped to the user (directly, or through the agents the
 * user owns), so a bug here cannot reach another tenant's rows.
 *
 * `kept` is counted BEFORE the deletes: the SET NULL rows survive the purge but
 * lose their link, so they cannot be counted afterwards.
 */
export async function purgeOneUser(
  tx: Executor,
  userId: string,
): Promise<{ purged: PurgeCounts; kept: PurgeCounts }> {
  const counts = emptyCounts()
  const kept: PurgeCounts = Object.fromEntries(KEPT_TABLES.map((table) => [table, 0]))

  const agents = await tx.query<{ id: string }>('SELECT id FROM agents WHERE user_id = $1', [userId])
  const agentIds = agents.rows.map((row) => row.id)

  const keptReceipts = await tx.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM machine_payment_receipts
     WHERE payment_intent_id IN (
       SELECT id FROM payment_intents WHERE user_id = $1 OR agent_id = ANY($2::uuid[])
     )`,
    [userId, agentIds],
  )
  kept.machine_payment_receipts = Number(keptReceipts.rows[0]?.count ?? 0)

  const keptDeliveries = await tx.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM accounting_webhook_deliveries WHERE user_id = $1',
    [userId],
  )
  kept.accounting_webhook_deliveries = Number(keptDeliveries.rows[0]?.count ?? 0)

  // 1. payment_intents: the NO ACTION references to users and agents, and the
  //    NO ACTION references to task/sub budgets, all leave with these rows.
  counts.payment_intents =
    (await tx.query('DELETE FROM payment_intents WHERE user_id = $1 OR agent_id = ANY($2::uuid[]) RETURNING id', [
      userId,
      agentIds,
    ])).rowCount ?? 0

  // 2. agent_delegations: clears agent_delegations.rekey_id before the rekeys go.
  counts.agent_delegations =
    (await tx.query('DELETE FROM agent_delegations WHERE agent_id = ANY($1::uuid[]) RETURNING id', [agentIds]))
      .rowCount ?? 0

  // 3. agent_rekeys: the NO ACTION reference to users.
  counts.agent_rekeys =
    (await tx.query(
      'DELETE FROM agent_rekeys WHERE initiated_by_user_id = $1 OR agent_id = ANY($2::uuid[]) RETURNING id',
      [userId, agentIds],
    )).rowCount ?? 0

  // 4. agent_organizations: RESTRICT on parent_organization_id, so leaves first.
  counts.agent_organizations = await deleteOrganizations(tx, userId)

  // 5. agents, then the user. Everything else cascades.
  counts.agents = (await tx.query('DELETE FROM agents WHERE user_id = $1 RETURNING id', [userId])).rowCount ?? 0
  counts.users = (await tx.query('DELETE FROM users WHERE id = $1 RETURNING id', [userId])).rowCount ?? 0

  return { purged: counts, kept }
}

/**
 * Delete the user's organizations leaf-first. A child owned by ANOTHER user
 * makes the parent undeletable, which is correct: the transaction rolls back
 * and the run reports that user as failed rather than silently orphaning
 * someone else's organization.
 */
async function deleteOrganizations(tx: Executor, userId: string): Promise<number> {
  let total = 0
  // Bounded: an organization tree deeper than this is not a QA throwaway.
  for (let pass = 0; pass < 100; pass += 1) {
    const result = await tx.query(
      `DELETE FROM agent_organizations o
       WHERE o.user_id = $1
         AND NOT EXISTS (SELECT 1 FROM agent_organizations c WHERE c.parent_organization_id = o.id)
       RETURNING o.id`,
      [userId],
    )
    const deleted = result.rowCount ?? 0
    total += deleted
    if (deleted === 0) break
  }
  return total
}

// ── Run ──────────────────────────────────────────────────────────────────────

export interface PurgeOptions {
  retentionDays: number
  dryRun: boolean
  /** Injectable clock, so the retention boundary is testable. */
  now?: Date
}

export interface PurgeFailure {
  userId: string
  error: string
}

export interface PurgeResult {
  dryRun: boolean
  retentionDays: number
  cutoff: string
  candidates: number
  deletedUsers: number
  failedUsers: number
  purged: PurgeCounts
  kept: PurgeCounts
  failures: PurgeFailure[]
}

/**
 * Run the purge. One transaction per user: a failure leaves that user whole,
 * the run continues so the summary is complete, and `failures` is non-empty —
 * which is what makes the job exit nonzero. A partly failed destructive run
 * must never look green.
 */
export async function runPurge(db: Executor, options: PurgeOptions): Promise<PurgeResult> {
  const retentionDays = parseRetentionDays(options.retentionDays)
  const now = options.now ?? new Date()
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000)

  const candidates = await selectCandidates(db, cutoff)

  if (options.dryRun) {
    const { purged, kept } = await countCandidates(db, cutoff)
    return {
      dryRun: true,
      retentionDays,
      cutoff: cutoff.toISOString(),
      candidates: candidates.length,
      deletedUsers: 0,
      failedUsers: 0,
      purged,
      kept,
      failures: [],
    }
  }

  const purged = emptyCounts()
  const kept: PurgeCounts = Object.fromEntries(KEPT_TABLES.map((table) => [table, 0]))
  const failures: PurgeFailure[] = []
  let deletedUsers = 0

  for (const candidate of candidates) {
    try {
      const perUser = await withTransaction(db, (tx) => purgeOneUser(tx, candidate.userId))
      addCounts(purged, perUser.purged)
      addCounts(kept, perUser.kept)
      deletedUsers += 1
    } catch (error) {
      failures.push({
        userId: candidate.userId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return {
    dryRun: false,
    retentionDays,
    cutoff: cutoff.toISOString(),
    candidates: candidates.length,
    deletedUsers,
    failedUsers: failures.length,
    purged,
    kept,
    failures,
  }
}

// ── Summary ──────────────────────────────────────────────────────────────────

/**
 * Markdown for the job summary. Counts only: the repo is public, so no email,
 * API key or address is ever printed.
 */
export function renderSummary(result: PurgeResult): string {
  const lines: string[] = []
  lines.push(`## QA throwaway purge — ${result.dryRun ? 'DRY RUN (nothing deleted)' : 'APPLIED'}`)
  lines.push('')
  lines.push(`- Retention: ${result.retentionDays} day(s); cutoff ${result.cutoff}`)
  lines.push(`- Candidates: ${result.candidates}`)
  if (!result.dryRun) {
    lines.push(`- Users deleted: ${result.deletedUsers}`)
    lines.push(`- Users failed: ${result.failedUsers}`)
  }
  lines.push('')
  lines.push('| Table | Rows |')
  lines.push('| --- | ---: |')
  for (const table of PURGED_TABLES) lines.push(`| ${table} | ${result.purged[table] ?? 0} |`)
  lines.push('')
  lines.push('Kept by design (SET NULL, so dev accounting stays true):')
  lines.push('')
  lines.push('| Table | Rows |')
  lines.push('| --- | ---: |')
  for (const table of KEPT_TABLES) lines.push(`| ${table} | ${result.kept[table] ?? 0} |`)
  lines.push('')
  lines.push('The gas ledgers (`relayer_gas_events`, `sponsored_userop_gas_events`) have no foreign key and are never touched.')
  if (result.failures.length > 0) {
    lines.push('')
    lines.push(`### ${result.failures.length} user(s) failed — the run is NOT green`)
    lines.push('')
    for (const failure of result.failures) lines.push(`- \`${failure.userId}\`: ${failure.error}`)
  }
  return `${lines.join('\n')}\n`
}
