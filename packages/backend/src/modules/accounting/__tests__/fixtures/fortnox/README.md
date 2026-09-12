# Recorded Fortnox HTTP fixtures (#2862)

Response bodies as the Fortnox v3 API returns them, in the shapes the #494
sandbox spike (2026-07-16, `docs/research/fortnox-non-asserting-feed.md`)
and the #1362 read-back recorded. Identifiers are sandbox values, not a
customer's. Served by `fortnox-connector.conformance.test.ts`'s fetch router
by method + path; the router adds the per-case state (booked, deleted).

| file | request |
|---|---|
| `token.json` | `POST oauth-v1/token` — echoes the full `FORTNOX_SCOPE`; a narrower echo makes the callback record `scope_missing` (#2865), which `scope-missing.db.test.ts` drives with its own router |
| `companyinformation.json` | `GET /3/companyinformation` |
| `suppliers-search-empty.json` | `GET /3/suppliers?name=…` (no match) |
| `supplier-created.json` | `POST /3/suppliers` |
| `supplierinvoice-created.json` | `POST /3/supplierinvoices` |
| `inbox-upload.json` | `POST /3/inbox` |
| `fileconnection-created.json` | `POST /3/supplierinvoicefileconnections` |
| `fileconnection-scope-error.json` | the same, HTTP 400 — grant lacks `connectfile` (error 2000663) |
| `supplierinvoice-get.json` | `GET /3/supplierinvoices/{n}`, unbooked |
| `supplierinvoice-get-booked.json` | the same after a human booked it |
| `error-404.json` | any 404 |
