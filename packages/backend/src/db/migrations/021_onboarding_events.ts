import type { PoolClient } from 'pg'

export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE onboarding_events (
      id          TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::text,
      user_id     TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      event       TEXT        NOT NULL CHECK (event IN (
                                'signed_up',
                                'safe_deployed',
                                'safe_imported',
                                'agent_created',
                                'allowance_granted',
                                'safe_funded',
                                'first_payment_settled'
                              )),
      metadata    JSONB,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  await client.query(
    `CREATE INDEX onboarding_events_user_id ON onboarding_events (user_id)`,
  )
  await client.query(
    `CREATE INDEX onboarding_events_event_created ON onboarding_events (event, created_at)`,
  )

  // Deduplicate one-time events so fire-and-forget inserts are safe
  await client.query(`
    CREATE UNIQUE INDEX onboarding_events_user_once
      ON onboarding_events (user_id, event)
      WHERE event IN ('signed_up', 'safe_funded', 'first_payment_settled')
  `)
}

export async function down(client: PoolClient): Promise<void> {
  await client.query('DROP TABLE IF EXISTS onboarding_events')
}
