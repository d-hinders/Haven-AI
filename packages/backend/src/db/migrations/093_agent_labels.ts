import type { PoolClient } from 'pg'

/**
 * 093 — agent labels (#3167): free-form tags on agents, editable afterwards,
 * many per agent, ad-hoc. The companion of organizations (#3164): an
 * organization is one structural folder per agent; a label is a flat
 * categorization ("prod", "experimental", "finance") and an agent carries as
 * many as the user wants. The #3165 filter facet wires into the read surface
 * this migration enables; nothing here builds the facet itself.
 *
 * ## Two tables, both per-user scoped
 *
 * `agent_labels` is the tag vocabulary — one row per label the user has
 * created. The unique constraint is on `(user_id, lower(name))`, NOT on the
 * raw name: "prod" and "Prod" are one label. Postgres enforces it at write
 * time, so the one-name rule is a property of the schema rather than of every
 * writer remembering to lowercase; the API normalizes on insert anyway, so a
 * caller never sees the constraint fire. Names are capped at 64 characters —
 * longer strings are UI noise, not categories, and the cap keeps a pasted
 * paragraph from becoming a chip that cannot render.
 *
 * `agent_label_assignments` is the join: one row per (agent, label). Its
 * primary key IS the pair, so an agent cannot be double-tagged with the same
 * label even by a racing request. CASCADE runs in BOTH directions on purpose:
 *
 * - deleting a LABEL removes its assignments — the issue's own acceptance
 *   criterion, "deleting a label never deletes or alters agents". The agents
 *   rows are untouched; only the join rows go.
 * - deleting an AGENT removes its assignments. A label is user-scoped, an
 *   assignment is agent-scoped, and an orphaned assignment would be a row
 *   pointing at an agent no list can render.
 *
 * `ON DELETE CASCADE` on agent_id is deliberately NOT the audit-trail posture
 * `payment_refusals` chose (#2945): refusal rows are money-path telemetry and
 * outlive the account; a label assignment is display state with no existence
 * apart from the pair it names.
 *
 * ## The boundary this schema draws — and the one it must not cross
 *
 * Labels are DISPLAY/CATEGORIZATION ONLY. Nothing in the delegation, budget,
 * or on-chain enforcement path may read these tables — no query that decides
 * what an agent may spend may join them, now or later. The tables live beside
 * the money-path tables but carry no authority semantics: no amount, no
 * caveat, no delegation reference. If a future diff reads `agent_labels`
 * from `rails/` or the payment pre-checks, that is the design violation the
 * issue names, not an extension of it.
 */
export const version = '093_agent_labels'

export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS agent_labels (
      id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name       VARCHAR(64) NOT NULL
        CONSTRAINT agent_labels_name_nonblank CHECK (length(btrim(name)) > 0),
      color      VARCHAR(20) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `)
  // The one-name-per-user rule fires on the LOWERCASED name — "prod" and
  // "Prod" collide. A table-level UNIQUE constraint cannot carry an
  // expression, so this is a unique INDEX (same enforcement, same 23505).
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS agent_labels_user_lower_name_unique
      ON agent_labels (user_id, lower(name))
  `)
  await client.query(`
    CREATE TABLE IF NOT EXISTS agent_label_assignments (
      agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      label_id UUID NOT NULL REFERENCES agent_labels(id) ON DELETE CASCADE,
      PRIMARY KEY (agent_id, label_id)
    )
  `)
  await client.query(`
    CREATE INDEX IF NOT EXISTS agent_label_assignments_label_id_idx
      ON agent_label_assignments (label_id)
  `)
}

/**
 * Structural down (#1139): drops exactly what this migration created. The
 * assignment table goes first only for readability — CASCADE from
 * `agent_labels` would empty it anyway. Both statements are plain drops:
 * neither table ever carried rows the user cannot recreate.
 */
export async function down(client: PoolClient): Promise<void> {
  await client.query(`DROP TABLE IF EXISTS agent_label_assignments`)
  await client.query(`DROP TABLE IF EXISTS agent_labels`)
  await client.query(`DROP INDEX IF EXISTS agent_labels_user_lower_name_unique`)
}
