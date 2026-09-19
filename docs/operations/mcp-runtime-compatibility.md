---
owner: "@d-hinders"
status: current
contract: true
covers:
  - packages/mcp/**
  - packages/connect/**
  - packages/signer/**
  - packages/mcp-server/src/tools.ts
  - packages/mcp-server/src/tools/**
  - .github/workflows/publish.yml
  - packages/cli/src/connect-runner.ts
  - packages/backend/src/routes/machine-payments.ts
  - packages/sdk/src/account-reads.ts
  - packages/sdk/src/client.ts
  - packages/sdk/src/mcp-merchant-transport.ts
  - packages/sdk/src/merchant-completion.ts
  - packages/mcp-server/src/description-size.test.ts
  - packages/backend/src/modules/x402/delegation-authorize.ts
  - packages/backend/src/modules/x402/replay.ts
  - packages/cli/src/commands.ts
  - packages/cli/src/commands.test.ts
  - packages/frontend/src/components/connect-agent/__tests__/runtime-status-copy.test.ts
  - packages/connect/src/installed-clients.test.ts
  - packages/backend/src/middleware/retired-safe-names.ts
  - packages/backend/src/routes/transactions.ts
  - packages/backend/src/routes/user-accounts.ts
  - packages/backend/src/routes/agents.ts
  - packages/backend/src/routes/agent-connection-setups.ts
  - packages/backend/src/domain/agent-payment-taxonomy.ts
  - packages/backend/src/modules/transactions/csv-export.ts
  - packages/sdk/src/types.ts
  - packages/sdk/src/payment-mappers.ts
  - packages/sdk/src/x402.ts
  - packages/sdk/src/tool-descriptions.ts
  - packages/sdk/src/next-step.ts
  - packages/mcp-server/src/server.ts
  - packages/mcp-server/src/next-step-signer-parity.test.ts
  - packages/mcp-server/src/test-support/next-step-fixtures.ts
  - scripts/lint-next-steps.mjs
  - scripts/lint-next-steps-baseline.json
  - .github/workflows/ci.yml
last-verified: "2026-09-19"
---

# MCP Runtime Compatibility

> **Scope:** This covers the **local stdio MCP runtime** installed during agent
> setup — the advanced/local path. For the default topology (hosted MCP + local
> signer) and how to deploy it, see [hosted-mcp.md](hosted-mcp.md).
>
> **Re-verified unchanged (#3131, and again for #3133):** this doc is coupled to
> `.github/workflows/ci.yml`. #3131 added one dependency-free step to the
> repo-config job, running a read-only CI guard; #3133 extended that guard to a
> third input and rewrote the step's comment to say so. Nothing in this document
> moves under either: no tool is added, renamed or re-shaped, no description text
> changes, no schema or argument changes, and the runtime-skew and consent-hash
> contracts are untouched. Neither change emits runtime code — #3133's whole
> deliverable is a declaration and a documentation page, and its diff against
> `packages/cli` and `packages/connect` is empty by design. Recorded here rather
> than silently passed over because the coupling gate cannot tell a CI-wiring
> edit from a contract edit, and a contract doc cleared without a reader is how
> #2274 shipped a false sentence past a green tick. Kept as one note rather than
> one per CI edit, so this section does not accumulate a paragraph every time a
> step is added.
>
> **Recent re-verification (#3116):** the signer's merchant-header boundary
> (`buildX402PaymentHeader`, `packages/signer/src/core.ts`) now refuses an
> x402 challenge whose entries all advertise a transfer method or payment
> flow the SDK cannot construct (`extra.assetTransferMethod: 'permit2'`, or
> an unrecognized `extra.paymentFlow`) — via the same shared
> `selectStandardPaymentOption` it already selected through, so the local
> runtime's refusal and the SDK clients' refusal are the one rule, not two.
> A mixed challenge still signs the supported entry behind the unsupported
> one, and the explicitly-supported pair (`eip3009` + `authorization`) still
> signs — the positive controls in `packages/signer/src/core.test.ts` pin
> both. No tool name, schema, tool-NAME set, consent hash or next-step shape
> moves: the refusal is the pre-existing `HavenApiError` "No compatible
> payment option" path, now with a clause naming the capability reason.
> Skew: none — the behavior change is inside both runtimes' bundled SDK, so
> they tighten together; an older bundled SDK keeps the old (sign-anyway)
> behavior, which is the bug this closes. Nothing else in this document was
> re-verified in this pass.
>
> **Recent re-verification (#3128):** `haven_list_receipts` is RE-SHAPED on
> both runtimes — the one deliberate non-additive change on this surface
> since #2330. Its schema gains an optional `cursor` (the previous page's
> `next_cursor`, a receipt id) beside `limit`, and its result is the page
> object `{ receipts, total, hasMore, nextCursor }` instead of the bare
> receipts array: `total` is how many receipts Haven holds for the agent
> (`0` = none exist; there is no indexing delay behind this list), `hasMore`
> says the page was cut at `limit`, and `nextCursor` is fed back as `cursor` —
> which the backend refuses with 400 if it is not a uuid or names no receipt
> of this agent, so a stale cursor is an error rather than a silently empty
> page (an older hosted deploy answered it with an empty page).
> Both runtimes call the SDK's new `listReceiptsPage()`; the SDK's
> `listReceipts()` keeps returning the array, and the HTTP envelope
> (`GET /machine-payments/receipts`) is additive (`total`, `has_more`,
> `next_cursor` beside the unchanged `receipts`), so the qa-agent's and any
> SDK caller's reads are untouched. Skew: an older `@haven_ai/mcp` bundles an
> older `@haven_ai/sdk` and keeps serving the array with `limit` only; the
> hosted server serves the page from its deploy onward; against a backend
> older than #3128 the SDK maps the three page fields to `null` ("unknown"),
> never a fabricated `0` / `false`. The strict/permissive split, the tool-NAME
> set and the consent hash do not move (the hash covers identity, tool names
> and allowances, not schemas — `packages/mcp/src/consent.ts:81-103`). The
> two allowance reads are reconciled additively: `HavenAllowance` gains
> `remainingDisplay` (derived client-side by the same function the bootstrap
> summary uses) and `HavenAgentAllowanceSummary` gains `id` and
> `tokenAddress`, pinned field for field on one fixture. The shared
> description fragments (`listReceipts`, `getAgent`, `getAllowances`) were
> re-cut under the #1591 mean cap — `packages/mcp-server/src/description-size.test.ts`
> carries the measured mean (873.91 ≤ 874 at the delivered head; the test,
> not this sentence, is the instrument) — the `getAgent` prose lost
> phrasing, not guidance. Nothing else in
> this document was re-verified in this pass.
>
> **Recent re-verification (#3126):** the sufficiency read `GET
> /machine-payments/balance-coverage` (tool `haven_check_funds`) ships in this
> same change as its backend route, so there is no version window to argue.
> Round-2 rework relocated the route's two query guards (`token`,
> `amount_atomic`) verbatim into `modules/mpp/balance-coverage-guards.ts`,
> exported through the mpp barrel, to hold the #3029 shrink-only ratchet
> baseline for `routes/machine-payments.ts` (19, unchanged). The wire contract
> this document describes is untouched: same checks in the same order,
> byte-identical 400 bodies (pinned by the 62-test real-DB route suite), no
> tool added or renamed beyond this PR's own `haven_check_funds`, no schema or
> description change, and the skew-flatness this document asserts holds — the
> endpoint and the tool that calls it deploy in the same train. Nothing else
> in this document was re-verified in this pass.
>
> **Recent re-verification (#3132):** `haven_list_receipts`'s `selectionGuidance`
> prose changed on BOTH runtimes (one shared fragment,
> `packages/sdk/src/tool-descriptions.ts` `listReceipts`): it now says "This
> agent's payment evidence, not the wallet's transaction history (sweeps,
> funding legs, other agents)" instead of inviting a transaction-history read,
> and its `behavior` was re-cut to stay under budget — the exact text is
> `packages/sdk/src/tool-descriptions.ts` `listReceipts`, and
> `packages/mcp-server/src/description-size.test.ts` holds it under the #1591
> budget; the hosted description mean was re-measured under the
> #1591 budget by `description-size.test.ts`. Each receipt row now carries
> `scope: { source: 'agent', filter: null }` — additive on the wire
> (`MachinePaymentReceipt.scope`, optional) and on the SDK type
> (`HavenPaymentReceipt.scope`, absent on an older backend, never invented), so
> an older SDK against a newer backend drops the key in `mapPaymentReceipt` and
> a newer SDK against an older backend sees none; no tool added, renamed or
> re-shaped, no argument or schema change, and the version-skew and
> consent-hash contracts do not move (descriptions are not a skew axis — #2330
> precedent). Nothing else in this document was re-verified in this pass.
>
> **Recent re-verification (#3169):** the edge signer's `haven_sign` no longer
> signs a bare `payload_hash` (no `payment_id`, no `typed_data` /
> `typed_data_b64`, no `x402_expected`): that arm was raw secp256k1 over caller
> bytes for the retired AllowanceModule rail, and it now answers the structured
> `BARE_HASH_REFUSED` refusal (`next_action: stop_and_tell_user`, a typed step
> with no tool and the reason) — the same envelope shape as the #3001/#3103
> signer refusals. `haven_sign`'s ARGUMENTS are unchanged (the refusal is on
> one combination of them), its description text changed to say so, and no
> tool was added, renamed or re-shaped, so the consent hash (identity + tool
> names + surface version, `packages/signer/src/consent.ts`) and the
> version-skew contract do not move; an older signer against the same backend
> keeps signing the bare hash WHEN A CALLER HANDS IT ONE — no Haven flow emits
> that shape (the legacy rail answers 410), so the exposure is caller-driven;
> updating the signer is the remedy, as for any signer defect. The opposite
> skew — a new signer against a pinned pre-#1254 hosted image that returns
> `payload_hash` with no `typed_data_b64`, WHEN the agent relays that hash as
> the only argument — now gets `BARE_HASH_REFUSED` where it previously got a
> signature the account rejected on-chain anyway (AA24): a behaviour change for
> a pinned old backend, and the better outcome. With `payment_id` against that
> same image the answer is unchanged — `HavenSignContextError` with the
> `typed_data_b64` fallback (`sign-context.ts` refuses a context missing
> `typed_data`). Nothing
> else in this document was re-verified in this pass.
>
> **Recent re-verification (#3171):** the SDK's paid retry — `MerchantCompletion.retryRequest`
> (behind `fetch()`, `payX402Quote()`, `resumeX402Payment()`) and
> `HavenClient.completeX402MerchantCall()` (the hosted leg) — now re-initializes
> once and resends the SAME payment header when the merchant answers HTTP 404 +
> JSON-RPC `-32001` carrying `error.data = { settled: false, next_action:
> 'reinitialize_then_retry_same_payment_header' }`. No tool added, renamed or
> re-shaped on either runtime: arguments, schemas, descriptions and the
> registered tool-name set are untouched, so the version-skew and consent-hash
> contracts do not move. Skew: an OLDER SDK (pre-#3171) against the NEW demo
> merchant still surfaces that 404 as `MERCHANT_REJECTED_AFTER_FUNDING` — the
> pre-#3171 behaviour, nothing worse, and the merchant's message now tells the
> agent the remedy in words; a NEW SDK against an OLDER merchant sees a bare
> `-32001` without `error.data` and does not resend — the conservative
> direction. Neither skew moves money differently. `last-verified` is not
> re-stamped: it already reads 2026-09-19. Nothing else in this document was
> re-verified in this pass.
>
> **Recent re-verification (#3172):** the edge signer's audit sidecar is now
> created owner-only, tightened in place when found permissive, and rotated at
> 8 MiB; and `payload_hash` / `typed_data_hash` are bounded on the tool
> schemas to a 32-byte hash (`^0x[0-9a-fA-F]{64}$`, previously `+`). No tool
> added or renamed, no argument name added or removed; the one client-visible
> shape change is the `pattern` on those two string arguments in the advertised
> `inputSchema` (`tools/list`), which the consent hash does not read, so the
> consent hash (`packages/signer/src/consent.ts`
> hashes identity, tool names and surface version) does not move, and the
> consent text's audit promise is unchanged in wording. Version skew: every
> value Haven emits for those two fields is a 32-byte hash, so a new signer
> against any backend sees no change; an older signer keeps accepting hex of
> any length WHEN A CALLER HANDS IT ONE, which no Haven flow does — updating the
> signer is the remedy, as for any signer defect. The sidecar change is local
> to the machine and has no wire or skew dimension. `last-verified` is not
> re-stamped: it already reads 2026-09-19. Nothing else in this document was
> re-verified in this pass.
>
> **Recent re-verification (#3125):** the `haven_list_receipts` description
> prose changed on BOTH runtimes — it is one shared fragment
> (`packages/sdk/src/tool-descriptions.ts` `listReceipts`), composed verbatim by
> the local stdio surface and the hosted `contracts.ts` module alike, and the
> edit adds the payer-provenance boundary: `parties.treasuryAccount` is Haven's
> authoritative payer record, `protocolReceiptPayload` is the merchant's
> `PAYMENT-RESPONSE` relayed verbatim, merchant-controlled and unverified — not
> Haven's record — and its payer may differ from `payerAddress`. No tool added,
> renamed or re-shaped: arguments, schemas, the strict/permissive split and the
> registered tool-NAME set are untouched, so the version-skew and consent-hash
> contracts do not move (descriptions are not a skew axis — #2330 precedent —
> and `computeConsentHash` hashes identity, tool names and allowances only, not
> description text, verified at `packages/mcp/src/consent.ts:81-103`; an older
> runtime simply serves the older guidance text from the `@haven_ai/sdk` it
> bundles). The fragment was sized to keep the hosted description mean under
> the #1591 per-tool cap (873.04 ≤ 874 bytes measured at the delivered head),
> so the new guidance cost old phrasing, not the budget. The SDK type edit is
> doc-comment-only (`HavenPaymentReceipt.protocolReceiptPayload`), no wire
> shape change. Nothing else in this document was re-verified in this pass.
>
> **Recent re-verification (#3054):** the hosted guided prepare's over-budget
> compare moved server-side. `haven_prepare_catalog_purchase`'s step 6 no
> longer reads `GET /machine-payments/allowances` and compares locally; it
> calls the new additive SDK method `client.precheckBudget(...)`
> (`POST /machine-payments/budget-precheck` — agent-key auth, money-path rate
> limit, orchestration in `modules/mpp/budget-precheck.ts`), one Haven round
> trip replacing the allowances GET so the preflight's round-trip count is
> unchanged (#1348 budget). The server decides with the SAME derived-budget
> read the allowances endpoint uses (#1090 + the #1145 enforcer read, never
> `agent_allowances`) and refuses through the #3053 choke point, so the
> `payment_refusals` ledger records the refusal with `source =
> 'hosted_prepare'` (migration 087 widens the CHECK; the dedupe fold key is
> unchanged). The tool relays the decided 403 byte-identically —
> `DELEGATION_BUDGET_EXCEEDED` shape characterization-pinned (95/95 in
> `catalog-purchase.test.ts`) — and ANY other precheck outcome (transport
> failure, a retired rail's 410, an older backend without the route)
> degrades to the existing `sufficient: null` warning, never a refusal. No
> tool added, renamed or re-shaped: arguments, schemas, descriptions and the
> strict/permissive split are untouched, the local stdio runtime is not on
> this path (`haven_pay_mcp_tool` has no pre-check today and needs none), and
> the skew-flatness this document asserts holds — deploy order is backend →
> hosted MCP, and an older MCP against the new backend merely degrades to the
> warning path. The new route answers 410 on both retired rails like every
> rail-aware surface. Nothing else in this document was re-verified in this
> pass.
>
> **Recent re-verification (#3000):** the hosted server's
> `MERCHANT_UNRESPONSIVE_AFTER_FUNDING` refusal (the merchant-timeout branch of
> `deliverMerchantPayment` in `src/tools/paid-mcp-completion.ts`) now branches
> on the settlement scheme the way #2983 made `MERCHANT_REJECTED_AFTER_FUNDING`
> do: on erc7710 (no funding leg) it drops every sweep mention and points at
> `haven_get_payment_status` (`next_action: check_status_later`); eip3009 keeps
> verify-then-sweep. The code-keyed texts (`skill-content.ts`, its frontend
> mirror, `AgentPaymentFailureCodeDescriptions`, the SDK README) branch on
> scheme too. No tool added, renamed or re-shaped; the local runtime is not on
> this path. Nothing else in this document was re-verified in this pass.
>
> **Recent re-verification (#3001):** the signer's `fetchX402SignContext`
> (`packages/signer/src/sign-context.ts`, the authenticated
> `GET /x402/:id/sign-context` read behind the `{ payment_id }` form of
> `haven_sign` / `haven_sign_x402`) now throws a typed `HavenSignContextError`
> at each of its four throw sites — timeout, unreachable host, a non-ok
> backend response (404/410/…), a malformed body — instead of the generic
> `HavenSigningError` #2985 described below. `normalizeError` in
> `packages/signer/src/tools.ts` serialises it with `code`
> (`SIGN_CONTEXT_TIMEOUT` / `SIGN_CONTEXT_UNREACHABLE` /
> `SIGN_CONTEXT_REFUSED` / `SIGN_CONTEXT_MALFORMED`) and `next_action`, routed
> per refusal class: transport failures and unreadable bodies carry
> `fallback: 'typed_data_b64'` + `stop_and_tell_user`; a backend REFUSAL
> carries `http_status` + `backend_error_code` and no fallback, with 410
> `expired` → `payment_window_expired` + `retry_with_new_quote` (the signer's
> existing `PAYMENT_WINDOW_EXPIRED` routing) and the rest `stop_and_tell_user`
> — the same shape `HavenUnsupportedSignerVersionError` already carried, so a
> caller can route on `code` instead of parsing `message`.
> These codes are signer-local, never part of `@haven_ai/sdk`'s
> `AgentPaymentFailureCode` taxonomy, and never reach the backend's
> REST/OpenAPI surface. `message` text and every other refusal in this
> document are unchanged; `instanceof HavenSigningError` still holds for the
> new class. Nothing else in this document was re-verified in this pass.
>
> **Recent re-verification (#2983):** the local runtime (`packages/mcp/src/tools.ts`,
> `haven_pay_mcp_tool`) now mirrors the hosted mapping below — a merchant
> `503 { error: 'merchant_not_ready', … }` refusal on the quote path is
> reported as `MERCHANT_NOT_READY` (on the local envelope the field is spelled
> `nextAction: stop_and_tell_user` — its failure shape is camelCase, unlike
> the hosted `next_action`; `retry_with_new_quote: true`; the merchant's `reason_code` / `retry_after_s`
> in the message) BEFORE the #1301 same-origin discovery fallback, on both the
> original probe and a retry against a discovered endpoint. A bare 503 (no
> matching JSON body) still falls through to today's discovery-miss path
> unchanged. The two runtimes are at parity on this refusal now; no tool
> added, renamed or re-shaped, and the wire code is imported from
> `@haven_ai/sdk`'s `AgentPaymentFailureCode`, never redefined locally.
> Separately, the hosted paid-retry refusal (`MERCHANT_REJECTED_AFTER_FUNDING`,
> `deliverMerchantPayment` in `packages/mcp-server/src/tools/paid-mcp-completion.ts`)
> is now scheme-aware: on erc7710 (no funding leg — the signature IS the
> settlement child) the refusal no longer carries `sweep_stranded_funds`
> guidance or a stranded-funds claim, since nothing moved; it says the
> merchant refused delivery, no settlement ran, and the budget is intact, and
> surfaces the merchant's `reason_code` / `retry_after_s` when its body is
> `merchant_not_ready`. The eip3009 branch is unchanged — the delegate wallet
> genuinely may hold stranded funds there, and the sweep guidance stays.
> Nothing else in this document was re-verified in this pass.
>
> **Recent re-verification (#2985):** the signer's one network call —
> `fetchX402SignContext` (`packages/signer/src/sign-context.ts`, the
> authenticated `GET /x402/:id/sign-context` read behind the `{ payment_id }`
> form of `haven_sign` / `haven_sign_x402`) — now carries
> `AbortSignal.timeout(SIGN_CONTEXT_TIMEOUT_MS = 15_000)`; a timeout surfaces
> as the same `HavenSigningError` class as an unreachable host, naming the
> timeout and the `typed_data_b64` fallback. No tool, argument, version
> field, consent hash or signing logic changes; the local runtime and the
> hosted server are not on this path. Nothing else in this document was
> re-verified in this pass.
>
> **Recent re-verification (#2979):** the hosted server's shared MCP quote
> probe (`src/tools/support/mcp-context.ts`, `quoteMcpToolCall`) now
> recognises a merchant's own `503 { error: 'merchant_not_ready', … }`
> refusal and reports it as the additive failure code `MERCHANT_NOT_READY`
> (`next_action: stop_and_tell_user`, `retry_with_new_quote: true`, the
> merchant's `reason_code` / `retry_after_s` in the message) BEFORE the #1271
> same-origin discovery fallback, which used to report any non-402 status
> as `API_ERROR` "no discovery document". The SDK's
> `X402UnexpectedStatusError` now carries the merchant's JSON body. No tool
> added, renamed or re-shaped; strict-input list, consent hash and
> version-skew contract untouched. At the time of this pass the local runtime
> (`packages/mcp`) was NOT on this path — since corrected to parity, see the
> #2983 re-verification above. Nothing else in this document was re-verified
> in this pass.
>
> **Recent re-verification (#2975):** the hosted server's two cap refusals
> that still bypassed the guidance envelope — `PRICE_EXCEEDS_MAX` and
> `INVALID_MAX_AMOUNT` in `src/tools/support/cap-price.ts` — now go through
> `HostedToolError` like every other refusal in that module, so the wire
> failure carries `next_action: stop_and_tell_user` (and, for
> `PRICE_EXCEEDS_MAX`, `retry_with_new_quote: true`). Codes, messages, status
> and the point of refusal (before any funding intent) are unchanged; no tool
> added, renamed or re-shaped, so tool identity, the strict-input list, the
> consent hash and the version-skew contract are untouched. The local
> runtime (`packages/mcp`) has no cap contract at all — this is hosted-only.
> Nothing else in this document was re-verified in this pass.
>
> **Recent re-verification (#2908, naming epic #2906 phase 1):** the local
> runtime's readers accept both the Safe-vocabulary and the account-vocabulary
> names and prefer the new. Credential FILE: `account_address ?? safe_address
> ?? safeAddress` in both `@haven_ai/signer` and `@haven_ai/mcp` — the two old
> keys are read **permanently** (a file on disk never rewrites itself).
> Environment: `HAVEN_ACCOUNT_ADDRESS ?? HAVEN_WALLET_ADDRESS ??
> HAVEN_SAFE_ADDRESS`; the two old names are removed one release later
> (#2914). `@haven_ai/connect` now WRITES `account_address` only, and
> `--doctor`'s `credentials` check reports which name a credential set carries
> (`stored as account_address` / `stored under the pre-#2908 name safe_address —
> still read`). The CLI calls `/user/accounts*`, sends `?accountId=` beside
> `?safeId=`, and dual-emits `account_id`/`safe_id` and
> `account_address`/`safe_address` on `--json` and the CSV header for the
> window. **The version-skew contract does not move:** `SUPPORTED_X402_EXPECTED_
> VERSIONS` is still `[1, 2, 3]` (asserted by
> `signer/src/naming-window-no-version-change.test.ts` beside the untouched
> `version-skew.test.ts`), `sign_data.components.payer_account` is response
> metadata twin of `components.safe`, never part of the signed payload, and
> the consent hash input is the resolved address, not the key it came from —
> an old-file machine's ack stays valid. The Supported Runtime Manifest table
> below is unchanged. The `GET /machine-payments/agent` field list quoted under
> `--rekey` was the P0 (#2907) shape when this note was written; #2914 rewrote
> that list in place to the contracted shape, so read this sentence as history
> — `account_address` is no longer "a server twin P0 does not emit yet", it is
> the only spelling.
>
> **Re-verification (#2914, naming epic #2906 phase 5 — the CONTRACTION):**
> the window the #2908 note above describes is CLOSED. Read that note as
> history from here; this one states what the runtimes do now.
>
> - **Credential FILE reads are unchanged and remain PERMANENT.**
>   `account_address ?? safe_address ?? safeAddress` still resolves in both
>   `@haven_ai/signer` and `@haven_ai/mcp`, still tested against an old-shape
>   file. A file on disk never rewrites itself, so this is not part of the
>   window and never was. `@haven_ai/connect`'s own `identity.json` /
>   `agent.json` fallback is the same permanent class.
> - **The retired ENV names are gone.** `HAVEN_ACCOUNT_ADDRESS` is the only
>   spelling read; `HAVEN_WALLET_ADDRESS` and `HAVEN_SAFE_ADDRESS` resolve to
>   nothing. This is the one upgrade step an operator has to take: a machine
>   configured through either old variable stops finding its account address.
> - **The CLI sends one name — from this release.** `?accountId=` only,
>   `account_id` only in the connection-setup body, and `--json` / the CSV
>   header carry `account_id` / `account_address` with the old columns
>   dropped. **An INSTALLED 0.2.x CLI does not**, and that distinction is the
>   point of this document: #2908 told it to dual-send both names, and it
>   does. The server therefore refuses a retired name on RELIANCE rather than
>   presence — `safeId` alone is a 400, `safeId` beside a matching `accountId`
>   is accepted, the two disagreeing is a 400. So a 0.2.x CLI keeps working
>   against a contracted backend, and **there is no release-ordering
>   constraint**: neither side has to ship first. Had the refusal keyed on
>   presence, `activity list`, `activity export` and `agents connect` would
>   have 400'd for every user until the CLI reached `latest`.
> - **The enum flipped.** `fund_account_or_raise_allowance` is the only value
>   the server emits and the only one the SDK taxonomy declares; the backend
>   mirror and the SDK are still pinned key-for-key
>   (`agent-payment-taxonomy.parity.test.ts`, 10/10).
> - **`sign_data.components.safe` is gone**; `payer_account` is the payer.
>   `components.account` still means the DELEGATE account address — a
>   different address, deliberately never merged with it.
>
> **The version-skew contract still does not move, and that is the load-bearing
> claim in this note.** `SUPPORTED_X402_EXPECTED_VERSIONS` is `[1, 2, 3]`, the
> advertised capability list is the same list, and both are asserted by
> `signer/src/naming-window-no-version-change.test.ts` beside the untouched
> `version-skew.test.ts` — green in the signer's 210/210 run for this slice.
> The reason holds unchanged from #2908: `components` is response metadata,
> never part of the signed expected-context payload, and the consent hash's
> input is the resolved ADDRESS rather than the key it arrived under, so an
> old-file machine's acknowledgement stays valid across this contraction.
> `MCP_VERSION`, `CONNECTOR_VERSION` and `runtime-manifest.ts` are untouched by
> this slice, so the Supported Runtime Manifest table below stands.
>
> **Recent re-verification (#2258):** Connect's `pending_approval` wording
> describes zero spending authority, with the exact sweep-recovery exception
> documented as stranded-balance recovery only. This does not change the local
> runtime's capabilities, consent hash, or version-skew contract.
>
> **Recent re-verification (#2808):** the hosted server's cross-tool safety
> support (error normalization and `HostedToolError`, `runTool`, agent
> guidance and purchase summaries, cap/price selection, MCP transport
> serialization and merchant-context validation, the expiry-aware signing
> context, quote responses and payment-status predicates) moved from
> `tools.ts` into `src/tools/support/*`, still behind the same facade. The
> runtime contract — tool names, schemas, input policies, refusal text,
> response shapes, and payment behavior — is unchanged, and
> `parse`/`parseStrict` remain in the #2807 parsing seam.
>
> **Recent re-verification (#2809):** the hosted server's state,
> direct-payment and recovery handlers — `haven_get_agent`,
> `haven_get_allowances`, `haven_get_payment_status`,
> `haven_get_resume_state`, `haven_send`, `haven_pay`, `haven_submit`,
> `haven_sweep_delegate`, `haven_list_receipts` and `haven_verify_receipt` —
> moved from `tools.ts` into `src/tools/state-direct-recovery.ts` and are
> composed back into `createToolHandlers` from there. The runtime contract is
> again unchanged: the same tool names are registered, the strict/permissive
> split is untouched (`haven_get_agent` and `haven_get_allowances` remain the
> two permissive tools, and both moved), schemas and descriptions still come
> from the #2807 contracts module, and the version-skew and consent-hash
> contracts do not move because the registered tool-NAME set does not.
>
> **Recent re-verification (#2912, naming epic #2906 phase 3b):** a **data**
> migration renamed the `account_type` VALUE `'safe'` to `'legacy_safe'` on
> `smart_accounts` and tightened its CHECK — schema/data only, no wire
> contract change (the OpenAPI `account_type` field was already typed as a
> bare string, and the one enum that narrows it already excluded `'safe'`
> since #2413). `packages/cli/src/commands.test.ts` is covered here only
> because it carries a mock fixture (`account_type: 'safe'` → `'legacy_safe'`)
> used to test the "grant refuses a non-delegation-rail agent" case; the
> assertion, the CLI behavior, the tool names, schemas, version-skew and
> consent-hash contracts are all unchanged. No other file this document
> covers was touched by #2912.
>
> **Two sections sit outside that scope**, each for its own reason:
>
> - [Where the Node floor is enforced](#where-the-node-floor-is-enforced) applies
>   to **both** topologies. The floor is a property of the machine, not of the
>   chosen topology — scoping it to the local path is exactly the mistake
>   [#1161](https://github.com/d-hinders/Haven-AI/issues/1161) fixed, so it is
>   documented in one place rather than split across two.
> - [Signer / hosted-MCP version skew](#signer--hosted-mcp-version-skew-1138-1143)
>   and its [pre-payment detection](#detecting-skew-before-a-payment-1155)
>   subsection are the **opposite** case: they apply only to the hosted MCP +
>   local signer topology, because skew needs two independently versioned
>   components and the local runtime signs in-process with the SDK it shipped
>   with. They live here because this is the runtime-compatibility doc, not
>   because they describe the local path.
>
> **Recent re-verification (#2810):** the same for the hosted server's catalog,
> quote and prepare handlers — `haven_discover_tools`,
> `haven_submit_catalog_entry`, `haven_quote_mcp_tool`, `haven_pay_mcp_tool`,
> `haven_quote_catalog_purchase` and `haven_prepare_catalog_purchase` — which
> moved from `tools.ts` into `src/tools/catalog-purchase.ts` and are composed
> back into `createToolHandlers` from there. The runtime contract is again
> unchanged: the same tool names are registered, the strict/permissive split is
> untouched (none of these six is permissive, and none changed), and schemas
> and descriptions still come from the #2807 contracts module. `haven_pay_mcp_tool`'s
> local twin is unaffected — the #1301 bounded discovery helper it shares still
> lives in `@haven_ai/sdk`, so the skew-flatness this document asserts is a
> property of the SDK helper, not of which mcp-server file calls it.
>
> **Recent re-verification (#3078):** the merchant layer adds ONE field to
> the catalog entry — `merchant { id, slug, name, listing_status,
> is_test_merchant }` — on the SDK's `HavenCatalogEntry` (OPTIONAL there:
> an installed SDK against a backend that predates migration 088 gets the
> field absent, never null — `client-characterization.test.ts` pins both
> readings) and on the hosted `haven_discover_tools` map in
> `src/tools/catalog-purchase.ts` (wire-shaped, spread in only when the SDK
> carries it). Additive on the read side only: no tool name, schema, strict/
> permissive split, expected-context version or signer contract changes, and
> the local server's `haven_pay_mcp_tool` twin and the #1301 discovery helper
> are untouched. The skew-flatness this document asserts holds in both
> directions — an old server against a new backend ignores the field, a new
> server against an old backend omits it.
>
> **Recent re-verification (#3080):** one hosted-server TEST added
> (`src/tools/catalog-purchase.test.ts`): `haven_discover_tools` reads
> `GET /catalog` only — never `/merchants` — and so never returns a
> `coming_soon` prospect. No runtime file under `src/tools/**` changed; the
> compatibility contract is untouched.
>
> **Recent re-verification (#2850):** the CLI's transaction CSV/JSON export
> relabelled `delegate_sweep` from "allowance funding" to "sweep" — the old
> label was the retired rail's name for what is now the shared gasless-sweep
> lane (`infra/chain/relayer-reads.ts` feeds it its wallet). One display string
> in `exportType` (`packages/cli/src/commands.ts`); no command surface, flag,
> auth step, consent hash, or version-skew contract changes, and nothing about
> the local runtime's capabilities moves.
>
> **Recent re-verification (#3127):** the transaction feed (whose route and
> CSV module are on this document's coverage list) now stamps a converted
> amount triple on every row — `convertedAmount` / `convertedCurrency` /
> `convertedFxRate`, struck in the user's `currency_preference` (SEK when
> none is set), from the row's OWN stored book-time capture
> (`machine_payment_evidence.amount_sek` columns and the migration-082
> `fx_rates` map), never a serve-time price read; `fxRates` rides declared
> for auditability. Compatibility treatment: ADDITIVE to a published JSON
> surface — `amountSek`/`fxRateSek`/`fxSource` are unchanged and no field is
> renamed, so there is nothing to dual-emit and no release boundary to
> wait for; the agent-visible effect is new optional keys on
> `activity list --json` rows (the CLI forwards them untouched), and an
> existing consumer parsing `amountSek` reads byte-identical values. The
> CSV export APPENDS two columns at the END of its contract
> (`reporting_currency`, `converted_currency`) — the export's amounts stay
> the deliberate fixed-SEK accounting branch — which shifts nothing for an
> importer keyed on pre-#3127 column indices. No MCP tool, flag, auth step,
> consent hash, or version-skew contract changes; nothing about the local
> runtime's capabilities moves.
>
> **Recent re-verification (#2811):** the same for the hosted server's
> plain-HTTP x402 lifecycle handlers — `haven_quote_x402`,
> `haven_pay_x402_quote`, `haven_resume_x402_payment` and
> `haven_report_x402_outcome` — which moved from `tools.ts` into
> `src/tools/plain-http-x402.ts` and are composed back into
> `createToolHandlers` from there. The runtime contract is again unchanged:
> the same tool names are registered, the strict input policy on all four is
> untouched (these four parse inside a failure envelope, as before), schemas
> and descriptions still come from the #2807 contracts module, and the
> signing-context helper this slice calls still lives in the #2808 shared
> support — the module itself never signs. The header-name guidance agents
> read for x402 retries is produced by the same `buildAgentGuidance` call as
> before, so the dual-wire-name rule this document pins is unaffected by the
> move.
>
> **Recent re-verification (#2812):** the same for the hosted server's
> paid-MCP completion handlers — `haven_complete_mcp_tool` and
> `haven_settle_mcp_tool` — which moved from `tools.ts` into
> `src/tools/paid-mcp-completion.ts`, together with the merchant delivery /
> context-rehydration helpers #2808 had parked in shared support
> (`resolveMerchantCallContext`, `deliverMerchantPayment`,
> `preflightMcpPaymentHeader` and the `ResolvedMerchantCallContext` shape) —
> they were single-slice by call-site and now live with their only caller.
> `tools.ts` is now a composition-only facade: every hosted tool is owned by
> exactly one capability module, `createToolHandlers` is capability spreads
> only, and the permanent ownership/import-boundary guard lives in
> `src/tools/module-boundaries.test.ts`. The runtime contract is again
> unchanged: the same tool names are registered, both completion tools remain
> strict-input, schemas and descriptions still come from the #2807 contracts
> module, and the #2282 fail-closed ordering (merchant-call context resolved
> BEFORE any funding relay, on both schemes) moved with the handlers verbatim.
>
> **Recent re-verification (#2970):** "settled means verified" — the erc7710
> branch of `haven_settle_mcp_tool` (`paid-mcp-completion.ts`) now reports
> `settled: true` only once the backend has confirmed the merchant's reported
> settlement hash on-chain (reusing the SDK's existing evidence report,
> `HavenClient.completeX402MerchantCall` → `MerchantCompletion.reportEvidence`),
> and otherwise returns `code: 'DELIVERED_UNSETTLED'` or
> `code: 'SETTLEMENT_PENDING'` with `next_action: check_status_later`.
> `haven_complete_mcp_tool` has no erc7710 branch of its own: it always takes
> the funding-leg path, and `deliverMerchantPayment`'s unconditional
> funding-leg status read 409s on a `submitted` erc7710 intent before any
> merchant call is made — pre-existing, unchanged here. This is an ADDITIVE
> response-shape change on `haven_settle_mcp_tool`, same schemas, same strict-input policy, same
> #2282 fail-closed ordering — nothing here changes tool identity, the local
> signer contract, or version skew. `haven_get_payment_status` gains a new
> additive `next_action` value, `awaiting_settlement_evidence`, for a
> `submitted` erc7710 intent whose settlement window has passed with no
> verified evidence — the local runtime forwards it unchanged, same as every
> other `next_action` value.
>
> **Recent re-verification (#2972):** a new HOSTED-only tool,
> `haven_report_settlement_evidence { payment_id, settlement_tx_hash }`, is
> the remedy #2970's guidance could not name — an agent holding the
> merchant's real erc7710 settlement transaction hash (from
> `PAYMENT-RESPONSE.transaction`, or a prior settle/complete result's
> `settlement_tx_hash`) can now hand it to Haven directly instead of only
> waiting on the settlement sweep or the 3009-shaped `haven_report_x402_outcome`
> (which takes no hash and refuses a non-`confirmed` intent). It reuses the
> SAME backend seam (`POST /machine-payments/evidence` →
> `observeErc7710Settlement`, fail-closed, #2092) and reports the same three
> outcomes as the #2970 settle/complete gate: `settled: true` only once Haven
> verified the hash on-chain, else `code: 'DELIVERED_UNSETTLED'` or
> `code: 'SETTLEMENT_PENDING'`. Strict input (23rd hosted tool, in
> `STRICT_INPUT_TOOLS`), agent-scoped (a foreign `payment_id` 404s and is
> classified `DELIVERED_UNSETTLED`, never a write), a zero settlement hash is
> refused client-side before any network call
> (`HavenClient.reportSettlementEvidence` /
> `MerchantCompletion.reportSettlementEvidence`). No local-runtime twin: this
> is a hosted-only tool, so the version-skew contract, the consent hash, and
> the local signer surface are all unchanged. `haven_get_payment_status`'s
> `awaiting_settlement_evidence` message names this tool as the remedy when
> the agent holds a hash; on the #2970 settle gate, `SETTLEMENT_PENDING` (the
> agent demonstrably holds a non-zero hash — it is echoed in the same
> response) points `next_tool` / `next_arguments` at this tool with that
> hash, while `DELIVERED_UNSETTLED` keeps `haven_get_payment_status` as
> `next_tool` and names this tool in prose for a hash the agent may still
> obtain. On a refusal the tool reads the payment's status for its summary
> rather than asserting one (`unknown` when the read itself is refused).
>
> **Recent re-verification (#2968):** the response vocabulary is completed at
> the agent-facing surface, additively. `deliverMerchantPayment` now collapses
> a zero/placeholder `settlementTxHash` (the demo merchant's `ZERO_TX_HASH`
> "delivered, not settled" marker, recognised by the SDK's
> `isZeroSettlementTxHash`) to `null` at the response boundary on BOTH
> schemes — a sentinel shaped like a hash is never handed to an agent as one,
> and `null` means "no transaction known". The erc7710 settled arm also emits
> `delivered: true` (the delivery half of the vocabulary rides on every arm,
> so `settled` and `delivered` cannot disagree in either direction), and an
> unconfirmed erc7710 settlement additionally carries a machine-readable
> `SETTLEMENT_UNCONFIRMED` warning — new additive
> `AgentPaymentWarningCode.SettlementUnconfirmed` in `@haven_ai/sdk` types —
> whose message carries the intent's `expires_at`; the summary gains an
> additive `expires_at` on the same arm. Tool-contract wording on
> `haven_settle_mcp_tool` and the hosted `instructions` state the rule
> (settled = on-chain verified, never merchant 2xx; null hash rule), and the
> hosted instructions' post-funding sweep line is now scheme-aware to match
> #2983's erc7710 refusal guidance. Same tools, same schemas, same strict-
> input policy, same fail-closed ordering; no route, migration, or signer
> change, and the #2970 gate decides settlement exactly as before — these
> changes only narrow what the response claims. Regression tests are
> mutation-proven (removing the classify gate or the zero-hash nulling
> re-fails them).

Haven Connect Agent 2 installs a local stdio MCP runtime for Codex Desktop,
Codex CLI, and Claude Code. The connector must not rely on `npx` at agent
startup; setup preinstalls a tested runtime and writes a stable wrapper:

`haven_discover_tools` remains skew-flat across the local and hosted MCP
topologies: since #1350 it accepts the same optional `search` argument on both
surfaces, alongside the existing `category` and `rail` filters. `category`
matching is case-insensitive after trim, `search` matches catalog `name`,
`description`, or `category`, and omitting the new field preserves the older
request shape exactly. Since #1716 both surfaces also accept the same optional
`verified` filter (`any` | `verified` | `operator`) and return the `source` /
`domain_verified` / `verified_payable` badge fields on each entry — added to
BOTH surfaces together, so the skew-flat claim holds unchanged. Since #2978,
`verified` is not a pure provenance filter: `verified=verified` returns any
entry, operator-curated or self-submitted, whose endpoint Haven watched
answer a live quote probe (`verified_payable === true`); `verified=operator`
still filters on provenance alone. The result is still read-only discovery
metadata: catalog prices are indicative hints, never payment authority.
`verified_payable` means the endpoint answered a live probe; `domain_verified`
is the separate, stronger claim that ownership of the domain was proven —
operator rows can carry the former without the latter. Version skew, stated:
the filter runs in `@haven_ai/sdk`, so the hosted server (deployed from
`dev`) applies the badge semantics as soon as #2978 lands, while a published
local runtime keeps the older provenance semantics (`source === 'ingestion'`)
until the next release bump republishes the sdk pin — the surface is
skew-flat, the meaning of `verified=verified` is not, for that window.

The default hosted MCP + local signer topology additionally exposes
`haven_quote_mcp_tool` and `haven_quote_catalog_purchase` (#1397). They are
read-only live-price probes for an arbitrary MCP merchant or a curated catalog
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
caller is unchanged and there is nothing to upgrade**. `haven_submit` is a
hosted-only tool — the local stdio MCP does not expose it — so nothing here is
skew.

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
directly), so the local stdio `haven_quote_x402` passthrough gains none of
these fields — it has no server-side agent read to predict from, and a local
caller already holds its own key/rail state.

One **deliberate local/hosted skew**, recorded because this table exists to
catch exactly that: the **local stdio** `haven_quote_x402` is a bare
passthrough of the SDK's `X402Quote`, so it now also QUOTES an erc7710-only
merchant (it used to throw) — but it returns the SDK's own `acceptedScheme`
(camelCase) and no `erc7710_only` convenience field, since none of the hosted
response shaping runs there. The local **pay** paths are unchanged in behavior
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

```text
~/.haven/agents/<agent-id>/bin/haven-mcp
```

## Supported Runtime Manifest

The source of truth is `packages/connect/src/runtime-manifest.ts` (the SDK and
signer versions are pinned there; `@haven_ai/mcp` tracks its own `MCP_VERSION`,
and `@haven_ai/connect` its own `CONNECTOR_VERSION`).

> **Re-verification (changelog-heading gap, 2026-09-14):** this doc's covered
> trees changed only by a CHANGELOG heading — `release-bump.mjs` now rewrites
> `## Unreleased` to `## <version> — <date>` in the five published packages.
> No version constant, tool, capability or version-skew surface moved, so the
> Supported Runtime Manifest table and every compatibility claim below stand
> unchanged. Recorded rather than date-stamped because the table is what a
> consumer reads to know which versions work together.

> **Re-verification (0.2.1-alpha.0 release, 2026-09-16):** unlike the previous
> release, this one DOES move runtime surfaces, and the table's four rows moving
> to `0.2.1-alpha.0` is the smaller half of that. **Most of it is additive, but
> NOT all of it — an earlier draft of this note said "additive in every case" and
> independent review was right that this is the worst possible document in which
> to be loose about that**, since it is what a consumer reads to decide whether
> an upgrade is safe. Two changes alter existing behaviour:
>
> - **`merchant_not_ready` in the LOCAL runtime (#2983) changes a code, not just
>   adds one.** A merchant's `503 { error: 'merchant_not_ready' }` now maps to
>   `MERCHANT_NOT_READY`; it previously fell through to the discovery path and
>   surfaced a different code. An unchanged caller gets a different code for the
>   same merchant response. The same change, and #3000, also REMOVE sweep
>   guidance from the erc7710 post-funding refusals — correctly, since erc7710
>   has no funding leg to sweep, but the guidance text a client may surface has
>   changed.
> - **`settled` changes truth value (#2968, #2971).** An erc7710 payment where
>   the merchant returned 200 without on-chain confirmation now reports
>   `settled: false` where it reported `true`. This is the change most likely to
>   surprise an existing integration, and it is deliberately fail-closed.
>
> The additive remainder: a new hosted tool `haven_report_settlement_evidence`
> (#2973); `expected_settlement_scheme` / `expected_funding_leg` /
> `expected_settleable` on quotes (#2991); `merchant_not_ready` parity in the
> LOCAL runtime, which previously refused differently from hosted (#2983);
> sign-context refusals carrying `code` / `fallback` / `next_action` like the
> version-mismatch refusal already did (#3001); `next_action` on
> `PRICE_EXCEEDS_MAX` / `INVALID_MAX_AMOUNT` (#2975) and on
> `MERCHANT_UNRESPONSIVE_AFTER_FUNDING` (#3000); and a 15-second abort on
> `fetchX402SignContext` where it previously hung (#2985).
>
> **Each of those was documented in this file by the PR that shipped it** — the
> coupling gate forces that, and a grep for every symbol above finds it here
> already. This note does not re-state them; it records that the release
> carries them as a set.
>
> **The version-skew contract itself is unchanged, with the two exceptions named
> above stated rather than buried.** No refusal was REMOVED and no EXISTING field
> became required, so an older signer paired with a 0.2.1 backend still
> understands every refusal it understood before and ignores the added fields,
> and a 0.2.1 signer against an older backend sees those fields absent — the same
> window the contract below already describes. What an integration must
> nonetheless re-read before upgrading is the `settled` semantics and the local
> `merchant_not_ready` mapping: neither is a skew problem between signer and
> backend, both are behaviour changes visible to a caller at any pairing.

> **Re-verification (0.4.0-alpha.0 release, 2026-09-19):** the manifest table
> above is re-pinned by the bump to `0.4.0-alpha.0` for `connect`, `mcp`, `sdk`
> and `signer`; the four numbers were not copied by hand. **Re-read, not
> rubber-stamped**, and the table's non-version rows still hold: the Node floor
> is unchanged (`>= 22.0.0`, CI on LTS 24 via `.nvmrc`), and the Codex and
> Claude Code rows still describe local stdio MCP.
>
> **MINOR, and one tool's output contract is why.** `haven_list_receipts` on
> the local MCP runtime now returns
> `{ receipts, total, hasMore, nextCursor }` **instead of a bare array**, and
> takes an optional `cursor` (#3128, via the SDK's new `listReceiptsPage`). For
> an MCP server package the **tool result shape is the published contract**, so
> an agent or script that indexed the old array meets an object. Under the 0.x
> convention that made 0.2.0 and 0.3.0 MINOR, a break takes the minor step.
>
> **Record how nearly this was missed**, because the lesson is about the
> instrument. Commit subjects carried no `!:` marker, and BOTH declaration-level
> checks — a name-level `.d.ts` diff and a TypeScript-compiler-API pass that
> recurses three levels into exported members — reported **zero removals across
> all five packages**. They are correct and they are blind here: a tool's
> runtime result shape appears in no `.d.ts`. The release's own CHANGELOG is
> what names it. Treat "the declaration surface lost nothing" as evidence about
> declarations only, never as evidence that a release carries no break.
>
> The SDK is NOT part of this break: `listReceipts(): Promise<HavenPaymentReceipt[]>`
> is byte-identical to the published `0.3.0-alpha.0` declaration and
> `listReceiptsPage` is additive. Measured against the published tarballs, the
> built declarations remove **zero** names across all four affected packages and
> add **24** (23 `sdk`, 1 `signer`).
>
> **What else moved that a skew reader should know.** The typed-next-step
> surface reaches all three published runtimes at once (epic #3105: `sdk` gains
> `NextStep` and `createNextStepBuilder`, `signer` gains
> `SIGNER_HOSTED_HANDOFF_SHAPES`, and the hosted MCP will not compile a bare
> `nextAction`). These are **outputs**, and nothing validates their presence at
> runtime, so **a stale signer or local runtime simply emits no typed next
> step** — the state it was already in before this release. Note this is the
> fail-open-on-absence direction, which is NOT what the skew table below models:
> that table is about a stale half refusing input it cannot validate. The sharp
> edge there is *"An undeclared argument is refused, not stripped (#2312)"* —
> checked, and it does not bite: `git diff` over `packages/signer/src/tools.ts`
> across this range shows no `toolSchemas` schema change at all, only a
> `Record<…>` → `as const satisfies Record<…>` annotation, so no new signer
> argument exists to be refused.
>
> The x402 retry-target guards (`assertSecureX402RetryTarget` and siblings,
> #3097) and the unsupported-transfer-method refusal (#3116) are additive at the
> declaration level but **narrow runtime behaviour** in the fail-closed
> direction — an old caller that relied on the paid retry following a
> merchant-declared `http://` resource, or on a `permit2` entry being signed as
> EIP-3009, now gets a typed refusal. Neither was a documented capability.
>
> `last-verified` is left as it stands: it **already reads 2026-09-19** from
> #3116's change earlier today, so there is nothing to bump. This note is a
> genuine re-read of the manifest table and the skew section rather than a
> scoped check of one constant — but a date that is already correct does not get
> re-stamped for the sake of it (#1366).

> **Re-verification (0.3.0-alpha.0 release, 2026-09-17):** this release is a
> **BREAK**, and the version says so — MINOR under the 0.x convention, the same
> reason 0.2.0-alpha.0 was. It carries the naming-P5 contraction (#2914 /
> #3075), which ends the compatibility window 0.2.0-alpha.0 opened.
>
> **What an old client now meets.** Retired paths answer **410** with a typed
> body naming their replacement; retired REQUEST names are **refused with 400**
> naming the new field rather than ignored; the next-action enum emits
> `fund_account_or_raise_allowance`, and the SDK stops translating it for you.
> **That last one is a response-only enum** — `openapi/spec.ts` says so at the
> enum itself, "No route takes this as request input" — so nothing rejects an
> old value on input; what went is the SDK's client-side normaliser
> `canonicalAgentPaymentNextAction`, with `isFundAccountOrRaiseAllowance`. A
> 0.3.0 SDK against a pre-0.3.0 server therefore passes the old value through
> unrecognised rather than mapping it. Measured against the published `@haven_ai/sdk@0.2.1-alpha.0` tarball,
> **seven exported declarations are removed and none added**
> (`AgentPaymentNextActionAccountAlias`, `AgentPaymentNextActionWire`,
> `accountAddressTwins`, `canonicalAgentPaymentNextAction`,
> `isFundAccountOrRaiseAllowance`, `readAccountAddress`, `readAccountId`).
>
> **Two response names deliberately SURVIVE this release**, and that is the one
> skew statement a reader must not miss: the `safes` envelope key on
> `GET /user/accounts` and `safeName` on the `GET /transactions` feed. (A third
> retired name also survives — the `safes` key on `GET /transactions/filters` —
> but it is read only by the dashboard, which ships from the same branch as the
> backend, so it carries no published-client skew and is not part of this
> contract. It is named in the release shard.) Both twins are
> declared `deprecated` in the spec, and both are still emitted, because
> `@haven_ai/cli@0.2.1-alpha.0` — what `latest` resolved to before this release
> — reads them, and a published client cannot dual-READ the way a request can
> dual-send. Their removal condition is written at the call site in
> `packages/backend/src/middleware/retired-safe-names.ts`: the release AFTER
> this one, once `npm view @haven_ai/cli dist-tags` shows `latest` at or past
> 0.3.0-alpha.0. This release is what makes that true.
>
> **Update, same day — the follow-up release closes this.** 0.3.0-alpha.0
> published and `npm view @haven_ai/cli dist-tags` reads `latest:
> 0.3.0-alpha.0`, a CLI whose `accountsEnvelope()` reads `accounts`. The
> removal condition above is met, so the FOLLOW-UP release — cut the same
> day, immediately after this one, not "next" in any later reader's sense —
> removes both twins AND the third name, and
> `middleware/retired-safe-names.ts` exports no twin helper at all. It also
> removes a FOURTH retired response name nothing had noticed: `safe_tx_hash`
> on `GET /agent-connection-setups/{id}`'s `approval` object, which outlived
> the epic by reading migration 084's `account_tx_hash` column through the
> old wire key. No published package read it, so it was renamed outright.
> `last-verified` is not bumped for this block: it already reads 2026-09-17,
> and this records what the two releases carry rather than a re-verification
> of the document. What that leaves is worth stating, because it is the shape
> of the contract rather than an incident: the `/user/safes*` TOMBSTONE PATHS
> stay 410 and the retired REQUEST names stay refused with a 400 — a path is
> what an old client types and a request can be sent twice, so those are
> answered, not deleted. Only the response bodies contracted. One consequence
> for a reader pinning versions: a pre-0.3.0 CLI against the follow-up
> backend breaks exactly as described above, and there is no longer a
> backend release where it does not — the one-release window WAS the window.
>
> **The version-skew contract is therefore ASYMMETRIC for one release**: a 0.3.0 client against a 0.3.0 backend is consistent,
> and a pre-0.3.0 client against a 0.3.0 backend now fails **loudly and typed**
> rather than silently — which is the intended end state of #2906, not a
> regression. The signer's supported expected-context versions are untouched by
> this epic and by this release. `last-verified` is NOT bumped: it already reads
> 2026-09-17 from an earlier change today, and this note records what this
> release carries rather than a re-verification of the document.

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
| `@haven_ai/connect` | `0.4.0-alpha.0` |
| `@haven_ai/mcp` | `0.4.0-alpha.0` |
| `@haven_ai/sdk` | `0.4.0-alpha.0` |
| `@haven_ai/signer` | `0.4.0-alpha.0` |
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

Every "re-run `npx @haven_ai/connect@<tag>`" hint the published packages emit —
in `@haven_ai/connect`'s doctor, repair, re-key and tombstone messages, in the
signer's capability text and its version-skew refusal, and in the SDK's shared
`SIGNER_UPDATE_FALLBACK` — renders from a single build-time constant,
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
separate local `haven-signer` stdio entry; it is distinct from the local-stdio
runtime described above. Hermes Agent is a supported hosted-runtime profile:
Connect writes `$HERMES_HOME/config.yaml` and its matching owner-only `.env`
when `HERMES_HOME` is set, otherwise `~/.hermes/config.yaml` and `.env`. The
hosted API key stays in `.env`; config uses the `Bearer ${MCP_HAVEN_API_KEY}`
template. Connect preserves source text outside `mcp_servers` and replaces only
the `mcp_servers.haven` and `mcp_servers.haven-signer` entries.
Hermes discovers MCP servers at process startup, so start a new session (or run
`/restart` for a gateway). Hermes also needs its Python MCP SDK installed (`pip
install mcp`) to load MCP tools.

## Runtime selection is detection-first (#1672)

Which runtime's config the connector writes is resolved in
`packages/connect/src/runtime-registry.ts` (`resolveRuntimeSelection`), in this
precedence order:

1. `--runtime-force <name>` always wins (an unknown name refuses, listing the
   valid values).
2. Environment detection (`CLAUDECODE`/`CLAUDE_CODE` → claude-code,
   `CODEX_SANDBOX`/`CODEX_HOME` → codex-cli, `VSCODE_*` → vscode,
   `HERMES_*` → hermes) **beats a contradicting `--runtime` hint**, with a
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
   is an interactive terminal, the connector scans for the config locations it
   can actually write (`~/.claude`, `~/.codex/config.toml`, `~/.cursor/mcp.json`,
   the VS Code / VS Code Insiders user `mcp.json`, a workspace `.vscode/`,
   Claude Desktop's `claude_desktop_config.json`, `$HERMES_HOME/config.yaml`)
   and offers **only those**, likeliest first — an existing MCP config outranks
   a bare client directory. The scan **populates the choices; it never
   selects** (the #1719 invariant — pinned by
   [`packages/connect/src/installed-clients.test.ts`](../../packages/connect/src/installed-clients.test.ts)
   "NEVER selects for the user", #2680). Finding exactly one installed app still prompts, because an
   installed app tells you what exists, not where the user wants their agent to
   run, and a silent wrong write plants an API key and a delegate key in an app
   they do not use. This rung is **omitted entirely** — not answered — under
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

> **Recent re-verification (#3120):** the precedence ladder above is unchanged —
> `--doctor`/`--repair` now resolve a runtime the same way when the `--runtime`
> flag is ABSENT (explicit flag verbatim → the runtime recorded in the agent
> directory's `last-connect-outcome.json` → unknown, never env-detection), but
> with a flag present nothing moved: detection still beats a contradicting
> hint, an explicit runtime still applies as given, `runtime_undetermined` /
> `runtime_unrecognized` / `runtime_force_unrecognized` keep their codes and
> allowed-value lists. The doctor's new unknown-runtime verdict reuses
> `RUNTIME_FLAG_VALUE_LIST` for its prose, so the values it names cannot drift
> from this ladder's vocabulary.

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
  top: a lone candidate, or a live MCP config file outranking bare client
  directories. Two candidates in the same evidence tier are separated only by
  the scan's fixed order, which is a preference rather than a fact about the
  machine, so no suggestion is offered there.

**The scan populates choices; it never selects.** This is #1719's invariant and
it is unchanged: a `suggested_runtime` is a value the agent may echo back as
`--runtime`, never a selection the connector makes. Finding exactly one
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
| `wiring_collision` ([#2551](https://github.com/d-hinders/Haven-AI/issues/2551)) | A **bare** (no `--name`) setup on a machine whose credential root already holds a bare-pair directory with a usable key — what `--doctor` calls `wired` or `superseded` — and no interactive terminal to ask | **Relay to the human**, who chooses: re-run with `--replace` (re-point `haven` / `haven-signer`, retire the previous directory locally) or with `--name <slug>` (install alongside; `error.suggested_name` proposes one). An agent following the setup prompt must not add either flag itself |
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
nothing (#1695). Two things it deliberately is not. It is not a third
permitted change to the dashboard's command: the setup prompt still allows an
agent exactly `--json` and, after a runtime refusal, `--runtime`, and the
refusal's own message says so — *relay this to your user; do not add a flag
yourself* — which is why the two artifacts do not contradict even though the
prompt does not name this case.

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
says so), and the owner still revokes on the Haven
agent page. The revoke route is owner-authenticated; the connector holds agent
keys only.

`runtime_config_unreadable` is the exception, and the only one of the six that
reaches the dashboard (`runtimeStatusHelper`; the routing is pinned by
[`packages/frontend/src/components/connect-agent/__tests__/runtime-status-copy.test.ts`](../../packages/frontend/src/components/connect-agent/__tests__/runtime-status-copy.test.ts),
#2680): it happens after credentials
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
universal rule that only two changes to the command are permitted.

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
connector's resolve reports the detected runtime. `--doctor`/`--repair` still
require an explicit `--runtime` (they examine a stored config, which is a
choice, not a detection).

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
On arrival it says only that it is waiting for the agent to run the setup
command. After one minute of a confirmed `awaiting_connection` it acknowledges
that a first run downloads the connector before it can register — an
observation, not a warning: it offers no recovery actions and does not suggest
anything is wrong. After **three minutes** of confirmed `awaiting_connection`
it says Haven has not received a connection yet, asks the user not to approve
agent rules, offers the same local command for copying, and lets them cancel
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
agents included, so the boolean is never to be read against it), and
`error.superseded_agent_ids` / `error.suggested_name` on a `wiring_collision`
refusal; since #3122, also additive, `existing_agents_before_write` (always
present on a completed run — the other live-keyed directories, named BEFORE the
first write, with the account each spends from; a subset of
`superseded_agent_ids`, which also names key-less and tombstoned directories)
and `server_name_rebound_from`
(only when the run took a server name over from another directory's local
`mcp-server-binding.json`, with `backend_changed`); and since #2528, also
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
NEW agent and, without `--replace` (#2551), retires nothing, so earlier
credential directories keep live API and signing keys; the ids of those other
directories are now in the record
instead of only in stderr prose. The list is empty on a clean first run — and
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
lint:workspace-pins` enforces both directions of that rule on every PR. Nothing
about the runtime floor, the version-skew contract, or the Supported Runtime
Manifest below moves — the published set this section governs is unchanged at
`sdk`, `signer`, `mcp`, `connect`, `cli`.

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
current, and the failure mode differs by which half is stale:

| Stale half | Symptom |
|---|---|
| Signer older than the backend, **`@haven_ai/signer` ≥ the #1143 release** | `This signer is out of date: it supports x402 expected context versions up to <N>, and Haven sent version <M>. Update @haven_ai/signer …` |
| Signer older than the backend, **signer predating #1138** | `MCP error -32602: Input validation error: Invalid arguments for tool haven_sign_x402: Invalid literal value, expected 1 at x402_expected.auth.version` |
| Signer with #1138 but predating #1143 (forward-looking — see below) | `… Invalid input at x402_expected.auth.version` — Zod says nothing at all about a failing literal *union* |
| Backend older than the signer | `Refusing to sign typed data under an expected context that does not commit to it` |

All of these fail closed, which is the point: none produces a signature. Treat any
of them on the delegation rail as a version-skew report, not a credential
problem — and note the last is also what a *legacy-rail* intent looks like if
a caller passes `typed_data` that the context never committed to.

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
  list is 21 of the 23 (#2972 added `haven_report_settlement_evidence` to both counts).** It is `STRICT_INPUT_TOOLS`, which since #2807 lives
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
  `quote` where it takes `payment_required`, and a `body` on
  `haven_quote_x402` that only the local surface declares. Since #2348 those
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

**The merchant payment header name is NOT a skew axis (#2289).** Since #2289 the
SDK sets both `PAYMENT-SIGNATURE` (x402 v2) and `X-PAYMENT` (v1) to the same
value on every merchant retry.

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
> chain and duplicating it is refused with HTTP 431. Both names remain correct,
> and remain the instruction, on the EIP-3009 bridge. This is
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

Row three cannot fire on today's traffic and is listed for the next context bump:
a signer carrying #1138 accepts both v1 and v2, so it only breaks once a v3
context ships while that signer is still installed. Row two is the one seen in
the field on 2026-08-06.

If you see either Zod row, **do not** "fix" it by editing `auth.version` to a
supported value. The version is inside the Haven-signed binding message, so
rewriting it invalidates the signature and misrepresents what Haven declared —
the update is the fix. ("Declared", not "authorised" (#2347): Haven signs this
message, and that is all it does here — the word matches
`packages/signer/src/settlement-child.ts`, which describes the same binding.
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
merchant and `settlement_tx_hash` is only an optional merchant PAYMENT-RESPONSE
receipt reference. Missing values are explicit; it changes neither signing nor
runtime compatibility.

> **Re-verified #3118:** the SDK under both runtimes now also speaks the
> official x402 MCP transport profile — a payment-required TOOL RESULT
> (`isError: true`, `PaymentRequired` as `structuredContent`, JSON text
> fallback) under HTTP 200 is quoted like a 402 by `quoteX402` /
> `quoteMcpX402` / `fetch()`; the paid retry adds the decoded envelope as
> `params._meta["x402/payment"]` beside the unchanged headers whenever the
> body is a `tools/call` request; `settlement_tx_hash` may now come from
> `result._meta["x402/payment-response"]` when there is no `PAYMENT-RESPONSE`
> header, and it stays a merchant CLAIM relayed verbatim (re-encoded as base64
> JSON so `protocolReceiptPayload` decodes through the one existing path). An
> in-band refusal (an `isError` challenge on the paid retry, or
> `success: false`) is `ok: false` — the hosted refusal is thrown as 402 (no
> failure object rides an HTTP-200 status) and its message names
> `HTTP 200, refused in-band`, the status the merchant really returned. No
> tool added, renamed or re-shaped; no argument, schema, strict/permissive
> split, tool-NAME set, version-skew or consent-hash contract moves; the
> hosted server changes in exactly one place, that status mapping in
> `paid-mcp-completion.ts`, and inherits everything else from
> `@haven_ai/sdk`. Nothing else in this document was re-verified in this
> pass.

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

### Detecting skew before a payment (#1155)

Every row above is a *post-quote* symptom: the agent found out by trying to pay.
The same skew is now detectable at connection time, from two surfaces that cost
nothing to read.

| Surface | What it states | Where |
|---|---|---|
| Signer `initialize` result | The version sets this signer will verify — `capabilities.experimental["haven/signer-compatibility"]` (machine-readable) and the same numbers in `instructions` (what clients show the model) | `packages/signer/src/capabilities.ts`, wired in `buildSignerMcpServer` |
| Hosted quote/prepare result | `signer_compatibility.x402_expected_context_version` — the version that quote will emit — plus in-band guidance (since #1547: branch on the signer's machine-readable version-mismatch refusal, not a pre-compare). Present on the **EIP-3009 shape** of each tool; the erc7710 shape carries none, and since #2041 that now includes `haven_pay_x402_quote` | `packages/mcp-server/src/tools.ts` (`haven_pay_x402_quote`, `haven_pay_mcp_tool`, `haven_prepare_catalog_purchase`) |

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
  `suggested_tool_omitted_reason`.
- **Where it is built.** The SDK's `createNextStepBuilder`
  (`packages/sdk/src/next-step.ts`) over a target map; the hosted server, the
  signer and the local runtime each declare the shapes they hand off to, and a
  wrong key, a missing required key, an unregistered tool or an omitted
  `nextTool` is a compile error at the site. Cross-surface handoffs are pinned
  both ways in `packages/mcp-server/src/next-step-signer-parity.test.ts`:
  every hosted emission fixture (19 fixtures for the 17 success sites, 28 for
  the refusal steps) is built for real and its `next_arguments` parsed with the named tool's strict schema
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
- **Tools missing after restart:** rerun the connector. It will reuse the
  existing local credentials, reinstall or reuse the pinned MCP runtime, and
  fail loudly if the wrapper handshake cannot list the required Haven tools.
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
- **`--doctor` / `--repair` (#1589):** a stuck setup is diagnosable without a
  hand-built MCP client: `npx @haven_ai/connect@alpha --doctor --runtime
  <runtime>` checks config, credentials, the pinned signer runtime, the hosted
  MCP, and runs the live signer handshake (reporting its compat versions),
  printing one repair action per failure and exiting non-zero. `--repair`
  reinstalls the pinned runtime and rewrites wrapper + config from STORED
  credentials — no new setup token, keys untouched. `--json` for automation.

  > **Re-verified #2963:** the `signer_runtime` check now asks its two
  > questions against two references — *intact?* against the sidecar's record
  > of what npm installed, *current?* against the connector's pinned manifest.
  > A runtime that is merely older than the pin reports `Installed X does not
  > match the connector's pinned Y — intact, but outdated`; only a directory
  > whose CLI is missing, or whose installed package versions differ from what
  > the sidecar recorded, reports `stale or empty`. The repair action is
  > the same either way (`--doctor --repair`). Nothing else in this section
  > re-read.

  > **Re-verified #3121:** three verdict levels. Every check and the report
  > carry `level: ok | advisory | failed`; only `failed` reaches the exit
  > code, so "exiting non-zero" above now means "on a failed check". The
  > intact-but-outdated `signer_runtime` state from #2963 is an `advisory`
  > (`!` marker, exit 0, both versions still named, `--repair` still
  > offered), as is `superseded_agents` on a RECOGNISED runtime that owns no
  > config file (Claude Code, `other`): the live keys are still named, and
  > the check says why "wired" cannot be verified from this machine. `ok` on a check and on the report is derived (`true` unless
  > `failed`) so `report.ok` stays the exit code's predicate for `--json`
  > consumers; the report stays `version: 1`. A live key in a directory the
  > readable config demonstrably does not use stays a failure, for every
  > non-wired classification, and the unknown-runtime `runtime_config`
  > verdict (#3120) stays a failure. A runtime string the connector does
  > not recognise (`--runtime codex-clii`) is a new `runtime_config` failure
  > of its own, naming the allowed values, and demotes nothing; a documented
  > alias (`--runtime codex`) now resolves to its config file for the
  > doctor's check, the repair's local-topology refusal and the repair's
  > config write, instead of the "CLI-managed" skip and a repair that
  > reported success having written nothing.

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
  `chain_id` and `execution_rail` since #2914, **none of them a re-key
  stage**. Widening the probe
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
  and exits 1, and records `TOMBSTONE.json` for `--doctor`. Touches NO key
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
  detail, so that text stays on stderr and never enters the JSON record. This closed a real field failure — a `haven-reset` agent
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

  > **Re-verified #3123:** the last step now ASKS before it destroys. A
  > revoked agent's API key + delegate signature are exactly what the
  > sweep-recovery routes still accept — the only local means of recovering a
  > stranded delegate balance — so after the wiring is removed `--unwire` runs
  > the one read it already has (`probeHostedAgentIdentity`, `GET
  > /machine-payments/agent` with the stored key; no new network call, no
  > backend change) and refuses to destroy the key material on every answer:
  > `ok` (still active — revoke on the agent page first), `unauthorized` (a
  > stranded balance MAY exist and the connector CANNOT check; the backend's
  > 401 is deliberately ambiguous between revoked / archived / paused / rotated
  > and the refusal says so), `network_error` / `bad_response` (unknown is not
  > "safe to delete"). Only a directory with no stored API key + URL proceeds
  > unprobed, as before. The refusal exits 1 with the wiring gone and the key
  > left in the 0o600 credential file only — the config and Hermes-env copies
  > are scrubbed BEFORE the decision (S3), so a refusal leaves the key in the
  > credential file and in any config this run could not clean (reported
  > `refused` / `unreadable`, never silently); `--doctor` then reports the directory as
  > `superseded` until the key is revoked or destroyed, which is the honest
  > state. `--destroy-key-material` proceeds on every answer and states that
  > local recovery ends. `--json` carries an additive `teardown: { status:
  > destroyed | retained | forced, probe, detail, remedy? }`. The `claude-code`
  > copy of the key (`claude mcp add`, a config the connector does not own)
  > stays out of `--unwire`'s scope, stated in the README. Companion:
  > `--prune-signer-runtimes [--dry-run]` reclaims
  > `~/.haven/signer-runtime/<key>` directories no credential directory's
  > sidecar or wrapper names (walking the ROOT, so `override-<hash>`
  > directories from #2424 are seen; the default agents root and an explicit
  > `--credentials-dir`'s parent are read as a union; paths normalized on both
  > sides), never one any credential directory names nor the current pin,
  > reporting each entry through #3121's levels (a failed removal is the only
  > exit 1); `--doctor` surfaces unused directories as the
  > `signer_runtime_unused` advisory, names only — the size walk runs only in
  > the prune itself. Also re-read in this pass: the
  > `--replace` paragraph under the wiring-collision section (now states that
  > `--replace`'s teardown is unconditional and unprobed) and the JSON-envelope
  > bullet above (a retained teardown is the second non-zero-exit case).
  > Nothing else in this document was re-verified in this pass.

  > **Re-verified #3122:** a wallet warning is now emitted BEFORE the first
  > credential write. Setup now reads every other credential directory's stored key and
  > account (local files only — no network call is added, and the backend is
  > not asked whether a key still authenticates) and logs `Heads-up (before
  > anything is written): …` naming each agent and the account it spends from,
  > then proceeds — it warns, it does not refuse (owner decision 1 on #3119);
  > #2551's name-slot refusal is unchanged. `--json` gains
  > `existing_agents_before_write` (always present on a completed run). Each
  > setup writes a non-secret `mcp-server-binding.json` beside
  > `last-connect-outcome.json` (server name → agent id, backend URL,
  > bound-at; per credential directory, never machine-wide); a name another
  > directory's record holds is named before the write with a DIFFERENT-backend
  > flag (`server_name_rebound_from`) — the case the backend's
  > `agents.mcp_server_name` cannot see. That backend column stays the
  > authority for the same backend; the local record is a reporting aid and
  > every message reading it says "locally recorded". `--unwire` releases the
  > record (its `--json` record gains `binding_released`), and so does the
  > `--replace` retirement (the setup outcome carries no such field);
  > `--tombstone` leaves it, so `--doctor` ignores a RETIRED directory's record
  > and reports two records claiming one name as the `mcp_server_name_rebound`
  > advisory (#3121 level), excluding tombstoned (retired) directories only,
  > absent otherwise. The #1688 completion heads-up is unchanged — #3122 ADDS
  > the earlier notice, it does not move or remove the later one.
  > Nothing else in this document was re-verified in this pass.

  This is local teardown, **not** backend revocation: Connect reports what it
  changed, while the owner revokes the agent on the Haven agent page. Named
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
  credential directory — `~/.haven/agents/<agent-id>/signer.json`, or
  `~/.haven/agents/<slug>/signer.json` for a `--name`d agent (#1696). During a
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

> **Re-verification (#3097, the paid retry's target, 2026-09-18):** this diff
> touches `packages/mcp-server/src/tools/{plain-http-x402,contracts,paid-mcp-completion}.ts`,
> `packages/mcp-server/src/tools/support/mcp-context.ts` and `packages/sdk/src/types.ts`
> (the one SDK file in this document's coverage list; the SDK's x402 modules are
> covered by `04-x402-payment-sequence.md`). Both surfaces keep their contracts; what is new is an optional `url` on
> `haven_pay_x402_quote` / `haven_resume_x402_payment` (the URL the agent
> quoted), `request_url` / `retry_url` / `resource_url_differs_from_request` on
> the quote, `retry_url` on pay and resume, and the `INSECURE_RETRY_TARGET`
> refusal of a public `http://` retry target — the same rule on the SDK's
> `McpMerchantTransport.deliverPayment` seam, which the local runtime crosses. The
> local/hosted divergence this document describes is unchanged: the local
> runtime always retried the caller's URL; the hosted surface now carries it.
> Scope of this note: those fields and that refusal. Nothing else in this
> document was re-verified.

> **Re-verification (#3100, discovery hands out arguments its suggested tool
> accepts, 2026-09-18):** this diff touches the hosted `haven_discover_tools` map (`src/tools/catalog-purchase.ts`), the strict-refusal builder (`src/tools/registry.ts`) and the `STRICT_INPUT_TOOLS` reason for `haven_quote_x402` (`src/tools/contracts.ts`), plus the local runtime's discovery map (`packages/mcp/src/tools.ts`). Additive on the read side:
> every discovery entry gains `suggested_arguments` in the suggested tool's
> vocabulary (hosted MCP entries now suggest the cap-free
> `haven_quote_catalog_purchase { catalog_id }` instead of prepare; HTTP entries
> `haven_quote_x402 { url }`; the local runtime keeps its pay tools with
> `{ merchant_url, tool_name, arguments }` / `{ url }`), and a hosted strict
> refusal now names the declared keys and a rejected key's declared alias
> (`TOOL_ARGUMENT_ALIASES` + folded-spelling equality) on both the handler and
> the transport parse paths. No tool name, schema key, strict/permissive split,
> expected-context version or signer contract changes; the local/hosted
> divergence this document records is unchanged (the two surfaces suggest
> different tools by design — same property, not the same values). The
> `haven_quote_x402` reason no longer claims the hosted surface has no body
> field (it has had one since #2366). A row no verbatim hint exists for (no
> `tool_name`; hosted: degraded) carries `suggested_tool_omitted_reason` on
> both surfaces instead of a hint. Scope of this note: those fields and that
> text. Nothing else in this document was re-verified.

> **Re-verification (#3101, the typed next-step builder, 2026-09-18):** this
> diff adds `packages/sdk/src/next-step.ts` (the builder, exported from the
> SDK's `index.ts`) and touches `packages/mcp-server/src/tools/support/{guidance,errors}.ts`,
> `packages/mcp-server/src/tools/{contracts,catalog-purchase,plain-http-x402,paid-mcp-completion,state-direct-recovery}.ts`,
> `packages/mcp-server/src/server.ts` (instructions name the omitted-reason
> field), the SDK's `types.ts` (a new optional `next_tool_omitted_reason` on
> `AgentNextStep`) and `skill-content.ts`, and, annotation only,
> `packages/signer/src/tools.ts` and `packages/mcp/src/tools.ts`. The
> hosted `next_tool` family is now rendered by the SDK's builder from a bare
> tool name + server role over a target map derived from the hosted
> `toolSchemas` (which keeps its keys via `as const satisfies`) plus the two
> signer handoff shapes the hosted server declares itself — it never imports
> the edge signer at runtime; a test pins them to the signer's schemas; the
> wire strings are byte-identical on the 9 sites the epic did not re-decide,
> and all 17 `buildAgentGuidance` call sites (a census the characterization
> test enforces — an 18th site fails it) are pinned by
> `next-step-characterization.test.ts`, the 8 re-decided ones marked. New on the wire:
> `next_tool_omitted_reason` wherever no tool is named (the three refusals
> that used to hand `{ payment_id: null }` to a tool requiring a string, the
> recovery module's own-HTTP-retry step, the report-accepted step and the
> three settled done-states), and the same `next_tool` family on refusals
> whose `HostedToolError` carries a step. No tool name, schema key,
> strict/permissive split, expected-context version, signer contract, cap,
> funding, signing or settlement decision changes; the local runtime's
> `nextAction` emission is untouched (slice #3103). Scope of this note: those
> fields. Nothing else in this document was re-verified.

> **Re-verification (#3102, every hosted refusal names its next step, 2026-09-18):**
> this diff touches `packages/mcp-server/src/tools/support/{errors,guidance,cap-price,catalog-entry,mcp-context}.ts`
> and `packages/mcp-server/src/tools/{catalog-purchase,plain-http-x402,paid-mcp-completion}.ts`.
> `HostedToolError` no longer takes a bare `nextAction`: a refusal thrown as a
> `HostedToolError` names an action only through a typed `nextStep`
> (`refusalNextStep`, the same builder and target map as the success path),
> so each of the 28 refusal steps (27 sites, one of them following the live
> payment state) now also carries either a tool with arguments that tool declares
> (six name a tool: `haven_get_payment_status { payment_id }` on the
> post-funding timeout, the erc7710 rejection and an eip3009 rejection whose
> live state says retry or poll; `haven_sweep_delegate {}` on the eip3009
> rejection and the funded insecure-target branch, as their messages say) or `next_tool_omitted_reason` (every stop-and-tell-user,
> retry-with-explicit-context, fund-account and window-expired refusal). The
> one other hosted refusal shape, the SDK's `HavenPaymentStateError` passed
> through `normalizeError`, takes its step from the per-action default table
> (status read, sweep) or says why none follows, so no hosted refusal carries
> a bare `next_action`. `next_action` and `suggested_tool` are byte-identical
> on every refusal, pinned by `next-step-refusals-characterization.test.ts`
> (written before the change; a census of `refusalNextStep` calls enforces the
> 27); `status`, `phase`, `rail` and `retry_with_new_quote` are untouched by
> the diff and pinned where they were, in `tools.test.ts` and
> `paid-mcp-completion.test.ts`. No tool name, schema
> key, cap, funding, signing or settlement decision changes; the local
> runtime is untouched (slice #3103). Scope of this note: those fields.
> Nothing else in this document was re-verified.

> **Re-verification (#3104, cross-surface handoff parity and the ratchet,
> 2026-09-18):** this diff adds `scripts/lint-next-steps.mjs` (+ test +
> zero baseline, wired in `ci.yml` and `package.json`), moves the hosted
> next-step fixtures to `packages/mcp-server/src/test-support/next-step-fixtures.ts`,
> and extends `packages/mcp-server/src/next-step-signer-parity.test.ts` into
> the cross-surface walk: every hosted emission fixture is built for real and
> its arguments parsed with the named tool's strict schema on the surface its
> role names. No emission, tool name, schema key or decision changes; the epic's
> contract as it stands after #3100–#3103 is what the walk and the ratchet
> hold. Scope of this note: the tests and the gate. Nothing else in this
> document was re-verified.

> **Re-verification (#3103, the signer and the local runtime name a next tool,
> 2026-09-18):** this diff adds `packages/signer/src/next-step.ts` (the signer's
> declared hosted handoff shapes — `haven_get_payment_status { payment_id }` —
> and its refusal-side builder over the SDK's) and touches
> `packages/signer/src/{sign-context,tools,index}.ts` and `packages/mcp/src/tools.ts`.
> The signer's five decision sites now carry a typed step beside `next_action`:
> a backend refusal of the signing context (not expired) names the hosted
> status read with the payment id through the role fields
> (`next_tool_server_role: hosted`, `next_tool_name`), so a `--name <slug>`
> install resolves it; a transport failure, a malformed body, an expired window
> and a version skew name no tool and say why (`next_tool_omitted_reason`).
> `HavenSignContextError` gains the optional `next_tool*` fields additively;
> no signing decision, expected-context version or binding version changes.
> The local runtime's failure envelope dual-emits `nextAction` and
> `next_action` (decision 10, one release before the old spelling is dropped;
> this supersedes the #2983 note's "its failure shape is camelCase") and its
> two decision sites — the ones the signer's symmetric grep returns
> (`nextAction: …` or `nextAction = …`): the `MERCHANT_NOT_READY` envelope
> and the `UNKNOWN_ERROR` fallback — say why no tool follows.
> Every field the refusals emitted before is byte-identical, pinned by
> `next-step-characterization.test.ts` in each package (written before the
> change). The hosted server's suite pins the signer's declared shapes to the
> hosted schemas. Scope of this note: those fields. Nothing else in this
> document was re-verified.
