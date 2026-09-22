import type { PoolClient } from 'pg'

/**
 * 094 — agent organizations (#3164): a per-user tree for filing agents.
 *
 * The companion of labels (093): a label is a flat tag an agent carries any
 * number of; an organization is ONE structural place per agent, nested.
 * `parent_organization_id = NULL` is a root (the issue's "Company A");
 * non-null nests under another of the SAME user's organizations, unlimited
 * depth, multiple roots allowed.
 *
 * ## The shape of the tree
 *
 * `parent_organization_id` is a self-reference with `ON DELETE RESTRICT`: the
 * database refuses to delete an organization that still has children EXCEPT
 * through the promote path below, which repoints the children first and only
 * then deletes. `agents.organization_id` is `ON DELETE SET NULL` — a backstop
 * that must never be the thing that runs (the delete path promotes member
 * agents to the deleted folder's parent first, "never orphans anything");
 * if raw SQL ever deletes an organization directly, an agent demotes to the
 * top level rather than dangling.
 *
 * Sibling names are unique per user, case-insensitively ("Tech Agents" twice
 * under the same parent is one mistake, not two folders). The unique INDEX
 * (not a table constraint — the expression needs the function) keys on
 * `COALESCE(parent_organization_id, uuid_zero)`: a plain three-column index
 * would treat NULL parents as mutually distinct and allow two roots with the
 * same name, which the folder UI cannot disambiguate. The all-zero UUID is a
 * sentinel no real row can hold (gen_random_uuid() output space), so roots
 * collide with roots exactly as siblings collide with siblings.
 *
 * A direct self-parent is refused by CHECK; longer cycles (A→B→A) cannot be
 * expressed as a CHECK — the move path walks the ancestor chain inside its
 * transaction and refuses a cycle before writing (repositories/agent-
 * organizations.ts). Every write goes through that module; the schema guards
 * what one row can say, the module guards what the graph can become.
 *
 * ## The boundary this schema draws — and the one it must not cross
 *
 * Organizations are DISPLAY/CATEGORIZATION ONLY, exactly like agent labels
 * (093). Nothing in the delegation, budget, or on-chain enforcement path may
 * read these tables or `agents.organization_id` — no query that decides what
 * an agent may spend may join them, now or later. There is no amount, no
 * caveat, no delegation reference here; if a future diff reads
 * `agent_organizations` from `rails/` or the payment pre-checks, that is the
 * design violation the issue names, not an extension of it.
 */
export const version = '094_agent_organizations'

export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS agent_organizations (
      id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id                UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      parent_organization_id UUID REFERENCES agent_organizations(id) ON DELETE RESTRICT,
      name                   VARCHAR(64) NOT NULL
        CONSTRAINT agent_organizations_name_nonblank CHECK (length(btrim(name)) > 0),
      created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
      -- One-row cycle stop: the deep cycles are refused by the move path.
      CONSTRAINT agent_organizations_no_self_parent
        CHECK (parent_organization_id IS NULL OR parent_organization_id <> id)
    )
  `)
  // Sibling names unique per user on the LOWERCASED name, roots included via
  // the sentinel. Same enforcement posture as 093's lower(name) index: the
  // rule is a property of the schema, not of every writer remembering.
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS agent_organizations_user_parent_lower_name_unique
      ON agent_organizations (user_id, COALESCE(parent_organization_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name))
  `)
  // Filing placement on the agent. SET NULL is the raw-SQL backstop only —
  // the service's delete promotes members first (see header).
  await client.query(`
    ALTER TABLE agents
      ADD COLUMN IF NOT EXISTS organization_id UUID
        REFERENCES agent_organizations(id) ON DELETE SET NULL
  `)
  await client.query(`
    CREATE INDEX IF NOT EXISTS agents_organization_id_idx
      ON agents (organization_id)
  `)
}

/**
 * Structural down (#1139): drops exactly what this migration created, agents
 * column first (the FK points at the table). Both statements are plain drops:
 * the column carries placement only and the table carries the folders, all of
 * which a re-run recreates empty.
 */
export async function down(client: PoolClient): Promise<void> {
  await client.query(`DROP INDEX IF EXISTS agents_organization_id_idx`)
  await client.query(`ALTER TABLE agents DROP COLUMN IF EXISTS organization_id`)
  await client.query(`DROP INDEX IF EXISTS agent_organizations_user_parent_lower_name_unique`)
  await client.query(`DROP TABLE IF EXISTS agent_organizations`)
}
