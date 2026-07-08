import type { PoolClient } from 'pg'

export const version = '040_recipient_case_normalization'

/**
 * Case-insensitive uniqueness for agent_recipients (#815).
 *
 * Found live during the #805 matrix setup: the pre-#798 SQL path inserted a
 * mixed-case token_address while the #796 CRUD lowercases — the UNIQUE key is
 * case-sensitive, so the same (agent, token, recipient) existed twice. The
 * read side matches with LOWER(), so both rows came back as duplicate
 * policies (post-#813 both compute the SAME session, so an enableSessions
 * batch would carry duplicate ids).
 *
 * Fix: dedupe (keep the newest row per lowered key), normalize everything to
 * lowercase, and add a CHECK so a mixed-case insert fails loudly instead of
 * silently duplicating. The CRUD already lowercases on write, so the CHECK
 * only bites raw-SQL paths — which is exactly the seam that caused this.
 */
export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    DELETE FROM agent_recipients a
    USING agent_recipients b
    WHERE a.agent_id = b.agent_id
      AND LOWER(a.token_address) = LOWER(b.token_address)
      AND LOWER(a.recipient_address) = LOWER(b.recipient_address)
      AND a.id <> b.id
      AND (a.created_at < b.created_at
           OR (a.created_at = b.created_at AND a.id < b.id));

    UPDATE agent_recipients
    SET token_address = LOWER(token_address),
        recipient_address = LOWER(recipient_address)
    WHERE token_address <> LOWER(token_address)
       OR recipient_address <> LOWER(recipient_address);

    ALTER TABLE agent_recipients
      ADD CONSTRAINT agent_recipients_lowercase_chk
      CHECK (token_address = LOWER(token_address)
             AND recipient_address = LOWER(recipient_address));
  `)
}
