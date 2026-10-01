---
owner: "@d-hinders"
status: current
covers:
  - packages/backend/src/infra/ops-readonly-role.ts
  - packages/backend/scripts/ops-readonly-role.ts
  - packages/backend/src/infra/repositories/ops-read-role.ts
  - packages/backend/src/db/ops-read-pool.ts
  - packages/backend/src/config/ops.ts
last-verified: "2026-10-01"
---

# Ops console read-only database role

The ops console (epic #3507) reads customer data through its own Postgres
login, `OPS_DATABASE_URL`, never the backend's `DATABASE_URL`. That login is
the read-only role from #3510:

- It can `SELECT` a positive allowlist of columns, granted column by column.
- It cannot write or create objects.
- It runs `default_transaction_read_only`, with a 5 s statement timeout and
  `CONNECTION LIMIT 5`.

What it may read, and the columns it never may, is
`packages/backend/src/infra/ops-readonly-role.ts`. That file is the single
source; this page is only the operator steps. The full ops-console runbook,
`docs/operations/ops-console.md`, lands with #3517 and links here.

Without `OPS_DATABASE_URL` the console's data routes answer 404, and there is
no fallback to the main login.

## Set it up (once per environment)

Run every SQL step as the database owner, for example the Railway `postgres`
user in Railway → Postgres → Query.

1. **Print the role script.** Run it with `-s`, otherwise npm's `> …` banner
   lands in the output and the output is no longer pure SQL:

   ```bash
   npm run -s ops:readonly-role-sql -w packages/backend > ops-role.sql
   ```

   Flags: `--role <name>` (default `haven_ops_readonly`) and `--schema <name>`
   (default `public`).
2. **Run `ops-role.sql`.** It runs in one transaction. It creates the role
   `NOLOGIN` if it is missing, revokes everything, then grants exactly the
   allowlist. It refuses, and grants nothing, in two cases:
   - **"still holds an unredacted vendor secret":** a granted free-text column
     (`OPS_FREE_TEXT_COLUMNS`) has an old row that predates the redaction at
     its writer. Scrub it (below), then re-run.
   - **"can still CREATE in schema":** PUBLIC holds `CREATE` on the schema.
     This is the default before Postgres 15, and survives a `pg_upgrade`. Run
     `REVOKE CREATE ON SCHEMA public FROM PUBLIC;` (the backend's own user
     owns the schema, so it keeps `CREATE`), then re-run.
3. **Give the role a login.** The password goes to the secret store, never
   to the repo:

   ```sql
   ALTER ROLE haven_ops_readonly LOGIN PASSWORD '<openssl rand -base64 32>';
   ```

4. **Set `OPS_DATABASE_URL`** on the backend service to
   `postgres://haven_ops_readonly:<password>@<private host>:5432/<db>`. Use
   the same private-network host as `DATABASE_URL`, not the public proxy.
5. **Redeploy and check.** The boot refuses an `OPS_DATABASE_URL` that names
   no user or the same user as `DATABASE_URL`.

   Before its first read, the pool also asks the database what the login can
   do. If the login can do any of the following, the ops data routes (today
   `POST /ops/reveal`) answer 404 and the log says `Ops console data reads are OFF: …`:
   - read `users.password_hash` or `payment_intents.signature`;
   - write `users`;
   - create in its schema;
   - run outside a read-only transaction.

## Scrub old secrets (only when step 2 refuses)

```bash
npm run -s ops:readonly-role-sql -w packages/backend -- --scrub > ops-scrub.sql
```

The scrub rewrites each granted free-text column exactly as the writer's
`redactVendorSecrets` would, and only on rows where a secret is still
present:

| Column | What the write does |
|---|---|
| `payment_intents.error_message` | Rewritten as `redactVendorSecrets` would; nothing else changes |
| `outbound_txs.error` | Same |
| `agent_passports.last_error` | Same |
| `agent_passports.revocation_last_error` | Same |

It is one transaction and idempotent. No status, amount or other column
changes. The real-DB parity test pins the regexes to the JavaScript helper.

Run `ops-scrub.sql`, then run `ops-role.sql` again.

## Keep it current

- **After any migration that adds a column or table the console should
  read:** add the column to `OPS_READONLY_GRANTS` in a PR, then re-run
  step 2 on each environment. Until then the new column is simply
  unreadable, and nothing flags it. The exception is `outbound_txs`: its
  `SELECT *` query test goes red.
- **The scrub and the role script are both safe to re-run.**
- **Connection budget.** Each backend process holds at most 2 connections on
  this login (`OPS_READ_POOL_MAX`). Two replicas plus one console session fit
  the limit of 5. A third replica needs the limit raised in
  `OPS_READONLY_CONNECTION_LIMIT` and the script re-run.

## Residual risk: customer-supplied text

Some granted columns hold text the agent or merchant supplied, which no
regex covers:

- `payment_intents.machine_metadata`
- `x402_resource_url` and `payment_resource_url`
- `payment_refusals.resource_url`

A merchant URL can embed a customer's own key in its query string. These
columns are granted because the console needs them (#3510 sanctions
`machine_metadata`). They are customer data: the pages that show them
(#3512, #3516) have to treat them that way.
