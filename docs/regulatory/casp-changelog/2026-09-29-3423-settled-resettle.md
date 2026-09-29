- **#3423 slice B** — a repeated settle of an erc7710 payment that already
  settled is answered as settled. `POST /x402/:id/settle`
  (`packages/backend/src/modules/x402/settle.ts`) used to answer an untyped
  409 "Payment is confirmed, expected pending_signature", and the hosted MCP
  relayed that as `API_ERROR`. It now answers a typed 409
  `payment_already_settled` carrying `payment_id` and `tx_hash`
  (`FIND_SETTLE_INTENT_SQL` in `infra/repositories/x402-authorizations.ts`
  now selects `tx_hash`), but only for a row whose recorded
  `machine_metadata.settlement_scheme` is `erc7710`. An EIP-3009 funding row,
  whose `tx_hash` proves only that the delegate was funded, and a `submitted`
  row keep the plain 409. The SDK's `submit()`
  (`packages/sdk/src/x402-erc7710.ts`) maps the typed 409 to
  `X402Erc7710AlreadySettledError`, the class #3417 introduced. The hosted
  `haven_settle_mcp_tool` erc7710 branch
  (`packages/mcp-server/src/tools/paid-mcp-completion.ts`) returns the #3417
  done state (`settled: true`, `settlement_tx_hash`, no next tool), with a
  reason worded for a repeated settle, and does not call the merchant again.
  **No custody or authority change:** the new branch returns before any
  signing, merchant or chain step, and nothing is written; the real-DB test
  compares the whole row before and after. No key, signature, delegation,
  caveat, budget or recipient pin changes, and the answer only reports a
  settlement the backend already recorded for that payment. Mutation-tested:
  removing the backend branch fails the settled test; dropping the scheme
  check fails the EIP-3009 test; dropping `tx_hash` from the SQL fails two;
  an SDK `submit()` that does not map fails the SDK test and the hosted
  settle test; removing the hosted catch fails the hosted settle test.
  Perimeter unchanged.
