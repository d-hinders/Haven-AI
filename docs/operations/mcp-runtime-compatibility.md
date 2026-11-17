---
owner: "@d-hinders"
status: current
contract: true
covers:
  - packages/mcp/**
  - packages/connect/**
  - packages/signer/**
  - packages/mcp-server/src/tools.ts
  - packages/mcp-server/src/connector-channel.ts
  - packages/backend/src/__tests__/connector-upgrade-command-parity.test.ts
  - scripts/ci/upgrade-hint-guard.test.mjs
  - packages/mcp-server/src/tools/**
  - packages/mcp-server/src/description-tool-references.test.ts
  - packages/sdk/src/x402-erc7710.ts
  - packages/backend/src/modules/payments/direct-sign-context.ts
  - packages/backend/src/modules/x402/sign-context.ts
  - packages/sdk/src/userop-binding.ts
  - packages/sdk/src/task-budget-guards.ts
  - .github/workflows/publish.yml
  - packages/cli/src/connect-runner.ts
  - packages/backend/src/routes/machine-payments.ts
  - packages/sdk/src/account-reads.ts
  - packages/sdk/src/agent-guidance.ts
  - packages/sdk/src/client.ts
  - packages/sdk/src/node-version.ts
  - packages/sdk/src/connector-channel.ts
  - packages/sdk/src/mcp-merchant-transport.ts
  - packages/sdk/src/merchant-egress.ts
  - packages/sdk/src/merchant-answer.ts
  - packages/sdk/src/merchant-completion.ts
  - packages/sdk/src/receipt.ts
  - packages/sdk/src/edge.ts
  - packages/sdk/src/client-identity.ts
  - packages/core/src/client-compat.ts
  - packages/core/src/client-releases.ts
  - packages/core/src/budget-refusal-codes.ts
  - packages/backend/src/middleware/client-compat.ts
  - packages/sdk/src/haven-api-transport.ts
  - packages/cli/src/api.ts
  - packages/sdk/package.json
  - packages/sdk/tsup.config.ts
  - scripts/release-bump.mjs
  - scripts/release-version-constants.mjs
  - scripts/release-version-constants.test.mjs
  - scripts/release-bump.test.mjs
  - scripts/verify-connect-bundle.mjs
  - scripts/README.md
  - packages/mcp-server/src/description-size.test.ts
  - packages/mcp-server/src/log.ts
  - packages/backend/src/modules/x402/delegation-authorize.ts
  - packages/backend/src/modules/x402/replay.ts
  - packages/backend/src/infra/chain/x402-binding-signer.ts
  - packages/backend/src/modules/mpp/budget-precheck.ts
  - packages/cli/src/commands.ts
  - packages/cli/src/commands.test.ts
  - packages/frontend/src/components/connect-agent/setup-copy.ts
  - packages/frontend/src/components/connect-agent/WaitingForConnector.tsx
  - packages/frontend/src/components/connect-agent/__tests__/runtime-status-copy.test.ts
  - packages/frontend/src/hooks/useAgentConnectionSetupStatus.ts
  - packages/connect/src/installed-clients.test.ts
  - packages/backend/src/middleware/retired-safe-names.ts
  - packages/backend/src/routes/transactions.ts
  - packages/backend/src/routes/user-accounts.ts
  - packages/backend/src/routes/agents.ts
  - packages/backend/src/routes/agent-connection-setups.ts
  - packages/backend/src/domain/agent-payment-taxonomy.ts
  - packages/backend/src/domain/x402-settlement-timing.ts
  - packages/backend/src/modules/payments/agent-payment-status.ts
  - packages/backend/src/modules/transactions/csv-export.ts
  - packages/backend/src/domain/csv.ts
  - packages/sdk/src/types.ts
  - packages/sdk/src/payment-mappers.ts
  - packages/sdk/src/x402.ts
  - packages/sdk/src/tool-descriptions.ts
  - packages/sdk/src/next-step.ts
  - packages/sdk/src/skill-content.ts
  - packages/mcp-server/src/server.ts
  - packages/mcp-server/src/http.ts
  - packages/mcp-server/src/next-step-signer-parity.test.ts
  - packages/mcp-server/src/test-support/next-step-fixtures.ts
  - scripts/lint-next-steps.mjs
  - scripts/lint-next-steps-baseline.json
  - .github/workflows/ci.yml
  - packages/core/src/client-releases.data.ts
  - packages/mcp-server/src/tools-list.snapshot.json
  - scripts/ci/check-stale-client-compat.mjs
  - packages/mcp-server/src/next-arguments-corpus.json
  - packages/mcp-server/src/tool-contract-snapshot.test.ts
last-verified: "2026-11-12"
---

> **Contract change (#4808, 2026-11-11): the local MCP's settlement-evidence
> message.** `packages/mcp/src/tools.ts` is on this contract's cover list.
>
> The backend's `message` names `haven_report_settlement_evidence` in two
> states — phase `delivered_unverified` / next action `stop_and_tell_user`, and
> phase `payment_submitted` / next action `awaiting_settlement_evidence`. That
> tool is hosted-only, and the local package has no settlement-evidence path at
> all, so the instruction was unreachable for a local-MCP agent. The local
> `haven_get_payment_status` handler now replaces `message` whole in those two
> states, keyed on the structured fields and never on the backend's sentence,
> and names no reporting tool: it says the merchant delivered, that Haven's
> settlement sweep may still attribute the payment, and to tell the user if it
> stays unverified. Every other state passes the backend message through
> unchanged. No `phase`, `next_action`, status code or stored value changes,
> and `agent-payment-status.ts` is not edited.
>
> **What an installed client sees.** The `message` field of the local
> `haven_get_payment_status` response changes in exactly those two states;
> nothing else in the response moves. **What does not:** no tool name,
> argument, input schema, strict-input list, expected-context version, consent
> hash, `tools-list.snapshot.json` entry, `local-tool-contract.golden.json`
> entry or `next-arguments-corpus.json` row changes — both goldens are
> byte-identical before and after, and the hosted contract fingerprint does not
> move.
>
> **How it is held.** `packages/mcp/src/payment-status-message.test.ts` pins
> the local replacement with `toBe` in both states, twice per state (the
> backend's current sentence and an arbitrary string), and proves pass-through
> elsewhere; an assertion in the MCP server package proves the hosted agent
> still reads `haven_report_settlement_evidence`, so a replacement moved into
> the shared SDK read goes red. `last-verified` is not re-stamped: this block
> is the scope.

> **Contract change (#4790, 2026-11-11): the local MCP's typed refusal answers.**
> `packages/mcp/src/tools.ts` is on this contract's cover list. The local
> `normalizeError`'s `HavenApiError` branch typed none of the 20 backend
> `error_code`s the hosted mapper answers, so every one reached a local-MCP
> agent as `code: "API_ERROR"` with no `next_tool_omitted_reason`. It now
> answers all 20 exactly as the hosted mapper does: the same typed `code`, the
> same `next_action`, the same `next_tool_name` and `next_arguments` where the
> hosted answer names a tool, and the same `next_tool_omitted_reason` or the
> same absence of one — including the body-dependent variants
> (`submission_outcome_unknown` names `haven_get_payment_status` only when the
> body carries a `payment_id`; `prepare_reverted` changes its step on
> `revert_cause`) and the 403 guard on `delegation_expired`. Any other
> `error_code` keeps the generic `API_ERROR` answer, and a body's own
> `next_action` is still passed through.
>
> **What an installed client sees.** For those 20 refusals the failure
> envelope's `code` changes from `API_ERROR` to the typed code, and the
> `next_action` / `next_tool_name` / `next_arguments` /
> `next_tool_omitted_reason` fields appear where the hosted surface already
> emits them. No tool name, argument, input schema, strict-input list,
> expected-context version, consent hash, `tools-list.snapshot.json` entry or
> `next-arguments-corpus.json` row changes, and no hosted runtime file changes.
> The local package's `tools/list` golden is untouched.
>
> **How it is held.** A parity test in `packages/mcp-server/src/` drives both
> mappers with the hosted suite's fixture bodies and fails on any
> difference in `code`, `next_action`, `next_tool_name`, `next_arguments` or
> `next_tool_omitted_reason` that its (empty) allowlist does not name, and on a
> stale allowlist entry. It also walks `PAYMENT_SCOPE_REFUSAL_CODES` from
> `@haven_ai/core`, so a new core code cannot go unanswered locally.

> **Contract change (#4826, 2026-11-12): one more typed refusal on the local
> MCP.** `packages/mcp/src/tools.ts` is on this contract's cover list. The
> backend's x402 authorize replay for an idempotency key whose payment is
> already `submitted` now answers `409` with `error_code:
> "payment_already_submitted"`, `payment_id` and `status: "submitted"`. Both
> mappers answer it with `check_status_later` and
> `haven_get_payment_status { payment_id }` taken from the body — never a
> retry, never a new payment. That is the 21st typed code the local mapper
> answers; the hosted branch requires the body's `payment_id`, and a body
> without one falls through to the generic `API_ERROR` answer on both
> surfaces. No tool name, argument, input schema, strict-input list,
> expected-context version, consent hash or `tools-list.snapshot.json` entry
> changes; `next-arguments-corpus.json` gains one row for the new fixture site
> (the same `haven_get_payment_status { payment_id }` step the two
> `submission_outcome_unknown` rows already carry), and no hosted runtime file
> changes. `last-verified` is not re-stamped: this block is the scope.

> **Description-only change (#4796, 2026-11-10): four tool descriptions named
> a tool their own surface does not register.** The shared description text in
> `packages/sdk/src/tool-descriptions.ts` told a local-MCP agent to use
> `haven_check_funds` (hosted only) from `haven_send` and
> `haven_sweep_delegate`, and a hosted-MCP agent to use `haven_pay_x402` (local
> only) from `haven_send` and `haven_pay_mcp_tool`. `composeDescription` now
> takes the surface, and those four descriptions are worded for the surface
> that serves them: the hosted ones point at `haven_quote_x402`; the local ones
> say the surface has no check of funds against an amount, and, on funds,
> name `haven_get_allowances` only for its `fundsCoverRemaining` flag, never as
> such a check (a live budget is spend authority, not proof of a balance).
> **What moves:** the four `description` strings, in the hosted golden
> `packages/mcp-server/src/tools-list.snapshot.json` and the local golden
> `packages/mcp/src/local-tool-contract.golden.json`; the hosted contract
> fingerprint, which hashes descriptions, so an agent holding the old hosted
> list is told to reconnect, as designed. **What does not:** no tool name,
> argument, input schema, strict-input list, expected-context version, consent
> hash or `next-arguments-corpus.json` row; the stale-client check ignores
> description-only changes. A new test,
> `packages/mcp-server/src/description-tool-references.test.ts`, fails when a
> description on either surface names a tool that surface does not register,
> a signer tool or one allowlisted reference aside. `last-verified` is not re-stamped: this block is the
> scope.

> **No contract change (#4791, 2026-11-10): the local `tools/list` contract
> gets a golden, as the hosted one has had since #3817.** Tests and one script
> line; no runtime behaviour changes. The local `@haven_ai/mcp` `tools/list`
> payload — each tool's name, description and input schema — is now captured
> through the MCP SDK (`InMemoryTransport` + `client.listTools()`, the server
> built by `buildMcpServer`) into the committed golden
> `packages/mcp/src/local-tool-contract.golden.json` and pinned by
> `packages/mcp/src/local-tool-contract.test.ts`; regenerate with
> `npm run snapshot:regen -w packages/mcp` and review the diff as a contract
> change. The golden holds `tools/list` only, so a release bump (which rewrites
> the package's version constant) does not move it, and it is not published
> (`files` stays `dist` and `README.md`). It deliberately does not reuse the
> hosted basename `tools-list.snapshot.json`. The local package still has no
> contract fingerprint and no next-arguments corpus: those serve the
> stale-hosted-client check. No tool name, argument, input schema, strict-input
> list, expected-context version, consent hash, `tools-list.snapshot.json` entry
> or `next-arguments-corpus.json` row changes. `last-verified` is not
> re-stamped: this block is the scope.

> **No contract change (#4746, 2026-11-09): the runbook's release-record link
> moves to the start of "If something breaks".** `packages/sdk/src/agent-guidance.ts`
> is on this contract's cover list. The section's paragraph ended with "What
> changed: [/releases](/releases)."; it now opens with "Client out of date? What
> changed: [/releases](/releases)." and is otherwise unchanged.
> `AGENT_CLIENT_UPDATE_SENTENCE`, the `upgrade_command` instruction it carries,
> and the `client_update` wire shape are all untouched. No tool name, argument,
> input schema, strict-input list, expected-context version, consent hash,
> `tools-list.snapshot.json` entry or `next-arguments-corpus.json` row changes.
> `last-verified` is not re-stamped: this block is the scope.

> **No contract change (#4706, 2026-11-08): the connect flow names the agent
> and offers a read-only check.** `WaitingForConnector.tsx` and `setup-copy.ts`
> are on this contract's cover list. The waiting screen gains the agent row
> above its checklist (presentational: the name and "Listening for it…", then
> "Connected just now"; it owns no live region), and `setup-copy.ts` gains the
> "Say hello" prompt the done state copies. No runtime-status copy, setup
> command, upgrade hint, runtime detection or connector behaviour moves;
> `runtime-status-copy.test.ts` is untouched. `last-verified` is not
> re-stamped: this block is the scope.

> **No contract change (#4675, 2026-11-05): the agent runbook says signup is
> passkey-only.** `packages/sdk/src/agent-guidance.ts` is on this contract's
> cover list. Its account step and signup hand-off script said signup offers
> "a passkey or a wallet"; both now say "a passkey", because signup is
> passkey-only and a wallet joins an existing account's signer set later. No
> tool name, argument, input schema, strict-input list, expected-context
> version, consent hash, `tools-list.snapshot.json` entry or
> `next-arguments-corpus.json` row changes: the runbook is prose, and no
> command, flag, runtime-detection rule or upgrade hint moves.
> `last-verified` is not re-stamped: this block is the scope.

> **No contract change (#4655, 2026-11-04): the binding key's boot refusal.**
> `packages/backend/src/infra/chain/x402-binding-signer.ts` is on this contract's
> cover list. The backend now refuses to boot when a set
> `X402_BINDING_PRIVATE_KEY` equals a relayer key or the receipt key, and the
> sweep authorization signing moved into that file so the binding wallet is
> constructed in one place. No tool name, argument, input schema, strict-input
> list, expected-context version, consent hash, `tools-list.snapshot.json` entry
> or `next-arguments-corpus.json` row changes: the signed messages
> (`buildX402ExpectedMessage`, `buildSweepAuthorizationMessage`) and the signer
> address are byte-identical, so an installed signer sees no difference.
> `last-verified` is not re-stamped: this block is the scope.

> **No contract change (#4638, 2026-11-03): a presentation-only prop on
> `WaitingForConnector`.** It gains an optional `halo` flag, passed through to
> the step checklist so the live Connect dialog can show one attention ring on
> the active step. No runtime-status copy, setup command, upgrade hint, runtime
> detection or connector behaviour moves; `runtime-status-copy.test.ts` is
> untouched. `last-verified` is not re-stamped: this block is the scope.

> **Contract change, additive (#4449, 2026-10-26): the edge signer's SUCCESS
> results carry the next-step family.** Covered files: `packages/signer/**`
> (`tools.ts`, `next-step.ts`, `no-funding-leg.ts`), `packages/sdk/src/next-step.ts`
> (an optional `name` on `NextStepTarget`, so a `<tool>#<variant>` target key
> renders the bare tool name) and
> `packages/mcp-server/src/next-step-signer-parity.test.ts` (the two new
> variants pinned to the hosted schemas).
>
> Each of the six signer success sites now carries either `next_tool_name` +
> `next_tool_server_role: 'hosted'` + `next_arguments`, or a literal
> `next_tool_omitted_reason`. The `next_tool` family only: no success result
> gains `next_action` or `safe_to_continue`, which stay on refusals.
>
> **Installed runtimes do not emit the step.** The signers observed live on
> 2026-10-26 (`0.10.0-alpha.0`, `0.8.1-alpha.0`) return the same results they
> always did, so an agent on either runtime sees no `next_tool*` field on a
> successful signature. **The hosted prepare and pay guidance stays
> authoritative** and must not be trimmed in favour of the signer step: it is
> the only next-step source those runtimes have, and it is the only one that
> knows the merchant transport.
>
> Nothing else moves. No tool name, argument, input schema, strict-input list,
> expected-context version, consent hash, `tools-list.snapshot.json` entry or
> `next-arguments-corpus.json` row changes — no signer description is mirrored
> in the hosted snapshot, and the consent hash ignores descriptions
> (`packages/signer/src/consent.ts`). `SUPPORTED_X402_EXPECTED_VERSIONS` is
> untouched and no signing decision changes. `last-verified` already reads
> 2026-10-26 and is left as is. Nothing else in this document was re-verified.

> **Contract change, additive (#4257, 2026-10-22): the local MCP's paid-call failure envelope.**
> `packages/mcp/**` is on this contract's cover list.
>
> When the embedded SDK refuses to re-send a paid request to a different
> origin (a body-keeping redirect from the merchant, refusal `redirect_cross_origin_body`),
> the local paid tools now answer `MERCHANT_EGRESS_REFUSED` with:
>
> - `paymentId`;
> - `status: merchant_unresponsive_after_funding`;
> - `phase` and `next_action`: `funded_but_unsettled` / `sweep_stranded_funds`
>   on EIP-3009, or `not_delivered` / `check_status_later` on erc7710;
> - `next_tool: haven_get_payment_status` and `next_arguments: { payment_id }`.
>
> These are the fields the hosted #1300 treatment already returns. Before
> this change no such refusal existed locally: the platform re-sent the
> request.
>
> On the transport, a hop to another origin now carries only the #4244 header
> allow-list, and redirects are followed by the SDK with `redirect: 'manual'`.
> `MerchantEgressRefusedError` gains `redirect_cross_origin_body` and three
> optional fields (`redirectStatus`, `redirectTarget`, `settlementScheme`); its
> inherited `paymentId` is now filled in on a paid delivery.
>
> No tool is added, renamed or re-shaped. No strict schema, consent hash,
> version-skew rule or signing input moves. `last-verified` is not
> re-stamped: this block is the scope.

> **Contract change (#4107 reverted, 2026-10-21, one hosted tool removed):
> `haven_check_token_safety` is gone.** PR #4148 added it on 2026-10-20; it
> reached `dev` and hosted dev only, never `main`, and is reverted whole on
> owner decision (record:
> `docs/regulatory/casp-changelog/2026-10-21-4107.md`). The hosted surface
> returns to 29 tools (strict set 27), and the companions go back to their
> pre-#4148 values in the same commit: `tools-list.snapshot.json` loses the
> row, and the description-size ratchet returns to 31,674 bytes over 29 tools
> (mean pin 1092.21). Version skew is safe both ways: an agent that saw the
> tool on hosted dev and calls it now gets unknown-tool, and no signer tool,
> schema, connector or consent surface moves. `last-verified` is re-stamped
> to 2026-10-21 for this note; this block is the scope.

> **#3817 (2026-10-10, the hosted `tools/list` contract is snapshotted and
> stale-client impact is reported in CI):** CI-only, tests and skill text —
> no runtime behaviour changes. The hosted `tools/list` payload (names,
> input schemas, descriptions) is now captured through the SDK
> (`InMemoryTransport` + `client.listTools()`) into the committed golden
> `packages/mcp-server/src/tools-list.snapshot.json` and pinned by
> `tool-contract-snapshot.test.ts` (regenerate with
> `npm run snapshot:regen -w packages/mcp-server`); a companion corpus
> (`next-arguments-corpus.json`) carries every `next_arguments` the server
> emits for a hosted `next_tool`. `mcp_server_checks` gains an ADVISORY step
> (`scripts/ci/check-stale-client-compat.mjs`) that validates the corpus and
> the branch snapshot against `origin/main`'s golden and writes
> reconnect-required findings to the job summary — never a failure: a
> contract change is legitimate, it only needs announcing. Nothing in this
> document's skew rules moves: the check is the MEASURING instrument for the
> stale-client half of the existing reconnect rule (contract fingerprint §
> above), not a new contract. Description-only changes and additive optional
> fields no emission carries are silent by design; a narrowed `enum`/`pattern`
> flags (the #3172 precedent). Until the first promotion publishes a golden
> to `main`, the check prints a notice and skips.

> **#3778 (2026-10-08, optional bounded `delivery_reference` on the x402
> outcome and settle surfaces):** `haven_report_x402_outcome`,
> `haven_complete_mcp_tool` and `haven_settle_mcp_tool` accept an optional
> `delivery_reference` (≤ 512 chars) — the NON-SECRET pointer to a delivered
> good ("Bik Bok 5 SEK, order 6ac7…"). On an accepted outcome it is recorded
> on the `machine_payment_evidence` row (migration 107) and surfaces on the
> receipt (`haven_list_receipts` / `POST /machine-payments/evidence` echo),
> the transaction detail drawer, and the activity feed, so the owner can see
> that a deliverable EXISTS and where to recover it — closing the #3778 gap
> where the only copy of a purchased redemption code lived in the agent's
> session context.
> - **Credential-shaped values are refused at three layers:** the tool
>   handlers (pre-write for the report; pre-funding for settle), the backend
>   semantic layer (`attachMachinePaymentEvidence` → 400
>   `delivery_reference_refused`), and the shared recognizer in
>   `@haven_ai/core` (`deliveryReferenceError`: JWTs, long hex/base64 token
>   material, grouped uppercase gift-card codes). Deliberately conservative —
>   order ids and invoice references pass; the relay of the secret itself
>   stays the skill's rule, not a stored field. Rejected outcomes record no
>   reference (nothing was delivered).
> - **Hosted delivery picks this up on deploy**; local MCP/connect users
>   need an `@haven_ai/mcp` / `@haven_ai/connect` release (both pin the SDK
>   exactly), as with #3764.
> - **An already installed `SKILL.md` stays stale until reinstalled** (its
>   "Reporting after a purchase" section gained the relay rule and the
>   Bitrefill SIWX recovery steps; both byte-pinned copies edited
>   identically).

> **#3769 (2026-10-08, the guided catalog path accepts per-call arguments and
> an HTTP call shape):** `haven_prepare_catalog_purchase` gains one OPTIONAL
> input, `arguments`. A catalog row that declares `tool_arguments_schema` (a
> JSON Schema the row carries; migration 107 pins Soundside `create_text`'s,
> tightened to require prompt-or-messages) accepts caller `arguments` — merged
> over the row's pinned `tool_arguments` and validated against the schema
> BEFORE the merchant probe, refused `INVALID_CATALOG_ARGUMENTS` (400) when
> they violate it; a row WITHOUT a schema is a fixed SKU and now REFUSES
> caller `arguments` with `INVALID_INPUT` (the old drop-in-silence hardened
> into a refusal). The strict-input mis-key census moved from `arguments` to
> `tool_name` for this tool. Discovery entries additively carry
> `tool_arguments_schema` / `http_method` / `body_type` / `body_example`
> (absent on an older backend), and an http row's `haven_quote_x402` hint now
> carries `method`/`body` when the row declares them.
> - **Additive, not re-shaping.** No tool is added or renamed; `arguments` is
>   optional, so an existing caller's payload is unchanged and an older local
>   MCP is unaffected (the input lives on the hosted surface only).
> - **Version skew is safe in both directions.** An old BACKEND sends no
>   `tool_arguments_schema`, every row reads schema-less, and `arguments`
>   refuses — the pre-#3769 contract. An old hosted server ignores the new
>   backend fields and keeps quoting with the row's pinned arguments. The
>   consent hash covers tool names, not inputs (per the #3771 note, now in the
>   archive), so it does not move.
> - **The refusals are pre-intent.** Both argument refusals run before the
>   live quote, so no merchant is contacted and no payment exists on an
>   invalid call — the same position the cap refusals already hold.

>
> **#3768 (2026-10-08, merchant-issued credentials are withheld from the settled `result`):**
> a settled `haven_settle_mcp_tool` / `haven_complete_mcp_tool` response no longer
> forwards merchant-issued bearer credentials to the agent verbatim. Prod QA
> 2026-10-08 (payment `79084a5e`, Soundside `create_text`, Base mainnet) showed
> `result.structuredContent` carrying an `x402_session_token` JWT and a
> `wallet_link` URL with an embedded JWT — both bound to the agent's delegate
> EOA — reaching the untrusted agent context as-is. `deliverMerchantPayment`
> now redacts the merchant body before any handler arm returns it: JWT-shaped
> strings are redacted by shape (including embedded in URLs), and string
> values under credential-named keys (`*_token`, `*_link`, `access_token`,
> `session`, plus `secret`/`password`/`api_key`/`authorization`/`bearer`/
> `credential`) are withheld whole. The MERCHANT_REJECTED_AFTER_FUNDING
> refusals' bounded `Merchant response:` echo redacts unconditionally.
> - **The opt-in is explicit and per call:** `include_merchant_credentials:
>   true` on either tool returns the merchant body unredacted — a merchant
>   session (Bitrefill `X-Access-Token`, #3728) is how an agent avoids paying
>   per call, so receiving a credential is the agent's deliberate act, never
>   the default. Money fields, `settled`/`delivered` markers and transaction
>   hashes are never touched by the recognizer.
> - **The hosted surface picks this up on deploy**; no local-MCP or connect
>   release is implicated (the local flow has the agent make the paid retry
>   itself, so Haven never sees that result).
> - **An already installed `SKILL.md` stays stale until reinstalled** (its
>   "Reporting after a purchase" section now documents the withholding; both
>   byte-pinned copies — `packages/sdk/src/skill-content.ts` and the frontend
>   twin — were edited identically).
> - **Persistence paths checked:** the evidence row
>   (`attachMachinePaymentEvidence`) records status, challenge, proof and
>   receipt headers — never a result body; the hosted access log
>   (`packages/mcp-server/src/log.ts`) logs metadata only; the backend
>   `agent_tool_invocations` audit extracts payment_id/next_action/error-code
>   only, and its tool allowlist never included the settle/complete tools.
>   Two body-bearing writes REMAIN verbatim by design, both bounded:
>   reconciliation-event `retry_body` snippets (written only on a REJECTED
>   retry, and only from that rejection body) and merchant `x-receipt-json`
>   receipt documents (the merchant's own document, captured from headers).
>   Neither is the settled tool result; flagged as accepted residual.

> **#3764 (2026-10-08, the SDK reports the merchant's EIP-3009 settlement hash):**
> on an accepted merchant answer to a payment WITH a funding leg, the SDK now
> posts the merchant's own settlement transaction (parsed from
> `PAYMENT-RESPONSE`, or the native MCP profile's
> `result._meta["x402/payment-response"]`) as a SECOND
> `/machine-payments/evidence` report right after the funding one — so Haven
> records the transaction the merchant shows
> (`machine_metadata.merchant_settlement_tx_hash`, #3475). Exactly one
> attempt, no backoff; nothing is posted when the hash is missing, malformed,
> the zero marker, or the funding hash in any letter case. The hosted eip3009
> tools (`haven_complete_mcp_tool`, `haven_settle_mcp_tool`) map the report's
> outcome to next steps (retryable → `haven_report_settlement_evidence` with
> the hash prefilled; refused → no tool).
> - **Hosted delivery picks this up on deploy.**
> - **Local MCP users need an `@haven_ai/mcp` release** and **connect users an
>   `@haven_ai/connect` release** — both pin `@haven_ai/sdk` exactly
>   (`packages/mcp/package.json:57`, `packages/connect/package.json:58`), so
>   upgrading the SDK alone does nothing for them.
> - **An already installed `SKILL.md` stays stale until reinstalled** (the
>   skill's plain-HTTP settlement guidance now points at
>   `haven_report_x402_outcome`'s `payment_response`, #3727).

> **#4215 (2026-10-21, the local EIP-3009 settlement report is retried on a
> retryable answer):** on the LOCAL path (`fetch` / `payX402Quote` /
> `resumeX402Payment` → `MerchantCompletion.retryRequest`), the merchant's
> settlement-evidence report is no longer one attempt: it is retried while
> Haven answers `retryable` (503 `settlement_unobservable`) under the bounded
> `EVIDENCE_RETRY_DELAYS_MS` schedule — four attempts over ~7 s of backoff,
> each attempt additionally bounded only by `requestTimeout` (30 s). Any
> refusal — a 409, the #4061 `settlement_proof_header_missing` refusal, a
> validation error, a transport failure with no HTTP status — still ends the
> loop on the first attempt. This revisits #3764's D2 for the local path only
> (owner decision on #4215): the qa-dev EIP-3009 legs showed the backend's
> node sees the merchant transaction only seconds after the funding confirm,
> and a swallowed one-shot 503 red them against #4144's 45 s record window.
> **D2 on the HOSTED path is unchanged** (`completeX402MerchantCall` still
> posts once and maps a retryable answer to the
> `haven_report_settlement_evidence` handoff), the outcome stays swallowed on
> the local path (D1), and the caller-visible result of a completed purchase
> does not change — worst case it returns ~7 s later.
> - **Local `@haven_ai/mcp` users get this only with an `@haven_ai/mcp`
>   release** (it pins `@haven_ai/sdk` exactly), and **connect-installed
>   local runtimes only with an `@haven_ai/connect` release** (same exact
>   pin) — upgrading the SDK alone does nothing for them.
> - **Hosted delivery is unchanged and picks nothing up**; no hosted deploy
>   is implicated.

> **#4688 (2026-11-05, `settled: true` on the EIP-3009 bridge now requires a
> verified merchant settlement):** `haven_settle_mcp_tool` used to answer
> `settled: true`, `next_action: none` and "Funding and merchant settlement
> both succeeded." for every non-error merchant 2xx, whatever the settlement
> evidence report said. A merchant that verified the payment but never settled
> it left the funded USDC on the delegate EOA while the agent was told the
> purchase settled. `settled` is now
> `settlement_evidence_outcome?.outcome === 'confirmed'` — the rule the tool's
> own contract already stated.
> - **The unverified arms** (`retryable` → `SETTLEMENT_PENDING`; `refused`, or
>   nothing posted because the merchant gave no hash or a zero one →
>   `DELIVERED_UNSETTLED`) carry `settled: false`, `delivered: true`, a
>   `SETTLEMENT_UNCONFIRMED` warning, `settlement_tx_hash: null`, the allowance
>   block, and NO `purchase_summary` (its published `status` is `'settled'`
>   only). The next step polls `haven_get_payment_status` after about 3 minutes
>   — the #3888 sweeper's window — and names `haven_sweep_delegate` only if
>   `merchant_settlement_recorded` is still not true then.
> - **`haven_complete_mcp_tool`** answers the same unverified shape instead of
>   the bare delivery result, and its confirmed arm now carries `settled: true`
>   (additive; no consumer read its absence).
> - **No installed client breaks:** connect, signer and cli do not read the
>   tool's `settled`; the eval graders read backend status; the local SDK
>   completion path emits no `settled` field.
> - **Hosted delivery picks this up on deploy**; no local-MCP or connect
>   release is implicated (the local flow emits no `settled`). `last-verified`
>   is not re-stamped: this block is the scope.

# MCP Runtime Compatibility

> **Scope:** This covers the **local stdio MCP runtime** installed during agent
> setup — the advanced/local path. For the default topology (hosted MCP + local
> signer) and how to deploy it, see [hosted-mcp.md](hosted-mcp.md).

With `--local`, Haven Connect installs a local stdio MCP runtime for Codex
Desktop, Codex CLI, and Claude Code; the default topology is the hosted MCP plus
a local signer (see *Hosted-runtime connector profiles*). The connector must not
rely on `npx` at agent startup; a `--local` setup preinstalls a tested runtime
and writes a stable wrapper:

`haven_discover_tools` remains skew-flat across the local and hosted MCP
topologies: since #1350 it accepts the same optional `search` argument on both
surfaces, alongside the existing `category` and `rail` filters. `category`
matching is case-insensitive after trim. `search` normalizes whitespace,
accepts at most eight words, and requires every word to match the product
`name`, `description`, or `category`; merchant name is deliberately excluded
because it belongs to the separate merchant table. More than eight words
returns 400, while omitting `search` preserves the older request shape exactly.
Since #1716 both surfaces also accept the same optional
`verified` filter (`any` | `verified` | `operator`) and return the `source` /
`domain_verified` / `verified_payable` badge fields on each entry — added to
BOTH surfaces together, so the skew-flat claim holds unchanged. Since #2978,
`verified` is not a pure provenance filter: `verified=verified` returns any
entry, whatever its source, whose endpoint Haven watched answer a live quote
probe (`verified_payable === true`); `verified=operator` still filters on
provenance alone. Since #4245 `source` has a third value, `bazaar`, for rows
the x402 Bazaar discovery cron wrote (only when a deployment enables
discovery): seller-chosen name and description, no operator review, no
ownership proof. Before #4245 those rows were labelled `operator`. The value
is additive, and there is no skew: every published SDK's `verified=operator`
already keeps `source === 'operator'` only, so it excludes `bazaar` rows on
both surfaces. Since the #4245 follow-up, no catalog tool description calls
the catalog or its entries "curated"; that is description and
refusal-message text only (no tool name, schema or argument moved). The
result is still read-only discovery metadata: catalog prices are indicative
hints, never payment authority.
`verified_payable` means the endpoint answered a live probe; `domain_verified`
is the separate, stronger claim that ownership of the domain was proven —
operator rows can carry the former without the latter. Version skew, stated:
the filter runs in `@haven_ai/sdk`, so the hosted server (deployed from
`dev`) applies the badge semantics as soon as #2978 lands, while a published
local runtime keeps the older provenance semantics (`source === 'ingestion'`)
until the next release bump republishes the sdk pin — the surface is
skew-flat, the meaning of `verified=verified` is not, for that window. That
window has closed: #2978 landed on 2026-09-14, and every release since
(through `0.10.0-alpha.0`) bundles the badge semantics.

The default hosted MCP + local signer topology additionally exposes
`haven_quote_mcp_tool` and `haven_quote_catalog_purchase` (#1397). They are
read-only live-price probes for an arbitrary MCP merchant or a catalog
entry: no payment intent, approval, signing context, allowance check, funding,
or paid retry is created. Their response is informational only; a later hosted
`haven_pay_mcp_tool` or `haven_prepare_catalog_purchase` always obtains a fresh
quote and enforces its own cap before creating an intent. The local stdio MCP
intentionally does **not** expose these tools yet: its current one-shot payment
path cannot honor that quote-then-pay cap/re-quote contract, so publishing the
same names there would imply a safety guarantee it cannot make.

`haven_pay_x402_quote` — the generic plain-HTTP x402 entry point — selects its
settlement scheme the same way since #2041, using the shared #1450/#1453
preference rule rather than hard-routing to the EIP-3009 bridge. On the
delegation rail against a merchant advertising
`extra.assetTransferMethod: "erc7710"` it composes `prepareX402Erc7710` and
returns the `settlement_scheme` / `settlement.funding_leg` fields
`haven_pay_mcp_tool` already returns; every other case is byte-identical to
before. It carries **no new skew row**, for two reasons worth stating rather
than implying: the local stdio MCP's `haven_pay_x402_quote` is a different,
key-holding one-shot path that was never the surface this table describes, and
the erc7710 shape (like `haven_pay_mcp_tool`'s and
`haven_prepare_catalog_purchase`'s) carries no `signer_compatibility` — the
signer's own signing-time refusal is the guard there.

`haven_submit` gains an OPTIONAL `settlement_scheme` (`erc7710` | `eip3009`) in
the same change, so the generic erc7710 flow has a settle leg: on `erc7710` the
signature is the settlement child rather than a funding authorization, so it
goes to `POST /x402/:id/settle` and the response carries the Haven-assembled
`payment_header` with `tx_hash` / `funding_tx_hash` null — there is no
Haven-submitted transaction on that scheme. Omitting the field, or sending
`eip3009`, relays the funding signature exactly as before, so **every existing
caller is unchanged and there is nothing to upgrade**. The local stdio MCP's
`haven_submit` (added by #3329) relays a signature the
agent already holds (`task_budget_id` / `sub_budget_id`) and refuses a
`payment_id`, so it takes no `settlement_scheme` and nothing here is skew.
Since #4825 that runtime has no signer tool, so it cannot produce a
task-budget or sub-budget signature at all: the task-budget tools refuse with
`TASK_BUDGET_SIGNING_UNAVAILABLE` and a pending sub-budget row names no next
tool (see *Task budgets and sub-budget signing are hosted-plus-signer
features* below).

An **erc7710-ONLY merchant** — no untagged `accepts[]` entry — is reachable
through `haven_pay_mcp_tool` and `haven_prepare_catalog_purchase` since #2054:
the shared quote helper (`buildX402Quote`) describes the erc7710 entry when no
standard one exists instead of refusing the merchant outright. Additive shape,
stated so nobody re-derives it: the **hosted** read-only quote tools
(`haven_quote_mcp_tool`, `haven_quote_catalog_purchase`, and the hosted
`haven_quote_x402`) gain `accepted_scheme: 'standard' | 'erc7710'` plus
`erc7710_only: true` on the erc7710 case — new fields only, nothing existing is
renamed or retyped — and the two purchase tools gain one new refusal,
`ERC7710_RAIL_REQUIRED`, raised when the account's rail cannot settle the
merchant's only compatible entry (or the rail could not be read). It is a
`code` on the standard failure envelope, not a wire-enum change; no tool
argument changed, no capability handshake, no signer surface, and the Supported
Runtime Manifest table is untouched.

As of #2991 (the two MCP quote tools) and #2999 (the hosted plain-HTTP
`haven_quote_x402`), all THREE **hosted** quote tools gain
`expected_settlement_scheme: 'erc7710' | 'eip3009' | null` and
`expected_funding_leg: boolean | null` (and `expected_settleable: boolean`
when the rail is known — `false` where prepare/pay will refuse with
`ERC7710_RAIL_REQUIRED`) — the scheme
`haven_prepare_catalog_purchase` / `haven_pay_mcp_tool` / `haven_pay_x402_quote`
will actually select for THIS account, computed by the identical selector,
versus `accepted_scheme` which only ever describes the merchant's offer. All
three now go through the same `settlementPredictionFields` support helper, so
none can disagree with the others on an identical accepts[]/agent pair.
Another deliberate local/hosted skew, same shape as the one above: this is
response shaping specific to the hosted capability modules
(`buildMcpToolQuoteResponse`, and the hosted `haven_quote_x402` handler
directly), so the local stdio `haven_quote_x402` gains none of these fields —
it predicts no settlement scheme, and a local caller already holds its own
key/rail state. (It does read the agent since #3967, but only to compare a
stated `expected_amount`; see the #4830 note below.)

As of #3839, `haven_discover_tools` on BOTH the hosted and the local stdio
surface returns two additive fields per entry: `asset_transfer_methods` (the
catalog's stored set, `null` when none) and `funding_leg_expected: true |
false | "unknown"`, computed by the SDK's `catalogFundingLegExpected`. No
argument, ordering or existing field changed. The local surface gets them only
from an SDK that carries the helper (published `@haven_ai/mcp` pins its SDK
exactly, so after a release). The description gains one guidance sentence;
`description-size.test.ts` was re-derived for it (round 26).

One **deliberate local/hosted skew**, recorded because this table exists to
catch exactly that: the **local stdio** `haven_quote_x402` returns the SDK's
own `X402Quote` plus only the fields its own `expected_amount` comparison adds,
so it now also QUOTES an erc7710-only merchant (it used to throw) — but it
returns the SDK's own `acceptedScheme` (camelCase) and no `erc7710_only`
convenience field, since none of the hosted response shaping runs there. The
local **pay** paths are unchanged in behavior
(`HavenClient.fetch` / `authorizeX402` / `payX402Quote` still re-select through
`selectStandardPaymentOption` and refuse an erc7710-only merchant — a
key-holding EIP-3009 path cannot settle it); what changed is only the refusal
TEXT, which now names the erc7710 tag as the reason
(`noCompatiblePaymentOptionError`) instead of implying Base USDC is the limit,
so the quote-succeeds-then-pay-refuses sequence is legible rather than
contradictory.

`haven_submit_catalog_entry` (#1716) is also skew-flat: both surfaces expose
the same queue-only submission tool (same `resource_url` + honeypot `website`
input, same id/verify_token/status output). It writes a submission row only —
no outbound request, no token reuse, no authority — and domain-ownership proof
plus the read-only quote probe still gate any listing on the backend.

> **Additive response fields (#4830, 2026-11-12):** a stated `expected_amount`
> is no longer skipped silently on either surface. When the comparison cannot
> be made, `haven_quote_x402` (hosted and local) returns
> `price_comparison_made: false` with `price_comparison_not_made_cause`
> (`agent_read_failed` | `agent_read_refused` | `no_option_selected` |
> `unknown_decimals`), `safe_to_continue: false`, no prefilled cap and no pay
> step; `price_differs_from_expected` is absent because nobody compared the
> price. The next step follows the cause — `retry_with_explicit_context` for a
> transient agent-read failure, `stop_and_tell_user` for a refused read, an
> unselectable option or unknown decimals — and no new `next_action` value is
> introduced. The comparison is now decided WITHOUT the agent read wherever the
> rail cannot change the answer (one option, equal authorization amounts, or a
> stated price equal to neither), and a stated price finer than the token's
> scale is a decided mismatch on both surfaces (the local surface used to skip
> it). No input, existing field, or signer surface changed. The local half
> ships with the next `@haven_ai/mcp` release.

> **Additive response field (#3476, 2026-09-29):** the hosted
> `haven_pay_x402_quote` gains an optional `allowance` block on its
> successful results, both settlement branches — `{ rail: 'delegation',
> sufficient: boolean | null, remaining_atomic?: string,
> remainingAtomic?: string, source: 'active_delegations' }`, the same shape
> and the same `GET /machine-payments/allowances` source the catalog
> preflight's allowance field and the settle-time summary report from. It is
> VISIBILITY ONLY: the block never refuses, a failed budget read degrades to
> `sufficient: null` plus an `ALLOWANCE_CHECK_UNAVAILABLE` warning exactly
> like the catalog block's, and an optimistic remaining (the #1145 fallback)
> carries `ALLOWANCE_READ_OPTIMISTIC`. An account whose rail is not
> delegation gets NO block (never a fabricated row) with the same warning,
> and an over-budget payment is still declined exactly as before — the
> tool's own prepare-time answers and the on-chain enforcer are unchanged.
> Additive on the read side only: no tool name, schema, argument,
> strict-input decision, error code, refusal text or signing boundary
> changes, the #1348 one-agent-fetch round-trip budget is kept (the block
> reuses the handler's existing agent read), and the block reads
> `GET /machine-payments/allowances` — one extra read-only GET per
> successful quote, never `POST /machine-payments/budget-precheck` (that
> endpoint is the #3054 decision surface and books a `payment_refusals` row;
> the quote must only report). The local stdio runtime has no handler-level
> response shaping and gains nothing. Old agents ignore the new key; new
> agents against an older backend omit it (the allowances read fails, the
> block degrades to `sufficient: null` with the warning).

```text
~/.haven/agents/<slug>/bin/haven-mcp
```

The wrapper lives in the agent's credential directory, named from the wiring
slug (`haven-<slug>` pair) by default; only a `--bare` run, or a `--replace`
without `--name`, names the directory by the agent id instead (#3737).

## Supported Runtime Manifest

The source of truth is `packages/connect/src/runtime-manifest.ts` (the SDK and
signer versions are pinned there; `@haven_ai/mcp` tracks its own `MCP_VERSION`,
and `@haven_ai/connect` its own `CONNECTOR_VERSION`).

**Do not re-pin the four `@haven_ai/*` rows by hand.** Since
[#1790](https://github.com/d-hinders/Haven-AI/issues/1790) `npm run release:bump`
writes them, and a check compares each row against its own constant — on every
release *and* on every pull request, so a hand-edit that drifts from the source
fails CI rather than quietly becoming a false compatibility claim. The
`last-verified` note above is still written by hand; that is the part of this
doc that carries an argument rather than a number.

| Component | Supported version |
| --- | --- |
| Node.js | >= 22.0.0 (`engines` floor; repo development and CI pin LTS 24 via `.nvmrc`) |
| `@haven_ai/connect` | `0.14.0-alpha.0` |
| `@haven_ai/mcp` | `0.14.0-alpha.0` |
| `@haven_ai/sdk` | `0.14.0-alpha.0` |
| `@haven_ai/signer` | `0.14.0-alpha.0` |
| Codex Desktop / Codex CLI | local stdio MCP via `~/.codex/config.toml` |
| Claude Code | local stdio MCP via `claude mcp add-json --scope user` |

**This table describes the PRODUCTION channel — the `alpha` and `latest`
dist-tags — and only that.** Since [#2421](https://github.com/d-hinders/Haven-AI/issues/2421) a push
to `dev` also publishes a snapshot of all five packages under the **`dev`**
dist-tag at `0.0.0-dev.<YYYYMMDDHHMM>.<shortsha>`, so `npx @haven_ai/connect@dev`
installs a different set of versions from the ones above. That is not drift and
this table is not stale when it happens:

- the snapshot bump runs in a **throwaway CI tree**. It rewrites this table
  there, exactly as a release does, and the tree is discarded — nothing is
  committed to `dev`, so the committed table keeps naming the production
  versions. There is deliberately **no docs check run against the snapshot
  tree**: it would be checking a file nobody will ever read.
- a snapshot's four `@haven_ai/*` rows are *internally* consistent for the same
  reason a release's are — one bump script rewrites every version, pin and
  constant together. `npx @haven_ai/connect@dev --version` prints the snapshot
  version, and the signer and SDK it installs carry it too.
- `0.0.0-` sorts below every real version, and the two channels cannot cross:
  a snapshot can reach neither `alpha` nor `latest`, and the `main` path
  refuses a `0.0.0-dev.*` version outright. The enforcement points are named in
  the header comment of `.github/workflows/publish.yml`.

The **version-skew contract below is unchanged by the dev channel**, and reads
the same on both: a signer must be paired with a backend that emits an
`x402_expected_context_version` it knows. What the `dev` tag adds is the ability
to test that pairing before a production release rather than after one. How to
run that test — merge, wait for the run, poll `npm view`, install against the
dev backend, `--doctor` — and the owner steps that make the dev dashboard hand
out `@dev` are in [`package-dev-channel.md`](package-dev-channel.md): this doc
is the contract, that one is the runbook.
### The connector channel is a fifth bump-managed constant (#2423)

Every connector hint the published packages emit — the setup re-run
`npx @haven_ai/connect@<tag>` in `@haven_ai/connect`'s doctor, repair, re-key
and tombstone messages, and, since #3412, the upgrade command
`npx -y @haven_ai/connect@<tag> --doctor` in the signer's capability text and
its version-skew refusal and in the SDK's shared `SIGNER_UPDATE_FALLBACK` —
renders from a single build-time constant,
`HAVEN_CONNECTOR_CHANNEL` in `packages/sdk/src/connector-channel.ts`.

**Do not hand-edit it either.** `npm run release:bump` writes it from the
version being cut, by the same rule `.github/workflows/publish.yml` uses to
choose `npm publish --tag`:

| version | channel |
| --- | --- |
| `0.1.34-alpha.0` | `alpha` |
| `0.0.0-dev.<ts>.<sha>` | `dev` |
| `0.2.0` | `latest` |

Read as one sentence: a prerelease publishes under its own prerelease label, a
stable version under `latest`.

**That is the `--tag` this table is about, and #2536 did not change it.** What
#2536 added is a SECOND tag move afterwards: a prod-channel prerelease also
gets `latest` pointed at it, so a bare `npm install` / `npx` — which resolves
`latest` and never the highest version number — stops serving a build from
months ago. The prerelease tag stays, so `@alpha` still resolves, and
`HAVEN_CONNECTOR_CHANNEL` (the tag the packages tell a user to re-run) is
derived from `--tag` and is therefore untouched. The table above remains the
rule for `npm publish --tag`; it is not the whole set of tags a released
version ends up carrying.

**That second move did not actually work until #2647, and it now lives in a
different job.** #2536 put `npm dist-tag add` inside the publish job, which
authenticates by npm Trusted Publishing (OIDC) — a credential that authorises
`npm publish` and nothing else. The 0.1.35-alpha.0 release was the first
promotion to execute it: all five packages published under `alpha`, and all
five tag moves failed E401, leaving `latest` on `0.1.34-alpha.0`. The repair
moves the tag mutation into a separate `main`-only `promote-tags` job holding a
long-lived granular token, scoped by the `npm-production-tags` GitHub
Environment. Two consequences for a reader of this table: the `--tag` rule
above is still exactly as stated and still runs on the OIDC credential, and a
promotion can now be **half green** — packages published, `latest` not moved —
which reads as a failed `promote-tags` job rather than a failed publish. The
token expires 2026-12-06 and npm offers no non-expiring option, so that is a
dated maintenance obligation, not a solved problem.

Two guards keep the `--tag` halves honest, and they
fail differently. `scripts/release-bump.test.mjs` **executes** the workflow's
own `case` block in `bash` and compares its answer to the bump script's for the
same versions, so a rewritten-but-equivalent workflow passes and a
rewritten-and-different one fails; the same suite compares the constant on disk
against `packages/sdk/package.json`'s version on every pull request, which is
what catches a bump that stopped writing it. `scripts/verify-connect-bundle.mjs`
then checks the BUILT SDK by calling its helper, catching a stale
`packages/sdk/dist` that would ship hints for the previous channel — the same
failure the `mcpVersion` check above exists for, one constant over.

**The hosted MCP server is the exception, because it is deployed rather than
published.** It reads the `HAVEN_CONNECTOR_CHANNEL` **environment variable** at
startup and falls back to the SDK constant, so an unconfigured deployment names
the production channel exactly as before. A malformed value refuses the boot
rather than falling back — a silent fallback would put the production connector
in front of a deployment that looked configured. Which value any given
environment sets is an operator action this repository cannot observe and does
not record here.

## Hosted-runtime connector profiles

The SDK's parsed v2 payment requirements retain the merchant's advertised
`maxTimeoutSeconds`, floored to an integer, for the `accepted` echo (#3117). SDK and local signer
still bound the signed authorization lifetime separately; an offer can match
its echo yet exceed that lifetime at facilitator verification. This changes
neither tool arguments nor the funding-binding contract. Existing credentials
and signer/backend combinations require no migration.

For the hosted fast-settle path, the local signer may produce either the
supported legacy x402 v1 envelope or the current v2 `{ x402Version, resource?,
accepted, payload, extensions? }` envelope — since #2361 the signer echoes the
merchant challenge's `resource` and `extensions` verbatim when the challenge
carries them (the extensions echo is an x402 v2 spec MUST, and a strict live
facilitator rejects its absence, #2360), so a v0.1.33-or-earlier signer's
echo-less three-key envelope and the current echoing one are BOTH accepted.
Hosted MCP validates either recognizable form against the persisted intent
before it relays funding — the echoes are checked structurally, never against
the intent, since they are merchant data rather than spend authority. A
malformed, unsupported, expired, or mismatched header returns
`INVALID_PAYMENT_HEADER` with no funding relay; recreate it through the local
signer from the same `payment_id`. This preflight does not replace merchant or
facilitator verification.

The default Connect topology writes a keyless hosted Haven MCP entry plus a
separate local signer stdio entry. Since #3737 that is a named pair by default
(`haven-<slug>` / `haven-signer-<slug>`), and the bare `haven` / `haven-signer`
pair only when `--bare` or `--replace` is given without `--name`. It is distinct from the local-stdio
runtime described above. Hermes Agent is a supported hosted-runtime profile:
Connect writes `$HERMES_HOME/config.yaml` and its matching owner-only `.env`
when `HERMES_HOME` is set, otherwise `~/.hermes/config.yaml` and `.env`. The
hosted API key stays in `.env`; config uses the `Bearer ${<the pair's env key>}`
template, where the key is `MCP_HAVEN_<SLUG>_API_KEY` for a named pair (the
default; the slug upper-cased, hyphens as underscores) and `MCP_HAVEN_API_KEY`
for the bare pair. Connect preserves source text outside `mcp_servers` and
replaces only this agent's own two `mcp_servers` entries: `haven-<slug>` and
`haven-signer-<slug>` for a named pair, or `haven` and `haven-signer` for the
bare pair.
Hermes discovers MCP servers at process startup, so start a new session (or run
`/restart` for a gateway). Hermes also needs its Python MCP SDK installed (`pip
install mcp`) to load MCP tools.

## Runtime selection is detection-first (#1672)

Which runtime's config the connector writes is resolved in
`packages/connect/src/runtime-registry.ts` (`resolveRuntimeSelection`), in this
precedence order:

1. `--runtime-force <name>` always wins (an unknown name refuses, listing the
   valid values).
2. Environment detection (`CLAUDECODE`/`CLAUDE_CODE`/`CLAUDECODE_CWD` →
   claude-code, `CODEX_SANDBOX`/`CODEX_HOME`/`CODEX_CWD` → codex-cli,
   `VSCODE_CWD`/`VSCODE_IPC_HOOK_CLI` or `TERM_PROGRAM=vscode` → vscode,
   `HERMES_HOME`/`HERMES_AGENT` → hermes) **beats a contradicting `--runtime` hint**, with a
   printed one-line notice. Detection only fires inside a real agent shell,
   where writing a different client's config is almost surely wrong — the
   failure this closed was a `--runtime claude-desktop` hint pasted into
   Claude Code, which would have configured the Desktop chat app and left the
   Code session with no Haven entries.
3. An explicit `--runtime` with no contradicting detection applies as given —
   the plain-terminal "configure Claude Desktop by hand" case, unchanged.
4. Detection alone.
5. **The agent's own answer (#1719).** When nothing was detected, an agent
   executing the command may say which harness it is — by re-running the
   command once with `--runtime <name>` added. It enters at rung 3's
   precedence, which is the whole reason it is safe: a self-report can only
   fill a vacuum, and loses to a detection exactly as a typed hint does. The
   dashboard's setup prompt permits that one retry explicitly (see below), and
   the refusal at rung 7 is written as an instruction to the agent rather than
   to a human.
6. **The clients installed here (#1719).** When nothing was detected and stdin
   is an interactive terminal, the connector scans for agent clients — the
   config files it can actually write (`~/.codex/config.toml`,
   `~/.cursor/mcp.json`, the VS Code / VS Code Insiders user `mcp.json`, a
   workspace `.vscode/`, Claude Desktop's `claude_desktop_config.json`,
   `$HERMES_HOME/config.yaml`) plus the clients it configures through their
   own CLIs, seen as directory markers only: Claude Code (`~/.claude`,
   `~/.claude.json`), which is wired via `claude mcp add-json` and is never
   configured by writing a file — so those paths are EVIDENCE, never write
   targets (an earlier revision of this paragraph wrongly listed `~/.claude`
   among the config locations the connector writes; corrected in #3732).
   Since #3732, a `~/.claude.json` that carries an `mcpServers` key counts as
   config-file evidence for Claude Code — so a machine with both a Claude
   Code MCP config and a Codex config ties, and produces NO suggestion,
   instead of suggesting Codex by construction. Candidates are offered
   likeliest first — an existing MCP config outranks a bare client
   directory — and the list may mark one client `(suggested)`, but the
   prompt **never pre-selects**: an empty answer re-asks and, after three
   attempts, aborts with nothing written and the setup token unused
   (#3732's owner decision, matching the wiring-collision prompt). The scan
   **populates the choices; it never selects** (the #1719 invariant — pinned by
   [`packages/connect/src/installed-clients.test.ts`](../../packages/connect/src/installed-clients.test.ts)
   "NEVER selects for the user", #2680). Finding exactly one installed app still prompts, because an
   installed app tells you what exists, not where the user wants their agent to
   run, and a silent wrong write plants an API key and a delegate key in an app
   they do not use. The chat app's row reads "Claude Desktop (chat app)" so a
   user in the desktop app's Code tab cannot mistake it for where they are.
   This rung is **omitted entirely** — not answered — under
   `--json` and whenever `process.stdin.isTTY` is false, so CI and automation
   reach the refusal instead of blocking on stdin.
7. Nothing known → the connector **refuses before any side effect** (the
   #1161 discipline: no half-created agent, no burned setup token), naming
   the valid `--runtime` values.

An `--runtime` value that is not a runtime name at all is not a hint, it is a
mistake, and it must never fall through to a config location nobody asked for.
With no detection to fall back on it refuses (`runtime_unrecognized`). With a
detection it loses to it *loudly* — a printed notice naming the value that did
nothing — because the detected client is the right write either way, and
refusing there would turn every rollout window in which the dashboard learns a
picker id before the published connector does into a hard failure.

### Failure vocabulary for runtime selection (#1719)

Each of these is a stable `code` with a next action, raised as a `ConnectError`
and surfaced through `--json` as `error.code` / `error.next_action`. They are
additive and never renamed.

Since [#2091](https://github.com/d-hinders/Haven-AI/issues/2091) the `--json`
failure record also carries (additively, still `schema_version` 1):

- `error.message` — the redacted refusal prose, for every `ConnectError`. Only
  the connector-authored vocabulary is serialized; a plain `Error`'s message
  (which can carry arbitrary server/filesystem detail) stays out of the JSON.
- `error.allowed_runtimes` — on the three runtime-selection refusals
  (`runtime_undetermined`, `runtime_unrecognized`, `runtime_force_unrecognized`),
  the exact `--runtime` values a retry may use, as an array. The values used to
  live only in the prose, which `--json` discarded — while the backend's setup
  prompt permits a retry only with "one of the values that refusal lists". A
  Codex agent followed both rules and deadlocked; this field is what makes the
  rung-5 self-report reachable from automation.
- On every `--json` failure path the redacted message is also **mirrored to
  stderr** (stdout stays one pure-JSON line), so the prose channel is never
  silently discarded.

Since [#2174](https://github.com/d-hinders/Haven-AI/issues/2174), a
`runtime_undetermined` refusal also carries what the installed-client scan
found on **this machine** (additive, still `schema_version` 1):

- `error.installed_clients` — runtime ids the scan found, likeliest first. This
  is the same rung-6 scan described above, whose interactive prompt `--json`
  deliberately omits; before this the finding was thrown away in automation,
  leaving a retrying agent to pick from the nine-value `allowed_runtimes` menu
  on self-knowledge alone. `allowed_runtimes` says what is *permitted*;
  `installed_clients` says what is *here*.
- `error.suggested_runtime` — the top hit, and only when it is unambiguously
  top: a lone candidate, or a single live MCP config file among bare client
  directories. Since #3732, a `~/.claude.json` carrying an `mcpServers` key
  is config-file evidence for Claude Code — so a machine with both a Claude
  Code MCP config and a Codex config ties, and NO suggestion is offered,
  where before Codex won by construction. Two candidates in the same evidence
  tier are separated only by the scan's fixed order, which is a preference
  rather than a fact about the machine, so no suggestion is offered there.

**The scan populates choices; it never selects.** This is #1719's invariant and
it is unchanged: a `suggested_runtime` is a value the agent may echo back as
`--runtime`, never a selection the connector makes. The interactive prompt
follows the same rule and is stricter still (#3732): it never pre-selects —
an empty answer re-asks, and after three attempts aborts with
`runtime_prompt_aborted` having written nothing — even when the scan found
exactly one client. Finding exactly one
installed client does **not** flip the outcome to success — an installed app
tells you what exists, not where the user wants their agent to run, and the
cost of being wrong is an API key and a delegate key written into an app they
do not use. The outcome stays `failed` with
`rerun_connect_with_explicit_runtime`, and the retry stays explicit.

Both fields are **absent** when the scan found nothing *or* could not run: the
scan is best-effort and read-only (filesystem existence checks, before any
setup token is resolved and before any key or credential exists), and a scan
error degrades to the un-hinted refusal rather than replacing a precise refusal
with a filesystem error. An empty array is deliberately not emitted — it would
assert a finding that neither case made. The prose message names the same
clients, so the human and machine channels cannot disagree about one machine.
`runtime_unrecognized` and `runtime_force_unrecognized` are unchanged: the hint
answers "nothing is known", not "what you named is wrong".

Additionally, a dead setup token (the backend's 410 "Setup token expired" —
the token's TTL is 30 minutes — or 401 "Invalid setup token") is now
classified as `setup_challenge_expired_or_invalid` with next action
`return_to_haven_for_fresh_setup`, instead of degrading to the generic
`connect_failed` because the wording missed a legacy regex. The check runs at
both token-bearing calls, `resolveSetup` and `registerSetup` — the TTL can
lapse in the gap between them. Per the #1719 rule, the failure mode joined
the `ConnectError` vocabulary rather than the regex ladder.

| Code | When | What to do |
|---|---|---|
| `runtime_undetermined` | Nothing detected, no `--runtime`, no self-report, and no interactive terminal (CI, `--json`, a pipe) | Re-run with `--runtime <name>`; `other` stores credentials and prints the manual MCP steps |
| `runtime_unrecognized` | A supplied `--runtime` / self-report is not a runtime Haven knows, with no detection to carry the run | Re-run with one of the listed values — never a guessed one |
| `runtime_force_unrecognized` | `--runtime-force` names something unknown | Re-run with a valid name |
| `runtime_no_installed_clients` | Interactive terminal, but no client Haven can configure is installed | Re-run with `--runtime <name>`, or `other` |
| `runtime_prompt_aborted` | Ctrl-C / EOF at the prompt, or three invalid answers | Re-run and choose, or pass `--runtime` to skip the prompt |
| `runtime_config_unreadable` | The chosen client's config file exists but is not parseable JSON/YAML | Fix (or move aside) the named file, then `--doctor --repair --runtime <name>` — **not** the connector command |
| `wiring_collision` ([#2551](https://github.com/d-hinders/Haven-AI/issues/2551)) | A **bare** setup — `--bare`, or `--replace`; since [#3737](https://github.com/d-hinders/Haven-AI/issues/3737) a default setup names its own pair and never lands here — on a machine whose credential root already holds a bare-pair directory with a usable key — what `--doctor` calls `wired` or `superseded` — and no interactive terminal to ask | **Relay to the human**, who chooses: re-run with `--replace` (re-point `haven` / `haven-signer`, retire the previous directory locally) or with `--name <slug>` (install alongside; `error.suggested_name` proposes one). An agent following the setup prompt must not add either flag itself |
| `wiring_collision_declined` | The same collision at an interactive terminal, and the user chose neither | Re-run with `--replace` or `--name <slug>` |

The first five refuse **before any side effect**, so there is nothing to
recover from: no agent registered, no key minted, no credential written, and
the setup token still unused — each pinned by a mutation-proof test. Because
they precede the setup-token resolve, they are also the connector's exit
contract only: with no agent and no API key there is no authenticated channel
to report them on, so they never appear in the dashboard's `install_status`.

The two `wiring_collision` codes are the same shape one step later: they fire
**after** `/resolve` (the connector has read the setup, so the dashboard may
already show the detected runtime and the agent's name is what the proposed
`--name` is derived from) and **before** `/register`, so still no agent, no
key, no credential, and the token still unused — the resolve is not what
consumes it. The check reads only the local credential root, in the doctor's
own terms: `retired`, `orphaned`, `parked` and **named** directories never
trigger it, and a `--name` run is never asked, because a named pair displaces
nothing (#1695). Two things it deliberately is not. It is not a flag an
agent may add on its own initiative: the refusal's own message says *relay
this to your user; do not add a flag yourself*, and the setup prompt agrees.
Since #3689 the prompt names this case: once the user has answered the relay,
the agent may re-run once with the one flag the user chose (`--name` or
`--replace`), keeping `--json` and any `--runtime` already added. Before
#3689 the prompt allowed only `--json` and the runtime retry, so it forbade
the re-run the refusal asked for.

**A connector run invoked by `haven agents connect --run` (#2527) adds exactly
`--json` and nothing else** (pinned by
[`packages/cli/src/commands.test.ts`](../../packages/cli/src/commands.test.ts)
"exactly --json appended", #2680). The CLI splits the `connector_command` the backend
returned and appends that one flag; it never rewrites `--api`, never composes a
command of its own, and deliberately has no `--replace` or `--name` of its own
to pass down. The second permitted change, `--runtime` after a runtime refusal,
is likewise not something the CLI applies: it surfaces the refusal with its
`next_action` intact and exits 4, because choosing a runtime — like choosing
between replacing an existing wiring and installing alongside it — is the
human's decision, and the refusal is a relay instruction. That is the same rule
the paragraph above states for an agent reading the setup prompt; the CLI is
one more caller of it, not an exception to it. **Two different `--api` flags meet
here and they are not the same one (#2590):** the connector command carries the
backend URL the setup response chose, which the CLI passes through untouched, while
`haven --api` selects the backend the CLI's *own* calls talk to. The second has a
default and the first never does — `DEFAULT_API` in `packages/cli/src/commands.ts`
is Haven's hosted production backend, so a `haven` command run against another
deployment without `--api` or `HAVEN_API_URL` reaches production rather than
failing. That is a property of the CLI's own session, not of anything it hands the
connector, and nothing in this paragraph changes because of it. And it is not a revoke: `--replace` retires the
superseded directory **locally** (tombstone, then the unconditional key-material
teardown — `--unwire` itself now runs that teardown only when its #3123 probe
says there is nothing to preserve; `--replace` does not probe — only once the
runtime install actually completed — a failed install skips it and the outcome
says so), and the owner still ends it with **Remove agent…** on the Haven
agent page. The revoke route is owner-authenticated; the connector holds agent
keys only. Since #3542 the dashboard's revoke of a superseded agent also ends
its budget with one owner signature (`revoke-all`); a revoke that stops at the
credential leaves the agent marked "budget still active" with a Finish revoking
action. Since #3544 the same revoke also retires a connect-modal agent still
`pending_approval` — the owner can cleanly Remove an agent whose connect flow
never finished instead of leaving it dangling — and the revoke transaction
cancels the agent's open connection setup, so a connector half-way through that
setup can no longer carry its `budget-approval` to an approved budget for a
revoked agent; the approval answers the route's typed refusal instead (404, or
409 with an `error_code`: `already_revoked` is "done", anything else is a real
refusal). Installed CLIs are unaffected: 404 and 409 map to the same exit
class. Nothing the connector sends or does changes.

`runtime_config_unreadable` is the exception, and the only one of the eight that
reaches the dashboard (`runtimeStatusHelper`). The routing of the six
`runtime_*` codes is pinned by
[`packages/frontend/src/components/connect-agent/__tests__/runtime-status-copy.test.ts`](../../packages/frontend/src/components/connect-agent/__tests__/runtime-status-copy.test.ts)
(#2680); the two `wiring_collision` codes precede `/register` and never reach
the dashboard (`setup-copy.ts`, where the dashboard routes connector error
codes, names neither). It happens after credentials
exist, during the config write. It is deliberately distinct from its
retryable sibling `runtime_config_write_failed` — an unparseable config fails
identically on every re-run until the file itself is fixed. Parsing happens
**before** the write, so the file is left byte-identical. Codex keeps its own
older `codex_config_invalid` for the same class.

Its recovery is `--repair`, **not** a re-run of the connector command, and the
reason is the ordering: this failure lands after `registerSetup` consumed the
one-shot setup token, so the pasted command now 409s at `/resolve`, and
starting a fresh connection instead would mint a SECOND agent
([#1688](https://github.com/d-hinders/Haven-AI/issues/1688)). `--repair`
rewrites exactly this config from the credentials already on disk — no token,
no new agent — so it is what both the connector's message and the dashboard's
status helper point at.

Accordingly, the dashboard's generated connector command carries **no `--runtime`
flag at all** ([#1720](https://github.com/d-hinders/Haven-AI/issues/1720)).
Every user gets the identical command; the connector resolves the runtime with
the ladder above and reports it back through the setup status, and the
dashboard's runtime-specific copy keys off that reported value. Two known
detection limits: Codex Desktop's environment detects as `codex-cli` — both
write the same `~/.codex/config.toml`, so the config lands correctly and only
restart phrasing can differ. And **Codex commonly detects as nothing at all**
([#2091](https://github.com/d-hinders/Haven-AI/issues/2091)): the `CODEX_*`
variables rung 2 sniffs are only present for sandboxed commands (or a
customised `CODEX_HOME`), and `npx` needs network, which Codex runs escalated
— outside the sandbox. An undetected-Codex run reaching the rung-7 refusal is
therefore the *expected* Codex path, and the `--runtime codex` self-report
retry (rung 5) is its designed continuation, which is exactly why the refusal
must stay actionable under `--json` (below).

### There is no picker (#1720)

The dashboard asks nothing about the runtime. It never had a way to answer:
a browser sees no environment markers, no installed clients and no live agent,
while the connector sees all three. So the question moved to the component that
can answer it, and every user now gets a **byte-identical** connector command.

`#1682` had made the picker a flat list of nine product names, replacing
`#1672`'s single collapsed "AI agent (Claude Code, Codex, Cowork)" row. That
row asked users to classify their own app — a question a Hermes or OpenClaw
user answers "yes, mine is an AI agent" and gets wrong. The named rows fixed
the mis-classification; `#1720` removed the question. The row → modality
mapping `#1682` introduced is what made this safe to reason about, and the rows
themselves were transitional.

The **id vocabulary survives the picker**, because ids still arrive from two
places that are not a user's choice:

| id | Meaning now |
|---|---|
| `claude-code`, `codex`, `codex-cli`, `codex-desktop`, `cowork`, `agent` | reported by the connector after detection; `cowork` is an alias resolving to `claude-code` |
| `claude-desktop`, `cursor`, `vscode`, `vscode-insiders`, `openclaw`, `hermes`, `other` | reported by the connector after a self-report, a prompt, or an explicit `--runtime` |

The backend still **accepts and stores** a `runtime` an older client sends, so
setup rows created before this change keep reading back correctly; it simply
never spells one into the command. An explicit unsupported runtime is still
refused for `local_mcp`, where the answer is known at setup time.

**What this cost, deliberately.** The consent text a user approves before
anything runs is now generic — "update the local agent MCP config when
supported" for everyone, where it once named `~/.codex/config.toml` or the
Hermes `.env`. A universal prompt cannot be specific about a runtime it does
not know. This is a real loss of precision, bounded by the fact that it is
already what every command-path user saw.

The Hermes-specific block that used to ride in the dashboard prompt is gone
with it. Its substance is emitted by the connector itself once Hermes is
configured — restart guidance including `/restart` for gateway users,
`hermes mcp list` / `hermes mcp test`, and the `pip install mcp` fallback —
which is both later and better placed. The one line without a connector
counterpart, "do not run `hermes mcp add`", is subsumed by the prompt's
universal rule limiting which changes to the command are permitted (two at
the time; three since #3689, which added the user-chosen `--name`/`--replace`
re-run after a `wiring_collision`).

**OpenClaw needed a published connector, and now has one.** The `openclaw`
alias lives in `runtime-registry.ts`, and `npx @haven_ai/connect@alpha`
resolves to whatever is on npm — so the alias shipped only with release
`0.1.29-alpha.0`. Note what that required: a Railway/Vercel deploy is NOT
enough, because `publish.yml` skips any version already on npm, so an alias
ships only behind a `npm run release:bump`. The alias resolves `openclaw` to
the `other` profile, because "credentials on disk, no auto-written config,
paste the snippet" IS the OpenClaw flow. An id the published connector does not
know still refuses before any side effect — since #1719 as
`runtime_unrecognized`, naming the values it does know.

Pre-run, the dashboard knows nothing about the environment, so the "your app
may ask you to approve running the connector command" heads-up shows for everyone
during the waiting state, sharpening to app-specific wording once the
connector's resolve reports the detected runtime. `--repair` still requires
an explicit `--runtime` (it rewrites a stored config, which is a choice, not a
detection); since #3210 `--doctor` needs none and resolves the runtime from
the setup record.

**A failure the dashboard cannot name.** The runtime-resolution refusals above
(`runtime_undetermined`, `runtime_no_installed_clients`, `runtime_prompt_aborted`,
`runtime_unrecognized`) all fire *before* the connector contacts Haven, so no
setup row records them and the modal has nothing to render. It falls through to
the waiting state's recovery block, which since #1720 sends the user to the
connector's own output — which does name the problem — before suggesting a
re-run, because a re-run reproduces that refusal exactly.

## Guidance surfaces (skill parity, #1332)

Setup also installs the generic, secret-free payment skill wherever the
runtime has a documented instruction mechanism. The substance is the single
canonical string in `packages/sdk/src/skill-content.ts` on every runtime —
only the wrapper differs, never the content:

- **Claude Code** — `~/.claude/skills/haven-pay/SKILL.md` (canonical bytes).
- **Hermes** — `$HERMES_HOME/skills/haven-pay/SKILL.md` (default
  `~/.hermes/skills/…`); Hermes auto-discovers SKILL.md skills in the same
  front-matter format, so the file is byte-identical to the Claude install.
- **Codex CLI / Codex Desktop** — a marker-delimited managed section in the
  global `~/.codex/AGENTS.md` (Codex's documented global-guidance file, shared
  by both). The section carries the skill body without front matter
  (`HAVEN_SKILL_BODY_MD`); re-runs replace the section in place, everything
  outside the markers is preserved byte-for-byte, and a damaged marker pair
  makes the write fail closed with the file untouched. `AGENTS.override.md` is
  never written.
- **Every other runtime** (Cursor, VS Code, Claude Desktop, `other`) — no
  documented instruction file; the MCP server-level initialize instructions
  carry the baseline guidance and nothing is written.

Since #2537 that string carries an **Onboarding and setup** section as well as
the paying one, for the agent asked to connect a second agent or set a
colleague up: it names `haven login` and `haven agents connect`, says that none
of the payment tools can create authority, and quotes the connector rules
(approval relay, permitted command modifications, wiring collision) verbatim
from `packages/sdk/src/agent-guidance.ts` rather than restating them, so the
skill and the backend setup prompt cannot drift apart on a rule an agent meets
in both.

A guidance write happens only when the runtime config write itself succeeded,
and a failed skill install never fails the setup — the messages point at the
dashboard download instead.

## Completion handoff after Connect

The published `haven-connect` package is also checked through the npm bin
topology: the package smoke test invokes its packed `node_modules/.bin`
symlink, not only `node dist/cli.js`. This matters because Node keeps the
symlink path in `argv[1]`; Connect resolves it before deciding whether it is
the program entrypoint. A command that exits with no output before it creates
the local files has not registered an agent and must not be described as a
completed connection.

The connector's final output is deliberately short, ordered, and — since #1542
— shaped by what its own approval wait observed. When the budget is still
pending (or the wait was skipped): return to Haven to approve the budget first,
activate the current runtime second, then run the read-only `haven_get_agent`
and `haven_get_allowances` tools to confirm the Haven wallet and live budget.
Approval — not a restart — unlocks Haven tools. When the wait itself saw the
approval land, the handoff confirms it instead of re-requesting it — the
connector never celebrates the approval and then instructs the user to go
perform it — and only the activation and verification steps remain. When the
setup ended in Haven during the wait, the single next step is a fresh
connection from the dashboard. One name for the gate throughout the
connector's output: the **budget** (never "agent rules"). The activation step
for restart-bound runtimes also states why it survives the connector's own
in-process verification: session/app-scoped runtimes only read MCP config at
start-up. The verification must not sign, fund, or create a payment.

Since #1377 the connector does not go silent after registering, and since
#1543 the budget-approval unlock no longer waits for the whole install: the
moment the runtime MCP config write settles — before the network probes and
the skill install, whose tail approval does not depend on — the connector
sends an early, best-effort install-status report carrying the config-write
facts (configured/consent booleans, restart and next-action state; no probe
verdict, no skill state), which is what the dashboard's approval unlock
actually reads. When that early report is DELIVERED, the connector prints an
imperative approve-the-budget call-to-action at that exact moment
([#2279](https://github.com/d-hinders/Haven-AI/issues/2279) — the field
failure was a user watching the live dashboard button for minutes while the
terminal ran the install tail in silence). Two things silence the CTA, for
two different reasons: an early report that never arrived (the button may
not be live yet — though the unlock itself accepts a delivered report in
either state, clean or errored), and a delivered errorCode whose completion
handoff will say "start a fresh connection" (a fresh connection mints a NEW
agent, #1688, so "approve now" would spend the approval on a setup the run
is about to disown — `manual_runtime_setup_required` is the errorCode whose
handoff still recommends approving, and it keeps the CTA). Known limitation,
inherent to the two-report design: the CTA fires before the probes, so a
probe failure discovered after it can still end the run in fresh-connection
guidance — the early report is explicitly a bet that the probes will turn
out fine, and delaying the CTA past them would recreate the silence #2279
exists to close. In the silent
cases the instruction first reaches the user with the wait flow
below. After probes and skill install finish it makes the complete
install-status report — still the authoritative one, refining the same keys
with probe verdicts and skill state, and the fallback unlock path when the
early report failed (either report's failure is silent and cannot activate an
agent or change budget authority). It then polls the narrow read-only
`connector-status` endpoint (pending agent
API key, usable while `setup_pending`-scoped) and waits for the budget approval
— an immediate first check (#1542: users routinely approve while the install
is still running, and the "waiting for you to approve" line is only printed
once a check has actually observed a pending state, never ahead of a first
check that may find the wait already over), then every 5 seconds, for at most
3 minutes, with a progress reminder every 30 seconds that states elapsed time,
the poll cadence, and the give-up bound (#2279 — so a watcher can tell active
polling from a hang, and the bound is visible before it fires; the waiting
line itself is phrased as status, since the CTA above already carried the
ask). A failed report remains
readiness metadata only: it cannot activate an agent or change any budget
authority. On approval it prints a celebratory line
naming the granted authority (amount, token, reset period); on a terminal setup
status it says the setup ended in Haven; at the bound it exits cleanly with
"approve whenever ready" guidance — the connector always terminates on its
own. A flaky poll is retried inside the same bound, never treated as a verdict.
`--json` automation runs skip the wait entirely so the structured outcome is
emitted promptly.

Before registration, the dashboard stages what it says about a missing
connection over three periods, in one status slot that is never empty (#1399).
Before the setup prompt is copied it says the screen advances by itself once
the agent connects; once it is copied (#3832), it says it is waiting for the
agent to run the connector command, and only then does the one-minute line
below appear. Once server credentials are issued (#2482), it says instead to
save them and continue to wallet approval, and the recovery state below does
not show. After one minute of a confirmed `awaiting_connection` it acknowledges
that a first run downloads the connector before it can register — an
observation, not a warning: it offers no recovery actions and does not suggest
anything is wrong. After **three minutes** of confirmed `awaiting_connection`
it says Haven has not received a connection yet — whether or not the prompt
was copied — asks the user not to approve the budget yet, offers the same local command for copying, and lets them cancel
the one-time setup before creating a fresh prompt. A status-read error resets
the clock rather than advancing it: it remains an error state, not evidence
that the connector succeeded or failed.

That three-minute bound is sized against a cold `npx` download on a poor
network — the case that most often strands this screen — and is not tied to
anything else. It happens to equal the connector's approval wait described
above, but the two are **not** coupled and must not be reasoned about as a
pair: `waitForBudgetApproval` only starts once `registerSetup` has succeeded,
and a successful register moves the setup to `connected_local`, which is
precisely the transition that ends the dashboard's `awaiting_connection` clock.
The two govern disjoint phases and can never run concurrently, so either can be
retuned on its own evidence. They live in `AWAITING_CONNECTION_RECOVERY_MS`
(`packages/frontend/src/hooks/useAgentConnectionSetupStatus.ts`) and
`waitForBudgetApproval`'s `timeoutMs` default (`packages/connect/src/runtime.ts`).

Automation can pass `--json`: Connect keeps progress and recovery prose on
stderr and emits one parseable, versioned object on stdout. `schema_version: 1`
is the stable contract; `outcome` is `complete`, `action_required`, or
`failed`. The record carries runtime/topology, configuration and probe state,
activation, next action, approval and any approval expiry, read-only
verification guidance, and — since #2173, additive within the same
`schema_version` — `hosted_mcp_url` and `superseded_agent_ids`; since #2551,
also additive, `superseded_agents_retired_locally` and `retired_agent_ids` on a
run that replaced existing wiring (the latter names only the collision set that
was actually retired — `superseded_agent_ids` is every other directory, named
agents included, so the boolean is never to be read against it) — since #3259
joined, additively, by `retirement_mirror_errors` (agent id → errno code) only
when a retired directory's surviving ledger record could not be written — and
`error.superseded_agent_ids` / `error.suggested_name` on a `wiring_collision`
refusal; since #3122, also additive, `existing_agents_before_write` (always
present on a completed run — the other live-keyed directories, named BEFORE the
first write, with the account each spends from; a subset of
`superseded_agent_ids`, which also names key-less and tombstoned directories)
and `server_name_rebound_from`
(only when the run took a server name over from another directory's local
`mcp-server-binding.json`, with `backend_changed`; since #3772, when a run
re-points wiring another agent held — such a rebind, or any `--replace` — and
its install completed, `activation.instruction` also says that a session
already running keeps acting as the previous agent(s) until it is restarted,
and that they may still be active in Haven — text appended to an existing
string field, no new key. Since #3772 part 1, such a `--replace` also posts
the ids it actually retired (never `superseded_agent_ids`) to
`POST /agent-connection-setups/{setupId}/retired-agents` with the new agent's
key, accepted only within 30 minutes of the setup's registration; Haven records each as superseded by the new agent, and that agent's own
`haven_get_agent` / `haven_get_allowances` then carry `supersededBy` with a
restart-and-remove warning. Best-effort — an older backend's 404 is ignored
silently, any other failure is one log line, and the outcome carries no new key); and since #2528, also
additive, `approval.url` — the absolute link to
this setup's budget approval, echoed from the register response and present
only when `approval.required` is true AND the backend is new enough to return
one, so a consumer must test for the key rather than assume it. The connector
never synthesises that link: the outcome carries no setup id, so there is
nothing to assemble one from, and the guidance sentences tell an agent to relay
the whole link or none. It is
redacted by construction: no API/private keys, credential contents, full
credential paths, or full delegate address are serialized. Library callers use
the same object at `runConnect(...).outcome`.

Activation is owned by the Connect runtime registry. Claude Code needs a new
session; Codex CLI can start a fresh session with `codex resume --last`; Codex
Desktop and Claude Desktop need a full app restart; Cursor and VS Code hot
reload; and Hermes needs a new session or `/restart` in Gateway. An unknown
runtime is the only manual case: Connect cannot write its configuration, so use
the secret-free file references it prints and then start a fresh session.

If a setup challenge has expired, return to Haven for a fresh connection and
rerun Connect. If a package install, runtime configuration, or MCP probe fails,
use the structured `error.code` and `error.next_action` (or the matching human
recovery note). Never manually edit runtime configuration or paste credentials
into prompts, logs, or configuration. The `other` runtime is intentionally
`action_required`: finish the secret-free manual setup references, then start a
fresh runtime session; do not request another one-shot setup solely because the
runtime is unrecognized.

Normal Connect output abbreviates the public delegate address. For an operator
diagnostic that needs the full public identifier, use the owner-only, non-secret
`agent.json` orientation file Connect reports. Never inspect or share
`identity.json` or `signer.json` for that purpose: they contain credentials.

### The hosted MCP endpoint is not the `--api` backend URL (#2173)

`hosted_mcp_url` is the endpoint Connect wired this run up to — written into
the runtime's MCP config, or, on a manual runtime Connect cannot configure,
printed as the endpoint to enter by hand. It is **deliberately a different
deployment** from the backend URL passed as `--api`: the hosted MCP server runs on its own service. A caller that
compares the two and finds them different is looking at intended topology, not
an environment mismatch — which is exactly how a field run read it before the
field existed, because the wired endpoint appeared nowhere in the outcome. The
value is non-secret: the same string already sits in the user's own MCP config
file, and the API key travels beside it in a header, never in the URL.

`superseded_agent_ids` makes the #1688 heads-up structural. A re-run mints a
NEW agent and, without `--replace` (#2551), retires nothing, so the other
credential directories keep their live API and signing keys; the ids of those
other directories are now in the record
instead of only in stderr prose. It is every other directory, not a replace
set (#3830): under named pairs by default (#3737) most of them are agents wired
alongside this one, so neither the heads-up nor the dashboard calls them
replaced or previous — the heads-up says "other agent directories on this
machine" and that this setup revoked none of them, and the dashboard lists the
owner's not-revoked ones (active, paused or still in setup) without a
revoke offer. The ids a `--replace` run actually
retired are `retired_agent_ids`. The list is empty on a clean first run — and
an empty list is **not** proof of a clean machine, because a scan that cannot
read the credential root also yields an empty list rather than failing a
completed setup. Directories are excluded by path, never by agent id (#1696):
a named agent's directory is its slug, which never equals its agent uuid.

### Recovering the outcome after a lost stream (#2173)

Connect writes its terminal outcome to **`last-connect-outcome.json`** in the
agent's credential directory (`~/.haven/agents/<slug-or-agent-id>/`), as
pretty-printed JSON whose content is exactly the object emitted on stdout —
same shape, same secret-free construction, never credential-file contents.
Every terminal outcome lands there, all three: `complete` and
`action_required` on the return path, `failed` on the throw path. A refusal
that happens *before* credentials are written (`runtime_undetermined`, an
expired setup challenge, the Node floor) writes nothing, because no directory
exists yet and nothing was created that could need recovering. The write is
best-effort: a failure to write it never fails a setup that otherwise
completed, and never changes the verdict the run already reached.

**Guidance for agent harnesses.** Allow **several minutes** for a first run: a
cold `npm` install of the signer routinely outruns a command harness's default
watch window, and the last line such a harness sees is the install heartbeat,
not the verdict. That is a stream loss, not a failure — the setup usually
finished. Do not reconstruct completion from a runtime's own MCP listing; read
`last-connect-outcome.json` instead, which carries the activation instruction
(including `restart_required` and the "start a fresh session" step) and the
read-only verification sequence the missed stdout line would have carried.

## Where the Node floor is enforced

`>=22.0.0` is declared in three places that must agree: the `engines.node` of the
four packages this floor governs (`sdk`, `connect`, `signer`, `mcp`),
`HAVEN_MINIMUM_NODE_VERSION` in `@haven_ai/sdk`, and
`MCP_RUNTIME_MANIFEST.minimumNodeVersion`. The manifest field is **derived** from
the SDK constant, and a guard test in each of those four packages pins its own
`engines.node` to it. They cannot drift silently. `.nvmrc` is separate: it pins
the version the repo itself develops and runs CI on (LTS 24), which may sit
*above* the user-facing floor but never below it. The floor is what an agent's
machine must satisfy; `.nvmrc` is what ours does.

The floor is 22 (maintenance LTS until April 2027) rather than 24 because the
runtime uses nothing newer than `AbortSignal.any` (Node 20.3), and Node 20 is
past end-of-life — 22 is the oldest still-supported LTS
([#1352](https://github.com/d-hinders/Haven-AI/issues/1352)).

They did drift once, which is why the constant exists. `engines` said `>=24`
everywhere while the manifest enforced `20.0.0`, so the guard meant to hold the
floor passed Node v23 — and because that guard only ran inside local-MCP
installation, the **default** (hosted MCP + local signer) path never called it at
all. A full connect on Node v23.1.0 completed, installed the signer, and produced
a real testnet payment signature ([#1161](https://github.com/d-hinders/Haven-AI/issues/1161)).

`@haven_ai/cli` is **out of scope and declares no `engines` floor today** — it is
published but sits outside the connect/signer/MCP runtime this section governs.
Neither do the unpublished workspace packages (`backend`, `frontend`, `core`,
`mcp-server`, `demo-merchant-mcp`, `qa-agent`), which are pinned by `.nvmrc` in
CI instead. Read "the floor" here as the agent-runtime floor, not a repo-wide one.

That list was already correct when [#1526](https://github.com/d-hinders/Haven-AI/issues/1526)
was filed; the **manifests** were what disagreed. `mcp-server` and
`demo-merchant-mcp` lacked `private: true`, so tooling that classified by that
flag — `release-bump.mjs` and connect's `package-smoke.test.ts` — treated them
as published and demanded exact internal pins. Both are now flagged private and
use `"*"`, which is what a workspace-only consumer must use; `npm run
lint:workspace-pins` enforces both directions of that rule on every PR. Since
[#4723](https://github.com/d-hinders/Haven-AI/issues/4723) `demo-merchant-mcp`
also consumes `@haven_ai/sdk` with a `"*"` pin (the merchant-side passport
verifier), the same rule applied to a second internal dependency; its
`build`/`test`/`typecheck` scripts build core and the SDK first, so the Railway
build command is unchanged. Nothing about the runtime floor, the version-skew
contract, or the Supported Runtime Manifest below moves — the published set this
section governs is unchanged at `sdk`, `signer`, `mcp`, `connect`, `cli`.

Enforcement now happens at three points, all refusing rather than warning:

| Point | What refuses | Why there |
| --- | --- | --- |
| `runConnect` (every topology) | Setup, before the setup token is resolved, credentials are written, or an agent is registered | A failed precondition must not strand a half-created agent or burn a one-shot token |
| `prepareLocalMcpRuntime` | The `--local` install | Kept; it is the deeper of the two connect paths |
| `runSignerStdioServer` / `runStdioServer` | Startup, before credentials are read | Install-time checks cannot see a Node **downgrade** after setup, or a version manager handing the agent runtime a different Node than the shell that connected |

Refusing rather than warning is deliberate. `engines` alone is advisory — npm
prints `EBADENGINE` and installs anyway unless the user runs `engine-strict` — so
before this the floor held by luck. And what gets installed is the **signer**,
which holds the delegate key and produces every payment signature; on an
unsupported runtime the plausible failure is a wrong or missing signature. "It
seemed to work" is exactly the evidence that cannot be trusted there.

## Release Checklist

> Publishing itself is automated: `npm run release:bump -- <version>` produces
> the bump, the release PR goes into `dev` (never `main` — `dev-gate` rejects a
> `release/*` branch aimed at `main`), and the later `dev → main` promotion
> triggers the **Publish packages** workflow
> (`.github/workflows/publish.yml`), which builds and publishes the
> changed packages. Do not run `npm publish` by hand. See
> [`scripts/README.md`](../../scripts/README.md) and the README's
> [Releasing npm packages](../../README.md#releasing-npm-packages) section. The
> checks below still matter — they are what CI enforces on the release PR
> before merge.

- Each published package needs its **own npm trusted publisher** (repo
  `d-hinders/Haven-AI`, workflow `publish.yml`) and a `repository` block in its
  `package.json` — configured once, per package, before its first release.
  `@haven_ai/cli` shipped without either and its first workflow publish failed
  with `E404` (#1159); the publish loop now attempts every package and reports
  per-package outcomes, but the npm-side configuration is an operator step no
  code change can do.
- Update `packages/connect/src/runtime-manifest.ts` whenever `connect`, `mcp`,
  `sdk`, or `signer` compatibility changes.
- Keep `packages/connect/package.json` and `packages/mcp/package.json` pinned
  to the tested SDK/runtime versions; do not use wildcard dependencies.
- Run `npm run test -w packages/connect` before publishing connector or MCP
  packages. CI runs connector tests whenever SDK, MCP, signer, or connector
  files change.
- Run `npm run smoke:pack -w packages/connect` before publishing connector or
  MCP packages. The smoke packs Connect plus local SDK/MCP artifacts, verifies
  the packed npm bin starts through an npm-style symlink, stages them into a
  temp Haven runtime, and verifies the wrapper can complete an MCP `initialize`
  + `tools/list` handshake.
- Verify the generated wrapper with an MCP `initialize` + `tools/list`
  handshake before setup reports local MCP as ready.
- Confirm setup output, logs, generated config, wrapper scripts, and sidecars do
  not include API keys or delegate private keys.

## Signer / hosted-MCP version skew (#1138, #1143)

`haven_sign` and `haven_sign_x402` take an optional `typed_data`, and the
x402 expected context has a second version that carries `typedDataHash`. Both
additions are backward compatible in the only direction that can actually occur
— a **v1** (legacy-rail) context is byte-identical to what shipped before, so an
older signer keeps verifying it — but the delegation rail needs both halves
current, and the failure mode differs by which half is stale. (That v1 path has
since been retired: the backend now emits only v2, or v3 where
`X402_EMIT_PAYER_CONTEXT` is on — `version: context.payerDelegate ? 3 : 2` in
`packages/backend/src/infra/chain/x402-binding-signer.ts` — and the current
signer accepts `[2, 3]`; see the v1-retirement note in the archive.)

| Stale half | Symptom |
|---|---|
| Signer older than the backend, **`@haven_ai/signer` ≥ the #1143 release** | `This signer is out of date: it supports x402 expected context versions up to <N>, and Haven sent version <M>. Update @haven_ai/signer …` |
| Signer older than the backend, **signer predating #1138** | `MCP error -32602: Input validation error: Invalid arguments for tool haven_sign_x402: Invalid literal value, expected 1 at x402_expected.auth.version` |
| Signer with #1138 but predating #1143 (fires once the deployment emits v3 — see below) | `… Invalid input at x402_expected.auth.version` — Zod says nothing at all about a failing literal *union* |
| Backend older than the signer | `Refusing to sign typed data under an expected context that does not commit to it` |
| Hosted tool list (client loaded `tools/list` before a hosted deploy) | A result's `contract_fingerprint` differs from the one in the server instructions the client loaded at `initialize`; or a `next_arguments` doesn't fit the schema the client loaded for the **hosted** tool it names (a misfit on a signer tool is signer skew — the rows above). The server cannot push `notifications/tools/list_changed` (stateless transport, `sessionIdGenerator: undefined`), so the SDK's `-32602` / unknown-tool refusals arrive before any Haven handler and now carry the fingerprint plus a reconnect hint. |

All of these fail closed, which is the point: none produces a signature. Treat any
of them on the delegation rail as a version-skew report, not a credential
problem — and note the last is also what a *legacy-rail* intent looks like if
a caller passes `typed_data` that the context never committed to.

### Hosted tool lists — the contract fingerprint and the reconnect rule (#3816)

The hosted transport is stateless, so a deploy cannot tell connected clients
that the contract moved. Instead every hosted tool result carries
`contract_fingerprint` and `server_version` as top-level fields of its JSON
payload (and the SDK-generated strict-input / unknown-tool refusals, which a
stale client is exactly the one to hit, carry both plus a one-line reconnect
hint via a CallTool wrapper in `packages/mcp-server/src/server.ts`). The same
16-hex fingerprint is computed at boot from what `tools/list` advertises —
name, the SDK's converted input schema, description; the instructions are
excluded — and is embedded in `HOSTED_INSTRUCTIONS`, delivered at
`initialize`. A client compares the fingerprint it loaded in the instructions
against the one on any result; a difference, or a `next_arguments` that does
not fit the schema it loaded for the hosted tool named, means the tool list
is stale: reconnect or restart the session before continuing, and never
hand-build or reshape a payload to make it fit. The in-flight carve-out: a
prepared or funded payment keeps its `payment_id` and resumes through
`haven_get_payment_status` / `haven_resume_x402_payment`
(`haven_sweep_delegate` for a stranded bridge balance) — never pay again.
During a rolling deploy the fingerprint may alternate once across replicas;
reconnect once, and if it still alternates, continue and report. The
published `haven-pay` skill carries the same rule.

### Task budgets — a third sign-context, and the tool set moves (#3329)

`haven_sign` accepts `task_budget_id` (mutually exclusive with `payment_id`
and `payload_hash`). The signer fetches
`GET /task-budgets/:id/sign-context`, whose `task_sign_context_version` is
pinned to `SUPPORTED_TASK_SIGN_CONTEXT_VERSIONS` (`packages/signer/src/sign-context.ts`,
currently `[1]`) and advertised in the handshake as
`task_sign_context_versions` next to `direct_sign_context_versions`. Two
shapes are signed and nothing else: a self-delegated task child
(`assertOwnTaskChild`) and the `disableDelegation` UserOp that closes one
(`assertOwnTaskBudgetCloseUserOp`), both from `@haven_ai/sdk`'s
`task-budget-guards.ts` — the security model §10 states the allowlist.

**The tool-name set changes on both runtimes.** Only the local `@haven_ai/mcp`
has a consent gate, so its hash moves and every installed operator of the
local runtime is asked to consent again on the next launch; the signer's own
hash covers tool names and does not move, so its reworded `haven_sign`
consent summary is not re-prompted:
local `@haven_ai/mcp` gains `haven_open_task_budget`, `haven_close_task_budget`
and `haven_submit` (the local relay step task budgets need; its `payment_id`
branch refuses, because the local runtime signs and submits a payment inline);
the hosted MCP gains `haven_open_task_budget` and `haven_close_task_budget`,
and its existing `haven_submit` takes `task_budget_id` XOR `payment_id`.

**#4825 (2026-11-12) corrects where the signature comes from on the local
runtime.** Task budgets and sub-budget signing are **hosted-plus-signer
features**: opening a task budget, closing one that is open, and signing a
sub-budget row all need a signature from the Haven signer, and a `--local`
install has no signer tool — the connector's local mode removes the signer
server on every runtime that supports local mode
(`packages/connect/src/runtime-install.ts`,
`packages/connect/src/config-writers.ts`). The local tool NAMES do not change,
so the local consent hash does not move; the behaviour does. `haven_open_task_budget`
refuses with the typed code `TASK_BUDGET_SIGNING_UNAVAILABLE` before contacting
anything (no `POST /task-budgets`, so no pending row is created);
`haven_close_task_budget` still answers `status: "closed"` for a pending or
expired budget, and refuses with the same code — without calling
`POST /task-budgets/:id/close`, so the budget is not left `closing` — for one
that is open or closing; a `pendingSubBudgetSignatures[]` row of
`haven_get_agent` and both `haven_submit { sub_budget_id }` results carry no
`next_tool` and a `next_tool_omitted_reason` saying this runtime cannot sign a
sub-budget and that the owner signs it from a hosted-plus-signer install. No
local tool description names a signer tool or a signer step any more, and the
`signer_compatibility` notice is gone from the local handoffs (they no longer
hand off). Spending through an open sub-budget (`sub_budget_id` on the pay
tools) needs no signer and is unchanged.

`task_budget_id` is an optional argument on `haven_send`, `haven_pay`,
`haven_pay_x402_quote` and `haven_pay_x402` where each exists. (#3378
re-verification: until then the local `haven_pay_x402_quote` and the hosted
`haven_send`, `haven_pay` and `haven_pay_x402_quote` accepted it and dropped
it, charging the whole budget; all four now carry it to the wire, pinned by
wire-level tests on both runtimes. A merchant-pinned task budget is declined
on an EIP-3009 funding leg, which pays the agent's own wallet first; both
runtimes' `haven_open_task_budget` descriptions say so. Descriptions are not
consent inputs, so no consent hash moves.)

Skew, both directions fail closed, each by a different mechanism: an
**older signer** strips the unknown `task_budget_id` key (its `haven_sign`
schema predates it) and then refuses with "Pass payment_id … or
payload_hash" — it never fetches and never signs; an **older hosted MCP**
lists no task-budget tools, and its `haven_submit`, which the signer's
hand-off names, is strict, so a `task_budget_id` there is refused with the
`-32602 unrecognized_keys` envelope below; a **newer signer against an older
backend** gets a 404 from the sign-context read and refuses with
`SIGN_CONTEXT_REFUSED`, never a signature. The SDK's `getAgentSummary()` now performs a third read
(`GET /task-budgets?status=live`) and degrades to an empty `taskBudgets`
list on any failure, so an older backend does not break `haven_get_agent`.
(#3518 re-verification, 2026-10-01: the list reads `status=live` instead of
`?status=open` — `closing` rows always, unexpired `pending` and `open`
rows; `closed` and expired rows are omitted — so a budget that is closing
stays visible AS closing instead of vanishing the moment its close starts,
while the list stays bounded. An older backend that refuses `status=live`
is re-asked for `status=all`, filtered the same way client-side; the
soft-fail degradation is unchanged. Both runtimes also gain
`haven_get_task_budget { task_budget_id }`, the read-by-id over the
backend's any-status `GET /task-budgets/:id` — the status check a close
refusal's "re-check the budget's status" points at; see the re-verification
block at the end of this document. An older hosted MCP lists no read tool,
which is the same fail-closed skew as the rows above.)

### An undeclared argument is refused, not stripped (#2312)

This produces the same `-32602` vocabulary as the skew rows above, and it is
**not** a skew report — a correct, current runtime gets it when it sends a key
the tool does not declare:

```text
MCP error -32602: Input validation error: Invalid arguments for tool
haven_settle_mcp_tool: [ { "code": "unrecognized_keys", "keys": ["max_amount"], … } ]
```

Read it as an argument-name mismatch, not an out-of-date package. Two things
worth knowing before you reach for an upgrade:

- **The affected tools are a declared list — and since #2353's switch that
  list is every hosted tool except the two `{}`-schema reads (`haven_get_agent`, `haven_get_allowances`); it read "21 of the 23" until #3645 re-measured 25 of 27, and at `ffca80f36` it is 27 of 29.** It is `STRICT_INPUT_TOOLS`, which since #2807 lives
  in the hosted server's contracts module (`src/tools/contracts.ts`, behind
  the `tools.ts` facade). It began (#2312) with the money-path
  tools that read from the payment record rather than from arguments, #2348
  added the four the local MCP reaches under the same name with a different
  argument spelling, #2349 closed it with the remaining twelve, and #2353's
  switch added `haven_complete_mcp_tool` — the last money-path tool to leave
  the permissive set — once the corrected `SKILL.md` had shipped to npm
  (0.1.34-alpha.0). If you see `payment_required` in the keys of a
  `haven_complete_mcp_tool` refusal, you are carrying a pre-0.1.34
  auto-installed skill copy: the field is not taken, and Haven rehydrates the
  merchant call context AND the 402 from `payment_id`. The two that still
  strip are on their own list beside it, `PERMISSIVE_INPUT_TOOLS`, each with
  its reason: `haven_get_agent` and `haven_get_allowances` (schema `{}` — the
  handlers read no input, and a supported runtime decorates no-argument calls
  with a dummy key, so a refusal there would protect nothing and break a real
  client). A tool on neither list does not compile.
- **The most likely cause is the local-vs-hosted argument spelling**, not a
  typo: `idempotencyKey` where the hosted surface takes `idempotency_key`,
  and `quote` where it takes `payment_required`. (A third crossover, `body` on
  `haven_quote_x402` declared only on the local surface, converged by #2366 —
  the hosted schema takes `body` too now.) Since #2348 those
  four tools say so in the refusal itself — the message names the hosted
  spelling to send instead, so the refusal is actionable without leaving the
  terminal. See
  [`08-local-vs-hosted-mcp.md` § Tool model](../architecture/08-local-vs-hosted-mcp.md#tool-model),
  which also records what each crossover cost while it was silent, and
  [#2366](https://github.com/d-hinders/Haven-AI/issues/2366) for the
  convergence that would remove the skew rather than report it.

**Server-side runtime requirement.** A strict tool registers a `ZodObject`
rather than a raw shape, which the deprecated `McpServer.tool(name, description,
schema, handler)` overload refuses outright ("received an unrecognized object").
The hosted server therefore registers through `McpServer.registerTool`, so
`@modelcontextprotocol/sdk` must be at a version that has it. This is a
hosted-server build constraint only — nothing about a client, a connector or the
local runtime changes, and the advertised JSON Schema is byte-identical either
way (`additionalProperties: false` in both cases, which is what the permissive
behaviour had been contradicting).

**The merchant payment header name is NOT a skew axis (#2289).** Since #4754 the
SDK sends an x402 v2 payload under `PAYMENT-SIGNATURE` alone and a v1 payload
under both `PAYMENT-SIGNATURE` and `X-PAYMENT` (#2289 had set both on every
retry; #2341 narrowed erc7710 first).

> **#2330 — the same defect, one level up, and why it is still not a skew axis.**
> #2289 fixed the retry the SDK *performs*. It did not fix the retry Haven
> *instructs an agent to perform*, and `haven_pay_x402_quote`'s premise is
> "retry the merchant YOURSELF". Three tool descriptions still named `X-PAYMENT`
> alone, two named no header, and nothing named `PAYMENT-SIGNATURE` to an agent
> — so an operator or agent following Haven's own guidance by hand reproduced
> the v1-only defect no matter which runtime or backend they were on. #2330
> makes every such instruction name both names and guards the property.
> **Superseded in part by #2341:** on the erc7710 scheme the instruction now
> names `PAYMENT-SIGNATURE` ALONE, because that header carries a delegation
> chain and duplicating it is refused with HTTP 431. **Superseded again by
> #4754:** the instruction is now "set exactly `retry_headers`" —
> `PAYMENT-SIGNATURE` alone for any x402 v2 payload, `X-PAYMENT` too only for
> v1 — because the #2361 extensions echo made a doubled EIP-3009 header answer
> 431 after funding. This is
> still not a version-skew axis: it is a description-only change, no tool is
> added, removed or renamed, and an older runtime simply carries older guidance
> text rather than failing closed against a newer backend. That choice is made entirely inside whichever
`@haven_ai/sdk` the installed runtime bundles — the backend neither sends the
header nor negotiates its name, and the name is not part of the Haven-signed
expected context — so there is no version to agree on and no combination of
runtime and backend that fails closed on it. An operator on a runtime predating
#2289 keeps sending only the v1 name, which strict x402 v2 merchants do not read;
that is the defect being fixed, and its remedy is an ordinary runtime update, not
a skew diagnosis. Nothing in the table above applies to it.

### retry_headers and the installed-signer lever (#3727)

`haven_sign_x402` and `haven_x402_sign_header` now return `retry_headers` —
`{ <name>: <payment_header> }` built from the SDK's live
`x402PaymentHeaderNamesFor` rule — and the hosted `haven_submit` returns it on
the erc7710 path beside the header it assembles. This IS an installed-signer
lever: `retry_headers` reaches agents only after a `@haven_ai/signer` release
and connector refresh. #4754 moved the rule itself (v2 → `PAYMENT-SIGNATURE`
alone): the hosted prose now says "set exactly `retry_headers`", which stays
correct against an old signer too — an installed signer keeps returning both
names for a v2 EIP-3009 payload until a `@haven_ai/signer` release reaches it
through a `@haven_ai/connect` release that bumps `runtime-manifest.ts`'s
`signerVersion`. The field is additive — nothing keys on its
presence, and the name-selection rule it encodes is the same rule the wire path
already applies, so there is no combination of signer, hosted server and
backend that fails closed on it. The plain-HTTP outcome fold
(`haven_report_x402_outcome` taking `settlement_tx_hash` / `payment_response`)
is hosted-only and ships on deploy; nothing installed depends on it.

**Why three stale-signer rows (#1143).** The second is what the field actually
returned on 2026-08-06, and #1141's original version of this table got it wrong:
it listed `x402 expected context authentication message is invalid`, which is what
the *binding* check produces. That check is never reached — the tool schema pinned
`auth.version` to a literal, so the MCP server rejected the call before any Haven
code ran, and anyone grepping the documented string during an incident found
nothing. #1143 opened the schema and moved the decision into the signer
(`SUPPORTED_X402_EXPECTED_VERSIONS` in `packages/signer/src/core.ts`), which is
the first row. The other two rows stay because they are not historical: every
signer published before that release still behaves this way, and they remain
installed until users update. Both Zod strings were reproduced against `zod/v3`
rather than inferred — note that a failing literal *union* degrades to a bare
`Invalid input`, so the pre-#1143 signer that knows v2 is even less diagnosable
than the older one that reported `expected 1`.

Row three was written for the next context bump, and that bump has shipped as an
operator switch: the backend emits v3 where `X402_EMIT_PAYER_CONTEXT` is on
(#1690, `x402-binding-signer.ts`; a per-environment operator flip). On such a
deployment a signer carrying #1138 but predating #1143, which accepts v1 and v2
only, produces row three. Row two is the one seen in the field on 2026-08-06.

If you see either Zod row, **do not** "fix" it by editing `auth.version` to a
supported value. The version is inside the Haven-signed binding message, so
rewriting it invalidates the signature and misrepresents what Haven declared —
the update is the fix. ("Declared", not "authorised" (#2347): Haven signs this
message, and that is all it does here — the word matches
the settlement-child verifier's own header comment (shared by the SDK and the signer since #3283), which describes the same binding.
Spend authority is the owner-signed delegation and the on-chain caveat that
enforces it, never Haven.) The same applies to `expected_auth.version` on the sweep
binding, which shares the mechanism (`SUPPORTED_SWEEP_BINDING_VERSIONS`) and will
hit this the first time that binding is versioned.

**Row one is now machine-readable, not just named (#1309).** The Zod rows
above are a diagnosability gap the table exists to translate; row one — a
signer ≥ the #1143 release, still stale relative to the backend — no longer
needs that translation, because it is now structured at the source. The tool
boundary (`haven_sign` / `haven_sign_x402` / `haven_sign_sweep_delegate`)
returns the row-one message verbatim (unchanged) PLUS
`{ code: 'UNSUPPORTED_EXPECTED_CONTEXT_VERSION' | 'UNSUPPORTED_SWEEP_BINDING_VERSION',
supported_versions, received_version, fallback, next_action:
'stop_and_tell_user' }` — `assertSupportedBindingVersion` in
`packages/signer/src/core.ts` throws a typed
`HavenUnsupportedSignerVersionError` (`@haven_ai/sdk`) instead of the plain
`HavenSigningError` every other signing refusal uses, so `code` and the two
version fields are DERIVED at the throw site from
`SUPPORTED_X402_EXPECTED_VERSIONS` / `SUPPORTED_SWEEP_BINDING_VERSIONS` rather
than a second hand-written literal. `fallback` is the same
`SIGNER_UPDATE_FALLBACK` string the hosted quote's advisory
`signer_compatibility.fallback` (below) carries, so an agent that hits either
surface is told the identical fix. This narrows *how* the refusal is
diagnosed; it enforces nothing new — nothing was ever signed on this path
either, before or after.

One more skew row since #1272: the hosted x402 quote tools are **compact by
default** — no `typed_data`/`typed_data_b64` in the response. A signer old
enough to lack the #1263 `payment_id` fetch (or an install missing
`identity.json`) therefore has no byte source in the default flow; its error
names the fallback, and the recovery is to re-run the quote tool with the SAME
`idempotency_key` plus `include_signing_payload=true`, which replays the
ORIGINAL sign_data (#1207) with the full payload. This is a transport change
only — the signer's verification is identical on both paths — but it converts
"old signer silently relays bulk bytes" into "old signer asks for them
explicitly", which is the observable difference an operator will see.

That replay recipe was **false on the erc7710 scheme** for two of the three
hosted entry points until #3042 (scan B2, measured live on dev 2026-09-16):
`haven_pay_mcp_tool` and `haven_prepare_catalog_purchase` never forwarded
`idempotency_key` on their erc7710 branch — only `haven_pay_x402_quote` did
(#2041) — so re-running with the same key minted a second, independently
signable settlement child (`6866bc97…` and `9835d550…` from one key). The
backend had deduplicated on the key all along; the hosted branches simply did
not send it. Since #3042 all three entry points forward an explicitly given
key (and none derives one — unkeyed erc7710 calls mint one child per call on
all three), so a keyed retry replays the original child **while that child is
still `pending_signature` and inside its quote window**: an expired child is
lazily expired and a new one minted (cap and budget re-checked); a `submitted`
child answers 409 (retry the original); a `confirmed` child answers with its
`tx_hash` and no `sign_data`. This is hosted-only: no signer or connector
version is involved, and a hosted server older than #3042 is the only runtime
that still shows the double-child behaviour — recognisable by a second
`payment_id` for the same key, with `haven_get_payment_status.idempotencyKey`
reading `null`.

One more skew row since #1307, on the SETTLE leg rather than the sign leg:
`haven_settle_mcp_tool` / `haven_complete_mcp_tool` accept `merchant_url` /
`tool_name` / `arguments` / `mcp_transport` as optional and rehydrate them by
`payment_id` from the stored intent when omitted. Omitting them against a
backend that never stored a call context — pre-#1307 backend, or an intent
that was never quoted through `haven_pay_mcp_tool` (a plain non-MCP-tool x402
resource) — gets a structured `MERCHANT_CALL_CONTEXT_UNAVAILABLE` refusal
naming the fallback in-band: re-send the four fields explicitly (the same
values `haven_pay_mcp_tool` returned at quote time). Same shape as the
`include_signing_payload=true` fallback above: no signature verification
changes, only which call carries the bulk bytes.

On a successful hosted settle (#1349), agents report from the compact
`agent_summary.purchase_summary` rather than parsing the merchant's raw
`result`. This is a backward-compatible reporting extension only: Haven state
sets status and payment fields, while product/invoice metadata comes from the
merchant — `product` falling back, since #3771, to the Haven-derived
`<merchant host> <tool_name>` label when the merchant names none (Re-verified
#3771) — and `settlement_tx_hash` is only an optional merchant PAYMENT-RESPONSE
receipt reference. Missing values are explicit; it changes neither signing nor
runtime compatibility.

`haven_prepare_catalog_purchase` (#1306) — the guided catalog-id preflight —
persists the SAME `mcpCallContext` at quote time (it composes the identical
authorize calls `haven_pay_mcp_tool` uses, just sourced from a
`merchant_catalog` row instead of caller-supplied fields — since #1547 that
includes the settlement-scheme selection, so on the delegation rail against an
erc7710-advertising merchant it composes `prepareX402Erc7710` with the same
context passthrough rather than `createX402Intent`), so it carries no
separate skew row: the settle leg above rehydrates a catalog-preflight-created
intent exactly like a `haven_pay_mcp_tool`-created one on either scheme, and
the `signer_compatibility` version check on the QUOTE side (table above)
applies identically to its 3009 shape (the erc7710 shape carries no
`signer_compatibility`, like `haven_pay_mcp_tool`'s — the signer's own
signing-time refusal is the guard there, as everywhere).

**The `@alpha` in that remediation is the PRODUCTION channel, and since #2422 it
is not universal (epic #2420).** The backend now derives the connector it hands
out from `HAVEN_CONNECTOR_CHANNEL` (default `alpha`; setting it on the shared dev
environment is an owner step whose ordering and verification are in
[`package-dev-channel.md`](package-dev-channel.md) § *Operator checklist* — this
doc records neither that it has been done nor that it has not), so on a
non-production deployment the correct rerun
names that backend's own channel — its setup response reports it in
`connector_package`. The strings above are unchanged and still say `@alpha`,
because they are baked into `packages/sdk` and `packages/signer` at build time
and this repository's production release channel really is `alpha`.

**#2423 has since landed, and it did NOT make those hints environment-derived** —
a published tarball cannot read a deployment's environment. It made them derive
from a build-time constant that mirrors the npm dist-tag the build was published
under, so an `alpha` build still says `@alpha` (byte-identically to the strings
above) and a build published on another channel says that channel. See
*The connector channel is a fifth bump-managed constant* earlier in this
document for the mechanism. The runtime-environment half applies only to the two
surfaces that are DEPLOYED rather than published: the backend's handout (#2422)
and the hosted MCP server (#2423).

So the reading stands, for a slightly different reason than it used to: treat the
hint as "reinstall the connector **your backend hands out**", whose spec that
backend reports in `connector_package`. That is exactly the skew this section is
about: a signer installed from one channel against a backend emitting another is
how an unknown `x402_expected_context_version` arises in the first place.

### `haven_pay_x402_quote` pays from the request, not a copied challenge (#3739)

Hosted only; the local `@haven_ai/mcp` runtime is unchanged (its one-shot
`haven_pay_x402` already probes and pays from the request).

- **Request mode.** `haven_pay_x402_quote` now selects its mode by whether
  `payment_required` is present:
  - Absent: it takes `url` (required), `method`, `headers`, `body` and a cap
    (required). It makes the unpaid request itself and builds the payment from
    the 402 it fetched.
  - Present: `payment_required` mode is unchanged, and the challenge must still
    be passed UNCHANGED.
- **The quote names the pay step.** `haven_quote_x402`'s result carries a next
  step for the first time: `haven_pay_x402_quote` with request-mode
  `next_arguments`. Those are the request as the caller sent it, plus
  `max_amount_human` set to the quoted amount and a fresh `idempotency_key`
  that a retried pay call replays.
- **Egress policy: #3747's hosted policy, with a stricter redirect rule.**
  - The target is checked by the client's `merchantEgress` policy
    (`docs/security/hosted-egress.md`): public https hosts only, no IP literal,
    localhost, single-label or internal name. A refusal is
    `MERCHANT_EGRESS_REFUSED`, before any request.
  - `redirect: 'error'`, set per call, and an explicit refusal of any 3xx:
    stricter than the policy's re-checked GET redirects, as #3739 and #3747
    agreed.
  - The policy's quote budgets: a 15 s timeout and a 256 KiB read cap.
  - Other refusals are typed `X402_PROBE_*` codes with nothing created. A 402 the
    backend cannot store (over 64 KB) refuses as `X402_CHALLENGE_TOO_LARGE`:
    request mode has no agent copy to fall back on.
  - The policy cannot refuse a public name that resolves to a private address
    (#3740, accepted residual).
- **Replays.**
  - With `idempotency_key`, the existing intent answers BEFORE any re-probe,
    through the new read-only `GET /x402/by-idempotency-key/{key}`:
    - awaiting signature → the signer tool;
    - past signing → `haven_get_payment_status`.
    - Only when the stored intent is for the same URL and its amount fits this
      call's cap; otherwise the call falls through (the probe re-checks the
      cap, `POST /x402` the rest).
    - The quote's `next_arguments` prefill a fresh `idempotency_key`
      (`x402q:…`) per quote, so a retried pay call replays.
  - A closed window, a different task budget, or a 404 (including an older
    backend without the route) falls through to probe + `POST /x402`, whose own
    key replay still applies.
  - With no key, the derived key (`x402r:…`) hashes the whole probed challenge,
    `extensions` included.
- **Skew.**
  - Signer: no behaviour change; it fetches the stored challenge by
    `payment_id` exactly as before. Its `haven_sign_x402` description now says
    Haven never sends the merchant the paid request (text only).
  - Hosted server ahead of the backend: request mode works, but loses only the
    replay-before-probe.
  - Older skill text still says to copy `payment_required` verbatim. That
    remains a valid mode.

### Plain-HTTP x402 next steps after the merchant retry (#3774)

These are hosted surface changes. The local runtime has no twins: its `haven_submit { payment_id }` refuses.

- **erc7710 `haven_submit`** names `haven_report_settlement_evidence` (`payment_id` prefilled) as the step after the agent's own retry, where it used to name no Haven tool.
- **`haven_report_x402_outcome` on an unconfirmed erc7710 payment** now refuses with a typed code instead of `API_ERROR`. Clients that branched on `API_ERROR` from this tool see the new codes:
  - `ERC7710_REPORT_SETTLEMENT_EVIDENCE` names the evidence tool and carries the caller's hash;
  - `ERC7710_OUTCOME_NOT_REPORTABLE` answers a `rejected` outcome with `haven_get_payment_status`: the merchant may already have redeemed its authorization, so re-quote only if the status shows no settlement. There is no delegate balance to sweep.
- **`haven_submit { payment_id }` success** now carries the next-step fields. Once confirmed, one status read picks the flow, and for x402 one merchant-call-context read picks the purchase type:
  - x402 MCP-tool purchase (a stored call context): `haven_complete_mcp_tool` (`payment_id` prefilled);
  - x402 plain HTTP (no stored context): retry the merchant, then `haven_report_x402_outcome`;
  - x402 with the context read failing: both continuations, named in the reason;
  - direct confirmed: done;
  - anything else: `haven_get_payment_status`.

  `status` and `tx_hash` are unchanged.
- **Request-mode probe refusals** carry per-cause reasons.
- **`MERCHANT_EGRESS_REFUSED`** names the calling tool's own argument (`url`, `merchant_url`, or "pick another catalog entry").
- **Skew:**
  - Text and next-step fields only; no tool, schema, version or consent-hash change. The server instructions and the `haven_pay_x402_quote` description now name `haven_report_settlement_evidence` after an erc7710 retry.
  - The skill text splits the post-retry step by scheme.
  - An older skill still teaches `haven_report_x402_outcome` on erc7710; that call now gets a refusal that names the right tool.

### erc7710 refusal wording on settle/complete (#3784)

Hosted text only. The `haven_settle_mcp_tool` description and the server instructions no longer say an erc7710 merchant refusal moved nothing; they say there is nothing to sweep, check `haven_get_payment_status` after the payment window, and re-quote only if unsettled — the next step the settle refusal returns for a generic merchant refusal (a merchant that reported it is not ready gets stop-and-tell-user, and the served text is the more cautious of the two). The `haven_complete_mcp_tool` description drops its erc7710 clause for "erc7710 settles via `haven_settle_mcp_tool`". No tool, schema, refusal code or consent-hash change; a connected client sees the new text on its next `tools/list` / initialize.

### Out-of-gas `MERCHANT_NOT_READY` names the operator top-up (#3834)

Message text and one next-step reason only. When a merchant refuses with `reason_code: settlement_wallet_out_of_gas`:

- The hosted runtime (on deploy) and the local runtime (`@haven_ai/mcp`, once released) both say the merchant's operator must top up its settlement wallet, and give `fail_floor` beside `settlements_remaining`. They no longer say "retry after approximately 60s"; the wallet does not refill itself, so retrying before a top-up is refused again.
- Both runtimes' `next_tool_omitted_reason` names the top-up. The erc7710 paid-retry refusal on `haven_settle_mcp_tool` follows the same rule; the eip3009 paid retry (`haven_complete_mcp_tool`) is unchanged.
- Every other reason code keeps its wording. The code, `next_action: stop_and_tell_user` and `retry_with_new_quote: true` are unchanged.
- Haven's wording is keyed on `reason_code`; it does not read the merchant's `recovery` field.

No tool, schema, refusal code or consent-hash change. A local client on an older `@haven_ai/mcp` keeps the old "retry after" text until it updates.

### An expired-only budget is refused as `delegation_expired`, with the end date (#4352)

Backend and hosted text. When the ONLY delegation row for a token has expired,
the live reads hide it (#3802), so the refusal sites answered the generic
over-budget refusal — "wait for the period to reset" — which never resets. The
DECISION is unchanged: the same 403, nothing created and nothing signed. What
moved is the reason and the words:

- `POST /machine-payments/budget-precheck` and both x402 legs (erc7710 and the
  EIP-3009 funding leg) now answer `delegation_expired` with *"this budget ended
  on `<YYYY-MM-DD>`; ask the owner to set a new one"*
  (`modules/budget-scope/refusal-body.ts:257-272`,
  `modules/x402/delegation-authorize.ts:483,699`).
- The expired-row read is narrow and lives in
  `modules/budget-scope/expired-budget.ts`; it is consulted ONLY on paths that
  were already refusing, never on a live one (#3919).
- Migration `119_payment_refusals_budget_ended_at.ts` widens the
  `payment_refusals` detail allowlist with `budget_ended_at`, so the ledger row
  carries the provenance marker.
- `delegation_expired` therefore has TWO producers: the timestamp-caveat revert
  it always meant, and this pre-check refusal. A client that branched on the
  code alone sees the same code; the prose and the `budget_ended_at` detail are
  what distinguish them.

No tool, schema shape or consent-hash change. An older client keeps working and
simply surfaces the new prose.

### erc7710 authorize refuses a `merchantPayTo` that differs from `payTo` (#4243)

Backend only. On the erc7710 shape (`payTo` = the merchant) `POST /x402/authorize` now answers 400 when the body carries a `merchantPayTo` that differs from `payTo`, and the intent records `payTo` as the merchant. No current client is affected: `@haven_ai/sdk`'s erc7710 path, the hosted MCP tools and the local runtime send the merchant as `payTo` and no `merchantPayTo`, and the EIP-3009 funding leg (`payTo` = the delegate EOA, `merchantPayTo` = the merchant) is unchanged. The one skewed caller it reaches is a pre-#1360 SDK that sends a stale delegate address as `payTo` with `merchantPayTo` and no `settlementScheme`: it used to fall through to the erc7710 selector and now gets the 400 before anything is built. No tool, schema shape, refusal code or consent-hash change.

### Detecting skew before a payment (#1155)

Every row above is a *post-quote* symptom: the agent found out by trying to pay.
The same skew is now detectable at connection time, from two surfaces that cost
nothing to read.

| Surface | What it states | Where |
|---|---|---|
| Signer `initialize` result | The version sets this signer will verify — `capabilities.experimental["haven/signer-compatibility"]` (machine-readable) and the same numbers in `instructions` (what clients show the model), which since #3738 also state the agent id and delegate address the signer is bound to | `packages/signer/src/capabilities.ts`, wired in `buildSignerMcpServer` |
| Hosted quote/prepare result | `signer_compatibility.x402_expected_context_version` — the version that quote will emit — plus in-band guidance (since #1547: branch on the signer's machine-readable version-mismatch refusal, not a pre-compare). Present on the **EIP-3009 shape** of each tool; the erc7710 shape carries none, and since #2041 that now includes `haven_pay_x402_quote` | `packages/mcp-server/src/tools/support/signer-compat.ts`, emitted on `haven_pay_x402_quote`, `haven_pay_mcp_tool`, `haven_prepare_catalog_purchase`; the emitter list is pinned by `packages/mcp-server/src/tools/support/shared-helper-ownership.test.ts` (#4631) |

**The information is agent-mediated, and cannot be otherwise.** The signer and
the hosted MCP are two separate servers connected to the same agent client. The
hosted server cannot introspect the signer, and the signer's one Haven call is
the #1263 read-only fetch of a *specific payment's* signing context — it cannot
ask what version a future quote will emit. Only the agent sees both surfaces. #1155 shipped the
information plus a prompt to COMPARE the two — and field experience (#1547)
showed that prompt was unperformable in most agent harnesses, which do not
expose an MCP `initialize` result to the model; agents "checked" by re-reading
instruction prose. The shipped guidance therefore no longer asks for a
pre-compare: it names the signer's signing-time structured refusal (#1309 —
`code` / `supported_versions` / `received_version` / `fallback`) as the branch
point, which every harness can act on because it arrives as a tool result. The
`initialize` surfaces above still advertise the sets for harnesses (and
humans) that can read them; nothing about what is ENFORCED moved.

**A mismatch warns, it does not block** (owner decision, 2026-08-07; unchanged by
#1309). No refusal was added to the payment path: a quote whose emitted version
the signer may not know still succeeds and simply reports the number. Refusing
on the strength of reported client metadata would let a false positive block a
working payment, which is strictly worse than the reactive state — and the
signing-time guard above already fails closed, so nothing is unguarded. Both
surfaces name the same fix (update `@haven_ai/signer`; rerun
`npx @haven_ai/connect@alpha`), so an agent that meets either says the same
thing to the user — and since #1309 that is not just true of the prose: the
quote's `signer_compatibility.fallback` and the signer's own structured
refusal `fallback` field are the SAME string
(`SIGNER_UPDATE_FALLBACK`, `@haven_ai/sdk`), so an agent reading either as
data gets byte-identical guidance, not merely similar wording.

**`signer_compatibility` is the stable contract this pre-payment check reads
(#1309).** Its shape — `x402_expected_context_version`, `signer_capability`,
`check` (prose), and now `fallback` (the same guidance as structured data) —
was already sufficient for the acceptance bar "hosted MCP quote/preflight
responses surface compatibility requirements in a stable field"; `fallback`
is the one field #1309 added, because it was the one piece of `check` an
agent could not previously read without parsing a sentence. See
`signerCompatibilityNotice` — since #2808 in the hosted server's signer-compat
support module (`src/tools/support/signer-compat.ts`, re-exported through
`tools.ts`).

The advertised set is **derived** from `SUPPORTED_X402_EXPECTED_VERSIONS` /
`SUPPORTED_SWEEP_BINDING_VERSIONS`, never a second literal — including the
rendered numbers inside `instructions`. Drift between what is advertised and what
is enforced is the one way this feature could become a lie, so tests hold them
together in both directions: a handshake assertion pins the advertised sets to
the exported constants, and a behavioural test drives the real signing path with
every advertised version and fails if the skew guard rejects any of them.

The signer advertises under `capabilities.experimental` rather than the newer
`extensions` field on purpose. Both are `Record<string, object>` in
`@modelcontextprotocol/sdk@1.29`, but a client running an older SDK parses the
`initialize` result with a `ServerCapabilities` schema that has no `extensions`
key and would strip it — and an out-of-date client is exactly the population this
feature serves.

Adding a read-only capability *tool* was the documented fallback if the SDK could
not carry this at handshake. It can (`ServerOptions.capabilities` and
`ServerOptions.instructions`, both forwarded by `McpServer` into the `initialize`
result), and a new tool would have been worse than redundant: the signer's
consent hash is computed over its registered tool names, so adding one would
invalidate every existing acknowledgement and prompt users to re-consent for a
diagnostic.

This covers the **hosted MCP + local signer** topology only. The local
`@haven_ai/mcp` runtime signs in-process with the SDK it was installed with, so
there is no second component to be out of step with.

**Both payment-brain servers set `instructions` too (agent-prompt audit, items
A/B).** `ServerOptions.instructions` above is the mechanism the signer's own
handshake reuses; `buildHostedMcpServer` and `buildMcpServer` (the local
runtime) now set it as well, with a compact critical path — deliberately free
of any version literal, since nothing there should ever need a release to stay
true (unlike the signer's compatibility numbers above, which are point-in-time
by design). See [`07-edge-signer.md`](../architecture/07-edge-signer.md) for
what each server's instructions say and why they differ in length.

## Direct-payment signing handoff and old-signer refusal recovery (#3277, 2026-09-26)

The hosted `haven_send` / `haven_pay` results now always name the byte-free
signing handoff: `next_action: sign_and_submit_payment`,
`next_tool: haven_sign` (rendered `mcp__haven-signer__haven_sign`),
`next_arguments: { payment_id }` — the exact shape the hosted handoff map
declares for the signer's `haven_sign` — plus a `signer_compatibility` notice
carrying `direct_sign_context_version` (the SDK's
`DIRECT_SIGN_CONTEXT_VERSION`, the version
`GET /payments/:id/sign-context` serves) and the recovery instruction.

This replaces #3271's planned "named only when the signer advertises support"
gating (owner decision on #3277, 2026-09-24): the hosted server never sees the
signer's `initialize` handshake, and per the #1547 lesson the notice must not
ask the agent to compare a version against `initialize` instructions either.
Old signers are handled by refusal recovery instead. Every installed pre-#3271
signer that follows `haven_sign({ payment_id })` for a direct payment answers
`SIGN_CONTEXT_REFUSED` with `backend_error_code: 'sign_context_unavailable'`
(its x402-context fetch draws the backend's 409) and has signed NOTHING — so
the notice says: re-sign with `{ payload_hash, typed_data_b64 }` from the
payment result, passed through unchanged, then update the connector by
rerunning the connect command. The relay fields
(`payload_hash`, `signature_scheme`, `typed_data`, `typed_data_b64`) stay on
every delegation-rail result unchanged — they are the recovery route, not a
deprecated path.

Compatibility: additive result fields only; no tool name, schema key, failure
code, expected-context version or signing wire format changes. The
`SIGN_CONTEXT_REFUSED` code and the `sign_context_unavailable` backend code
named in the notice are pinned to what `@haven_ai/signer` emits
(`sign-context.ts`) by a cross-package test
(`hosted-signer-integration.test.ts`). No gate upgrades existing installs —
at the time, production ran the signer at `@haven_ai/connect@alpha`'s exact pin
(`0.4.0-alpha.0`) — which is why the recovery route, not an update prompt, is
the compatibility story. Merging to `dev` waited for the promotion carrying
#3271 to publish a connect/signer pair that includes the direct sign-context;
that has shipped, and connect now pins the signer version shown in the
*Supported Runtime Manifest* table above (`packages/connect/src/runtime-manifest.ts`).

> **Superseded by #3495 (2026-09-30), see the section immediately below.**
> The paragraph above ("the relay fields stay on every delegation-rail result
> unchanged") was the #3277 owner decision of 2026-09-24; the #3495 owner
> decision of 2026-09-30 reverses it. The handoff fields named in the first
> paragraph (`next_action`, `next_tool`, `next_arguments`, `signer_compatibility`)
> are UNCHANGED by #3495 — only whether `payload_hash`/`typed_data`/
> `typed_data_b64` ride the result unconditionally.

## Direct-payment results compact by default, and the opt-in relay (#3495, 2026-09-30)

Owner decision (2026-09-30), superseding #3277 AC2 ("the relay fields stay"):
the hosted `haven_send` / `haven_pay` results are now **compact by default**,
mirroring the x402 quote tools' own #1272 contract on the same helper
(`delegationSignFields`, `tools/support/mcp-context.ts`) — `payment_id`,
`status`, `idempotency_key`, `payload_hash`, `expires_at`, the byte-free
signing handoff, `signer_compatibility`, and (send) `asset`/`amount`/
`recipient` or (pay) `meta`; `signature_scheme` rides every delegation-rail
result, but `typed_data` / `typed_data_b64` do not.

**Idempotency key, generated fresh and echoed.** When the caller passes no
`idempotency_key`, the hosted tool generates one and echoes it on every
result (`idempotency_key` field, present on success AND on
`pending_approval`) — echoing the same way the x402 tools echo theirs
(`buildX402SigningContext`, `mcp-context.ts`), but the direct-payment
generator (`generateDirectIdempotencyKey`, `tools/support/mcp-context.ts`) is
DELIBERATELY NOT a derivation of `buildX402IdempotencyKey` (`@haven_ai/sdk`'s
`x402.ts`). An earlier design hashed token/amount/recipient/task_budget_id/
sub_budget_id into a 5-minute bucket, mirroring the x402 key's shape — review
caught that this is wrong for a direct send: x402's key identifies a QUOTE
for one paid resource, where two calls with the same parameters inside the
bucket really are the same purchase, but "send 5 USDC to 0xabc" said twice in
five minutes is routinely two DIFFERENT payments (two tips, two payouts), and
bucketing them onto one key would make the backend's `findPaymentReplay`
function return the FIRST payment for the second call — the agent told the
second send succeeded while no second transfer happened. The generator is instead `direct:` + `crypto.randomUUID()`:
every no-key call gets its own payment by construction, and a same-key
re-run — in particular the `include_signing_payload: true` opt-in below — is
a true replay ONLY because the caller deliberately echoes the key back, never
because two calls happened to share parameters. The backend still requires
the re-run to repeat the exact token, amount, recipient, `task_budget_id` and
`sub_budget_id` the first call used — a mismatch answers 409 rather than
silently rerouting to a different payment.

**Replay semantics, precisely** (`findSendIntentByIdempotencyKey`'s
`FIND_SEND_INTENT_BY_KEY_SQL`, `findPaymentReplay`): the outcome depends on
the stored row's own state, and on whether the lookup finds a row at all —
the SQL excludes `status IN ('failed', 'expired')` from its `WHERE` clause
outright. A matching key against a row still `pending_signature` AND within
its `expires_at` window is a TRUE replay — the same `payment_id`, the same
stored `sign_data`, no new chain read. A matching key against a row
`pending_signature` but PAST `expires_at` is lazily expired IN PLACE and a
FRESH intent is created under the SAME key (pre-existing #961 behaviour,
untouched here). A key that already belongs to a `failed` or `expired` row
matches NOTHING in the query — the lookup returns as if no row exists, and a
FRESH intent is created immediately, no lazy-expire step. A matching key
against a row already `confirmed` (or any other terminal, non-`failed`/
`expired` status the query does return) answers a STATUS replay with no
`sign_data` at all. At any moment a given `idempotency_key` names AT MOST ONE
live (non-terminal) intent.

**The opt-in.** `include_signing_payload: true` on `haven_send` / `haven_pay`
is new schema surface (`contracts.ts`) — a same-`idempotency_key` re-run
returns the stored payment's full `delegationSignFields` (signature_scheme +
typed_data + typed_data_b64), never a second intent.

Two review-round-1 corrections, both fixed in the same PR that introduced
this whole section:
- **S5 — a same-key re-run of a CONFIRMED payment used to crash.**
  `HavenClient.createIntent`'s return type hardcodes `status:
  'pending_signature'`, so the status-replay body above (no `sign_data`)
  reached `intent.signData.hash` and threw (`UNKNOWN_ERROR`) instead of
  surfacing the real state. `haven_send`/`haven_pay` now detect a missing
  `sign_data.hash` and answer with the REAL status (`haven.getPaymentStatus`),
  the tx hash when recorded, no signing fields, and `next_action: none`
  (confirmed) or `check_status_later` (a defensive branch for any other
  status `agentPaymentStatusHttpCode` answers 200 for through its default
  arm; no current payment-intent status reaches it). A
  status mapped to a non-2xx code there (`pending_signature`/`submitted` →
  409, `expired` → 410, `failed` → 502) never reaches this branch: the SDK
  transport throws before `createIntent` returns, surfacing as an ordinary
  API error instead.
- **N3 — the opt-in re-run's own reason now tells the agent to relay
  directly**, rather than looping back through `haven_sign { payment_id }` —
  a compact result's reason (`DIRECT_SIGN_REASON`) still points at
  `payment_id` first; the `include_signing_payload: true` re-run's own result
  carries `DIRECT_SIGN_REASON_WITH_RELAY` instead.

This is the recovery route `directSignerCompatibilityNotice`
(`support/signer-compat.ts`) and `DIRECT_SIGN_REASON` (`state-direct-recovery.ts`)
now name — on TWO DISTINCT trigger shapes, named separately (review round 1
caught the PR's first pass conflating them into one wrong trigger): (1) any
`haven_sign` refusal carrying `fallback: 'typed_data_b64'`, whatever its
code — a currently-published `@haven_ai/signer` (0.5.0-alpha.1 through
current) sets that field only on `SIGN_CONTEXT_TIMEOUT` /
`SIGN_CONTEXT_UNREACHABLE` / `SIGN_CONTEXT_MALFORMED`, or
`SIGN_CONTEXT_REFUSED` with `http_status: 404` against an older backend.
Since #4829 `SIGN_CONTEXT_UNREACHABLE` is the NON-ANSWER class as well as a
transport failure: a body that is not a JSON object at any non-2xx status, any
5xx, and a 429 all report it (with `http_status`), so a gateway's HTML 502 and
the money-path rate limit's 429 route here rather than to
`SIGN_CONTEXT_REFUSED`; (2)
`SIGN_CONTEXT_REFUSED` with `backend_error_code: 'sign_context_unavailable'`
and NO `fallback` field, which only a signer predating #3271 produces (no
direct-fetch fallback of its own to try). Guidance never suggests a
`payload_hash`-only call — a signer predating #3169's bare-hash refusal
signs it raw and the account rejects it on-chain (AA24). The signer's own
messages (`sign-context.ts`'s timeout/unreachable/malformed/404 throws,
`tools.ts`'s `USEROP_BINDING_MISMATCH` remedy) and the backend's own 409 text
(`modules/x402/sign-context.ts`) are updated to match; the 404 case names
BOTH routes since the signer cannot tell whether the backend also predates
#3495 (original result already carries the pair) or is merely refusing this
`payment_id` for some other reason (a same-key opt-in re-run).

**Skew, both directions.** Against a Haven deployment that has shipped #3495:
an old signer (`<= 0.4.0-alpha.0`, predating #3271's direct sign-context
fetch) or a CURRENT published signer hitting either trigger shape above both
now need ONE EXTRA hosted call — the `include_signing_payload: true` re-run —
before they can relay, where #3277 let them relay straight from the original
result. Neither signer needs a code change to keep working: both already
read `fallback`/`next_tool_omitted_reason` as data, and the hosted notice's
prose now names the extra call. Against an OLD Haven deployment (pre-#3495)
the result still carries the relay fields unconditionally, so the extra call
is simply unused guidance the old backend never asked for. The OTHER
direction: a caller running #3495-aware guidance against a PRE-#3495 hosted
server — `include_signing_payload` is new schema surface the old server's
strict input validation (`STRICT_INPUT_TOOLS`) does not declare, so it
refuses the argument outright rather than silently ignoring it — no loss:
one refused call (the old server's strict input schema refuses
`include_signing_payload`), and the pair is already on that server's
original result.

Compatibility: additive/removed result fields only (the compact default drops
`typed_data`/`typed_data_b64` from the unconditional shape; `idempotency_key`
is newly always present); one new optional input (`include_signing_payload`)
on two existing tool schemas; no tool renamed, no failure code changed, no
expected-context version changed, no signing wire format changed (the
relayed bytes on the opt-in re-run are byte-identical to what the original
result used to carry unconditionally). `@haven_ai/signer`'s
`DIRECT_RELAY_FALLBACK` text ships in the same PR (`sign-context.ts`) and its
own release, with the hosted `signer_compatibility.check`/`fallback` prose
covering every currently-published signer in the meantime — no gate upgrades
an existing install.

## Task-budget signing handoff and old-signer recovery (#3419, 2026-09-28)

The hosted `haven_open_task_budget` / `haven_close_task_budget` results that
hand off to the signer (an open with `sign_data`; a close in the `closing`
state) carry a `signer_compatibility` notice, the #3277 pattern applied to the
`haven_sign { task_budget_id }` form: `task_sign_context_version` (the SDK's
`TASK_SIGN_CONTEXT_VERSION`, the same constant the backend's
`GET /task-budgets/:id/sign-context` serves and the signer's
`SUPPORTED_TASK_SIGN_CONTEXT_VERSIONS` derives from — never a literal),
`min_signer_version: '0.6.0-alpha.0'` (one exported constant,
`TASK_BUDGET_MIN_SIGNER_VERSION` — the first signer release whose
`haven_sign` accepts the `task_budget_id` form, #3329), `signer_capability`
(the existing capability key), and `check` + `fallback` carrying the recovery
sentence both as prose and as data.

The failure it recovers from: every 0.4.x / 0.5.x signer predates the
`task_budget_id` argument. Its MCP schema does not declare the key, the SDK
strips it before the handler runs, and the call answers the generic
`SIGNING_ERROR` "Pass payment_id (preferred for delegation-rail x402" … —
signed nothing, fetched nothing. Unlike the direct-payment case there is NO
relay fallback: the task-budget context is an `eip712_delegation` payload the
0.5.x unbound allowlist refuses and a 0.4.x signer must not be steered into.
The notice says instead: close the pending budget with
`haven_close_task_budget { task_budget_id }` to release it, update by running
the deployment's upgrade command (`npx -y @haven_ai/connect@<channel>
--doctor`, #3412) and then the repair line it prints, then open the budget
again. The handoff `reason` points at the notice rather than restating the
steps. The local `@haven_ai/mcp` handoffs carried the same notice from the same
builder shape (local `mcp` has no dependency on the hosted package, so the
fields were built from the same SDK constant; the cross-package pins in
`hosted-signer-integration.test.ts` held them together). **Since #4825 the
local handoffs are gone** — that runtime has no signer tool, so it refuses
instead of handing off (see *Task budgets and sub-budget signing are
hosted-plus-signer features* below), and the local builder was deleted with
them. The historic refusal
strings the trigger matches on are pinned verbatim in that test, with their
release-commit provenance (`9c548158`, `f6bd8a63`), so rewording either
historic message fails the build instead of silently disarming the recovery.

Stopping the NEXT occurrence (#3419 Option B): the signer registers its tools
through `registerTool` with a passthrough input schema (keeps unknown keys, so
the tool layer stays the refusal point — deliberately NOT the #2312 strict
registration, which would fail the call in the SDK before any handler and
answer plain McpError text that can carry no structured fields), and the
handler's strict re-parse refuses an undeclared top-level argument — the next
`haven_sign` form a signer predates, starting with #3444's `sub_budget_id` —
with the structured `UNSUPPORTED_ARGUMENT` (`unknown_arguments`,
`signer_version`, `fallback` naming the update command,
`next_action: stop_and_tell_user`; no signature, no audit entry) instead of
being stripped into the generic signing error.
The `initialize` instructions name it. This helps only signers at or past the
release that ships it — which is why the hosted notice above carries the
installed base.

## Client-version signal (#3303, epic #3302)

Every published client names itself on each Haven API request with
`X-Haven-Client: <package>/<version>`. That covers the SDK transport (default
`@haven_ai/sdk/<SDK_VERSION>`, or the embedding package's own name through
`HavenClientConfig.clientIdentity`), the local `@haven_ai/mcp` runtime, the CLI,
the connector's API client, and the signer on its two sign-context reads.
One Haven call deliberately sends no header: the connector's read-only
hosted-identity probe behind `--doctor` / `--unwire` (`probeHostedAgentIdentity`).
It can never be refused and reads no hint. The hosted
`mcp-server` names itself too; it is not one of the five published packages, so
nothing below ever applies to it.

The backend reads the header against one hand-edited table, `CLIENT_COMPAT` in
`packages/core/src/client-compat.ts`. Its values are owner decisions, each recorded where it is made. The first
real one: **`@haven_ai/signer` `min_version` = `0.6.0-alpha.0`** (epic #3302,
owner decision 2026-09-28, option A). Because signers send the header only from
`0.5.0-alpha.1`, this refuses `0.5.0-alpha.1` (the only published signer that
both sends the header and is below it) on the sign-context path until it runs the upgrade command. Older signers
send no header and are never refused. Two things can happen:

| Client is… | Effect | Where |
|---|---|---|
| below `recommended_version` | `client_update` (`required: false`) on any JSON-object response | every route |
| below a **set** `min_version` | 426 `client_outdated`, before the handler runs; nothing written | `POST /payments`, `POST /machine-payments/send`, `POST /x402`, `POST /x402/authorize` for the API clients; `GET /payments/:id/sign-context` and `GET /x402/:id/sign-context` for the signer |
| no header, unparseable, not a published package, or a `0.0.0-dev.*` snapshot | nothing, whatever the table says | — |

A below-minimum client on a route that does not refuse it gets
`client_update.required: true` instead. Sweep, sign, settle, evidence and
status reads are never refused, and neither is an agent on a retired rail. An
idempotent replay is exempt only when the handler would answer it from the
existing row. A `pending_signature` row past its `expires_at` does not qualify:
the handler would replace it with a new payment, so that request is refused
like any new one.

**What a signer minimum does and does not cover.** The signer meets the
backend only when it signs by `payment_id`: that path runs the sign-context
read, which is where the refusal lives. A signer handed `typed_data_b64` or
`x402_expected` directly never contacts the backend before signing, and the
sign and settle legs are never refused. A signer minimum therefore stops the
default path and tells the agent what to run, but it does not guarantee that no
older signer ever signs. The table shipped with every threshold `null` (#3303);
the only threshold set so far is the signer minimum recorded above (#3302).

**How each runtime surfaces it.**
- `@haven_ai/mcp` attaches the hint its own dispatch received as `client_update`
  on the tool result, success or failure. A refusal also keeps the backend's
  `next_tool_omitted_reason` at the top level.
- The signer turns a refusal into `SIGN_CONTEXT_REFUSED` with
  `backend_error_code: 'client_outdated'`, the hint as `client_update`,
  `next_action: stop_and_tell_user`, and a `next_tool_omitted_reason` naming the
  update command. It carries no `fallback`, because relaying other bytes cannot
  help.
- A hint on a successful sign-context read rides on the signing result.
- The update command is built from the **deployment's** connector channel, not a
  client's build-time one. Since #3304 the command itself comes from
  `upgradeCommandFor` in `packages/core/src/client-releases.ts`, the same
  function the public release documents use.
- **Since #3412 the command for the signer, the local MCP and the connector is
  the connector doctor** — `npx -y @haven_ai/connect@<channel> --doctor` — not
  a bare connector re-run. A bare re-run is a setup command: on an
  already-set-up machine it stops at `Missing --setup <hv_setup_...> setup
  token`. The doctor works as pasted, reports an outdated signer and prints
  the exact `--doctor --repair --runtime <runtime>` line; when several agent
  credential directories share the machine, that line names
  `--credentials-dir <dir>`, and a `--repair` without it is refused with one
  command per agent. The same form is named by every upgrade hint the
  published signer (initialize instructions, out-of-date refusal), the SDK
  (`signerUpdateFallback`) and the hosted MCP (signer-compat notices, server
  instructions) emit, from `connectorUpgradeCommand` in `@haven_ai/sdk`;
  core carries a copy, pinned by
  a backend parity test, and a CI guard fails on a bare re-run in an upgrade
  hint. Setup-time hints (identity restore, mid-setup retry) keep the
  bare form. **Not covered:** `--local` installs — `--repair` refuses that
  topology and asks for the original `--local` setup command — and signers
  from 0.4 and older, whose baked-in hints still name the bare re-run (they
  send no `X-Haven-Client`, so they are never refused either).
- **Since #3304 the hint's `notes_url` is set**, to the dashboard's public
  `/releases` page, resolved against the backend's configured frontend URL and
  never against a request header. The same per-package data is served as
  `client_releases` in `GET /discovery` and in each `packages` entry of
  `/.well-known/haven.json`: the version released in source, the thresholds
  from `CLIENT_COMPAT`, the update command, and short notes. A test mutates
  `CLIENT_COMPAT` itself to prove both documents follow the table the backend
  enforces. `notes_url` stays typed nullable, so a client built before this
  keeps parsing it.

**This does not reopen the 2026-08-07 decision above.** That decision ("a
mismatch warns, it does not block") is about the x402 expected-context version a
quote *reports*, and it stands. This signal is a separate mechanism. It refuses
only when an owner has explicitly set a minimum for a package (owner decision
2026-09-25, on #3302), and even then never a client that sends no header. The
signer's refusal comes after prepare, so its contract is "nothing signed or
submitted" and the prepared payment is left unsigned (owner decision
2026-09-25, on #3303).

**`SDK_VERSION` is a bump-managed source constant too** (`packages/sdk/src/client-identity.ts`,
in `release-bump.mjs`'s `SOURCE_VERSION_CONSTANTS` beside `SIGNER_VERSION`,
`HOSTED_SERVER_VERSION`, `CONNECTOR_VERSION` and `CLI_VERSION`). The "fifth
bump-managed constant" heading above counts the constants that existed at #2423
and is left as written. Do not hand-edit `SDK_VERSION` either.

## Typed next steps — the agent contract and its ratchet (epic #3105)

Every response on a payment flow — success or refusal — tells the agent what
to call next in structured fields, and those fields are typed end to end
(#3100–#3104). Informational reads (`haven_get_agent`, `haven_get_allowances`,
`haven_discover_tools` apart from its per-entry hints) carry none.

- **The contract.** On a payment-flow response `next_action` (from
  `AgentPaymentNextAction`) is present. When a tool follows, `next_tool` (`mcp__<server>__<tool>`, the
  default server names), `next_tool_server`, `next_tool_name`,
  `next_tool_server_role` (`hosted` | `signer` — the field to resolve against
  your own server names) and `next_arguments` (spelled in the named tool's own
  vocabulary and accepted by it verbatim) ride together. When no tool follows,
  `next_tool` is absent — never null — and `next_tool_omitted_reason` says why.
  A refusal carries the same fields a success does. Discovery entries carry
  `suggested_tool` + `suggested_arguments` under the same rule, or
  `suggested_tool_omitted_reason`. Provenance decides which tool an MCP row
  names on the hosted surface (#4823): an operator row points at
  `haven_quote_catalog_purchase { catalog_id }`, while a self-submitted
  (`source: 'ingestion'`) row — listed to agents but answered 404 by the agent
  detail read — points at `haven_quote_mcp_tool { merchant_url, tool_name }`,
  the same by-URL path the local runtime names.
- **Where it is built.** The SDK's `createNextStepBuilder`
  (`packages/sdk/src/next-step.ts`) over a target map; the hosted server, the
  signer and the local runtime each declare the shapes they hand off to, and a
  wrong key, a missing required key, an unregistered tool or an omitted
  `nextTool` is a compile error at the site. Cross-surface handoffs are pinned
  both ways in `packages/mcp-server/src/next-step-signer-parity.test.ts`:
  every hosted emission fixture is built for real (the census constants in
  `test-support/next-step-fixtures.ts`: at `ffca80f36`, `EMISSION_FIXTURE_COUNT`
  43 fixtures for `EMISSION_SITE_COUNT` 33 success sites, plus
  `REFUSAL_SITE_COUNT` 63 refusal sites; the doc's earlier figures, 19 for 17
  and 28, predate later sites) and its `next_arguments` parsed with the named tool's strict schema
  on the surface its role names (hosted → hosted, hosted → signer from the
  signer's built package); the signer's declared hosted shapes parse under the
  hosted schemas; the local runtime's discovery hints parse under its own
  tools in `packages/mcp/src/tools.test.ts`. Decision 9 rides along: an action with a default-table mapping names
  its tool.
- **The ratchet.** `npm run lint:next-steps` (`scripts/lint-next-steps.mjs`,
  shrink-only, baseline `scripts/lint-next-steps-baseline.json` committed at
  **zero**) counts, per file, emission blocks that name neither a tool nor a
  reason (`unnamed`) and discovery entries without `suggested_arguments`
  (`discovery_without_arguments`) across the hosted tools, the signer and the
  local runtime. The numerator is defined in the script header, not grepped
  loosely; the `wrongTool()` failure hints (the caller's own arguments) are
  outside it by decision 7. Recorded run at the epic's head (#3104): **0 / 0**.
  Positive control at the epic's base `4ed69592` (`--root=<tree>`): **44
  unnamed + 2 discovery entries across 10 files** (43 under the pre-review
  balanced-block rule; NAMED is tested over the emission's own top-level
  keys, which finds one more `plain-http-x402.ts` block that a nested
  literal had been naming). The gate runs in CI in the
  hosted-server, signer and local-runtime jobs (each fires on its own
  package's changes) and in `backend_checks` beside the request-schema
  ratchet, and is self-tested (`lint:next-steps:test`). It is a step inside
  those required contexts, not a new required context.

## A 429 is a rate limit, not a refusal as made (#4828, 2026-11-12)

The hosted mapper (`packages/mcp-server/src/tools/support/errors.ts`) used to
split an upstream `HavenApiError` on the status alone: below 500 was
`stop_and_tell_user` with "the upstream call was refused as made (4xx);
re-calling it the same way cannot succeed". A 429 is below 500, so a rate
limit reached the agent as a permanent refusal and any stated wait was
dropped. Two branches now sit ahead of that split, both keeping
`code: 'API_ERROR'`:

- **A 429 is the transient step.** `next_action: retry_with_explicit_context`
  (the value the 5xx branch already uses — no new `next_action` value), with a
  reason that says the upstream call was rate-limited, to wait, then re-call
  the same tool with the same arguments (and the same `idempotency_key` where
  the tool has one) **once** before telling the user. The reason names neither
  Haven nor the merchant as the limiter, because both reach this branch: the
  plugin's per-route limit, the hourly x402 cap and the catalog submission
  queue are Haven's, while a merchant's 429 on the unpaid MCP probe arrives as
  a status-only `HavenApiError` (the discovered-endpoint rebuild in
  `tools/support/mcp-context.ts` drops the body). No payment exists at the
  probe, so the re-call is safe there too.
- **The sponsorship budget is the one 429 that stops.** The relayer's
  per-identity window cap (`hybrid_deploy` for an account deploy, `sweep` for
  a sweep) now carries a typed `error_code: 'relayer_budget_exceeded'` on both
  bodies, so the mapper answers `stop_and_tell_user` from the code rather than
  from English. Its reason names the budget and the window: a slot frees when
  the oldest counted operation ages out, up to 24 hours for an account deploy
  and up to 60 minutes for a sweep. The sign route's 429 carries the same code
  as a defensive case; it is unreachable in production, because
  `RelayerBudgetExceededError` is thrown only by `assertRelayerBudget`, whose
  callers are the account-deploy and sweep paths.

**The additive field.** A rate-limit answer carries `retry_after_seconds`
(the number the limiter stated) when its body has one — the hourly x402 cap
sends `retry_after_seconds: 60`. It is absent on every other answer, and no
existing field changes meaning. The plugin states its wait only in a
`retry-after` header, which `HavenApiError` does not carry
(`packages/sdk/src/types.ts`), so that wait stays unread here; carrying it is
a change to the published SDK transport, not to this mapper.

**The local runtime diverges, deliberately.** The local MCP's mapper
(`packages/mcp/src/tools.ts`) answers a 429 `stop_and_tell_user` and relays
the whole `body`, so the wait is not dropped there — the agent reads
`retry_after_seconds` from `body` instead of a top-level field. The
`next_action` therefore differs between the two runtimes for a 429 (hosted:
`retry_with_explicit_context`; local: `stop_and_tell_user`), and the local
answer has no top-level `retry_after_seconds`. `local-hosted-refusal-parity.test.ts`
does not compare these rows: it walks only the fixtures whose hosted answer is
a typed code, and both 429 branches keep `API_ERROR`. Bringing the local
mapper onto the same step is its own change.

## Troubleshooting

- **A stale local `dist/` masquerading as version skew (#1188).** The symptoms
  in the skew table above have a second, unrelated cause: a sibling package
  whose `dist/` is older than its `src/`. `packages/signer`'s dist once sat four
  weeks behind its source and produced
  `signX402FundingTypedData is not a function` plus a pre-#1143 schema rejecting
  `auth.version` — indistinguishable, from the error alone, from a genuinely
  outdated installed signer. The npm scripts rebuild what they depend on
  (`npm run test -w packages/mcp-server` builds sdk and signer first), so this
  only bites when vitest is invoked directly. A `globalSetup` guard now refuses
  to run those suites against a stale dist, and `npm run check:dist` reports it
  on demand. If you see a skew-shaped error locally, check this before
  reinstalling anything.
- **`This x402 binding was already used to build a merchant header` (#2291).**
  Not version skew — a mis-sequenced call, and the message says so on purpose.
  `haven_sign_x402` is a **one-shot**: it signs the funding hash *and* builds
  the merchant header, consuming its own `x402_binding` on the way. The binding
  it returns is therefore already spent, and passing it to
  `haven_x402_sign_header` can only fail. The remedy is the `payment_header`
  that same result already carried; if it is gone, re-run the quote tool with
  the same `idempotency_key`. `haven_x402_sign_header` is the successor to
  **`haven_sign`**, which records the context without consuming it.
  Until #2291 both this and an id the signer never held produced the same
  `x402 funding binding is required…` text, and Haven's own guidance named the
  impossible order — so the message an operator grepped described a caller who
  had not signed, when the caller had signed seconds earlier. The two refusals
  are now distinct: the other one names a signer **restart** as its likeliest
  cause, since bindings live in memory only. An older signer still emits the
  single generic string; that is a diagnosis difference, not a fail-closed
  combination, and no runtime/backend pairing is broken by either.
- **`mcp_transport` rejected as `Invalid arguments` on settle (#2282).** Hosted
  MCP tool arguments are **snake_case**: `mcp_transport` is
  `{ handshake_required: boolean, source: "path" | "bazaar" }`. The SDK type
  `X402McpTransport` and the HTTP API's `mcpCallContext.mcpTransport` spell the
  same value **camelCase** (`handshakeRequired`), and both spellings are
  authoritative at their own boundary — the hosted server bridges them. A
  camelCase `mcp_transport` at the tool boundary is refused, and the refusal
  now names both spellings rather than only saying `handshake_required:
  Required`. Two ways not to hit it: echo the `mcp_transport` a Haven quote tool
  returned (already snake_case), or omit `merchant_url`/`tool_name` entirely and
  let Haven rehydrate the stored context by `payment_id`. Do not "fix" it by
  dropping the field on a merchant that needs the handshake — a wrong-shaped
  transport is refused, never silently ignored, precisely so a caller can tell
  the difference between "my argument was wrong" and "my argument was fine".
- **Broken or root-owned `~/.npm`:** the MCP runtime install first tries the
  user's default npm cache with `--prefer-offline` (which `npx` just warmed, so
  the signer/sdk tarballs are reused instead of re-downloaded). If that fails —
  e.g. a corrupted or root-owned global cache — it automatically retries against
  the isolated `~/.haven/npm-cache`, so a broken global cache still cannot break
  normal agent startup.
- **Invalid Codex TOML:** the connector writes Codex config with a TOML string
  serializer and validates the generated Haven block before writing. The
  expected shape is `command = ".../bin/haven-mcp"` and `args = []`.
- **Unsupported Node.js:** the connector, signer, and MCP packages require
  Node.js `>=22.0.0`, and
  since [#1161](https://github.com/d-hinders/Haven-AI/issues/1161) setup
  **refuses** below it rather than proceeding — see
  [Where the Node floor is enforced](#where-the-node-floor-is-enforced). The
  message names your version and how to upgrade. Upgrade Node and rerun setup.
  If setup succeeded but the signer now refuses to start, the runtime launching
  it is on an older Node than the shell you upgraded.
- **Signer exits at import with `ERR_PACKAGE_PATH_NOT_EXPORTED` (`Package
  subpath './edge' is not defined by "exports"`, #3173):** a hand-installed
  `@haven_ai/sdk` older than the signer's exact pin sits beside a signer that
  imports `@haven_ai/sdk/edge`. No key is read on this path. Run
  `npx -y @haven_ai/connect@<channel> --doctor`, then the `--doctor --repair`
  line it prints: repair reinstalls the pinned pair from the stored credentials
  (a bare connector re-run is a setup command and stops at "Missing --setup").
- **Local MCP runtime install failed:** rerun the connector command. It will reuse
  local credentials and install the pinned runtime into `~/.haven/mcp-runtime`,
  falling back from the user's default npm cache to `~/.haven/npm-cache` if the
  global cache is unusable.
- **Signer runtime install failed (`signer_runtime_install_failed`, #1586):**
  the hosted+signer setup now fails CLOSED — no runtime configuration is
  written at all, because a config pointing at an uninstalled signer looks
  wired but structurally cannot start (Codex kills the multi-minute npx cold
  install at its 120s `startup_timeout_sec`, leaving corrupted `_npx` dirs).
  There is no silent npx fallback anymore. The install budget is 10 minutes
  with console heartbeats; on failure, address the cause (network, npm cache)
  and rerun the connector command your backend hands out (its `connector_package`;
  `@alpha` in production — see the version-skew section above, #2422).
- **Claude Code does not show Haven:** run `claude mcp get haven` and confirm
  it points at the wrapper path. If `add-json` is unavailable, the connector
  falls back to `claude mcp add --scope user -- <wrapper>`.
- **Tools missing after restart:** run `npx -y @haven_ai/connect@<channel> --doctor`,
  then the `--doctor --repair` line it prints. Repair reuses the stored
  credentials, reinstalls or reuses the pinned runtime, rewrites the wrapper and
  runtime config, and re-diagnoses. With several agents on the machine the line
  names `--credentials-dir <dir>` (#3412).
- **Tool naming across runtimes (#1588, corrected by #2550):** guidance
  responses — since #3102 every hosted refusal, and since #3103 the edge
  signer's refusals, which name hosted tools through the role fields for the
  same reason — carry `next_tool` (Claude-family namespaced,
  `mcp__<server>__<tool>`, kept byte-identical for existing clients), the pair
  `next_tool_server` and `next_tool_name` (the bare tool name), and — since
  #2550 — `next_tool_server_role`, one of `hosted` or `signer`; and — since
  #3101 — `next_tool_omitted_reason` whenever no tool follows (`next_tool` is
  then absent, never null).
  **Read the role, not the server name, whenever your servers are not the
  default pair.** `next_tool` and `next_tool_server` are built from a literal
  in the SDK's next-step builder (`NEXT_TOOL_SERVER_NAMES`, since #3101; the
  hosted server before that), so they always say `haven` / `haven-signer`; that is
  the most the hosted server can know, because local server names are the
  client's config and never reach Haven. Two runtimes are already not the
  default: Codex names servers by config key — connect writes `haven_signer`
  (underscore; TOML) — and a connector run with `--name <slug>` wires
  `haven-<slug>` / `haven-signer-<slug>` (#1694; the slug is immutable once
  wired). On either, `next_tool` and `next_tool_server` name a server the
  client does not have, so resolve `next_tool_server_role` against your own
  configured servers and call `next_tool_name` there. The pair alone was the
  documented answer until #2550 and was wrong for the named case, which is why
  the role exists rather than a fourth spelling of the name.
  **Several pairs on one client (#3738):** once a harness carries more than
  one Haven pair, the role alone is ambiguous — `signer` matches every signer.
  The hosted instructions, the signer's own instructions and the `haven-pay`
  skill all carry one rule: act as one agent per task, ask which when the user
  has not said, and send each signer call to the signer of the hosted server
  called (`haven-<slug>` with `haven-signer-<slug>`, bare `haven` with
  `haven-signer`, Codex `haven` with `haven_signer`). Identity, not name, is
  the check: the signer's `initialize` instructions state the agent id and
  delegate address it is bound to, compared with `haven_get_agent`'s `id` and
  `delegateAddress`. In the hosted instructions both this rule and the
  server-name rule above sit inside the first 2,000 characters, because
  Claude Code truncates server instructions at about 2,048 (pinned by the
  hosted server's own tests).
- **`--doctor` / `--repair` (#1589):** a stuck setup is diagnosable without a
  hand-built MCP client: `npx @haven_ai/connect@alpha --doctor --runtime
  <runtime>` checks config, credentials, the pinned signer runtime, the hosted
  MCP, and runs the live signer handshake (reporting its compat versions),
  printing one repair action per failure and exiting non-zero. `--repair`
  reinstalls the pinned runtime and rewrites wrapper + config from STORED
  credentials — no new setup token, keys untouched. `--json` for automation.
  Since #3210 `--runtime` is optional for `--doctor` (the doctor checks the
  runtime the setup recorded, and fails honestly when no record names one)
  and required for `--repair`.

  The hosted MCP `tools/list` check proves only that its endpoint responds; it
  does not authenticate a bearer token. Credential verdicts instead use the
  authenticated, read-only agent-identity endpoint: an accepted identity read
  leaves a superseded key spend-capable, a 401/403 reports it already revoked,
  and a network or malformed response remains explicitly unverifiable. This
  prevents a static MCP capability listing from being mistaken for proof that
  an old credential can still act.

  **`--repair` rewrites only the pair the directory owns (#1910).** It reads
  the wiring slug from that directory's own `signer-runtime.json` sidecar
  (#1696) and writes `haven-<slug>` / `haven-signer-<slug>`, so repairing a
  named agent leaves a co-wired bare agent's `haven` / `haven-signer` entries
  untouched. Before #1910 it passed no slug at all, so `serverNamesFor()`
  defaulted to the bare pair: repairing a named agent silently did nothing for
  it and overwrote a *different*, working agent's entries with this one's
  credentials. Nothing to re-type — the slug is on disk, never a flag you have
  to remember to repeat.

  **A local runtime-spec override is a doctor finding, never a silent default
  (#2424).** A developer iterating on the signer, SDK or local MCP can set
  `HAVEN_SIGNER_SPEC`, `HAVEN_SDK_SPEC` or `HAVEN_MCP_SPEC` to anything
  `npm install` accepts (`file:/abs/path`, a `.tgz`, an explicit version) and
  setup, `--repair` and `--rekey-finish` install THAT instead of the pinned
  manifest sibling — into `~/.haven/signer-runtime/override-<hash>` (or
  `mcp-runtime/override-<hash>`), keyed by a hash of the resolved specs so the
  version-named directory the pinned path reuses is never touched, and never
  reused between runs. Setup prints `RUNTIME SPEC OVERRIDE ACTIVE` first; the
  sidecar records it under `runtime_spec_override` with the versions npm
  actually installed; the wrapper carries a comment; and `--doctor` reports a
  failing `runtime_spec_override` check ("runtime spec overridden — not the
  pinned manifest") whenever the sidecar says so OR a variable is set in the
  doctor's own shell. The handshake probe still requires every manifest tool,
  a malformed value is refused before npm runs, and with no variable set the
  install is byte-for-byte the pinned one. The manifest table above is the
  pin; an override is installed beside it and does not move it. Details:
  `packages/connect/README.md` § *Installing an unpublished signer / SDK / MCP build*.

  **`--doctor` also reports a parked re-key (#1911).** A `--rekey` that was
  started and never finished leaves `rekey-pending.json` behind (see
  **Credential safety** below); the doctor names it per agent — present or
  expired, when it started, its **public** address and its path, in both the
  human output and `--json`'s `agents[]` — and never its contents. Since
  **#1915** the pending file is also a discovery tell in its own right, so a
  directory holding nothing else is inventoried too, as `agents[]`
  `classification: "parked"` (a fifth value beside `wired` / `superseded` /
  `retired` / `orphaned`). An expired
  one is its own actionable failure rather than a generic warning, and
  `--repair` does not delete it: an expired TTL is a refusal to *use* the
  parked key, not a licence to destroy key material the owner may still be
  mid-flow on. What the doctor **can** settle is whether the backend re-key
  completed — Haven already reporting the parked address proves it did, and the
  fix is `--rekey-finish`. What it **cannot** settle is, within a re-key that
  did *not* complete, whether the owner got as far as the on-chain revoke:
  nothing local records the backend stage, and the doctor's identity probe
  reads two fields (`id`, `delegate_address`) from `GET
  /machine-payments/agent` — whose response carries `id`, `name`, `status`,
  `account_address`, `delegate_address`, `delegate_account_address`,
  `chain_id` and `execution_rail` since #2914, plus `superseded_by` (#3772),
  `parent_sub_budgets` (#3330) and `passport` (#4721) since, **none of them a
  re-key stage**. Widening the probe
  would not help, because the field does not exist on that endpoint to read.
  So "never started on the agent page" and "started, revoked,
  abandoned" look identical from the machine. The second is
  [#1868](https://github.com/d-hinders/Haven-AI/issues/1868)'s wedge — old
  delegations revoked, no new ones issued, recoverable only by an owner
  re-grant — so the check points at the agent page instead of implying the
  harmless reading.
- **`--tombstone <dir>` (#1681):** retires an agent credential directory in
  place — replaces its `bin/haven-signer.mjs` with a self-contained diagnostic
  that logs a `HAVEN-TOMBSTONE`-marked retirement notice (agent id, date,
  reason, restart-every-long-lived-host guidance) to the host's MCP stderr log
  and exits 1, and records `TOMBSTONE.json` for `--doctor`, mirrored into the
  credential root's ledger (`~/.haven/tombstones/<agent_id>.json` for the
  default root; `<root>/.tombstones/` inside any other — #3251) so the
  retirement stays listed after the directory is deleted. Touches NO key
  material and revokes nothing (connect reports; the user revokes). Exists
  because long-lived MCP hosts load wiring at startup: after an agent is
  recreated and its old directory removed, every stale host spawn-fails on the
  old path forever, masked as `Connection closed` — and after a chain of
  recreations each long-lived process can be parked on a DIFFERENT dead agent,
  so the remedy is restarting EVERY such host, not one. `--doctor` reads the
  tombstone: keys removed ⇒ informational "tombstoned (keys removed)"; key
  still present ⇒ the #1688 live-probe verdict stands unchanged (a tombstone
  is a marker, never a revocation). Optional `--reason` / `--replaced-by`.
  No token, no `--runtime` needed. Recreation-case only: `--rekey` rewrites
  credentials in place at a stable path and writes no tombstone (owner decision
  on epic #1694, 2026-08-21) — shipped in #1700, see the next entry.

  **Address it by DIRECTORY, never by agent id** ([#2175](https://github.com/d-hinders/Haven-AI/issues/2175)).
  A named agent's directory is its wiring **slug**, which never equals its agent
  id (#1696), so a path built from an id does not exist for it and the command
  refuses with `tombstone_directory_not_found` — retiring nothing. Enumerate
  `~/.haven/agents`, or take the `directory` values from `--doctor --json`.

  **Under `--json` the refusal is now on stdout too.** Success has always been
  one `{"tombstoned": true, …}` line; a failure used to write to **stderr
  only**, leaving stdout empty — indistinguishable, to a caller parsing stdout,
  from a run whose stream it had merely stopped reading. It now emits
  `{"tombstoned": false, "error": {"code", "next_action"}}` and still exits 1,
  with the prose mirrored to stderr: the same discipline #2091 gave the main
  connect path — including its gate on `message`, which is present **only** for
  a connector-authored `ConnectError`. The directory guard is not the only
  thing that can throw (the `mkdir`/`chmod`/`writeFile` calls after it are all
  bare), and a plain `Error`'s raw OS text can carry arbitrary local path
  detail, so that text stays on stderr and never enters the JSON record.
  **A failed surviving copy is not a failed retirement (#3259):** the ledger
  mirror is written after `TOMBSTONE.json`, and it used to throw, so `--replace`
  skipped the key teardown and left a directory that read `retired` with a key
  that could still spend. The mirror is now best-effort. `--tombstone --json`
  succeeds with `"recordPath": null` and `"mirrorError"` set to the errno code
  only (never the OS message), `--unwire --json` gains `mirror_error`, text
  output says the record was not written and where, and `--replace` logs a
  warning, still removes the key files, and names the failure in the outcome's
  `retirement_mirror_errors`. Residual: if the key teardown ITSELF fails after
  `TOMBSTONE.json` is written, the directory stays tombstoned with its key —
  `--doctor` shows it as `tombstoned — key material still present`, but nothing
  retries it, and directories half-retired by earlier connectors are not
  repaired. This closed a real field failure — a `haven-reset` agent
  reported "the tombstone command did not create `TOMBSTONE.json`" with no error
  to show for it, having built the path from an agent id. The reset skill now
  enumerates directories and verifies the result before deleting key material.
  **Every subcommand does this now** ([#2184](https://github.com/d-hinders/Haven-AI/issues/2184)),
  not just `--tombstone`: `--unwire`, `--rekey` and `--doctor`/`--repair` emit
  the same record through one shared helper, so a fourth subcommand inherits
  the behaviour instead of re-deciding it. Each envelope carries its own
  branch's success discriminant **inverted** — `{"unwired": false}`,
  `{"rekey": "failed"}`, `{"doctor": "failed"}` — so a failure can never be
  read as a success payload. That distinction earns its keep twice: `--doctor`'s
  success output *is* a JSON report (a failure record carries no `checks`), and
  `--unwire` reports `{"unwired": true}` with a **non-zero exit** when some
  runtime entries were refused or the key-material teardown was retained
  (#3123), which is a partial result rather than a failure.
- **`--unwire [<dir>]` (#2169):** removes one agent's local wiring. Address
  the target by its credential directory, or resolve it with `--name <slug>`
  (or `--credentials-dir`). The positional value is always an existing
  credential directory: named agents use their wiring slug, while unnamed
  agents normally use their agent-ID directory. It **tombstones first**, so a
  long-lived host still resolving the old wrapper receives the retirement
  diagnosis, and the #2155 mirror remains after teardown. It then removes that
  agent's hosted-MCP + local signer pair from every supported runtime config,
  removes its Hermes dotenv API-key line, and deletes the target directory's
  local signer, pending re-key, and stored API key.

  This is local teardown, **not** backend revocation: Connect reports what it
  changed, while the owner uses **Remove agent…** on the Haven agent page. Named
  pairs are uniquely addressable. For the shared bare `haven` /
  `haven-signer` pair, however, it removes entries only with positive proof
  that this directory owns the wrapper or Hermes key; otherwise it refuses
  rather than guess and unwire another agent. See the published
  [`@haven_ai/connect` unwiring guide](../../packages/connect/README.md)
  for the operator procedure and full supported-runtime list.
- **`--rekey` / `--rekey-finish` (#1700):** replaces an agent's signing key on
  the machine that runs it. **Two phases, because the owner's dashboard sits
  between them** — every backend re-key route is owner-authenticated and
  explicitly refuses an agent credential, so the connector never calls them:
  1. `npx @haven_ai/connect@alpha --rekey [--name <slug>]` reads the stored
     credentials, confirms with Haven that this agent is re-keyable (refusing a
     legacy-rail or revoked one the way the backend would), generates a fresh
     keypair **locally**, and prints its public address to paste into the agent
     page. The agent keeps working on its old key throughout — nothing else is
     touched.
  2. `--rekey-finish --api-key <key> --runtime <name>` takes the API key the
     agent page shows once, refuses unless it authenticates AND belongs to this
     agent AND Haven's recorded signing address matches the one this machine
     generated, then rewrites the credential files **in place at the unchanged
     path** and rewrites only this agent's MCP config pair.

  **Passing `--runtime` on the finish step is not optional in practice.** The
  API key is embedded in the runtime config itself (`Authorization: Bearer …`,
  or Hermes' `MCP_HAVEN[_SLUG]_API_KEY`), so without it the credential files are
  correct and every wired host still presents the retired key and 401s. The
  connector says so loudly rather than exiting quiet.

  The wiring slug does not move, so the MCP server names do not move, so no host
  needs reconfiguring — but every long-lived host does need a **restart**, since
  each holds its wiring snapshot from its own start time. The completion output
  prints the runtime's exact restart command plus that sweep instruction.
- **Signer verified by handshake (#1587):** in the hosted+signer topology the
  connector now proves the LOCAL signer with the same stdio handshake the
  hosted server gets (initialize → tools/list → required signer tools, the
  list derived from the pinned `@haven_ai/signer`). `localSignerConfigured`
  is true only after that handshake; a signer that cannot spawn, times out,
  or lacks tools reports `local_signer_probe_<status>` with a re-run
  instruction — setup can no longer exit 0 on an unstartable signer.
- **Credential safety:** private signing keys live only in the agent's own
  credential directory — `~/.haven/agents/<slug>/signer.json` for a default
  setup, or `~/.haven/agents/<agent-id>/signer.json` when the pair is unnamed
  (a `--bare` run, or a `--replace` without `--name`; #1696, default
  re-derived in #3737). During a
  re-key there is a SECOND, transient private key in that same directory:
  `rekey-pending.json` holds the newly generated key between `--rekey` and
  `--rekey-finish`, at the same `0600` mode, and is deleted once the rewrite
  lands (#1700). It expires after 24h and a fresh `--rekey` replaces it, so it
  is not a place a key accumulates — but it is a place one can be found, which
  is why it is named here rather than left to be discovered. **Expiry is a
  refusal, not a deletion (#1911):** an *abandoned* re-key — started, never
  finished — leaves the file in place past its TTL, so the bytes outlive their
  usefulness. `--doctor` now reports one when it finds one (that it exists, its
  age, its public address and its path — never its contents), and neither it
  nor `--repair` removes it; dropping key material stays the owner's call.
  **Including in a directory with nothing else left in it (#1915):** the
  doctor's directory scan used to require an `identity.json` or a
  `TOMBSTONE.json`, so a directory holding *only* `rekey-pending.json` was
  never inventoried and its key never named. It now counts as a third tell,
  and such a directory is classified `parked` — no agent, just the key a
  re-key generated. No shipped flow produces that shape (`--rekey` writes
  beside an `identity.json` that stays put), so expect it only after an
  out-of-band deletion, a hand-copied file, or a restore that recovered one
  file. Its abandoned-key handling is the ordinary one: an expired or
  unreadable parked key outside the reported agent fails `--doctor` through
  the existing `rekey_pending_elsewhere` check, an open one stays
  informational, and nothing is deleted for you. Do not paste
  signer files, pending-rekey files, wrapper sidecars, or command output into
  public issues without redacting secrets.

> **#4534 (2026-10-29, the purchase correlation key on the outcome report):**
> `haven_report_x402_outcome` gains two OPTIONAL arguments —
> `purchase_group_id` (1–128 chars) and `merchant_response` (an object). On an
> accepted outcome they ride the same `POST /machine-payments/evidence` report
> the tool already posts: the backend derives the group id from the merchant's
> own invoice/order id through a small explicit per-merchant map (Bitrefill:
> `invoice_id`), or takes the agent's key when the merchant supplies none, and
> records it on the `machine_payment_evidence` row (migration 123) together
> with `parent_payment_id` — the purchase payment a fee call paid for, resolved
> from the group's own members. The receipt (`haven_list_receipts` and the
> evidence echo) gains `purchase_group_id` and `parent_payment_id`; both are
> null on an ungrouped payment, which is fed exactly as before.
> - **Version skew is a refusal, not a silent drop.** Both arguments are
>   opt-in: a caller that supplies neither sends a byte-identical body to
>   before. A NEW MCP/SDK against a backend older than migration 123 gets the
>   existing request-validation refusal (400) for the two new body fields,
>   because `MachinePaymentEvidenceRequest` is `additionalProperties: false` —
>   the feature is unavailable there rather than quietly ignored.
> - **Hosted picks this up on deploy**; local MCP/connect users need an
>   `@haven_ai/mcp` / `@haven_ai/connect` release (both pin the SDK exactly),
>   as with #3764 and #3778.
> - `tools-list.snapshot.json` moves: two new optional arguments on one tool.
>   No tool is added or removed, no version floor or consent-hash input
>   changes, and `lint:next-steps` stays at zero.
>
> Scope of this note: those arguments, the two receipt fields and the snapshot
> row. Nothing else in this document was re-verified.

Historical verification records for this document are kept in the [archive](../archive/re-verification-notes-2026-11.md).
