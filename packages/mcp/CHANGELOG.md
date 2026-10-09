# @haven_ai/mcp

Release headers are written by the release bump (`npm run release:bump`), never by
hand — true since the changelog-heading gap, and stated here only because it was asserted for a long
time while being false. The bump rewrites the `## Unreleased` heading below into
`## <version> — <date>`; add entries under `## Unreleased` and leave the heading
alone.

Mark a bullet `**Update required**` when a client must update to keep paying.
The bump then flags that release `action_required` in the public release data
(`/releases`, `GET /discovery`, `/.well-known/haven.json`; #3305). It is not
`**BREAKING**`, which means updating may break you, not that you must update.
Write it exactly: "update required" in any other form (including "no update
required") is refused — reword to "no update needed", or quote it in a code span.

## Unreleased

### Changed

- **An out-of-gas `MERCHANT_NOT_READY` refusal names the operator top-up (#3834).** When the merchant refuses with `reason_code: settlement_wallet_out_of_gas`, the local runtime's message now gives `fail_floor` beside `settlements_remaining` and says the merchant's operator must top up its settlement wallet, so retrying before then is refused again. It no longer says "Retry after approximately 60s". Every other reason code keeps its wording; `retry_with_new_quote` stays `true`. Same sentence as the hosted runtime.

## 0.9.0-alpha.0 — 2026-10-09

### Changed

- **The local x402 tools report the merchant's EIP-3009 settlement hash (#3764, reaches stdio only after the next release).** `haven_pay_x402`, `haven_pay_x402_quote`, `haven_resume_x402_payment` and `haven_pay_mcp_tool` now post the merchant's own settlement transaction — parsed from the paid answer's `PAYMENT-RESPONSE` (or `_meta`) — as a second evidence report right after the funding one, so the receipt shows the transaction the merchant shows. One attempt, no backoff, and it can never change the tool's own answer: a missing, malformed, zero, or funding-equal hash posts nothing. Hosted delivery picks this up on deploy; stdio serves it once `@haven_ai/mcp` pins the SDK release that carries it (see `docs/operations/mcp-runtime-compatibility.md`).

- **A funding-first `PREPARE_REVERTED` failure (#3731, hosted behaviour — reaches stdio only after the next release).** When a prepare revert was the token's own insufficient-balance error, the hosted failure now carries `revert_cause: "insufficient_balance"` and answers `next_action: fund_account_or_raise_allowance` with a funding-specific reason — the account needs funds, not a caveat change; the revert already proves the shortfall, so no check tool is named. Any other revert keeps today's caveat text and stop step, and the refusal ledger is unchanged (still `onchain_revert`). The hosted runtime picks the backend change up on deploy; stdio serves it once `@haven_ai/mcp` pins the SDK release that carries it (see `docs/operations/mcp-runtime-compatibility.md`).

### Added

- **`haven_get_receipt { payment_id }` returns the signed receipt bundle (#3723).** No MCP tool returned the signed bundle `haven_verify_receipt` checks, so an agent that wanted it had to call the REST API with the key from its credential file by hand (field evidence 2026-10-07). The new read tool answers `{ receipt }` — the signed `haven-receipt-1` bundle only, from this agent's own **settled** payments: an unknown id, another agent's id or an unsettled payment is a structured 404, and the endpoint's server-side `verification` is deliberately not returned (it is computed on Haven's server, not offline — `haven_verify_receipt` reads the bundle unchanged). The tool list change re-consents: this runtime hashes its registered tool names, so installed clients ask for consent once after updating, and the exported `HavenMcpToolName` union grows (a source break for exhaustive `switch`/`Record` consumers).

### Fixed

- **`haven_verify_receipt` accepts the receipt endpoint's wrapped response as-is (#3723).** `GET /payments/{id}/receipt` returns `{ receipt, verification }`, but passing that response unchanged as the `receipt` argument answered `not_a_signed_receipt` — the verifier looked for `authorization` at the top level. The bundle inside is now verified when the top level carries no `authorization` (one level only, no recursion; the wrapper's `verification` is never read — it is Haven's own self-check, not offline evidence). The spread form (`{ receipt, verification }` as top-level arguments) also verifies: `verification` is an accepted-and-ignored argument. A `haven_list_receipts` row still answers `not_a_signed_receipt`, bare or wrapped.

## 0.8.1-alpha.0 — 2026-10-07

## 0.8.0-alpha.0 — 2026-10-05

- **`haven_get_task_budget` reads one task budget by id, whatever its status (#3518).** `haven_get_agent` lists only live task budgets (closing, plus unexpired pending and open), each with its `status` and `isExpired`; closed and expired ones are read with the new tool. `haven_get_allowances` rows carry each budget's scope (`recipientAddress`, `merchantId`, `delegationHash`, `reservedHavenAtomic`). A new tool name changes this runtime's tool list, so a client that pins tool consent will ask once after updating. No update needed.

- **`haven_submit` accepts `sub_budget_id`, and `haven_get_agent` lists pending sub-budget signatures (#3506).** The signer's `haven_sign { sub_budget_id }` step hands off to `haven_submit { sub_budget_id, signature }`. This runtime used to refuse that, so a sub-budget could not be completed by the agent. `haven_submit` now takes exactly one of `payment_id`, `task_budget_id` or `sub_budget_id` (plus `signature`) and refuses zero or several before contacting anything. An opened sub-budget row whose sibling is still pending names `haven_sign` for the sibling. `haven_get_agent` grew `pendingSubBudgetSignatures[]` (additive): each row this agent must sign, with its `haven_sign` step. A stale sub-budget close (`close_needs_reprepare`) is recovered inside `haven_submit`, which re-prepares the close and names `haven_sign` for the fresh operation (or reports `closed`); an unconfirmed one (`close_outcome_unconfirmed`) asks to repeat the same `haven_submit` later. No tool added, removed or renamed: no agent-side close tool is needed.

- **`haven_pay_x402`'s paid retry carries the buyer tax declaration (#3427).** The local MCP reaches the merchant through the SDK's `fetch`, `payX402Quote` and `resumeX402Payment` paths, so when the owner opted the agent in (#3426) the paid EIP-3009 retry now also carries `X-Tax-Declaration: <base64url(JSON)>` — signed locally by the agent's own delegate key (wg-tax #5 §2.2), sent to the seller only, and omitted on the erc7710 scheme, the first unpaid request, a "not available" content answer, or a 404 from the content endpoint (older backend). Tool descriptions for `haven_pay_x402` and `haven_resume_x402_payment` document the new header. No update needed otherwise: without the opt-in the wire is unchanged.

## 0.7.0-alpha.0 — 2026-09-29

### Added

- **`haven_list_receipts` accepts `compact: true` (#3423).** Each row then leaves out `challengePayload`, `selectedPayment` and `protocolReceiptPayload`, the merchant's payload echoes. Omit it for the unchanged default shape. The hosted runtime accepts the same key.

- **`sub_budget_id` on `haven_send`, `haven_pay_x402_quote` and `haven_pay_x402` (#3330).** A sub-agent pays under a sub-budget another agent granted it. The argument is mutually exclusive with `task_budget_id`. Additive and optional.

- **Task-budget handoffs carry the old-signer recovery notice (#3419).** `haven_open_task_budget` and `haven_close_task_budget` results that hand off to `haven_sign { task_budget_id }` now carry `signer_compatibility` with `task_sign_context_version`, `min_signer_version` (`0.6.0-alpha.0`, the first signer with the `task_budget_id` form), and the recovery route as prose (`check`) and data (`fallback`): if `haven_sign` answers `SIGNING_ERROR` with a message starting "Pass payment_id (preferred for delegation-rail x402", the signer predates task budgets and signed nothing — close the pending budget with `haven_close_task_budget`, update via the connector doctor and its repair line, then reopen. There is no relay fallback for this signing context.

### Removed

- **BREAKING (#3411) — the legacy `idempotencyKey` argument spelling is refused, not accepted.** The #2366 deprecation window is closed: it was met when the warning first shipped on the `alpha`/`latest` channel in `0.1.35-alpha.0` (2026-09-07), several releases behind `latest`. `haven_send`, `haven_pay_mcp_tool`, `haven_quote_x402`, `haven_pay_x402_quote` and `haven_pay_x402` still **declare** `idempotencyKey` in their schema (so the MCP SDK's default `z.object` strip mode cannot silently drop it before the handler runs — the #2348 double-spend this refusal exists to prevent), but any call that sets it now fails with `IDEMPOTENCY_KEY_RENAMED` before anything is contacted or spent, whether or not `idempotency_key` was also sent. Send `idempotency_key`. The public `toolSchemas` export changes meaning: `idempotencyKey` on it is no longer an accepted input, only a refused one.

### Fixed

- **`haven_verify_receipt` no longer throws on a `haven_list_receipts` row (#3418).** The two receipt tools now work together: passing a history row — which carries no signature — returns `{ verified: false, reason: 'not_a_signed_receipt' }` instead of `UNKNOWN_ERROR` with a raw `TypeError`. The tool takes the signed receipt bundle from `GET /payments/:id/receipt`; on erc7710 payments it now verifies (`verifiedOver: 'delegation_digest'`) where it previously reported `signer_mismatch` for genuine payments, and a direct or eip3009 bundle returns `not_verifiable_offline`. `verified: true` means only that the agent delegate signed the hash named by `verifiedOver` — the payment block is Haven-asserted and settlement is not proven; check `settlementTxHash` on an explorer.

- The first-launch consent screen printed the agent's budget in atomic units
  labelled as whole tokens (`up to 1000000 USDC` for a 1 USDC/day agent).
  Budgets now render in whole tokens through the SDK token registry, and carry
  an explicit `(atomic units)` label when the token's decimals cannot be
  resolved. Display only: the consent hash still covers the atomic string, so
  no installed sidecar acknowledgement is invalidated. (#3410)
  Known limitation: the setup-time budget in the credential file is a
  snapshot. If the wallet owner edits the budget after setup and the live
  read then fails, the screen shows the old budget as current. (#3410)

## 0.6.0-alpha.0 — 2026-09-26

### Removed

- **BREAKING (#3306, via `@haven_ai/sdk`) — `haven_list_receipts` rows lose four keys.** `rail`, `proofStatus`, `resourceUrl` and `merchantAddress`, the deprecated twins kept for one full release since `0.5.0-alpha.0` (#3134), are no longer emitted; read `source`, `paymentProofStatus`, `x402ResourceUrl` and `x402MerchantAddress`. This is a tool-output re-shape, breaking for any agent or script still reading an old key, so the release carrying it takes a **MINOR** bump under the 0.x convention (`docs/operations/mcp-runtime-compatibility.md`). A `.d.ts` diff of this package shows nothing — the break is in tool output, which no declaration file carries. No tool, argument, schema or description changed **by this bullet's change alone** — see the task-budget tool additions below for what else this release carries; the hosted runtime drops the keys with its deploy.

### Added

- **Task budgets: three new tools (#3329).** `haven_open_task_budget` and `haven_close_task_budget` reserve and end a short-lived, self-delegated child of the agent's own budget delegation, scoped to one task; `haven_submit` is new on this runtime and relays the local signer's signature for a task budget by `task_budget_id` only — a `payment_id` is refused here, because this runtime signs and submits a payment inline and has no relay step for it. `task_budget_id` is an optional argument on `haven_send`, `haven_pay_x402_quote` and `haven_pay_x402` (`haven_pay_x402_quote` dropped it on the `dev` channel until #3378). A task budget pinned to a recipient is checked against where each payment first goes, and the x402 tools here first fund the agent's own wallet, so a merchant-pinned task budget is declined on them — `haven_open_task_budget`'s description says so. The exported `HavenMcpToolName` union gains the three names, so a consumer with an exhaustive `switch` or a `Record<HavenMcpToolName, …>` over it must add them. The tool set grew by three, so the consent hash changes and every operator is asked to consent once more on the next launch.

### Changed

- **Behaviour change, via `@haven_ai/sdk` (#3375, epic #3284):** `haven_pay_x402`, `haven_pay_x402_quote` and `haven_pay_mcp_tool` now refuse, before anything is signed or submitted, an x402 funding leg that does not pay the quoted amount of the quoted token into this key's own delegate wallet. The backend already builds exactly that shape, so no live payment changes; the check closes a redirect a compromised Haven API could otherwise serve under an open budget. No tool, argument, schema or description changes, so the consent hash does not move. Update to get the check.

- **`haven_send` description copy (#3277, via `@haven_ai/sdk`).** The shared send description no longer claims every signer refuses a payload whose typed data does not match its hash — only a current signer does. Copy only: the consent hash covers tool names, never descriptions, so nobody is re-prompted.

## 0.5.0-alpha.1 — 2026-09-25

- **Client identity and update hint (#3303, epic #3302).** Haven API requests name `@haven_ai/mcp/<version>` in `X-Haven-Client`. When the backend sends a `client_update` hint for this runtime, the tool result carries it as `client_update`, on success and failure alike, with the exact update command. A 426 `client_outdated` refusal also keeps the backend's `next_tool_omitted_reason` at the top level of the failure. No tool, schema or consent input changes, so nobody is re-prompted.

## 0.5.0-alpha.0 — 2026-09-25

- **Consent label copy fix (#3279).** The first-launch consent screen prints `Haven wallet: <address>` instead of `Haven wallet (Safe): <address>`, and the `accountAddress` field JSDoc loses the retired rail's name. Copy only: **the consent hash is unchanged** — `computeConsentHash` covers identity, the tool set and the allowance summary, never the rendered text, so nobody is re-prompted; the label pin test is retargeted to the new wording, not removed. The spend-gate wording on the same screen ("the real spend gate — enforced by the agent's signed delegation") was already correct and stays.
- **Behaviour change, via `@haven_ai/sdk` (#3283):** `haven_send` and the x402 payment tools (`haven_pay_x402`, `haven_pay_x402_quote`, `haven_pay_mcp_tool`) now refuse, before anything is signed or submitted, a served UserOp that is not this delegate key's own direct-payment shape. So is an erc7710 settlement child that does not match the merchant's 402, is a root grant, is delegated by another account, or has no 402 expectation to check it against. Every such refusal is the SDK's `HavenTypedDataRefusedError`, code `TYPED_DATA_NOT_ALLOWED`. Separately, `haven_send` inherits #3271's direct-payment binding check: a served UserOp whose typed data does not hash to its own `payload_hash` is refused with `HavenUserOpBindingError`, code `USEROP_BINDING_MISMATCH`. No tool, argument, schema or description changed on this package.
- `haven_list_receipts` rows gain `source`, `paymentProofStatus`, `x402ResourceUrl` and `x402MerchantAddress` (#3134, via `@haven_ai/sdk`'s `mapPaymentReceipt`) beside the deprecated `rail`, `proofStatus`, `resourceUrl`, `merchantAddress`, which stay for one full release (removal condition in the SDK CHANGELOG entry). No tool, argument, schema or description changed on this package; the change is carried by the SDK dependency.

## 0.4.0-alpha.0 — 2026-09-19

- #3128: `haven_list_receipts` accepts `cursor` and returns `{ receipts, total, hasMore, nextCursor }` instead of a bare array (via the SDK's `listReceiptsPage`).

- **Failure envelope: `next_action` added, `nextAction` deprecated (#3103,
  epic #3105 decision 10).** Every `{ success: false }` result now carries
  `next_action` with the same value as `nextAction`; `nextAction` is kept for
  this release and removed in the release after the one carrying #3103 (the
  #2908 pattern). The merchant-not-ready and unknown-error refusals also carry
  `next_tool_omitted_reason`.

## 0.3.0-alpha.0 — 2026-09-17

### Removed

- **BREAKING (#2914, naming epic #2906 phase 5).** `HAVEN_WALLET_ADDRESS` and
  `HAVEN_SAFE_ADDRESS` are no longer read from the environment;
  `HAVEN_ACCOUNT_ADDRESS` is the only name. Set it before upgrading.
- `HavenCredentialFile.safeAddress` is removed from the in-memory shape.

### Unchanged, and deliberately

- The credential-FILE fallback `account_address ?? safe_address ?? safeAddress`
  is **permanent** — a file on disk never rewrites itself — and stays tested
  against an old-shape file. The environment is not permanent, and that
  difference is the whole of this entry.

## 0.2.1-alpha.0 — 2026-09-16

### Added

- Quotes predict the scheme `prepare` will select — `expected_settlement_scheme`,
  `expected_funding_leg`, `expected_settleable` (#2991). A prediction only: the backend
  still selects from the payTo shape at prepare time.
- `haven_report_settlement_evidence` (#2973).

### Changed

- **`merchant_not_ready` parity in the local runtime** (#2983, #2979). A merchant's
  `503 { error: 'merchant_not_ready' }` now maps to `MERCHANT_NOT_READY`; previously it
  fell through to the discovery path and surfaced a different code. An unchanged caller
  gets a different code for the same merchant response.
- The erc7710 paid-retry refusal states that nothing moved.
- `PRICE_EXCEEDS_MAX` and `INVALID_MAX_AMOUNT` refusals carry `next_action` (#2975).

## 0.2.0-alpha.0 — 2026-09-14

### Naming epic #2906, phase 1 (#2908) — reads both names, prefers the new

| Reader | Chain (earlier wins) | Window |
|---|---|---|
| credential file, single and split (`loadCredentials`) | `account_address ?? safe_address ?? safeAddress` (per file; split files must agree, mismatch is labelled `account_address`) | the two old keys are read **permanently** |
| environment | `HAVEN_ACCOUNT_ADDRESS ?? HAVEN_WALLET_ADDRESS ?? HAVEN_SAFE_ADDRESS` | `HAVEN_WALLET_ADDRESS` / `HAVEN_SAFE_ADDRESS` removed at #2914 |

`HavenCredentialFile` gains an explicit `accountAddress` key (this shape is
separate from the signer's); `safeAddress` is kept with the same value and
`@deprecated` — **removed in the release after the one carrying #2908
(#2914)**. Exported: `readAccountAddressField()`, `readAccountAddressEnv()`.
The consent seed prefers the SDK's `accountAddress` and falls back to
`safeAddress`; the consent hash input value is unchanged either way.
