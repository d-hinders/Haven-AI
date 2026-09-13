import type { PoolClient } from 'pg'

export const version = '086_payment_refusals'

/**
 * `payment_refusals` — the analytics ledger of what the guardrails refused
 * (#2945, slice A of epic #2944). Until now a refused payment left no trace:
 * the budget pre-checks return their 403 before writing anything, and an
 * over-budget or expired redemption that reverts in `prepareRedemption`'s gas
 * estimation surfaces as a bare 502 with no row. This table records those
 * refusals so the analytics page can show what the guardrails caught.
 *
 * ## Why a ledger, and why it is fire-and-forget
 *
 * The guardrails are the caveat enforcers on-chain and the fail-fast
 * pre-checks in front of them; this table is only a RECORD of their answers.
 * The writer (`infra/repositories/payment-refusals.ts` via
 * `modules/payments/refusal-ledger.ts`) runs after the refusal is decided and
 * never changes it: a failing ledger write is logged and swallowed, because
 * telemetry must not be able to alter a refusal the caller already received.
 *
 * ## Closed `reason` enum — each value with a named writer
 *
 * - `delegation_budget_exceeded` — the fail-fast remaining-budget pre-check on
 *   BOTH x402 legs (erc7710 and the EIP-3009 funding shape) and the
 *   `POST /payments` prepare path.
 * - `no_delegation_for_target` — the "no active budget delegation for this
 *   token/merchant" 403, which is how a recipient pin refuses on this rail
 *   (not distinguishable from no-delegation, so it is named for what it is).
 * - `delegation_expired` — the timestamp-caveat revert detected at gas
 *   estimation (the classification in `modules/payments/refusal-ledger.ts`).
 * - `relayer_budget` — the sign-route `RelayerBudgetExceededError` refusal
 *   before broadcast.
 * - `onchain_revert` — any other gas-estimation revert. Rare since #2706:
 *   the pre-checks catch over-budget on both legs first.
 *
 * `recipient_not_allowed` was deliberately DROPPED from the enum: no writer
 * emits it on this rail (the recipient pin refuses as
 * `no_delegation_for_target`), and an enum value with no writer is a lie the
 * CHECK would enforce forever.
 *
 * ## The boundary this table does NOT record
 *
 * The hosted MCP's `PRICE_EXCEEDS_MAX` cap refusal (`cap-price.ts`) happens
 * in the agent's runtime BEFORE any backend call and is the user's own
 * instruction — it is not in this ledger. A `POST /machine-payments/refusals`
 * report from the hosted MCP is a possible follow-up and is not filed.
 *
 * ## `detail` is a JSONB ALLOWLIST, not a denylist
 *
 * Only `error_code`, `phase`, `next_action`, `remaining_atomic` and
 * `budget_atomic` may be copied from a refusal body — nothing else. The
 * #2907/#2908 review found `components.account` vs `payer_account`
 * confusions exactly where bodies were copied whole; the CHECK below (plus
 * the writer's own pick) makes a whole-body copy structurally impossible
 * rather than a convention that can decay. `amount` is NOT in the allowlist
 * on purpose: `amount_atomic` already carries it, and a second spelling is
 * the drift the allowlist exists to stop.
 *
 * The check deletes every ALLOWED key from a copy of `detail` (`jsonb -
 * text[]`, a pure builtin — CHECK constraints cannot contain subqueries) and
 * requires the remainder to be empty, so an extra key is a constraint
 * violation at write time, not a convention.
 *
 * ## Growth bound, booked here as a constraint story
 *
 * A refused attempt costs the caller nothing, so a retry loop against
 * `POST /x402/authorize` would write one row per attempt. The dedupe
 * (60-second window on `(agent_id, reason, resource_url)`) is enforced by
 * the repository's upsert — see `recordPaymentRefusal` — and `attempts`
 * counts the folded attempts. There is no retention: rows are small and are
 * the audit trail the CASP guardrails doc cares about.
 */
export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS payment_refusals (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      account_id    UUID,
      agent_id      UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      chain_id      INTEGER NOT NULL,
      token_symbol  VARCHAR(20) NOT NULL,
      amount_atomic VARCHAR(78) NOT NULL,
      usd_value     NUMERIC(20,6),
      eur_value     NUMERIC(20,6),
      merchant_to   VARCHAR(42),
      resource_url  TEXT,
      reason        TEXT NOT NULL
        CONSTRAINT payment_refusals_reason_check
        CHECK (reason IN (
          'delegation_budget_exceeded',
          'no_delegation_for_target',
          'delegation_expired',
          'relayer_budget',
          'onchain_revert'
        )),
      source        TEXT NOT NULL
        CONSTRAINT payment_refusals_source_check
        CHECK (source IN ('x402_authorize', 'payment', 'redeem')),
      detail        JSONB
        CONSTRAINT payment_refusals_detail_allowlist_check
        CHECK (detail IS NULL OR (
          detail - ARRAY[
            'error_code', 'phase', 'next_action', 'remaining_atomic', 'budget_atomic'
          ]::text[]
        ) = '{}'::jsonb),
      attempts      INTEGER NOT NULL DEFAULT 1
        CONSTRAINT payment_refusals_attempts_positive_check
        CHECK (attempts >= 1),
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    ALTER TABLE payment_refusals
      ADD CONSTRAINT payment_refusals_account_id_fkey
      FOREIGN KEY (account_id) REFERENCES smart_accounts(id);

    CREATE INDEX IF NOT EXISTS idx_payment_refusals_user_created
      ON payment_refusals (user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_payment_refusals_agent_created
      ON payment_refusals (agent_id, created_at);
    -- The dedupe lookup of recordPaymentRefusal: equality on the reason and
    -- the nullable resource_url, recency on created_at.
    CREATE INDEX IF NOT EXISTS idx_payment_refusals_dedupe
      ON payment_refusals (agent_id, reason, resource_url, created_at);
  `)
}

export async function down(client: PoolClient): Promise<void> {
  await client.query(`
    DROP TABLE IF EXISTS payment_refusals;
  `)
}
