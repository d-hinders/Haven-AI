import type { PoolClient } from 'pg'

export const version = '122_agents_avatar_tint_superseded_holds'

/**
 * 122 — a superseded agent keeps holding its tint until it is archived
 * (#4448, epic #4428 finding B1).
 *
 * ## What 121 got wrong
 *
 * 121 treated a superseded agent (`superseded_by_agent_id IS NOT NULL`) as
 * having released its tint, and handed that tint to the replacement. Both
 * halves rest on a premise that does not hold: a superseded agent is not
 * hidden anywhere. `superseded_by_agent_id` is read in exactly two places
 * outside migrations and tests — the writer (`MARK_AGENTS_SUPERSEDED_SQL`) and
 * `FIND_AGENT_SUPERSESSION_SQL`, which serves the `superseded_by` warning to
 * the stale agent on its own agent-authenticated reads. No agent list read
 * filters on it: the dashboard preview filters by status only, `GET /agents`
 * has no filter, and the analytics overview filters by `user_id` only. The
 * frontend never reads the column at all.
 *
 * So after `POST /agent-connection-setups/{setupId}/retired-agents` the
 * replacement and its still-visible predecessor wore the SAME colour side by
 * side — on the dashboard, on `/agents`, in the account Agents tab and in
 * analytics. That is the collision epic #4428 exists to remove.
 *
 * ## The rule this migration installs (owner decision 2026-10-29)
 *
 * - **Held:** `archived_at IS NULL`. A superseded agent holds its tint; only
 *   archiving releases it. Nothing is hidden, so the old agent stays easy to
 *   find and revoke.
 * - **No inheritance.** The replacement keeps the tint it got at creation and
 *   is never recoloured. This reverses the inheritance half of #4428's option
 *   (a) — inheritance recolours an agent while it is visible. The rest of
 *   option (a) stands: visible agents hold a tint, archived agents release
 *   theirs.
 * - **History exception (accepted, no code):** an archived agent that still
 *   appears in a historical view (Analytics with activity in the range,
 *   `/agents` with Archived shown, the agent panel's removed list) may repeat
 *   a released tint next to the agent that took it. Documented in
 *   `docs/product/design-system.md`.
 *
 * ## Backfill
 *
 * Rows written under 121 can already carry a collision this rule leaves
 * behind: an inherited pair (predecessor and replacement on one tint), or a
 * predecessor whose released tint a later agent took. Among the non-archived
 * agents of every user with six or fewer such agents, the backfill walks the
 * agents oldest first and recolours the NEWER agent of each colliding pair to
 * the lowest tint no earlier agent of that user holds. Users with more than
 * six non-archived agents are left alone: past six a repeat is unavoidable,
 * and recolouring there would churn colours for nothing.
 *
 * ## Unarchive
 *
 * `POST /agents/:id/unarchive` clears only `archived_at`. If the agent's
 * stored tint is now held by another non-archived agent of the same user and
 * the user has six or fewer non-archived agents after the unarchive, the
 * agent gets a free tint; otherwise it keeps its tint. That lives in
 * `UNARCHIVE_AGENT_SQL` (`infra/repositories/agents.ts`) rather than a
 * trigger, because it is one statement on one row and the route already owns
 * the write. It recolours only an agent that was hidden, so the "never
 * recoloured while visible" rule holds.
 *
 * ## Presentation only
 *
 * `avatar_tint` is display data (121 `:57-60`). Nothing on the payment,
 * delegation, budget or enforcement path reads it or
 * `superseded_by_agent_id` (112 `:11-15`). This migration changes no custody,
 * signing or spend authority.
 */
export async function up(client: PoolClient): Promise<void> {
  // The ONE "held" predicate, now with no supersession term. The signature
  // loses its second argument, so this is a new overload rather than a
  // replacement; the two-argument version is dropped below once nothing calls
  // it.
  await client.query(`
    CREATE OR REPLACE FUNCTION agent_holds_avatar_tint(
      p_archived_at TIMESTAMPTZ
    ) RETURNS BOOLEAN
    LANGUAGE sql
    IMMUTABLE
    PARALLEL SAFE
    AS $$
      SELECT p_archived_at IS NULL
    $$
  `)

  // Same assignment rule as 121, against the new predicate: the lowest tint in
  // 1..6 that no held agent of this user holds, falling back to the least-used,
  // lowest-numbered tint when all six are held.
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
                      AND agent_holds_avatar_tint(a.archived_at)
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
             AND agent_holds_avatar_tint(a.archived_at)
             AND (p_exclude_agent_id IS NULL OR a.id <> p_exclude_agent_id)
           GROUP BY t.tint
           ORDER BY COUNT(a.id), t.tint
           LIMIT 1
        )
      )
    $$
  `)

  // No inheritance: the replacement keeps the tint it got at creation.
  await client.query(`DROP TRIGGER IF EXISTS agents_inherit_avatar_tint ON agents`)
  await client.query(`DROP FUNCTION IF EXISTS agents_inherit_avatar_tint_on_supersede()`)

  // Nothing calls the two-argument predicate any more.
  await client.query(`DROP FUNCTION IF EXISTS agent_holds_avatar_tint(TIMESTAMPTZ, UUID)`)

  // Backfill: remove the collisions 121's rule left behind, recolouring the
  // NEWER agent of each colliding pair. Oldest first per user, so "newer" is
  // the row reached later in this walk.
  await client.query(`
    DO $$
    DECLARE
      r RECORD;
      v_user UUID;
      v_taken SMALLINT[];
      v_free SMALLINT;
    BEGIN
      FOR r IN
        SELECT a.id, a.user_id, a.avatar_tint
          FROM agents a
         WHERE a.archived_at IS NULL
           AND (
                 SELECT count(*)
                   FROM agents c
                  WHERE c.user_id = a.user_id
                    AND c.archived_at IS NULL
               ) <= 6
         ORDER BY a.user_id, a.created_at ASC NULLS LAST, a.id
      LOOP
        IF v_user IS DISTINCT FROM r.user_id THEN
          v_user := r.user_id;
          v_taken := ARRAY[]::SMALLINT[];
        END IF;

        IF r.avatar_tint = ANY(v_taken) THEN
          -- A collision: this row is the newer of the pair, so it moves. With
          -- at most six non-archived agents and at most five distinct tints
          -- already taken, a free tint always exists; the guard is belt and
          -- braces so a surprise cannot fail the migration on NOT NULL.
          SELECT t.tint
            INTO v_free
            FROM generate_series(1, 6) AS t(tint)
           WHERE NOT (t.tint = ANY(v_taken))
           ORDER BY t.tint
           LIMIT 1;

          IF v_free IS NOT NULL THEN
            UPDATE agents SET avatar_tint = v_free WHERE id = r.id;
            v_taken := v_taken || v_free;
          END IF;
        ELSE
          v_taken := v_taken || r.avatar_tint;
        END IF;
      END LOOP;
    END;
    $$
  `)
}

/**
 * Structural down (#1139): restores 121's shape — the two-argument held
 * predicate, the inheritance trigger and its function — and drops the
 * one-argument predicate this migration added. The backfill is data, not
 * structure, and is not reverted.
 */
export async function down(client: PoolClient): Promise<void> {
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

  await client.query(`DROP FUNCTION IF EXISTS agent_holds_avatar_tint(TIMESTAMPTZ)`)
}
