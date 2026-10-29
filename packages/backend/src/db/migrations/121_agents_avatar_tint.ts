import type { PoolClient } from 'pg'

export const version = '121_agents_avatar_tint'

/**
 * 121 — a stored display colour per agent (#4429, epic #4428 slice 1).
 *
 * Every agent surface needs a stable colour: the dashboard's agent rows, the
 * account Agents tab and the analytics spend rows all key a monogram off the
 * agent. Until now the frontend derived it from a hash of the NAME
 * (`packages/frontend/src/lib/avatar-tint.ts`), so renaming an agent changed
 * its colour and two agents could collide by accident. The owner decision on
 * #4428 (2026-10-26) is to store the tint on the row instead, assigned once.
 *
 * ## Why a trigger, not application code
 *
 * 127 files insert into `agents` (`git grep -l "INSERT INTO agents" --
 * packages/backend`), including the two runtime sites
 * (`infra/repositories/agents.ts`, `agent-connection-setups.ts`), the
 * migration tests and `scripts/db-schema-smoke.ts`. Migrations run at boot, so
 * during a rolling deploy — or after a code rollback — an old replica inserts
 * without naming the column. With `NOT NULL` and app-side assignment those
 * inserts would fail. A `BEFORE INSERT` trigger is the one copy that covers
 * every insert path, and it is the first trigger in `migrations/`.
 *
 * ## Which agents hold a tint (owner decision 2026-10-26)
 *
 * - **Held:** `archived_at IS NULL AND superseded_by_agent_id IS NULL` — that
 *   covers active, paused, `pending_approval` and revoked agents. The
 *   predicate lives in ONE function (`agent_holds_avatar_tint`) that the
 *   insert trigger, the inherit trigger and the backfill all call.
 * - **Released:** archiving or superseding an agent frees its tint for the
 *   NEXT new agent. No existing agent is recoloured.
 * - **Inherited:** when `superseded_by_agent_id` is set (`POST
 *   /agent-connection-setups/{setupId}/retired-agents`, the
 *   `RecordRetiredAgents` path), the replacement takes
 *   the predecessor's tint unless another held agent holds it. An `AFTER
 *   UPDATE OF superseded_by_agent_id` trigger does it, so there is one copy
 *   and no route code. It fires once, on the run that retires the
 *   predecessor.
 * - **Backfill:** held agents first, oldest first per user, then released
 *   (archived or superseded) agents by least-used, lowest number — so the
 *   column can be `NOT NULL` without a released agent ever taking a tint a
 *   held agent needs.
 *
 * ## Concurrency
 *
 * Two agents created for one user at the same moment may get the same tint:
 * the trigger reads the table as of its statement's snapshot, and there is no
 * unique constraint. That is accepted — the tint is a display hint, not
 * identity, and a unique index would turn a cosmetic collision into a failed
 * agent creation. When all six tints are held, the trigger falls back to the
 * least-used, lowest-numbered tint among the held agents, so the duplication
 * is spread rather than piled on tint 1.
 *
 * ## Presentation only
 *
 * `avatar_tint` is display data. Nothing on the payment path, the delegation,
 * the budget or the enforcement path reads it, and it carries no authority or
 * custody weight (the same boundary as 112's supersession columns and 118's
 * acknowledgements).
 *
 * `ADD COLUMN ... NULL` is metadata-only in Postgres 11+; the backfill and the
 * `SET NOT NULL` are the only table-touching steps, and the runner wraps the
 * whole migration in one transaction under its advisory lock.
 */
