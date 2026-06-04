import type { PoolClient } from 'pg'

export const version = '018_machine_payment_approval_evidence_refs'

export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE machine_payment_evidence
      ALTER COLUMN payment_intent_id DROP NOT NULL,
      ADD COLUMN IF NOT EXISTS approval_request_id UUID REFERENCES approval_requests(id) ON DELETE CASCADE;

    CREATE UNIQUE INDEX IF NOT EXISTS idx_machine_payment_evidence_approval_request
      ON machine_payment_evidence(approval_request_id)
      WHERE approval_request_id IS NOT NULL;

    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'machine_payment_evidence_one_payment_reference'
      ) THEN
        ALTER TABLE machine_payment_evidence
          ADD CONSTRAINT machine_payment_evidence_one_payment_reference
          CHECK (
            (CASE WHEN payment_intent_id IS NULL THEN 0 ELSE 1 END) +
            (CASE WHEN approval_request_id IS NULL THEN 0 ELSE 1 END) = 1
          );
      END IF;
    END
    $$;

    ALTER TABLE machine_payment_reconciliation_events
      ADD COLUMN IF NOT EXISTS approval_request_id UUID REFERENCES approval_requests(id) ON DELETE SET NULL;

    CREATE UNIQUE INDEX IF NOT EXISTS idx_machine_payment_reconciliation_approval_event
      ON machine_payment_reconciliation_events(approval_request_id, event_type)
      WHERE approval_request_id IS NOT NULL;
  `)
}