export async function up(client: PoolClient): Promise<void> {
  await client.query(`ALTER TABLE agents ADD COLUMN IF NOT EXISTS avatar_tint SMALLINT`)

  // CHECK precedent: 118's `attention_dismissals_kind_shape`, 119's detail
  // allowlist. NULL passes a CHECK (unknown is not a violation), which is what
  // lets the column be nullable until the backfill below finishes.
  await client.query(`ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_avatar_tint_range`)
  await client.query(`
    ALTER TABLE agents ADD CONSTRAINT agents_avatar_tint_range
      CHECK (avatar_tint BETWEEN 1 AND 6)
  `)

  // The ONE "held" predicate. Every caller below goes through it, so the
  // owner's rule cannot drift between the insert trigger, the inherit trigger
  // and the backfill.
  await client.query(`
    CREATE OR REPLACE FUNCTION agent_holds_avatar_tint(
      p_archived_at TIMESTAMPTZ,
      p_superseded_by_agent_id UUID
    ) RETURNS BOOLEAN
    LANGUAGE sql
    IMMUTABLE
    PARALLEL SAFE
    AS $$
      SELECT p_archived_at IS NULL AND p_superseded_by_agent_id IS NULL
    $$
  `)

  // The assignment rule for a NEW agent: the lowest tint in 1..6 that no held
  // agent of this user holds. When all six are held, the least-used,
  // lowest-numbered tint among the held agents (see "Concurrency" above).
  // `p_exclude_agent_id` lets the backfill ignore the row it is assigning.
  await client.query(`
    CREATE OR REPLACE FUNCTION agent_next_avatar_tint(
      p_user_id UUID,
      p_exclude_agent_id UUID DEFAULT NULL
    ) RETURNS SMALLINT
    LANGUAGE sql
    STABLE
    AS $$
      SELECT COALESCE(
        (
          SELECT t.tint
            FROM generate_series(1, 6) AS t(tint)
           WHERE NOT EXISTS (
                   SELECT 1
                     FROM agents a
                    WHERE a.user_id = p_user_id
                      AND a.avatar_tint = t.tint
                      AND agent_holds_avatar_tint(a.archived_at, a.superseded_by_agent_id)
                      AND (p_exclude_agent_id IS NULL OR a.id <> p_exclude_agent_id)
                 )
           ORDER BY t.tint
           LIMIT 1
        ),
        (
          SELECT t.tint
            FROM generate_series(1, 6) AS t(tint)
            LEFT JOIN agents a
              ON a.user_id = p_user_id
             AND a.avatar_tint = t.tint
             AND agent_holds_avatar_tint(a.archived_at, a.superseded_by_agent_id)
             AND (p_exclude_agent_id IS NULL OR a.id <> p_exclude_agent_id)
           GROUP BY t.tint
           ORDER BY COUNT(a.id), t.tint
           LIMIT 1
        )
      )
    $$
  `)

  // The backfill's rule for RELEASED agents: least-used, lowest number across
  // every agent of the user. Held agents are assigned first, so this can never
  // take a tint a held agent needs.
  await client.query(`
    CREATE OR REPLACE FUNCTION agent_least_used_avatar_tint(p_user_id UUID)
    RETURNS SMALLINT
    LANGUAGE sql
    STABLE
    AS $$
      SELECT t.tint
        FROM generate_series(1, 6) AS t(tint)
        LEFT JOIN agents a
          ON a.user_id = p_user_id
         AND a.avatar_tint = t.tint
       GROUP BY t.tint
       ORDER BY COUNT(a.id), t.tint
       LIMIT 1
    $$
  `)

  await client.query(`
    CREATE OR REPLACE FUNCTION agents_assign_avatar_tint_on_insert()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
    BEGIN
      -- An explicit tint is kept: only a NULL is filled. Old replicas and
      -- every test helper that does not name the column land here.
      IF NEW.avatar_tint IS NULL THEN
        NEW.avatar_tint := agent_next_avatar_tint(NEW.user_id, NULL);
      END IF;
      RETURN NEW;
    END;
    $$
  `)
  await client.query(`DROP TRIGGER IF EXISTS agents_assign_avatar_tint ON agents`)
  await client.query(`
    CREATE TRIGGER agents_assign_avatar_tint
      BEFORE INSERT ON agents
      FOR EACH ROW
      EXECUTE FUNCTION agents_assign_avatar_tint_on_insert()
  `)

  await client.query(`
    CREATE OR REPLACE FUNCTION agents_inherit_avatar_tint_on_supersede()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
    DECLARE
      v_tint SMALLINT;
    BEGIN
      IF NEW.superseded_by_agent_id IS NULL
         OR NEW.superseded_by_agent_id = NEW.id
         OR NEW.superseded_by_agent_id IS NOT DISTINCT FROM OLD.superseded_by_agent_id THEN
        RETURN NEW;
      END IF;

      v_tint := OLD.avatar_tint;
      IF v_tint IS NULL THEN
        RETURN NEW;
      END IF;

      -- This very update releases the predecessor, so it no longer holds its
      -- tint; only ANOTHER held agent can block the inheritance.
      IF EXISTS (
        SELECT 1
          FROM agents a
         WHERE a.user_id = NEW.user_id
           AND a.avatar_tint = v_tint
           AND a.id <> NEW.id
           AND a.id <> NEW.superseded_by_agent_id
           AND agent_holds_avatar_tint(a.archived_at, a.superseded_by_agent_id)
      ) THEN
        RETURN NEW;
      END IF;

      UPDATE agents
         SET avatar_tint = v_tint
       WHERE id = NEW.superseded_by_agent_id
         AND user_id = NEW.user_id
         AND agent_holds_avatar_tint(archived_at, superseded_by_agent_id)
         AND avatar_tint IS DISTINCT FROM v_tint;

      RETURN NEW;
    END;
    $$
  `)
  await client.query(`DROP TRIGGER IF EXISTS agents_inherit_avatar_tint ON agents`)
  await client.query(`
    CREATE TRIGGER agents_inherit_avatar_tint
      AFTER UPDATE OF superseded_by_agent_id ON agents
      FOR EACH ROW
      EXECUTE FUNCTION agents_inherit_avatar_tint_on_supersede()
  `)

  // Backfill. Held agents first, oldest first per user, so the tints a held
  // agent needs are taken before any released agent is coloured.
  await client.query(`
    DO $$
    DECLARE
      r RECORD;
    BEGIN
      FOR r IN
        SELECT a.id, a.user_id
          FROM agents a
         WHERE agent_holds_avatar_tint(a.archived_at, a.superseded_by_agent_id)
         ORDER BY a.user_id, a.created_at ASC NULLS LAST, a.id
      LOOP
        UPDATE agents
           SET avatar_tint = agent_next_avatar_tint(r.user_id, r.id)
         WHERE id = r.id;
      END LOOP;

      FOR r IN
        SELECT a.id, a.user_id
          FROM agents a
         WHERE NOT agent_holds_avatar_tint(a.archived_at, a.superseded_by_agent_id)
         ORDER BY a.user_id, a.created_at ASC NULLS LAST, a.id
      LOOP
        UPDATE agents
           SET avatar_tint = agent_least_used_avatar_tint(r.user_id)
         WHERE id = r.id;
      END LOOP;
    END;
    $$
  `)

  await client.query(`ALTER TABLE agents ALTER COLUMN avatar_tint SET NOT NULL`)
}

/**
 * Structural down (#1139): drops exactly what this migration added, in
 * dependency order — the triggers before the functions they call, the
 * functions before the column they read.
 */
export async function down(client: PoolClient): Promise<void> {
  await client.query(`DROP TRIGGER IF EXISTS agents_inherit_avatar_tint ON agents`)
  await client.query(`DROP TRIGGER IF EXISTS agents_assign_avatar_tint ON agents`)
  await client.query(`DROP FUNCTION IF EXISTS agents_inherit_avatar_tint_on_supersede()`)
  await client.query(`DROP FUNCTION IF EXISTS agents_assign_avatar_tint_on_insert()`)
  await client.query(`DROP FUNCTION IF EXISTS agent_least_used_avatar_tint(UUID)`)
  await client.query(`DROP FUNCTION IF EXISTS agent_next_avatar_tint(UUID, UUID)`)
  await client.query(`DROP FUNCTION IF EXISTS agent_holds_avatar_tint(TIMESTAMPTZ, UUID)`)
  await client.query(`ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_avatar_tint_range`)
  await client.query(`ALTER TABLE agents DROP COLUMN IF EXISTS avatar_tint`)
}
