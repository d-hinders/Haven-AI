---
owner: "@d-hinders"
status: archived
covers: []  # historical verification records; no live code contract
last-verified: "2026-11-02"
---

# Archived re-verification notes (2026-11)

#4613 (slice 2 of epic #4610) moved every re-verification note out of the
`status: current` docs into this file, byte for byte before the relative-link
rewrite (the rewrites are listed in the PR that added this file). The census
that defines "every shape" is `scripts/docs/no-reverification-prose.mjs
--census`; the verifier is `scripts/docs/re-verification-notes.test.mjs`. Use
`git log -p -- <doc>` for the surrounding historical diff.

## `docs/architecture/00-overview.md`

<!-- sha256: 48e4227026627bbbb4e90787f11c55037b8e7d53b1ea0ac530915844f3eeaa42 -->
```markdown
> **Re-verified #3093 (frontend hooks: wire keys default instead of crashing):**
> this diff touched `hooks/useAccounting.ts`, in this document's coverage list, by
> defaulting the array keys it stores (`?? []`) so an API answer without the key degrades to an empty state instead
> of sending the route into the ErrorBoundary. No endpoint, flow or
> behaviour this document describes changes. Scope of this note: those
> expressions. Nothing else in this document was re-verified.

Re-verified 2026-09-21 (weekly docs audit #3206, at dev `7f17c9f3`). The
accounting one-liner above was updated: Accounted is a second live connector
since #3019 (`registry.ts` `id: 'accounted'`, `availability: 'live'`,
`accounted-connector.ts`, `accounted-webhooks.ts`), so "Fortnox as the live
connector" no longer matched the code. Everything else re-checked at this head:
the delegation-rail lines (one live rail, sponsored UserOp, no funding leg),
the custody line, the component table (facade/keyless/signed-only per package),
the connect-flow tool names (`haven_get_agent`, `haven_get_allowances` still
the pre-payment reads in `mcp-server/src/tools/state-direct-recovery.ts`), the
runtime profiles (claude-code, codex-cli, codex-desktop, cursor, vscode,
vscode-insiders, claude-desktop, hermes, other in
`connect/src/runtime-registry.ts`), the Hermes credential paths, the chain
facts, and the docker entry points. The heavy intervening drift (#3134 SDK
vocabulary convergence at the mapper, #3173 signer cold start and
`@haven_ai/sdk/edge`, #3155 the x402 MCP transport profile, #3167 agent
labels, #3127 currency preference, #3202 marketplace prospects) changed the
packages' internals without moving any boundary this overview states.

Re-verified 2026-09-30 (weekly docs audit #3413, at dev `5b5bd059`). No claim
needed rewriting. Re-checked at this head: the package table against
`packages/*` (no package added or removed; the one-liners' custody split —
keyless mcp-server, signing signer, opt-in local mcp, private core — still
matches each package's README and facade); the accounting connectors
(`registry.ts` still `fortnox` + `accounted` live, others `coming_soon`);
the delegation-rail lines (one live rail, sponsored UserOp, no funding leg;
retired rails still answer 410 at the payment paths, `routes/payments.ts`);
the frontend `delegator_hybrid` filter; the connect-flow tool names
(`haven_get_agent`, `haven_get_allowances` still the pre-payment reads in
`mcp-server/src/tools/state-direct-recovery.ts`); the nine runtime profiles
in `connect/src/runtime-registry.ts` and the Hermes credential paths
(`HERMES_HOME`/`~/.hermes` in `connect/src/config-writers.ts`); the chain
facts (the shared core registry still registers 8453/84532/100 — the file
doc 01's covers list implicates) and the
erc7710-with-EIP-3009-fallback settlement shape. The week's heavy drift
(#3444 sub-budgets, #3423 receive-side slices, #3479 settlement recording,
#3471 discovery default chain, #3482 faucet/onramp) moved internals —
including the default-chain derivation this doc's chain line does not
state — without touching any boundary, actor or custody split named here.

Re-verified 2026-10-05 (weekly docs audit #3645, at dev `cdb91d86`). Changed:
the component table gains `@haven/ops` (#3570, epic #3507) and `@haven_ai/ui`
(#3562, #3508), both added after the 09-30 head, and the backend row names the
read-only `/ops/*` surface; the delegation-rail line no longer says the whole
rail has no funding leg — direct payments and erc7710 x402 settlement have
none, the EIP-3009 x402 fallback does (the earlier notes' "no funding leg"
shared that scope error); the Hybrid DeleGator line names the redemption path
through task- and sub-budget children (#3329/#3330), matching the CASP
guardrails' wording; and the chain line drops the registry clause, which epic
#3634's next slice will make false. Re-checked without change: the retired
rails' 410s, the dropped approval queue, the caveat triple, the frontend
`delegator_hybrid` filters, the accounting connectors, the core package's
purity rule and `"*"` pins, the nine runtime profiles and Hermes paths, the
connect-flow tool names, the budget-approval activation, and the passport
chain.

Re-verified 2026-10-23 (#4372 part A, at dev `1579908a4`). Changed: the
delegation-rail line and the Hybrid DeleGator line no longer say every
redemption is a sponsored UserOp — Haven submits it for direct payments and the
EIP-3009 funding leg, the merchant or its facilitator on erc7710 settlement
(`04-x402-payment-sequence.md`, "the settling party needs native gas"); the
connect flow's pre-payment read is `haven_get_agent`, as the hosted
instructions say (`mcp-server/src/server.ts:35-36`), with `haven_get_allowances`
for the breakdown; and PostgreSQL holds budget delegations, not allowances
(`agent_allowances` retired, `infra/repositories/agents.ts:378`); and the
package table's qa-agent row names the agent evals (`src/evals/`, epic
#3957). Re-checked without change: the rest of the 13-package table and each
package's `private` flag, the
`core-stays-pure` rule and `"*"` pins, the accounting connectors (`fortnox`,
`accounted` live; `light`, `igdrasil` coming soon), `/ops` answering 404 until
configured, the retired rails' 410s (`isRetiredRailIntent`), the
`delegator_hybrid` list filters, the nine runtime profiles and Hermes paths,
the named-pair default (`connect/src/server-names.ts`), first-grant activation
(`routes/agent-delegations.ts:988-996`), the passport chain (84532 only), and
Gnosis as history-only.

Re-verified 2026-10-25 (weekly docs audit #3645, at dev `615686369`). No claim
needed rewriting. Re-checked at this head: the package table against
`packages/*` (still 13 packages — the two `retired-rail-prose-*.json` files
at that level are baseline data, not packages), the accounting registry
(`fortnox` + `accounted` live, `light` + `igdrasil` coming soon,
`modules/accounting/registry.ts`), the hosted instructions' pre-payment read
(`haven_get_agent` first, `haven_get_allowances` for the breakdown,
`mcp-server/src/server.ts`), the retired rails' 410s
(`isRetiredRailIntent` in `routes/payments.ts`), the nine runtime profiles
(`connect/src/runtime-registry.ts`), `/ops` answering 404 until configured
with the read-only role (#3510), and passports carrying a `chainId` through
`infra/repositories/agent-passports.ts`. The week's drift (x402
proof-header settlement reports #4075, request-mode x402, SIWX sign-in,
multi-account overview #4080, expired-only budgets #4376, catalog probe
cooldown #4407) changed what covered surfaces report and render without
moving any boundary, actor or custody split this overview states.

Re-verified 2026-11-02 (weekly docs audit #4605, at dev `fc8ac1eb6`). No claim
needed rewriting. Re-checked at this head: the package table against
`packages/*` (still 13 packages), the accounting registry (`fortnox` +
`accounted` live, `light` + `igdrasil` coming soon,
`modules/accounting/registry.ts`), the hosted instructions' pre-payment read
(`haven_get_agent` first, `mcp-server/src/server.ts`; `haven_get_allowances`
for the breakdown), the retired rails' 410s
(`isRetiredRailIntent` in `routes/payments.ts`), the nine runtime profiles
(`connect/src/runtime-registry.ts`), `/ops` answering 404 until configured,
and the chain facts (Base 8453, Base Sepolia 84532, Gnosis 100 history-only).
The week's drift (receipts declaring their six served keys #4587, the parent
receipt field rename #4583, accounting transaction kind #4535 and purchase
correlation key #4544, the direct-payment underlag #4546, MCP retry-or-stop by
failure cause #4516, the typed task-/sub-budget payment-scope refusals #4483,
the expired-only budget's `delegation_expired` #4376, the x402 merchant
rejection reason #4558, settlement-evidence `payment_header` prefill #4536,
`avatar_tint` migration 121 #4433) changed what covered surfaces report and
render without moving any boundary, actor or custody split this overview
states.
```

## `docs/architecture/02-identity-and-custody.md`

<!-- sha256: 6c9631c7ac22e5a620071af1e91a44da281d5d761bf99ab73cc263320d553013 -->
```markdown
Re-verified 2026-09-21 (weekly docs audit #3206, at dev `7f17c9f3`): the
retirement and custody claims above were re-checked against the code at this
head. Migration 084's `user_safes` → `smart_accounts` rename (#2941) and
#2911's follow-up migrations are on dev, so the doc's Safe-row language ("rows
persist but reach no screen") describes a renamed-but-present table, which is
what the code still shows. The remaining safe-retirement remainder items named
by the 2026-09-13 scan (#2851, the P3 rename) are both CLOSED COMPLETED.
`connect/src/runtime.ts` still registers the agent by public
delegate address and API-key hash only (`middleware/agentAuth.ts`), and
`signer/src/core.ts` still holds the delegate key locally. The intervening
commits (#3167 labels, #3127 currency preference, #3151 `--unwire`
recovery-credential guard) touched covered files and none moved a custody
boundary; nothing here needed rewriting.

Re-verified 2026-09-30 (weekly docs audit #3413, at dev `5b5bd059`): the
custody claims re-checked at this head — `routes/agents.ts` and
`middleware/agentAuth.ts` still handle `delegate_address` + API-key
hash/prefix only; `connect/src/rekey.ts` and `routes/agent-rekey.ts` still
exist with the explicit `refuseAgentCaller` guard (an agent still cannot
re-key itself); `infra/repositories/user-passkeys.ts` still stores
`credential_id`, `public_key_x/y`, signer address, chain and the raw
attestation unverified (POC, as written); `disableDelegation` still backs
revocation and revoke-all in `routes/agent-delegations.ts`; the signer-set
ops still live in `rails/hybrid-signer-actions.ts` behind existing-signer
signing; and `signer/src/core.ts` still keeps the delegate key local. The
week's drift (#3444 sub-budgets — the stored delegation graph now also holds
child re-delegations, protected like the parent copies; #3423 receive-side;
#3479 settlement recording; #3451 re-key activation; #3386 re-key merchant
label) widened the delegation surface but moved no zone, invariant or custody
boundary; nothing here needed rewriting.

Re-verified 2026-10-23 (#4372 part B, at dev `2d0713dad`), a full re-read. Changed:
the Connect provisioning bullet separates credential material (hash/prefix,
delegate address, proof) from the non-secret setup metadata the
registration also sends (`connect/src/runtime.ts`); the passkey bullet says
the enrolment route (`POST /passkeys`) was deleted with #2847 and only the
read remains (`routes/passkeys.ts`); the delegation-rail section no longer
says the agent receives the signed delegation through the credential
channel — the owner signs it to the agent's delegate account, Haven stores it
and embeds it in every redemption it prepares (the direct-payment UserOp,
`rails/delegation-rail.ts` `buildRedemptionCall`; on erc7710 the
`payment_header` the agent forwards, `modules/x402/x402-delegation.ts`
`assembleSettlementPayload`), and no connector credential file stores it
(`connect/src/storage.ts`). Review round 1 (#4377) added the setup token and
challenge id to the registration's list, the dashboard manual-credential
path, and the exact `hybrid_account_passkeys` columns. Review round 2 made
the delegation-exposure bullets say the delegation is not secret after first use
on every rail (public calldata; the erc7710 header; Haven's evidence copy) and that the
delegate key alone can spend within the caveat stack once it is. Re-checked without change: `identity.json` /
`signer.json`, the manual `/agents` key (`routes/agents.ts`), the re-key
split and `refuseAgentCaller` (`connect/src/rekey.ts`,
`routes/agent-rekey.ts`), relayer deployment (`rails/hybrid-provisioning.ts`),
`X402_BINDING_PRIVATE_KEY` (`infra/chain/x402-binding-signer.ts`), the
platform-level encryption at rest for `agent_delegations` (migration 042),
and the signer-set ops (`rails/hybrid-signer-actions.ts`,
`hybrid_account_passkeys`).

Re-verified 2026-11-02 (weekly docs audit #4605, at dev `fc8ac1eb6`). No claim
needed rewriting. Re-checked at this head: `POST /passkeys` is still absent and
`GET /passkeys` is the only route in `routes/passkeys.ts`; migrations 042
(`agent_delegations`) and 044 (`hybrid_account_passkeys`) are the ones named;
`machine_payment_evidence.payment_proof_header` is the evidence column
(migration 014) and `modules/mpp/evidence.ts` still reads it;
`assembleSettlementPayload` (`modules/x402/x402-delegation.ts`) and
`buildRedemptionCall` (`rails/delegation-rail.ts`) are the two places the
signed chain is embedded; `refuseAgentCaller` still guards every re-key route
(`routes/agent-rekey.ts`); `X402_BINDING_PRIVATE_KEY` is read by
`infra/chain/x402-binding-signer.ts` and `rails/sweep.ts` (the sweep
authorization-context binding — same dedicated key, distinct message
namespace); `disableDelegation` still backs
revocation and revoke-all (`routes/agent-delegations.ts`); and
`infra/repositories/user-passkeys.ts` still stores `credential_id`,
`public_key_x/y`, `signer_address`, `chain_id` and the raw attestation. The
week's drift (the 365-day `expires_at` cap #4369, the expired-only budget's
`delegation_expired` #4376, the EIP-3009 settlement proof ladder #4337, the
receipts field renames #4583/#4587) narrowed or renamed covered behaviour
without moving a custody zone, invariant or boundary.
```

## `docs/architecture/03-payment-sequence.md`

<!-- sha256: ea97059dda67ada46292ff5671b1844690b70b2f150713d734ce8a43372d28a3 -->
```markdown
> **Re-verified 2026-10-24 (#4372 part F, at dev `6d87ddf95`), a full re-read.**
> Changed: the retired-rail section credits #2020, not #1987, with deleting
> the backend's `computeEffectiveAllowance` (#1987 deleted the signature path
> and the callers), and the key-invariants bullet no longer points at
> `relayer-reads.ts` as the function's home; the x402-payTo match no longer
> says the matched intent id is never served — `GET /receive/{accountAddress}`
> returns it as `matched_payment_intent_id`. Re-checked without change: the
> 410 rail gates on `/payments` and `/x402` (`rails/execution-rail.ts`,
> `modules/x402/authorize.ts`), `/safe/exec` and `/approvals` gone (#2847,
> #2055 / migration 070), the 10-minute signing window, the delegation-rail
> steps (native-token 400, selection by hash, the #3503 pre-check body and
> its fail-open, the smallest-link rule, the #3500 and period-revert 403s,
> the 502, the `eip712_userop` 201), the erc7710 child (600s cap,
> `/x402/:id/settle`, `eip712_delegation`), the EIP-3009 bridge
> (`merchantPayTo`, open budget, `settlement_scheme`), the #961 one-shot 400,
> replay and hourly cap (default 100, replays exempt), the #956 receipt
> capture (first write wins), and the receive side (migration 097 keying,
> the explorer-fed index, the payer-signed drop, the owner-only off-ramp
> routes, the submit-time calldata pin, the panel removed by #4142 under
> #4097). Every cited issue was read with `gh api`; all are closed.
>
> **Review round 1 (haven-doc-reviewer @ `344d7ea91`).** The matched-intent
> sentence now says the field is null unless `match_kind` is `x402_payto`
> (the repository's `matchInboundTransfer` comment; the OpenAPI
> `ReceiveLedgerTransfer` description) and that it is documented in the
> OpenAPI schema.
```

## `docs/architecture/04-x402-payment-sequence.md`

<!-- sha256: 2d86ffe8594dc41e74408c433b5b549ab4fe32867de510f55e8f4e1c9d389baf -->
```markdown
   > **#3518 re-verification, 2026-10-01 — WHICH budget the compare runs
   > against.** The pre-check selects the payment's OWN budget
   > (`selectBudgetForPaymentReport`, the mirror of the payment rule
   > `SELECT_DELEGATION_FOR_PAYMENT_SQL`): a recipient-pinned budget for
   > `merchantTo` wins, a pin to a different payee is excluded, and the open
   > budget answers everything else — never the FIRST per-token row, which
   > with an open 0.001 beside a pinned 0.005 described a budget that did
   > not pay. No `merchantTo` in the call → only the open budget is
   > eligible (a pinless quote cannot claim a recipient-scoped grant). This
   > changes refusals in both directions: an open 0.001 plus a pinned 0.005
   > for the pinned merchant is no longer refused; a large open budget
   > beside a small pin for this payee is now refused on the pin's
   > remaining. Success and refusal bodies both name the budget that paid
   > (`budget_id`, `budget_delegation_hash`,
   > `budget_recipient_address`, `budget_merchant_id`), additive/optional;
   > the typed refusal contract (`error_code`, `phase`,
   > `next_action`, `remaining_atomic`, `shortfall_atomic`, the refusal
   > ledger row) is unchanged — only the budget whose figures it cites
   > moved. The allowance rows this section's summary reports carry the
   > same identity (`delegation_hash`) plus scope
   > (`recipient_address`, `merchant_id`) and the Haven-side
   > reservation (`reserved_haven_atomic`, summed beside the on-chain
   > remaining, never folded into it).

#3518 re-verification (2026-10-01): the settled row now names the budget that
metered it. `payment_intents.budget_delegation_hash` (recorded at authorize,
migration 053) rides `GET /machine-payments/:id/status` as
`budget_delegation_hash` / SDK `budgetDelegationHash` (additive/optional;
omitted on the legacy rail and on rows predating migration 053), and the
settle summary picks the allowance row whose `delegationHash` equals it —
the budget that PAID — instead of re-deriving a (token, payee) first match
whose winner can move between pay and settle (the grants' window can shift,
and task-/sub-budget payments meter their PARENT by hash while the payee
matches no pin at all). The token first-match remains only as the fallback
for an older backend whose status predates the field. A status payload that
carries the field but matches none of the agent's own rows (a sub-budget
payment metering another agent's budget, or a re-key between pay and settle)
reports the figure unavailable (`ALLOWANCE_CHECK_UNAVAILABLE`), never another
budget's remaining; the failed-read degradation above is unchanged.

> **Re-verified (#3475 follow-up, 2026-09-30, passage only).** An `accepted`
> outcome on an eip3009 payment with no merchant *settlement* recorded yet
> (a separate fact from the evidence row above — the delegate → merchant
> transfer, not the merchant's HTTP response) also names
> `haven_report_settlement_evidence` as the next tool, `payment_id`
> prefilled: pass the merchant's `PAYMENT-RESPONSE.transaction` as
> `settlement_tx_hash` if it returned one. A call carrying only `payment_id`
> is a well-formed success no-op — nothing checked, nothing recorded — never
> a refusal, since the merchant may simply have returned no hash.
> `last-verified` unchanged.
>
> **Folded in one call earlier (#3727).** The outcome tool itself now takes
> the optional evidence — `settlement_tx_hash` and/or the raw base64
> `PAYMENT-RESPONSE` header as `payment_response` — and on an `accepted`
> outcome records it through the same `reportSettlementEvidence` seam,
> verified on-chain BEFORE recording (a mismatching or zero hash refuses
> before anything is written; the decoded header contributes `transaction`
> only, never `payer`). With evidence supplied the response names no next
> tool, so the plain-HTTP eip3009 purchase needs one call fewer; the standalone `haven_report_settlement_evidence` stays for agents
> that call it and for the paid-MCP/erc7710 handoffs that already name it.
>
> **The proof header rides the report (#4061, passage only).** Since #3925 a
> REPORTED EIP-3009 merchant settlement is recorded only with the payment
> header the agent sent the merchant (the passive sweep still records a
> derived-nonce settlement with no report). Haven never sees that header on this path, so both
> report tools take an optional `payment_header`: the exact header the agent
> retried with. It is forwarded as `paymentProofHeader` plus the names
> `x402PaymentHeaderNamesSent` derives, the funding report's pair. A report
> without it is refused with `error_code: "settlement_proof_header_missing"`,
> and the tools answer `SETTLEMENT_PROOF_HEADER_MISSING`, naming
> `haven_report_settlement_evidence` again with the hash prefilled. The
> agent adds `payment_header`; the hash was not judged. Every other refusal
> keeps its terminal answer. `last-verified` unchanged.
>
> **The header is prefilled where the arm holds it (#4530, passage only).**
> "The agent adds `payment_header`" is no longer the whole story. On the arms
> that already hold the agent's header — the retryable settlement-evidence
> handoff of `haven_complete_mcp_tool` / `haven_settle_mcp_tool`, the report
> tool's own status-unreadable arm, and the plain-HTTP outcome report's
> folded-evidence retryable and offer arms — `next_arguments` now carries
> `payment_header` beside the hash, so the agent re-supplies nothing. The
> plain-HTTP retryable arm prefills what the call FORWARDED as `proofHeader`,
> never the raw argument. The prefill is omitted when the header exceeds the
> report tools' 16,384-character cap, and the prose still names the header for
> a client holding a stale tool list. The missing-header arms stay prose-only:
> there the call carried no header, so there is nothing to prefill. The status
> read also names the recorded transaction now
> (`merchant_settlement_tx_hash`), so an agent can confirm on that read which
> settlement Haven recorded. `last-verified` unchanged.

#3518 re-verification (2026-10-01): the agent-facing reads now say which
budget and what is reserved. `GET /machine-payments/allowances` rows carry
`delegation_hash` / `recipient_address` (null = open) / `merchant_id`
(null except a #3331 merchant-locked budget) / `reserved_haven_atomic` —
the sum of the budget's OPEN, unexpired task- and sub-budget children's
caps, keyed by delegation hash and reported BESIDE `onchain.remaining`,
never folded into it (the on-chain figure stays authoritative; a
reservation releases on close/expire without any chain event). The
sub-budget half of that sum walks grant → parent-child → the budget
delegation's hash (`SUM_OPEN_RESERVED_FOR_BUDGET_DELEGATION_SQL`) —
`sumOpenReservedForParent` keys on the parent-child row's OWN hash and
would answer 0 here. `GET /task-budgets?status=live` (and the MCP/SDK reads
over it) list unexpired pending, open, and closing rows, each
with its `status` (closed rows and every expired row omitted — an
expired `closing` row owes no close signature, since the close would
be trivial #3329 N2(c) / #3773; `status=all` still
answers every row), and
`GET /task-budgets/:id` is the read-by-id the MCP
`haven_get_task_budget` surfaces — the status check a close refusal's
"re-check the budget's status" points at, for any status.

> **Re-verification (#3097, the paid retry's target, 2026-09-18):** this diff
> touches the hosted plain-HTTP handlers, the hosted tool contracts and the
> SDK's quote/transport modules in this document's coverage list. What changed:
> `haven_pay_x402_quote` and `haven_resume_x402_payment` take an optional `url`
> (the URL the agent quoted), the quote returns `request_url` / `retry_url` /
> `resource_url_differs_from_request`, pay and resume return `retry_url`, and a
> public `http://` retry target is refused (`INSECURE_RETRY_TARGET`) before an
> intent exists on the hosted surface, and on the SDK side at
> `McpMerchantTransport.deliverPayment` (after funding on the MCP-merchant
> family, annotated by the hosted completion tool). The
> flows above are otherwise unchanged: selection, caps, funding, signing and
> settlement evidence keep their positions; the paragraph "Where the paid retry
> goes" is the new statement. Scope of this note: that paragraph and the
> diagram's `url` argument. Nothing else in this document was re-verified.

> **Re-verification (#3101, the typed next-step builder, 2026-09-18):** this
> diff adds `packages/sdk/src/next-step.ts` (the builder, exported from the
> SDK's `index.ts`) and touches `packages/mcp-server/src/tools/support/{guidance,errors}.ts`,
> `packages/mcp-server/src/tools/{contracts,catalog-purchase,plain-http-x402,paid-mcp-completion,state-direct-recovery}.ts`,
> the hosted server's instructions (they name the omitted-reason field; that
> file is on `mcp-runtime-compatibility.md`'s list), the SDK's `types.ts` (a new optional `next_tool_omitted_reason` on
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
> 2026-09-18):** this diff adds the next-step ratchet (`npm run
> lint:next-steps`, a shrink-only gate with a zero baseline, wired into CI),
> moves the hosted next-step fixtures into the hosted server's test-support
> module, and extends the hosted parity test (the one on
> `mcp-runtime-compatibility.md`'s list) into the cross-surface walk: every hosted emission fixture is built for real and
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

> **Re-verification (#3344, one observer-receipt helper, 2026-09-26):** this
> diff touches `packages/qa-agent/src/scenarios/x402-hosted-mcp-signer.ts` only
> to replace its private copy of `waitForReceipt` with the harness's one shared
> observer-receipt helper, called with the leg's own
> `TIMING.receiptWaitMs` / `pollIntervalMs` (read per call, so the test seam is
> unchanged). The leg's assertions, its reads and every payment step it drives
> are unchanged; its suite passes unmodified. Scope of this note: that helper.
> Nothing else in this document was re-verified.

> **Re-verification (#3332, additive `parties.buyer`, 2026-09-27):** this diff
> adds an OPTIONAL `buyer` field to `Parties` (`openapi/party-model.ts`) — the
> paying agent's owner's company details, present only when
> `HAVEN_OWNER_COMPANY_DETAILS` is on and the owner has saved details, absent
> (the key missing, never present-and-null) otherwise. It is not part of any
> settlement typed data, does not change `withParties`' existing four fields,
> and does not touch `routes/x402.ts`, `x402-delegation.ts`, the settlement-
> transfer verifier, or `agent-payment-status.ts` (deliberately not wired in
> this slice — see `docs/product/owner-company-details.md`). Every existing
> consumer of `Parties` is unaffected by construction: an optional key nothing
> previously read. Scope of this note: that one field. Nothing else in this
> document was re-verified.

> **Re-verified #3423 (slice A, hosted agent-surface polish, 2026-09-29):**
> this diff made three passages stale. This document said an
> "unknown/degraded/non-MCP catalog row" and the `2.` sequence step's
> "`degraded` row or one missing MCP tool metadata (`protocol`/`tool_name`)"
> ALL shared one fallback, `haven_pay_mcp_tool` — that was already wrong for a
> plain-HTTP row (no `tool_name` to pass it) before this fix, and this fix is
> what corrected the code. Both passages now read: a plain-HTTP row hands off
> to `haven_quote_x402 { url: resource_url }` (checked FIRST); a degraded or
> tool-less MCP row keeps `haven_pay_mcp_tool`; an unknown catalog_id names
> `haven_discover_tools`. The `agent_summary.purchase_summary` passage gained
> one sentence: on erc7710, `funding_tx_hash` is always `null` (no funding
> leg), never back-filled from the settlement hash `payment.txHash` otherwise
> carries on that scheme — the erc7710 settled branch of
> `haven_settle_mcp_tool` did not build `purchase_summary` at all before this
> fix, so the field's existing generic description was previously read as
> EIP-3009-only; it is now true of both schemes. Scope of this note: those
> three passages. Nothing else in this document was re-verified.
> `last-verified` is not re-stamped.

> **Re-verified #3988 (2026-10-15 — a read-only holder-side sub-budget
> listing).** The diff touches one covered path:
> `routes/agent-sub-budgets.ts` gains
> `GET /agents/{id}/sub-budgets/received` — a SELECT-only read of the
> non-closed grants an agent RECEIVES, with the parent agent's name joined,
> for the holder's own page. It prepares, signs and redeems nothing and
> offers no mutation (closing stays the delegator's DELETE); the
> payment-time chain check (`checkSubBudgetForPayment`) is untouched, and
> the display verdict the Agent payload ships is the same chain that check
> already enforced, so no display can now present a chain the payment path
> would refuse. Scope of this note: that one route. Nothing else in this
> document was re-verified; `last-verified` is bumped to 2026-10-15 for
> exactly this coverage.

> **Re-verification (#4119, qa-dev asserts the merchant settlement was
> recorded, 2026-10-20):** this diff touches
> `packages/qa-agent/src/scenarios/x402-hosted-mcp-signer.ts` to ADD an
> assertion after `haven_settle_mcp_tool` returns, through a new helper the
> four qa-dev EIP-3009 legs share: the payment status must
> carry `merchant_settlement_recorded`, the receipt's `settlement_tx_hash`
> must equal the settle's, and the settle's eip3009 evidence guidance is
> followed — a `haven_report_settlement_evidence` follow-up carries the
> leg's own `payment_header`, and any refusal fails the leg. It reads the
> existing status flag, receipt field and hosted guidance, and makes one
> WRITE: on the report-tool arm (retryable, or the missing-proof-header
> refusal) it calls the guided `haven_report_settlement_evidence` with the
> prefilled `next_arguments` plus its own `payment_header`, as the guidance
> instructs an agent to. No backend, hosted or SDK behaviour or signing
> decision changes, and the leg's quote, sign and settle calls are
> unchanged. Scope of this
> note: that harness assertion. Nothing else in this document was
> re-verified; `last-verified` is not re-stamped.

> **Re-verified #4303 part E (2026-10-23, full re-read).** Every section of
> this document was re-read against the code at `d061a2b90`. Corrected: the
> hosted EIP-3009 diagram now draws the default `haven_sign_x402` one-shot and
> the outcome report; the expected-context table gains its v3 row; the
> paid-MCP fast path states its erc7710 shape; the catalog preflight's step
> reference, refusal summary and round-trip budget match the code after
> #3054; the unpinned settlement child lists all three ways authorize
> receives no `facilitatorAddresses`; and several counts were replaced with
> pointers to the instruments that hold them. A review round then found the
> post-purchase summary still describing the #1306 preflight's pre-#3054
> read, and a forward reference to #3102 that the shipped slice did not
> fulfil; both are corrected, and the #3054 fact family was swept with the
> wrapped lines joined. `last-verified` is bumped for this re-read.

> **Re-verified 2026-10-26 (#4449, the signer's success next-step family):** the
> signer's six success results and the settlement-child guidance were re-read
> against `packages/signer/src/tools.ts`, `next-step.ts` and
> `no-funding-leg.ts` at `origin/dev` `b9f9f1e47`. Scope of this note: the
> paragraph added above. The rest of this document was not re-read for it, and
> `last-verified` is not bumped.

> **Re-verified 2026-10-29 (#4534, the purchase correlation key on the outcome
> report):** this diff touched four files in this document's coverage list —
> `packages/sdk/src/client.ts`, `packages/sdk/src/merchant-completion.ts`,
> `packages/sdk/src/types.ts` and `packages/mcp-server/src/tools/**` — and none
> of the sequence, signing or settlement claims above. `reportX402MerchantOutcome`
> gains two OPTIONAL inputs, `purchaseGroupId` and `merchantResponse`, spread
> into the same `POST /machine-payments/evidence` payload the accepted arm
> already posts, so the accepted-outcome behaviour described above is
> unchanged: `proof_status` still upgrades to `merchant_response_observed` and
> the payment still leaves case 2's predicate permanently. The hosted
> `haven_report_x402_outcome` gains the same two optional arguments and
> forwards them to that same report. `HavenPaymentReceipt` gains two optional
> read-only fields (`purchaseGroupId`, `parentPaymentId`), absent on an older
> backend. Nothing here authorizes, signs, funds or settles anything: the
> fields are descriptive metadata on a document the accounting feed already
> produces, and a payment with no correlation is reported exactly as before.
> Scope of this note: those four files. Nothing else in this document was
> re-verified, and `last-verified` is not bumped.
```

## `docs/architecture/05-agent-api-openapi.md`

<!-- sha256: 555404dc9067b1ca74be44e32d99b2b3c5744dd368dea5e2ca7ee36d04b65bf4 -->
```markdown
Re-verified 2026-10-23 (#4372 part B, at dev `2d0713dad`), a full re-read. Changed:
the `/agents` facet sentence names the account (#3719) and organization
facets beside the built-in status and budget ones (`AgentPanel.tsx`); the agent-activity reads gain #4366's export
(review round 1 of #4377); the
spend-authority read names #4355's `next_refill_at` (spec entry beside each
row's `onchain` block); the `AgentApiKey` operation count is 46 (five also
accept `DashboardJwt` or `SetupToken`); the route total is 211 across 49
modules, one undocumented (`safe-deploy.ts`), re-counted with the coverage
gate's own survey. Re-checked without change: the four security schemes,
`apiBaseUrl`'s four callers and its gating (`domain/request-origin.ts`),
`PUBLIC_CATALOG_FIELDS` and the eight-word search, the SDK's `POST /x402`
alias, the resume union, the empty `KNOWN_UNDOCUMENTED_ROUTES` and the
1/1 ceilings (`openapi/route-coverage.ts`), the three `allOf` components,
the five human-decimal emitters (`rails/delegation-budget-view.ts`
importers), and `RefusalActivityEntry` (#4323).

Re-verified 2026-10-26 (weekly docs audit #4438, at dev `ebf567f1c`), a
targeted re-read of the counts and the discoverability claims rather than a
second full pass. Re-derived with the coverage gate's own extractor
(`openapi/route-inventory.ts`): **211 declared routes across 49 registered
modules**, one undocumented (`safe-deploy.ts`), `KNOWN_UNDOCUMENTED_ROUTES`
empty and `MAX_UNDOCUMENTED_MODULES`/`MAX_UNDOCUMENTED_ROUTES` both 1 — the
same figures the 2026-10-23 pass recorded. `AgentApiKey` is still the security
scheme on **46** operations, with **5** of those also accepting `DashboardJwt`
or `SetupToken`, and the four schemes are unchanged. Re-checked without change:
`servers[0]`'s derivation from `domain/request-origin.ts` (including the
`TRUST_PROXY_HOPS` gating and the leftmost-scheme residue), the root document's
thinness, `PUBLIC_CATALOG_FIELDS` and the eight-word `search`, the
`GET /payments/{id}/sign-context` / `GET /x402/{id}/sign-context` /
`GET /x402/by-idempotency-key/{key}` / `GET /payments/{id}/resume_state` reads,
`POST /machine-payments/budget-precheck` and `GET /machine-payments/balance-coverage`,
the `/task-budgets/*` and `/sub-budgets/*` families with their owner routes, the
`/labels` family and `PUT /agents/{id}/labels`, `BUILT_IN_FACETS` plus the
account (#3719) and organization facets, and the catalog's
`tool_arguments_schema` / `http_method` / `body_type` / `body_example` shapes.
The 21 covered commits since 2026-10-23 — #4404's `payment_intents.failed_at`
(a one-line spec description change), #4434's money-path globs, the analytics
and token fixes, and the #4372 doc sweeps — moved no operation, scheme or route
count.
```

## `docs/architecture/06-hosted-mcp-connect-flow.md`

<!-- sha256: c3423ac5a13892d867e986b1e996ad95d8d48a74de6c3d4fb4b21e1c4535f721 -->
```markdown
> **Re-verified #3495 (2026-09-30):** step 2's result shape and step 3's
> recovery route, for the compact-by-default result and its opt-in relay.
> Nothing else in this file was re-verified in this pass.

> **Re-verified (#3475 follow-up, 2026-09-30, passage only).** The added
> `haven_report_settlement_evidence` step above is the hosted next-step
> answer, not a new tool: `haven_report_x402_outcome`'s response names it
> when the fact warrants it (eip3009, accepted, unsettled), and the tool
> itself now accepts a bare `payment_id` as a well-formed no-op when the
> merchant returned no hash. `last-verified` unchanged — nothing else in this
> file's scope was re-checked.

Re-verified 2026-10-05 (weekly docs audit #3645, at dev `cdb91d86`), a full
re-read of everything except the dated notes. Changed: the recommended
paid-MCP path shows the erc7710 shape beside the EIP-3009 bridge; the
`POST /payments` comparison under the pre-checks now reflects its own #3503
period pre-check and typed `403`; the hosted direct-payment paragraph says
the legacy branch answers `410` (deleted in #1987) instead of "serves both
rails"; the tool-surface list drops the retired MPP tools, gives
`haven_check_funds`'s `covered` its null case and adds the reports, catalog
submission and task budgets; the strict-input count (stale at 22 of 24) is
replaced by the rule it counted; and the signer paragraph and `haven_sign` row
name the task- and sub-budget sign-contexts. Re-checked without change: the
connect steps and what registration sends, the boot-time key guard, the
`run_mode` refusal, the collision prompt, one budget per signature, the
direct-payment fields and recovery text, the erc7710 pre-check and its 201
shape, the `/x402/authorize` 410, the merchant-receipt capture, and the
custody summary.


Re-verified 2026-10-23 (#4372 part B, at dev `2d0713dad`), a full re-read. Changed:
the signer section names all five tools — `haven_sign_siwx` (#3728) was
missing from the table and from the never-reaches-the-network list
(`SignerToolName`, `packages/signer/src/tools.ts`); the manual-credential
paragraph says the key pair is generated in the browser and separates its
credential material (and the setup token and challenge id that authenticate
the call, added in review round 1 of #4377) from the setup metadata it also
sends
(`hooks/useAgentConnectionSetup.ts`). Re-checked without change: the hosted
egress limits (`HOSTED_MAX_GET_REDIRECTS = 3`, non-GET redirects refused,
the DNS residual, all in the SDK's merchant egress policy), the boot-time key
guard (`mcp-server/src/cli.ts`, `server.ts`), the #4065 containers, the
registration payload, the `run_mode` 400, `approval_url`, the #3772 report
window (30 minutes) and `superseded_by` reads, the erc7710 `haven_sign`
next step (`tools/catalog-purchase.ts`), the #3768 redaction and
`include_merchant_credentials`, the 15-minute grace window
(`domain/merchant-report-grace.ts`), and both authorize pre-checks with
their fail-open shapes (`modules/x402/delegation-authorize.ts`).

Re-verified 2026-11-02 (weekly docs audit #4605, at dev `fc8ac1eb6`). No claim
needed rewriting. Re-checked at this head: the five signer tools
(`SignerToolName`, `packages/signer/src/tools.ts`); the strict/permissive input
lists (`STRICT_INPUT_TOOLS` / `PERMISSIVE_INPUT_TOOLS`,
`mcp-server/src/tools/contracts.ts`); `haven_check_funds`'s `covered`
true/false/null; the task-budget tools (`haven_open_task_budget`,
`haven_get_task_budget`, `haven_close_task_budget`); both sign-context reads
(`GET /x402/:id/sign-context`, `GET /payments/:id/sign-context`); the
`retired-agents` report window (`RETIRED_AGENTS_REPORT_WINDOW_MINUTES =
SETUP_TOKEN_TTL_MINUTES = 30`); `HOSTED_MAX_GET_REDIRECTS = 3`
(`sdk/src/merchant-egress.ts`); and the 15-minute merchant-report grace
(`domain/merchant-report-grace.ts`). The week's drift added behaviour this doc
does not contradict: retry-or-stop is decided by the failure's cause rather
than its status (#4516), the x402 merchant rejection reason is recorded and
echoed on rejected retries (#4558), settlement-evidence handoffs prefill
`payment_header` (#4536, already noted above), and the ten typed task-/
sub-budget payment-scope refusals answer in the MCP layer (#4483).
```

## `docs/architecture/07-edge-signer.md`

<!-- sha256: 602a2cf2c61772d7a2b56a965ec9d6e7c8bf6ecf605a6c5b29bf25b424f62b04 -->
```markdown
> **Re-verified #3495 (2026-09-30):** the "Regular payment" sequence, the
> paragraphs through the compact-by-default note below, and the "Preferred
> x402 form" paragraph's direct-payment sentence further down (which used to
> say direct payments "always carry the full pair as well, for older
> signers" — no longer true since #3495) were updated for the #3495 owner
> decision (direct-payment results compact by default, relay behind an
> `include_signing_payload: true` opt-in) and its review-round-1 and
> round-2 corrections (the two-trigger-shape fix, the S5 no-sign-data-replay
> guard, the direct fetch's 404 naming both routes). Nothing else in this
> document was re-verified in this pass.

> **Re-verification (#3935, the derived EIP-3009 nonce, 2026-10-14):** the
> `buildX402PaymentHeader` sentences were added against `origin/dev`
> `686ac03c` (`packages/signer/src/core.ts`, the backend's
> `eip3009-settlement-sweeper.ts`). Scope of this note: that bullet. The rest
> of this document was not re-read for it, and `last-verified` is not bumped.

> **Re-verified 2026-10-19 (weekly docs audit #3645, at dev `cf88627c`):** the
> whole document was re-read against the code. Changed: the core lists
> `signSiwxMessage` (#3728); the handshake paragraph names the sign-context
> version sets (#3506 added the sub-budget one); the #3272 allowlist accepts
> the #3330 three-link sub-budget chain, not two shapes; the over-budget 502 is
> typed (#3609) and a confirmed budget revert answers 403; the hosted egress
> policy's deadlines and caps (#3747); the decomposed x402 flows gain the quote
> step (#3739) and the outcome / settlement-evidence report, with the proof
> header #3925 requires; the SIWX audit row; and the sweep supports Base
> Sepolia as well as Base mainnet (`isSweepableChain`). Checked and accurate:
> the `core.ts:448-454` and sweeper `:464` line anchors, the tool set and
> `--help` / unknown-option exit 2 (run), the consent and ack paths, the audit
> rotation constants, the SIWX grammar limits, and the 300 s delivery default.

> **Re-verified 2026-10-23 (#4372 part A, at dev `1579908a4`):** the whole
> document was re-read. Changed: the nonce line anchors (`core.ts:495-501`,
> sweeper `:472`), and the scope note no longer says delegation-rail payments
> are not exposed as signer tools — `haven_sign` signs their `eip712_userop`
> typed data (#3271/#3272) and the erc7710 settlement child — and names the
> SDK's `eip712_delegation` target, `signSettlementDelegationTypedData`. Re-checked without change: `RETIRED_BINDING_MEMORY`
> (64), the handshake version fields, the egress deadlines (5 s discovery, 15 s
> quote and session, 300 s delivery, ≤3 GET redirects), the sweep chains
> (`isSweepableChain`: Base, Base Sepolia), `X402_BINDING_PRIVATE_KEY` with no
> fallback, `HAVEN_SIGNER_ACK` and the ack sidecar, and the 8 MiB audit rotation.

> **Re-verified 2026-10-25 (weekly docs audit #3645, at dev `615686369`):**
> the whole document's standing claims were re-spot-checked at this head.
> Changed: the derived-nonce line anchor is now `core.ts:496-503` (the
> overwrite and the library's `signPaymentHeader` call moved down three
> lines); the sweeper's `:472` nonce anchor still lands exactly. Checked and
> accurate: `RETIRED_BINDING_MEMORY` (64, `core.ts:270`), the
> `client.ts:668-697` scheme dispatch, the 8 MiB audit rotation
> (`AUDIT_ROTATE_BYTES`), the SIWX 300 s window plus pinned skew tolerance
> (`SIWX_MAX_AGE_SECONDS`, `siwx.ts`), the dedicated binding key still read
> from `X402_BINDING_PRIVATE_KEY` with a throw (never the relayer key — it
> lives in `infra/chain/x402-binding-signer.ts:90`), and
> `isSweepableChain` in `packages/sdk/src/sweep.ts`. The week's covered
> drift (x402 proof-header settlement reports #4075, expired-only budgets
> #4376) changed what reports carry and refuse, not any signer boundary.

> **Re-verified 2026-10-26 (#4449, the signer's success next-step family):** the
> six success sites and the settlement-child guidance were re-read against
> `packages/signer/src/tools.ts`, `next-step.ts` and `no-funding-leg.ts` at
> `origin/dev` `b9f9f1e47`. Scope of this note: the success-result paragraph and
> the `NO_FUNDING_LEG` bullet. The rest of this document was not re-read for it,
> and `last-verified` is not bumped.
```

## `docs/architecture/08-local-vs-hosted-mcp.md`

<!-- sha256: 87110ea4799aab4768b55326ee2b058d615b7d144f6e0329692ceade3309ec6a -->
```markdown
> **Re-verified (#3475 follow-up, 2026-09-30, passage only).** The added
> step is `haven_report_x402_outcome`'s own next-step answer, offered only
> when the fact warrants it (eip3009, accepted, unsettled) — not a new call
> an agent must always make. `last-verified` unchanged.

> **Re-verified (#4530, 2026-10-29, passage only).** "The agent adds
> `payment_header`" is no longer the whole story. Where the handoff already
> holds the agent's header — the retryable settlement-evidence arms of
> `haven_complete_mcp_tool` / `haven_settle_mcp_tool`, the report tool's own
> status-unreadable arm, and the plain-HTTP outcome report's folded-evidence
> retryable and offer arms — `next_arguments` now carries `payment_header`
> beside the hash, so the agent re-supplies nothing; the plain-HTTP retryable
> arm prefills what the call FORWARDED as `proofHeader`, never the raw
> argument. The prefill is omitted when the header exceeds the report tools'
> 16,384-character cap, and the prose still names the header for a client
> holding a stale tool list. The missing-header arms stay prose-only: there
> the call carried no header. The status read also names the recorded
> transaction (`merchant_settlement_tx_hash`), so an agent can confirm on that
> read which settlement Haven recorded. `last-verified` unchanged.

> **Re-verification (#3097, the paid retry's target, 2026-09-18):** this diff
> touches `packages/mcp-server/src/tools/{plain-http-x402,contracts,paid-mcp-completion}.ts`,
> `packages/mcp-server/src/tools/support/mcp-context.ts` and the SDK's
> `mcp-merchant-transport.ts` (in this document's coverage list; the SDK's
> `x402-protocol.ts` is covered by `04-x402-payment-sequence.md`). Both surfaces keep their contracts; what is new is an optional `url` on
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
> accepts, 2026-09-18):** this diff touches both discovery maps (`packages/mcp-server/src/tools/catalog-purchase.ts`, `packages/mcp/src/tools.ts`) and the hosted strict-refusal builder. Additive on the read side:
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
> field (it has had one since #2366). A row no verbatim hint exists for — an MCP
> row without `tool_name` on either surface, a degraded MCP row on the hosted
> one — carries `suggested_tool_omitted_reason` instead of a hint, on BOTH
> surfaces (review rounds 1–2), so that field is not a divergence. Scope of
> this note: those fields and that text. Nothing else in this document was
> re-verified.

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

Re-verified 2026-09-30 (weekly docs audit #3413, at dev `5b5bd059`). One claim
needed updating: the strict/permissive census said "21 of the 23 hosted tools
refuse"; the registered surface is now 26 tools (the #3354 task-budget slice
added `haven_open_task_budget`, `haven_close_task_budget`,
`haven_check_funds`, and later slices added
`haven_report_settlement_evidence`), with 24 on `STRICT_INPUT_TOOLS` and
`PERMISSIVE_INPUT_TOOLS` still exactly `haven_get_agent` +
`haven_get_allowances` — every tool on exactly one list, checked mechanically
against `tools/contracts.ts` at this head. Everything else re-checked:
the custody-boundary lines (hosted stays keyless; the sign-context fetch is
still the signer's whole network surface), the #2561 three-state report, the
receipt-vs-wallet scope declaration (#3132) and the vocabulary pairs (#3134,
open count still 0 — `scripts/ci/vocabulary-map.json` unchanged), the #3411
`idempotencyKey` refusal (`IDEMPOTENCY_KEY_RENAMED`, still declared-but-refused
in the schemas), the #2366 body convergence, the standing
`quote`/`payment_required` owner decision, the deleted `#314` aliases
(`server.ts` still iterates `toolSchemas` only), the five edge-signer tool
names, the two-flow x402 comparison (EIP-3009 bridge / erc7710 direct, the
settle-column split, `POST /x402/:id/settle` selection, the #1986 410 rail
scope — still present in `routes/x402.ts`), `assertExpectedBinding` /
`verifySettlementChild` in the signer, and the qa-dev env pins
(`QA_HOSTED_MCP_URL` / `QA_DEMO_MERCHANT_URL` in `.github/workflows/qa-dev.yml`).
The week's tool-surface drift (#3423 slices, #3444, #3465 catalog handoff,
#3467 compact receipts, #3476 allowance block, #3485 allowance spelling)
extended schemas and refusal text inside the documented decision structure;
none of it moved the local/hosted split this document is about.

> **Re-verification (#3935, the hosted contract fingerprint, 2026-10-14):** the
> fingerprint paragraph under "Tool model" was added against `origin/dev`
> `686ac03c` (`packages/mcp-server/src/{server,contract-fingerprint}.ts`); a
> grep over `packages/mcp/src` and `packages/signer/src` for
> `contract_fingerprint` / `server_version` returns nothing, which is the
> "hosted only" claim. Scope of this note: that paragraph and the related-docs
> link. The rest of this document was not re-read for it, and `last-verified`
> is not bumped.

Re-verified 2026-10-23 (#4372 part A, at dev `1579908a4`). Changed: the
strict/permissive census is 27 strict of 29 hosted tools (#3788 added
`haven_report_delivery_quality`; `PERMISSIVE_INPUT_TOOLS` still exactly
`haven_get_agent` + `haven_get_allowances`), and the fingerprint paragraph's
`server.ts` line anchors moved (instructions `:169-183`, `annotateStaleToolList`
`:373-385`, `toMcpResult` `:387-405`); and the report paragraph no longer
says erc7710 needs no report step (#3774, review round 1). Re-checked without
change: the five
signer tools, the report-settlement-evidence arguments, the hosted egress
deadlines and the DNS residual (`sdk/src/merchant-egress.ts:16-18`), the qa-dev
env pins, and the #1986 410 (`modules/x402/authorize.ts:106`).

Re-verified 2026-11-02 (weekly docs audit #4605, at dev `fc8ac1eb6`). No claim
needed rewriting. Re-checked at this head: the five signer tools
(`SignerToolName`, `packages/signer/src/tools.ts`); the strict/permissive
census lists (`STRICT_INPUT_TOOLS` / `PERMISSIVE_INPUT_TOOLS`,
`mcp-server/src/tools/contracts.ts`); the next-step vocabulary and its
shrink-only lint (`scripts/ci/vocabulary-map.json`, `scripts/lint-next-steps.mjs`,
`sdk/src/next-step.ts`, `signer/src/next-step.ts`); the next-step
characterization and signer-parity suites; and the hosted egress constants
(`HOSTED_MAX_GET_REDIRECTS = 3`, `sdk/src/merchant-egress.ts`). The week's
drift is additive to what this doc states: retry-or-stop is decided by the
failure's cause rather than its status (#4516), the x402 merchant rejection
reason is recorded and echoed on rejected retries (#4558), settlement-evidence
handoffs prefill `payment_header` (#4536, already noted above), and the ten
typed task-/sub-budget payment-scope refusals answer in the MCP layer (#4483).
```

## `docs/architecture/09-fee-module.md`

<!-- sha256: 710ae8e01115886ceb89fec168d37c1aecb2b74d287490a7c50e84400d50bbfd -->
```markdown
Re-verified 2026-09-30 (weekly docs audit #3413, at dev `5b5bd059`). No claim
needed rewriting; `modules/fee/` and migration 029 have no commits since the
last verification. Re-read at this head: `quoteFee` still returns the zero
quote unconditionally — including when `HAVEN_FEE_ENABLED` is set
(`fee-module.ts` zero-quote branch at both flag states); the ledger write
stays the best-effort zero-fee row, idempotent per payment via
`ON CONFLICT DO NOTHING` in `infra/repositories/payment-fees.ts`; the SDK
still maps the same public `fee` shape (`payment-mappers.ts`). The covered
commits that did move (`routes/payments.ts`, `modules/mpp/`,
`modules/payments/agent-payment-status.ts` — #3423 settle semantics, #3420
terminal delivered-unsettled status, #3479 settlement recording) changed
payment status and settlement handling around the scaffold, not the fee
shape or the zero-fee path.

Re-verified 2026-10-23 (#4372 part B, at dev `2d0713dad`), a full re-read. Changed:
epic #386 is named as closed (2026-06-17). Re-checked without change:
`quoteFee` returns the zero quote at both flag states (`fee-module.ts`); the
one ledger writer is `recordSettledFee`, called best-effort from
`modules/mpp/evidence.ts` after settlement and idempotent through
`ON CONFLICT (payment_id) DO NOTHING` (`infra/repositories/payment-fees.ts`);
no `RailFeeExecutor` implementation exists; `routes/payments.ts` and
`modules/payments/agent-payment-status.ts` surface the zero fee and the SDK
maps it (`payment-mappers.ts`); `HAVEN_FEE_ENABLED` is read in `config.ts`.
```

## `docs/architecture/10-module-boundaries.md`

<!-- sha256: b2bd296116c05142bc3c4f465b239d8af6b192b68343116dc24e36bd8ff79c93 -->
```markdown
Re-verified 2026-09-30 (weekly docs audit #3413, at dev `5b5bd059`). The
module list gained `modules/sub-budgets/` (#3444) in the target structure and
the rule-6 row; the largest-route line was re-measured (1451, up from 1379 —
the request-validation slices #3276/#3405 and the Safe-vocabulary renames
grew `routes/agent-connection-setups.ts`); the boundary-enforcement row's
waiver census now names its real split, 9 `pg-only-in-infra` plus the #2881
deep-cross waiver (the previous "10 pg-only" wording predated that waiver's
arrival by four days); and the delegation-rail file count in prose is nine,
not seven (unchanged since the last measure — the count itself was misstated).
Everything else re-checked at this head against the machinery: `npm run
lint:deps` prints 40 `.query(` call sites across 10 files (unchanged), the
ceiling 58, 10 waived edges and 0 violations across 414 files;
`.dependency-cruiser.cjs`, `scripts/dep-lint.mjs` and the callsite ceiling
have no commits since 2026-09-15; the session-key seam grep still fires only
in `rails/execution-rail.ts` (the `routes/payments.ts` mentions are
`isRetiredRailIntent` comments naming it retired, the documented shape); the
#2138 passport SQL exception and the rule-4 chain-client port
(`infra/chain/index.ts` `getChainClient`) are as written.

Re-verified 2026-10-02 (#3597): the module list and rule-6 row both gain
`modules/feedback/` — the backend half of the CLI feedback channel's secret
check. It is its own module rather than living in `domain/` (where its CLI
counterpart's comments might suggest) because it imports `viem/accounts`,
which `domain-stays-pure` forbids inside `domain/`. Mechanically the linter
would honour an inline waiver on that rule (`UNWAIVABLE_RULES` in
`scripts/dep-lint.mjs:39` names only `no-circular`), but by the policy above
`domain-stays-pure` never carries one, so `domain/` was never an option.
`lint:deps` fails if the file is ever moved into `domain/`.


Re-verified 2026-10-23 (#4372 part B, at dev `2d0713dad`), a full re-read with
`npm run lint:deps`. Changed: the module lists gain `budget-scope/` (#3616),
`dashboard/` (#3847) and, in the target structure, `ops/`; the rule-6 row
says the lint polices importers OUTSIDE `modules/` only (its `from` excludes
every `modules/<name>/` file), with 14 static module-to-module deep imports
it does not see; `no-deep-cross-module-import` carries 3 waivers, not none;
the waiver census is 11 (8 `pg-only-in-infra`, 3 deep-cross); the call-site
gauge is 35 across 9 files under a ceiling of 35 (locked down by #4044);
the largest route is `routes/payments.ts` (1561 lines); the passport alias
check is case-insensitive; the `lib/` row names `modules/dashboard/`'s missing
`index.ts` (review round 1 of #4377); the package-split sentence no longer implies
seven packages. (Merged with #4379 on 2026-10-24: the rule-3 row's census, the rule-6 row
and numbered rule 6, the waiver paragraph and the boundary-enforcement row
now carry #4379's text — a seventh rule, the module-to-module arm, and 15
waivers — so this note's rule-6, rule-count and waiver-census items describe
the doc at `2d0713dad`.) Re-checked without change: the six enabled rules and their
error severity (`.dependency-cruiser.cjs`), `UNWAIVABLE_RULES` and the
20-character reason floor (`scripts/dep-lint.mjs`), the nine
`rails/delegation-*` / `rails/hybrid-*` files, the `session_key` seam (only
`rails/execution-rail.ts` decides; the other mentions name the retired
passport enum member), the #2138 exception, `getChainClient` and the
conformance suite, and five published packages (`scripts/release-bump.mjs`).

Re-verified 2026-10-25 (weekly docs audit #3645, at dev `615686369`): the
module list and rule-6 lineage gain `modules/budget-scope/` (#3622, the
one-module link/pre-check/task-cap/refusal resolver); the largest-route line
was re-measured (`routes/payments.ts` 1561 now leads `routes/agent-connection-setups.ts`
1525); the gauge re-measured 35 `.query(` call sites across 9 files with the
ceiling shrunk to 35 (last locked by #4044); and the live lint prints
0 violations across 505 source files with the same 15 waived edges (8
`pg-only-in-infra`, 3 `no-deep-cross-module-import`, 4
`no-deep-module-to-module-import`). `UNWAIVABLE_RULES` still names only
`no-circular` (`scripts/dep-lint.mjs:39`), the #2138 passport SQL exception
and the rule-4 port (`infra/chain/index.ts` `getChainClient`) are as
written.

Re-verified 2026-11-02 (weekly docs audit #4605, at dev `fc8ac1eb6`), with
`npm run lint:deps` run at this head. Changed: the largest-route line is
re-measured at `routes/payments.ts` 1572 lines (it grew 11 lines across the
receipts and accounting work since 2026-10-26), and the live lint now prints
0 violations across 513 source files with the same 15 waived edges (8
`pg-only-in-infra`, 3 `no-deep-cross-module-import`, 4
`no-deep-module-to-module-import`). Re-checked without change: the 17
`modules/**` directories and their `index.ts` rule (only `modules/dashboard/`
has none), the nine `rails/delegation-*` / `rails/hybrid-*` files, the
inline-SQL gauge (35 `.query(` call sites across 9 files, ceiling 35), the
`session_key` seam, the #2138 exception, and `getChainClient`.
```

## `docs/bug-reports/_run-report-template.md`

<!-- sha256: 3b34d37a0abce5d636171a3d2354e945b8796941e23b4aa5ef08406bd01ddf61 -->
```markdown
The commands and artifact paths in this template were re-verified against the
repos on 2026-10-25 (weekly docs audit #3645, at dev `615686369`; previous
verification 2026-09-30, audit #3413 at `5b5bd059`): the five script names
above in `packages/frontend/package.json` and
`packages/qa-agent/package.json`, and both Playwright `outputDir` values in
`playwright.config.ts` / `playwright.live.config.ts` — all unchanged as
documented (the `output/playwright*/` paths are gitignored working dirs).
The intervening commits (#4372 parts A–I, #4405 agent-dir paths, #4407
catalog probe cooldown, #4352 expired-only budgets) changed the suites and
covered code, not the template's fields, tables or artifact layout. The
scenario table's over-budget claims still match the code: the typed HTTP 403
`delegation_budget_exceeded` pre-check covers both the EIP-3009 leg and the
erc7710 direct-settlement scheme (`modules/x402/delegation-authorize.ts`).

Re-verified 2026-11-02 (weekly docs audit #4605, at dev `fc8ac1eb6`). No claim
needed rewriting. Re-checked at this head: the five canonical commands
(`test:e2e:gate`, `test:e2e:desktop`, `test:e2e:mobile`, `test:e2e:live` in
`packages/frontend/package.json`; `qa:dev` in `packages/qa-agent/package.json`);
both Playwright `outputDir` values (`../../output/playwright/test-results`,
`../../output/playwright-live/test-results`); the two QA workflows and the
three `.claude/commands/qa-*.md` files; and the typed HTTP 403
`delegation_budget_exceeded` pre-check on both the EIP-3009 leg and the
erc7710 direct-settlement scheme. The week's drift (the typed task-/sub-budget
payment-scope refusals #4483, `delegation_expired` #4376, the x402 merchant
rejection reason #4558) adds refusal codes a run may record; the template's
fields, tables and artifact layout are unchanged.
```

## `docs/contributing/ai-agent-workflow.md`

<!-- sha256: 5dd782bc6474deb7afe04af13c02460fd0ad0938e58dc463677014a394c0a954 -->
```markdown
> **Re-verified 2026-10-24 (#4372 part F, at dev `6d87ddf95`), a full re-read.**
> Changed: *Inline Gate Placement* no longer points at a hoisted-notice layout
> in `EditAgentModal` — #2331 removed it, and no product file renders
> `<OnchainActionNotice />` now. The rule itself is unchanged, and the
> *Safe setup* phrase in the self-check list is left to open PR #4388.
> Re-checked without change: the three rulesets (`gh api …/rulesets`: code
> owner review required on `dev` and `main`), `CLAUDE.md` § *How shipping is
> governed*, `AGENTS.md` § *Agentic Workflow*, `.claude/hooks/ship-next-guard.sh`,
> the seven `.claude/agents/` adapters and their canonical references,
> `npm run preflight`, the named frontend symbols, `pendingApprovals` always 0
> (`routes/agent-activity.ts`), the ship-next verdict-line and arming rules,
> the Proportionality lane anchor, `scripts/ci/review-isolation.mjs`'s flags
> and its "not asserted" lines, prove-red's backup naming, `npm run
> screenshot`, and every cited issue's state with `gh api`.
```

## `docs/contributing/ai-review-patterns.md`

<!-- sha256: 01df4d3b9695b43ed5ae08b55d7c4ad7d85f73238313b56c0957b40a5c299ba1 -->
```markdown
> **Re-verified 2026-10-24 (#4372 part G, at dev `b79b112ec`), a full re-read.**
> Changed: *Inline Gate Placement* no longer names `EditAgentModal` as the
> canonical hoisted notice (#2331 removed it; `git grep OnchainActionNotice --
> packages/frontend/src` finds only `OnchainActionGate.tsx` and tests). The
> Tailwind fix names the shared preset `packages/ui/tailwind.preset.js`
> (#3508), where `boxShadow.card` and the `brand` colour now live. Two Safe
> leftovers became account and smart-account wording (#1440). No rule was
> added or weakened.
> Re-checked without change: the *Captain Self-Check Preflight* heading in
> `ai-agent-workflow.md` and the *Recurring traps* list in `reviewer.md`;
> `useActiveSigner`'s `address && walletClient` EOA rung (`lib/signer.ts`);
> #2413's notice deletion (PR #2460 removed `RetiredRailNotice.tsx`); the
> `#patterns` anchor in `design-system.md`; `design:lint`; the
> `focus-ring`, `shadow-token` and `compiled-colour-utilities` tests;
> `humanAmountToAtomic`, `formatTokenValue` and the `allowanceHumanAmount`
> pattern `^(0|[0-9]+\.[0-9]{2,6})$` (`openapi/spec.ts:332`); the coupling
> gate exiting 0 without `--strict` and `docs:coupling` being the `--strict`
> form CI runs (`docs-coupling.yml`); ship-next *Implement* step 5; the four
> 2026-10-20 PRs (#4131, #4133, #4144, #4145, all merged that day) and the
> five cited commits, each a commit of the PR it is listed under; the
> `SETTLEMENT_PENDING` negative case in `x402-hosted-mcp-signer.test.ts`.
> Not changed here: `reviewer.md:139` still names `EditAgentModal`, so the
> three lists this doc keeps in sync now disagree on that one item (see the
> PR's *Not filed* list).
```

## `docs/contributing/autonomous-pr-loop.md`

<!-- sha256: b5d55bc233715f273e3d2965bcfdde4c9e4f74a61c83e4d4ca59d3c9ecb225b6 -->
```markdown
   Re-verified **2026-10-13** (#3798): the strict flags, the required-check
   lists (15 on `dev`, 19 on `main`), the merge methods and the code-owner
   requirements are unchanged. Re-verified **2026-10-25** (#4372) with the same
   commands: three active rulesets; 16 required contexts on `dev` and 19 on
   `main`; strict only on *Dev gate*; squash only on `dev` and merge only on
   `main`; code-owner review on *Haven automerge rules* and *Dev gate*, not on
   *Dev merge*; PR ownership gate still not required. The 2026-10-09 authenticated read also shows
   `Dev gate` with **no bypass actors** (the admin-role `always` bypass lives
   only on *Haven automerge rules*) — see
   [`branch-and-release-flow.md`](../contributing/branch-and-release-flow.md) § *Promotion to
   production*.
   The `rules/branches/{main,dev}` form is the fastest way to re-check the
   effective branch rules without admin UI access: it reports each rule once per
   matching ruleset, which is the union above seen from the other side. Two
   rulesets match each branch, so both report `pull_request`, `deletion` and
   `non_fast_forward` twice. Since the External intake gate went on *Dev
   merge*, `required_status_checks` also comes back **twice** on each branch:
   on `dev` from *Haven automerge rules* and *Dev merge*, on `main` from that
   ruleset and *Dev gate*.
```

## `docs/contributing/branch-and-release-flow.md`

<!-- sha256: ad6d901192154a4eff6d0a2933150b0e44660ea77247dd4b392fcce833ec8658 -->
```markdown
> **Re-verified #4612 (2026-11-02, the contract-doc count drops from five to
> one):** coupled through `scripts/release-bump.mjs` and
> `scripts/release-version-constants.mjs`. The bump's printed next-steps block
> now says a release implicates ONE contract doc that needs action
> (`casp-risk-guardrails.md`, cleared by the CASP shard) instead of five, because
> the docs coupling gate partitions out a file whose entire diff is
> release-version constants. `release-version-constants.mjs` gains
> `DEDICATED_VERSION_CONSTANT_FILES` (`MCP_VERSION`) and
> `ALL_VERSION_CONSTANT_FILES`; `SOURCE_VERSION_CONSTANT_FILES` is unchanged, so
> the bump's generic writer loop is unchanged. No version, pin, channel,
> dist-tag, build order or credential path moves, and `release-bump.test.mjs` is
> 96/96. **Nothing in this document was made false or stale by that edit** — it
> describes the flow the bump sits in, not the bump's list of files.
> `last-verified` deliberately NOT bumped: this is a scoped check of two script
> edits, not a re-verification of the document, and #1366 rates a rubber-stamped
> date worse than a stale one.

> **Re-verification (#3819, 2026-10-09):** coupled through
> `.github/workflows/publish.yml`: the dependency-presence ledger inside the
> loop (`dep_state`) was rewritten from a bash-4 associative array
> (`declare -A`) to a space-delimited `pkg=state` string read by an
> exact-word `case` lookup, so the loop runs on bash 3.2 (stock macOS
> `/bin/bash`) without changing what it decides (#3819). The gate's
> behaviour is identical on every bash — the same packages are held back,
> marked FAILED and never nominated for `latest` — so no branch-flow,
> promotion-window, dev-gate/qa-freshness or credential claim in this
> document moves. Verified by `release-bump.test.mjs` (102/102), which runs
> the real loop shell on host bash 5 and in a real GNU bash 3.2.57
> container.

> **Re-verification (#3797, 2026-10-09):** coupled through
> `.github/workflows/publish.yml`, which gains a dependency-presence gate: a
> package whose exact-pinned internal `@haven_ai/*` dependency did not publish
> in the same run is held back and marked FAILED, never nominated for
> `latest`. The two `publish.yml` descriptions in this document were updated
> in the same pass; branch flow, the promotion window, dev-gate/qa-freshness
> requirements and every credential path are untouched. Verified by
> `release-bump.test.mjs` (102/102), which runs the real loop shell.

> **Re-verification (#3305):** coupled because `scripts/release-bump.mjs` is in
> its `covers:`. The bump gains one owned file, the client release data in
> `@haven_ai/core`, which it regenerates from the
> CHANGELOGs after stamping their headings. It refuses up front when that file
> was hand-edited, and skips both steps for a snapshot. The release still happens
> on a release branch into `dev` and publishes on the `dev → main` promotion, and
> no version, pin, channel, dist-tag, build order or credential path moves.
> Nothing in this document was made false by that change; it describes the flow
> the bump sits in, not the bump's list of files.

> **Re-verification (contract-doc count correction, 2026-09-17):** this doc is
> coupled because `scripts/release-bump.mjs` is in its `covers:` and that script
> was edited — its *printed* next-steps block said "the two contract docs" and
> enumerated two, while the docs had been corrected to three. Only operator-facing
> log strings and comments changed; no version, pin, channel, dist-tag, build
> order or credential path moves, and `release-bump.test.mjs` is 76/76.
> **Nothing in this document was made false or stale by that edit** — it carries
> no contract-doc count of its own, which is why it needed no content change.
> `last-verified` deliberately NOT bumped: this is a scoped check of one script
> edit, not a re-verification of the document, and #1366 rates a rubber-stamped
> date worse than a stale one.

> **Re-verification (#3303, 2026-09-25):** coupled again through
> `scripts/release-bump.mjs`, which gains one `SOURCE_VERSION_CONSTANTS` entry —
> the SDK's `SDK_VERSION`, rewritten and verified exactly like the four
> constants beside it. No branch, promotion, dist-tag,
> channel, build order or credential path moves, and this document names no
> source constant, so nothing in it was made stale. `last-verified` not bumped,
> for the reason in the note above.

> **Re-verification (#3361, 2026-09-26):** coupled through
> `scripts/ci/qa-freshness.mjs`, whose green-run query changes from "the newest
> 30 run-level successes" to "every run-level success created within twice
> `QA_FRESHNESS_HOURS`", with rows that cannot have run the harness dropped
> before the job lookup and the lookups budgeted. This document states only
> what `qa-freshness` requires — a green money-flow QA run covering the
> promoted money-path code, bypass `qa-override` — and that requirement is
> unchanged: the selector's rules, the freshness window and the coverage diff
> are untouched. The change finds real greens the old window missed, or
> refuses. In one narrow case it anchors differently at the same commit: when
> a better-provenance `deployment_status` run lies beyond twice the window, a
> younger admitted run at that commit (itself a passing money-flow run) is the
> one whose age is judged. Nothing here was made stale. `last-verified` not bumped,
> for the reason in the notes above.

> **Re-verification (#3368, 2026-09-26):** coupled through
> `scripts/ci/qa-freshness.mjs`, which loses a dead branch (the #1044
> step-level completeness warning, which could never fire while the Coverage
> completeness step fails its job) and gains precise refusals: a search cut
> short by the lookup budget is reported as such instead of "no run found",
> and an unusable `QA_FRESHNESS_HOURS` echoes the raw value. What
> `qa-freshness` requires — a green money-flow QA run covering the promoted
> money-path code, bypass `qa-override` — is unchanged, and every changed
> path still refuses. Nothing here was made stale. `last-verified` not bumped,
> for the reason in the notes above.

> **Re-verification (#3337, 2026-09-26):** coupled through
> `.github/workflows/dev-gate.yml`, where only a comment changes: the
> `qa-override` escape hatch is no longer described as a quarantine for "a
> wedged testnet flake" but by its documented rule (used only with a comment
> stating what was verified out-of-band; see agent-qa.md and dev-environment.md
> for the hotfix, stale-gate and red-run cases). The label,
> its warning and the gate are unchanged, and this document's "bypass is
> `qa-override`" still holds. `last-verified` not bumped, for the reason in the
> notes above.

> **Re-verification (release-bump constant table, 2026-09-29):** coupled through
> `scripts/release-bump.mjs`. The bump's table of self-reported version
> constants moved into `scripts/release-version-constants.mjs`, and its
> `SIGNER_VERSION` entry now names the signer's `tools.ts`, where #3454
> moved the declaration. Before this fix, the 0.7.0-alpha.0 cut died part-way
> through. The release still runs on a release branch into `dev` and publishes
> on the `dev → main` promotion. No step, gate or merge rule in this document
> moved.

> **Re-verified unchanged (#4371, 2026-10-23 — `publish.yml`'s invariant
> comment).** The comment over the dev-tag invariant in
> `.github/workflows/publish.yml` now says five enforcement places, matching the
> five it lists. Comment only: no job, trigger, branch rule or release step
> changes. Scope of this note: that comment. Nothing else in this document was
> re-verified.
```

## `docs/contributing/docs-quality-system.md`

<!-- sha256: 3c1c03a78fc2f8c9e3c2eaf8c80f0ed6af882875e8602241aa47b38bb20ff325 -->
```markdown
Re-verified 2026-10-24 (#4372 part D, at dev `f590d946c`). Changed: the
gates table gains the operator-verify close-keyword guard (a step of the
required *Docs front-matter & agent skills* job since #2276, on `edited` since
#2839); *Docs served to agents* says four docs (three product docs and the
security model) rather than four product docs, and records that
`served-docs.test.ts` forbids a literal `last-verified:` or `covers:` in a served
body; `covers:`
gains `scripts/ci/operator-verify-close-guard.mjs` for the new row. Re-checked
without change: every script the table names (`chain-integrity.mjs` absent, as
"Retired" says), the `docs:*` scripts, `docs.yml`'s unfiltered `pull_request`
trigger and its advisory lychee step, the Monday 06:00 UTC audit through
`standing-issue-upsert.mjs`, `doc-health.mjs`'s four flags, the
`doc-reviewer.md` custody rule (#4174), the required check names on `dev`,
`isGoverned()`, the three control globs, the `package-docs.mjs` sets, the
served-doc `ALLOWLIST` and its build wiring, the classifier's `--no-renames`
and `ALLOWLIST` import, and the four `scripts/docs/measure/` scripts.
```

## `docs/contributing/loop-engineering.md`

<!-- sha256: 1ed8639adb86a25eca1b100655e663a5e0afb66918a6f113660ce887078331f0 -->
```markdown
Re-verified 2026-10-24 (#4372 part D, at dev `f590d946c`). Changed: the
body's "Last updated" line, which predated the withdrawal edits below it, is
removed (`last-verified` carries the date), and §2's reference-model bullet
says the withdrawn allowance loops "used" one.
Re-checked without change: no `loop-harness/` directory is tracked (`git
ls-files | grep loop-harness/` is empty), no package defines `test:loop`,
`loop-harness-index.md` says none is live (LP-2 withdrawn, #2848), #2020 and
#2848 are closed, #1024 removed the money-path merge pause, and the linked
`autonomous-pr-loop.md`, `ai-agent-workflow.md` and the quality-scan
`discovery-method.md` exist.
```

## `docs/contributing/pr-workflow-checklist.md`

<!-- sha256: 04bd18a58e689b48d222807ca5f13dd06c6dfc56638e0825f94bec8e7732c190 -->
```markdown
> **Re-verified 2026-10-24 (#4372 part G, at dev `b79b112ec`), a full re-read.**
> Changed: the backend gate count is 39, not 36 (the snippet above prints
> `39 11`; the raw-string variant still prints 9 and the whole-document
> variant 12). `qa-agent` has had a CI job since #3005 (*QA agent checks*),
> so "not one" was wrong. The docs row names all five `docs:check` steps.
> The payment row says "account or signer setup" for the retired Safe term.
> `guard-freshness.yml` is push-driven with a weekly floor, so the two guards
> are no longer both called scheduled.
> Re-checked without change: `dev-gate.yml`'s `dev`/`hotfix/*` rule; the
> three active rulesets (`gh api …/rulesets`): *Haven automerge rules* on
> `main` and `dev`, with the 15 required checks (*Banned product-copy terms*
> and *Design-system coupling (strict)* among them), strict policy off and
> code-owner review required; *Dev gate* on `main`, requiring `gate`,
> `qa-freshness`, *Design visual regression* and *Frontend browser smoke*,
> strict policy on and code-owner review required; and *Dev merge* on `dev`,
> requiring *External intake gate* (#4200), strict policy off and no
> code-owner review of its own;
> `CODEOWNERS` on migrations; every npm script the doc names; the preflight
> flags and exit codes 0/1/2/3 and `PREFLIGHT_SILENCE_MS`; the CI jobs that
> run `lint:next-steps`, `lint:vocabulary`, `lint:runbook-parity`,
> `design:lint` and the backend ratchets; the classifier's CLAUDE.md,
> `frontend/public`, allowlist and `docs/exit/README.md` arms and
> `--no-renames`; the ten-package `build` chain; the dependency lint with no
> baseline; the *Update visual baselines* `mode` default `changed`, the
> *Baseline change audit* and `baseline-before-after` artifact, and
> `BASELINE_PUSH_TOKEN` absent from `gh secret list` (which lists 12 others);
> `verify-merged-head.mjs` taking a PR number; the coupling gate's #2323
> section heading and its exit 0 without `--strict`; the `ui-gate-wording`
> baseline's one sentence in `ship-playbooks/frontend.md`; the anchors into
> `ship-playbooks/frontend.md`, `ship-next` and `autonomous-pr-loop.md`.
```

## `docs/contributing/ship-playbooks/backend.md`

<!-- sha256: bc19e5e54490283dea865e2baefba4c353c1d1c1e3fd3c36ee4a7658ed4b88e3 -->
```markdown
Re-verified 2026-09-30 (weekly docs audit #3413, at dev `5b5bd059`). One
reference needed fixing: the response-shape bullet named
`openapi/response-shape.js`; the module has been `response-shape.ts` since it
landed (#1460, 2026-08-15) — a stale extension, not a moved file. Everything
else re-checked at this head: `spec.test.ts`, `route-coverage.ts` /
`route-coverage.test.ts` (both `KNOWN_UNDOCUMENTED_ROUTES` and
`UNDOCUMENTED_MODULES` present), `route-modules.generated.ts` and the
`generate:`/`check:route-modules` scripts, `generate:api-types` +
`check:api-types`, `scripts/db-schema-smoke.ts` with the `db:schema-smoke`
script, `migrate.ts`'s `transactional = false` / `nonTransactionalReason`
opt-out, `.github/money-path-globs.json` (still the CI-enforced perimeter the
money-path bullet points at instead of copying), the dep-lint bullet's
machinery (re-verified in depth under `10-module-boundaries.md` this audit),
and the openapi/ commits since the last verification (#3479, #3461, #3471,
#3469, #3470, #3444, #3452, #3453) each carried their spec/route-module
regeneration with the code, which is exactly the workflow this playbook
prescribes.

Re-verified 2026-10-24 (#4372 part D, at dev `f590d946c`). Changed: the
query-mock bullet's example fragment named `agent_allowances`, a table
migration `075_drop_inert_safe_rail_schema.ts` dropped; it now names
`agent_delegations`, and the bullet states the `lint:db-mocks` ratchet
(`scripts/db-mock-ratchet.mjs`, run in *Backend checks*) and the real-Postgres
harness; both join `covers:`. Re-checked without change: the seven `AGENT_PAYMENT_ROUTE_FILES` in
`spec.test.ts`, `route-coverage.test.ts` deriving its scope from
`registeredRouteModules()`, both lists under ceilings of 1
(`MAX_UNDOCUMENTED_ROUTES`, `MAX_UNDOCUMENTED_MODULES`), `expectMatchesSpec`
in `response-shape.ts`, `openapi/__tests__/route-modules.generated.test.ts` and
the `generate:`/`check:route-modules` and `generate:`/`check:api-types` scripts
(`check:api-types` runs in CI), `db:schema-smoke`, `migrate.ts`'s
`transactional = false` / `nonTransactionalReason` and its `'running'` row,
`createIndexConcurrently()` in `db/concurrent-index.ts`, the money-path globs'
examples and `money-path.test.mjs`'s labeler and perimeter-doc checks, and
`dep-lint.mjs` (`UNWAIVABLE_RULES` = `no-circular`, the 20-character reason
floor, `--update-ceiling` refusing to raise).
```

## `docs/contributing/ship-playbooks/docs.md`

<!-- sha256: a07558768a92ad45dbf2cfebb3d7a9ed8b58b23d51535da762b3746631841888 -->
```markdown
> **Re-verified 2026-10-24 (#4372 part F, at dev `6d87ddf95`), a full re-read.**
> Changed: the front-matter line names the one exemption `docs:check` makes —
> the CASP changelog shards (`scripts/docs/validate-frontmatter.mjs`,
> `docFilesFrom`, #1366). Re-checked without change: the `docs:check`,
> `docs:test` and `docs:coupling` scripts (`package.json`; the bare
> `coupling-gate.mjs` exits 0, `--strict` is the CI form), the ship-next
> Acceptance Gate, Independent Review and Rework caps (#2163) anchors, the
> #4174 custody carve-out, #2323, #2681, #2499, and the Monday weekly audit
> (`.github/workflows/docs-audit.yml`).
>
> **Review round 1 (haven-doc-reviewer @ `344d7ea91`).** The front-matter
> line is reworded so it cannot read as exempting the gravity files: they
> carry front matter (`AGENTS.md`, `CLAUDE.md`; `validate-frontmatter.mjs`
> checks them), and only the shards are exempt.
```

## `docs/contributing/ship-playbooks/frontend.md`

<!-- sha256: eca8c0552b1b37b232d6b797ff1686d4eba4c767591ff8e7360e13bf2770e518 -->
```markdown
Re-verified 2026-10-24 (#4372 part D, at dev `f590d946c`). Changed:
- **Primitives.** 18 live in `packages/ui/src` (16 moved by #3508, `BackLink` and `Tabs` added there since), and 17 have a re-export shim in `components/ui`. Modal, SidePanel, the charts and the list controls are among those still in `components/ui`.
- **Inline `@/lib/api` mocks.** The count is now 56 of 60 files, re-measured.
- **`toHaveCount(1)`.** The count is now 229 across 22 visual specs, 24 of them in `design-system.visual.spec.ts`.
- **Required checks.** The pixel gate and *Frontend browser smoke* are described as required on `main` (the *Dev gate* ruleset) and advisory on `dev`, as the rulesets say, wherever the doc calls them blocking or gating.
- **Coverage grades.** These now name the whole-page baselines `product-routes.visual.spec.ts` and seven other specs commit (agent detail, `/accounts`, mobile `/agents`, `/contacts`). `/dashboard` and `/transactions` are no longer called the only ones.
- **#2331 retirements.** The chain-read harness paragraphs (#1935 `chain()`, #2106 silent routes, `makeAllowanceChainFixture`, `SCREENSHOT_CHAIN_STALL_MS`, `CHAIN_SILENT_CAPTURES`, `UnmanagedDelegateCard`) are marked as retired by #2331, and `AllowanceBarSkeleton` as deleted by #2848.
- **`usePortfolio` residual risk.** This is now marked closed by #2732.
- **#1801.** This is now marked closed.
- **`/investor-briefing`.** This example is replaced (removed by #2468).
- **`shoot()` and `ui/Modal` references.** The `shoot()` call-site counts and the `ui/Modal` line references are updated.
- **Required contexts.** The count on `dev` is updated to 16.
- **Wire-type baseline.** This is now 11 shapes in 6 files.
- **The two product-route rejections.** These are marked superseded.
- **The 500-pixel budget.** This is now attributed to the removed whole-page capture.
- **Review round 1.**
  - `ui/Modal` is cited at `packages/frontend/src/components/ui/Modal.tsx:205`/`:259`.
  - The `shoot()` dialog count is 36 `getByRole('dialog')` locators.
  - The design-system coupling scope names `packages/ui/src/**`.
  - The viewport override's gate consumers are counted (24 e2e files import `VIEWPORTS`; only `screenshot.mjs` resolves the override).
  - Driven-spec rule (5) is in the past tense about `canUseWalletActions`/`isDelegationAgent` and the legacy-agent fixture, and counts `mockHavenApi` callers (59).
  - The product-route rejections are rewritten in the past tense, with #2817 as the `/accounts` supersession and the current `haven-api.ts:1360`/`:1388` anchors; "Fix #2225 in both fixtures first" is dropped.
  - The auto-merge note names the *Dev gate* ruleset.

Re-checked without change:
- the `test:local` constants (86/87, 5 min / 30 min);
- Playwright 1.60.0's Desktop Chrome and Pixel 5 numbers;
- `SUITE_IGNORE`, `evidence-viewports.mjs` (1280/390) and the `:built` and `test:visual*` scripts;
- the capture-identity and e2e port ranges (3111–3230, 3300–3419);
- the readiness budgets;
- retention (`DEFAULT_KEEP_RUNS = 3`);
- the content floors (30/6, 30 s);
- `CLIP_TOLERANCE_PX`, `THEME_STORAGE_KEY` and `SEED_STORAGE_KEYS`;
- the onramp placeholder wiring;
- the baseline-verdict-gate line format and scope;
- `vitest.config.ts` setting no `pool`/`maxWorkers`/`testTimeout`/`isolate`;
- the copy lint's scan directories.

Re-verified 2026-11-02 (weekly docs audit #4605, at dev `fc8ac1eb6`). Changed:
the primitive count is 19, not 18 — `Spinner` joined `packages/ui/src` with
#4563/#4588, and it has no `components/ui` shim, so the shim count stays 17.
Re-checked without change: the `test:local` wrapper and its 86/87 stall/cap
codes; the `test:e2e:*` and `test:visual*` scripts and what each selects; the
`chromium-desktop-dark` project and its `testMatch`; the onramp placeholder
wiring (`NEXT_PUBLIC_COINBASE_ONRAMP_APP_ID` in `ReceiveDialog.tsx`, set by
`test:visual:structure` and `test:e2e:gate:built`); the capture-identity and
e2e port ranges; the readiness budgets; retention (`DEFAULT_KEEP_RUNS = 3`);
the content floors; `CLIP_TOLERANCE_PX`; the baseline-verdict-gate line format
and scope; the copy lint's scan directories; and the workflows the doc names
(`docs.yml`, `docs-coupling.yml`, `design-system-coupling.yml`,
`frontend-copy-lint.yml`, `update-visual-baselines.yml`,
`baseline-verdict-gate.yml`). The week's UI sweep (#4562–#4603) moved screens
and baselines, not the gates or commands this playbook states.
```

## `docs/contributing/ship-playbooks/README.md`

<!-- sha256: eeb6e4d48304b8f4e231b353c279ff01f317cf6c4e8409c68b5f54304e8b0c75 -->
```markdown
Re-verified 2026-10-24 (#4372 part D, at dev `f590d946c`): read end to end,
nothing changed. Checked: the five playbook files exist; `ship-next`'s
*Prepare* section routes `area:frontend`, `area:backend`, `area:sdk`/`area:mcp`,
`area:docs` and `money-path` to them; `.github/workflows/labeler.yml` runs
`actions/labeler` with `sync-labels: false`; `.github/labels.yml` and its sync
workflow exist; `.github/CODEOWNERS`' single-star migrations pattern does not
reach `__tests__/`; #651, #1024 and #1025 are closed.
```

## `docs/contributing/ship-playbooks/sdk.md`

<!-- sha256: fbacd17081a2528b80a6122fbadfccf6e2b54b0b3bcd9960912d410e97bc1a15 -->
```markdown
Re-verified 2026-09-21 (weekly docs audit #3206, at dev `7f17c9f3`): the
published-package set (`@haven_ai/{sdk,signer,mcp,connect,cli}`), the internal
pin rule's both directions as enforced by `npm run lint:workspace-pins`, the
`smoke:pack` script, and the release tooling names above are unchanged at this
head. The intervening package commits (#3134 vocabulary convergence, #3173
`@haven_ai/sdk/edge` split, #3155 the x402 MCP transport profile) changed
package internals, not anything this playbook claims about process.

Re-verified 2026-10-07 (weekly docs audit #3645, at dev `009bd611`): §§1–5
re-read. The private-consumer list in § Versioning gains `ops` (#3570), which
`npm run lint:workspace-pins` already enforces by its `private: true` field.
Everything else above is unchanged at this head.

Re-verified 2026-10-24 (#4372 part D, at dev `f590d946c`): §§1–5 re-read,
nothing changed. Checked: `scripts/README.md` and `scripts/release-bump.mjs`;
`smoke:pack` in `packages/connect`; `lint:workspace-pins`; the five published packages pin exact
internal versions and the private consumers (backend, frontend, ops, qa-agent,
mcp-server) pin `"*"`; `release-bump` and `publish.yml` are on the
money-path globs; `.github/CODEOWNERS` gates only
`packages/backend/src/db/migrations/*.ts`, and *Haven automerge rules* (on `dev`
and `main`) and *Dev gate* (on `main`) both require code-owner review.
```

## `docs/contributing/x402-mpp-consolidation.md`

<!-- sha256: 0f32cdf3784cc863fa07004cbab846742b0e754f90aaebf3efb843451eb41ec9 -->
```markdown
Re-verified 2026-10-24 (#4372 part D, at dev `f590d946c`). Changed: the
intro and *Coverage strategies* now speak of `decideCoverage` in the past
tense (deleted by #1987, with its two strategies), the #1328 section no longer
calls the "Allowance-only" strategy live, a "below" that pointed at the
paragraph above now says "above", and (review round 1) the paragraph after
*Coverage strategies* states the legacy branch and the delegation rail's lack
of a coverage step in the past tense. Re-checked without change:
`insertMachineIntent` in `infra/repositories/payment-intents.ts`, called with
`executionRail: 'delegation'` from `modules/x402/delegation-authorize.ts`;
`resolvePaymentToken` in `domain/payment-token.ts`; the deleted files
(`domain/payment-coverage.ts`, `infra/repositories/approval-requests.ts`,
`modules/mpp/authorize.ts`, `routes/demo-mpp.ts`, `routes/x402-resources.ts`);
`POST /machine-payments/authorize` answering through `mppDemoRetired()` in
`routes/machine-payments.ts`; and #830, #834, #1328, #1986, #1987, #2055 and
#2257, all closed.
```

## `docs/operations/accounting-feed.md`

<!-- sha256: fe4ed79b1377f0ea168bad23ccd0aefa921a18521cb6b13e84fa21dd1a6278d1 -->
```markdown
> **Re-verified 2026-10-24 (#4372 part E, at dev `ee7fdd27`), a full re-read.**
> Changed: the intro, the flow diagram and the providers row now say two
> connectors are live (Fortnox and Accounted, live since #3017, `registry.ts`);
> the `api-key` row lists the route's real answers (`accounting-connections.ts`
> and `registry.ts`'s `ProviderNotConnectableError`) instead of "no live
> `api_key` provider today → 409"; the Transactions badge says *Evidence
> archived* for a pushed Accounted row and the *Check in* action names the
> row's provider, a read-back only on Fortnox (`AccountingBadge.tsx`
> `RECORD_ONLY_PROVIDERS`, `en.ts`), and on the ledger row it is the pill
> alone since #4298, its link and reason living in the detail panel
> (`TransactionsLedgerRow.tsx`, `TransactionDetailPanel.tsx`); the
> `pushed` row names Accounted's `external_ref` shape; the Settings card's
> fail-closed guard no longer reads as waiting on #2918 (closed); the seller
> block says the `Merchant` line always renders (`receipt-underlag.ts`); and
> the Accounted slice-1 paragraph is in the past tense, with `revoke` a no-op.
> Re-checked without change: the configuration table, party identity, the
> settlement-side reasons table, the off-state table, every other route row,
> connection and sync states, ledger currency, feed-from/backfill/settings,
> the retry sweep's constants (`retry-sweep.ts`: 25 requests / 5 s, 8 per
> push, batch 200), the booked-hash section, ops signals, secrets at rest
> (`CURRENT_KEY_VERSION = 1`), the schema section, and both provider notes.
> A sweep of the doc's backticked identifiers against `packages/` matched all
> of them except the Accounted webhook API's own field and scope names, which
> are the provider's, not this repo's.

> **Re-verified #3093 (frontend hooks: wire keys default instead of crashing):**
> this diff touched `hooks/useAccounting.ts`, in this document's coverage list, by
> defaulting the array keys it stores (`?? []`) so an API answer without the key degrades to an empty state instead
> of sending the route into the ErrorBoundary. No endpoint, flow or
> behaviour this document describes changes. Scope of this note: those
> expressions. Nothing else in this document was re-verified.

> **Re-verified #4497 (2026-10-29, production enabled).** Changed: the
> Configuration table's prod column now reads `HAVEN_ACCOUNTING_ENABLED=true`,
> mode `all`, `HAVEN_SECRETS_KEY` set, and `FORTNOX_*` with the client id and
> secret set (the dev app's) but the redirect URI unset; the two-off-states
> section now says the flag-off state describes a deployment that switched the
> feed off, not either of Haven's two deployments; the ledger-currency
> blockquote keeps "no production connection is non-SEK" and rewords its
> "ahead of its first user" reasoning, because production has Accounted
> connections that book in SEK by the default; the key-rotation follow-on is
> due now rather than with #2876; and the verify-call paragraph records that a
> first-attempt `RATE_LIMITED` on two of the three subscriptions is expected
> and self-heals on the provider's retry. Re-checked against the measured prod
> state of 2026-10-29 (feed status for two accounts, the providers list, the
> 503 on the Fortnox connect-url, one connected Accounted destination with
> `base_currency` null, three verified subscriptions) and against the code
> claims the changed sentences rest on. Nothing else in this document was
> re-verified, and `last-verified` is not bumped.

> **Re-verified #4532 (2026-10-29, receipt transaction kind).** Added: the
> "What kind of transaction it is" block under *What the accountant sees on the
> attachment* — the closed enum, the derivation ladder, the three pinned
> Bitrefill routes, and where each connector carries the fields. Changed: the
> Fortnox provider note's description of the `Comments` field now names the
> description part and its `/` → `-` fold. Re-checked against
> `modules/accounting/transaction-kind.ts`, `entry.ts`, `feed-transaction.ts`,
> `receipt-underlag.ts`, `fortnox-connector.ts` and `accounted-connector.ts`.
> Nothing else in this document was re-verified, and `last-verified` is not
> bumped.

> **Re-verified #4578 (2026-10-30, direct payments classify as transfers).**
> Changed: the "What kind of transaction it is" block under *What the
> accountant sees on the attachment* — the derivation ladder gains a rung 2
> (the direct-payment rail, emitted as a literal by the entry source's direct
> branch) and the later rungs renumber to 3-6; the `unknown` sentence now says
> a direct payment renders `transfer` with its counterparty's canonical
> address as the `Description` label. Re-checked against
> `modules/accounting/transaction-kind.ts`, `entry.ts` and
> `receipt-underlag.ts`, and against the real-DB suite
> `direct-payment-feed.db.test.ts`. Nothing else in this document was
> re-verified, and `last-verified` is not bumped.
```

## `docs/operations/agent-qa.md`

<!-- sha256: 9cb474f0e9c4274ab4b9dc32dccb3d770362133e27f3e175d754444495d2dec2 -->
```markdown
  > **Re-verified #3321 (2026-09-30):** the guard-freshness listing-coherence
  > / page-1 retry passage only; nothing else in this document was
  > re-verified.

> **Re-verified 2026-10-24 (#4372 part F, at dev `6d87ddf95`), a full re-read.**
> Changed: the scenario table now follows `SCENARIOS` in
> `packages/qa-agent/src/run.ts` (the text says "in order"), and
> `x402-erc7710-hosted` names its two sibling legs instead of "the two legs
> above"; the sweep fixture spends 0.0005 USDC, not 0.001 (`storage_50gb`'s
> `price_usdc: 500n`); an unconfigured `x402-delegation-3009` skip fails the
> run under `QA_REQUIRE_ALL_LEGS=1`, which is set; the 3009 legs run live
> (qa-dev run 40048064262 passed all three); the wire-contract test pins v2
> only, v1 retired by #3272; #2268 closed on 2026-09-02; the exploratory
> prompt's within-budget step names the hosted tools beside the local
> `haven_pay_x402`; the dev relayer does not sponsor UserOps (#3264).
> Re-checked without change: every file path and `npm run` script the
> document names, the seed's routes and reuse rules, the preflight floors
> (`TREASURY_RUN_COST_ATOMIC`, `MIN_SETTLEMENT_HEADROOM_FAIL`/`_WARN`), the
> merchant's `/healthz` and 503 bodies, the #4119 record check and its
> 45 s / 60 s / 120 s timings, the qa-dev and qa-balances workflows (secrets,
> variables, cron, concurrency, the green-close step), the balance and faucet
> constants, the freshness gate and guard constants, the window line's
> budgets, the failure classifier's signatures, the sign-failure codes and
> their 300-character bound, `SWEEP_MIN_USDC`, the merchant session TTL and
> #3171 data, the RPC probe flags and the observer's 10-block range, and all
> 137 cited issues with `gh api` (#3933 and #4215 are open, `landed-partial`;
> the text describes their shipped parts).
>
> **Review round 1 (haven-doc-reviewer @ `344d7ea91`).** Also changed:
> `x402-erc7710-sdk` names `x402-erc7710-settle` rather than "the leg above",
> and its hosted variant is `x402-erc7710-hosted` (#1456 is closed); the
> post-deploy trigger's history is no longer "exactly one deploy" (2,685
> `deployment_status` runs created 2026-10-01 → 10-23, 0 to 265 a day, from
> per-day `created=` counts; rounds 2 and 3 corrected an earlier 2500, the
> filtered listing's cap, and a "hundreds a day" drawn from one peak day); the 3009 scenarios run in every `qa-dev` money-flow job, not
> every run; the dev relayer deploys the treasury at first activation and a
> fresh agent's delegate account at its first erc7710 authorize; #2268 is the
> issue that reported the old trigger never fired; and two stale conditionals
> found re-scanning for the same class — the catalog leg is no longer "NEW",
> and #3171 is deployed (dev's demo merchant answers an unknown session with
> its data, probed 2026-10-24).
```

## `docs/operations/delegation-rail-vendor-ops.md`

<!-- sha256: d3cd98e92b2ac006e27bc4ac8a2e1aeb0114e50b4d8dd72279ad4bbae90308c0 -->
```markdown
> **Re-verified 2026-10-24 (#4372 part F, at dev `6d87ddf95`), a full re-read.**
> Changed: the relayer bullet names the two deploys — the treasury at grant
> activation (`ensureHybridDeployed`) and the agent's delegate Hybrid at its
> first erc7710 authorize (`ensureDelegateHybridDeployed`, #4023) — instead
> of one "delegator/treasury" deploy, and the blast-radius lines follow; the
> `SESSION_RAIL_*` variables are read nowhere, not "except the probe"; the
> pinned set has 9 enforcers (the `redeemer`, #1058), not 8; the SDK is
> pinned by the lockfile, its `package.json` ranges are `^1.6.0`; #830 is
> closed. Re-checked without change: the 502 and 429 deploy answers
> (`modules/x402/delegation-authorize.ts`), `max_x402_per_hour` default 100
> with replays exempt, the per-chain resolver and its chain guard
> (`delegationRailBundlerUrl`), the typed 503 on `/payments` and the funding
> leg, `prepare_failed` (#3609) and the hosted MCP mapping, the #3371 RPC
> scrub, every consumer passing `DELEGATION_RAIL_SPONSORSHIP_POLICY_ID`, the
> 120 s deploy and attest waits (#1722, #1735), the bump worker's three log
> lines and its cap of 3, the rebroadcast-safe set, migration 061's partial
> index, the `ops:cancel-stuck-*` scripts and their built form in the
> `--omit=dev` image, the probes' exit codes and `CHECK_BUNDLER_CHAIN_ID`,
> the #908 mainnet pins, and `dependency-parity.test.ts`. Every cited issue
> was read with `gh api`; all are closed.
```

## `docs/operations/demo-agent-purchase-runbook.md`

<!-- sha256: 025b7aaf77a52b7e6d365804cef45263e92b4e721a320dc9073bd829f1897190 -->
```markdown
Re-verified 2026-10-24 (#4372 part E, at dev `ee7fdd27`), a full re-read.
Changed: Act 0's Fortnox connect is in Settings → Business since #4358, its
check is `/accounting` or `GET /accounting/feed/status` (there is no
`/fortnox/status` route), and the fallback script is a backend workspace script;
Act 1 names `haven_prepare_catalog_purchase` and `haven_settle_mcp_tool`; Act 2
shows a funding tx only on the EIP-3009 bridge; Act 3's refusal is the
off-chain `403 delegation_budget_exceeded` pre-check (#3503) and the revoke
answer is a `403` with the "no active budget delegation" message and no
`error_code` (`routes/payments.ts`; `no_delegation_for_target` is only the
ledger reason); Act 4A pushes through the live feed, not the legacy voucher
route; Act 5's out-of-gas `MERCHANT_NOT_READY` comes from the quote step that
`haven_quote_mcp_tool`, `haven_pay_mcp_tool` and both catalog tools share
(`quoteMcpToolCall`, defined with the refusal in
`tools/support/mcp-context.ts` and called from `catalog-purchase.ts`), so it
names `haven_prepare_catalog_purchase` first (review round 1 on #4386); Act
2's erc7710 condition is the merchant's `MERCHANT_ERC7710_DELEGATION_MANAGER`
pin plus its settlement-method list (`demo-merchant-mcp/src/index.ts`,
`resolveErc7710Config`; review round 2).
Re-checked without change: the connector-package handout, the SIE flag and
export route (`routes/accounting.ts`, 410 otherwise), the `storage_50gb`
skip-settle fixture, and the rehearsal list.
```

## `docs/operations/dev-environment.md`

<!-- sha256: c3ede555966ea559dd38140a16510feac7276c6946b843ae23bb87934aa06b0a -->
```markdown
> **Re-verified #4612 (2026-11-02, the version-only partition gains a constant
> set):** the one covered file this diff touches is `scripts/ci/qa-freshness.mjs`.
> `isVersionOnlyDiff` and `partitionVersionOnly` gain an optional `constants`
> argument naming the `export const <NAME>_VERSION` set to recognise; the default
> is the same two constants this gate has always used, so every existing caller
> and every decision this document describes are unchanged. The wider set is
> passed only by the docs coupling gate, which partitions files this gate never
> looks at. No env variable, port, service, workflow or freshness threshold
> moves. Nothing else in this document was re-verified, and `last-verified` is
> not bumped.

> **Re-verified #4570 (2026-10-31, British spelling in the organisations copy):**
> this diff touched one file in this document's coverage list,
> `packages/frontend/src/hooks/useOrganizations.ts`. The change is one
> user-facing string: the fetch-failure message now reads "We could not load
> your organisations. Try again in a moment." (British spelling, owner decision
> 2026-10-30). The hook's shape, its `GET /organizations` call, its error state
> and its CRUD calls are unchanged, and no env variable, port, service or
> workflow moves. Nothing else in this document was re-verified, and
> `last-verified` is not bumped.

> **Re-verified #4407 (2026-10-25, the catalog ingestion cooldown):** this
> diff touched one file in this document's coverage list,
> `packages/backend/src/index.ts`. The catalog ingestion tick now
> calls a monitor built once at boot (`createCatalogIngestMonitor`) instead
> of `runCatalogIngestTick()`; the leader lock, the 5-minute interval and the
> alert delivery are unchanged. No env variable, port, service or workflow
> moves. Nothing else in this document was re-verified, and `last-verified`
> is not bumped.

> **Re-verified #4327 (2026-10-23, the agent Activity ledger export):** this
> diff touched one file in this document's coverage list,
> `packages/backend/src/openapi/route-modules.generated.ts`, and none of this
> document's mode/rollback/env semantics. The map gains exactly one
> operation — `GET /agent-activity/{id}/activity/export.csv` →
> `routes/agent-activity.ts`, which is already an enforced module
> (`index.ts`'s `enforcedModules`). No route file is added or moved,
> `enforcedModules` is untouched, and `.env.dev.example` gains no variable.
> Nothing else in this document was re-verified, and `last-verified` is not
> bumped.

> **Re-verified #4319 (2026-10-23, the EIP-3009 receipt-attribution flag):**
> this diff touched one file in this document's coverage list,
> `packages/backend/src/config.ts`. The change adds one entry to the `config`
> object — `eip3009ReceiptAttribution`, read through `parseBooleanFlag` from a
> NEW env scalar, `HAVEN_EIP3009_RECEIPT_ATTRIBUTION`. It follows the family's
> standing rules this document already describes: unset/empty reads `false`
> (the flag ships off, per the issue's rollout order — merge → dev dry run →
> dev write → dev flag → prod), an unrecognised value refuses the boot
> (#3015), and the flag is documented in `.env.example` beside its siblings.
> No env variable this document names is renamed, re-read, or re-typed; no
> dev-environment surface (ports, services, workflow env plumbing) moves.
> Scope of this note: the one new flag and its env scalar. Nothing else in
> this document was re-verified, and `last-verified` already reads 2026-10-23
> and is left as is.

> **Re-verified #4307 (2026-10-23, Receive dialog QR chrome):** this diff
> touched one file in this document's coverage list,
> `packages/frontend/src/components/ReceiveDialog.tsx`. The change is
> presentational: the visible "QR code for 0x…" caption under the QR image is
> removed — the `<img>` alt text is unchanged and still names the code for
> screen readers, and the address and the Copy button below still say what it
> holds — and the QR image loses its inner `border` (the rounded frame box
> that wraps it remains); the now-unused `truncate` import goes with the
> caption. The claim § `NEXT_PUBLIC_COINBASE_ONRAMP_APP_ID` in the Playwright
> builds makes about this file is unchanged: the id is still read at module
> scope (`const ONRAMP_APP_ID = process.env.NEXT_PUBLIC_COINBASE_ONRAMP_APP_ID`),
> so the build-time gate and every CI surface that sets the literal behave
> exactly as written. Nothing else in this document was re-verified, and
> `last-verified` already reads 2026-10-23 and is left as is.

> **Re-verified #4192 (2026-10-21, ignore-step tests: event-loop yield and
> real git):** this diff touched two files in this document's coverage list,
> `scripts/vercel/ignore-build-harness.mjs` and
> `packages/frontend/src/lib/__tests__/vercel-ignore-build.test.ts`. The
> harness gains `yieldToEventLoop`, which both ignore-step test files register
> as an `afterEach`. The harness spawns git synchronously, so without it a file
> that runs longer than 60 s blocks the vitest worker's event loop past the
> 60 s timer of its `onTaskUpdate` RPC. vitest then reports an unhandled error
> and exits 1 although every test passed. On macOS the harness also resolves
> the real git once (`xcrun -f git`) and puts its directory first on PATH,
> skipping the slow `/usr/bin/git` shim; elsewhere it spawns plain `git` as
> before. No assertion, watched path or script behaviour changed, and the
> claims this document makes about the step and its test stand as written.
> Nothing else in this document was re-verified, and `last-verified` is not
> bumped.

> **Re-verified #4167 (2026-10-20, Receive dialog clean-up):** this diff
> touched one file in this document's coverage list,
> `packages/frontend/src/components/ReceiveDialog.tsx`. The change is present-
> tational — the #4094 dialog loses its old Deposit-address chrome (the
> "On-chain receive" chip, the "Show QR code" toggle in favour of an inline
> QR, the "View on explorer" button, the "Before you send" box), gains an
> account picker when the caller offers several accounts, and the dashboard
> money card follows #4167's one primary-button rule. The claim §
> `NEXT_PUBLIC_COINBASE_ONRAMP_APP_ID` in the Playwright builds makes about
> this file is unchanged: the id is still read at module scope
> (`process.env.NEXT_PUBLIC_COINBASE_ONRAMP_APP_ID`), so the build-time gate
> and every CI surface that sets the literal behave exactly as written.
> #1844/#3478 gating is untouched. Nothing else in this document was
> re-verified, and `last-verified` is not bumped.

> **Re-verified #4118 (2026-10-20, `eth_getLogs` probe line):** this diff
> touched one file in this document's coverage list,
> `scripts/ci/rpc-conformance.mjs`, which gains a sixth check (`eth_getLogs`
> over the last 500 blocks) and the `--logs-range` flag. The edits are the
> probe step in § *Two Base Sepolia RPCs* (the new line, why 500, the QA
> observer's `--logs-range 10`) and the provider table's new `--logs-range`
> column. Nothing else in this document was re-verified, and `last-verified`
> is not bumped.

> **Re-verified #3913 (2026-10-19, after the toggle):** only the sentence in
> § *PR previews are opt-in* about the haven-ops skip setting changed. It now
> says the setting was seen **Enabled** on haven-ops in the dashboard and
> turned off on 2026-10-15, and that the records stopped (measured on #3913).
> The frontend's value is still inferred from its records. Nothing else
> in this document was re-verified, and `last-verified` is not bumped.

> **Re-verified #3913 (2026-10-13, Vercel skip-setting doc corrections):** the
> edits are the "Skipped - Not affected" sentences in *Which pushes rebuild the
> frontend* and § *PR previews are opt-in* — the frontend has never recorded
> such a deployment, the records belong to haven-ops, and they came from the
> per-project Vercel setting named in the diff with required value **off**
> (per #3913's GitHub deployment-records census; inferred, dashboard
> unchecked; superseded for haven-ops by the 2026-10-19 note above). Nothing else in this document was re-verified, and
> `last-verified` is not bumped.

> **Re-verified #3825 (2026-10-09, `GET /user/signers`):** this diff touched
> one file in this document's coverage list,
> `packages/backend/src/openapi/route-modules.generated.ts`, and none of this
> document's mode/rollback/env semantics. The map gains exactly one operation —
> `GET /user/signers` → `routes/user.ts`, the owner-scoped read that lists a
> user's signers once across their accounts. `routes/user.ts` is already an
> enforced module, no route file is added or moved, `enforcedModules` is
> untouched, and `.env.dev.example` gains no variable. Nothing else in this
> document was re-verified, and `last-verified` is not bumped.

> **Re-verified #3821 (2026-10-09, opt-in frontend previews):** the frontend
> project now deploys only `dev`, `main` and `preview/*` branches
> (`git.deploymentEnabled` in `packages/frontend/vercel.json`). This note's
> edits are the per-PR-preview statements: the intro, the topology row, the
> URLs entry, *Which pushes rebuild the frontend*, *Inspecting the dev
> environment*, and the new § *PR previews are opt-in*. Nothing else in this document was re-verified.

> **Re-verified #3770 (2026-10-08, delivery-quality report):** this diff
> touched one file in this document's coverage list,
> `packages/backend/src/openapi/route-modules.generated.ts`, and none of this
> document's mode/rollback/env semantics. The map gains exactly one operation —
> `POST /machine-payments/{id}/delivery-quality` → `routes/machine-payments.ts`
> — the agent's evidence-only verdict on what a settled payment DELIVERED
> (#3770): it writes to the new `machine_payment_delivery_reports` table only,
> never touches `payment_intents`, and is agent-scoped like the evidence
> attach path. No route file is added or moved, `enforcedModules` is untouched
> (`routes/machine-payments.ts` is already money-path), and `.env.dev.example`
> gains no variable. Migration 107 follows the structural-down pattern (#1139).
> Nothing else in this document was re-verified.

> **Re-verified #3664 (2026-10-05):** `index.ts`'s `enforcedModules` comments
> on the sub-budget routes no longer say "money-path-adjacent" —
> `routes/agent-sub-budgets.ts` and `routes/sub-budgets.ts` are runtime
> money-path globs since #3661 (the owner issuance/sign routes are where a
> sub-budget is issued and opened, the moment another agent receives spend
> authority; Haven signs nothing there, the delegating agent's key does).
> The `routes/task-budgets.ts` comment's "no live caller yet" is updated
> too: qa-dev drives its lifecycle since #3505. The `enforcedModules`
> entries themselves are byte-identical — no module joined or left the
> list — so nothing in this document's mode/rollback semantics moves, and
> this doc's own line above already calls `routes/task-budgets.ts`
> money-path. Nothing else in this document was re-verified, and
> `last-verified` is not bumped.
>
> **Re-verified #3804 (2026-10-09):** `index.ts`'s `enforcedModules` gains one
> born-enforced entry — `routes/dashboard-budget-remaining.ts`, the
> display-only `GET /dashboard/budget-remaining` read (its own file riding
> the `/dashboard` prefix, GET-only, no parameters, no body, no live caller
> at birth — the same brand-new-module rule as `agent-organizations.ts`).
> It is NOT money-path: the route caches the enforcer read for DISPLAY while
> `readRemainingBudget` itself is untouched behind every spend decision, and
> a structural import guard pins the route as the cache module's only
> importer. The request schema comes from the OpenAPI spec (no body to
> refuse). No route file is moved, no mode/rollback/env semantics change, and
> `last-verified` is not bumped.
>
> **Re-verified #3645 (2026-10-05):** `.env.dev.example`'s comments on the
> hosted-MCP URL now match the backend: `NEXT_PUBLIC_HAVEN_MCP_URL` is a legacy
> name the frontend no longer reads (#1823) and the backend reads only as a
> fallback, and an unset `HAVEN_HOSTED_MCP_URL` makes `/resolve` and
> `/register` answer 500 naming the variable rather than handing out
> production's URL (#1129). Comments only; no variable or value changes.
> Nothing else in this document was re-verified, and `last-verified` is not
> bumped.
>
> **Re-verified #3632 (2026-10-05):** `.env.dev.example` drops "Gnosis Chiado"
> from its testnet line, which now names Base Sepolia only, and annotates
> `RPC_URL` and `GNOSISSCAN_API_KEY` as "chain 100 only; unused by the delegation
> rail". `config.ts` still reads both variables. This matches this doc's own
> lines that call chain 100 legacy and dead; no variable, value or deploy step
> changes. Nothing else in this document was re-verified, and `last-verified` is
> not bumped.

> **Re-verified #3579 (2026-10-05):** the site switch-over deleted the
> public site's gate module (dropped from `covers:`) and with it every reader
> of its preview flag; § "The public site's former gate" replaces the flag's
> section, and the local-`/demo` sentence it carried moved to
> § `HAVEN_DEMO_PAGE_VISIBLE`. Nothing else in this document was re-verified,
> and `last-verified` is not bumped.

> **Re-verified #3669 (2026-10-06, supported vs known chains):**
> - **Supported narrows.** The backend's supported chain set is now an explicit 8453 and 84532. With `HAVEN_DEPLOY_CHAIN_IDS` unset, deploys, the outbound bump loop, the relayer balance monitor, prices, `GET /chains` and discovery `supported` cover Base and Base Sepolia only. Chain 100 is not one of them.
> - **Known stays.** Chain 100 is still resolved for history (transactions, explorer links) and stays read-only. That matches this doc's lines calling chain 100 dead.
> - **Boot check widens.** The passport receipt-key boot check in `index.ts` now compares against every `RELAYER_PRIVATE_KEY` / `RELAYER_PRIVATE_KEY_<n>` variable set, not only the supported chains' keys.
> - **No variable changes.** No variable, value or deploy step changes; `RPC_URL` and `GNOSISSCAN_API_KEY` are slice #3671.
>
> Nothing else in this document was re-verified, and `last-verified` is not bumped.

> **Re-verified (#4012, 2026-10-16, `ETH_GETLOGS_MAX_BLOCK_RANGE` added):** a
> new optional backend variable: the widest `eth_getLogs` block range the RPC
> provider serves. The x402 settlement sweepers never ask for more. Dev's RPC
> is the Alchemy dev app on the free plan, which serves **10**. Unset, the
> sweepers learn that limit from the provider's refusal, which costs one
> refused call per chain per hour and a `provider_log_range_limit` warn in the
> backend logs. Set `ETH_GETLOGS_MAX_BLOCK_RANGE=10` on dev while it stays on
> the free plan, and unset it (or raise it) after a PAYG upgrade. On a
> 10-block cap the erc7710 sweep scans nothing (its settlement windows do not
> fit the call budget). The eip3009 sweep still works, 200 blocks per attempt.
> No other variable, value or deploy step changes. Nothing else in this
> document was re-verified, and `last-verified` is not bumped.

> **Re-verified (2026-10-09, `ALCHEMY_HISTORY_API_KEY` added):** a new
> optional backend variable. When set, Base and Base Sepolia transaction
> history is read through Alchemy's transfers API (`alchemy_getAssetTransfers`,
> hosts `base-mainnet` / `base-sepolia.g.alchemy.com`) instead of Blockscout,
> whose public API answers Railway with a Cloudflare challenge (HTTP 403) and
> whose keyed API puts Base behind a paid plan. Use a key from its own Alchemy
> app, apart from the RPC app. Unset, history stays on Blockscout as before.
> No other variable, value or deploy step changes. Nothing else in this
> document was re-verified, and `last-verified` is not bumped.

> **Re-verified (2026-10-07, `BLOCKSCOUT_API_KEY` added):** a new optional
> backend variable. When set, it is sent as `apikey` on the Base and Base
> Sepolia Blockscout history reads; unset, the reads stay anonymous as before.
> Production Base history reads were refused with HTTP 403 on every request,
> so set it on any environment where `Explorer API fetch failed` logs a 403.
> No other variable, value or deploy step changes. Nothing else in this
> document was re-verified, and `last-verified` is not bumped.

> **Re-verified #3671 (2026-10-06, `RPC_URL` removed):** the backend no longer
> reads `RPC_URL`; RPC is resolved only for supported chains, so chain 100 has
> none. Delete the variable from any environment that still sets it (it is
> ignored). `GNOSISSCAN_API_KEY` stays, history only (decision (c), #3635): it
> serves the chain-100 explorer history read. The "Testnet RPCs by default"
> bullet drops its Chiado line. Nothing else in this document was re-verified,
> and `last-verified` is not bumped.

> **Re-verified #4571 (2026-10-31):** `playwright.config.ts`'s dark-project
> `testMatch` gains `settings-tabs.visual.spec.ts` — the Settings tab strip
> joins the pixel gate at 375px in dark, the width the 2026-10-30 UX audit
> measured the thin vertical line at. The spec pins 375 itself rather than
> adding a width to `scripts/evidence-viewports.mjs`, because that list mints
> blocking baselines for every route in every evidence run (#2006); it is the
> file's only capture, so the extra width costs one PNG. `webServer.env` and
> every other project are untouched, so the Playwright build surfaces this
> document describes are unchanged. No environment variable changes name,
> meaning, surface, or where it is set. Nothing else in this file's coverage
> was touched; this note is the only edit.

> **Re-verified #4053 (2026-10-17):** `playwright.config.ts`'s dark-project
> `testMatch` gains `more-sheet.visual.spec.ts` — the phone More sheet joins
> the pixel gate in light and dark with the same seed-before-navigation dark
> convention the other specs use (its spec reads `testInfo.project.name`;
> unlike most specs it does keep a MOBILE dark baseline, because the sheet only
> exists below `lg`). `webServer.env` and every other project are untouched,
> so the Playwright build surfaces this document describes are unchanged; the
> `DEV` badge section above still holds (the badge now sits off the wordmark
> with a gap, in the rail and in the sheet). No environment variable changes
> name, meaning, surface, or where it is set. Nothing else in this file's
> coverage was touched; this note is the only edit.

> **Re-verified #4293 (2026-10-22):** `playwright.config.ts` gains
> `use.timezoneId: 'UTC'` and `TZ: 'UTC'` in `webServer.env`, so every e2e and
> visual run renders local times in UTC whatever the host's zone (the same pin
> goes into `scripts/screenshot.mjs`'s browser context and dev-server spawn).
> `TZ` here is a process setting for the test server only: no app environment
> variable is added, renamed or moved, nothing reads it by name, and no build
> surface this document describes changes. The other `webServer.env` entries
> and the projects are untouched. Nothing else in this file's coverage was
> re-verified; `last-verified` is not bumped.

> **Re-verified #3577 (2026-10-02):** `playwright.config.ts`'s dark-project
> `testMatch` gains `dev-agent-pages.visual.spec.ts` — For developers and For
> agents join the pixel gate with the same seed-before-navigation dark
> convention the other specs use (its spec reads `testInfo.project.name`; the
> light desktop/mobile shots ride the chromium-desktop project's viewport
> loop, and mobile dark is skipped — no mobile dark baseline). The new
> `/developers` and `/for-agents` pages are frontend pages behind the
> existing site gate; no environment variable this document describes changes
> name, meaning, surface, or where it is set, and no backend route file is
> added or moved. Nothing else in this file's coverage was touched; this note
> is the only edit.

> **Re-verified #3574 (2026-10-02):** `playwright.config.ts`'s dark-project
> `testMatch` gains `home.visual.spec.ts` — the redesigned home page joins the
> pixel gate with the same seed-before-navigation dark convention the other
> specs use (its spec reads `testInfo.project.name`; the light desktop/mobile
> shots ride the chromium-desktop project's viewport loop). No environment
> variable this document describes changes name, meaning, surface, or where it
> is set: the gate section above already covers the site-preview variable and
> the e2e/visual build surfaces, unchanged by this slice. No route file is
> added or moved. Nothing else in this file's coverage was touched; this note
> and the `last-verified` date are the only edits.

> **Re-verified #3564 (2026-10-02):** `index.ts` gains one more
> leader-gated background tick beside the settlement sweep — the submission
> reconciler (`modules/payments/submission-reconciler.ts`, lock key
> `submissionReconcile`), every 60 s, `unref`'d like the sweep's own
> interval. It resolves the direct payments whose sign submit was SENT but
> whose receipt was never confirmed (the rows #3564 books outcome-pending):
> one bundler receipt read per candidate row, terminal writes via CAS, and
> a per-candidate try/catch so one poison row cannot silence the queue. No
> route file is added or moved, `enforcedModules` is untouched, and the
> shadow/enforce semantics this document describes are unchanged. Nothing
> else in this file's coverage was touched; this note and the
> `last-verified` date are the only edits.

 > **Re-verified #3980 (2026-10-15):** #3980 touches
 > `infra/repositories/merchants.ts` (a USDC lowest-price aggregate beside the
 > offer count) and `routes/merchants.ts` (the field on the wire, plus a
 > renumbered bind placeholder), without moving the scoping this bullet
 > describes: `$1` is still the network list, `coming_soon` rows are still
 > listed only through the same `includeProspects` gate, and the SQL's
 > `ORDER BY` is deliberately unchanged — #3980 re-sorts client-side in the
 > grid's `visible` memo, so the endpoint's order for its other clients stays
 > put.
 > Scope of this re-read: this bullet's marketplace paragraphs and the
 > merchants repo/route coverage it names; the rest of the document was not
 > re-read for it.

 > **Re-verified #4408 (2026-10-25):** #4408 touches
 > `infra/repositories/merchants.ts` comment text only — the
 > OFFER_AGGREGATES_SQL doc block now cites `agentsThatCanPay` (the #4004
 > client-side replacement for the deleted `withinBudget`) where it names the
 > malformed-`price_atomic` defense. No SQL, bind placeholder, flag or scoping
 > change; every claim in the marketplace bullet above is untouched. Scope of
 > this re-read: this bullet's marketplace paragraphs and the merchants repo
 > coverage they name; the rest of the document was not re-read for it, and
 > `last-verified` is bumped to 2026-10-25 for exactly this coverage.

 > **Re-verified #3769 (2026-10-08):** the catalog verifier
 > (`modules/catalog/merchant-catalog.ts`) now probes a plain-HTTP row with
 > the row's DECLARED method and body example (`http_method`/`body_type`/
 > `body_example`, migration 108) instead of a hardcoded GET, and a challenge
 > that structurally advertises its own method (`resource.method` on the 402)
 > is written back onto the row's `http_method` in the same success UPDATE —
 > one more COALESCE'd column beside the #3331 `pay_to` write. The claims
 > above about what the refresh records and when payTo arrives are unchanged:
 > `pay_to` is still written as seen from the challenge, `asset_transfer_methods`
 > is still scoped to `accepts[0]`'s network, and the probe is still read-only
 > (it never pays, signs, or follows the challenge). Scope of this re-read:
 > this bullet's catalog-verification paragraphs; nothing else in the
 > document was re-read for it, and `last-verified` is bumped to 2026-10-08
 > for exactly this coverage.
 > **Re-verified #4245 (2026-10-22):** #4245 adds `merchant_catalog.source`
 > (migration 117) and the `CatalogRow.source` field in
 > `modules/catalog/merchant-catalog.ts`. The refresh probe, what it records
 > (`pay_to`, `asset_transfer_methods`, `http_method`) and the marketplace
 > chain scoping above are unchanged; only the discovery cron's INSERT writes
 > the new column. `CATALOG_DISCOVERY_ENABLED` stays false in
 > `.env.dev.example`. Scope of this re-read: this bullet's catalog
 > paragraphs; nothing else in the document was re-read for it, and
 > `last-verified` is not bumped.
 > **Re-verified #4281 (2026-10-22):** the refresh probe in
 > `modules/catalog/merchant-catalog.ts` now sends every request through the
 > SSRF guard (`infra/http/ssrf-guard.ts`). That means https on the default
 > port only, a public resolved address only, a 15 s total deadline and a
 > 256 KiB cap, and no redirect on a method that carries a body. It still probes
 > with the row's declared method and
 > body example, and what a success records (`pay_to`,
 > `asset_transfer_methods`, `http_method`) is unchanged. Every catalog row
 > seeded by migrations is an https URL on a public host, so a local dev
 > refresh probes them as before. A row pointed at a local or http merchant
 > now fails its probe. Scope of this re-read: this bullet's catalog
 > paragraphs; nothing else in the document was re-read for it, and
 > `last-verified` is not bumped.
 > **Re-verified #4300 (2026-10-23):** a refresh run is now bounded to
 > 10 min, and a row it does not reach waits for the next run without being
 > counted as a miss. The guard's deadline now covers name resolution, and it
 > tries the next checked address when a connection fails before TLS. With
 > the migration-seeded rows, a local dev refresh finishes well inside the run
 > budget, so local behaviour is unchanged. Scope of this re-read: this
 > bullet's catalog paragraphs; nothing else in the document was re-read for
 > it, and `last-verified` is not bumped.
 > **Re-verified #4341 (2026-10-23):** #4341 changes what happens when a
 > probe's outcome cannot be STORED, in `modules/catalog/merchant-catalog.ts`
 > and `modules/catalog/catalog-discovery.ts`. A row whose verified write
 > fails (e.g. a challenge string carrying a NUL byte, which Postgres
 > rejects) is now recorded as a miss and degrades after the usual three;
 > `probeCatalogEntry` logs a thrown parse error with the row's URL and the
 > message; and a discovery candidate whose write fails is skipped and
 > counted (`failedWrite`) while the run reaches later candidates. No env
 > scalar, workflow, dev service, port or seeded row in this document
 > changes, and local dev behaviour with the migration-seeded rows is
 > unchanged (their challenges are storable). Scope of this re-read: this
 > bullet's catalog paragraphs; nothing else in the document was re-read for
 > it, and `last-verified` is not bumped.
 > **Re-verified #4389 (2026-10-24):** the refresh probe in
 > `modules/catalog/merchant-catalog.ts` and the discovery pre-filter in
 > `modules/catalog/catalog-discovery.ts` now keep the `accepts[]` options
 > the pay path keeps (the SDK's `normalizePaymentRequired` rule) and judge
 > them with the pay path's own selector (`selectX402SettlementScheme`,
 > delegation rail), over all of them instead of `accepts[0]`. The recorded
 > network is the selected option's, as CAIP-2, so `pay_to` and
 > `asset_transfer_methods` are scoped to it rather than to `accepts[0]`'s
 > network as the #3769 note above says. A challenge with no option the pay
 > path could settle is a miss and degrades after the usual three, and the
 > asset is labelled from the `@haven_ai/core` chain registry on the
 > selected option's own chain rather than defaulting to USDC. A row stored
 > before as `base` or `base-sepolia` was left out wherever rows are
 > filtered by CAIP-2 network (an agent's catalog view, a chain-scoped
 > marketplace listing, merchant funding targets); its first successful
 > refresh after #4389 rewrites it as CAIP-2, and from then on it shows up
 > in all three. No env
 > scalar, workflow, dev service, port or seeded row in this document
 > changes; the seeded rows were not re-probed for this note. Scope of this
 > re-read: this bullet's catalog paragraphs; nothing else in the document
 > was re-read for it, and `last-verified` is not bumped.
 - **Owner company details (#3332)** — `HAVEN_OWNER_COMPANY_DETAILS` (strict
  boolean) gates `/user/company-details*`, the additive `parties.buyer`
  field on payment evidence/receipts, and the Company details card on the
  Settings → Business tab (the card moved there in #4359/PR #4382; #4415
  corrects the name and the flag-off sentence in this bullet only —
  nothing else in this document was re-read for it, and `last-verified` is
  not bumped). Dark by default; GET/PUT
  and POST vies-check answer 404 when off, and
  the card itself renders nothing (no title, no form) while off — the
  Settings page still renders General and Security, and once the reads
  settle the Business tab is listed only when this card or the accounting
  connections card has something to show (`SettingsClient.tsx:38-56`) —
  so with the flag off there is no dashboard way to erase, even though the
  DELETE route stays ungated (it erases only the caller's own row). Erasure
  then goes through Haven support, who removes the row directly in the
  database — the M3 decision, #3332 review round 2. With the flag on, the owner erases it
  themselves from Settings. See
  [`docs/product/owner-company-details.md`](../product/owner-company-details.md).
- **Served-chains gate** — `HAVEN_DEPLOY_CHAIN_IDS=84532` so dev only deploys
  accounts on Base Sepolia (onboarding offers only served chains, #679), and
  `NEXT_PUBLIC_HAVEN_CHAIN_ID=84532` so onboarding defaults there (#615). A
  multichain backend resolves the relayer **per chain**
  (`RELAYER_PRIVATE_KEY_<chainId>`, #640/#678) — a mechanism that *permits*
  isolating testnet from mainnet keys, though the deployed posture shares one
  key (see above).
- **Connector channel** — `HAVEN_CONNECTOR_CHANNEL` on the dev **backend**
  selects the npm dist-tag the dashboard's connector command hands out (#2422, epic
  #2420), and the same variable on the dev **hosted MCP** selects the tag its
  own "re-run the connector" hints name (#2423). Unset or empty means `alpha`;
  production leaves it unset, so the production handout is untouched by the
  variable's existence. The value must match `/^[a-z][a-z0-9-]{0,31}$/` — an
  invalid value makes the service refuse to start, naming the variable, rather
  than fall back to `alpha`, because a silent fallback would hand out the
  production connector from dev and look like it had worked. **This bullet
  describes the mechanism, not the deployed posture**: whether the dev services
  have it set is read from Railway, or from a fresh setup response's
  `connector_package` field (the package the backend actually used) — never
  assumed from prose. Setting it is owner-only and **ordered**: it must come
  *after* the `dev` dist-tag exists on npm for all five packages, or the
  dashboard hands out a tag `npx` cannot resolve (`ETARGET`; observed on
  2026-09-03 when it was set one step early — #2420 thread). The ordered
  checklist, and why the dev signer and dev backend must move together, are in
  [`package-dev-channel.md`](../operations/package-dev-channel.md) § *Operator checklist*.
- **Sweep recovery floor** — `SWEEP_MIN_USDC=0` in dev so the QA scenario's
  0.0005-USDC stranded balance exercises the real gasless recovery path. The
  production default is `0.01`; do not copy the dev override into production.
- **QA crash/resume grace** — set
  `MERCHANT_REPORT_GRACE_MIN_OVERRIDE=0` on the dev **backend only** before
  running the #2159 funded-but-undelivered QA leg. The backend starts only when
  this deployment serves exactly `HAVEN_DEPLOY_CHAIN_IDS=84532`; it rejects the
  override on mainnet, mixed, or unbounded deployments. Leave it unset outside
  that deterministic test so the normal 15-minute merchant-report grace stays
  in force; never set it in production.
- **Request-validation mode** — `HAVEN_REQUEST_VALIDATION` on the backend is
  `enforce` (**default since slice 4's flip, #3032**: off-spec requests on the
  modules `index.ts`'s `enforcedModules` lists are refused with the documented
  400 envelope; the list is the per-module ROLLBACK — epic decision 6 — so
  removing one route file there returns exactly that module to shadow
  behaviour, the response to one misbehaving module) | `shadow` (the GLOBAL
  observation switch: log and count would-be refusals on every constrained
  route, listed or not; since #3082 the request BODY is restored after
  validation so nothing the handler reads changes, and a body that coercion
  alone made valid is counted as `would_coerce`. Typed querystring/params are
  still coerced — that is what makes them usable) | `off` (the GLOBAL kill
  switch: nothing runs, `enforcedModules` included). Per the OpenAPI spec, via
  the request-validation plugin (#3029, epic #3028). Any other value refuses
  the boot.

  > **Re-verified #3330 (2026-09-28):** the born-ENFORCED rule above gained
  > two more followers — the owner-auth `routes/agent-sub-budgets.ts` and the
  > agent-auth, money-path-adjacent `routes/sub-budgets.ts` (sub-budget
  > issue/sign/list/tree/revoke), both listed in `index.ts`'s
  > `enforcedModules` with their own key, both registered under existing
  > prefixes (`/agents`, `/sub-budgets`), and `route-modules.generated.ts`
  > regenerated for both. Same reasoning as #3329's pair: brand-new modules
  > with no installed caller have no old shape to shadow for, so they are
  > enforced from their first commit. The backend suite's request-validation
  > envelopes for both files are green, and `check:route-modules` passes at
  > the merged head. Nothing in this section's mode/rollback semantics
  > moved.

  > **Re-verified #3602 (2026-10-06):** the change adds `GET /ops/feedback`
  > to the existing `routes/ops.ts` module — no new module, so no new
  > `enforcedModules` entry; it joins the already-ENFORCED `/ops` prefix,
  > and the route carries no request body. `route-modules.generated.ts` was
  > regenerated for the added operation, and both checks that fail on a
  > stale table are green at this head (`npm run check:route-modules` and
  > the backend suite). Nothing in this section's mode/rollback semantics
  > moved.

  > **Re-verified #4497 (2026-10-29):** the paragraph above said dev uses a
  > **separate dev Fortnox app** and never the prod credentials. That is false:
  > production's `FORTNOX_CLIENT_ID` hashes identically to dev's, so prod holds
  > the dev app's credentials, inert while `FORTNOX_REDIRECT_URI` is unset. The
  > redirect path in the paragraph was already the post-#2862
  > `/accounting/connections/fortnox/callback` and is unchanged. Nothing else in
  > this document was re-read for it, and `last-verified` is not bumped.

  > **Re-verified #3126 (2026-09-18):** round 3 of PR #3148 regenerated
  > `packages/backend/src/openapi/route-modules.generated.ts` — the branch
  > added `GET /machine-payments/balance-coverage` to
  > `routes/machine-payments.ts`, and #3138's generator tracks route files,
  > so the committed table was STALE against the registered routes (the
  > Backend-checks gate caught it on the PR). Regeneration ran
  > `npm run generate:route-modules` (deriving from `src/index.ts` +
  > `src/routes/*.ts` source) and adds exactly one row —
  > `"GET /machine-payments/balance-coverage": "routes/machine-payments.ts"`
  > — and `npm run check:route-modules` exits 0 at the new head. The plugin
  > resolves `enforcedModules` through this table, so the new route is
  > visible to request-validation in the same commit that registers it. The
  > generator script, `request-validation.ts`, `index.ts` and `config.ts`
  > claims above were re-read and are untouched by this PR.
  >
  > **Re-verified #3018 (2026-09-18):** the only `index.ts` change in PR
  > #3110 is the comment block above `registerConnector(new AccountedConnector())`
  > — it now describes the #3018 WORM document delivery (the receipt underlag
  > uploaded as one WORM document, delivery proven by sha256 echo) where it
  > previously said the connector's push half was still pending and skipped.
  > Comment-only: no registration, wiring or boot-order change. The doc's
  > other `index.ts` claims — boolean boot flags through `parseBooleanFlag`
  > and the request-validation `off`/`shadow`/`enforce` modes — were re-read
  > against the merged tree and hold; the doc makes no claim about
  > accounting-connector registration itself. Found stale here but
  > PRE-EXISTING and out of scope for #3018 (dev's own #3084 changed the code
  > without touching this doc): the enforced-module sentence in the
  > request-validation bullet above still named `['/contacts']` while
  > `index.ts` had moved on — flagged, not edited. Nothing in this file was
  > edited except this note and the `last-verified` date.
  >
  > **Resolved since:** #3111 corrected that sentence, and #3135 re-keyed the
  > option itself from `enforcedPrefixes` to the file-keyed `enforcedModules`.
  > The bullet above is current as of #3135.

  > **Re-verified #3018 (2026-09-18, round-3 follow-up):** the staleness
  > flagged in the blockquote above is fixed in this edit. The sentence now
  > names `['/contacts', '/merchants']` with the #3084 attribution and
  > re-derives the consequence: the refusal-set identity holds because an
  > enforced prefix refuses in every mode (`mode` gates only the `off`
  > early-return and the counters), and the widened enforcement is
  > non-vacuous — `/merchants/{slug}`'s required `slug` path parameter is
  > pattern-constrained in the spec. Re-read at dev tip ec41ee72 against
  > `packages/backend/src/index.ts` (the `installRequestValidation` options),
  > the plugin's `onRoute` wiring in
  > `packages/backend/src/openapi/request-validation.ts` (enforcement is
  > prefix-determined and mode-independent), the `/merchants` path items in
  > the OpenAPI spec, and the read-only GET registrations in the
  > `/merchants` route module.

  > **Re-verified #3019 (2026-09-20):** PR's `index.ts` change registers ONE
  > new plugin — `app.register(accountingWebhookRoutes)` — the Accounted
  > webhook receiver (`routes/accounting-webhooks.ts`, capability-URL token +
  > HMAC, its own encapsulated raw-body parser so the capture stays off every
  > other route). The doc's config claims are unaffected: the receiver reads
  > the existing `HAVEN_ACCOUNTING_ENABLED` flag (feature off → the route
  > still answers 200 with a counter — deliberate: a 4xx would eat the
  > provider's ~87 h retry budget) and adds no variable. The
  > request-validation claims hold unchanged: the webhook module is NOT in
  > `enforcedModules` (public route, spec-documented, carries no session
  > surface to shadow; since #3030 it is listed, see the enumeration above), and `route-modules.generated.ts` was regenerated in
  > the same commit (`npm run check:route-modules` green), including the
  > trailing-slash twin's spec entry so the provider never meets Fastify's
  > redirect. `HAVEN_SECRETS_KEY` now also protects the three webhook
  > signing secrets (same blob, same key) — the *Secrets at rest* section of
  > `docs/operations/accounting-feed.md` is the reference, not this file.

  > **Re-verified #3019 round 2 (PR #3196 review):** the webhook half now
  > requires `HAVEN_API_URL` (or `PUBLIC_API_URL`) on the BACKEND deployment.
  > The old `http://localhost:<port>` fallback is gone: with no stated origin
  > the connect flow refuses to register any subscription and flags the
  > connection `needs_attention` (`no public API origin configured`) instead
  > of writing a callback URL the provider could never reach. Dev backends
  > that exercise the webhook half must state the origin explicitly (the
  > Railway dev backend already does); a tunnel URL works, a loopback URL
  > does not — the provider refuses to dispatch to private/loopback addresses
  > by policy.

  > **Re-verified #3345 (2026-09-26):** the PR's `index.ts` change replaces
  > the inline `sendCatalogOpsAlert` body with a call to the shared ops-alert
  > sender (`infra/delegate-alert-webhook.ts`, also used by the relayer and
  > delegate balance monitors — see `docs/operations/catalog-ingestion.md`
  > for the alarm semantics) and hands the ingest loop's alerts to
  > `deliverCatalogAlerts`, so a failed webhook re-arms the alarm instead of
  > being dropped. Comment-only inside the covered claims: the function
  > previously swallowed every failure silently. No new env variable (the
  > sender reads the existing `DELEGATE_ALERT_WEBHOOK_URL`), no route, plugin
  > registration, boot-order or request-validation change — the new
  > `catalog*` alert path registers nothing and the route-module table is
  > untouched. The doc's other `index.ts` claims (boot flags through
  > `parseBooleanFlag`, the `installRequestValidation` options, the
  > non-money-route enumeration) were re-read against this tree and hold.

  > **Re-verified #3426 (2026-09-29):** the PR's `index.ts` change registers
  > ONE new route module — `app.register(agentTaxDeclarationRoutes, { prefix:
  > '/agents' })` — the per-agent x402 tax-declaration toggle + content read
  > (`routes/agent-tax-declaration.ts`). No new env variable (the module
  > reads the existing `HAVEN_OWNER_COMPANY_DETAILS` through `config`), no
  > plugin, no boot-order change. Request-validation claims hold unchanged:
  > the module IS in `enforcedModules` from its first commit (a genuinely new
  > module has no installed caller to shadow for — the born-ENFORCED rule
  > above), and `route-modules.generated.ts` was regenerated in the same
  > commit with both operations (`GET`/`PUT /agents/{id}/tax-declaration`)
  > keyed to the new file. The PUT's request schema comes from the spec
  > (`UpsertAgentTaxDeclarationRequest`), so the `lint:request-schemas`
  > baseline does not grow. The GET is the only agent-auth surface in the
  > module and carries no body; the PUT's hooks are route-level
  > (`refuseAgentKey` then `authMiddleware`), deliberately NOT the
  > instance-level `addHook` shape, so an agent key meets the named 403
  > rather than `routes/agents.ts`' generic 401 — the module is mounted on
  > its own app instance and shares only the prefix.

> **Re-verified #3386 (2026-09-28):** `merchant-catalog.ts`'s
> `collectAssetTransferMethods` now scopes to the offer's recorded network
> (`accepts[0]`'s), the same scoping `collectPayTo` already used, instead of
> scanning every `accepts[]` option regardless of network. This is a CATALOG
> READ-SIDE change — what `merchant_catalog.asset_transfer_methods` records
> for the marketplace and merchant-locked-budget build gate — and does not
> touch this section's claims. Scheme SELECTION on a live payment
> (`selectStandardPaymentOption`, `selectX402SettlementScheme`,
> `routes/x402.ts`) does not read that column at all, so the erc7710/EIP-3009
> dispatch described above, the QA scenario that proves it, and the ordering
> footgun analysis are unaffected. Nothing else in this section's covered
> claims was re-read, so `last-verified` is deliberately not bumped.

> **Re-verified #3167 (2026-09-20):** this diff's two new route files
> (`routes/labels.ts`, `routes/agent-labels.ts`) are born ENFORCED —
> `enforcedModules` in `index.ts` grew by exactly those two entries, the
> generated map (`route-modules.generated.ts`) was regenerated in the same
> commit, and both modules carry spec request bodies the plugin can enforce.
> The shadow/enforce semantics this document describes are unchanged; the
> rollout moved in its own forward direction (new modules start enforced,
> shadow residue only shrinks — `lint:request-schemas` stays green with no
> baseline bump). Nothing else in this file's coverage was touched; the note
> and the `last-verified` date are the only edits.

> **Re-verified #3303 (2026-09-25):** `index.ts` registers one more pair of
> root hooks, `registerClientCompatHooks` (`middleware/client-compat.ts`), after
> the request-validation plugin. Its `preHandler` therefore runs after the
> plugin's `preHandler` has restored the client's body; it only reads the body
> (an idempotency key) and never mutates it, so the shadow-snapshot rule above
> holds. The `X-Haven-Client` header it reads is declared in the spec as an
> unconstrained optional string, so neither shadow nor enforce mode can refuse
> a malformed value. The shadow/enforce semantics, `enforcedModules` and the
> generated route-module table are unchanged (no route file added or moved).
> Nothing else in this file's coverage was touched; this note is the only edit.

> **Re-verified #3294 (2026-09-25):** `index.ts` gains two wiring lines and one
> sweep phase, none of them route work. The wiring: `setAnchorUidRepair` joins
> the other passport seams beside `setRevocationProbe` (it degrades to the
> pre-#3294 submit when unwired, so no boot path changes), and
> `repairAnchoredUids` is imported from the passport barrel. The phase: inside
> the existing leader-gated passport sweep, a `phase('anchor-repair', …)` runs
> BETWEEN the issuance retry phase and the revocation phase — a `limit`ed,
> `updated_at`-paced batch (`repairAnchoredUids()`), so a repair-triggered
> revoke shares the one relayer lane through the revocation sweep's ordinary
> backoff rather than stampeding it; phase isolation keeps its failure away
> from the safety-critical revocation half, as for issuance. No route file is
> added or moved, `enforcedModules` is untouched, and the shadow/enforce
> semantics this document describes are unchanged. Nothing else in this file's
> coverage was touched; this note and the `last-verified` date are the only
> edits.

> **Re-verified #3338 (2026-09-26):** `qa-dev.yml`'s money-flow step keeps
> its in-step retry (`QA_MAX_ATTEMPTS`, default 2) unchanged; each attempt now
> tees its own `qa-run.attempt-<i>.log` and `qa-run.log` is copied from the
> final attempt, so the blocking Coverage completeness step judges exactly
> what it judged before. A pass after a failed attempt now adds a job-summary
> block (URLs and long key-labelled values scrubbed) and a notice (agent-qa.md § Flake budget). The
> run and its `money-flow` job still conclude `success`, so the promotion
> freshness gate described above selects the same runs as before. Nothing else
> in this file's coverage was touched; this note is the only edit.

> **Re-verified #3342 (2026-09-26):** `index.ts`'s `anchor-repair` phase — the
> one #3294 added inside the existing leader-gated passport sweep — now also
> emits a warn-level per-row report when the repair left rows unanswered
> (`agent_id`, `outcome`, `reason`); the repair result itself gained a
> `healthy` count and the per-row array. No phase is added, moved, or reordered
> (the report is ten lines inside the existing `anchor-repair` phase), no route
> file is added or moved, `enforcedModules` is untouched, and the
> shadow/enforce semantics this document describes are unchanged. The repair
> sweep now excludes rows durably confirmed against their anchor receipt
> (migration 096's `uid_repair_confirmed_at` marker), which only shrinks what
> the phase re-reads. Nothing else in this file's coverage was touched; this
> note is the only edit.

> **Re-verified #3361 (2026-09-26):** the promotion freshness gate described
> above now reads every run-level qa-dev success created within twice
> `QA_FRESHNESS_HOURS`, instead of the newest 30. Rows whose run name names
> another deployment environment or state, or that finished in under 60 s, are
> dropped before the job lookup, and the lookups are budgeted. The rules that
> select the anchoring run — SHA ancestry and the `money-flow` job's
> conclusion (#2404) — and the recency and coverage checks are unchanged, so
> every statement above still holds. The `qa-dev.yml` edit is a comment. Nothing
> else in this file's coverage was touched; this note is the only edit.

> **Re-verified #3368 (2026-09-26):** `qa-freshness.mjs` drops the #1044
> step-level completeness warning, which could not fire: the Coverage
> completeness step fails the `money-flow` job, which the gate already
> refuses. It also reports a search cut short by its lookup budget, and an
> unusable `QA_FRESHNESS_HOURS`, as their own refusals. The `qa-dev.yml` edits
> are comments. The statements above — a skipped leg fails the run, the gate
> selects by SHA ancestry and the `money-flow` job — still hold. Nothing else
> in this file's coverage was touched; this note is the only edit.

> **Re-verified #3337 (2026-09-26):** `qa-dev.yml`'s failure step now passes
> the money-flow attempt logs to the standing-issue reporter, which
> records a failure class and signature in the standing `qa-failure` issue, and
> the retry-budget comment no longer calls a failed attempt a "transient testnet
> RPC hiccup". Triggers, gating, the retry count and the freshness gate
> described above are unchanged. Nothing else in this file's coverage was
> touched; this note is the only edit.

> **Re-verified #3395 (2026-09-27):** `index.ts`'s `anchor-repair` phase warn
> report ("left rows unanswered") now excludes `repaired` rows alongside
> `confirmed` ones — a repair is an answer, and the row left the queue on the
> same write — so the operator's report carries only `unrepairable` and
> `deferred` outcomes. The phase itself is unchanged: same position in the
> sweep, same `repairAnchoredUids()` call with the same default limit; the
> pacing this issue added (`uid_repair_next_at`, migration 099) lives in the
> repository and the sweep's own per-row handling, and the selector still
> skips whatever the phase's batch cannot reach. No route file is added or
> moved, `enforcedModules` is untouched, and the shadow/enforce semantics this
> document describes are unchanged. Nothing else in this file's coverage was
> touched; this note and the `last-verified` date are the only edits.

> **Re-verified #3837 (2026-10-10):** `route-modules.generated.ts` was
> regenerated in the same commit as a new route — `GET /ops/sponsored-gas`
> (ops console, `routes/ops.ts`), registered through the same data-read
> builder as the other ops reads and covered by an OpenAPI operation, so
> `check:route-modules` and `lint:request-schemas` stayed green with no
> baseline change. The generate/check workflow and the ENFORCED-from-birth
> rule this section describes are unchanged — no new MODULE was added, only
> a route inside the already-enforced `routes/ops.ts`. Nothing else in this
> file's coverage was touched; this note and the `last-verified` date are
> the only edits.

> **Re-verified #3333 (2026-09-27):** `index.ts`'s `enforcedModules` grew by
> exactly one entry — `routes/receive.ts`, born ENFORCED per the rule above
> (a genuinely new module with no existing caller). The generated map
> (`route-modules.generated.ts`) was regenerated in the same commit and
> `lint:request-schemas` stayed green with no baseline bump: the module
> carries a spec operation for every registered route, including the
> unauthenticated-but-signed receipt drop (whose body shape is the enforced
> schema's). The shadow/enforce semantics this document describes are
> unchanged. Nothing else in this file's coverage was touched; the note and
> the `last-verified` date are the only edits.

> **Re-verified PR #3587 (2026-10-02):** `playwright.config.ts` changed only
> in comments — the `chromium-desktop-dark` project's opening comment now
> points at its `testMatch` instead of naming specs. `webServer.env`
> (`HAVEN_DEMO_PAGE_VISIBLE`, `NEXT_PUBLIC_COINBASE_ONRAMP_APP_ID`), the
> projects and their `testMatch` lists are untouched, so the Playwright-build
> claims above still hold. This note is the only edit.

> **Re-verified #3597 (2026-10-02):** `index.ts`'s `enforcedModules` grew by
> exactly one entry — `routes/feedback.ts`, born ENFORCED per the rule above
> (a genuinely new module, `haven feedback submit`, with no existing caller).
> The generated map (`route-modules.generated.ts`) was regenerated in the
> same commit and `lint:request-schemas` stayed green with no baseline bump
> (the handler's own hand-rolled length/type checks were deleted in favour of
> the spec's `minLength`/`maxLength`, matching `routes/contacts.ts`'s own
> split between what the schema enforces and what the handler still checks
> by hand). The shadow/enforce semantics this document describes are
> unchanged. Nothing else in this file's coverage was touched; `last-verified`
> was already 2026-10-02 at the base commit, so this note is the only edit.

> **Re-verified unchanged (#3739, 2026-10-07, route table):** this diff
> regenerates `packages/backend/src/openapi/route-modules.generated.ts`
> (`npm run generate:route-modules`) for one new read-only route,
> `GET /x402/by-idempotency-key/{key}`, in the existing `x402` module. No
> request-validation mode, enforced-module list, environment variable or dev
> setup step this document describes moved. The rest of this document was not
> re-read for it, and `last-verified` is not bumped.

> **Re-verified unchanged (#3813, 2026-10-10, server-saved dismissals):** this
> diff regenerates `packages/backend/src/openapi/route-modules.generated.ts`
> (`npm run generate:route-modules`) for two new operations in the existing
> `routes/user.ts` module — `GET`/`POST /user/attention-dismissals` (#3813,
> born ENFORCED: `routes/user.ts` is already in `index.ts`'s
> `enforcedModules`). No request-validation mode, enforced-module list,
> environment variable or dev setup step this document describes moved. The
> rest of this document was not re-read for it, and `last-verified` is not
> bumped.

> **Re-verified #3888 (2026-10-10):** `index.ts`'s existing leader-gated
> settlement tick (`runSettlementSweep`, lock key `settlementSweep`) now runs
> a SECOND pass beside the erc7710 one — `runEip3009SettlementSweepTick`
> (`modules/x402/eip3009-settlement-sweeper.ts`), the passive observation
> that records an eip3009 merchant settlement nobody reported. Same lock, no
> new interval, no new route, `enforcedModules` untouched, and no environment
> variable or dev setup step this document describes moves. Nothing else in
> this file's coverage was touched; this note is the edit (the
> `last-verified` date already reads today).

> **Re-verified #3772 (2026-10-13):** `route-modules.generated.ts` is
> regenerated (`npm run generate:route-modules`) for one new operation in the
> existing `routes/agent-connection-setups.ts` module —
> `POST /agent-connection-setups/{setupId}/retired-agents` (born ENFORCED: the
> module is already in `index.ts`'s `enforcedModules`). No request-validation
> mode, enforced-module list, environment variable or dev setup step this
> document describes moved. The rest of this document was not re-read for it,
> and `last-verified` is not bumped.

> **Re-verified #3988 (2026-10-15 — a generated table, regenerated).**
> `packages/backend/src/openapi/route-modules.generated.ts` is the one
> covered file in this diff: it is REGENERATED (`npm run
> generate:route-modules`) for the new `GET /agents/{id}/sub-budgets/received`
> operation, exactly as the file's own header instructs — one mapped row, no
> mode, enforced-module list, environment variable or dev setup step this
> document describes moved. The rest of this document was not re-read for
> it; `last-verified` already reads 2026-10-15.

> **Re-verified #4069 (2026-10-19):** `qa-dev.yml`'s money-flow job gains a
> *Close the standing qa-failure issue on green* step after Coverage
> completeness — a failed close only warns, so the job conclusion is
> unaffected — which only closes the standing
> `qa-failure` issue; the failure step's trigger line moved into the issue
> script (agent-qa.md § *Automated failure reporting*). The gate job, the Coverage completeness step, the #1047
> override validation and the `money-flow` job's conclusion are unchanged, so
> the freshness-gate statements above still hold. The rest of this document was
> not re-read for it, and `last-verified` is not bumped.

> **Re-verified #4216 (2026-10-21 — kit analytics off at boot):**
> `packages/backend/src/index.ts` is the covered file in this diff, and the
> change is its import ORDER: `src/telemetry/kit-analytics-off.ts` is now the
> first import, setting `process.env.DO_NOT_TRACK = '1'` before anything in
> the process can load `@metamask/smart-accounts-kit` (whose analytics post
> from the first tracked call and latch once). No route, module list,
> enforced-module entry, start command, health probe or required environment
> variable this document describes moved — `PORT`, `DATABASE_URL`, the ops
> surface and the boot checks are untouched; the only behavioral delta is the
> absence of an outbound telemetry post. The same module is imported by
> `vitest.setup.ts` and the kit-reaching `scripts/*.ts`, and the deployed
> process takes this path (Railway starts `node packages/backend/dist/index.js`).
> Scope of this note: the one new first import; `last-verified` is bumped to
> 2026-10-21 for exactly this coverage.

> **Re-verified #4236 (2026-10-21 — the qa-failure window):** `qa-dev.yml`'s
> `money-flow` job gains a job-level `permissions:` block. It restates the
> top-level `contents: read`, `issues: write` and `deployments: read` and
> adds `actions: read`, which the failure step uses to list qa-dev's own runs
> and read their jobs. With that, the standing `qa-failure` issue names the
> last-green → first-red window and its PRs (agent-qa.md § *Automated failure
> reporting*). The failure step also passes the dispatch's `haven_api_url`
> input through env, so a run against another backend reads "window: not a
> dev run". The `gate` job, its top-level grants, the triggers, the #1047
> override validation, Coverage completeness, the green step and the
> `money-flow` job's conclusion are unchanged, so the freshness-gate
> statements above still hold. `qa-freshness.mjs` is imported by the
> reporter, not edited. The rest of this document was not re-read for it,
> and `last-verified` is not bumped.

> **Re-verified unchanged (#4387, 2026-10-24 — comments in
> `packages/frontend/playwright.config.ts`).** Two comments there now say
> "the 24 visual specs" and "the visual specs" where they said "the five
> specs". No config value, project, `testIgnore` entry or matcher changed.
> Scope of this note: those two comments. Nothing else in this document was
> re-read for it, and `last-verified` is not bumped.

> **Re-verified unchanged (#3019 delta, 2026-10-26 — the Accounted
> endpoint-verification handshake).** `modules/accounting/api-key-flow.ts` and
> `routes/accounting-webhooks.ts` are in this document's coverage list, and
> both changed: the receiver now echoes `data.object.challenge` for a
> `webhook.verification` delivery, and the connect flow runs
> `POST …/webhooks/{id}/verify` once per subscription after the triples are
> stored. Nothing this document describes moved. `HAVEN_API_URL` (fallback
> `PUBLIC_API_URL`) is still the only source of the callback origin and still
> fails closed with `no public API origin configured`; the route is still
> registered on both the exact path and its trailing-slash twin, so the
> route-modules table is unchanged; the module is still outside
> `enforcedModules`, so the request-validation posture is unchanged; no
> environment variable, start command, health probe or boot check was added.
> The verify call is best effort and never changes a connection status, so the
> dev-environment statements about connection states still hold. Scope of this
> note: those two files. Nothing else in this document was re-read for it, and
> `last-verified` is not bumped.

> **Re-verified unchanged (#4514, 2026-10-28 — descriptive text in
> `packages/backend/src/config.ts`).** The comment over
> `accountingEntitlementMode` and the text of the
> `parseAccountingEntitlementMode` boot-refusal message no longer name a
> deployment as the one that runs mode `all`. The comment points at the
> Configuration table in `docs/operations/accounting-feed.md` instead. The
> parser, its two accepted values, its default and the condition that throws
> are unchanged. This document does not name
> `HAVEN_ACCOUNTING_ENTITLEMENT_MODE` or quote that message. Scope of this
> note: those two passages. Nothing else in this document was re-read for it,
> and `last-verified` is not bumped.

> **Re-verified unchanged (#4573, 2026-10-31 — the receive dialog's copy
> affordance).** `packages/frontend/src/components/ReceiveDialog.tsx` now
> copies the address through the shared `CopyButton` instead of a hand-rolled
> `navigator.clipboard.writeText` with its own 1800 ms timer. The address, the
> inline QR, the one-network rule, the faucet/onramp gates and the account
> picker are unchanged, and the success toast still fires — now from
> `CopyButton`'s `onCopied`, which runs only after the write resolves. Nothing
> this document says about the dev environment, the demo gate or the receive
> surface moves. Scope of this note: that one file. Nothing else in this
> document was re-read for it, and `last-verified` is not bumped.
```

## `docs/operations/dev-testing-with-a-wallet-signer.md`

<!-- sha256: c78bcd58a2646eb2a528c426c21bfb92858996aed3681b97ba1627e9e7e7ec2f -->
```markdown
> **Re-verified #3093 (frontend hooks: wire keys default instead of crashing):**
> this diff touched `hooks/useDelegationBudget.ts`, in this document's coverage list, by
> defaulting the array keys it stores (`?? []`; and `?? 0` on the portfolio
> totals) so an API answer without the key degrades to an empty state instead
> of sending the route into the ErrorBoundary. No endpoint, flow or
> behaviour this document describes changes. Scope of this note: those
> expressions. Nothing else in this document was re-verified.

> **Re-verified 2026-10-24 (#4372 part F, at dev `6d87ddf95`), a full re-read.**
> Changed: the add-a-wallet and add-a-backup-passkey steps name where the card
> lives now — the account page's *Security & details* tab, under *Who can
> approve* (both #4142), with its *Or add a wallet* / *Add wallet* and *Add a
> backup passkey* buttons (`components/AccountSignersCard.tsx`) — instead of a
> "Backup & recovery" card heading the page no longer renders (#4166, PR #4190,
> removed it). Re-checked
> without change: the stable dev URL (`dev-environment.md`), the opt-in PR
> previews (#3821), the "Browser wallet" / "Show address" (#3825) and
> "Passkey · added {date}" (#1679, `lib/passkeyLabels.ts`) labels, Settings →
> Security → *Passkeys and wallets* → *Connect wallet*
> (`components/settings/SignersSection.tsx`), the #2068 client-side owner
> check (`lib/signer.ts`), the "passkey may be on another device" line
> (`PasskeyElsewhereHint`, shown on the owner-signing flows when the passkey
> path signs), the single `transferOwnership` owner slot
> (`rails/hybrid-signer-actions.ts`), removal disabled below two signers, and
> #1153.
>
> **Re-verified 2026-10-27 (#4474, mockup v9).** Changed, and superseding the
> two phrases above: the add-a-wallet button reads **Add a wallet** (not *Or
> add a wallet*), and **Remove is absent, not disabled, while one signer
> remains** — with two or more, every row carries it. The *Who can approve*
> heading now sits ABOVE the card with **Passkeys and wallets** as a link on
> its heading row (the link text is the owner's 2026-10-30 decision, #4563,
> superseding the mockup's *All signers in Settings*), each signer row is two lines (the kind over "Added {date}"),
> and the card's ONE footer row holds *Add a backup passkey*, *Add a wallet*
> and *Lost a device?*. Re-checked without change: the stable dev URL, the
> opt-in PR previews (#3821), the "Browser wallet" / "Show address" (#3825)
> labels, Settings → Security → *Passkeys and wallets* → *Connect wallet*
> (`components/settings/SignersSection.tsx`, untouched by #4474), the #2068
> client-side owner check (`lib/signer.ts`), the "passkey may be on another
> device" line (`PasskeyElsewhereHint`), the single `transferOwnership` owner
> slot (`rails/hybrid-signer-actions.ts`), and #1153's drop-to-one
> confirmation.
>
> **Review round 1 (haven-doc-reviewer @ `344d7ea91`).** The attribution was
> wrong: *Who can approve* came with #4142 (`git log -S'Who can approve</h2>' -- packages/frontend` →
> `fa1c20399`), and #4166 (PR #4190, `37ec8b7ba`) removed the card's
> duplicate "Backup & recovery" heading (`git log -S "Backup & recovery"` on
> `AccountSignersCard.tsx`).
```

## `docs/operations/e2e-qa-runbook.md`

<!-- sha256: 6736eeccc4c4d56ac545377442a77f09cfa44bb13d7d0fb6bce7ae10ad793bea -->
```markdown
Re-verified 2026-10-24 (#4372 part E, at dev `ee7fdd27`), a full re-read.
Changed: the mobile-viewport row no longer says the spec "gates every PR" —
the *Frontend browser smoke* job (`ci.yml`, `browser_smoke`) runs it on PRs
that touch the frontend, and the repository rulesets require that check on
`main` only (`gh api repos/d-hinders/Haven-AI/rules/branches/<branch>`).
Re-checked without change: the automated-coverage table's other rows, the
mocked-suite command, the #419 steps (no runtime picker since #1720, the
per-deployment connector package since #2422, the per-agent pair names since
#3737, the over-budget pre-checks #3503 / #2082 / #2706), the #420 steps and
edge cases, and the reporting rules.
```

## `docs/operations/hosted-mcp.md`

<!-- sha256: 917f0b4304bc3b2d6b4bc1ad808f20dedde21375eb6bcbf0bab23a77856f4093 -->
```markdown
Re-verified 2026-09-21 (weekly docs audit #3206, at dev `7f17c9f3`), 42
mcp-server commits after the last verification: every operational claim above
still matches the code: `assertHostedEnv`'s `HAVEN_DELEGATE_KEY` refusal and
message text (`boot.ts`), `HAVEN_CONNECTOR_CHANNEL` dist-tag validation
(`connector-channel.ts`), the `POST /v1` + `GET /healthz` surface
(`http.ts`, `HAVEN_MCP_PATH` in `cli.ts`), the one-line access log (`log.ts`),
the compose wiring (`docker-compose.yml` `mcp-server` service: Dockerfile
path, 8788, `depends_on`, `HAVEN_API_URL: http://backend:3001`), and the CI
job names this doc cites ("MCP server checks", "Docker build
(MCP server)"). The intervening commits (#2812 tool extraction into
`src/tools/`, #3118/#3155 the plain-HTTP x402 profile, #3102 refusal next
steps, #3126 `haven_check_funds`) changed the tool surface behind the same
HTTP and custody posture this doc describes; nothing here needed rewriting.

Re-verified 2026-10-05 (weekly docs audit #3645, at dev `c3df5b19`), a full
re-read, 50 covered commits after the last verification. The 2026-09-21
note's "every operational claim above still matches the code" was wrong; each
error below was already wrong at `7f17c9f3`, and none came from the
intervening commits:

- **Audit rows.** The doc said every tool dispatch leaves an
  `agent_tool_invocations` row. The backend records only an allowlist
  (`MCP_TOOL_NAMES`), and `haven_pay`/`haven_submit` were never on it.
- **Environment.** The variables list missed `BASE_RPC_URL`.
- **Custom domain.** The step pointed at a frontend URL generator. The hosted
  URL actually comes from the backend's `HAVEN_HOSTED_MCP_URL`, which a
  non-production backend must set.
- **Domain names.** The predicted domain `havenmcp-production-*` matches no
  deployed host.
- **Dist-tag pattern.** It lacked its 32-character cap.
- **`docker:up`.** It does not rebuild the image; `--build` does.
- **`HAVEN_DELEGATE_KEY`.** The boot refusal fires on a non-blank value, not
  on the variable merely being set.

Re-verified 2026-10-24 (#4372 part F, at dev `6d87ddf95`), a full re-read.
Changed: the Dockerfile builds `@haven_ai/core` before the SDK and the server
(`packages/mcp-server/Dockerfile`), and `npm run docker:up` also starts
`postgres` (`docker-compose.yml`). Re-checked without change: the
`HAVEN_DELEGATE_KEY` non-blank refusal (`boot.ts`), the keyless
`createHostedHavenClient` (`server.ts`), `GET`/`HEAD /healthz` answering
`{"status":"ok"}` and a missing Bearer token answering 401 (`http.ts`), the
access-log fields (`log.ts`), `HAVEN_MCP_PATH` defaulting to `/v1` (`cli.ts`),
the dist-tag pattern and `alpha` default (`sdk/src/connector-channel.ts`), the
`BASE_RPC_URL` one-confirmation wait of up to 30 s on 8453
(`sdk/src/x402-funding-leg.ts`), the hosted-URL resolution and its
non-production refusal (`routes/agent-connection-setups.ts`
`hostedMcpUrl`, reported rather than thrown by `routes/discovery.ts`), the
eight-name `MCP_TOOL_NAMES` allowlist (`middleware/agentToolAudit.ts`), the
compose port 8788, and the CI job and step names ("MCP server checks" is a
job, "Docker build (MCP server)" a step in it).
```

## `docs/operations/local-to-hosted-mcp.md`

<!-- sha256: 6f0d44937305a5a547adb0c0c516d86812cde514c047bcd28edc6132c485541c -->
```markdown
> **Re-verified #3495 (2026-09-30):** steps 2 and 3, for the compact-by-default
> result and its opt-in relay. Nothing else in this file was re-verified in
> this pass.

Re-verified 2026-10-05 (weekly docs audit #3645, at dev `cdb91d86`), a full
re-read. Changed: the hosted-URL handout (step 3 and the variables table) now
says the backend's `HAVEN_HOSTED_MCP_URL` serves both the dashboard and the
connector — the frontend variable and its not-configured state went with #1823
— which also matches `hosted-mcp.md`; the signer table and its network use name
the task- and sub-budget sign-contexts (#3329/#3330); the decline paragraph
separates a refusal from the #3495 `payload_hash: null` replay; the
troubleshooting entry no longer says a bad key empties the tool list (a live
probe of the dev hosted MCP listed every tool for an invalid key, and the first
call answered 401); and Connect Agent 2's registration names its non-secret
setup metadata. Re-checked without change: the package tags, the signer flags
and variables, the production URL default, the tool names, the erc7710
`haven_submit` header, the hosted boot refusal, step 2, and the rest of steps 3–4.

Re-verified 2026-10-24 (#4372 part E, at dev `ee7fdd27`), a full re-read.
Changed: Connect Agent 2's registration now also names the one-time setup token
and challenge id that authenticate it and its `connector_context` labels
(`packages/connect/src/api.ts`, `registerSetup`); the identity/authority/
enforcement line names the delegation's caveat enforcers instead of the retired
module; and step 5 names `haven_get_agent`, which the hosted server's
instructions tell every session to call first, alongside `haven_get_allowances`.
Re-checked without change: the package tags, the signer tool list and flags,
the hosted URL handout and variables table, the production URL default, the
erc7710 `haven_submit` header, the #3495 compact result, the custody
invariant, and the troubleshooting entries.
```

## `docs/operations/mcp-runtime-compatibility.md`

<!-- sha256: 55c1c3412f5fc92a30202e199e6895ef56e3a6bb6f72a1a2a52f6b2c4cd3a7ce -->
```markdown
> **Re-verified #4612 (2026-11-02, the bump's contract-doc guidance and the
> version-constant table):** coupled through `scripts/release-bump.mjs`,
> `scripts/release-version-constants.mjs` and their two test files. The bump's
> printed next-steps block now says a release implicates ONE contract doc that
> needs action (`casp-risk-guardrails.md`, cleared by the CASP shard) instead of
> five, and `release-version-constants.mjs` gains
> `DEDICATED_VERSION_CONSTANT_FILES` (`MCP_VERSION`) plus
> `ALL_VERSION_CONSTANT_FILES`. No tool, input schema, strict-input list,
> expected-context version, consent hash, version floor or
> `tools-list.snapshot.json` entry moves; the manifest table, the connector
> command and the setup prompt are untouched, and the bump still re-pins the
> table from the source constants exactly as this document describes.
> `last-verified` is not re-stamped for a guidance-only note. Nothing else in
> this document was re-verified.

> **Re-verified #4570 (2026-10-31, copy only in the connect flow's waiting
> screen):** the one covered file this slice touches is
> `packages/frontend/src/components/connect-agent/WaitingForConnector.tsx`, and
> the change is the manual-credential button's busy label — `Creating
> credentials...` becomes `Creating credentials…` (U+2026, copy-guidelines
> § Busy and retry copy). No tool, input schema, strict-input list,
> expected-context version, consent hash, version floor or
> `tools-list.snapshot.json` entry moves; the connector command, the setup
> prompt and the runtime manifest are untouched. The same slice's other edits
> (the shared confirmation dialog's busy label and error slot, the contact and
> company-details confirmations, the connect flow's inline close guard, the
> "signers" wording and the British spellings) are outside this document's
> covered surfaces. `last-verified` is not re-stamped for a copy-only note.
> Nothing else in this document was re-verified.

> **Re-verified #4577 (2026-10-30, the parent-receipt field on the receipts
> wire and the SDK):** covered surfaces change ADDITIVELY, and no tool, input
> schema, strict-input list, expected-context version, consent hash, version
> floor or `tools-list.snapshot.json` entry moves.
>
> - `packages/sdk/src/types.ts` — `HavenPaymentReceipt.parentReceiptId` and
>   `RawHavenPaymentReceipt.parent_receipt_id` are added, both optional. The
>   value is the parent purchase receipt's `id` (the
>   `machine_payment_evidence` row id of the purchase leg a fee call paid for),
>   which is what `parentPaymentId` already carried under a name that said
>   "payment". `parentPaymentId` keeps mapping the same value and is now
>   `@deprecated`; it is NOT removed, because 0.13.0-alpha.0 shipped it and
>   removal is a breaking change needing its own release decision.
> - `packages/sdk/src/payment-mappers.ts` — one new block-form mapping
>   (`receipt.parentReceiptId = raw.parent_receipt_id`), per-row: a backend that
>   does not send the key leaves it ABSENT, never a fabricated `null`. The
>   existing `parent_payment_id` block is unchanged.
>
> **Version skew.** A local `@haven_ai/mcp` or `@haven_ai/connect` older than
> this change pins the previous SDK exactly, so it keeps the old receipt shape
> (no `parentReceiptId`) until it is updated; the hosted server picks the SDK
> change up on deploy. Nothing is refused in either direction — the change is
> additive and optional on a type that is only returned, so existing consumers
> keep compiling. `last-verified` already reads 2026-10-30 from the release note
> below, so it is not re-stamped for this note. Nothing else in this document
> was re-verified.

> **Re-verified (0.13.0-alpha.0 release, 2026-10-30):** the Supported Runtime
> Manifest table's four rows move to `0.13.0-alpha.0`, and that is the whole of
> this release's effect on the table. Re-read against the source constants
> rather than the bump's own rewrite: `MCP_VERSION`
> (`packages/mcp/src/server.ts:113`), `CONNECTOR_VERSION`
> (`packages/connect/src/runtime.ts:56`), `SIGNER_VERSION`
> (`packages/signer/src/tools.ts:70`) and `SDK_VERSION`
> (`packages/sdk/src/client-identity.ts:20`) all read `0.13.0-alpha.0`. Only
> `mcpVersion` is derived from a constant (`runtime-manifest.ts:13` reads
> `MCP_VERSION`); `sdkVersion` and `signerVersion` are literals the bump
> re-pins (`:15`, `:17`). The Node floor is unchanged at `>= 22.0.0`.
>
> **What the release carries.** Re-measured at the door (`origin/dev`
> `745d4ebf`), the shipped delta is 16 files, +162/−20, over 14 commits:
> `sdk` 7, `connect` 3, `cli` 2, `mcp` 2, `signer` 2. Ten of those are the
> bump's own version literals, which is why every package appears at the door
> and only `sdk` appeared at the cut. The substantive changes, all already
> recorded above and none re-litigated here:
>
> - **#4534, the purchase correlation key** — two OPTIONAL inputs on
>   `reportX402MerchantOutcome` (`purchaseGroupId`, `merchantResponse`) and two
>   additive receipt fields (`purchaseGroupId`, `parentPaymentId`). Its own note
>   is at the end of this document.
> - **#4530, `PaymentStatusResult.merchantSettlementTxHash`** — additive and
>   optional on a type that is only returned, so existing consumers keep
>   compiling. It names the settlement transaction Haven recorded, under the
>   same presence rule as `merchantSettlementRecorded`: present only when
>   recorded, absent otherwise, never `null` and never the merchant's
>   unverified echo.
>
> - **#4550, canonical low-s EIP-3009 bridge signatures** — a new
>   `test-support/low-s.ts` entry asserting the wire bytes of a 65-byte EOA
>   signature, plus `@x402/core` moving from `2.17.0` to `2.29.0` in the
>   **devDependencies** of `sdk`, `signer` and `backend`. Test fixtures and a
>   build-time pin; no signing path changes.
>
> **What did NOT move.** No tool is added, renamed or removed. No input schema
> changes beyond #4534's two optional arguments, which are already in
> `tools-list.snapshot.json` from that PR. No strict-input list, no
> expected-context version, no consent hash, no version floor. The
> `next-arguments-corpus.json` DOES move in the range — #4530's prefill adds
> `payment_header` to three settlement-evidence rows and adds two rows, which
> the note at the end of this document already records; the bump itself does
> not touch it. `@haven_ai/mcp`, `@haven_ai/signer`,
> `@haven_ai/connect` and `@haven_ai/cli` ship version literals over otherwise
> byte-identical contents, which is why the bump moves all five and only `sdk`
> carries a substantive change.
>
> **Version skew.** A local `@haven_ai/mcp` or `@haven_ai/connect` older than
> this release pins the previous SDK exactly, so it keeps the old receipt and
> status shapes until it is updated; the hosted server picks the SDK change up
> on deploy. Nothing is refused in either direction — both changes are
> additive. `last-verified` is re-stamped to 2026-10-30 for this note.

> **Re-verified #4541 (2026-10-29, the release-records shipped-delta drafter):**
> no covered runtime surface changes. The diff adds a new measurement script
> under `scripts/ci` and its `node --test` suite, a `release:records` entry in
> `package.json`, and a section in the covered `scripts/README.md` describing
> them. The script reads `release:scope --json` and prints the CASP shard's
> shipped-delta figures; it touches no package source, no tool name, input
> schema, strict-input list, expected-context version, consent hash or
> `tools-list.snapshot.json` entry, and no version literal the Supported
> Runtime Manifest table pins. Nothing else in this document was re-verified,
> and `last-verified` is re-stamped to 2026-10-29 for this note.

> **Re-verified #4468 (2026-10-27, the ten typed task-/sub-budget
> payment-scope refusals and three siblings):** covered surfaces change
> additively, and one wire field changes VALUE for ten codes. (1)
> `packages/mcp-server/src/tools/support/errors.ts` — `normalizeError` gains
> one table-driven branch ahead of the generic `HavenApiError` pair, keyed on
> the shared `@haven_ai/core` code list. The ten codes (`task_budget_` and
> `sub_budget_` × `not_found`, `not_open`, `token_mismatch`,
> `recipient_mismatch`, `parent_mismatch`) now answer their own hosted `code`
> (the backend code upper-cased), the backend's `error_code` at the top level,
> `next_action: stop_and_tell_user` and a reason naming that code's remedy.
> Before, all ten fell into the generic 4xx branch as `code: "API_ERROR"` with
> no `error_code`, so the typed reason survived only as English in `message`.
> (2) The same file gains a branch for `task_budget_exceeds_remaining` (409)
> relaying `remaining_atomic`, `reserved_atomic` and `requested_atomic`. (3)
> `packages/mcp-server/src/tools/state-direct-recovery.ts` — `haven_submit`'s
> task-budget path now maps `close_needs_reprepare` (409) and
> `close_outcome_unconfirmed` (502) to typed refusals naming
> `haven_close_task_budget` with `task_budget_id`, the shape the sub-budget
> path has had since #3506. (4) `packages/mcp-server/src/tools/contracts.ts` —
> `ToolFailure` gains an optional `error_code`. (5)
> `packages/core/src/budget-refusal-codes.ts` (new) holds the code unions and
> their status tables; the backend's `modules/budget-scope/resolver.ts`
> re-exports them, so the backend's wire statuses are unchanged. (6)
> `packages/mcp-server/src/test-support/next-step-fixtures.ts` and
> `next-arguments-corpus.json` — the census moves to 78 refusal fixtures and
> 79 `refusalNextStep` calls, and the corpus golden gains the thirteen rows.
>
> **Wire effect.** `code` is a wire field, so an agent on an older hosted
> server still sees `API_ERROR` for these ten codes; a new hosted server
> against an older backend sees the same bodies (the codes and statuses are
> unchanged) and answers them typed. `error_code` is additive: absent on every
> other branch, and the generic branch deliberately does not relay it (that
> decision belongs to #4470, which edits the same branch). No tool name, input
> schema, strict-input list, expected-context version, consent hash or
> `tools-list.snapshot.json` entry changes — the tools/list golden is
> byte-identical. Nothing else in this document was re-verified, and
> `last-verified` is re-stamped to 2026-10-27 for this note.

> **Re-verified #4415 (2026-10-25, stale comment sweep):** the only covered
> file this diff touches is `packages/signer/src/cli-args.test.ts` — one test
> TITLE now says "a sixth tool" (the signer library exposes five tools, so a
> new one is the sixth), and the `:35` floor assertion is raised from
> `toBeGreaterThanOrEqual(4)` to `toBeGreaterThanOrEqual(5)` — the one test
> change that is not a title. The `:38` `toHaveLength(registered.length)`
> bullet-count pin is unchanged and still pins `--help` against
> `Object.keys(toolSchemas)`. No signer source, help text, consent
> input or protocol surface changes. Every other file in the diff is outside
> this document's coverage. Nothing else in this document was re-verified,
> and `last-verified` is not bumped.

> **Re-verified #4352 (2026-10-23, the additive `budget_ended_at` /
> `budgetEndedAt` read):** two covered surfaces change. The backend
> machine-payments allowances read adds ONE top-level response field (the
> latest ended budget's expiry, null unless an expired row exists — the
> same narrow query the refusal answers use), and
> `packages/sdk/src/account-reads.ts` maps it and derives `budgetEndedAt`
> on `getAgentSummary()` for an agent whose only budgets have ended. Additive both ways: an older backend's
> rows omit the key and map to `null`; the readiness values, the
> tools/list shape (one description sentence) and every other response
> field are unchanged, so local and hosted surfaces stay in lockstep — the
> hosted `haven_get_agent` description moves with the SDK's
> `tool-descriptions.ts` in the same commit, and the
> `tools-list.snapshot.json` golden is regenerated in the same commit.
> Description budget round 30: the new sentence is offset inside the same
> description, total unchanged at 31,812. Nothing else in this document was
> re-verified, and `last-verified` is re-stamped to 2026-10-23 for this
> note.

> **Re-verified #4458 (2026-10-26, the typed `delegation_expired` body and the
> hosted readers that branch on it):** four covered surfaces change, all
> additively. (1) `packages/backend/src/modules/x402/delegation-authorize.ts`
> — both authorize legs now answer an expired-only budget with the typed 403
> body (`error_code: "delegation_expired"`, `phase`, `next_action`,
> `budget_ended_at`, `remaining`/`remaining_atomic` `"0"`, amount/shortfall,
> `rail`, `network`, `resource_url`, `merchant_address`) instead of a one-line
> `{ error }`; the decision is unchanged (403, one `payment_refusals` row,
> nothing created or signed), and on the EIP-3009 funding leg
> `merchant_address` is `merchantPayTo`, never `payTo`. (2)
> `packages/mcp-server/src/tools/**` — the quote pre-check, the catalog prepare
> preflight and the shared error normaliser recognise a 403 with that code and
> stop with the owner-sets-a-new-budget remedy; the quote warning is the new
> additive `QUOTE_BUDGET_ENDED` code. (3) `packages/sdk/src/types.ts` gains
> that one `AgentPaymentWarningCode` member — additive, so a client that
> switches over the enum keeps compiling and an older backend never emits it.
> (4) `packages/mcp-server/src/server.ts`'s instructions gain the ended-budget
> cause for `safe_to_continue: false`; the `tools/list` payload is unchanged,
> so `tools-list.snapshot.json` and the description budget do not move. An
> older hosted server against a new backend ignores the extra body fields and
> keeps its previous (fail-open) behaviour; a new hosted server against an
> older backend never sees the code and degrades exactly as before. Nothing
> else in this document was re-verified, and `last-verified` stays
> 2026-10-26.

> **Re-verified unchanged (#4327, 2026-10-23, the CSV export's response
> plumbing moves into `packages/backend/src/domain/csv.ts`).** Two covered
> files change: `packages/backend/src/routes/transactions.ts` and
> `packages/backend/src/modules/transactions/csv-export.ts`. The export row
> cap, the 413 body, the CSV headers, the BOM and the dated filename leave
> them for one shared helper, which a second export (the agent Activity
> ledger, `GET /agent-activity/{id}/activity/export.csv`) also uses.
> `GET /transactions/export.csv` answers the same bytes: a characterization
> test written before the move pins its exact 413 body and its exact success
> headers, and the route's existing tests pass unchanged; the column set and
> quoting are untouched. No runtime package (`packages/cli`, `packages/mcp`,
> `packages/mcp-server`, `packages/sdk`, `packages/signer`,
> `packages/connect`) calls either export. No tool, argument, input schema,
> expected-context version, consent surface or runtime channel moves.
> `last-verified` is not re-stamped: this block is the scope. Nothing else in
> this document was re-verified.

> **Re-verified unchanged (#4328, 2026-10-23, a comment-only path reference in
> `packages/backend/src/modules/transactions/csv-export.ts`).** The only
> covered file this PR touches is
> `packages/backend/src/modules/transactions/csv-export.ts`: its doc comment
> named the frontend helper module by its old path (`lib/transaction-csv.ts`)
> and now names the moved one (`lib/csv-export.ts`, part of the #4328 shared
> export action slice). The CSV column contract, the quoting rules and every
> byte of the generated file are unchanged — the CLI and MCP consumers read
> the same output. No tool, argument, input schema, expected-context version,
> consent surface or runtime channel moves. Scope: the comment-only edit
> only; `last-verified` is re-stamped to 2026-10-23 for this note. Nothing
> else in this document was re-verified.

> **Re-verified unchanged (#4319, 2026-10-23, a comment-only doc comment in
> `packages/backend/src/modules/payments/agent-payment-status.ts`).** The only
> covered file this PR touches is `agent-payment-status.ts`: the #3475 doc
> comment above `merchant_settlement_recorded` gains one clause naming the
> #4319 proof ladder (Tier 1/Tier 2 on the generic attach path and the
> backfill) among the writers of the recorded hash. Wording only: no
> interface field, type, route, status predicate, `haven_*` tool schema,
> strict-input list, `next_tool` value or expected-context version moves, and
> the signer contract is untouched. Scope of this note: that one comment.
> Nothing else in this document was re-verified, and `last-verified` already
> reads 2026-10-23 and is left as is.

> **Re-verified unchanged (#4315, 2026-10-23, a comment-only doc comment in
> `packages/signer/src/audit.ts`).** The only covered file this PR touches is
> `packages/signer/src/audit.ts`: the #3728 doc comment above the
> `domain`/`nonce` fields is reworded to no longer name the retired
> `safe_address` token (it now refers to the persisted serialized key declared
> above instead); the serialized key itself, the `SigningAuditEntry`
> interface and every behavior are unchanged. The rest of the PR is CI-only
> census plumbing under `scripts/ci/` (the `ALLOWED_CEILING` comparison is
> exported and asserted in `safe-account-rename-census.test.mjs`), none of it
> on this contract's cover list. No MCP tool, argument, input schema, signing
> input, expected-context version, consent hash, runtime channel or release
> step moves. Scope: the comment-only `audit.ts` edit only;
> `last-verified` is re-stamped to 2026-10-23 for this note. Nothing else in
> this document was re-verified.

> **Re-verified unchanged (#4265, 2026-10-22, transaction-feed client
> compatibility):** the covered transaction routes accept the optional
> `foldOwnTransfers` query parameter only on the aggregate JSON and CSV reads.
> The CSV projection appends `to_account_name` only for that opt-in request;
> its default column set is untouched. The covered published CLI sends no flag
> and keeps its existing local CSV behavior.
> No MCP tool, argument, input schema, signing input, expected-context version,
> consent hash, runtime channel or release step moves. Scope: the transaction
> feed/export compatibility claims only; `last-verified` is not re-stamped.

> **Re-verified unchanged (#4271, 2026-10-22, a new self-test step in
> `ci_config_checks`).** The only covered file this diff touches is
> `.github/workflows/ci.yml`: one step ADDED after the design-lint self-test
> in `ci_config_checks` — a `node --test` run of the dependency-free
> self-test of the `test:local` watchdog wrapper (#4271; a new file under
> `packages/frontend/scripts/`, driven by a stub child, never vitest, and
> importing no package in this repo). No job, env value, literal, condition
> or existing step moves, and no covered tool, schema,
> `tools-list.snapshot.json` entry, description budget, channel, dist-tag,
> release step or consent surface is touched by it. The wrapper itself is
> frontend-local (same new `packages/frontend/scripts/` directory) and on no
> cover list, as is its package.json script. `last-verified` is re-stamped
> to 2026-10-22 for this note; this block is the scope. Nothing else in
> this document was re-verified.

> **Re-verified unchanged (#4244, 2026-10-22, merchant-transport only).**
> `packages/sdk/src/mcp-merchant-transport.ts` and `merchant-egress.ts` are on
> this contract's cover list. Under a merchant-egress policy, a GET redirect
> hop that changes origin now sends only an allow-list of caller headers
> (`accept`, `accept-language`, `user-agent`, `x402-wallet`); same-origin hops
> and the no-policy path are unchanged. No tool is added, renamed or
> re-shaped; no strict schema, consent hash, version-skew rule or signing
> input moves. `last-verified` is not re-stamped: this block is the scope.

> **Re-verified unchanged (#4121, 2026-10-20, a `ci.yml` comment counts the
> qa-agent test files that import the built signer):** the only covered file
> this diff touches is `.github/workflows/ci.yml`, and the change inside it is
> comments only: the two `qa_agent_checks` comments above the sibling builds
> and `Run QA agent unit tests` now say that the suite's globalSetup asserts
> the signer `dist` fresh as well as the SDK's, and that 3 test files cannot
> resolve `@haven_ai/signer` without it (`src/evals/tools.test.ts` joined the
> two hosted-signer scenario tests, which `vi.mock` it), where they said 2.
> No step, job, env value, literal or condition moves. The covered
> `tools-list.snapshot.json` and the signer's `toolSchemas` are READ by that
> new qa-agent test, never edited, so no tool, argument, input schema,
> description, channel, dist-tag, release step or consent surface moves. The
> change classifier gains a file arm that also routes `qa_agent` for a
> snapshot change; the `mcp_server` job it already ran is unchanged.
> `last-verified` is not re-stamped for this note: its 2026-10-20 is the
> #4123 note's stamp below, and this block is the scope. Nothing else in this
> document was re-verified.

> **Re-verified (#4123, 2026-10-20, the retryable settlement-evidence reasons
> name `payment_header`):** reason text only, in two covered files under
> `packages/mcp-server/src/tools/**`. When an EIP-3009 merchant settlement
> report comes back retryable (Haven could not read the transaction yet), the
> three hosted reasons that told the agent to report "the same hash" again
> now also tell it to add `payment_header`, which the backend requires before
> it judges the hash (#3925; without it a verbatim retry is refused once with
> `SETTLEMENT_PROOF_HEADER_MISSING`):
>
> - **`haven_settle_mcp_tool` / `haven_complete_mcp_tool`**, eip3009 settled
>   arm (`paid-mcp-completion.ts`, `settlementEvidenceReason`): "Call
>   next_tool (haven_report_settlement_evidence) shortly with next_arguments,
>   adding payment_header: the exact payment_header you passed to this
>   call." These tools sent the merchant the header the agent
>   passed them, as the missing-header arm beside it already says.
> - **`haven_report_x402_outcome`**, folded evidence (`plain-http-x402.ts`,
>   `evidenceReason`): "Call next_tool (haven_report_settlement_evidence)
>   shortly with next_arguments, adding payment_header: the exact
>   payment_header you sent the merchant." Unconditional: a pending erc7710
>   report is refused before the evidence report (`erc7710OutcomeRefusal`),
>   and a confirmed one, which does reach it, cannot come back retryable —
>   the backend answers 503 only for `settlement_unobservable` (the
>   pending-erc7710 seam or the eip3009 branch), and the confirmed-erc7710
>   attach path answers 202/409. Even a stray 503 leaves the text harmless:
>   the report tool it names drops the header on any non-eip3009 payment.
> - **`haven_report_settlement_evidence`**, `SETTLEMENT_PENDING`
>   (`classifySettlementEvidenceReport`): "Report it again shortly with
>   haven_report_settlement_evidence and the same hash — on an EIP-3009
>   payment adding payment_header: the exact payment_header you sent the
>   merchant — or poll next_tool." Scoped to EIP-3009 because an erc7710
>   report reaches this arm too: the backend's erc7710 seam answers 503 on an
>   unreadable chain.
>
> `next_tool`, `next_action` and `next_arguments` are byte-identical on all
> three, so `next-arguments-corpus.json` does not move. That is deliberate:
> `check-stale-client-compat.mjs` validates the corpus against `origin/main`'s
> tools/list snapshot, where `haven_report_settlement_evidence` takes only
> `payment_id` and `settlement_tx_hash` with `additionalProperties: false`, so
> a prefilled `payment_header` waits until #4061's schema is on `main`. No tool
> description, input schema, `tools-list.snapshot.json` entry or contract
> fingerprint moves, and `packages/sdk/src/tool-descriptions.ts` is untouched
> (the description budget is at its cap) — so its
> `haven_report_settlement_evidence` description still says "report the same
> hash again shortly" for `SETTLEMENT_PENDING` (`tool-descriptions.ts:267`), a
> known fourth copy left for the post-promotion `payment_header` prefill
> follow-up. No Supported Runtime Manifest row,
> channel, dist-tag, release step, expected-context version or consent surface
> moves; the hosted surface picks this up on deploy, and an older local MCP or
> signer is unaffected. Ship before the next `dev → main` promotion, so the
> header requirement and this guidance reach prod together. The #3764 block
> below stays as written. `last-verified` is bumped to 2026-10-20 for this
> note. Nothing else in this document was re-verified.

> **Re-verified unchanged (#4094, 2026-10-19, a `ci.yml` comment names the
> merged Receive dialog):** the only covered file this diff touches is
> `.github/workflows/ci.yml`, and the change inside it is comments only: the
> `frontend_checks` build's explanatory comment about
> `NEXT_PUBLIC_COINBASE_ONRAMP_APP_ID` now says the reader is
> `ReceiveDialog.tsx` (#4094 merged `AddFundsModal` and `ReceiveFundsModal`
> into it) instead of the deleted `AddFundsModal.tsx`. No step, job, env
> value, literal or condition moves — the fixed synthetic onramp literal the
> comment explains is byte-identical — so no CI surface, channel, dist-tag,
> release step or consent surface moves. `last-verified` stays 2026-10-19
> for this note. Nothing else in this document was re-verified.

> **Re-verified (#4079, 2026-10-19, check_funds wording):** `haven_check_funds`
> answers `covered: false` whenever a live chain read reports LESS than the
> checked amount, not only an empty account, so its wording now says that:
> the `next_step` in `packages/mcp-server/src/tools/state-direct-recovery.ts`
> ("The account holds less than the checked amount (how much less is not
> returned) — stop and tell the user the account is short …"), the hosted
> description in `packages/mcp-server/src/tools/contracts.ts` ("stop and tell
> the user the account is short", one byte shorter) and the SDK description in
> `packages/sdk/src/tool-descriptions.ts`. Text only: the `covered`
> true/false/null contract, the stop instruction, every field, argument and
> input schema, and the backend route are unchanged; the tools/list contract
> snapshot moves by that one description string and is regenerated. No
> Supported Runtime Manifest row, channel, dist-tag or release step moves, so
> the version-skew contract does not move; an older local MCP or signer is
> unaffected. Nothing else in this document was re-verified in this pass.

> **Re-verified (#4061, 2026-10-19, `payment_header` on the settlement
> reports):** this changes the hosted tool contract additively.
>
> - **New argument.** `haven_report_x402_outcome` and
>   `haven_report_settlement_evidence` gain an optional `payment_header`
>   (string, 1–16,384 chars). It is forwarded only on the eip3009
>   merchant-settlement report it proves: a hash other than the payment's
>   funding hash. The evidence tool checks the payment's status first (one
>   extra read, made only when `payment_header` is passed).
> - **Descriptions.** The two report tools, `haven_pay_x402_quote`,
>   `haven_resume_x402_payment`, and the signer's `haven_sign_x402` now say
>   to pass it.
> - **Snapshot and fingerprint.** `tools-list.snapshot.json` and the contract
>   fingerprint move.
> - **Corpus.** `next-arguments-corpus.json` gains two emissions, each naming
>   `haven_report_settlement_evidence` with `{ payment_id,
>   settlement_tx_hash }`.
> - **Stale-client check.** `check-stale-client-compat.mjs` reports no
>   reconnect-required change against `origin/main` or `origin/dev`.
>
> Interoperation:
>
> - **A stale client** loses only the new argument. Its EIP-3009 settlement
>   reports stay refused, now with the typed
>   `SETTLEMENT_PROOF_HEADER_MISSING` answer and its re-report handoff,
>   until it reloads `tools/list`.
> - **A new hosted server against a backend that predates #3925** (`main`):
>   the backend accepts `paymentProofHeader` on the evidence route and does
>   not read it on the eip3009 branch, so it records as before.
> - **An older hosted server against a current backend:** it keeps the
>   refusal it already had.
>
> No Supported Runtime Manifest row, channel, dist-tag, release step or
> consent surface moves. `last-verified` is bumped to 2026-10-19 for this
> note. Nothing else in this document was re-verified.


> **Re-verified unchanged (#4065, 2026-10-19, the frontend's onboarding-prompt
> copy deleted):** `/agents` now renders the connect flow inline for a user
> with no agents, so the "Set up with your AI agent" card and the frontend's
> byte-pinned copy of `AGENT_ONBOARDING_PROMPT`
> (`packages/frontend/src/lib/agent-onboarding-prompt.ts`) had no consumer and
> were deleted; the path leaves this doc's `covers:`. In the covered
> `packages/sdk/src/agent-guidance.ts` only a doc comment changes (it no
> longer claims a frontend copy); the published `AGENT_ONBOARDING_PROMPT`
> export, every runbook string and every byte-pinned copy that remains are
> byte-identical. No Supported Runtime Manifest row, channel, dist-tag,
> release step, tool, argument, input schema, description or consent surface
> moves, so the version-skew and consent-hash contracts do not move.
> `last-verified` is not re-stamped: this block is the scope. Nothing else in
> this document was re-verified.

> **Re-verified unchanged (#4095, 2026-10-19, the transactions feed and export
> gain FilterBar query parameters):** this diff touches one covered file,
> `packages/backend/src/routes/transactions.ts` (and the transactions module
> beside it), with an additive READ-only change: `GET /transactions` and
> `GET /transactions/export.csv` accept optional `direction`, `chainId`,
> `search`, `period`, `from`, `to` and `tz` query parameters, applied
> server-side before paging — the browser previously filtered direction and
> network in memory over the loaded page only. An absent parameter is no
> filter, so the CLI's `GET /transactions` calls
> (`packages/cli/src/commands.ts`, sending none of them) return unchanged
> results, and no MCP tool, tool argument, input schema, description,
> expected-context version or consent surface moves. The CSV export's columns
> and quoting are byte-identical (`modules/transactions/csv-export.ts` is
> untouched); only WHICH rows the file holds narrows, under the caller's own
> filters. `last-verified` is not re-stamped: this block is the scope.
> Nothing else in this document was re-verified.

> **Re-verified unchanged (#4023, 2026-10-16, per-account deploy salt):** this
> diff touches one covered file,
> `packages/backend/src/modules/x402/delegation-authorize.ts`, in a six-line
> rename: the counterfactual deploy helper it calls became
> `ensureDelegateHybridDeployed` because #4023 split the rails entry point
> into a salted USER-account arm and a literal-`'0x'` DELEGATE-account arm —
> and the x402 authorize path is the DELEGATE arm. Its behaviour is
> unchanged: the same fail-closed getBytecode short-circuit before the intent
> row exists, the same ownerAddress-only derivation, the same relayer
> attribution, and every response shape the hosted tools parse is
> byte-identical. No Supported Runtime Manifest row, channel, dist-tag,
> release step, tool, argument, input schema, description or consent surface
> moves, so the version-skew and consent-hash contracts do not move. An older
> hosted server and an older backend interoperate exactly as before.
> `last-verified` is bumped to 2026-10-16 for this note. Nothing else in this
> document was re-verified.

> **Re-verification (#3886, 2026-10-10, the golden caught up):** #3839
> (#3855) added funding-leg sentences to the `haven_discover_tools`
> description after #3817's golden was committed, so the snapshot test went
> red on every PR that routes to `mcp_server_checks`, and on the `dev` pushes
> that routed to it (#3855's own merge and #3875's) — `dev` showed green only
> when a later push skipped the job. The golden was regenerated with
> `snapshot:regen`; the one changed line is that description, already served
> since #3855. Description-only, so the stale-client check stays silent by the
> rule above; nothing else in this document moves.

> **Re-verification (#3924, 2026-10-14, a new CI step beside the ratchets):**
> `.github/workflows/ci.yml` gains one `backend_checks` step —
> `npm run lint:budget-liveness` + its self-test, the shrink-only census over
> inline budget-liveness predicates (#3924, epic #3919 slice E), wired beside
> `lint:request-schemas`. It is a lint over source text: no tool is added,
> renamed or re-shaped, no argument, schema, description or consent input
> changes, and the version-skew and consent-hash contracts do not move.

> **Re-verification (#3940, 2026-10-14, the job-summary how-to line):**
> `scripts/ci/check-stale-client-compat.mjs`'s reconnect-required summary
> line now points connected agents at this document's reconnect rule —
> restart or reconnect the session; a reconnect keeps credentials, agent id
> and budget, and a prepared or funded payment resumes on its `payment_id`
> — via the absolute GitHub URL a job summary needs, instead of naming the
> destructive `haven-reset` skill as the how-to. The sentence is exported
> (`RECONNECT_HOWTO`) and pinned by its test. The measuring instrument's
> logic — corpus and snapshot validation, the silence rules above — is
> unchanged, so no skew rule in this document moves.

> **Re-verification (#3922, 2026-10-14, additive `is_live`).** The SDK
> (`account-reads.ts`, `types.ts`) and the CLI (`commands.ts`) read a new
> additive wire field, `is_live`, on budget rows. Each falls back to its
> previous derivation when an older backend omits it:
> - the SDK task-budget summary and the CLI grant wait both fall back this
>   way;
> - the CLI revoke refusal stays status-based and never reads the field.
>
> So every client/backend skew pair keeps working. No tool, description,
> input schema or signer surface changes, so the contract fingerprint does
> not move. One output field is added: every `task_budget` result
> (`haven_open_task_budget`, `haven_close_task_budget`, `haven_submit` for a
> task budget, and `haven_get_task_budget`; hosted and local) carries an
> additive `isLive`, absent against an older backend. Nothing else in this document moves.

> **Re-verification (#3923, 2026-10-14).** Against an older backend that
> sends no `is_live`, the SDK summary's task-budget filter now drops an
> expired `closing` row as well, matching the backend's `status=live` since
> #3773. A current backend already omits that row, so nothing visible
> changes there. No tool, description, input schema or wire field changes,
> so the contract fingerprint does not move.

> **Re-verification (#3839 follow-up via #3864, 2026-10-10, hosted
> `haven_discover_tools` description golden regen):** #3839 (22f49edd)
> rewrote the hosted `haven_discover_tools` description in source (adding the
> `funding_leg_expected` selection guidance) but missed the
> `tools-list.snapshot.json` regen, leaving `tool-contract-snapshot.test.ts`
> red until the golden was regenerated (`npm run snapshot:regen -w
> packages/mcp-server`) on this branch. The description delta is exactly the
> three guidance sentences the #3839 section above already documents
> ("funding_leg_expected is a catalog hint…", "A recipient-pinned budget can
> pay erc7710 merchants only.", "The quote's expected_funding_leg is
> authoritative."); tool name, schema, arguments and strict-input decision are
> untouched, and descriptions are not a skew axis (#2330 precedent). This
> document already described the new sentence at #3839 and does not
> contradict it, so no rule text moves; this entry is the re-verification
> touch, not a contract change. `last-verified` stays 2026-10-10. Nothing else
> in this document was re-verified.

> **Re-verification (#3838, 2026-10-09, wording-only `haven_pay_x402_quote`
> description edit):** the local tool's sign-in-with-x sentence was rewritten
> (sign in FIRST for multi-call flows; the merchant session token never
> reaches the quote tools) at the same 434-byte length — byte-neutral against
> the #1591 ratchet, re-measured green. No Supported Runtime Manifest rule,
> version-skew contract, consent-hash or hosted-runtime statement in this
> document moves: descriptions are not a skew axis (#2330 precedent), the
> tool's schema, arguments and response shapes are unchanged, and the
> sign-in guidance itself lives in the SDK skill copy mirrored byte-pinned
> into the frontend bundle. `last-verified` stays 2026-10-09. Nothing else in
> this document was re-verified.

> **Re-verification (#3819, 2026-10-09):** coupled through
> `.github/workflows/publish.yml`: the dependency-presence ledger
> (`dep_state`) is now a space-delimited `pkg=state` string with an
> exact-word `case` lookup instead of a bash-4 associative array, making the
> loop bash 3.2 compatible (#3819). No Supported Runtime Manifest rule,
> version-skew contract or hosted-runtime statement in this document moves:
> the hold-back / FAILED / never-nominated behaviour is identical on bash 5
> and bash 3.2. Verified by `release-bump.test.mjs` (102/102), including a
> real GNU bash 3.2.57 container run.

> **Re-verification (#3797, 2026-10-09):** coupled through
> `.github/workflows/publish.yml`, which gains a dependency-presence gate (a
> package whose internal `@haven_ai/*` dependency did not publish in the same
> run is held back, not published, not nominated for `latest`). No Supported
> Runtime Manifest rule, version-skew contract or hosted-runtime statement in
> this document moves: the gate only narrows which packages reach npm in a
> single run, and the re-run remedy is unchanged. Verified by
> `release-bump.test.mjs` (102/102).

>
> **Re-verified #3781 (2026-10-08, the catalog tier of the purchase label):**
> a settled purchase that came from a catalog entry now reports the catalog
> row's name as the purchase label, not the `<merchant host> <tool_name>`
> label a direct pay gets. `haven_prepare_catalog_purchase` persists the
> row's `name` as optional `catalogName` on the stored `mcp_call_context`
> (both scheme branches — one shared object); `POST /x402`'s enforced request
> schema accepts the optional key (previously refused outright under
> `additionalProperties: false`); `GET /x402/{id}/merchant-call-context`
> re-serves it snake_case as `catalog_name`; and the settle leg prefers the
> rehydrated `catalogName` over the host+tool label in `purchaseFallbackLabel`
> (`packages/mcp-server/src/tools/paid-mcp-completion.ts`).
> - **Precedence is unchanged, and #1349 with it.** The merchant's
>   `product_name` still wins in both cases; the catalog name is only the
>   first tier of the Haven-derived gap filler. A direct
>   `haven_pay_mcp_tool` purchase carries no `catalogName` and keeps the
>   host+tool label (#3771 pinned) — and a catalog row is Haven's own data,
>   so the tier stays Haven-derived, never merchant content.
> - **No contract moves.** No tool is added, renamed or re-shaped; the new
>   schema key is optional, additive, `minLength: 1`, and refused nowhere it
>   worked before; the endpoint response gains one optional key under its
>   existing closed schema; no migration (the context is a JSONB blob), and
>   the version-skew, consent-hash and expected-context contracts do not
>   move. An older settle leg simply ignores the extra rehydrated key.
>
> `last-verified` stays 2026-10-08. Nothing else in this document was
> re-verified.

> **Re-verified #3770 (2026-10-08, delivery-quality report):** the hosted
> surface gains one tool, `haven_report_delivery_quality { payment_id, quality,
> note? }` — the agent's evidence-only verdict on what a settled payment
> DELIVERED (`ok` / `unusable` / `partial`, note bounded at 2000). It joins
> `PAID_MCP_COMPLETION_TOOLS` and `STRICT_INPUT_TOOLS`: the rail, amount and
> merchant are read from the payment record scoped to the calling agent, so a
> report cannot be pointed at another agent's payment (404) or an unsettled
> one (409). The description-size ratchet re-measures at 29,863 bytes over 29
> tools (mean pin 1029.76, shrink-only from here).
> - **No consent-hash event.** The tool is hosted-only — the local signer's
>   tool set, `SIGNER_CONSENT_SURFACE_VERSION` and the signer consent hash are
>   untouched, and the signer and connect packages do not change.
> - **Wording-only description edits.** `haven_complete_mcp_tool` and
>   `haven_settle_mcp_tool` gain one next-action sentence naming the report;
>   no input or output schema, argument, expected-context version or consent
>   surface moves, and the strict-input count goes 26 → 27 with the same
>   per-tool rationale as its siblings.
> - **An older build keeps working.** Without the tool the agent simply has
>   no way to record a verdict — exactly the #3770 gap — and nothing it could
>   do before is refused or re-shaped.
>
> `last-verified` stays 2026-10-08. Nothing else in this document was
> re-verified.

> **Re-verified #3771 (2026-10-08, purchase_summary.product fallback):** a
> settled result whose merchant payload names no product — no
> `structuredContent.summary` — no longer leaves `purchase_summary.product`
> null: it falls back to the Haven-derived `<merchant host> <tool_name>` label
> built from facts the settle call already holds — the merchant URL the
> resolved call context was resolved against and the tool that was called
> (`purchaseFallbackLabel`, `packages/mcp-server/src/tools/paid-mcp-completion.ts`);
> a URL that will not parse (or none) falls back to the tool name alone.
> Both settled arms pass it — erc7710 AND EIP-3009, through
> `haven_settle_mcp_tool` and `haven_complete_mcp_tool` — and
> `agent_summary.product` carries the same label via
> `buildPurchaseSummary`'s `fallbackProduct` input.
> - **The merchant's `product_name` still wins.** The fallback only fills the
>   gap when the merchant's result carries none; #1349 is otherwise untouched —
>   `invoice_id`, money, status and hashes keep their existing sources, and
>   merchant content still sets no display field beyond `product_name`.
> - **No contract moves.** No tool is added, renamed or re-shaped, no argument
>   or input schema changes, and the version-skew and consent-hash contracts
>   do not move: response payloads are not a skew axis and the consent hash
>   covers tool names, not their inputs or responses. An older build without
>   the fallback still reports `product: null` — only less informative.
>
> `last-verified` stays 2026-10-08. Nothing else in this document was
> re-verified.

> **Re-verified (2026-10-07, hosted agent identity before tool dispatch):**
> - **Every hosted tool call reads the agent first.** `buildHostedMcpServer` runs `requireAgentIdentity` (`packages/mcp-server/src/tools/identity-gate.ts`) before a tool's handler. A 401 on that read refuses with `code: AGENT_IDENTITY_UNVERIFIED`, `next_action: stop_and_tell_user` and a `next_tool_omitted_reason`. Any other failure is relayed through `normalizeError` as before, so `agent_pending_approval` and `agent_paused` keep their backend reason. The handler does not run either way.
> - **Two exemptions.** `haven_verify_receipt` makes no request. `haven_sweep_delegate` calls only the sweep routes the backend keeps open to revoked and paused keys, so sweep recovery is unchanged.
> - **No contract moves.** No tool, schema, strict-input list, expected-context version or consent hash moves; the local MCP, the signer and the connector are untouched. A valid key sees one extra agent read per call and otherwise unchanged answers.
>
> `last-verified` stays 2026-10-02. Nothing else in this document was re-verified.

> **Re-verified #3728 (2026-10-07, signer SIWX phase 1):** the local signer
> gains one tool, `haven_sign_siwx { url, challenge }` — an x402
> Sign-In-With-X (CAIP-122 / EIP-4361) sign-in for the delegate EOA. The tool
> takes no input from Haven, composes the message in-package from
> grammar-validated challenge fields, and returns a finished
> `SIGN-IN-WITH-X` header; it moves no money.
> - **One consent-hash event, not a version bump.** The consent hash covers
>   the sorted tool NAMES, so the new tool moves it once — every upgraded
>   install re-prompts exactly once. `SIGNER_CONSENT_SURFACE_VERSION` stays 2.
> - **`requiredSignerTools` is derived**, so no connect-side edit: doctor and
>   install probes now require the new tool from the installed signer. An
>   older signer keeps paying but does not list the tool.
> - **No schema, expected-context or sweep-binding version moves.** The audit
>   entry gains optional additive `domain`/`nonce` fields on `version: 1`,
>   following the `safe_address?`/`chain_id?` pattern, no key renamed (#2914).
> Scope of this note: the signer tool set, consent and audit surfaces.
> Nothing else in this document was re-verified.

> **Re-verified #3669 (2026-10-06, backend supported vs known chains):**
> - **The wire value narrows.** `GET /chains` and discovery `chains.supported` now list 8453 and 84532 only; chain 100 leaves. No key or field is removed.
> - **History filters keep working.** `GET /transactions` still accepts a `chainId=100` history filter, through the new known-chain gate.
> - **No contract moves.** No MCP tool, schema, expected-context version or consent hash moves. No installed runtime reads `supported` to pay; the SDK already refuses chain 100 (#3638).
>
> `last-verified` stays 2026-10-02. Nothing else in this document was re-verified.

> **Re-verified #3638 (2026-10-05, SDK networks and explorer links):** the SDK's
> x402 network and token tables drop chain 100. The public `selectPaymentOption`
> no longer selects an `eip155:100` option (the payment paths already refused one
> through `selectStandardPaymentOption`), and `resolveTokenFromAddress` /
> `resolveTokenBySymbol` no longer know the chain-100 tokens. Explorer links map
> 84532 to `sepolia.basescan.org` (they fell back to mainnet basescan); chain 100
> and any other chain get none. The CLI's chain names gain Base Sepolia. No tool, schema,
> expected-context version or consent hash moves, and an installed runtime keeps
> paying on Base and Base Sepolia unchanged. `last-verified` stays 2026-10-02.
> Nothing else in this document was re-verified.

> **Re-verified #3632 (2026-10-05, SDK text drops Gnosis Chain):** the
> `@haven_ai/sdk` tool descriptions and the `PaymentRequest.token` JSDoc now
> name USDC on Base (`eip155:8453`) and Base Sepolia (`eip155:84532`) only;
> Gnosis Chain is not a Haven network. Description text only: no tool, schema,
> field, enum, version-skew or consent-hash contract moves, and an installed
> runtime keeps working with the old text. `last-verified` stays 2026-10-02.
> Nothing else in this document was re-verified.

> **Re-verified #3620 (2026-10-05, budget-scope guards):** this diff touches
> two covered files, and neither change moves a runtime contract.
> `packages/backend/src/middleware/client-compat.ts` gets a comment-only fix:
> the mirrored `findPaymentReplay` lookup skips `failed` and `expired` rows,
> which free the key. The hosted server's cross-runtime test suite gets a
> test-only parity block. Every tool name both runtimes register, plus
> hosted `haven_pay` ↔ local `haven_send`, must declare the same budget-scope
> keys. The one allowlisted difference is hosted `haven_pay_x402_quote`
> without `sub_budget_id` (the #3617 entry below). No tool, schema,
> description, version-skew or consent-hash contract moves. `last-verified`
> stays 2026-10-02. Nothing else in this document was re-verified.

> **Re-verified #3617 (2026-10-04, hosted `sub_budget_id` forwarding
> deleted):** `packages/mcp-server/src/tools/plain-http-x402.ts` no longer
> forwards `sub_budget_id` to `prepareX402Erc7710` or `createX402Intent`.
> The hosted `haven_pay_x402_quote` schema never declared the key, so
> `parseStrict` refused it before either call. The deleted lines could not
> run, and no caller's behaviour changes: the refusal names the key and makes
> zero Haven calls, now pinned in `plain-http-x402.test.ts`. The tool's
> description gains one sentence saying a sub-agent pays x402 through the
> local MCP's `haven_pay_x402` tools. It was trimmed elsewhere to stay under
> the #1591 description budget, and the `haven_get_allowances` routing hint
> stays. The local runtime's `haven_pay_x402_quote` and `haven_pay_x402`
> still take `sub_budget_id` (#3330), so the #3330 entry below holds for the
> local pay tools only. No tool is added, removed or renamed. The
> strict/permissive split, the schemas, the expected-context versions and the
> consent hash do not move. The backend half of #3617 (both
> `/x402/authorize` legs on the budget-scope resolver) adds no response
> shape: what changes is which existing answer a scoped request gets. Over
> B's slice it is now the typed 403 `delegation_budget_exceeded` with no
> `sign_data`, and a B without its own grant now gets the 201 on erc7710.
> The hosted MCP already parses that 403 (#3504). `last-verified` stays 2026-10-02. Nothing else in this
> document was re-verified.

> **Re-verified #3619 (2026-10-04, one settled-replay rule; pre-check 403
> through the #3616 builder):** this diff touches
> `packages/backend/src/modules/mpp/budget-precheck.ts` (covered file): the
> settled-replay rule and its match guards are unchanged (still `confirmed` +
> `tx_hash`, the `erc7710`/`eip3009` scheme set, no task-/sub-budget pin, same
> payee/resource/token/amount) and are now pinned cell by cell — the same
> seeded rows through `delegationReplay`, this pre-check and
> `findPaymentReplay` (via `POST /payments`) — by
> `routes/__tests__/replay-rules-parity.test.ts`. The 403 body the hosted tool
> parses (#3504) and the `payment_refusals` ledger `detail` are now built by
> the #3616 module's `buildPeriodExceededBody` (flavor `mpp`) and
> `periodExceededLedgerDetail`, equal field for field to the hand-built body
> for the same inputs. No tool, schema shape, version-skew or consent-hash
> contract moves. `last-verified` stays 2026-10-02. Nothing else in this
> document was re-verified.

> **Re-verified #3610 (2026-10-02, x402 status description):** this diff
> touches `packages/backend/src/modules/x402/delegation-authorize.ts` and
> `modules/payments/agent-payment-status.ts`, covered files: authorize now
> persists `machine_metadata.description` (the body's `description`, else the
> stored 402's `resource.description`, control/bidi characters stripped, cut at
> 300 code points plus an ellipsis) and the
> status reader falls back to the stored 402 on older rows. The status
> response's `description` / `x402.description` fields already existed and
> keep their shape (`string | null`); only their values for plain-HTTP x402
> payments change, from `null` to the merchant's text. No tool, schema shape,
> version-skew or consent-hash contract moves. `last-verified` stays
> 2026-10-02. Nothing else in this document was re-verified.

> **Re-verified #3609 (2026-10-02, the typed prepare 502):** the backend's
> delegation-rail prepare 502 (`POST /payments`, the x402 EIP-3009 funding
> leg) gains an `error_code`: `prepare_reverted` (the redemption reverted in
> execution — `refusal_reason`, a decoded `revert_reason`, a remedy
> `message`) or `prepare_failed` (anything else, including an ERC-4337 `AA`
> validation failure the bundler words as a revert), and its `details` are
> bounded at 300 characters after redaction. The hosted `normalizeError`
> (`packages/mcp-server/src/tools/support/errors.ts`) maps `prepare_reverted`
> to `PREPARE_REVERTED` with a `stop_and_tell_user` step and the two reason
> fields; `prepare_failed` keeps the generic 5xx retry-once step (the
> next-step census moves to 46 refusal fixtures and 57 `refusalNextStep`
> calls, `src/test-support/next-step-fixtures.ts`). Skew is
> additive both ways: an older hosted server reading the new body falls into
> the generic 5xx branch exactly as before, and this hosted server reading an
> older backend's untyped 502 does the same. The agent skill
> (`packages/sdk/src/skill-content.ts` and the frontend bundle copy) gains a
> `PREPARE_REVERTED` bullet in its failure-handling list. No tool, schema
> input, version-skew or consent-hash contract moves. `last-verified` stays
> 2026-10-02. Nothing else in this document was re-verified.

> **Re-verified #3596 (2026-10-02, the agent-skills index and step files):**
> this diff touches `packages/sdk/src/agent-guidance.ts`, a covered file —
> three cross-reference fixes inside `HAVEN_AGENT_RUNBOOK_MD` (step 1's
> "(below)" named "What you run" instead of trusting proximity; "If you cannot
> open a browser"'s "Steps 1-3" got a three-word gloss and lost a trailing
> ", as above"; "Budget changes later"'s "the setup above" named "The
> sequence") so no step file at `/agent-skills/<step>.md` points at another
> section by position; references by step number remain.
> No sentence constant, tool, schema, version-skew or consent-hash contract
> moves — the runtime manifest, connector channel, dist-tag and setup-prompt
> rule sentences are byte-identical to before. `last-verified` stays
> 2026-10-02. Nothing else in this document was re-verified.
>
> **Re-verified #4350 (2026-10-23, the budget end date):** the diff touches
> `packages/sdk/src/agent-guidance.ts`, a covered file — the runbook's
> "What Haven is" paragraph gains one sentence (the budget ends on a
> user-chosen date — 30/90/180/365 days — enforced on-chain, and renewal is
> a new approval on the agent's page). The served `for-agents.md`, the CLI
> copy and the `what-haven-is` step file are regenerated from it; no
> sentence constant, tool, schema, version-skew or consent-hash contract
> moves. `last-verified` stays as recorded in the scope section. Nothing
> else in this document was re-verified.

> **Re-verified #3756 (2026-10-07, superseded-agent wording):** this diff
> touches covered connect files in their human-readable output only:
> - the `--doctor` superseded-agents repair (`doctor.ts`);
> - the replace and new-agent heads-ups and the `wiring_collision` refusal
>   (`runtime.ts`);
> - the collision prompt (`wiring-collision.ts`);
> - the `--replace` help (`args.ts`) and the README.
>
> Each now names Remove agent… on the agent page instead of "revoke". No
> flag, exit code, check id, `--json` field, tool, schema, version-skew or
> consent-hash contract moves. Two body lines here repeated the same claim and
> are fixed with it: the `--replace` paragraph ("the owner still revokes on the
> Haven agent page") and the `--unwire` paragraph ("the owner revokes the agent
> on the Haven agent page") now name Remove agent…. `last-verified` stays
> 2026-10-02. Nothing else in this document was re-verified.

> **Re-verified #3722 (2026-10-07, leaked-credential copy):** this diff touches
> covered files in their human-readable text only: the haven-pay skill's leak
> section (`skill-content.ts`, renamed "If the credential may have leaked"), the
> signer consent line, and the connect `--tombstone` / `--unwire` output
> sentences. All of them now name Replace signing key, Stop budget and Remove
> agent… instead of "pause or revoke". Every runtime still installs the one
> canonical skill string. The signer consent hash covers identity, tool names
> and `SIGNER_CONSENT_SURFACE_VERSION` (unchanged), not the wording, so no
> install is re-prompted by this. No tool, argument, schema, version-skew,
> consent-hash or exit-code contract moves. `last-verified` stays 2026-10-02.
> Nothing else in this document was re-verified.

> **Re-verified, Backend checks ceiling (2026-10-07):** this diff touches
> `.github/workflows/ci.yml`, a covered file, in the `backend_checks` job's
> `timeout-minutes` only (8 to 12) and the comment above it. The job name,
> its steps, the check identity and every ruleset contract are unchanged. No
> tool, schema, version-skew or consent-hash contract moves; the client
> releases table, upgrade hints, publish flow and package resolution are
> untouched. `last-verified` stays 2026-10-02. Nothing else in this document
> was re-verified.

> **Re-verified #3583 (2026-10-02, the ops render smoke):** this diff touches
> `.github/workflows/ci.yml`, a covered file, inside the `ops_checks` job
> only: its build step gains a fixture `NEXT_PUBLIC_OPS_ENVIRONMENTS`, three
> steps are added (the shared Playwright cache restore, a cache-miss browser
> install, and `npm run smoke -w packages/ops`), and the job timeout goes
> from 10 to 15 minutes. No tool, schema, version-skew or consent-hash
> contract moves; the client releases table, upgrade hints, publish flow and
> package resolution are untouched. `last-verified` stays 2026-10-02. Nothing
> else in this document was re-verified.

> **Re-verified, skill `client_update` line (2026-10-02, guidance text only):**
> this diff touches `packages/sdk/src/skill-content.ts`, a covered file. The
> runbook's `client_update` sentence moves into a shared constant,
> `AGENT_CLIENT_UPDATE_SENTENCE` in `agent-guidance.ts`, and the haven-pay skill
> now carries it too. Every runtime still installs the one canonical skill
> string (§ *Guidance surfaces*), and `/for-agents.md` is byte-unchanged
> (`lint:runbook-parity` green). No tool, argument, schema, version-skew or
> consent-hash contract moves; the client releases table, upgrade hints and
> `upgrade_command` are untouched — the skill only names the existing field.
> `last-verified` stays 2026-10-02. Nothing else in this document was
> re-verified.


> **Re-verified, follow-up to #3587 (2026-10-02, a step rename):** this diff
> touches `.github/workflows/ci.yml`, a covered file, in one step NAME and its
> comment only — the `design_visual` job's dark-scheme step is renamed from
> `(design system)` to `(chromium-desktop-dark testMatch)`, because it runs
> seven specs, not one. The job name, the command, the check identity and every
> ruleset contract are unchanged. No tool, schema, version-skew or consent-hash
> contract moves; the client releases table, upgrade hints, publish flow and
> package resolution are untouched. `last-verified` stays 2026-10-02. Nothing
> else in this document was re-verified.

> **Re-verified #3515 (2026-10-02, the ops console scaffold):** this diff
> touches `.github/workflows/ci.yml`, a covered file. The change adds gate
> steps (design lint, wire-type ratchet) to the NEW `ops_checks` job for the
> `@haven/ops` scaffold (#3515) and its surface routing; no covered runtime
> code moved. No tool is added, renamed or re-shaped on either runtime, no
> argument or input schema changes, and the version-skew and consent-hash
> contracts do not move: a CI job's steps are not a skew axis. The client
> releases table, upgrade hints, publish flow and package resolution are
> untouched. `last-verified` is bumped to 2026-10-02 for this note.
> Nothing else in this document was re-verified.

> **Re-verified #3564 (2026-10-02):** this diff touches
> `packages/mcp-server/src/tools/support/errors.ts` and
> `packages/sdk/src/types.ts` / `payment-mappers.ts` — all covered trees.
> #3494's `SUBMISSION_OUTCOME_UNKNOWN` mapping moves from a
> `stop_and_tell_user` (the intent was already `failed`, so polling this
> payment_id's own status could never confirm the outcome) to the poll the
> re-booked backend now permits: with the 502 body's `payment_id` the step
> names `haven_get_payment_status` (`next_action: check_status_later` — the
> intent is booked outcome-pending, so the status read IS the source of
> truth, and it becomes the real terminal state once the backend's
> submission reconciler resolves the row from the chain); without a
> `payment_id` to poll, the step stays `stop_and_tell_user`, saying why no
> new payment may be created. No tool added, renamed or re-shaped; the
> runtime manifest, connector channel, dist-tag and consent-hash contracts
> are untouched, and the failure shape rides the same refusal-wire fields
> the #3104 parity walk already parses. Additive SDK surface:
> `submissionOutcomePending` on the status result — absent on every other
> row, never `false`, matching `delivered`'s honesty rule — so an older
> backend stays wire-compatible. `last-verified` is bumped to 2026-10-02
> for this note: the hosted refusal mapping for this code is part of this
> document's guidance surfaces, and its `next_action` moved.

> **Re-verified #3496 (2026-09-30, the tombstone tell moves ahead of the
> identity stat):** this diff touches `packages/connect/src/doctor.ts` (and its
> test), a covered tree. In `discoverCredentialDirectory` the `TOMBSTONE.json`
> check moved out of the missing-identity catch into a pre-check before the
> `identity.json` stat: a retired directory that kept its `identity.json` (the
> `--replace`-era shape) used to enter the candidate set whenever that identity
> was the newest on disk and could be selected as the primary — the doctor then
> reported the live agent as superseded and prescribed a full re-setup. It is
> now never a primary candidate and stays reportable as retired (#1681
> semantics unchanged); the missing-identity catch narrows to the
> rekey-pending tell. No runtime-compatibility behavior moved: the
> supported-runtime manifest table, channel, dist-tag, snapshot publishing,
> runtime-spec-override and package resolution are untouched. `last-verified`
> is bumped to 2026-09-30 for this note: the candidate selection that decides
> which directory `--doctor` reports on is part of this document's subject, and
> that behavior moved.

> **Re-verified #4438 (2026-10-26, weekly docs audit):** the 17 covered commits
> since the 2026-10-23 pass were read against this document's subject. The
> Supported Runtime Manifest table is correct at this head: all four
> `@haven_ai/*` rows read `0.11.0-alpha.0`, matching each package's
> `package.json` and `packages/connect/src/runtime-manifest.ts`, and the Node
> floor is still `>=22.0.0` (`packages/sdk/src/node-version.ts:36`) with
> `.nvmrc` at 24. Three of the intervening changes had already been recorded
> here by their own PRs: #4304 re-pinned the table (the 0.11.0-alpha.0 note
> above), #4368 added `next_refill_at` / `budgetRefillsAt` to the
> `haven_get_agent` guidance, and #4405 corrected the agent-dir default path
> (`~/.haven/agents/<slug>/bin/haven-mcp`). One had not: **#4376** changed a
> refusal reason on the hosted prepare and both x402 legs, and is now written
> up in § *An expired-only budget is refused as `delegation_expired`, with the
> end date (#4352)*. The remainder — #4381's dep-lint widening, #4325's census
> ceilings, #4374's and #4417's doc corrections, and the analytics and token
> fixes — moved no tool, schema, version constant, consent hash, channel,
> dist-tag or package-resolution rule. `last-verified` is bumped to 2026-10-26
> for this note.

>
> **Re-verified #3531 (2026-10-01, advisory recipient history hint on
> `haven_send`/`haven_pay`):** this diff touches a file under a covered tree —
> `packages/mcp-server/src/tools/state-direct-recovery.ts`. Additive only: the
> hosted `haven_send`/`haven_pay` success shape gains an optional top-level
> `recipient_class` (`previously_paid` | `new_address`), present only when the
> backend sends `intent.recipient` — an older backend omits it and the field
> is simply absent, no new required field and no change to
> `next_action`/`safe_to_continue`/refusal shapes. The local `@haven_ai/mcp`
> `haven_send` (`packages/mcp/src/tools.ts`) is deliberately NOT changed: it
> calls the all-in-one `haven.pay()`, whose returned `PaymentResult` is built
> from post-confirmation state and carries nothing from the intermediate
> `createIntent()` call this field is computed at — widening `PaymentResult`
> itself is out of this change's scope.
>
> **Re-verified #3497 (2026-10-01, agent-surface polish from the 2026-09-30
> purchase run):** this diff touches files under a covered tree —
> `packages/mcp-server/src/tools/**` (`catalog-purchase.ts`,
> `plain-http-x402.ts`, `paid-mcp-completion.ts`, `contracts.ts`,
> `state-direct-recovery.ts`, `support/signer-compat.ts`, `support/index.ts`,
> and the new `support/allowance-block.ts`). Three changes, all
> text-and-summaries: response prose no longer carries internal issue
> references (guidance `reason`, `signer_compatibility.check`, the
> strict-input refusal messages, the direct-sign fallback — a signer VERSION
> is what an agent acts on, pinned by a source scan in
> `response-prose.test.ts`); `agent_summary.product` on the settled erc7710
> arms reports the merchant's product name with the tool name as fallback
> (value change, field and shape unchanged; since #3771 that fallback is the
> Haven-derived `<merchant host> <tool_name>` label — see Re-verified #3771);
> and the delegation-rail
> `allowance` block `haven_pay_x402_quote` has carried since #3476 moved
> VERBATIM to `support/allowance-block.ts` and is now attached to
> `haven_pay_mcp_tool`'s successful results too — an optional additive field
> with the same read-only derived-budget shape, never a refusal, the over-budget
> decision staying with the backend's typed 403 on each settlement leg. No tool
> is added, renamed or re-shaped on either runtime, no argument or input schema
> changes, and the version-skew and consent-hash contracts do not move:
> response payloads are not a skew axis, and the local consent hash covers tool
> names, not their inputs or responses (`packages/mcp/src/consent.ts`). An
> older SDK/hosted build that lacks the field is only less informative; a
> newer one adds visibility the backend already exposes. `last-verified` is
> not re-stamped: it already reads 2026-10-01 and this block is the scope.
> Nothing else in this document was re-verified.
>
> **Re-verified #3501 (2026-09-30, task budgets report spent/remaining):**
> this diff touches four files this document covers —
> `packages/sdk/src/types.ts` (`RawTaskBudget` gains optional
> `spent_atomic` / `remaining_atomic` / `remaining_is_from_chain`;
> `HavenTaskBudget` and `HavenTaskBudgetSummary` the camelCase forms plus
> `remainingDisplay`), `packages/sdk/src/account-reads.ts` (`mapTaskBudget`
> preserves key presence exactly — absent stays absent, so a caller can
> distinguish "this response did not read the chain" from "the read failed"
> (null), and `summarizeTaskBudget` derives `remainingDisplay` by the SAME
> formatter as `maxDisplay`, mapping an older backend's absent keys to the
> honest degraded shape — null figures, `remainingIsFromChain: false`, never
> the full cap as remaining), `packages/sdk/src/tool-descriptions.ts`
> (`getAgent`'s and `getAllowances`'s behavior text names the new fields and
> where task budgets live), and
> `packages/mcp-server/src/description-size.test.ts` (the #1591 total/mean
> pins re-derived to the measured 24,474 / 941.31 — the test, not this
> sentence, is the instrument). Additive, optional keys on the wire; no tool
> is added, renamed or re-shaped on either runtime, no argument or input
> schema changes, and the version-skew and consent-hash contracts do not
> move: descriptions are not a skew axis (#2330 precedent), and the local
> consent hash covers tool names, not their inputs or responses
> (`packages/mcp/src/consent.ts`). An older SDK against a newer backend
> ignores the new keys; a newer SDK against an older backend sees none and
> reports the degraded shape. `last-verified` is not re-stamped: this block
> is the scope. Nothing else in this document was re-verified.
>
> **Re-verified #3427 (2026-09-29, the paid x402 retry carries the buyer tax
> declaration):** this diff touches files under covered trees —
> `packages/sdk/src/client.ts`, `merchant-completion.ts`, `edge.ts`,
> `tool-descriptions.ts` and `skill-content.ts`, and
> `packages/mcp/src/tools.test.ts`. The SDK edge entry gains
> `buildSignedTaxDeclaration`: the EIP-712 tax declaration is built LOCALLY over
> exactly the wg-tax PR #5 §2.1 fields and signed by the same delegate key that
> signs the EIP-3009 payment authorization (§2.2: the signer is the payer);
> content arriving with `principalId`, `principalAttributionHash` or any unknown
> field is refused. `MerchantCompletion.retryRequest` — the seam shared by
> `fetch`, `payX402Quote` and `resumeX402Payment` — attaches
> `X-Tax-Declaration: <base64url(JSON)>` to the SELLER request on the paid
> EIP-3009 retry, only when the owner opted the agent in (#3426 content
> endpoint); it is omitted on the erc7710 scheme, on the first unpaid request,
> on a "not available" content answer, and on a 404 from the content endpoint.
> Runtime-compatibility contracts do not move: no tool is added, renamed or
> re-shaped on either surface, `haven_pay_x402` and `haven_resume_x402_payment`
> keep their input schemas (the attach happens inside the SDK below the MCP tool
> layer, driven by the #3426 opt-in, and `deliverPayment` — the hosted keyless
> path — is untouched, so a hosted runtime never attaches a declaration), the
> local consent hash covers tool names, not their inputs
> (`packages/mcp/src/consent.ts`), and the header is seller-bound only — it
> never reaches Haven's API or the payment payload, so what a newer client may
> send an older runtime is unchanged. The two tools' descriptions gain one
> sentence about the header (description text only), and the payment skill's
> prose mirrors it into the frontend bundle byte-for-byte (its parity test is
> re-run green). No update needed without the opt-in: the wire is unchanged.
> `last-verified` is not re-stamped: this block is the scope. Nothing else in
> this document was re-verified.
>
> **Re-verified (#3423 slice C, 2026-09-29, `haven_list_receipts` gains
> `compact`):** both surfaces declare an optional `compact: boolean` on
> `haven_list_receipts`, and with it each row omits `challengePayload`,
> `selectedPayment` and `protocolReceiptPayload`. The stripping is in the SDK's
> `listReceiptsPage({ compact })`, which both runtimes call. The default,
> without the key, is byte-identical. Version skew differs by surface. A hosted
> server older than this change refuses `compact` by name through its strict
> input schema (the transport's `.strict()` and the handler's `parseStrict`,
> both with the declared-keys message); an agent that gets
> that refusal should drop the key, and no data is lost. A local
> `@haven_ai/mcp` older than this change parses input non-strictly
> (`objectInput` strips unknown keys), so it silently ignores `compact` and
> returns full rows. The local consent hash
> covers tool names, not their inputs (`packages/mcp/src/consent.ts`), so
> adding the key does not ask for a new acknowledgement. Nothing else in this
> document was re-verified.

> **Re-verified unchanged (#3423 slice A, 2026-09-28, hosted agent-surface
> polish):** this diff touches `packages/mcp-server/src/tools/{support/catalog-entry,support/cap-price,paid-mcp-completion,support/guidance}.ts`
> and `packages/sdk/src/skill-content.ts`, all under this doc's covered trees.
> Four fixes, none touching a tool's name, schema, input shape or the
> version-skew/consent-hash contracts: (1) a `protocol: 'http'` catalog row's
> refusal now names `haven_quote_x402` instead of the mcp-only
> `haven_pay_mcp_tool`, with `next_action: retry_with_explicit_context`
> (was `stop_and_tell_user`) — refusal wording and `next_action`/
> `next_tool`/`next_arguments` content change; `CATALOG_ENTRY_UNUSABLE` is
> unchanged, no schema change; (2) the `PRICE_EXCEEDS_MAX` message states
> both sides in whole tokens instead of mixing units — message text only, same
> code/status/`retry_with_new_quote`; (3) the erc7710 settled branch of
> `haven_settle_mcp_tool` now ALSO includes `agent_summary.purchase_summary`
> alongside the `agent_summary.product` field it already carried (additive,
> review round 1 F1) — a read-only field built from values the handler
> already held, no new call, no wire shape removed; (4) the
> skill's catalog Signing/Settle prose now names both settlement shapes
> instead of only EIP-3009 — prose only, mirrored byte-for-byte into the
> frontend skill bundle, which its own parity test enforces. No runtime is
> added, no tool is renamed or re-shaped, and this document's version-skew and
> consent-hash contracts are untouched. `last-verified` is not re-stamped:
> this block is the scope. Nothing else in this document was re-verified.
>
> **Re-verified #3464 (2026-09-29, the four allowance spellings align on
> `haven_get_agent`):** this diff touches three surfaces this document
> covers — `packages/sdk/src/account-reads.ts`
> (`getPostPurchaseAllowanceSummary` gains the canonical camelCase keys
> `remainingAtomic`/`remainingDisplay`/`resetPeriodMin`/`tokenSymbol`/
> `tokenAddress` beside the kept snake_case keys and takes its
> `remainingDisplay` from the shared `formatRemainingDisplay`),
> `packages/sdk/src/tool-descriptions.ts` (`getPaymentStatus` names the
> allowance block and the deprecation window), and
> `packages/mcp-server/src/tools/contracts.ts` (the settle/complete/
> payment-status and catalog-preflight descriptions carry the same
> spelling note). Additive, optional keys on the wire; the snake_case keys
> are unchanged and marked deprecated — no tool is added, renamed or
> re-shaped, no argument or input schema changes, and the version-skew and
> consent-hash contracts do not move. The local stdio surface composes the
> shared description verbatim (`packages/mcp/src/tools.ts` is otherwise
> untouched). `last-verified` is not re-stamped: this block is the scope.
> Nothing else in this document was re-verified.
>
> **Re-verified #3430 (2026-09-29, the runbook runs the manifest's own CLI
> command):** the agent runbook (`HAVEN_AGENT_RUNBOOK_MD` in
> `packages/sdk/src/agent-guidance.ts`, served as `/for-agents.md` and bundled
> into `haven guide`) and the dashboard onboarding prompt template replace the
> step-1 CLI template `npx @haven_ai/cli@<channel>` — which, filled from
> `packages.cli.channel` as instructed, produced the broken
> `npx @haven_ai/cli@@haven_ai/cli@dev` of the 2026-09-28 cold run — with the
> manifest's own `packages.cli.one_liner`, run as given. Text only: no tool is
> added, renamed or re-shaped, no argument, schema, description or consent
> input changes, and the CLI login flow the command starts is the same
> device-approval handshake as before, so the version-skew and consent-hash
> contracts do not move. The CLI's byte-pinned bundled runbook copy was
> regenerated from the SDK canonical with its parity test and size pins
> updated — the #2719 mechanism. Nothing else in this document was
> re-verified.
>
> **Re-verified #3431 (2026-09-29, no chain name in the onboarding prompt):**
> `AGENT_ONBOARDING_PROMPT` in `packages/sdk/src/agent-guidance.ts` — the
> dashboard's onboarding prompt (static; distinct from the per-agent setup
> prompt and from `HAVEN_AGENT_RUNBOOK_MD` above; see
> `docs/product/copy-guidelines.md` § Agent-facing vocabulary) — said
> "funding the account with USDC on Base" — wrong on any deployment that does
> not deploy Base mainnet (dev deploys Base Sepolia only). Made chain-neutral:
> "funding the account with USDC". Prose only, in the same file this doc
> already covers for the runbook and the sentence constants — no tool,
> argument, schema, description or consent input changes, and the
> version-skew and consent-hash contracts do not move. The frontend's
> byte-pinned copy (`packages/frontend/src/lib/agent-onboarding-prompt.ts`,
> added to this doc's `covers:` by this change) was edited identically and
> its parity test re-run. `last-verified` is not re-stamped: this block is
> the scope. Nothing else in this document was re-verified.
>
> **Re-verified #3418 (2026-09-28, the receipt verifier stops throwing and
> verifies the delegation digest):** this diff touches three surfaces this
> document covers. `packages/sdk/src/tool-descriptions.ts` `verifyReceipt` —
> composed verbatim by the local stdio surface and the hosted `contracts.ts`
> module alike — no longer tells agents to fetch receipts with the history
> tool (it sent every agent down the crash the issue reproduces); it now names
> the signed-bundle source (`GET /payments/:id/receipt`), the
> `not_a_signed_receipt` answer for a `haven_list_receipts` row, the
> `not_verifiable_offline` branch and the settlement-not-proven rule. The
> `haven_verify_receipt` HANDLER on both runtimes is a pass-through of
> `verifyPaymentReceipt` (`packages/mcp/src/tools.ts`,
> `packages/mcp-server/src/tools/state-direct-recovery.ts`) and its input
> schema stays `z.unknown()`; what changes on the wire is the tool OUTPUT for
> a non-bundle input — a structured
> `{ verified: false, reason: 'not_a_signed_receipt' }` success where both
> runtimes escaped `UNKNOWN_ERROR` with a raw TypeError before — plus the
> erc7710 verify-over-delegation-digest correction on signed bundles. The
> hosted `STRICT_INPUT_TOOLS` rationale for `haven_verify_receipt`
> (`packages/mcp-server/src/tools/contracts.ts`) is reworded text only: no
> tool is added, renamed or re-shaped, no schema or argument change, and the
> version-skew and consent-hash contracts do not move. `last-verified` is not
> re-stamped: this block is the scope. Nothing else in this document was
> re-verified.
>
> **Re-verified unchanged (#3410, 2026-09-28, consent display):** the local
> MCP server's first-launch consent screen now renders the budget in whole
> tokens instead of atomic units (`packages/mcp/src/consent.ts`,
> `renderConsentBlock` → `describeBudgetAmount`), with an explicit
> `(atomic units)` label when the token's decimals cannot be resolved through
> the SDK registry. Display only — this document's consent-hash contract
> holds unchanged: `computeConsentHash` (`packages/mcp/src/consent.ts:96-119`)
> still hashes identity, tool names and the RAW ATOMIC allowance strings, so
> no installed sidecar `.ack.json` or `HAVEN_MCP_ACK` value is invalidated,
> and the live path (`onchain.amount`) and the credential seed
> (`allowance_amount`) hash byte-identical strings (pinned by a literal-hash
> test and a live≡seed equality test in `packages/mcp/src/consent.test.ts`).
> The unreachable human-decimal `configuredAmount` fallback in the live-read
> mapping was removed (`onchain.amount ?? '0'`), so no human-decimal value can
> reach the atomic field the hash covers. New SDK surface consumed here:
> `resolveTokenBySymbol` and `formatTokenAmount` (`@haven_ai/sdk`, additive
> exports). No tool added, renamed or re-shaped, no schema or argument change,
> no version-skew axis moves. Scope of this note: the consent screen's
> rendering path and the two stale line citations below (the consent-hash
> function moved from `consent.ts:81-103` to `:96-119` under this change;
> both now read `:96-119`). Nothing else in this document was re-verified in
> this pass.
>
> **Re-verified unchanged (#3279, 2026-09-25, Safe-vocabulary copy):** copy-only
> edits on two surfaces this document covers. The local signer's first-launch
> consent block (`packages/signer/src/consent.ts`) now names the agent's signed
> budget delegation as the real spend gate, and the local MCP server's consent
> screen prints `Haven wallet: <address>` (`packages/mcp/src/consent.ts`) — the
> retired rail's name is gone from both. `haven_sign_sweep_delegate`'s
> description (`packages/signer/src/tools.ts`) and the sweep `to`-guard refusal
> message (`packages/signer/src/core.ts`) name the destination as the agent's
> account (Haven wallet) and state the conditional destination check: it runs
> only when the local credential carries an account address (#2247), and
> otherwise rests on Haven's binding signature. No tool added, renamed or
> re-shaped, no schema or argument change, no version-skew axis moves, and the
> consent-hash contract holds: neither `computeConsentHash`
> (`packages/mcp/src/consent.ts`) nor `computeSignerConsentHash`
> (`packages/signer/src/consent.ts`) hashes rendered text, and
> `SIGNER_CONSENT_SURFACE_VERSION` stays 2 (newly pinned by a test). Scope of
> this note: those copy strings and their pins. Nothing else in this document
> was re-verified in this pass.
>
> **Re-verified unchanged (#3241):** the change is test-only in
> `packages/connect/src/doctor.test.ts` (+47/−1) — a `stampAgentMtimes()`
> helper stamping the seeded `identity.json` files with synthetic,
> strictly-increasing utimes so `discoverCredentialDirectory`'s newest-wins
> selection is deterministic under the kernel's coarse-clock ties. No runtime,
> tool, schema, description or wire change: nothing in this document moves,
> and the doctor's selection contract itself is unchanged — the fix only makes
> the fixtures honor it deterministically.
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
> **Re-verified unchanged (#3483, and again for #3573):** the change touches `.github/workflows/ci.yml`,
> a covered file, but only inside the frontend build the design_visual job's
> baselines come from — one build-time env line
> (`NEXT_PUBLIC_COINBASE_ONRAMP_APP_ID`, a fixed synthetic literal so the Add
> funds modal's visual baselines render the onramp variant; see
> `docs/operations/dev-environment.md` § `NEXT_PUBLIC_COINBASE_ONRAMP_APP_ID`
> in the Playwright builds; #3573 added one more such line, the redesigned
> public site's preview flag, and #3579 removed it again with the gate).
> Frontend-only CI wiring: no tool is added, renamed
> or re-shaped, no description text changes, no schema or argument changes, and
> the runtime-skew and consent-hash contracts are untouched. `last-verified` is
> not bumped: this note is the scope.
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
> and allowances, not schemas — `packages/mcp/src/consent.ts:96-119`). The
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
> **Recent re-verification (#3031):** `routes/machine-payments.ts` joined the
> request-validation `enforcedModules`, so its wire contract now refuses an
> off-spec REQUEST SHAPE with the plugin's 400 envelope before the handler —
> including on the routes the hosted MCP tools call (`/receipts`' uuid
> `cursor`, `/evidence`'s field shapes, `/sweep/submit`'s full
> `SweepAuthorization`, which the shipped SDK already sends). Every body the
> current `@haven_ai/sdk` and the hosted MCP send passes byte-identically
> (the suites assemble the app the production way and prove it), and the
> refusals a CONFORMANT caller can still get are unchanged: same handlers,
> same semantic gates, no tool added, renamed or re-described. An older
> runtime sees the same success shapes; only a caller already sending an
> off-spec body — which no shipped client does — gets the new 400. The skew
> dimension is unchanged: route and tools deploy in the same train.
>
> **Round-2 correction (#3031 rework, owner decision epic #3028 2026-09-24):**
> `POST /machine-payments/reconciliation-events` — the endpoint
> `report-x402-outcome` posts to when a merchant retry rejects a confirmed
> payment — is the rollout's NAMED RESIDUE and stays SHADOWED: it moved to
> its own route file (`routes/machine-payments-reconciliation-events.ts`,
> same prefix) so the module flip could not drag it into enforcement. For the
> MCP surface this changes nothing: the tool already sends a spec-conformant
> body, a shadowed route answers exactly as it always did (shadow only
> measures), and the route is enforced the day a real merchant rejection
> gives the shadow reading traffic to prove it. The rework also moved the
> retired `/machine-payments/authorize` refusal into an `onRequest` hook
> (owner-ordered, #3030 tombstone pattern) and restored the strict
> `MachinePaymentAuthorizeRequest` schema; the tombstone answers 410 before
> validation, so no MCP-visible answer changed there either.
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
> **Recent re-verification (#3134):** each `haven_list_receipts` row on BOTH
> runtimes gains four keys — `source`, `paymentProofStatus`,
> `x402ResourceUrl`, `x402MerchantAddress` — carrying exactly the values the
> row already reports as `rail`, `proofStatus`, `resourceUrl` and
> `merchantAddress`; the old four stay for one full release as deprecated
> twins (removal condition on `mapPaymentReceipt`: all three release clocks —
> sdk `latest`, mcp `latest`, the hosted deploy's `serverInfo.version` on
> `initialize` — read at or past the release naming the twins, against the
> registry and the live handshake, never a green promotion). Additive
> on the SDK type only; the receipts WIRE is unchanged, so an older SDK against
> a newer backend and a newer SDK against an older backend both see exactly
> what they saw before. Neither runtime reshapes receipt rows (hosted
> `state-direct-recovery.ts` and local `tools.ts` pass `listReceiptsPage`
> through), no tool added, renamed or re-shaped, no argument or schema change,
> no description change (the #1591 budget is untouched at 2 bytes headroom),
> and the version-skew and consent-hash contracts do not move. `last-verified`
> is not re-stamped: this block is the scope, and the third clock's instrument
> needs an agent key (`Authorization: Bearer`, `http.ts`) — the handshake is
> authenticated, unlike the two `npm view` reads. Nothing else in this document
> was re-verified in this pass.
>
> **Recent re-verification (#3304):** no tool, argument, schema, description
> or consent input changes on either runtime. Two agent-facing things move.
> First, the agent runbook (`HAVEN_AGENT_RUNBOOK_MD` in
> `packages/sdk/src/agent-guidance.ts`, served as `/for-agents.md` and bundled
> into `haven guide`) gains a short "If something breaks" section pointing at
> `client_update` and `/releases`. That is text, not a contract: nothing parses
> it. Second, the backend's `client_update` hint now carries a non-null
> `notes_url`. The SDK's `readClientUpdate` already passes a string through, and
> the field was always in the schema, so a client from #3303 on reads it without
> a change. The version-skew and consent-hash contracts do not move. Nothing
> else in this document was re-verified in this pass.
>
> **Recent re-verification (#3375):** the local runtime's x402 payment tools
> (`haven_pay_x402`, `haven_pay_x402_quote`, `haven_pay_mcp_tool`) pay through
> `@haven_ai/sdk`'s own funding leg, which now also runs the #3281 recipient pin
> (`assertFundingLegPaysDelegate`) against the 402 option being paid. A funding
> leg that does not transfer the quoted amount of the quoted token into the
> key's own delegate EOA is refused as `TYPED_DATA_NOT_ALLOWED`, with nothing
> signed or posted to `/sign`. No tool, argument, schema, description or
> consent input changes, so the handshake and consent hash do not move. Skew:
> the backend already builds exactly this shape, so an updated SDK against the
> current backend refuses no live leg; installed `@haven_ai/mcp` / SDK copies
> keep the old funding leg until updated. The hosted runtime signs through the
> signer, which has pinned this since #3281. Nothing else in this document was
> re-verified in this pass.
>
> **Recent re-verification (#3306):** each `haven_list_receipts` row on BOTH
> runtimes LOSES four keys — `rail`, `proofStatus`, `resourceUrl`,
> `merchantAddress`, the deprecated twins #3134 dual-emitted from
> `0.5.0-alpha.0` — so a row carries only `source`, `paymentProofStatus`,
> `x402ResourceUrl` and `x402MerchantAddress` for those values. This is a
> tool-output RE-SHAPE, and breaking for any agent or script still reading an
> old key. The removal condition held at merge: `@haven_ai/sdk` `latest`,
> `@haven_ai/mcp` `latest` and the hosted prod `serverInfo.version` on
> `initialize` all read `0.5.0-alpha.1` (≥ `0.5.0-alpha.0`; evidence on #3130).
> Those clocks prove clients *received* the survivors, not that they stopped
> reading the twins — accepted by design (#3134 decision 1). The change is made
> at `mapPaymentReceipt` only: the receipts WIRE (`RawHavenPaymentReceipt`) is
> unchanged, neither runtime reshapes receipt rows itself (hosted
> `state-direct-recovery.ts` and local `tools.ts` pass `listReceiptsPage`
> through), so the hosted runtime drops the keys with its deploy (the SDK is a
> workspace link there) and the local runtime with its SDK dependency. No tool
> added or renamed, no argument, schema or description change, and the
> version-skew and consent-hash contracts do not move. Under the 0.x
> convention this document records below (the 0.4.0-alpha.0 note: a break
> takes the minor step), the release carrying this is a MINOR step, and a
> `.d.ts` diff does not show a tool-output break. Nothing else in this document was re-verified in this
> pass.
>
> **Recent re-verification (#3213):** `haven_check_funds` now accepts its
> `token` argument as the contract address OR the SYMBOL the identity and
> allowance reads report (`packages/mcp-server/src/tools/state-direct-recovery.ts`,
> `resolveTokenAddressFromAllowances`): a symbol is resolved to the address of
> this agent's one allowance carrying it through the existing
> `GET /machine-payments/allowances` read, and the coverage read
> `GET /machine-payments/balance-coverage` still receives an address — the
> backend route, its two query guards and its 400 bodies are untouched, so the
> wire contract this document describes does not move. Additive on the tool:
> the address form takes the #3126 path unchanged (no allowance read); a symbol
> no allowance carries, or two carry, refuses `INVALID_INPUT` with the address
> as the remedy and `haven_get_allowances` as the typed next step; the
> read-only no-cap refusal names the check rather than a paid merchant call
> (`readMaxAmountCap` gained an optional `uncappedRefusal` opener; every
> purchase tool keeps the shared copy). One description re-cut under the
> #1591 mean cap (the test is the instrument: total 20,995 of 21,000 at the
> delivered head); no tool added or renamed, no version-skew or consent-hash
> change. Nothing else in this document was re-verified in this pass.
>
> **Recent re-verification (#3272):** the edge signer's `haven_sign` now signs
> typed data without an x402 context ONLY when it is a direct-payment
> `PackedUserOperation` for the signer's own derived delegate account, on a
> chain with pinned delegation contracts (Base, Base Sepolia), whose `callData`
> is a single `execute` to the DelegationManager calling `redeemDelegations`
> with exactly one delegation, a single grant made to that account by a
> different account,
> in `SingleDefault` mode, canonically encoded.
> Anything else answers the new structured `TYPED_DATA_NOT_ALLOWED` refusal
> (`next_action: stop_and_tell_user`, no signature, no audit entry), the same
> envelope shape as `BARE_HASH_REFUSED` (#3169). Separately, the signer's
> `SUPPORTED_X402_EXPECTED_VERSIONS` is now `[2, 3]`: a v1 (bare-hash) expected
> context answers the existing version-mismatch refusal, and the backend can
> no longer emit one (`signX402ExpectedContext` requires `typedDataHash`). The
> handshake advertises the new set automatically. Skew: an old signer against
> a new backend is unaffected, because no v1 context is emitted and a v2/v3
> context signs as before. A new signer against an old backend that still
> emitted v1 is not a live case, since every backend site already passed
> `typedDataHash`. No tool was added or renamed and no argument changed, so the
> consent hash (identity + tool names + surface version) does not move.
> Installed signers keep the pre-#3272 behaviour until upgraded, and Haven
> cannot gate that. Nothing else in this document was re-verified in this
> pass.
>
> **Recent re-verification (#3281):** the signer's x402 arm (`haven_sign` with
> `x402_expected` or a fetched x402 context, and `haven_sign_x402`) now signs
> only a funding-leg `PackedUserOperation` that passes the same allowlist plus
> a recipient pin (a transfer of the quoted amount to the signer's own
> delegate EOA), or an erc7710 settlement child delegated by the signer's own
> account. Anything else answers `TYPED_DATA_NOT_ALLOWED` or
> `USEROP_BINDING_MISMATCH`, with the same envelopes as the unbound branch,
> even when Haven's binding validly declared it. No tool, argument or version
> set changes, so the handshake and consent hash do not move. Skew: a new
> signer against the current backend signs every live shape, which the
> backend's `funding-leg-signer-shape.contract.test.ts` pins. Installed
> signers keep the old x402 arm until upgraded. Nothing else in this document
> was re-verified in this pass.
>
> **Recent re-verification (#4248):** the #4242 refusal is now the
> structured `NO_FUNDING_LEG` (it was `SIGNING_ERROR`), with
> `next_action: sign_and_submit_payment` and a `next_tool_omitted_reason`,
> on both `haven_x402_sign_header` and `haven_sign_x402`. `haven_sign_x402`
> now checks the expected-context version before the settlement-child
> refusal, so an out-of-date signer gets `UNSUPPORTED_EXPECTED_CONTEXT_VERSION`
> (#1143 ordering) whatever the typed data is. A settlement-child binding is
> retired at mint and no longer held in memory. No tool, argument,
> description or version set changes, so the handshake and consent hash do
> not move. Skew: no released signer emitted the #4242 `SIGNING_ERROR`, and
> hosted code branches on neither code. Nothing else in this document was
> re-verified in this pass.
>
> **Recent re-verification (#4242):** the signer's x402 binding now records
> which shape was signed, and `haven_x402_sign_header` builds an EIP-3009
> header only from a funding-leg binding; a settlement-child binding is
> refused (`SIGNING_ERROR`) and retired. `haven_sign_x402` refuses a
> settlement child before signing. Three tool descriptions changed; no tool,
> argument or version set changes, so the handshake and consent hash do not
> move. Skew: hosted guidance already routes erc7710 to `haven_sign` +
> `haven_submit { settlement_scheme: 'erc7710' }`, which is unchanged, so a
> new signer against the current backend refuses nothing it is sent on a
> live path. Installed signers keep the old behaviour until upgraded. Nothing
> else in this document was re-verified in this pass.
>
> **Recent re-verification (#3283):** the allowlist above moved into
> `@haven_ai/sdk` (`assertBoundDirectPaymentUserOp` and friends, exported from
> `@haven_ai/sdk/edge`). The signer imports it and wraps the SDK's
> `HavenTypedDataRefusedError` into its own `TYPED_DATA_NOT_ALLOWED` refusal,
> with the same code, message and next step. The signer's tool surface, its
> refusal envelope and its consent hash do not change.
>
> `@haven_ai/mcp` changes behaviour: its keyed `HavenClient` now runs the same
> allowlist in `signForData`, so a `haven_send` / x402 payment whose served
> UserOp is not this key's own direct-payment shape is refused before
> anything is signed or submitted. The same holds for an erc7710 settlement
> child that does not match the merchant's 402, is a root grant, is delegated
> by another account, or has no 402 expectation (`TYPED_DATA_NOT_ALLOWED` in
> every case).
>
> Release coupling: the signer pins `@haven_ai/sdk` exactly, so both must ship
> together through `release-bump`. The new `@haven_ai/sdk/test-support` subpath
> is test fixtures only, and no runtime path imports it. Nothing else in this
> document was re-verified in this pass.
>
> **Recent re-verification (#3279, SDK wording):** documentation-only edits in
> `@haven_ai/sdk` source comments (`client.ts`, `sweep.ts`, `types.ts`,
> `x402.ts`, `x402-funding-leg.ts`), the README and the CHANGELOG. They name the
> sweep destination as the agent's Haven account and the x402 funding leg as
> account → delegate EOA, instead of the retired Safe. No tool, type, wire field
> or description string served to an agent changes, so the version-skew and
> consent-hash contracts do not move. Nothing else in this document was
> re-verified in this pass.
>
> **Recent re-verification (#3271):** a direct payment (`haven_send` /
> `haven_pay`) can now be signed by `payment_id`, like delegation-rail x402. New backend
> route `GET /payments/:id/sign-context` (versioned by `@haven_ai/sdk`'s
> `DIRECT_SIGN_CONTEXT_VERSION = 1`) serves the exact typed data; the signer's `haven_sign({ payment_id })` tries
> the x402 fetch first and, ONLY on its 409 `sign_context_unavailable`, fetches
> the direct context. Every direct-payment UserOp `haven_sign` signs — fetched
> or relayed — is re-hashed and refused with `USEROP_BINDING_MISMATCH` when it
> disagrees with its `payload_hash`; the x402 funding leg keeps its #1138
> digest check against the Haven-signed expected context. Additive on the
> wire: the hosted direct-payment result is UNCHANGED in this change (it still
> names the `payload_hash` + `typed_data_b64` relay); the capability-gated
> `next_tool` guidance ships separately, after the signer release, per #3271's
> sequencing. The signer's `initialize` instructions list the direct
> sign-context versions it supports. Skew: an OLD signer with the new backend
> sees no difference — the hosted result still hands it the relay; a NEW
> signer against an OLD backend gets the x402 409,
> then a 404 from the direct fetch, and the signer refuses with
> `SIGN_CONTEXT_REFUSED` carrying `fallback: 'typed_data_b64'` and a reason
> naming the relay, so the agent relays the same fields (pinned in
> `packages/signer/src/direct-sign-fallback.test.ts`). No tool added or renamed and no argument removed,
> so the consent hash (identity + tool names + surface version,
> `packages/signer/src/consent.ts`) does not move. The `send` description
> was re-cut under the #1591 mean cap. Nothing else in this document was
> re-verified in this pass.
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
> **Recent re-verification (#3173):** the edge signer now imports
> `@haven_ai/sdk/edge` (a new, ethers-free SDK entry) instead of the barrel and
> lazy-loads `x402/schemes`; its CLI refuses unknown options and its consent
> block/refusal name the connector doctor. No tool added, renamed or re-shaped
> on either runtime — arguments, schemas, descriptions and the registered
> tool-name set are untouched — so the consent hash and the version-skew
> contract do not move. One NEW coupling to state: a signer at or above this
> version resolves `@haven_ai/sdk/edge`, which does not exist on an SDK below
> this version; the signer pins its SDK exactly (`release-bump.mjs` re-pins),
> and the connector installs the pinned pair, so a mixed pair cannot arise
> through the supported install path — a hand-installed older SDK beside a new
> signer fails at import with `ERR_PACKAGE_PATH_NOT_EXPORTED` ("Package subpath
> './edge' is not defined by \"exports\""), before any key is read.
> `last-verified` is not re-stamped: this block is the scope. Nothing else in
> this document was re-verified in this pass.
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
> description text, verified at `packages/mcp/src/consent.ts:96-119`; an older
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
> **Recent re-verification (#3492):** the #3054 pre-check's over-budget
> compare had a replay bug — a retried `idempotency_key` whose erc7710
> payment had already SETTLED (via `haven_prepare_catalog_purchase`'s
> authorize step) could still hit step 5b's pre-check with the now-spent
> remaining budget and be refused as over-budget: a false
> `delegation_budget_exceeded` `payment_refusals` row (`source:
> 'hosted_prepare'`) for a payment that had already moved. `POST
> /machine-payments/budget-precheck` gains an optional `idempotencyKey`
> (`BudgetPrecheckRequest`); when it resolves to the SAME lookup authorize's
> replay already uses (`findX402IntentByIdempotencyKey`) and that row is a
> SETTLED erc7710 payment for the exact same quote (confirmed, a `tx_hash`,
> `settlement_scheme: 'erc7710'`, same token/amount/payee/resource, no
> task- or sub-budget pin), the pre-check answers `{ sufficient: true,
> replay: true }` WITHOUT calling `refuse()` — skipping the write, not
> faking the remaining figure (`remaining_atomic` still reports the true,
> now-lower number). Any other row shape — no row, a `pending_signature`
> child, a key collision on a different payee/resource/token/amount, or a
> task/sub-budget-scoped row — falls through to today's compare unchanged,
> including its refusal branch. (At the time of this pass a settled EIP-3009
> row was also deliberately out of scope here; #3527 below closed that gap.)
> `haven_prepare_catalog_purchase`'s step 5b forwards `args.idempotency_key`
> onto the pre-check call; `haven_pay_mcp_tool` is unaffected — it never had
> this bug, because its authorize call runs the replay lookup BEFORE its own
> pre-check (`delegation-authorize.ts`). One input-schema change:
> `haven_prepare_catalog_purchase`'s `idempotency_key` gains 1–128 bounds,
> matching `haven_pay` and the backend's `X402AuthorizeRequest`, so an empty
> or over-long key is now refused at tool input (`INVALID_INPUT`). Before,
> an over-long key was refused by the backend (400), and an empty key was
> treated as no key on the erc7710 branch. No tool added or renamed; descriptions
> and the strict/permissive split are untouched, the local stdio runtime is
> not on this path, and the skew-flatness this document asserts holds in the
> tool-shape sense apart from that bound — but
> the WIRE is not skew-flat here, checked from the code
> (`routes/machine-payments.ts` is in `index.ts`'s `enforcedModules`, and
> `BudgetPrecheckRequest` is `additionalProperties: false`): an older
> backend's spec does not declare `idempotencyKey`, so request validation
> REFUSES the field with a 400 ("body must NOT have additional properties"),
> not silently ignores it. The hosted tool's catch block only recognizes a
> decided 403 `delegation_budget_exceeded` as a refusal; a 400 falls to the
> generic branch and degrades to `sufficient: null` with
> `ALLOWANCE_CHECK_UNAVAILABLE` — the SAME safe degrade as a transport
> failure, just for a different reason. An older MCP against the new
> backend never sends the field and gets today's (occasionally
> over-refusing) behavior. Deploy order is backend → hosted MCP either way.
> Nothing else in this document was re-verified in this pass.
>
> **Re-verified #3527:** the #3492 gap above is closed. `isSettledX402Replay`
> (renamed from `isSettledErc7710Replay`) now accepts a settled EIP-3009 row
> on the SAME rule — `confirmed` + `tx_hash` is that scheme's FUNDING leg
> (treasury → delegate), the same fact `delegationReplay`'s own
> confirmed+tx_hash branch already treats as replayable for every scheme, so
> the pre-check's prior refusal was always false there too. The resource
> match is unchanged (it compares the request's `resourceUrl` against
> whichever value the row's own `x402_resource_url` column stores), but the
> CALLER now sends the right value per scheme:
> `haven_prepare_catalog_purchase` step 5b forwards `merchantUrl` on the
> erc7710 branch (unchanged) and `paymentRequired.resource.url` — the exact
> field `createX402Intent` persists for a 3009 row — on the 3009 branch, and
> forwards the EFFECTIVE idempotency key
> (`args.idempotency_key ?? quote.idempotencyKey`, the same key step 9
> authorizes with) rather than the explicit key only. On the hosted side, a
> confirmed EIP-3009 replay reaching `createX402Intent`'s own state-error
> path (`haven_prepare_catalog_purchase` step 9, `haven_pay_mcp_tool`'s 3009
> branch) used to surface as a bare `API_ERROR` — `settledReplayResponse`
> could not be reused as-is, because it hardcodes `settlement_scheme:
> 'erc7710'` and reports its replayed `tx_hash` as the SETTLEMENT hash, which
> is wrong on 3009 (that hash is the FUNDING leg; the merchant leg is a
> separate, re-read fact). A new helper,
> `eip3009ConfirmedReplayResponse` (`tools/support/guidance.ts`), re-reads
> `haven_get_payment_status` and splits in three, not two (review round 1
> S1/B1 corrected the first cut):
>
> - A merchant settlement VERIFIED on-chain (`merchant_settlement_recorded`)
>   → a DONE state with `settled: true`.
> - A merchant leg REPORTED but not yet verified (`delivered` on the status
>   wire, the `merchant_leg_reported` column) → ALSO a done state (nothing
>   left to sign or pay) but `settled: false`. In this answer, `settled: true`
>   means a VERIFIED on-chain settlement, never merely "the merchant
>   answered"; the answer carries `merchant_leg_reported` so the two done
>   shapes stay distinguishable.
> - Neither → the #2290 funded-awaiting-merchant remedy, but ONLY when the
>   re-read status's own `next_action` is one of the two real producers
>   (`retry_original_x402_request`, `sweep_stranded_funds`) — review round 1
>   B1: `isFundedX402AwaitingMerchantLeg` is false for its OWN first 15
>   minutes (`MERCHANT_REPORT_GRACE_MIN`), so a status read taken moments
>   after funding falls through to the plain confirmed mapping
>   (`next_action: none`, `message: "The payment is confirmed."`) even with
>   ZERO merchant evidence. Relaying that verbatim would have paired a
>   `next_tool` with `next_action: none` and no evidence behind it. Any other
>   action (the in-grace `none`, or a failed re-read) now answers
>   `check_status_later` instead, pointed at `haven_get_payment_status`, with
>   an honest reason that says funding confirmed and the merchant's delivery
>   is not recorded yet.
>
> `funding_tx_hash` is the row's own hash on every branch; `settlement_tx_hash`
> is ALWAYS `null` here — `getPaymentStatus` exposes only a verified BOOLEAN
> today, never the merchant's own settlement hash, so this never backfills
> one from the funding hash. No tool added, renamed or re-shaped; the local
> stdio runtime is not on this path (`haven_pay_mcp_tool` has no pre-check,
> same as #3492). The eip3009 pre-check's own refusal row also changes shape
> slightly: its `resource_url` now records the merchant's own declared
> resource (`paymentRequired.resource.url`) rather than the discovered
> merchant URL, matching what the stored row carries for this scheme.
> Nothing else in this document was re-verified in this pass.
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
> **Recent re-verification (#3506, sub-budgets user-completable):** both
> runtimes' `haven_submit` accept `sub_budget_id` (exactly one of
> `payment_id`, `task_budget_id` or `sub_budget_id`, plus `signature`). This
> completes the signer's existing `haven_sign { sub_budget_id }` →
> `haven_submit { sub_budget_id, signature }` handoff, which the hosted schema
> used to reject. The call goes through the SDK's new `submitSubBudget` to
> `POST /sub-budgets/:id/submit`. An opened row whose tree sibling is still
> pending names `haven_sign { sub_budget_id }` for the sibling. `haven_get_agent`'s
> response grew `pendingSubBudgetSignatures[]`. It is additive: the rows this
> agent must sign (the opens of an owner-issued sub-budget, or a `closing` row
> after an owner close), each with its `haven_sign` step. It reads
> `GET /sub-budgets?status=awaiting_signature`, and an older backend answer
> fails soft to `[]`. A stale sub-budget close (`close_needs_reprepare`) is
> recovered inside `haven_submit`, which re-prepares through
> `POST /sub-budgets/:id/close` and names `haven_sign` (or reports `closed`);
> `close_outcome_unconfirmed` asks to repeat the call later. No close tool is
> added. `next-step-signer-parity.test.ts` now pins both
> `haven_submit` handoffs (`SIGNER_HOSTED_HANDOFF_SHAPES`
> `'haven_submit#task_budget'` and `'haven_submit#sub_budget'`). The signer's
> `initialize` block gains `sub_budget_sign_context_versions` (additive) and
> its consent text names sub-budget signing. **Consent hash unchanged:**
> `SIGNER_CONSENT_SURFACE_VERSION` stays 2 (owner decision, copy-only), so no
> re-consent. No tool was added, removed or renamed, the strict/permissive
> split is untouched, and the version-skew contract does not move. A signer
> older than 0.7.0 cannot sign `sub_budget_id` at all; that is unchanged, and
> it needs no new notice. Nothing else in this document was re-verified in
> this pass.
>
> **Recent re-verification (#3330, sub-agent budgets):** the local runtime
> gained one new flow-keyed signable and one additive response field. The
> signer's `haven_sign` accepts `sub_budget_id` (an agent-issued sub-budget's
> open or close typed data, fetched from `GET /sub-budgets/:id/sign-context`
> and verified by `assertOwnSubBudgetChild` / `assertOwnSubBudgetCloseUserOp`
> before the key signs — the same fetch-then-verify discipline as the
> #3329 task-budget arm, byte-for-byte the same auth/timeout/refusal
> structuring). `haven_get_agent`'s response grew `parent_sub_budgets`
> (additive: the agent's open sub-budget grants naming the parent agent and
> the narrower effective limits; empty when it holds none — an older backend
> that omits the key still parses). The pay tools accept an optional
> `sub_budget_id` that routes the payment through the three-link
> `[grant, parent-child, budget]` chain and is mutually exclusive with
> `task_budget_id`. No tool was removed or renamed, the strict/permissive
> split is untouched, schemas stay in the contracts module, and the
> consent-hash and version-skew contracts do not move: `SUPPORTED_X402_EXPECTED_VERSIONS`
> is still `[1, 2, 3]` and the registered tool-NAME set grew only by the
> existing tools' optional field. The Supported Runtime Manifest table below
> stands.
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
> - [Where the Node floor is enforced](../operations/mcp-runtime-compatibility.md#where-the-node-floor-is-enforced) applies
>   to **both** topologies. The floor is a property of the machine, not of the
>   chosen topology — scoping it to the local path is exactly the mistake
>   [#1161](https://github.com/d-hinders/Haven-AI/issues/1161) fixed, so it is
>   documented in one place rather than split across two.
> - [Signer / hosted-MCP version skew](../operations/mcp-runtime-compatibility.md#signer--hosted-mcp-version-skew-1138-1143)
>   and its [pre-payment detection](../operations/mcp-runtime-compatibility.md#detecting-skew-before-a-payment-1155)
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
> **Recent re-verification (#3127, round 2):** the transaction feed's
> display-currency treatment is completed on the CONSUMER side — the
> dashboard frontend now represents `SEK` end to end, which is the surface
> `routes/transactions.ts`' converted triple is ultimately rendered by.
> (The consumer files themselves are NOT on this document's coverage list;
> their compatibility treatment is the frontend bundle's own release
> boundary, not a runtime contract here.) The served enum
> (`USD`/`EUR`/`SEK`, SEK the no-preference default) and everything the
> round-1 block asserts about the wire are unchanged: the route, the CSV
> branch, and the additive fields above still hold byte-identically, and
> the settings PUT was already documented as accepting SEK. What moved is
> presentation only — a SEK user now reads SEK figures in the sv-SE voice
> on every fiat surface instead of USD totals under a SEK label. No MCP
> tool, flag, auth step, consent hash, or version-skew contract changes;
> nothing about the local runtime's capabilities moves.

> **Re-verified (#4099, 2026-10-19 — the CSV `initiator` column's words):**
> this doc is coupled through `modules/transactions/csv-export.ts`. The
> server CSV's `initiator` cell now carries the app's words — `You` / the
> agent's name / `Unknown`, empty on inbound rows except an agent's
> delegate sweep — instead of the raw
> `human` / `agent` / `unknown` enum (owner decision, 2026-10-19). Column
> set and order are unchanged; the VALUES change for anyone reading
> `GET /transactions/export.csv`, which the dashboard downloads. No local
> runtime consumes it: `packages/cli`, `packages/mcp`, `packages/mcp-server`
> and `packages/sdk` neither read `initiatedBy` nor fetch the server CSV
> (`grep -rn "initiatedBy\|export.csv\|initiator"` over their `src/`,
> tests excluded, returns nothing at this head), and the CLI's own export
> builds its file from the JSON feed. On the JSON feed `initiatedBy: 'human'`
> becomes reachable — a value the spec has always declared — so no schema
> key, MCP tool, `next_tool` value, consent hash or version-skew contract
> changes. Scope of this note: the CSV module's `initiator` cell. Nothing
> else in this document was re-verified.

> **Re-verified unchanged (#3824, 2026-10-09 — serve-time approx amounts +
> grouped activity):** this doc is coupled through
> `routes/transactions.ts` (the only coverage-list file in the diff). The
> change is additive on the JSON feed only: rows without book-time fiat
> gain OPTIONAL `approxAmount` / `approxCurrency` (serve-time pricing via
> `getServeTimeFiatValues`, null never 0, struck in the same per-user
> preference currency the #3127 block documents); the CSV export path is
> byte-identical (pinned by test), so no importer contract shifts. The new
> dashboard activity grouping is a pure in-memory projection served beside
> the existing preview rows. No MCP tool, schema key, `next_tool` value,
> expected-context version, consent hash or version-skew contract changes;
> nothing about the local runtime's capabilities moves. Scope of this note:
> `routes/transactions.ts`'s response mapping and the new
> transactions-module files. Nothing else in this document was re-verified.
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
> **Re-verified (#3475, 2026-09-29):** `haven_report_settlement_evidence` now
> also takes an **eip3009** payment's merchant settlement, per the owner
> decision on #3475 (`haven_report_x402_outcome` keeps its no-hash contract).
> After a plain-HTTP purchase the agent retried the merchant itself, so the
> merchant's `PAYMENT-RESPONSE.transaction` reaches Haven only this way. The
> tool's input schema, strictness and response shape are unchanged; the
> backend seam behind the same `POST /machine-payments/evidence` decides by
> the payment. A funded eip3009 intent reported with a hash that is not its
> funding hash goes to `observeEip3009MerchantSettlement`, which verifies a
> delegate → merchant transfer of exactly the amount, mined after funding
> confirmed and before the report (so a settlement from a funded retry signed
> long after `expires_at` still qualifies), and records it as
> `machine_metadata.merchant_settlement_tx_hash`. The funding `tx_hash` and the
> evidence row's proof status do not move. Receipts (`haven_list_receipts`)
> then show that hash as `settlementTxHash`, ahead of the merchant's
> unverified echo, and `haven_get_payment_status` stops offering
> `retry_original_x402_request` for that payment: the merchant was provably
> paid, so a fresh header could only pay it twice. A refused report still
> classifies as `DELIVERED_UNSETTLED` or `SETTLEMENT_PENDING` (the same three
> outcomes; an eip3009 refusal leaves an already-confirmed payment as it was,
> and the backend's 409 body now carries a `reason`). The shared
> description drops its erc7710-only wording (−11 bytes, the #1591 total pin
> moves to 22,575), and the skill's plain-HTTP paragraph now tells the agent
> to report the transaction. Version skew: an older backend treats the report
> as the funding-hash attach and answers 409 `tx_hash_mismatch`, which the
> tool reports as `DELIVERED_UNSETTLED`, and records no hash. (The new
> backend writes the payment's base evidence row before its chain read, an
> idempotent upsert that never touches proof status.) No
> local-runtime twin, so the consent hash and the local signer are unchanged.
>
> **Re-verified (#3475 follow-up, 2026-09-30, review round 1 final shape):**
> `haven_report_x402_outcome` keeps its no-hash contract (still
> `payment_id`/`outcome`/`merchant_status`/`merchant_body`, no `tx_hash`
> input, per the owner decision), but an `accepted` outcome on an eip3009
> plain-HTTP payment with no merchant settlement recorded yet now names
> `haven_report_settlement_evidence` as `next_tool`, `payment_id` prefilled —
> where it used to answer "no tool follows" unconditionally on acceptance.
> `next_action` is UNCHANGED by this offer: it stays the status re-read's own
> answer (or the pre-existing per-outcome default, `none` on acceptance) —
> review round 1 rejected reusing `AgentPaymentNextAction.AwaitingSettlementEvidence`
> for this, because that value's published meaning is an erc7710 payment past
> its settlement window with no verified evidence, a different fact; the
> offer rides `next_tool` / `next_arguments` / `reason` only. The reason
> states the conditional: pass the merchant's `PAYMENT-RESPONSE.transaction`
> as `settlement_tx_hash` if it returned one, otherwise the purchase is
> already complete. Rejected outcomes, erc7710 payments, and a payment whose
> settlement is already recorded keep the old answer. The signal comes from
> `GET /machine-payments/:id/status`'s two new additive fields,
> `settlement_scheme` (`'eip3009' | 'erc7710' | null`; `null` when unknown or
> off the declared enum) and `merchant_settlement_recorded` (absent unless
> `true`) — read from the SAME status re-read the tool already performed, no
> second call. Because the offered `next_arguments` carries only `payment_id`
> and Haven does not yet hold a hash to prefill,
> `haven_report_settlement_evidence`'s own `settlement_tx_hash` argument is
> now OPTIONAL on the schema; a call that omits it SUCCEEDS as a no-op
> (`recorded: false`, `next_action: none`, zero backend calls) rather than
> refusing — review round 1's S3: an agent following `next_tool` /
> `next_arguments` verbatim must never get an error for doing exactly that.
> It still never records evidence without a real hash to verify. Version
> skew: an older backend never sets the two new status fields, so an
> older-backend response reads as absent/unknown and the tool falls back to
> its pre-existing "no tool follows" answer — the safe side, since erc7710
> and unrecorded-scheme payments already default there.
>
> **Re-verified (#3529, 2026-10-01):** a refused evidence report whose backend
> relayed a refusal `reason` — the #3475 evidence 409/503 contract, emitted
> only by the eip3009 settlement seam — is its own arm, keyed on the REASON's
> PRESENCE and never on payment status (on eip3009 "confirmed" means the
> FUNDING leg, so a status-keyed code would also fire on ordinary, correct
> refusals of mismatched hashes). New response code
> `SETTLEMENT_NOT_RECORDED` with the backend's sentence relayed verbatim as
> the additive `refusal_reason`: what Haven knows is that the payment's
> funding leg is confirmed and unchanged, and THIS hash was not accepted as
> its settlement — the old transfer-shape claim is gone from this arm, and
> `next_tool` stays `haven_get_payment_status`. A reasonless refusal (a plain
> mismatch, a foreign payment id, a validation refusal, or a pre-#3475
> backend) keeps `DELIVERED_UNSETTLED` with wording honest for every case
> that reaches it — including a confirmed payment behind an older backend —
> never claiming a confirmed funding it cannot know. The backend negative
> pins (a `payment_not_confirmed` 409 and the erc7710 seam's
> `settlement_unverified` 409 carry NO `reason`) are the other half of the
> contract: the discriminator cannot collapse. The shared description's
> nextActionGuidance names the new code (round 14 of the #1591 census),
> and the #3475 Not-filed item "a refusal on an already-confirmed payment
> still classifies as DELIVERED_UNSETTLED" closes with this.
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
>
> **Recent re-verification (#3420):** `haven_get_payment_status`'s
> delivered-but-unsettled state now ends. The #2970 answer
> (`awaiting_settlement_evidence`) is bounded by the sweep's LAST attribution
> chance — the verifier's own `notAfterSec` (`authorize` +
> `MAX_SETTLEMENT_WINDOW_SECONDS` + the exported `CLOCK_SKEW_SECONDS`,
> `settlement-observed.ts`); past that instant the same read answers the new
> additive phase `delivered_unverified` with the tool-less
> `next_action: stop_and_tell_user`, and the message says polling is over
> (the only live remedy left, a real hash via
> `haven_report_settlement_evidence`, works at any age). Within the horizon
> the `awaiting_settlement_evidence` message states the remaining patience as
> expiry-bounded ("until shortly after this payment's expiry") instead of the
> fixed "about two minutes", which read identically at 3 minutes and at 3
> hours. The status response also gains the additive `delivered: true` —
> present only when a `machine_payment_evidence` row records the merchant's
> response, omitted (never false) otherwise — so the status read now matches
> the `delivered: true` the settle call already reported. Local runtime:
> additive phase/next_action value and additive response field, forwarded
> unchanged like every other — same schemas, same strict-input policy, no
> route, migration, or signer change, and nothing about when the settle gate
> itself decides `settled`.
>
> **Recent re-verification (#3645):** `packages/mcp/README.md`'s *Audit log*
> section now states what the backend already does: an `agent_tool_invocations`
> row is written only for the eight tools on the backend's audit allowlist,
> so `haven_send`, `haven_submit`, the local `haven_pay_x402` and the hosted
> `haven_pay` leave none. The README previously said every
> call was recorded. Text only: no tool, argument, schema, description or
> consent input changes on either runtime, and the version-skew and
> consent-hash contracts do not move. `last-verified` is not re-stamped: this
> block is the scope. Nothing else in this document was re-verified in this
> pass.
>
> **Recent re-verification (#3645, 2026-10-07):** `scripts/README.md`'s
> internal-pin section now lists `ops` among the private consumers that pin
> `"*"` and adds `ops` and `ui` to the table's private rows, matching what
> `npm run lint:workspace-pins` already enforces by the `private: true` field.
> The published-package enumeration `release:bump:test` checks is unchanged.
> Text only: no tool, argument, schema, description or consent input changes,
> and the version-skew and consent-hash contracts do not move. Nothing else in
> this document was re-verified in this pass.

> **Re-verification (#3402, 2026-09-27):** the release-note generator's
> break notice gains a shorter form, "Includes a breaking change.", used only
> when "(+N more in the changelog)" follows it, so a summary names the
> changelog once. The covered `scripts/README.md` §7b and
> `scripts/release-bump.test.mjs` change with it. No served note changes:
> `client-releases.data.ts` is byte-identical, since the one real notice
> (connect 0.6.0-alpha.0) has no count. Nothing below moves.

> **Re-verification (#3393, 2026-09-27):** the generated
> `packages/core/src/client-releases.data.ts` changed in two ways, neither a
> runtime or compatibility change:
> - each release note gains an additive `summary_segments` field, `summary`
>   split into `{ text, code }` parts so `/releases` renders code as code. The
>   texts join to exactly `summary`, which is unchanged for every note but one;
> - that one is connect 0.6.0-alpha.0, whose summary omitted the break its
>   bullet carries and now ends "Includes a breaking change: see the changelog."
>
> `GET /discovery` and `/.well-known/haven.json` serve the new field. It is
> additive, so no client that parses these documents breaks, and no in-repo
> client reads `summary`. No version constant, tool, schema, capability,
> consent input or version-skew surface moved; `client-compat.ts` is untouched.
> The Supported Runtime Manifest table and every claim below stand unchanged.

> **Re-verification (#3305):** this doc's covered trees changed in four ways,
> none of which is a runtime or compatibility change:
> - each published CHANGELOG gains a header paragraph defining the
>   `**Update required**` marker;
> - `release-bump.mjs` gains a step that regenerates
>   `packages/core/src/client-releases.data.ts`, the release notes #3304 serves;
> - `client-releases.ts` now re-exports that generated data;
> - `scripts/README.md` documents the new step.
>
> No version constant, tool, schema, capability, consent input or version-skew
> surface moved, and `client-compat.ts` is not written by the bump. The
> Supported Runtime Manifest table and every claim below stand unchanged.

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

> **Re-verification (0.8.0-alpha.0 release, 2026-10-05):** the manifest table
> above is re-pinned by the bump to `0.8.0-alpha.0` for `connect`, `mcp`, `sdk`
> and `signer`, with `SDK_VERSION` rewritten beside it. The step from
> `0.7.0-alpha.0` is **MINOR**, for three narrowing breaks:
> - #3638: chain 100 leaves the SDK's x402 helpers.
> - #3464: `PostPurchaseAllowanceSummary.rail`/`source` narrow to the delegation
>   values (type-only; the retired values were unreachable at runtime).
> - #3518: `getAgentSummary().taskBudgets` lists only live rows.
>
> **Surfaces this release moves:**
> - **The tool set.** `haven_get_task_budget` is a new tool on **both** the hosted
>   and the local runtime (#3518). The local consent hash includes
>   the tool names, so **every local operator is asked to consent once more**
>   after updating.
> - **Tool arguments and results.**
>   - The sub-budget `haven_submit` handoff (#3506).
>   - `haven_send` / `haven_pay` results are compact by default, with an opt-in (#3524).
>   - An advisory, history-only `recipient.class` (#3531).
>   - The camelCase allowance summary, with snake_case deprecated (#3464).
> - **Signer consent text.** It now names sub-budget open and close (#3506).
>   `SIGNER_CONSENT_SURFACE_VERSION` is unchanged (the owner's copy-only
>   decision), so the signer consent hash does not change.
> - **Client minimums.** `CLIENT_COMPAT` is unchanged: `@haven_ai/signer`
>   `min_version` stays `0.6.0-alpha.0`.
>
> **Re-read, not rubber-stamped:** the Node floor and the Codex and Claude Code
> rows are unchanged. `last-verified` is not bumped.

> **Re-verification (0.12.0-alpha.0 release, 2026-10-29):** the manifest table
> above is re-pinned by the bump to `0.12.0-alpha.0` for `connect`, `mcp`, `sdk`
> and `signer`, with `SDK_VERSION` rewritten beside it. The step from
> `0.11.0-alpha.0` is **MINOR**: the range adds surfaces and removes none, and
> no CHANGELOG entry is marked **Update required**.
>
> Type-level changes for SDK consumers that build objects by hand:
> - `nextRefillAt` is now required on `HavenAllowance` and
>   `HavenAgentAllowanceSummary`;
> - `budgetEndedAt` is now required on `HavenAllowanceSummary` and
>   `HavenAgentSummary`;
> - `budgetRefillsAt` is now required on `HavenAgentSummary`;
> - `AgentPaymentWarningCode` gains `QUOTE_BUDGET_ENDED`.
>
> Code that only reads these types is unaffected. The `.d.ts` comparison against
> the published `0.11.0-alpha.0` (`sdk`, `signer`, `mcp`) removes no declaration
> name and adds three, all in `sdk`: `FundingConfirmationUnknownError`,
> `FundingRevertedError` and `HavenApiFailureCause` (#4470).
>
> **Surfaces this release moves:**
> - **SDK.** An ended budget is named apart from a spent one:
>   `delegation_expired` with the end date (#4352, #4458), the quote warning
>   `QUOTE_BUDGET_ENDED`, and spent-for-the-period told apart from no budget
>   (#4355). `haven_list_receipts` rows carry the six delivery fields the mapper
>   dropped (#4469). Retry or stop follows the failure's cause:
>   `HavenApiError.failureCause`, and a typed failed funding wait (504 for a timeout,
>   which was an untyped error; 502 for a revert, which was 500) (#4470). Runbook and skill wording: budget end dates (#4350),
>   which quote checks the budget (#4345), and the agent folder named by its
>   wiring slug (#4396).
> - **Signer.** Success results name their next step, and the settlement-child
>   guidance names the MCP route (#4449). Guidance only; no new signing path.
> - **Local MCP.** Embedded-SDK changes only: `haven_get_agent`'s description
>   and result name an ended budget and tell a spent budget from no budget
>   (#4352, #4355), receipt rows carry their delivery fields (#4469), and a
>   failed funding wait reports its cause: 504 for a timeout, which was an
>   untyped `UNKNOWN_ERROR`, and 502 for a revert, which was 500 (#4470). The
>   tool list is unchanged, so there is no re-consent prompt. `README` wording
>   (#4396).
> - **Connect.** The installed skill names the ended budget (#4352), tells a
>   spent budget from no budget (#4355), says which quote checks the budget
>   (#4345), and names the agent folder by its slug (#4396). Existing installs
>   keep their `SKILL.md` until reinstalled.
> - **CLI.** `budget grant --expires` refuses a date more than 365 days out
>   (#4351), and `haven guide`'s runbook gains the end-date and
>   `needs_approval` wording (#4350, #4352, #4355).
> - **Not moved.** `CLIENT_COMPAT` is unchanged (`git diff origin/main
>   origin/dev -- packages/core/src/client-compat.ts` is empty), so no installed
>   client is forced to update.
>
> **Re-read, not rubber-stamped:** the Node floor and the Codex and Claude Code
> rows are unchanged. `last-verified` already reads 2026-10-27 from an earlier
> change and is not bumped.

> **Re-verification (0.11.0-alpha.0 release, 2026-10-23):** the manifest table
> above is re-pinned by the bump to `0.11.0-alpha.0` for `connect`, `mcp`, `sdk`
> and `signer`, with `SDK_VERSION` rewritten beside it. The step from
> `0.10.0-alpha.0` is **MINOR**: the range adds surfaces and removes none, and
> no CHANGELOG entry is marked **Update required**.
>
> Three type-level widenings for SDK consumers: `HavenCatalogEntry.source`
> gains `'bazaar'` (#4245), `MerchantEgressRefusalReason` gains
> `'redirect_cross_origin_body'` (#4257), and `AgentPaymentWarningCode` gains
> `QUOTE_EXCEEDS_REMAINING_BUDGET` and `MERCHANT_REPORTED_DENIAL` (#3967). Only
> an exhaustive `switch` over one of them needs the new case. The `.d.ts` comparison against the published
> `0.10.0-alpha.0` (`sdk`, `signer`, `mcp`) removes and adds no declaration
> name; the other changes are optional fields and parameters.
>
> **Surfaces this release moves:**
> - **SDK.** Redirects no longer carry caller credentials or payment headers to
>   another origin, with or without `merchantEgress`, and a paid request is
>   never re-sent cross-origin (#4244, #4257). Settlement reports carry the
>   payment header (#4061) and the local report is retried while Haven answers
>   `retryable` (#4215). One merchant-answer decision for both paid paths
>   (#4120), and a plain tool error after funding is a rejection (#4062).
>   Quote-time budget and price warnings (#3967), `is_live` (#3922, #3923),
>   catalog `source: 'bazaar'` (#4245), and runbook and description wording
>   (#4079, #4168).
> - **Signer.** Only a funding-leg binding builds an EIP-3009 header; a
>   settlement-child binding is refused with `NO_FUNDING_LEG` and retired at
>   mint (#4242, #4248). Description text names the settlement report (#4061).
>   Narrower, not wider: no new signing path.
> - **Local MCP.** `haven_quote_x402` takes `expected_amount` for a price
>   check (#3967; no local budget check), `HAVEN_RPC_URL_<chainId>` wires
>   per-chain RPC reads (#3996), a cross-origin paid redirect reports the
>   funded, undelivered state (#4257), settlement reports carry the payment
>   header (#4061) with the #4215 retry, a plain tool error after funding is a
>   rejection (#4062), and `isLive` on task budgets (#3922).
> - **Connect.** The installed skill passes `payment_header` with the
>   settlement report (#4061) and names the quote's stop signals (#3967). Existing installs keep their `SKILL.md` until
>   reinstalled.
> - **CLI.** `budget grant` refuses an occupied slot (#3933), approve wording
>   (#4067), `is_live` on grant wait (#3922), passkey wording (#4168).
> - **Not moved.** `CLIENT_COMPAT` is unchanged (`git diff origin/main
>   origin/dev -- packages/core/src/client-compat.ts` is empty), so no installed
>   client is forced to update.
>
> **Re-read, not rubber-stamped:** the Node floor and the Codex and Claude Code
> rows are unchanged. `last-verified` already reads 2026-10-23 from an earlier
> change and is not bumped.

> **Re-verification (0.10.0-alpha.0 release, 2026-10-14):** the manifest table
> above is re-pinned by the bump to `0.10.0-alpha.0` for `connect`, `mcp`, `sdk`
> and `signer`, with `SDK_VERSION` rewritten beside it. The step from
> `0.9.0-alpha.0` is **MINOR**: the range adds surfaces and removes none, and no
> CHANGELOG entry is marked **Update required**.
>
> One type-level change for SDK consumers: `supersededBy` is a required field on
> `HavenAgent` and `HavenAllowanceSummary` (#3772). Code that only reads them is
> unaffected; code that builds them by hand (test mocks) adds
> `supersededBy: null`. The `.d.ts` diff against the published `0.9.0-alpha.0`
> removes no declaration name and adds five.
>
> **Surfaces this release moves:**
> - **Signer.** An EIP-3009 merchant header now carries a nonce derived from the
>   Haven payment id instead of a random one (#3888), so the backend can
>   attribute the merchant's settlement on-chain. The signed typed data is still
>   the x402 library's own. The tool list and consent text are unchanged.
> - **SDK.** Sign-in to a merchant's SIWX session before a multi-call flow
>   (#3838). Discovery entries carry `funding_leg_expected` /
>   `asset_transfer_methods` (#3839). `getAgent()`, `getAgentSummary()` and
>   `getAllowances()` carry `supersededBy` (#3772). The derived EIP-3009 nonce
>   (#3888) and runbook wording (#3892, PR #3894) are also in range. All additive.
> - **Local MCP.** `haven_get_agent` / `haven_get_allowances` warn a replaced
>   agent (#3772), discovery shows the funding-leg hint (#3839), and an
>   out-of-gas `MERCHANT_NOT_READY` refusal names the operator top-up (#3834).
> - **Connect.** `--doctor` / `--repair --name <slug>` update one named pair,
>   refuse ambiguous multi-agent repairs, and re-consent without a token
>   (#3799, PR #3827). Coexisting agents are listed rather than called "replaced"
>   (#3830). After a completed `--replace`, Haven is told which agent replaced
>   which (#3772). Existing installs are left as they are.
> - **CLI.** Agent runbook text only (`commands.ts` changes a code comment).
> - **Not moved.** `CLIENT_COMPAT` is unchanged (`git diff origin/main
>   origin/dev -- packages/core/src/client-compat.ts` is empty), so no installed
>   client is forced to update.
>
> **Re-read, not rubber-stamped:** the Node floor and the Codex and Claude Code
> rows are unchanged. `last-verified` already reads 2026-10-10 from an earlier
> change and is not bumped.

> **Re-verification (0.9.0-alpha.0 release, 2026-10-09):** the manifest table
> above is re-pinned by the bump to `0.9.0-alpha.0` for `connect`, `mcp`, `sdk`
> and `signer`, with `SDK_VERSION` rewritten beside it. The step from
> `0.8.1-alpha.0` is **MINOR**: the range adds surfaces and narrows or removes
> none; no CHANGELOG entry is marked **Update required**.
>
> **Surfaces this release moves:**
> - **Signer.** A new tool, `haven_sign_siwx` (#3728): a Sign-In-With-X
>   signature by the delegate key, moving no funds. The signer's instructions
>   gain an advisory identity line (#3738), and one consent line is reworded
>   (#3722), so the consent text differs.
> - **Connect.** A default setup names each new agent's pair `haven-<slug>` /
>   `haven-signer-<slug>` (#3737); `--bare` / `--replace` reach the bare pair;
>   `--json` gains `server_name`. A `--replace` or rebind warns that a running
>   session keeps acting as the previous agent (#3772). Existing installs are
>   left as they are.
> - **SDK.** Settlement-hash reporting (#3764), folded settlement evidence and
>   retry headers (#3727), the request-mode key lookup (#3739); skill text
>   split by scheme (#3774) and several wording fixes. Additive.
> - **Local MCP.** `haven_get_receipt` returns the signed bundle (#3723).
> - **CLI.** `haven agents revoke` refuses while a budget is live unless
>   `--keep-budget` (#3729).
> - **Not moved.** `CLIENT_COMPAT` is unchanged: `@haven_ai/signer`
>   `min_version` stays `0.6.0-alpha.0`, so no installed client is forced to
>   update.
>
> **Re-read, not rubber-stamped:** the Node floor and the Codex and Claude Code
> rows are unchanged. `last-verified` already reads 2026-10-08 from an earlier
> change and is not bumped.

> **Re-verification (0.8.1-alpha.0 release, 2026-10-07):** the manifest table
> above is re-pinned by the bump to `0.8.1-alpha.0` for `connect`, `mcp`, `sdk`
> and `signer`, with `SDK_VERSION` rewritten beside it. The step from
> `0.8.0-alpha.0` is **PATCH**: nothing in the range narrows or removes a
> published surface.
>
> **Surfaces this release moves:**
> - **CLI.** A new command, `haven feedback submit` (#3597), with a local secret
>   check before any request, and one agent-runbook line pointing at it. Additive.
> - **Setup-prompt text.** The SDK's `AGENT_COMMAND_MODIFICATION_SENTENCE` permits
>   the one user-chosen `--name`/`--replace` re-run after a `wiring_collision`
>   relay (#3689). Text only; no SDK method or API change.
> - **Not moved.** The tool set and tool arguments on both runtimes (no change
>   under `packages/mcp/src` or `packages/mcp-server/src` in the range; the
>   bump rewrites only their version literals), the signer (no change under `packages/signer/src`),
>   and the consent hashes. `CLIENT_COMPAT` is unchanged: `@haven_ai/signer`
>   `min_version` stays `0.6.0-alpha.0`.
>
> **Re-read, not rubber-stamped:** the Node floor and the Codex and Claude Code
> rows are unchanged. `last-verified` is not bumped.

> **Re-verification (0.7.0-alpha.0 release, 2026-09-29):** the manifest table
> above is re-pinned by the bump to `0.7.0-alpha.0` for `connect`, `mcp`, `sdk`
> and `signer`, with `SDK_VERSION` rewritten beside it. The step from the
> published `0.6.0-alpha.0` is **MINOR** for three breaks:
> - #3411 (#3447) closes the #2366 window. Five local tools now **refuse** the
>   legacy `idempotencyKey` spelling by name instead of accepting it with a
>   warning: `haven_send`, `haven_pay_mcp_tool`, `haven_quote_x402`,
>   `haven_pay_x402_quote` and `haven_pay_x402`.
> - The SDK's `ReceiptVerification` `reason` union widens (#3418).
> - The SDK's settled-replay error changes class (#3417).
>
> **Surfaces this release moves:**
> - **Tool arguments.** `sub_budget_id` is added, optional, on local `haven_send`,
>   `haven_pay_x402_quote` and `haven_pay_x402` (#3330). No local tool is added
>   or removed.
> - **The signer handshake.** It gains `SUPPORTED_SUB_BUDGET_SIGN_CONTEXT_VERSIONS`
>   (`[1]`) and a `{ sub_budget_id }` form of `haven_sign` (#3330). Its
>   redemption allowlist admits the three-link `[grant, parent-child, budget]`
>   chain.
> - **Signer input.** The signer now refuses an undeclared top-level argument
>   rather than stripping it (#3419, via #3454).
> - **Client minimum.** The first `CLIENT_COMPAT` minimum is live since #3428:
>   `@haven_ai/signer` `min_version` `0.6.0-alpha.0`. A signer below it is
>   refused with `client_outdated` at the payment and x402 sign-context reads.
>   The task-budget and sub-budget sign-context reads are not refusal points.
>   A signer at `0.7.0-alpha.0` clears it.
>
> **Re-read, not rubber-stamped.** The Node floor and the Codex and Claude Code
> rows are unchanged. `last-verified` is not bumped.

> **Re-verification (0.6.0-alpha.0 release, 2026-09-26):** the manifest table
> above is re-pinned by the bump to `0.6.0-alpha.0` for `connect`, `mcp`, `sdk`
> and `signer`, with `SDK_VERSION` rewritten beside it. The step from the
> published `0.5.0-alpha.1` is **MINOR** for one break: #3306 removes the four
> deprecated receipt twins from `haven_list_receipts` output on both runtimes.
> Surfaces this release moves, each recorded where it is owned:
> **the tool set** — three new local tools (#3329, *Task budgets* below), so the
> consent hash changes and every local operator is asked to consent once more,
> and the exported `HavenMcpToolName` union widens by those names; **the signer
> handshake** — `task_sign_context_versions` is additive beside
> `direct_sign_context_versions`, and the signer's redemption allowlist admits
> exactly one more shape, the two-link `[task child, budget]` chain; **hosted
> direct-payment guidance** — #3277's `haven_sign({ payment_id })` handoff and
> old-signer recovery (its own section below), whose skew rule is refusal
> recovery, never an `initialize` version comparison. The SDK's funding-leg pin
> (#3375) and `task_budget_id` forwarding (#3378) move no tool, argument or
> schema. Every `CLIENT_COMPAT` threshold is still null, so no client is hinted
> or refused. Re-read, not rubber-stamped: the Node floor and the Codex and
> Claude Code rows are unchanged. `last-verified` is not bumped.

> **Re-verification (0.5.0-alpha.1 release, 2026-09-25):** the manifest table
> above is re-pinned by the bump to `0.5.0-alpha.1` for `connect`, `mcp`, `sdk`
> and `signer`, and the bump also rewrote `SDK_VERSION` in
> `packages/sdk/src/client-identity.ts`, as the client-identity section below
> says it must. **`0.5.0-alpha.0` was cut but never published**: #3303
> (#3316) landed on `dev` after that cut and before its promotion, with its
> five CHANGELOG entries under `Unreleased`. Publishing it as alpha.0 would
> have shipped code its own CHANGELOG called unreleased, so alpha.1 stamps it.
> The published step is therefore `0.4.0-alpha.0` → `0.5.0-alpha.1`: MINOR,
> for exactly the fail-closed signer refusals the alpha.0 note below records.
> **#3303 adds no break.** Every client now sends `X-Haven-Client` (except the
> connector's read-only `probeHostedAgentIdentity`, behind `--doctor` /
> `--unwire`, which deliberately sends none), and the
> backend hints below a `recommended_version` and refuses (426) only below a
> SET `min_version`. Every threshold in `CLIENT_COMPAT` is null at this cut, so
> no client is hinted or refused by this release. The signer maps a future 426
> to its existing `SIGN_CONTEXT_REFUSED`; what is new is the
> `backend_error_code: 'client_outdated'` value and the `client_update` field,
> both additive.
> Re-read, not rubber-stamped: the Node floor and the Codex and Claude Code rows
> are unchanged. `last-verified` is not bumped.
>
> **Re-verification (0.5.0-alpha.0 release, 2026-09-25):** the manifest table
> above is re-pinned by the bump to `0.5.0-alpha.0` for `connect`, `mcp`, `sdk`
> and `signer`; the four numbers were not copied by hand. **Re-read, not
> rubber-stamped**: the Node floor (`>= 22.0.0`, CI on LTS 24 via `.nvmrc`) and
> the Codex and Claude Code rows are unchanged.
>
> **MINOR, because the signer now refuses things it used to sign.** Every break
> in this release narrows what a delegate key will sign (epic #3284), and every
> one moves **fail-closed** — a refusal, never a different signature. The two
> the signer's CHANGELOG marks BREAKING: `haven_sign`'s unbound branch signs
> only a bound direct-payment UserOp and **x402 expected-context v1 is retired**
> (#3272), and the x402 arm signs only a guarded funding leg or a verified
> settlement child (#3281). Alongside them, `haven_sign` refuses a bare
> `payload_hash` (#3169) and the signer CLI refuses unknown options (#3173). The
> SDK's `signForData` refuses the same shapes (#3283), so `mcp`'s payment tools
> inherit the narrowing through it. None of this is visible to a declaration
> diff — the lesson the 0.4.0 note above records applies again, one layer in:
> these are runtime refusals, and the CHANGELOGs are what name them.
>
> **The v1 retirement's skew, verified rather than assumed.** The signer's
> `SUPPORTED_X402_EXPECTED_VERSIONS` goes `[1, 2, 3]` → `[2, 3]`. The risky
> direction is a new signer against the backend still on `main` at cut time
> (`fe717b58`), which selects `payerDelegate ? 3 : typedDataHash ? 2 : 1` — so
> v1 is emittable there, where `dev` selects `payerDelegate ? 3 : 2`. Re-read at
> the cut: `main` has exactly three `signX402ExpectedContext` call sites
> (`delegation-authorize.ts` twice, `replay.ts` once). The first two pass
> `typedDataDigest(...)` of a value they always build. The replay site passes
> `typedDataDigest(sign_data.typed_data)`, and it too always builds that value:
> it returns `null` early when `prepared_user_op` is null (`replay.ts:94`,
> `:146`), and otherwise sets `typed_data` to an object on both branches
> (`delegationSigningPayload`, `userOpTypedData`). `typedDataDigest` throws on
> unhashable input rather than returning `undefined`. So v1 cannot be produced
> at any of the three sites, and the
> note's earlier claim holds: **a new signer meeting an old backend's v1 is not
> a live case.** The other direction is unaffected: an old signer against the
> new backend receives only v2/v3, which it has always supported.
>
> `last-verified` is **not** bumped: this note re-reads the manifest rows and the
> v1 skew claim, and nothing else in the document.

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
>
> **Re-verified #3210:** that resolution is now reachable from the CLI for
> `--doctor`. Until #3210 the argument parser refused a flagless `--doctor`
> before the doctor ran (a guard from #1597), so the record path above was
> exercised only by library callers. `--repair` keeps the parser requirement:
> it rewrites the runtime config, so the runtime it rewrites is named on the
> command line, never inherited from the record. The ladder is unchanged.

> **Re-verified (#3933, 2026-10-14, `haven budget grant` into an occupied
> slot):** this doc is coupled through `packages/cli/src/**`. The change: when
> the agent already has a live budget for the (token, recipient), the build is
> refused and `haven budget grant` exits `4` (refused) with a hint to edit
> that budget on the agent's page; under `--json` the error carries
> `error_code: "BUDGET_SLOT_OCCUPIED"` and `existing_delegation_hash`. No
> command, flag or other exit code moves, and no runtime, tool or connector
> behaviour this document describes changes. The rest of this document was
> not re-read for it.

> **Re-verified (#4530, 2026-10-29, passage only).** The rule above gained two
> sentences, and this block records the case that forced them. The change is
> instructions text only: the instructions are excluded from the contract
> fingerprint, no tool description and no input schema moved, so this is **not**
> a reconnect event and the fingerprint is unchanged.
>
> **The case the fingerprint cannot see.** A 0.12.0-alpha.0 production EIP-3009
> smoke test (Claude Code desktop, demo merchant) hit a client whose
> `tools/list` was **pre-0.11** — `haven_report_settlement_evidence` declared
> only `{payment_id, settlement_tx_hash}` with `additionalProperties: false`,
> and its description lacked the "On EIP-3009 also pass payment_header"
> sentence — while every result in the same session carried the **current**
> `contract_fingerprint` (`9f6a89fa545a01c3`, `main`'s contract, in which the
> tool does declare `payment_header`). The fingerprint check compares the
> instructions the client loaded at `initialize` against the fingerprint on a
> result; when both are current but the **tool list** is cached, it reports
> nothing. The agent then sent the report without the header, was refused with
> `SETTLEMENT_PROOF_HEADER_MISSING`, and was told to add a key its own schema
> said it could not send.
>
> **Reproduction status.** Reproduced by the owner on their own machine
> (2026-10-29, Claude Code in the desktop app), not in this build environment.
> Two full app restarts did **not** refresh the cached `tools/list`:
> `haven_report_settlement_evidence` stayed
> `{payment_id, settlement_tx_hash}` with no EIP-3009 sentence. `claude mcp
> remove haven-claude-cloud -s user`, then `claude mcp add` with the same URL
> and header, then a restart **did** refresh it — the tool then listed
> `payment_header` and its description carried "On EIP-3009 also pass
> payment_header". The server was `0.12.0-alpha.0` with
> `contract_fingerprint` `9f6a89fa545a01c3` before and after, so the
> fingerprint was correct throughout: the case is exactly current
> instructions and current results beside a cached pre-0.11 tool list, which
> the fingerprint comparison cannot see. The cache therefore lives in the
> client's tool-list layer, not in Haven — the client also accepted and sent
> the undeclared key once the agent passed it — and remove/re-add is the
> working remedy, which is what the owner decision below records.
>
> **The owner's ruling (2026-10-29, option 2), now in the server
> instructions.** Two sentences were added to `HOSTED_INSTRUCTIONS`
> (`packages/mcp-server/src/server.ts`):
>
> - Sending a `next_arguments` that Haven returned, **verbatim**, is always
>   allowed, even when a key in it is missing from the schema the client
>   loaded. Sending Haven's own arguments unchanged is not hand-building or
>   reshaping — the prohibition is on reshaping a payload to fit, not on
>   passing through what the server handed you.
> - When a reconnect or restart does **not** change the tool list, the remedy
>   is to **remove and re-add the hosted MCP server entry** in the client. The
>   instructions previously named only reconnect or restart, which this case
>   shows can be insufficient.
>
> **Does the prefill fix detection?** No — and it is not meant to. The
> `payment_header` prefill (#4530 A) removes the *consequence* of a cached
> list: the retryable settlement-evidence handoffs now carry the header the
> call forwarded, so an agent holding a pre-0.11 schema no longer has to add a
> key its schema lacks, and the amended rule says passing Haven's own
> `next_arguments` through is allowed. Detection of a client whose
> instructions are current but whose tool list is cached remains impossible
> from the fingerprint alone. A further change would need the client to echo
> the tool-list hash it loaded (a `tools/list`-derived value sent back on each
> call) so the server can compare it — a new detection mechanism, out of scope
> without an owner decision, and the tool-description budget is at its cap
> (#4123 §3).

  > **Re-verified #3411 (2026-09-28), idempotency spelling only:** the local
  > `@haven_ai/mcp` now refuses `idempotencyKey` too
  > (`IDEMPOTENCY_KEY_RENAMED`), so both surfaces take `idempotency_key`. An
  > `idempotencyKey` in a hosted refusal usually means a pre-#3411 local
  > caller, or one copying the SDK's camelCase spelling; the #2366 spelling
  > half of that convergence is done. The `quote` crossover above is
  > unchanged. Nothing else in this document was re-verified.

> **Re-verified (#3392, 2026-09-27):** the replay recipes above gained one
> refusal on every runtime: a keyed retry naming a DIFFERENT `task_budget_id`
> / `taskBudgetId` than the stored intent was charged under — or none where
> the row has one, or one where it has none — now answers 409
> (`…different x402 task_budget` on `/x402`; the sibling wording on
> `/payments`) instead of replaying the first payment charged to the other
> budget. SDK `0.6.0-alpha.0` and later additionally refuse locally, before
> any network call, when the client's own receipt cache or in-flight entry
> was created under a different budget (`X402TaskBudgetMismatchError`);
> published SDKs before that never send the budget, so their retries are
> none-vs-none and replay exactly as before. No wire field moves and no
> runtime needs an update for calls that never name a task budget.

> **Re-verified (#3417, 2026-09-28):** the `confirmed` arm of the replay
> recipe above did not reach the agent as described. The backend answers with
> the `tx_hash` and no `sign_data`, but the SDK's erc7710 path read the
> missing `sign_data` as a scheme mismatch, so all three hosted entry points
> returned a 500 with "retry once". That is a deterministic dead end: the
> retry gets the same answer. The hosted entry points now answer a settled key
> with a done state instead: `settled: true`, `idempotent_replay: true`,
> `settlement_tx_hash`, `next_action: none`, and no `next_tool`. That holds only
> when the confirmed row pays the merchant this call names (`to`) for the
> resource it names (`resource_url`). The backend's lookup is keyed on the
> idempotency key alone, so a key reused for another payee or resource, or
> first spent on an EIP-3009 funding leg (whose payee is the delegate), answers
> a 409 "use a new idempotency key" refusal instead. Amount and the MCP tool
> call are not compared, so a key reused for a different tool at the same MCP
> merchant endpoint answers with that merchant's original settlement. This is
> hosted-only; no signer
> or connector version is involved. An SDK consumer calling
> `prepareX402Erc7710()` with an `idempotencyKey` gets the typed
> `X402Erc7710AlreadySettledError` (or the 409 `HavenApiError`) from the first
> SDK built with this change. (`settleX402Erc7710()` shares the check, but its
> typed options carry no idempotency key, so it does not reach a replay.)
> Every SDK published before it (`alpha`/`latest` `0.6.0-alpha.0` and the `dev`
> snapshots before it) still throws the scheme-mismatch `HavenApiError` for
> that answer.

> **Re-verified (#3423 slice B, 2026-09-29):** the settle half of the same
> story. A repeated `POST /x402/:id/settle` on an erc7710 payment that already
> settled answers a typed 409 `payment_already_settled` with `payment_id` and
> `tx_hash`. An EIP-3009 funding row and a `submitted` row keep the plain 409.
> The SDK's `submitX402Erc7710()` turns it into `X402Erc7710AlreadySettledError`,
> and the hosted `haven_settle_mcp_tool` answers the #3417 done state without
> calling the merchant again; `haven_submit` with `settlement_scheme: 'erc7710'`
> answers the same done state (before this change it answered `API_ERROR`).
> Version skew: an SDK older than this change surfaces the typed 409 as a plain `HavenApiError` 409, the same class it
> threw before, and its body now carries the hash. A hosted server older than
> this change answers `API_ERROR`. No signer or connector version is
> involved. Nothing else in this document was re-verified.

> **Re-verified #3493 (2026-09-30):** `haven_pay_mcp_tool`'s erc7710 branch
> now passes `mcpCallContext` to `prepareX402Erc7710`, like its EIP-3009
> branch and both `haven_prepare_catalog_purchase` branches, so the
> rehydration above holds for every `haven_pay_mcp_tool` intent on either
> scheme. Hosted-only change: the backend has persisted `mcpCallContext` on
> the erc7710 authorize since #1307 (`delegation-authorize.ts`), and the
> SDK's `prepareX402Erc7710` has forwarded it since #1547; no signer,
> connector or SDK version is involved. One more case with no stored context: an erc7710
> `haven_pay_mcp_tool` intent authorized by a hosted server older than this
> change. Settling it with `payment_id` alone gets the same
> `MERCHANT_CALL_CONTEXT_UNAVAILABLE` refusal and the same explicit-fields
> fallback, within the child's short window. Nothing else in this document
> was re-verified.

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
>
> **Re-verified #4062 (2026-10-19 — a plain tool error after funding is a
> rejection):** the EIP-3009 settle/complete legs now treat a PLAIN
> `isError: true` tool result — neither a payment-required challenge nor a
> settlement receipt — as `ok: false`, exactly like the two in-band signals
> above: the hosted refusal is thrown as MERCHANT_REJECTED_AFTER_FUNDING
> (402 for the HTTP-200 answer, the message now naming verify-then-sweep —
> check `haven_get_payment_status` before `haven_sweep_delegate`), and the
> local paid retry throws the same 402 `x402_retry_rejected_after_funding`
> marker after recording `merchant_retry_rejected_after_payment`, so
> `haven_get_payment_status` shows the stranded delegate balance instead of
> `next_action: none`. A tool error beside a settlement hash stays
> delivered; a JSON-RPC `error` envelope (no `result`) stays `ok` (#3155
> S4, unchanged). No tool added, renamed or re-shaped; no argument, schema,
> strict/permissive split, tool-NAME set, version-skew or consent-hash
> contract moves — the refusal shape is the existing
> MERCHANT_REJECTED_AFTER_FUNDING envelope, reached through the same
> `deliverMerchantPayment` choke point. Scope of this note: the acceptance
> gate in `client.ts`/`merchant-completion.ts` and the refusal message;
> `last-verified` is bumped to 2026-10-19 for exactly this coverage.

> **Re-verified #4120 (2026-10-20 — one shared post-funding merchant-answer
> decision; the hosted hash rule becomes the local rule):** the
> accepted/rejected-after-funding verdict, the settlement hash and the
> protocol receipt now live in ONE module,
> `packages/sdk/src/merchant-answer.ts` (added to this doc's `covers:` here),
> called by both `completeX402MerchantCall` and `MerchantCompletion.retryRequest`.
> On the D1 input — a `PAYMENT-RESPONSE` header with no transaction (or an
> empty header) beside a `_meta` settlement that has one — the HOSTED path now
> behaves as the local path always has: an `isError` answer beside a `_meta`
> settlement is accepted (evidence, not `MERCHANT_REJECTED_AFTER_FUNDING`);
> without `isError` the result carries the `_meta` settlement hash, the #3764
> second report is posted with it, and an erc7710 completion anchors on it. A
> header WITH a transaction still wins over a different `_meta` transaction on
> both paths. The D2 divergence is PRESERVED per caller: a 200 `text/plain`
> `isError` body is still parsed (and rejected) on the hosted path and never
> read (so accepted) on the local path — only the verdict moved, not the
> parsing. No tool added, renamed or re-shaped; no argument, schema,
> strict/permissive split, tool-NAME set, version-skew or consent-hash
> contract moves: `completeX402MerchantCall`'s return shape, the evidence
> header names, the local `x402_retry_rejected_after_funding` 402 and the
> report ordering are all unchanged. The backend still verifies every reported
> hash on-chain before recording it. `last-verified` already reads 2026-10-20.

> **Re-verified #3030 (2026-09-21, request validation slice 2):** the two
> covered files this diff touches, `routes/transactions.ts` and
> `routes/user-accounts.ts`, now have their request shapes enforced from the
> OpenAPI spec (`index.ts` `enforcedModules`) instead of by hand in the
> handlers. For the naming window described above nothing moves: `?safeId=`
> is still DECLARED in the spec so it can still be REFUSED with the retired-
> name 400 (that verdict runs in the handler, after validation, exactly as
> before), a malformed `?accountId=` is now refused by the spec's uuid schema
> (it always declared one; it is enforced now), and the dual-emitted response
> keys are untouched. What a
> published client that sent a malformed filter sees changed: the hand-rolled
> `{ error: 'Invalid accountId' }` became the spec's 400 envelope
> (`error_code: invalid_request`, `details` naming the field). The CLI sends
> only well-formed filters (typed from `api-types.ts`), so no shipped version
> is affected; the manifest table and `SUPPORTED_X402_EXPECTED_VERSIONS` are
> unchanged. Scope of this note: those two files' request-shape edits.
> Nothing else in this document was re-verified.

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
  >
  > **Re-verified #3830:** on Claude Code the doctor now reads `~/.claude.json`
  > (user-scope `mcpServers` and every `projects[<path>].mcpServers`) as
  > wiring evidence: a directory whose named pair or signer wrapper appears
  > there classifies `wired`, so a second agent the user connected on purpose
  > is no longer labelled superseded and still spend-capable. Only server names,
  > commands, args and URLs are kept — never `env` or `headers` — and the text
  > is matched, never printed. The evidence is additive: absence proves
  > nothing (project `.mcp.json` files are not discoverable), so a directory
  > the file does not name keeps the fallback verdict and the advisory, whose label now
  > reads "Other agent credentials (wiring not verifiable)" instead of
  > asserting "superseded" (nor does the human inventory row, which reads "not
  > verified as wired"). A directory the evidence upgrades to `wired` runs the
  > full per-agent check set like a wired agent on Codex, so its failures now
  > reach the exit code. The inventory `classification` values are unchanged,
  > and the runtime-config checks still take the CLI-managed skip.

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

> **Re-verified #3167 (2026-09-20):** the covered file this diff touches is
> `packages/backend/src/routes/agents.ts` — the agent rows the MCP server
> lists now carry an extra read-only `labels[]` field (the #3167 tag
> vocabulary). The wire contract the MCP server depends on did not move: no
> existing field changed shape or name, no request the server sends gained a
> required member (the only new write route, `PUT /agents/:id/labels`, is a
> dashboard surface no MCP client calls), and an extra response field is the
> additive case every consumer ignores. Version-skew and consent-hash
> contracts are untouched. Scope of this note: the `labels[]` addition on the
> agent rows. Nothing else in this document was re-verified.

> **Re-verified #3164 (2026-09-22):** same covered file,
> `packages/backend/src/routes/agents.ts`, same class of change as #3167 —
> the agent rows the MCP server lists now carry an extra read-only
> `organization_id` field (the #3164 folder placement; null = top level).
> The wire contract the MCP server depends on did not move: no existing
> field changed shape or name, no request the server sends gained a required
> member (`organization_id` on `PUT /agents/:id` is optional and a dashboard
> surface no MCP client calls; the new `/organizations` routes are a
> separate dashboard module), and an extra response field is the additive
> case every consumer ignores. Version-skew and consent-hash contracts are
> untouched. Scope of this note: the `organization_id` addition on the agent
> rows. Nothing else in this document was re-verified.

> **Re-verification (#3214, every branch of `normalizeError` names its next
> step, 2026-09-21):** this diff touches
> `packages/mcp-server/src/tools/support/errors.ts` (the three generic
> branches of `normalizeError`), the next-step tests and fixtures, and
> `packages/mcp-server/src/tools/plain-http-x402.test.ts` (the live-500
> replay). The #3102 note above recorded "no hosted refusal carries a bare
> `next_action`"; that held only for refusals that carry a `next_action` —
> the `HavenApiError`, `HavenError` and `UNKNOWN_ERROR` branches returned
> `code`/`message`/`statusCode`/`paymentId` and nothing else, and a transient
> upstream 500 during `haven_quote_x402` (the live refusal that filed #3214)
> landed in exactly that gap. Each of the three branches now emits a typed
> step through the same builder and `nextStepWireFields` spread as the
> payment-state branch: a 5xx (or status-less) `HavenApiError` →
> `next_action: retry_with_explicit_context` with `next_tool_omitted_reason`
> saying re-call the same tool with the same arguments (and the same
> idempotency key) once; a 4xx `HavenApiError`, a `HavenError` and the
> `UNKNOWN_ERROR` fallback → `next_action: stop_and_tell_user` with its
> omitted reason. None of the three names a tool (`normalizeError` serves
> every tool; the agent's own last call says which to re-run). Additive only:
> no error class changes shape, nothing is thrown that was not thrown before,
> no payment behaviour moves, and every field the three branches emitted
> before is byte-identical — pinned by the characterization census (35
> refusal fixtures, 41 `refusalNextStep` calls) written over the four bare
> shapes before the change, plus the per-branch ratchet cases. Scope of this
> note: those fields. Nothing else in this document was re-verified.

> **Re-verification (#3416, 2026-09-28):** `normalizeError` gains one branch
> ahead of the generic `HavenApiError` pair. A `HavenApiError` whose body
> carries `error_code: 'rail_unavailable_for_chain'`, the backend's typed 503
> for a chain the deployment has no bundler credential for, becomes
> `code: RAIL_UNAVAILABLE_FOR_CHAIN` with `next_action: stop_and_tell_user`
> and a `next_tool_omitted_reason`. Without the branch it would fall into the
> 5xx "retry once" step above, and the retry cannot succeed until an operator
> provisions the chain. Hosted-only: no signer, connector or SDK version is
> involved, and every other branch is unchanged. It is pinned by one new
> refusal fixture (the census moves to 37 fixtures and 46 `refusalNextStep`
> calls). Nothing else in this document was re-verified.

> **Re-verification (#3500, 2026-09-30):** `normalizeError` gains a second
> typed branch next to #3416's. A `HavenApiError` whose body carries
> `error_code: 'task_budget_exceeded'` becomes `code: TASK_BUDGET_EXCEEDED`
> with `next_action: stop_and_tell_user`, the body's `task_budget_id` and
> `remaining_atomic`, and a `next_tool_omitted_reason` naming the remedy
> (close the task budget and open a new one, or pay without it). The backend
> answers that 403 on every path that takes a task budget (`POST /payments`,
> both x402 authorize legs) when the task child's
> `ERC20TransferAmountEnforcer.spentMap` shows the cap cannot cover the
> payment. Before, the same condition reached the agent as the 5xx
> "transient, retry once" step, with a raw simulation dump; on the erc7710
> leg it only failed at the merchant's redemption. Hosted-only mapping: no
> signer, connector or SDK version is involved, and every other branch is
> unchanged. A backend older than this change keeps the old 502, and a hosted
> server older than it shows the 403 as the generic 4xx `API_ERROR` stop.
> Pinned by one new refusal fixture (the census moves to 39 fixtures and 48
> `refusalNextStep` calls). Nothing else in this document was re-verified.

> **Re-verification (#3230, the next-step ratchet refuses an empty scan,
> 2026-09-23):** this diff touches `scripts/lint-next-steps.mjs` (listed in
> `covers:` above). The gate's NUMERATOR is untouched — what counts as an
> unnamed emission or an argument-less discovery entry, the block-parsing
> rules, the baseline shape and the `--update` growth refusal are all
> byte-identical. What changed is when the gate is allowed to speak at all:
> `scan()` additionally returns a per-target read census, and `main` refuses
> (exit 1) when any `SCAN_TARGETS` entry matched no files, so the ✓ verdict
> and the `--update` write can no longer be produced over a zero-file scan
> (the quality scan 2026-09-22 measured both passing with all five targets
> moved aside). Nothing this document states about the contract moves: the
> same emissions are still demanded to name a tool or an omitted-reason, the
> baseline stays at zero, and the extra refusal only fires on a broken scan
> configuration, never on a scanned one. The success line now also prints
> the number of files read. Scope of this note: the lint gate itself.
> Nothing else in this document was re-verified.

> **Re-verified #3227 (2026-09-23, repository tenant scope):** this diff
> touches `routes/user-accounts.ts`, a covered file, in its unlink handler
> only. When the now tenant-scoped delete matches no row, the handler re-reads
> ownership and answers 200 if the account is already gone, the way a
> concurrent second unlink by the same owner answered before this change.
> The set of statuses the route returns (200, 404, 409) and every response
> body are unchanged. No published CLI, SDK, MCP or connector version calls
> the unlink or re-default routes; only the dashboard does
> (`git grep -n "user/accounts" packages/{cli,sdk,mcp,mcp-server,connect}/src`
> finds only the account list, the funding read and the rename). Scope of this note: that
> handler. Nothing else in this document was re-verified.

> **Re-verified #3228 (2026-09-23, branch-hygiene source):** this diff
> touches `.github/workflows/ci.yml`, a covered file, in one comment only —
> the branch-hygiene report reads merged PRs' commits now, not `dev`'s
> history. No step, job, trigger, publish path or runtime check changes.
> Scope of this note: that comment. Nothing else in this document was
> re-verified.

> **Re-verified #3253 (2026-09-23, hosted instructions name the plain-HTTP
> x402 path):** this diff touches `packages/mcp-server/src/server.ts`, a
> covered file, in `HOSTED_INSTRUCTIONS` only. The instructions gain one
> paragraph naming the plain-HTTP sequence the per-tool guidance already
> drives — `haven_quote_x402` → `haven_pay_x402_quote` with `url` set to the
> quote's `request_url`, then the EIP-3009 branch (`haven_sign_x402` →
> `haven_submit` → the agent's own merchant retry → `haven_report_x402_outcome`)
> or the erc7710 branch (`haven_sign` → `haven_submit` with
> `settlement_scheme: "erc7710"` → the agent's retry, no outcome report) — and
> the session bootstrap now says `haven_get_agent` runs at the start of every
> session, with `haven_discover_tools` allowed in parallel when discovery is
> needed. No tool, schema key, `next_tool` value, expected-context version or
> signer contract changes; the local runtime's instructions
> (`packages/mcp/src/server.ts`) are untouched. Scope of this note: that
> text. Nothing else in this document was re-verified.

> **Re-verified #3251 (2026-09-23, the tombstone ledger follows the
> credential root):** this diff touches `packages/connect/src/{tombstone,
> runtime,cli,doctor}.ts` and the connect test setup. The `--tombstone`,
> `--unwire` and `--replace` writers now mirror a retirement record into the
> ledger of the root that holds the retired directory, and `--doctor` reads
> the ledger of the root it scans. For the default root that is
> `~/.haven/tombstones`, unchanged; any other root keeps it inside itself at
> `<root>/.tombstones/` and no longer mirrors into the ambient home. The record's fields, its redaction and its no-key
> boundary are unchanged, and nothing is revoked. The connect test suite now
> runs against a scratch `HOME` and `TMPDIR`. The `--tombstone` entry above
> gains the ledger-location sentence. Scope of this note: those files.
> Nothing else in this document was re-verified.

> **Re-verified #3259 (2026-09-23, a failed tombstone mirror no longer skips
> the `--replace` key teardown):** this diff touches
> `packages/connect/src/{tombstone,unwire,runtime,cli}.ts`. `writeAgentTombstone`
> now catches a failed ledger mirror and returns `recordPath: null` plus
> `mirrorError` (errno code only), and every caller reports it. `--replace`
> still runs `teardownLocalKeyMaterial` and gains an additive
> `retirement_mirror_errors` in its outcome, `--tombstone` still exits 0, and
> `--unwire --json` gains an additive `mirror_error`. The outcome-fields
> paragraph gains the new field. The `--tombstone --json`
> entry above gains the mirror-failure sentence. The record's fields,
> redaction and no-key boundary are unchanged, and nothing is revoked. Scope of
> this note: those files. Nothing else in this document was re-verified.

> **Re-verified #3032 (2026-09-24, connector request fields declared):** this
> diff touches `packages/backend/src/routes/agent-connection-setups.ts`, a
> covered file, only to move the four OWNER routes' auth hook to `onRequest`.
> The connector's own routes (`/register`, `/:setupId/install-status`,
> `/:setupId/connector-status`) are untouched. The OpenAPI request schemas now
> declare the fields `@haven_ai/connect` already sends: `mcp_server_name` on
> register, and `skill_installed` and the `superseded_agent_ids` tri-state on
> install-status. These are loosenings, so a published connector's requests are
> accepted exactly as before, in shadow or enforced, and no connector
> behaviour, tool schema, runtime floor or failure code moves. Scope of this
> note: those schemas and that hook. Nothing else in this document was
> re-verified.

> **Re-verified #3032 (2026-09-25, request validation slice 4, the
> enforcement itself):** this diff touches the same covered files again —
> `routes/agent-connection-setups.ts` and `routes/agents.ts` — and moves no
> wire contract the MCP server or connector depends on. The handler-side
> shape rungs (name string-ness, setup-token string-ness, MCP-server-name
> regex entry, 23505 unique narrowing) are deleted because the OpenAPI
> schemas (including the #3276 loosenings above) state each one, and the
> five modules join `enforcedModules` with the mode default flipped to
> `enforce`: an off-spec request now answers the 400 envelope BEFORE the
> handler, where before it reached the handler's own 400/401. For conformant
> connector and MCP traffic — the only traffic this document's skew and
> consent-hash contracts are about — nothing changes: every field those
> clients send is declared, coercion converts the loose-typed extras the
> schemas permit, and the handler-side normalisation (`mcp_server_name` →
> null when malformed, `superseded_agent_ids` filtering) is unchanged. A
> connector that today gets a 400 from a handler rung gets the same 400 from
> the envelope, naming the field. Version-skew and consent-hash contracts
> are untouched. Scope of this note: the validation plumbing and the mode
> default. Nothing else in this document was re-verified.

> **Re-verified unchanged (#3267, 2026-09-24, the Safe-era identifier rename):**
> this doc is coupled through `routes/transactions.ts`,
> `routes/user-accounts.ts` and `routes/agent-connection-setups.ts` (the
> `middleware/retired-safe-names.ts` coverage is untouched — the file is not in
> the diff). Each change is an internal identifier rename: the locals
> `safes` / `allSafes` → `accounts` / `allAccounts` on the transactions feed
> and filters with no response-shape change, one comment in
> `user-accounts.ts`, and the internal `ApprovalStateInput.safeTxHash` →
> `accountTxHash` input field on `agent-connection-setups.ts` — a value the
> repo layer already wrote to the `account_tx_hash` column, not a wire input.
> No tool, schema key, `next_tool` value, expected-context version or signer
> contract changes. Scope of this note: those renames — nothing else in this
> document was re-verified.

> **Re-verified #3307 (2026-09-25, Haven-owned addresses checksummed on the
> receipt, payment-status and payment reads):** this diff changes the *values*
> of several read tools on both MCP runtimes. No names or schemas change.
> - **Receipt:** `haven_list_receipts` / `GET /machine-payments/receipts`,
>   checksummed in `mapEvidence`. Covers `merchantAddress`, `payerAddress`,
>   `settlementAddress`, `tokenAddress` and every `parties` entry.
> - **Payment status:** `haven_get_payment_status` and the `POST /payments`
>   idempotent-replay body. Covers every address: top-level
>   `merchant_address` / `payer_address`, the rail context (`asset`,
>   `x402` / `mpp` `.asset` / `.merchant_address`) and `parties`.
> - **`GET /payments/:id` and `GET /payments`:** checksum `to`.
> - **Why:** for one payment, the receipt and the status now carry the same
>   checksummed `merchant_address`, token address and `parties` (a
>   cross-surface real-Postgres test proves it). The transaction row (#3129)
>   uses the same `toCanonicalAddress` for its merchant and token addresses.
>
> **What stays as stored:**
> - Storage (`LOWER(...)`).
> - `tx_hash`.
> - The relayed merchant objects (#3125).
> - The signed receipt bundle (`haven_verify_receipt`).
> - **The resume state's rebuilt payment objects.** `haven_get_resume_state`
>   builds `accepted`, `paymentRequired`, the MPP `challenge` and its
>   `merchantAddress` from the row in stored casing, so what goes back to
>   merchants and signers is byte-identical. Every address
>   `haven_get_resume_state` returns stays in stored casing. The status the
>   lookup reads internally is checksummed, but it is not part of the response.
> - **Declared asymmetry:** the SDK's `X402Receipt.merchantTo` is now
>   checksummed on the resume path, where it is read from the status. On a
>   fresh payment it stays lowercase, because there it comes from the authorize
>   response's `merchant_to`, which sits inside Haven's signed binding.
>
> **Compatibility:**
> - The OpenAPI `address` pattern is case-agnostic, and the SDK mappers pass
>   values through.
> - No tool schema, package, version floor or failure code moves.
> - Every in-repo consumer compares addresses case-insensitively.
>
> Scope of this note: those tool results. Nothing else in this document was
> re-verified.
>
> **Re-verified unchanged (#3295, 2026-09-25, last-known balances):** this doc
> is coupled through `routes/user-accounts.ts`, whose change is comment-only:
> the funding endpoint's parity comment now states that `GET
> /balances/:accountAddress` serves a last-known balance on a failed read
> (#3295) while THIS endpoint still answers `'0'` and computes `funded` from
> it — behaviour byte-identical, the marker gap deferred by name to a
> follow-up. The `/user/accounts*` reads the CLI calls keep their shapes; no
> tool, schema key, `next_tool` value, expected-context version or signer
> contract changes. Scope of this note: that comment. Nothing else in this
> document was re-verified.
>
> **Re-verified unchanged (#3317, 2026-09-25, funding-endpoint degraded read):**
> this doc is coupled through `routes/user-accounts.ts`, whose funding endpoint
> now JOINS the #3295 degraded read instead of deferring it: a failed balance
> leg serves the last-known balance marked stale (or `'0'` marked
> `unavailable` when never read) and the response carries the additive optional
> `balanceFreshness` marker; `funded` is computed only from known values. The
> `/user/accounts*` reads the CLI calls keep their shapes — every previously
> required field stays required, the markers are optional additions on one
> read-only GET — so no tool, schema key, `next_tool` value, expected-context
> version or signer contract changes. Scope of this note: that endpoint's
> response shape. Nothing else in this document was re-verified.
>
> **Re-verified unchanged (#3318, 2026-09-25, CLI balance-freshness render):**
> this doc is coupled through `packages/cli/src/commands.ts` and
> `packages/cli/src/commands.test.ts`, and #3318 changes what the CLI's human
> output SHOWS, not what any party sends or accepts: `wallets balances` reads
> the additive optional `balanceFreshness` marker that #3295/#3317 already put
> on the wire and renders `≈ … (as of …)` for a stale entry and
> `unavailable` for a never-read one instead of presenting those figures as
> current. The CLI sends nothing new, accepts nothing new (the marker is
> optional and absent on clean reads), calls no new route, and the registry
> consumers — budget grant and connect, which read address/decimals/symbol —
> neither read nor render the marker. No tool, schema key, `next_tool` value,
> expected-context version or signer contract changes. Scope of this note:
> that rendering. Nothing else in this document was re-verified.
>
> **Re-verified #3319 (2026-09-25, agent-side allowance/identity addresses
> checksummed):** the residual after #3307 — the agent-side reads still
> emitting two addresses lowercase — is closed with the same
> `toCanonicalAddress` rule, at the response boundary, storage untouched.
> - **`haven_get_allowances`:** the top-level `delegate_address` and every
>   `allowances[].token_address` are checksummed (`handleGetAllowances`).
> - **`haven_get_agent`:** `delegate_address` is checksummed;
>   `account_address` and `delegate_account_address` are canonicalised through
>   the same total helper — a no-op on the checksummed forms they already
>   carry (viem-computed; verified live on dev), healing for any lowercase
>   row.
> - **`haven_check_funds`:** the `token_address` echo is canonicalised, so the
>   response carries ONE casing whether the caller sent a lowercase address, a
>   checksummed one, or a symbol (resolved from the now-checksummed
>   allowances read).
> - **`haven_get_payment_status` and `haven_settle_mcp_tool`:** no diff of
>   their own — the joined `allowance` block's `token_address` comes from the
>   allowances read (`account-reads.ts` copies `match.tokenAddress`), so it
>   is checksummed through the fix above. With that, the #3307 block's
>   "covers every address" is now true of the status tool result as a whole:
>   `asset` and `allowance.token_address` are the same checksummed string for
>   one payment.
>
> **What stays as stored:**
> - **Owner-side reads:** `allowances[].token_address` on `GET /agents`,
>   `GET /agents/:id`, `PUT /agents/:id` and `/dashboard` (via
>   `deriveDelegationAllowances`), and the `/agents/:id/delegations*` routes.
>   The owner and agent views of one delegation therefore differ in casing —
>   declared, not fixed; every frontend consumer compares case-insensitively.
> - **The budget-precheck refusal:** `merchant_address` is deliberately
>   lowercased and `asset` echoes the input.
> - **`rails/delegation-budget-view.ts`**, storage (`LOWER(...)` writes and
>   the `agent_delegations` CHECK), and the spec's owner-side `Delegation`
>   schema, whose "Stored lowercase" note stays true.
> - **The x402 binding:** the signer lowercases `delegate_address`
>   independently, so canonicalising the emitted value cannot move a signed
>   byte.
> - The x402 quote/prepare responses were not re-surveyed beyond the status
>   and settle paths above.
>
> **Compatibility:** the OpenAPI `address` pattern is case-agnostic, so no
> wire schema moves; no tool name, schema key, `next_tool` value,
> expected-context version or failure code changes; the SDK join and every
> in-repo consumer compares addresses case-insensitively. A real-DB route
> test seeds lowercase rows (the CHECK-constraint storage form) and pins the
> checksummed responses with raw storage reads guarding the boundary.
>
> Scope of this note: those tool results. Nothing else in this document was
> re-verified.

> **Re-verification (#3332, additive SDK `PaymentParties.buyer`, 2026-09-27):**
> this diff adds an OPTIONAL `buyer` field to `PaymentParties`/`RawPaymentParties`
> (`packages/sdk/src/types.ts`) and its mapping in `payment-mappers.ts`, present
> only when the backend has `HAVEN_OWNER_COMPANY_DETAILS` on and the owner has
> saved company details. No existing field, wire shape, or version-skew
> contract in this document moves: `mapParties` still maps the same four
> existing fields the same way, and the new field is additive and optional at
> every layer, so an older SDK reading a newer backend's response through the
> MAPPED surfaces (`listReceipts`/`listReceiptsPage`, and `packages/mcp-server`'s
> `haven_list_receipts`, which passes the SDK's typed object through unchanged)
> simply never sees it. Scoped precisely: `HavenClient.getReceipt()`
> (`packages/sdk/src/account-reads.ts`) is NOT one of those mapped surfaces — it
> passes the backend's JSON bundle through un-remapped, so
> `payment.parties.buyer` there is the raw, snake_case shape on the wire at
> runtime on ANY SDK version old or new (its own published type already says
> so: `PaymentReceipt['payment'].parties: RawPaymentParties`). Scope of this
> note: that one field, and this one precision about which surfaces are mapped.
> Nothing else in this document was re-verified.

> **Re-verification (release-bump constant table, 2026-09-29):** coupled
> through `scripts/release-bump.mjs`, `scripts/README.md` and
> `.github/workflows/ci.yml`. The bump rewrites the same six version constants
> and re-pins the same Supported Runtime Manifest table. Only the file it
> rewrites `SIGNER_VERSION` in changed, to `packages/signer/src/tools.ts`
> (#3454 moved it). CI now also runs `scripts/release-version-constants.test.mjs`,
> which fails when a constant the bump owns is no longer declared in the file
> the table names. No tool, capability, version-skew rule or manifest value
> moved.

> **Re-verification (#3504, 2026-10-01):** `normalizeError`
> (`packages/mcp-server/src/tools/support/errors.ts`) gains a third typed
> branch next to #3416's and #3500's. A `HavenApiError` whose body carries
> `error_code: 'delegation_budget_exceeded'` becomes
> `code: DELEGATION_BUDGET_EXCEEDED` with the backend's own
> `next_action: fund_account_or_raise_allowance` step and a
> `next_tool_omitted_reason` naming the remedy (the wallet owner raises the
> budget in Haven, or the period resets), plus the body's `remaining_atomic` /
> `shortfall_atomic` and, when the body carries them, `phase` and `rail`.
> Before this, the same condition reached the agent as the generic 4xx
> `API_ERROR` stop with `next_action: stop_and_tell_user` and no figures on
> every tool except the catalog prepare, whose own step-6 refusal already
> emits this code (it catches the same 403 upstream, so `normalizeError` never
> sees it there). The backend answers this 403 on every path that reads the
> delegation's period budget (`delegation-authorize.ts` on both x402 schemes,
> `mpp/budget-precheck.ts`, and since #3503 the direct `POST /payments`
> pre-check), so `haven_send` / `haven_pay` now surface the same typed refusal
> the catalog path does. Hosted-only mapping: no signer, connector or SDK
> version is involved, and every other branch is unchanged. A backend older
> than the pre-checks keeps its own shape, and a hosted server older than this
> shows the 403 as the generic 4xx `API_ERROR` stop. Pinned by one new refusal
> fixture (the census moves to 40 fixtures and 49 `refusalNextStep` calls).
> `last-verified` is re-stamped to 2026-10-01: the failure envelope this
> document's own re-verification trail pins is what changed. Nothing else in
> this document was re-verified.

> **Re-verification (#3494, 2026-10-01, updated in review rounds 1 and 2):**
> `POST /payments/:id/sign`'s failure catch (every rail the route relays — a
> direct payment and the EIP-3009 funding leg) now answers its 502 with a
> typed `error_code`, in the order the route checks them:
> `submission_outcome_unknown` (B1/B1', double-pay risk — checked FIRST):
> `sendUserOperation` resolved but the receipt wait itself errored or timed
> out (`SubmittedUserOpFailedError` with `reverted: false`, the default) —
> the UserOp MAY have landed, and Haven never learned the outcome.
> `next_action` is `stop_and_tell_user`, NOT `check_status_later` (round 1's
> mapping — this intent is already marked `failed` by `failSubmittedIntent`
> BEFORE this response is built, so `haven_get_payment_status` on the same
> payment_id answers "failed" immediately and forever; naming it as the next
> step, and round 1's message promising status would "confirm this one did
> not settle", invited reading that permanent "failed" answer as exactly
> that confirmation, then paying again — the double pay this code exists to
> prevent). The reason instead points at the account's REAL activity: Haven's
> own activity view, or the `user_op_hash` field this code's body now
> carries, on a block explorer. `signature_rejected` (AA24 only — the one
> ERC-4337 AA2x code this backend attributes to the signer);
> `account_validation_failed` (every OTHER AA2x code — AA20/21/22/23/25/26 —
> a real validation failure that is deliberately NEVER phrased as a signer
> problem); `task_budget_exceeded` / `delegation_budget_exceeded` (a budget
> revert caught at submit, re-confirmed from the enforcer's own current
> figure, same body shape the #3500/#3503 create-time pre-checks already
> answer — `asset` on `delegation_budget_exceeded` only, matching create
> time; neither carries a `message` field); and `onchain_execution_failed`
> for everything else, INCLUDING (round 2, N3) a `SubmittedUserOpFailedError`
> with `reverted: true` — the op executed and reverted, a KNOWN, confirmed
> outcome (the execution call reverts, so no token transfer and no delegation spend; only the EntryPoint nonce and the paymaster's sponsored gas are consumed),
> strictly distinct from the "truly unknown" case above. `normalizeError`
> gains four new typed branches next to #3416's/#3500's/#3504's: all four map
> to `stop_and_tell_user` (the budget two needed no new branch — #3500's and
> #3504's existing branches key on `error_code` alone, not the route or
> status code that produced it, so they already apply here unchanged). Also
> in this diff, on `agent-payment-status.ts` (a covered file): a `failed`
> intent's status now carries `failure_reason` (a bounded, redacted cause),
> and a direct intent's own `send_idempotency_key` is now surfaced as
> `idempotency_key` on status (`railContext` answered `{}` for the direct
> rail before this). `GET /payments/:id`'s `error_message` is bounded at the
> same read (300 characters plus an ellipsis if longer).
>
> Version-skew precision (round 2, R2-3): `failureReason` and
> `idempotencyKey` are NOT symmetric. `failureReason` requires an SDK release
> carrying `payment-mappers.ts`'s mapper — an older SDK against a newer
> backend simply omits the field. `idempotencyKey` requires ONLY the backend:
> the mapper already read `idempotency_key` generically before this diff, so
> any SDK that already shipped surfaces it the moment the backend starts
> sending it, no SDK release needed. The local `@haven_ai/mcp` (pins
> `@haven_ai/sdk` `0.7.0-alpha.0`, `packages/mcp/package.json`) therefore
> gains `failure_reason` only from the release that bumps its pinned SDK to
> one carrying the mapper, and gains the direct-row `idempotency_key`
> immediately once the backend ships it; the hosted server always bundles
> the workspace SDK, so neither question applies to the hosted path.
>
> No key, signature, delegation, caveat or budget changes. What DOES move on
> the wire, stated exactly rather than as "nothing moves": the sign-route
> 502's `error` text is reworded per cause, `details` is now bounded (and
> can be `null`) where it previously carried the raw bundler/viem text
> unbounded, a new `user_op_hash` field appears on `submission_outcome_unknown`,
> and `GET /payments/:id`'s `error_message` is now truncated past 300
> characters — every other field and branch is additive. A backend older
> than this change keeps the old untyped 502 and the un-bounded
> `error_message`. A hosted server older than this shows the four new codes
> (`submission_outcome_unknown`, `signature_rejected`,
> `account_validation_failed`, `onchain_execution_failed`) as the generic 5xx
> branch — "re-call the same tool once with the same arguments" (NOT "create
> a new payment"); the two budget codes already map through the #3500/#3504
> branches on any hosted server that has them. The retry gets a 409
> "Payment intent is failed, expected pending_signature", which an old hosted
> server shows as the generic 4xx stop: it reads as a plain failure, which is
> exactly the misreading `submission_outcome_unknown` exists to prevent — stale advice on
> an already-failed intent but not a new failure mode (the pre-#3494
> behaviour for every sign failure); the real risk of an old hosted server is
> an agent giving up on the stale retry advice and deciding, on its own, to
> pay again without ever being told to wait. Pinned by five new refusal
> fixtures (the exact counts live in `next-step-fixtures.ts`'s own
> `REFUSAL_SITE_COUNT` / `REFUSAL_STEP_CALLS`, not restated here to drift).
> Mutation-proven, independently: the `submission_outcome_unknown` priority
> over every other branch; the `reverted: true` vs `reverted: false` split
> (round 2, N3); the AA24-vs-every-other-AA2x split; the task-budget cap's
> `=== 'exceeded'` predicate (also a compile error under a `!== 'fits'`
> mutation, since `'unreadable'` carries no `remainingAtomic`/`maxAtomic` to
> read); the classification try/catch (S2) — a DB/chain failure while
> re-confirming a revert answers the generic code, never a 500; and the
> hosted `stop_and_tell_user` mapping for `submission_outcome_unknown`
> (round 2). The status `failure_reason`/`idempotency_key` surfacing is
> proven AND mutation-tested on the real-DB harness
> (`sign-failure-status.test.ts`); the sign-route 502 shape per cause class
> above, AND the `GET /payments/:id` `error_message` bound (round 2, R2-1:
> an earlier revision of this note wrongly grouped the GET bound with the
> real-DB claim above), are proven and mutation-tested on the ROUTE-level
> mocked-DB stub (`payments-sign-failure.test.ts` — `db-mock-exempt`, see
> that file's own header for why), not the real-DB harness: its claims are
> about the HANDLER's response shape, not about what Postgres does.
> `npm run preflight` green. `last-verified` is not re-stamped: this block is
> the scope. Nothing else in this document was re-verified.

> **Re-verified unchanged (#3508, 2026-10-01):** the change touches
> `.github/workflows/ci.yml`, a covered file, but only inside the required
> package-check aggregator and the surface-job wiring: one new `ui_checks` job
> (typecheck + the moved primitive suites from `packages/ui`), its entry in the
> umbrella `needs:` list, and one summary clause pairing
> `needs.changes.outputs.ui` with `needs.ui_checks.result`. Frontend-adjacent
> CI plumbing for the shared design-system package: no tool is added, renamed
> or re-shaped, no description text changes, no schema or argument changes, and
> the runtime-skew and consent-hash contracts are untouched. `last-verified` is
> not re-stamped: this note is the scope.

> **Re-verification (#3518, 2026-10-01):** the budget-visibility round. The
> hosted MCP and the local `@haven_ai/mcp` both gain
> `haven_get_task_budget { task_budget_id }` — the read over the backend's
> any-status `GET /task-budgets/:id`, i.e. the status check a close
> refusal's "re-check the budget's status" points at. It returns
> `{ task_budget }` verbatim (the SDK's typed `HavenTaskBudget`, `status`
> pending | open | closing | closed, `isExpired`, the #3501 spent/remaining
> figures on an open row) and a 404 carries the backend's own message
> through `runTool`; the local schema and wording are byte-parity with the
> hosted one. The third skew read changes shape:
> `getAgentSummary()`'s taskBudgets list now reads
> `GET /task-budgets?status=live` — `closing` rows always, unexpired
> `pending` and `open` rows; `closed` and expired rows are omitted by the
> backend, so neither the list nor its per-row on-chain reads grow with
> history — so the agent summary lists a `closing` budget AS closing (the
> read that must not vanish while a close submit is in flight) instead of
> dropping it the moment its close started. Against an older backend that
> refuses `status=live`, the SDK falls back to `status=all` and applies the
> same filter client-side. `haven_get_allowances` rows carry
> `delegationHash` / `recipientAddress` (null = open budget) /
> `merchantId` (set only on a #3331 merchant-locked budget) /
> `reservedHavenAtomic` (the sum of the budget's open, unexpired task- and
> sub-budget children's caps, in atomic units, reported BESIDE
> `onchain.remaining` and never folded into it — the on-chain figure stays
> authoritative; "0" covers both no-reservation and a failed sum), additive
> and undefined against an older backend. The tools' descriptions name the
> fields; the description payload measures 26,029 bytes across 27 tools
> (mean 964.04), the pins `description-size.test.ts` holds. Version skew,
> fail-closed or consent surfaces are unchanged: the local runtime's
> consent hash moves (a new tool name joins it), the signer's does not; an
> older hosted MCP lists no read tool and an older local server refuses
> the undeclared name — the rows above. An older backend's allowance rows
> omit the four fields and the SDK keeps them absent. `last-verified`
> stays 2026-10-01: the skew read, the tool set and the hosted/local
> descriptions are exactly what this document pins, and all three moved in
> this diff. Scope of this note: those tools and reads. Nothing else in
> this document was re-verified.

> **Re-verification (#3597, 2026-10-02):** `packages/sdk/src/agent-guidance.ts`
> is covered by this doc and was touched — the bundled agent runbook's "If
> something breaks" section gained one paragraph naming
> `haven feedback submit "<text>"`. Text-only: no tool, no schema, no
> version-skew surface and no consent-hash input changed. `last-verified`
> stays 2026-10-02 (already bumped by an earlier same-day change). Scope of
> this note: that one file. Nothing else in this document was re-verified.

> **Re-verified unchanged (#3729, 2026-10-07):** `packages/cli/src/commands.ts`
> and `packages/cli/src/commands.test.ts` are covered by this doc and were
> touched — `agents revoke` now reads the agent's server-computed
> `live_delegation_count` first and refuses (exit 4, `HavenCliError`) while a
> budget is still live on-chain unless `--keep-budget` is passed, and
> `budget revoke` accepts a `replaced` row (the backend's prepare route
> already did). A client-side guard only: no tool is added, renamed or
> re-shaped, no hosted/local schema or description changes, no version-skew
> surface and no consent-hash input moves, and the backend is untouched. The
> manifest rows and the skew tables above stand. `last-verified` is not
> re-stamped: this note is the scope. Nothing else in this document was
> re-verified.
> **Re-verified unchanged (#3822, 2026-10-09, comment-only):**
> `packages/cli/src/commands.ts` and `packages/cli/src/commands.test.ts` are
> covered by this doc and were touched, but only in one comment each: the
> reason the balances call passes `chain_id` no longer claims an account is
> "provisioned on every supported chain" (signup provisions one). The code
> still sends `?chain_id=` exactly as before. No command, flag, output, route,
> tool, schema key or version floor changes. `last-verified` is not
> re-stamped: this note is the scope. Nothing else in this document was
> re-verified.
> **Re-verified #3723 (2026-10-07, the receipt endpoint's wrapped response +
> the signed bundle's MCP read):** `verifyPaymentReceipt`
> (`packages/sdk/src/receipt.ts`) now accepts the response
> `GET /payments/{id}/receipt` returns — `{ receipt, verification }` — as-is:
> when the top level carries no `authorization` and `.receipt` is a non-null
> object, the bundle inside is verified, one level only, no recursion. The
> wrapper's `verification` is NEVER read — it is Haven's own self-check
> computed on Haven's server, and trusting it would defeat an offline
> verifier; a throwing getter around a valid bundle still verifies, and a
> wrapper around a bundle signed by another key answers `signer_mismatch`. A
> `haven_list_receipts` row — bare or wrapped — still answers
> `not_a_signed_receipt`. Both MCP runtimes gain
> `haven_get_receipt { payment_id }` (strict input, in
> `STATE_DIRECT_RECOVERY_TOOLS` on the hosted runtime), backed by
> `HavenClient.getReceipt` and returning `{ receipt }` only — the
> server-side `verification` is deliberately not handed back, so an agent
> cannot skip `haven_verify_receipt` on Haven's own word. The spread form
> (`{ receipt, verification }` as top-level arguments) verifies on both
> runtimes: hosted declares `verification` as accepted-and-ignored in its
> strict schema (previously it refused the key), and stdio — which silently
> stripped it — now declares the same schema, so the two agree. **The local
> runtime's consent hash MOVES**: a new registered tool name joins the sorted
> set (`packages/mcp/src/consent.ts`), so every installed client is re-asked
> for consent once after the update — intended, with precedent in #3329 and
> #3518, and recorded in `packages/mcp/CHANGELOG.md` under `## Unreleased`;
> the signer's hash does not. The exported `HavenMcpToolName` union grows
> (lever: a source break for exhaustive `switch`/`Record` consumers). The
> description payload is re-derived as a new round in
> `packages/mcp-server/src/description-size.test.ts` (the shrink-only
> `MAX_TOTAL_BYTES` pin cannot absorb a 28th description without a re-measure,
> as #3518 did); `MAX_MEAN_BYTES` is re-pinned to the new round's two-decimal
> ceiling (960.83, stricter than round 17's 964.04). Hosted picks the SDK
> change up on deploy; stdio only through a release (`@haven_ai/mcp` pins the
> SDK exactly). No backend route, OpenAPI, wire field, migration or payment
> path changed; the `agent_tool_invocations` audit allowlist is NOT extended, so
> `haven_get_receipt` leaves no audit row (like `haven_verify_receipt`
> today). `last-verified` is not re-stamped: this block is the scope.
> Nothing else in this document was re-verified.

> **Re-verified #3735 (2026-10-07, an x402 payment URL handed back by another
> tool):** the generic haven-pay skill (`packages/sdk/src/skill-content.ts`,
> and its byte-identical frontend copy `agent-skill-bundle.ts`) gains one
> paragraph after the non-MCP paywall block, a trigger bullet, and a wider
> front-matter `description` ("…or another tool returns an x402 payment URL").
> The paragraph tells the agent to quote the exact request (`url`, `method`,
> `headers`, `body` as a JSON string, `Content-Type: application/json` on a
> JSON POST), to repeat that method, body and `Content-Type` on its own paid
> retry (the hosted `haven_pay_x402_quote` takes none of them), to copy
> `payment_required` verbatim, to prefer the x402 URL over a deposit address,
> to pay one route only, and to check delivery in the merchant's own tool. The
> SDK's shared no-compatible-option refusal (`noCompatiblePaymentOptionError`)
> now names the offered schemes and the
> likely cause when every `accepts` entry is a non-`exact` scheme, echoing a
> merchant's scheme string only when it is a short identifier. Hosted
> `haven_quote_x402` relays that message through `HavenClient.quoteX402`, so
> hosted picks it up on deploy; the local runtime (the refusal) and connect
> (the skill) pick up their changes only through a release (they pin the SDK
> exactly). No tool schema,
> consent hash, wire field, route, signer or payment path changed, and nothing
> under `packages/mcp-server/src/**` was edited. `last-verified` is not
> re-stamped: this block is the scope. Nothing else in this document was
> re-verified.

> **Re-verified #3731 (2026-10-07, funds coverage + the underfunded prepare's
> real cause):** `/machine-payments/allowances` rows now carry
> `funds_cover_remaining` (`true | false | null` — one `balanceOf` per
> DISTINCT token, per-row compare, absent when the remaining is 0, `null` when
> the read failed or the remaining was not live), mapped onto
> `HavenAllowance` and the `haven_get_agent` summary rows on BOTH runtimes
> (`fundsCoverRemaining`, any non-boolean wire value → `null`, never
> `undefined`). A `prepare_reverted` whose revert was the token's own
> insufficient-balance error carries `revert_cause: "insufficient_balance"`
> and a funding-first `message`; the HOSTED `PREPARE_REVERTED` mapping reads
> it and answers `next_action: fund_account_or_raise_allowance` with a
> funding-specific omitted reason (one new pinned site,
> `next-step-fixtures.ts` — `lint:next-steps` re-derived 57 → 58). **The
> skew:** the hosted runtime answers the funding step as soon as the backend
> deploys; stdio answers it only after its next release pins the SDK — until
> then a stdio `haven_pay`/`haven_send` on a short wallet still returns
> today's caveat text (the refusal itself is unchanged on both). No tool is
> added, renamed or re-shaped; no strict schema changes (the new body field
> rides the existing failure object); the consent hash does NOT move (no
> registered-name change; the description fragments grew — the
> `description-size` gate re-derived as round 19, 27,680 bytes / 28 tools).
> The refusal ledger is unchanged (`onchain_revert`; reason set fixed by the
> migration 086 CHECK). `last-verified` is not re-stamped: this block is the
> scope. Nothing else in this document was re-verified.

> **#3747 re-verification (2026-10-07, merchant-transport only).** The hosted
> merchant-egress policy (`packages/sdk/src/merchant-egress.ts`) changed
> `mcp-merchant-transport.ts` and `client.ts` — both on this contract's cover
> list. The change is additive and outbound-only: an optional
> `merchantEgress` config that gates where merchant requests CONNECT
> (https-only public hosts, re-checked GET redirects, while-reading byte
> caps, per-use timeouts). No tool is added, renamed or re-shaped; no
> strict schema changes; the version-skew and consent-hash contracts do not
> move, and no signing input (typed data, digest, auth.version) is touched —
> a refusal happens before signing or after an already-signed header was
> relayed, never by altering intent. The wire contract suite
> (`x402-expected-wire-contract.test.ts`) runs green through the fixture
> seam. Scope of this note: those two files' egress additions;
> `last-verified` is bumped to 2026-10-07 for exactly this coverage.

> **#3763 re-verification (2026-10-08, history read model only).** This diff
> touches the transactions history read model (`modules/transactions/`,
> `infra/repositories/transaction-history.ts`, `infra/repositories/agent-activity.ts`)
> and `openapi/spec.ts`. It is display-only: the EIP-3009 settlement hash the
> agent reported (#3475) is now surfaced beside the funding hash on the
> dashboard's history/activity views and the CSV export. No tool is added,
> renamed or re-shaped; no `haven_*` tool schema, description fragment or
> failure envelope moves; the version-skew and consent-hash contracts do not
> `last-verified` is bumped to 2026-10-08 for exactly this coverage.
> Nothing else in this document was re-verified.

> **#3767 re-verification (2026-10-08, the merchant-report grace's home).** This
> diff touches `modules/payments/agent-payment-status.ts`, a covered file: the
> #2145 grace window's resolved value (`MERCHANT_REPORT_GRACE_MIN`, its QA
> override and `merchantReportGraceElapsed`) moved to a domain leaf
> (`domain/merchant-report-grace.ts`) and is re-exported from the status module
> under the SAME names — the status module's answers, and every field they
> carry, are byte-identical. The move exists so the accounting feed (#3767)
> can wait out the SAME window on the SAME clock without importing the status
> module (a module cycle). No tool is added, renamed or re-shaped; no
> `haven_*` tool schema, description fragment or failure envelope moves; the
> version-skew and consent-hash contracts do not move. `last-verified` stays
> 2026-10-08 for exactly this coverage. Nothing else in this document was
> re-verified.

> **#3799 re-verification (2026-10-09, connect self-update in one command).**
> This diff touches covered connect files (`doctor.ts`, `cli.ts`, `args.ts`,
> `storage.ts`) and `packages/backend/src/middleware/client-compat.ts`:
> `--doctor`/`--repair` accept `--name <slug>` and select the agent directory
> by its RECORDED pair (one resolver shared with `--rekey --name` and
> `--unwire --name`); the multi-directory repair refusal names each agent id
> and its pair and offers the `--name` command; the Claude Code repair states
> the wrapper re-point instead of a false "Rewriting MCP entries" line; and a
> repair whose installed signer would refuse to start stops before writing
> anything unless `--ack-local-tools` is passed — the re-ack is then produced
> by the INSTALLED signer via the recorded wrapper's `--ack`, no setup token.
> The doctor's consent-missing check offers the same token-free path instead
> of `--ack-local-tools --setup <token>`. The consent-hash contract does not
> move: the hash still covers the signer's tool names, the signer still
> refuses on mismatch, and the ack file still holds only the hash (the repair
> never claims "the tools grew"). No `haven_*` tool schema, description
> fragment or failure envelope changes; the version-skew table is untouched;
> the backend's `upgrade_command` suffix is additive text on the connector
> doctor form and core's `/ --doctor$` parity command is unchanged.
> `last-verified` stays 2026-10-08: this note is the scope. Nothing else in
> this document was re-verified.

> **Re-verified #3888 (2026-10-10):** the local signer's minted X-PAYMENT
> header now carries an EIP-3009 nonce derived from the Haven payment id
> (`signer/src/core.ts`, via the shared `deriveX402PaymentNonce`). This is
> not a contract move: no `haven_*` tool, schema, strict-input list,
> expected-context version or consent hash changes, the header stays opaque
> to the merchant and facilitator, and the version-skew tables above stand.
> The invariants the wire-format tests pin (window clamps, EIP-712 domain,
> byte-sensitive asset echo) are unchanged; only the nonce's provenance
> moved from random to derived. Nothing else in this document was
> re-verified; `last-verified` already reads today.

> **Re-verified #3892 (2026-10-10):** the agent runbook's "Budget changes
> later" hash sentence now names `haven budget show <agentId> --hashes`
> (`HASH_DISCOVERY_HINT`, `packages/cli/src/commands.ts:778`) instead of
> `haven agents show <agentId>`, which prints no delegation hash. Copy-only:
> no `haven_*` tool, schema, strict-input list, expected-context version or
> consent hash changes; `packages/cli/src/commands.ts` itself is untouched
> (a test now imports its exported constant). The regenerated copies are
> pinned by `lint:runbook-parity` (11/11) and the new drift-guard test.
> Nothing else in this document was re-verified; `last-verified` already
> reads today.

> **Re-verified #3967 (2026-10-14, the quote-time budget gate):** the diff
> touches covered files (`packages/mcp-server/src/tools/**`,
> `packages/sdk/src/client.ts`, `packages/backend/src/modules/mpp/budget-precheck.ts`,
> `packages/backend/src/routes/machine-payments.ts`) additively. The three
> quote surfaces gain a quote-time budget pre-check (`budget_check` block +
> `QUOTE_EXCEEDS_REMAINING_BUDGET` / `MERCHANT_REPORTED_DENIAL` warning codes,
> an always-present `safe_to_continue` on the two MCP quote tools) and
> `haven_quote_x402` gains an optional `expected_amount`; the pre-check route
> gains an optional `recordRefusal` (default true — quotes send false so a
> quote writes no refusal row; the body guard rejects a non-boolean with the
> same 400 shape as the other field guards). No tool is added or renamed; the
> new inputs are optional and the new response fields additive, so an older
> local MCP and an older hosted server are unaffected. Version skew both
> ways: an OLD backend ignores `recordRefusal` (unknown body key) and
> records the refusal — a quote against an old backend may land one
> `hosted_prepare` row, which the quote surfaces tolerate (the agent already
> stopped); an old hosted server never sends the new fields. No
> expected-context version, consent hash or version floor moves. The new
> tests: the quote-surface fixtures in
> `packages/mcp-server/src/tools/{plain-http-x402,catalog-purchase}.test.ts`
> and the real-Postgres `record_refusal` route tests in
> `routes/__tests__/budget-precheck.test.ts`. Nothing else in this document
> was re-verified; `last-verified` already reads today.

> **Re-verified #3988 (2026-10-15 — an additive field on the Agent payload).**
> The diff touches one covered path, `routes/agents.ts`: the list, detail,
> PATCH and create responses gain an OPTIONAL `receivedSubBudgets` array
> (the server's qualifying-chain verdict on grants the agent RECEIVES).
> Additive only — no request schema, no removed field, no enum or format
> moves — and every published client (SDK, CLI, hosted MCP tool surfaces)
> ignores unknown response fields, so no expected-context version,
> consent-hash input or version floor moves. `last-verified` is bumped to
> 2026-10-15 for exactly this coverage.

> **Re-verified #3996 (2026-10-15 — the local MCP server wires per-chain RPC
> endpoints).** The diff touches two covered files, `packages/mcp/src/server.ts`
> and `packages/mcp/src/credentials.ts`: `resolveHavenClient` now reads
> `HAVEN_RPC_URL_<chainId>` scalars and passes a `chainRpcs` map into
> `HavenClient` when any are set. Config-only and additive — no tool is added,
> renamed or removed, no request or response schema moves, no version floor,
> expected-context version or consent-hash input changes (the env scalars are
> read outside the consent inputs). With the variables unset the client is
> constructed exactly as before, so an old credential file and an old flow are
> unaffected both ways; the hosted server already wires `chainRpcs` its own
> way and is untouched. `last-verified` already reads 2026-10-15.

> **Re-verified unchanged (2026-10-19 — the CLI's budget grant/revoke output
> says "approve", not "sign").** The diff touches two covered files,
> `packages/cli/src/commands.ts` and `packages/cli/src/commands.test.ts`: the
> human-readable lines `haven budget grant` and
> `haven budget revoke` print now read "Open this link and approve …",
> "Waiting for your approval …", "Approved and active.", "Revocation prepared —
> one approval, sponsored (no gas)." and "The budget keeps working until you
> approve …"; and their `--wait` timeout and refusal messages say "approve"
> (owner copy rule,
> `docs/product/copy-guidelines.md`). Wording only: the printed link, the
> `--json` object, exit codes, `--wait` polling, the routes called and every
> request and response shape are unchanged, and the CLI still never signs. No
> tool, schema key, `next_tool` value, expected-context version or signer
> contract changes. Scope of this note: those printed lines. Nothing else in
> this document was re-verified.

> **Re-verified unchanged (#4168, 2026-10-20 — the agent runbook says "a
> passkey", never a platform name).** The diff touches one covered file,
> `packages/sdk/src/agent-guidance.ts`: step 1 of the sequence and the
> "Before signup" hand-off script in `HAVEN_AGENT_RUNBOOK_MD` drop
> the platform names after "a passkey" (owner copy rule,
> `docs/product/copy-guidelines.md`). Wording only: no `haven_*` tool,
> schema, strict-input list, `next_tool` value, expected-context version or
> signer contract changes. The CLI copy and the nine agent-skills step files
> are regenerated by `sync-agent-guidance.mjs` and pinned by
> `lint:runbook-parity` (11 of 11 at `10762fb`); `/for-agents.md` was edited
> to match. Scope of this note: those two sentences. Nothing else in this
> document was re-verified.

> **Re-verified unchanged (#4345, 2026-10-23 — the skill says which quote
> checks the budget).** The diff touches the haven-pay skill text that connect
> installs (`HAVEN_SKILL_MD`, `packages/sdk/src/skill-content.ts`, with its
> byte-identical frontend copy): two sentences now say the hosted quote checks
> the remaining budget, and the local `@haven_ai/mcp` `haven_quote_x402` checks
> only a stated `expected_amount`, the budget being checked at pay time. Wording
> only: no `haven_*` tool, schema, strict-input list, `next_tool` value,
> expected-context version or signer contract changes; an installed `SKILL.md`
> stays stale until reinstalled. Scope of this note: those two sentences. Nothing
> else in this document was re-verified.

> **Re-verified (#4355, 2026-10-23 — `haven_get_agent` tells a spent budget
> from no budget).** Additive only. Each `/machine-payments/allowances` row
> gains `next_refill_at` (ISO, or null when the budget ends before it would
> refill), mapped by the SDK to `nextRefillAt`; `getAgentSummary()` — which
> both the hosted and the local `haven_get_agent` return as-is — gains
> `budgetRefillsAt`, set only when readiness is `needs_approval` because every
> live budget is spent for its period. `HavenAgentReadiness` keeps its three
> values (#4349 decision 5, additive), so a client that switches over them is
> unaffected and an older backend simply yields `null` for both fields. The
> runbook (`haven guide`, the agent-skills step file, `/for-agents.md`), the
> skill text and the `haven_get_agent` description now give `needs_approval`
> its two causes. No `haven_*` tool name, input schema, strict-input list,
> `next_tool` value, expected-context version or signer contract changes —
> but the `haven_get_agent` DESCRIPTION does, so `tools-list.snapshot.json`
> and the hosted contract fingerprint move: an already-connected hosted
> client gets the stale-list reconnect hint after deploy, as for any
> description change. Scope of this note: those fields and that wording. Nothing else in this
> document was re-verified.

> **Re-verified unchanged (#4371, 2026-10-23 — four stale comments and README
> lines).** The diff touches covered files only in prose: `packages/signer/README.md`
> (the bridge flow's `haven_sign` step now names `{ payment_id }` as preferred, and
> `payload_hash` + `x402_expected` with `typed_data_b64` as the decomposed form),
> two comments in `packages/mcp-server/src/tools/catalog-purchase.test.ts`
> (the budget read is `budget-precheck`, as the tests stub), and the comment in
> `.github/workflows/publish.yml` (five enforcement places, as listed). No
> `haven_*` tool, input schema, strict-input list, `next_tool` value,
> expected-context version, signer contract or publish step changes. Scope of
> this note: those lines. Nothing else in this document was re-verified.

> **Re-verified unchanged (#4379, 2026-10-23 — import paths only).** The diff
> touches covered files only in their import lines:
> `modules/x402/sign-context.ts`, `modules/x402/delegation-authorize.ts` and
> `modules/mpp/budget-precheck.ts` now import from `../payments/index.js`
> instead of private payments files, and `modules/payments/agent-payment-status.ts`
> reads `MAX_SETTLEMENT_WINDOW_SECONDS` and `CLOCK_SKEW_SECONDS` from the new
> zero-import `domain/x402-settlement-timing.ts` (same values, 600 and 120)
> instead of `modules/x402/`; that file joins this document's `covers:`. No
> `haven_*` tool, input schema, refusal,
> `next_tool` value, status projection or expected-context version changes.
> Scope of this note: those import lines. Nothing else in this document was
> re-verified.

> **Re-verified unchanged (#4387, 2026-10-24 — one sentence in
> `packages/connect/README.md`).** The README now says agents connected
> before the MCP server name was recorded show **not recorded** in the *MCP
> server name* row of their Settings tab, instead of quoting a "MCP name not
> recorded" label the dashboard does not render. No connector behaviour,
> flag or published version changed. Scope of this note: that sentence.
> Nothing else in this document was re-read for it, and `last-verified` is
> not bumped.

> **Re-verified unchanged (#4372 part G, 2026-10-24 — prose in
> `packages/connect/README.md`).** The README is the only covered file this PR
> touches, and it changes prose only: the default credential directory is
> `~/.haven/agents/<slug>/` (#3737), the intro names each field of the
> register body (`registerSetup` in `packages/connect/src/api.ts`) and the
> `X-Haven-Client` header, the doctor table lists `parked`, the runtime-unknown detail is quoted as
> `doctor.ts` writes it, the multi-agent `--repair` refusal accepts `--name`
> (#3799), and the setup screen is no longer said to offer a revoke (#3830).
> No connector code, flag, pin, tool, consent surface or published version
> changed. Scope of this note: those README sentences. Nothing else in this
> document was re-read for it, and `last-verified` is not bumped. Two passages
> here still say `<agent-id>` where #3737 made `<slug>` the default
> (`:2645`, `:5508`); follow-up #4396 covers them.

> **Re-verified unchanged (#4372 part I, 2026-10-25 — prose in
> `packages/signer/README.md`).** The README is the only covered file this PR
> touches, and it changes prose only: the redemption allowlist names the
> third chain shape, `[sub grant, parent child, budget]` (#3330, as
> `redemption-guard.ts` in `@haven_ai/sdk` already enforces); the library
> surface is five methods on `createEdgeSigner`'s object; the direct-payment
> diagram shows the compact `haven_pay` result (#3495); the trust-model note
> says the local checks prove shape and integrity, not amount or recipient;
> and the Connect Agent 2 paragraph lists the register body as `registerSetup`
> sends it. No signer code, tool, version constant, consent surface or
> published version changed. Scope of this note: those README sentences.
> Nothing else in this document was re-read for it, and `last-verified` is
> not bumped.

> **Re-verified (#4469, 2026-10-27 — `haven_list_receipts` rows gain six
> additive fields).** Both surfaces return the SDK's `listReceiptsPage`, and
> `mapPaymentReceipt` now reads six keys the receipts wire already carried:
> `settlementScheme`, `budgetDelegationHash`, `deliveryQuality`,
> `deliveryNote`, `deliveryReportedAt` and `deliveryReference`. Each is set
> only when the raw key is present, so a row from an older backend maps
> without it — absent stays absent, and the wire itself is unchanged. Version
> skew is silent in both directions: a hosted server or a local
> `@haven_ai/mcp` older than this change returns rows without the six (the
> mapper drops them), and no input schema, tool name or consent surface
> changes, so nothing is refused and no new acknowledgement is asked for. The
> `haven_report_delivery_quality` description also changed — it drops "and the
> dashboard" and no longer claims the owner reads the verdict, because no owner
> surface reads it. That is served prose, not a compatibility surface; the
> tool's input schema is byte-identical. No version constant, pin or published
> version changed. Scope of this note: the receipt row shape and that one
> description. Nothing else in this document was re-read for it, and
> `last-verified` is not bumped.

> **Re-verified (#4470, 2026-10-27 — retry or stop by cause, not status).**
> Additive on the wire.
> - **The SDK.** `HavenApiError` gains an optional `failureCause`: the
>   transport's own 408 and status-0 errors carry `{ kind: 'no_answer',
>   method }`, and nine deterministic SDK throws plus two payment-state throws
>   carry `{ kind: 'deterministic' }`. Its `name`, `code` (`API_ERROR`) and
>   `statusCode` are unchanged, so the local MCP (`packages/mcp/src/tools.ts`)
>   relays it as before. The funding wait throws two new `HavenApiError`
>   subclasses, `FundingConfirmationUnknownError` and `FundingRevertedError`.
>   The local MCP reaches that wait through `haven.fetch` and `payX402Quote`
>   and relays the two with their new status (504 / 502, was 500) and message;
>   its step is unchanged.
>   A settlement report that got no answer is `retryable`, not `refused`.
> - **The hosted MCP.** `normalizeError`'s generic `HavenApiError` branch
>   reads the cause first:
>   - a non-answer on a read re-calls once;
>   - a non-answer on a write stops without re-calling;
>   - a deterministic failure stops;
>   - only an unmarked status falls through to the 4xx and 5xx steps, and
>     their reasons are byte-identical.
>
>   `haven_submit`, on both schemes, and `haven_settle_mcp_tool`'s erc7710
>   settle answer a non-answer with the new code `NO_ANSWER_OUTCOME_UNKNOWN`
>   and the status read for its `payment_id`.
>   The eip3009 delivery step answers the funding wait with the new codes
>   `FUNDING_CONFIRMATION_UNKNOWN` (check status) and `FUNDING_REVERTED`
>   (stop), before any merchant call. The settlement-report pending texts now
>   name "Haven did not answer" as a cause.
> - **What does not change.** No `haven_*` tool name, input schema,
>   strict-input list, tool description, expected-context version or signer
>   contract changes, and `tools-list.snapshot.json` does not move. Every
>   step names a tool through `refusalNextStep` or says why none follows, and
>   `lint:next-steps` stays at zero.
>
> Scope of this note: those fields and texts. Nothing else in this document
> was re-verified.

> **Re-verified unchanged (#4550, 2026-10-30 — `@x402/*` devDependency bump and
> low-s pinning tests).** The diff touches this document's covered
> `packages/signer/**` and `packages/sdk/package.json` only in ways that reach
> no runtime surface. `@x402/*` moves 2.17.0 → 2.29.0 as a **devDependency** in
> every published package, so no installed `@haven_ai/mcp`, `@haven_ai/connect`
> or `@haven_ai/sdk` user resolves it; the runtime dependency `x402@^1.2.0` in
> `packages/sdk` and `packages/signer` is unchanged. The signer's new tests
> assert the EIP-3009 bridge header's wire signature is canonical low-s on all
> three signing branches — they pin bytes the bridge already emits and change
> no signing path. `packages/signer/src/siwx.test.ts` adapts to two
> `@x402/extensions` 2.29 API changes in the REFERENCE implementation the test
> compares against (`verifySIWxSignature` result fields renamed `valid` →
> `isValid` / `address` → `payer`; `createSIWxPayload` now takes the response
> URL and asserts the challenge is bound to its origin) — test-only, and the
> signer's own SIWX header construction is untouched. No tool is added or
> removed, no argument, version floor, consent-hash input or
> `tools-list.snapshot.json` row changes, and `lint:next-steps` stays at zero.
>
> Scope of this note: the dependency pins and those test files. Nothing else in
> this document was re-verified.
> **#4552 (2026-10-30, the merchant's rejection reason on a rejected retry):**
> `haven_report_x402_outcome` gains one OPTIONAL response field,
> `merchant_reported_error`, on a REJECTED outcome only: the merchant's own
> reason for refusing, as a code, or `null` when the reported body carried
> none. It is the SDK's parse result, not a read-back — the MCP server never
> parses the body itself — and it is merchant-claimed data, never something
> Haven verified. The response's `reason` says so.
> - **Where the reason comes from.** x402 merchants have started saying WHY
>   they refused: a verify-stage refusal returns `{"error": "<reason>"}` in the
>   402 body (x402-foundation/x402#3795, and #3882 for Go), where the reason is
>   the facilitator's `invalidReason` — a snake_case code such as
>   `invalid_exact_evm_non_canonical_signature`. A stock settlement failure
>   returns an EMPTY body and carries the reason only in the `PAYMENT-RESPONSE`
>   header (`errorReason`); merchants from before #3795 carry it only in
>   `PAYMENT-REQUIRED` (`error`). The same `error` field sometimes holds a
>   sentence, so only a value matching `^[a-z0-9_]{1,64}$` is accepted.
> - **Both writers record it.** `details.merchant_reported_error` is written by
>   `recordRetryRejected` (the SDK's local paid retry and the hosted
>   `haven_complete_mcp_tool` path, which also falls back to the merchant
>   headers it holds) and by `reportMerchantOutcome` (the agent-reported
>   plain-HTTP path, body-only). It is set after the `...input.details` spread,
>   so a caller cannot override it, and it is always present — the code or
>   `null`. `retry_body` is unchanged. `details` is open JSONB, so an older SDK
>   that does not write the key is read as optional: no backend change and no
>   migration.
> - **The parser is total.** It runs inside `recordRetryRejected`'s swallowing
>   `try`, where a throw would silently drop the stranded-funds event, so every
>   failure path returns `null` rather than raising.
> - **The handoff does not branch on the reason.** `next_tool` stays
>   `haven_sweep_delegate` for every rejection, and every `next_arguments` value
>   is unchanged.
> - **Instructions ask for the body.** The report instructions in
>   `REPORT_X402_OUTCOME_DESCRIPTION`, `state-direct-recovery.ts`, `server.ts`,
>   `skill-content.ts` (and its byte-pinned frontend mirror) and the SDK README
>   now ask the agent to pass the merchant's body on a rejection — the only
>   route by which the reason reaches Haven on the plain-HTTP path.
> - **Hosted picks this up on deploy**; local MCP/connect users need an
>   `@haven_ai/mcp` / `@haven_ai/connect` release (both pin the SDK exactly),
>   as with #3764, #3778 and #4534.
> - `tools-list.snapshot.json` moves: one description changed, no tool added or
>   removed, no input schema change, no version floor or consent-hash input
>   change. The description payload stays under its shrink-only cap (31,803 /
>   31,812 UTF-8 bytes), and `lint:next-steps` stays at zero.
>
> Scope of this note: that response field, the two writers' `details` key, the
> parser and the instruction copies. Nothing else in this document was
> re-verified.

> **Re-verified unchanged (#4573, 2026-10-31 — the connect flow's expiry
> stamp).** `packages/frontend/src/components/connect-agent/setup-copy.ts`'s
> `formatAbsoluteDate` now formats through `lib/format.ts`'s
> `formatShortDateTime` (en-GB) instead of the device locale's
> `toLocaleString(undefined, …)`. The value it renders, the sentence it sits
> in ("Expires …"), the NaN guard that returns the raw string, and every
> runtime-compatibility statement in this document are unchanged — the
> connector command, the runtime registry, the restart modes and the version
> floors do not read this helper. Scope of this note: that one helper. Nothing
> else in this document was re-verified.
```

## `docs/operations/ops-console.md`

<!-- sha256: 9bb7d19e3087c282a323ca461b115cca55820e849e296819be1f0c663904ec33 -->
```markdown
> **Re-verified #4192 (2026-10-21, ignore-step tests: event-loop yield and
> real git):** this diff touched `scripts/vercel/ignore-build-harness.mjs`
> and `packages/ops/src/__tests__/vercel-ignore-build.test.ts`. Two
> test-only changes. First, the harness gains `yieldToEventLoop`, which the
> ops test registers as an `afterEach`. The harness spawns git synchronously,
> so a file that runs past 60 s without a turn of the event loop outlasts the
> 60 s timer of the vitest worker's `onTaskUpdate` RPC. vitest then reports an
> unhandled error and `npm run test -w packages/ops` exits 1 with every test
> passing. Second, on macOS the harness resolves the real git once (`xcrun -f
> git`) and puts its directory first on PATH, skipping the slow `/usr/bin/git`
> shim. That cut the ops file from 135-153 s to about 25 s run alone at idle
> load. No assertion, watched path or script behaviour changed, so the Ignored Build
> Step paragraph in § 1 stands as written. Nothing else in this document was
> re-verified, and `last-verified` is not bumped.

> **Re-verified #3913 (2026-10-19, after the toggle):** only the "Skipped - Not
> affected" records paragraph and step 4 of § 1 changed; step 4 now names
> the setting's required value. The paragraph now records that the setting was seen
> **Enabled** on haven-ops in the dashboard and turned off on 2026-10-15, and
> gives the measured result (GitHub deployment records, 2026-10-15 to
> 2026-10-18). Nothing else in this document was re-verified, and
> `last-verified` is not bumped.

> **Re-verified #3913 (2026-10-13, Vercel skip-setting doc corrections):** the
> *Deploys from `dev` only* paragraph was reflowed and a new "Skipped - Not
> affected" records paragraph added, naming the per-project Vercel setting
> "Skip deployments when there are no changes to the root directory or its
> dependencies" and its required value **off** on haven-ops. The setting's
> on/off state per project and the record counts (103 preview, 8 of 40
> production) come from #3913's GitHub deployment-records census — an
> inference; nobody has checked the dashboard yet (superseded by the 2026-10-19
> note above: the dashboard was checked). Nothing else in this
> document was re-verified, and `last-verified` is not bumped.

> **Re-verified #3821 (2026-10-09):** only the *Deploys from `dev` only*
> paragraph (the "Skipped - Not affected" residual) and the Ignored Build Step
> paragraph changed — the frontend project takes the first-preview path for opt-in
> `preview/*` branches only. Nothing else in this document was re-verified,
> and `last-verified` is not bumped.
```

## `docs/operations/package-dev-channel.md`

<!-- sha256: 59b6cf212417887c2c7fd092063b984531f59c38b677d3a7ef17fdd0ac3508d9 -->
```markdown
> **Re-verified #4612 (2026-11-02, this doc stops being implicated by a version
> bump):** coupled through `scripts/release-bump.mjs` and
> `scripts/release-version-constants.mjs`. The bump's printed next-steps block
> now says this document needs **no edit** for a release whose only change to
> `packages/connect/src/runtime.ts` and `packages/mcp/src/server.ts` is the
> version literal, because the docs coupling gate partitions a version-literal-only
> diff out (#4612). `release-version-constants.mjs` gains
> `DEDICATED_VERSION_CONSTANT_FILES` (`MCP_VERSION`) and
> `ALL_VERSION_CONSTANT_FILES`; `SOURCE_VERSION_CONSTANT_FILES` is unchanged.
> Re-read against the diff and unchanged: the snapshot version format
> (`0.0.0-dev.<ts>.<sha>`, `scripts/release-snapshot-version.mjs`), the channel
> resolution and its guards (`scripts/release-channel.mjs`,
> `packages/sdk/src/connector-channel.ts`,
> `packages/mcp-server/src/connector-channel.ts`), `HAVEN_CONNECTOR_CHANNEL` and
> `parseConnectorChannel` in `packages/backend/src/config.ts`, the credential-file
> shape and consent inputs, and the `dev` dist-tag publish in
> `.github/workflows/publish.yml`. None of those files is in this diff.
> `last-verified` is not bumped: this is a scoped check of two script edits, not
> a re-verification of the document.

> **Re-verified (0.13.0-alpha.0 release, 2026-10-30):** coupled through
> `CONNECTOR_VERSION` in `packages/connect/src/runtime.ts`, which this bump
> rewrote from `0.12.0-alpha.0` to `0.13.0-alpha.0`. That literal is the ONLY
> edit the bump makes to any file this document covers — verified by reading
> the diff, not by trusting the bump's own report: `runtime.ts` changes one
> line, and `runtime-manifest.ts` re-pins `sdkVersion` and `signerVersion` to
> the same string.
>
> Re-read against the release, and unchanged: the snapshot version format
> (`0.0.0-dev.<ts>.<sha>`, `scripts/release-snapshot-version.mjs`), the
> channel resolution and its guards (`scripts/release-channel.mjs`,
> `packages/sdk/src/connector-channel.ts`,
> `packages/mcp-server/src/connector-channel.ts`), `HAVEN_CONNECTOR_CHANNEL`
> and `parseConnectorChannel` in `packages/backend/src/config.ts`, the
> credential-file shape and consent inputs, and the `dev` dist-tag publish in
> `.github/workflows/publish.yml`. None of those files is in this bump's diff.
>
> The release itself carries no connector change: the shipped delta at the door
> (`origin/dev` `745d4ebf`) is 16 files, +162/−20, and `@haven_ai/connect`'s
> three of them are the bump's own version literals (`package.json`,
> `runtime.ts`, `runtime-manifest.ts`), so it publishes a version literal over
> otherwise byte-identical contents. `last-verified` is re-stamped to
> 2026-10-30 for this note.

> **Re-verified #4415 (2026-10-25, stale comment sweep):** the only covered
> file this diff touches is `packages/backend/src/config.ts` — one COMMENT
> renames the screen it cites (the Company details card has lived on the
> Settings → Business tab since #4359). No flag, env scalar, parser call or
> default changes: `ownerCompanyDetailsEnabled` and every other entry keep
> their values. Every other file in the diff is outside this document's
> coverage. Nothing else in this document was re-verified, and
> `last-verified` is not bumped.

> **Re-verified unchanged (#4319, 2026-10-23, one added backend feature flag
> in `packages/backend/src/config.ts`).** The only covered file this PR
> touches is `config.ts`: it adds `eip3009ReceiptAttribution`, a
> `parseBooleanFlag` entry for the new `HAVEN_EIP3009_RECEIPT_ATTRIBUTION`
> env scalar (default off, unrecognised values refuse the boot — #3015's
> fail-closed family). It does not touch `HAVEN_CONNECTOR_CHANNEL`, the
> credential-file shape, the consent inputs, `chainRpcsFromEnv`, any version
> constant, or any field this document names; nothing about channel
> selection, dist-tag resolution, the snapshot path or publish behaviour
> moves. Scope of this note: confirming that. Nothing else in this document
> was re-verified, and `last-verified` already reads 2026-10-23 and is left
> as is.

> **Re-verification (#3819, 2026-10-09):** coupled through
> `.github/workflows/publish.yml`: the dependency-presence gate's ledger
> (`dep_state`) is now a space-delimited `pkg=state` string with an
> exact-word `case` lookup instead of a bash-4 associative array, making the
> loop bash 3.2 compatible (#3819). The gate runs on BOTH channels and its
> behaviour is unchanged on every bash; the dev-channel checklist, snapshot
> version shape and dist-tag rules in this document are untouched. Verified
> by `release-bump.test.mjs` (102/102), which runs the real loop shell on
> host bash 5 and in a real GNU bash 3.2.57 container — on the dev channel
> too.

> **Re-verification (#3797, 2026-10-09):** coupled through
> `.github/workflows/publish.yml`, which gains a dependency-presence gate that
> runs on BOTH channels: a package whose exact-pinned internal `@haven_ai/*`
> dependency did not publish in the same run is held back and marked FAILED,
> never nominated for `latest`. The dev-channel checklist above was updated in
> the same pass; the snapshot version shape, dist-tag rules, channel guard and
> every credential path are untouched. Verified by `release-bump.test.mjs`
> (102/102), which runs the real loop shell on the dev channel too.

> **Re-verification (#3496, tombstone-before-identity doctor selection,
> 2026-09-30):** this doc is coupled through `packages/connect/src/doctor.ts`.
> The change is `discoverCredentialDirectory`'s candidate selection: the
> `TOMBSTONE.json` tell is now checked BEFORE the `identity.json` stat, so a
> retired directory that kept `identity.json` is never selected as the primary
> candidate — before, it could be picked whenever its identity file was the
> newest on disk — while staying reportable as retired (#1681 semantics
> unchanged); the missing-identity catch narrows to the rekey-pending tell. No
> channel, dist-tag, snapshot, build-order or runtime-spec-override behaviour
> moves, and the credential-path rules this loop relies on are unchanged
> (#3412's `--credentials-dir` requirement, the `identity.json` /
> `TOMBSTONE.json` layout) — the only movement is which directories may be
> selected as primary. `last-verified` deliberately NOT bumped, per the
> precedent notes in `docs/contributing/branch-and-release-flow.md`: nothing
> this document claims was made false or stale, and #1366 rates a
> rubber-stamped date worse than a stale one. Scope of this note: that
> selection change — nothing else in this document was re-verified.

> **Re-verification (#3332, 2026-09-28):** coupled through
> `packages/backend/src/config.ts`, which is in this doc's `covers:` — the
> edit is a comment-only re-wording of `ownerCompanyDetailsEnabled`'s own
> comment (the "no settings UI yet" line, now stale for an unrelated reason:
> #3332's frontend slice shipped that UI). No channel, dist-tag, snapshot,
> build order, credential path, or runtime-spec-override behaviour moves, and
> this document names no fact about that flag's own gating, so nothing in it
> was made stale. `last-verified` deliberately NOT bumped, for the reason in
> the `docs/contributing/branch-and-release-flow.md` precedent note: this is
> a scoped check of one comment-only edit, not a re-verification of the
> document.

> **Re-verified unchanged (#4012, 2026-10-16, `ETH_GETLOGS_MAX_BLOCK_RANGE` added):**
> - **What changed.** `config.ts` gains `getLogsMaxBlockRange`, read only by the x402 settlement sweepers' `eth_getLogs` span (`infra/chain/log-range-limit.ts`). No connector, dist-tag or channel variable is touched.
> - **What did not.** No dist-tag, channel or `HAVEN_CONNECTOR_CHANNEL` behaviour moves.
>
> The rest of this document was not re-read for it, and `last-verified` is not bumped.

> **Re-verified unchanged (#3732, 2026-10-07, the runtime picker's no-default rule):**
> - **What changed.** `connect/src/runtime.ts`: the default prompt rung now passes the hint scan's `env` to the installed-client prompt (new `promptRuntimeByInstalledClient` dep), and the prompt itself never pre-selects — an empty answer re-asks and aborts with `runtime_prompt_aborted` after three attempts, writing nothing. `connect/src/installed-clients.ts` (not covered here) gains a `~/.claude.json`-`mcpServers` evidence path and the "(suggested)" marker, which changes which candidate the picker SUGGESTS, not any connector command the route builds.
> - **What did not.** No dist-tag, channel or `HAVEN_CONNECTOR_CHANNEL` behaviour moves; the loop's `--runtime` / `--json` guidance still holds.
>
> The rest of this document was not re-read for it, and `last-verified` is not bumped.

> **Re-verified unchanged (#3689, 2026-10-06, the wiring_collision re-run clause):**
> - **What changed.** Comments only in `routes/agent-connection-setups.ts` and `connect/src/runtime.ts`: both now say the setup prompt permits a third command change — after the user answers a `wiring_collision` relay, one re-run with the `--name` or `--replace` flag the user chose. The connector command the route builds, and the refusal the connector emits, are unchanged.
> - **What did not.** No dist-tag, channel or `HAVEN_CONNECTOR_CHANNEL` behaviour moves, and the `--replace` / `--name` guidance in The loop still holds.
>
> The rest of this document was not re-read for it, and `last-verified` is not bumped.

> **Re-verified unchanged (#3669, 2026-10-06, backend supported vs known chains):**
> - **What changed.** `routes/agent-connection-setups.ts` loses its chain-100 network-name branch. A setup can only be approved on a delegation-rail account (Base or Base Sepolia), so the only visible change is that a historic chain-100 setup row's `network` reads "Chain 100" instead of "Gnosis". No connector-handed command changes.
> - **What did not.** No dist-tag, channel or `HAVEN_CONNECTOR_CHANNEL` behaviour moves.
>
> The rest of this document was not re-read for it, and `last-verified` is not bumped.

> **Re-verified unchanged (2026-10-09, `ALCHEMY_HISTORY_API_KEY` added):**
> - **What changed.** `config.ts` gains `alchemyHistoryApiKey`, read by the Base / Base Sepolia transaction-history reads only. No connector, dist-tag or channel variable is touched.
> - **What did not.** No dist-tag, channel or `HAVEN_CONNECTOR_CHANNEL` behaviour moves.
>
> The rest of this document was not re-read for it, and `last-verified` is not bumped.

> **Re-verified unchanged (2026-10-07, `BLOCKSCOUT_API_KEY` added):**
> - **What changed.** `config.ts` gains `blockscoutApiKey`, read by the Base / Base Sepolia explorer history reads only. No connector, dist-tag or channel variable is touched.
> - **What did not.** No dist-tag, channel or `HAVEN_CONNECTOR_CHANNEL` behaviour moves.
>
> The rest of this document was not re-read for it, and `last-verified` is not bumped.

> **Re-verified unchanged (#3671, 2026-10-06, `RPC_URL` removed):**
> - **What changed.** `config.ts` drops `rpcUrl` (the Gnosis-only `RPC_URL` variable). No connector, dist-tag or channel variable is touched.
> - **What did not.** No dist-tag, channel or `HAVEN_CONNECTOR_CHANNEL` behaviour moves.
>
> The rest of this document was not re-read for it, and `last-verified` is not bumped.

> **Re-verified unchanged (#3830, 2026-10-09, coexisting-agent wording and
> Claude Code wiring evidence):** this doc is coupled through connect's
> `doctor.ts` and `runtime.ts`. The changes: the completion heads-up names the
> other agent directories as "other agent directories on this machine" and
> says this setup revoked none of them (no longer "previous agent(s)" or "If
> you meant to replace them"); on Claude Code `--doctor` reads `~/.claude.json`
> server entries as additive wiring evidence, and the `superseded_agents`
> advisory's label (and the human inventory row) no longer assert
> "superseded". A directory the evidence upgrades to `wired` now runs the full
> per-agent checks, so on Claude Code a broken second agent can fail
> `--doctor` where it used to be an advisory — the behaviour Codex already
> had. The check id, the inventory classifications and every `--json` field
> are unchanged, and no channel, dist-tag, version-order or publish behaviour
> this document describes moves. The rest of this document
> was not re-read for it, and `last-verified` is not bumped.

> **Re-verified unchanged (#3756, 2026-10-07, superseded-agent wording):**
> this doc is coupled through connect's `doctor.ts`, `runtime.ts`, `args.ts`
> and `wiring-collision.ts`, and through the backend's
> `routes/agent-connection-setups.ts` (its approved-agent cancel refusal, which
> this document does not describe). The change is human-readable text only: the
> superseded-agents repair, the replace and new-agent heads-ups, the
> `wiring_collision` refusal and prompt, and the `--replace` help now name
> Remove agent… instead of "revoke" on the agent page. No flag, exit code,
> check id, `--json` field, channel rule or guard this document describes
> moved. The rest of this document was not re-read for it, and
> `last-verified` is not bumped.

> **Re-verified unchanged (#3722, 2026-10-07, leaked-credential copy):** this
> doc is coupled through `packages/connect/src/cli.ts`. The change is two
> human-readable `--tombstone` / `--unwire` output sentences, which now name the
> agent page's **Remove agent…** control instead of "revoke the agent". No flag,
> exit code, `--json` field, channel rule or guard this document describes
> moved. The rest of this document was not re-read for it, and `last-verified`
> is not bumped.

> **Re-verified unchanged (#3267, 2026-09-24, the Safe-era identifier rename):**
> this doc is coupled through `routes/agent-connection-setups.ts` and
> `middleware/retired-safe-names.ts`. The route's change is one internal
> identifier: the `ApprovalStateInput.safeTxHash` field becomes
> `accountTxHash` — a value the repo layer writes to the `account_tx_hash`
> column it always wrote, not the wire input (`safe_id` stays DECLARED and
> REFUSED with a 400 exactly as #2914 left it). The refusal machinery this
> document depends on in `retired-safe-names.ts` is untouched (the file is not
> in the diff). Verified against the diff: `CONNECTOR_PACKAGE`, `CLI_PACKAGE`,
> `config.connectorChannel` and the `/discovery` response shape are unchanged,
> and no channel, dist-tag, version-order or publish behaviour moves. Scope of
> this note: that identifier rename — nothing else in this document was
> re-verified.
>
> **Re-verification (#3271, direct sign-context, 2026-09-24):** this doc is
> coupled through `packages/signer/src/credentials.ts`, where the only change
> is JSDoc: it now names the signer's second read-only fetch
> (`GET /payments/:payment_id/sign-context`, for a direct payment via
> `haven_sign`). Credential resolution, file modes and the `identity.json`
> lookup are unchanged, and no version, dist-tag, channel or publish behaviour
> moves. `last-verified` re-stamped to 2026-09-24 for this note only; nothing
> else in this document was re-verified.
>
> **Re-verification (#3032, connector request fields and owner-route auth
> order, 2026-09-24):** this doc is coupled through
> `packages/backend/src/routes/agent-connection-setups.ts`. The change moves
> the four owner routes' auth hook from `preHandler` to `onRequest`, and
> declares in the OpenAPI request schemas the fields the connector and
> dashboard already send (`local_mcp`, `mcp_server_name`, `skill_installed`,
> `superseded_agent_ids`). The setup, register and install-status flow this
> document describes for the dev channel is unchanged, and no channel,
> dist-tag, version-order or publish behaviour moves. Scope of this note: that
> file — nothing else in this document was re-verified.
>
> **Re-verification (#3772 part 1, retired-agents report, 2026-10-13):** this
> doc is coupled through `routes/agent-connection-setups.ts` and
> `packages/connect/src/runtime.ts`. The change adds
> `POST /agent-connection-setups/{setupId}/retired-agents` and, after a
> completed `--replace`, one best-effort connector call to it (an older
> backend's 404 is ignored silently; any other failure is one log line). The setup, register and install-status flow
> this document describes for the dev channel is unchanged, and no channel,
> dist-tag, version-order or publish behaviour moves. Scope of this note: those
> two files — nothing else in this document was re-verified.
>
> **Re-verification (#3259, failed tombstone mirror, 2026-09-23):** this doc is
> coupled through `packages/connect/src/{cli,runtime}.ts`. The change: a failed
> ledger mirror no longer aborts a retirement, so `--replace` still removes the
> superseded directory's key files and logs a warning, and `--tombstone` /
> `--unwire` report the failure additively. Re-read against the diff: the
> `--replace` guidance in step 2 ("it retires that agent's local key files") is
> now true in the one case where it used to be false, and no channel,
> dist-tag, version-order or publish behaviour moves. `last-verified` already
> reads 2026-09-23. Scope of this note: that passage — nothing else in this
> document was re-verified.

> **Re-verification (#3251, tombstone ledger follows the credential root,
> 2026-09-23):** this doc is coupled through `packages/connect/src/{cli,
> runtime,doctor}.ts`. The change: the retirement record that `--tombstone`,
> `--unwire` and `--replace` mirror now lands in the ledger of the credential
> root that held the retired directory, and `--doctor` reads the ledger of the
> root it scans. For the default root that is `~/.haven/tombstones`, as
> before; any other root keeps it at `<root>/.tombstones/`. Re-read against the diff: the `--replace`
> guidance in step 2 (it retires that agent's local key files; `--doctor`
> enumerates every agent regardless of name) and the override passage
> (`~/.haven/signer-runtime/override-<hash>`) are unchanged, and no channel,
> dist-tag, version-order or publish behaviour moves. Scope of this note: those
> passages — nothing else in this document was re-verified.

> **Re-verification (0.2.1-alpha.0 release, 2026-09-16):** this doc is coupled
> to the release because the bump rewrites `CONNECTOR_VERSION`
> (`packages/connect/src/runtime.ts`), which is in this doc's `covers:` list.
> **In THIS release the coupling is carried by that file alone**: an earlier
> draft of this note also claimed `HAVEN_CONNECTOR_CHANNEL`
> (`packages/sdk/src/connector-channel.ts`) was "re-pinned", and independent
> review found that file is not in the commit at all — the channel was already
> `alpha`, so the bump's write produced no diff. Verified rather than asserted:
> channel `alpha` (unchanged, no diff),
> version `0.2.1-alpha.0`, agreeing across the source, the built connect bundle,
> and the SDK that bundle resolves. **No channel behaviour changed** — nothing in
> this release touches `publish.yml`, `release-channel.mjs`,
> `release-snapshot-version.mjs` or `release-version-order.mjs`, so the
> `0.0.0-dev.*` snapshot path and the rule that the two channels cannot cross are
> untouched. `last-verified` is deliberately NOT bumped: it already reads
> 2026-09-16 from an earlier change today, and re-stamping it would assert a
> whole-document re-verification this release did not perform. Scope of this
> note: `CONNECTOR_VERSION` and the channel constant's unchanged value — nothing
> else in this document was re-verified.

> **Re-verification (#3172, signer audit sidecar, 2026-09-19):** this doc is
> coupled through `packages/signer/src/credentials.ts`, where the only change
> is that `warnIfCredentialFilePermissive` now delegates to a shared
> `file-mode.ts` helper (same message, same `chmod 600` hint, same Windows
> carve-out, and still `stat` — a symlinked credential path is judged by its
> target as before; only the sidecar check uses `lstat`) so the audit sidecar
> can reuse it. `file-mode.ts` is added to this doc's `covers:` because that
> claim now lives there. The credential's NAME
> resolution — `account_address` first, the two pre-#2908 names read
> permanently — is untouched, so the `credentials` check this document describes
> reports exactly what it did. No channel, version-order or publish behaviour
> is touched. `last-verified` is not re-stamped: it already reads 2026-09-19.
> Scope of this note: that one function — nothing else in this document was
> re-verified.

> **Re-verification (#3135, request-validation flip re-key, 2026-09-18):** this
> doc is coupled again through the same `covers:` entry on
> `packages/backend/src/config.ts`, and again only a JSDoc block and the
> boot-refusal error string changed: the per-module override is now keyed on
> the route FILE (`enforcedModules: ['routes/contacts.ts', …]`) rather than the
> mount prefix. The accepted values, the default, the restart semantics and the
> variable's irrelevance to package selection are all untouched, so **nothing in
> this document was made false or stale by that edit** — step 5's claim was
> re-read against the merged tree and holds. `last-verified` is deliberately
> NOT bumped: the re-read confirmed the existing claims rather than adding or
> changing one, and a date moved for that is a rubber stamp the staleness audit
> would then rank on.

> **Re-verification (#3082, request-validation body restore, 2026-09-17):** this
> doc is coupled because `packages/backend/src/config.ts` is in its `covers:` and
> that file was edited. Only a JSDoc block and the boot-refusal error string
> changed, both describing `HAVEN_REQUEST_VALIDATION`: `off` does not disable an
> `enforcedPrefixes` module, and shadow's "changes nothing" was true of the
> handler's view only after #3082 restored the request body. No parse shape, no
> default, no accepted value and no restart semantics moved.
> **Nothing in this document was made false or stale by that edit.** Its own
> claim at step 5 — `off`/`shadow`/`enforce`, default `shadow`, a mode change is
> a restart, and the variable does not affect the package-selection path — was
> re-read against `config.ts` and `openapi/request-validation.ts` at this
> commit and is true in every clause, which is why it needed no content change.

> **Re-verification (contract-doc count correction, 2026-09-17):** this doc is
> coupled because `scripts/release-bump.mjs` is in its `covers:` and that script
> was edited — its *printed* next-steps block said "the two contract docs" and
> enumerated two, while the docs had been corrected to three. Only operator-facing
> log strings and comments changed; no version, pin, channel, dist-tag, build
> order or credential path moves, and `release-bump.test.mjs` is 76/76.
> **Nothing in this document was made false or stale by that edit** — it carries
> no contract-doc count of its own, which is why it needed no content change.
> `last-verified` deliberately NOT bumped: this is a scoped check of one script
> edit, not a re-verification of the document, and #1366 rates a rubber-stamped
> date worse than a stale one.

> **Re-verification (0.3.0-alpha.0 release, 2026-09-17):** coupled because the
> bump rewrites `CONNECTOR_VERSION` (`packages/connect/src/runtime.ts`), which
> is in this doc's `covers:`. Verified rather than asserted: the bump's own
> checks report channel `alpha` and version `0.3.0-alpha.0` agreeing across the
> source, the built connect bundle and the SDK that bundle resolves. **No
> channel behaviour changed** — nothing in this release touches `publish.yml`,
> `release-channel.mjs`, `release-snapshot-version.mjs` or
> `release-version-order.mjs`, so the `0.0.0-dev.*` snapshot path and the rule
> that the two channels cannot cross are untouched. Worth noting for this
> release specifically: `0.0.0-` still sorts below every real version, so the
> MINOR bump to 0.3.0 changes nothing about channel ordering. `last-verified`
> deliberately NOT bumped — **it already reads 2026-09-17 from an earlier change
> today**, and a scoped check of one constant is not a re-verification of this
> document; #1366 rates a rubber stamp worse than a stale date. Scope: `CONNECTOR_VERSION` and the channel constant's value.

> **Re-verification (0.8.0-alpha.0 release, 2026-10-05):** coupled because the
> bump rewrites `CONNECTOR_VERSION` (`packages/connect/src/runtime.ts`), now
> `0.7.0-alpha.0` → `0.8.0-alpha.0`. `HAVEN_CONNECTOR_CHANNEL` stays `alpha`.
> - **Publish path.** Re-measured at `origin/dev` `97a330aa`: `git log
>   origin/main..origin/dev` over `publish.yml`, `release-channel.mjs`,
>   `release-snapshot-version.mjs` and `release-version-order.mjs` returns **0**
>   commits. The bump's own diff touches none of them.
> - **Live dist-tags read during this release.** `dev` =
>   `0.0.0-dev.202610051128.d0e0c97`, below `alpha`/`latest` = `0.7.0-alpha.0`.
>
> `last-verified` is not bumped.

> **Re-verification (0.12.0-alpha.0 release, 2026-10-29):** coupled because the
> bump rewrites `CONNECTOR_VERSION` (`packages/connect/src/runtime.ts`), now
> `0.11.0-alpha.0` → `0.12.0-alpha.0`, a MINOR step. `HAVEN_CONNECTOR_CHANNEL`
> stays `alpha`.
> - **Publish path.** Re-measured at `origin/dev` `feda1617`: `git log
>   origin/main..origin/dev` over `publish.yml`, `release-channel.mjs`,
>   `release-snapshot-version.mjs` and `release-version-order.mjs` returns **1**
>   commit, #4371 (#4374), which corrects a header comment in `publish.yml`
>   ("four" places to "five") and changes no step. The bump's own diff touches
>   none of these files.
> - **Live dist-tags read during this release** (registry over HTTP). `dev` =
>   `0.0.0-dev.202610271239.8cdcf88`, below `alpha`/`latest` = `0.11.0-alpha.0`
>   for all five packages.
>
> `last-verified` is not bumped.

> **Re-verification (0.11.0-alpha.0 release, 2026-10-23):** coupled because the
> bump rewrites `CONNECTOR_VERSION` (`packages/connect/src/runtime.ts`), now
> `0.10.0-alpha.0` → `0.11.0-alpha.0`, a MINOR step. `HAVEN_CONNECTOR_CHANNEL`
> stays `alpha`.
> - **Publish path.** Re-measured at `origin/dev` `7b2cca38`: `git log
>   origin/main..origin/dev` over `publish.yml`, `release-channel.mjs`,
>   `release-snapshot-version.mjs` and `release-version-order.mjs` returns **0**
>   commits. The bump's own diff touches none of these files.
> - **Live dist-tags read during this release** (registry over HTTP). `dev` =
>   `0.0.0-dev.202610222020.b071b39`, below `alpha`/`latest` = `0.10.0-alpha.0`
>   for all five packages.
>
> `last-verified` is not bumped.

> **Re-verification (0.10.0-alpha.0 release, 2026-10-14):** coupled because the
> bump rewrites `CONNECTOR_VERSION` (`packages/connect/src/runtime.ts`), now
> `0.9.0-alpha.0` → `0.10.0-alpha.0`, a MINOR step. `HAVEN_CONNECTOR_CHANNEL`
> stays `alpha`.
> - **Publish path.** Re-measured at `origin/dev` `641f527d`: `git log
>   origin/main..origin/dev` over `publish.yml`, `release-channel.mjs`,
>   `release-snapshot-version.mjs` and `release-version-order.mjs` returns **2**
>   commits, both in `publish.yml`'s publish loop:
>   - #3797 (#3800) holds back a package whose internal dependency did not
>     publish in the same run;
>   - #3819 (#3828) makes that ledger work on bash 3.2.
>
>   Neither touches channel selection, the `dev` snapshot version or version
>   ordering. The bump's own diff touches none of these files.
> - **Live dist-tags read during this release** (registry over HTTP). `dev` =
>   `0.0.0-dev.202610130724.e847be6`, below `alpha`/`latest` = `0.9.0-alpha.0`
>   for all five packages.
>
> `last-verified` is not bumped.

> **Re-verification (0.9.0-alpha.0 release, 2026-10-09):** coupled because the
> bump rewrites `CONNECTOR_VERSION` (`packages/connect/src/runtime.ts`), now
> `0.8.1-alpha.0` → `0.9.0-alpha.0`, a MINOR step. `HAVEN_CONNECTOR_CHANNEL`
> stays `alpha`.
> - **Publish path.** Re-measured at `origin/dev` `50fa90e1`: `git log
>   origin/main..origin/dev` over `publish.yml`, `release-channel.mjs`,
>   `release-snapshot-version.mjs` and `release-version-order.mjs` returns **0**
>   commits. The bump's own diff touches none of them.
> - **Live dist-tags read during this release** (registry over HTTP). `dev` =
>   `0.0.0-dev.202610082107.41e4d64`, below `alpha`/`latest` = `0.8.1-alpha.0`
>   for all five packages.
>
> `last-verified` is not bumped.

> **Re-verification (0.8.1-alpha.0 release, 2026-10-07):** coupled because the
> bump rewrites `CONNECTOR_VERSION` (`packages/connect/src/runtime.ts`), now
> `0.8.0-alpha.0` → `0.8.1-alpha.0`, a PATCH step. `HAVEN_CONNECTOR_CHANNEL`
> stays `alpha`.
> - **Publish path.** Re-measured at `origin/dev` `03e07aca`: `git log
>   origin/main..origin/dev` over `publish.yml`, `release-channel.mjs`,
>   `release-snapshot-version.mjs` and `release-version-order.mjs` returns **0**
>   commits. The bump's own diff touches none of them.
> - **Live dist-tags read during this release** (registry over HTTP). `dev` =
>   `0.0.0-dev.202610061536.ad3de49`, below `alpha`/`latest` = `0.8.0-alpha.0`
>   for all five packages.
>
> `last-verified` is not bumped.

> **Re-verification (0.7.0-alpha.0 release, 2026-09-29):** coupled because the
> bump rewrites `CONNECTOR_VERSION` (`packages/connect/src/runtime.ts`), now
> `0.6.0-alpha.0` → `0.7.0-alpha.0`. `HAVEN_CONNECTOR_CHANNEL` stays `alpha`,
> since a prerelease of `0.7.0` keeps the `alpha` label.
> - **Publish path.** Re-measured at `origin/dev` `ffd8856c`:
>   `git log origin/main..origin/dev` over `publish.yml`, `release-channel.mjs`,
>   `release-snapshot-version.mjs` and `release-version-order.mjs` returns **0**
>   commits.
> - **The bump's own diff.** It touches none of those four. It does include the
>   release-bump constant-table fix (`SIGNER_VERSION` is read from the signer's
>   `tools.ts`), which landed on `dev` just before this cut.
> - **Live dist-tags read during this release.** `dev` =
>   `0.0.0-dev.202609282315.dd06d7c`, below `alpha`/`latest` = `0.6.0-alpha.0`.
>   The next `alpha`/`latest` is `0.7.0-alpha.0`.
>
> `last-verified` is not bumped.

> **Re-verification (0.6.0-alpha.0 release, 2026-09-26):** coupled because the
> bump rewrites `CONNECTOR_VERSION` (`packages/connect/src/runtime.ts`), now
> `0.5.0-alpha.1` → `0.6.0-alpha.0`, with `HAVEN_CONNECTOR_CHANNEL` = `alpha`
> unchanged (a prerelease of `0.6.0` keeps the `alpha` label). Re-measured at
> `origin/dev` `8944227d`: `git log origin/main..origin/dev` over `publish.yml`,
> `release-channel.mjs`, `release-snapshot-version.mjs` and
> `release-version-order.mjs` returns **0** commits, and the bump's own diff
> touches **0** of them. Live dist-tags read during this release: `dev` =
> `0.0.0-dev.202609261411.8944227` on all five packages, below `alpha`/`latest`
> = `0.5.0-alpha.1`; the next `alpha`/`latest` is `0.6.0-alpha.0`. This bump is
> also the first to regenerate the client release data (#3305); a snapshot run
> still skips it. `last-verified` is not bumped.

> **Re-verification (0.5.0-alpha.1 release, 2026-09-25):** coupled because the
> bump rewrites `CONNECTOR_VERSION` (`packages/connect/src/runtime.ts`), now
> `0.5.0-alpha.0` → `0.5.0-alpha.1`, with channel `alpha` agreeing across
> source, bundle and resolved SDK. Re-measured at `origin/dev` `20176679`:
> `git log origin/main..origin/dev` over `publish.yml`, `release-channel.mjs`,
> `release-snapshot-version.mjs` and `release-version-order.mjs` returns **0**
> commits, and the bump's own diff touches **0** of them. Live dist-tags read
> during this release: `dev` = `0.0.0-dev.202609251409.98ed67a` on all five
> packages, below `alpha`/`latest` = `0.4.0-alpha.0`. `0.5.0-alpha.0` never
> reached npm (see the runtime-compatibility note), so the next `alpha`/`latest`
> is `0.5.0-alpha.1`. `last-verified` is not bumped.
>
> **Re-verification (0.5.0-alpha.0 release, 2026-09-25):** coupled because the
> bump rewrites `CONNECTOR_VERSION` (`packages/connect/src/runtime.ts`), which
> is in this doc's `covers:`. Verified rather than asserted: the constant moved
> `0.4.0-alpha.0` → `0.5.0-alpha.0`, and the bump's own checks report channel
> `alpha` agreeing across the source, the built connect bundle and the SDK that
> bundle resolves. **No channel behaviour changed** — re-measured, not carried
> over from the 0.4.0 note: `git log origin/main..origin/dev` over
> `publish.yml`, `release-channel.mjs`, `release-snapshot-version.mjs` and
> `release-version-order.mjs` returns **0** commits, and this bump's own diff
> touches **0** of them, so the `0.0.0-dev.*` snapshot path and the rule that the
> two channels cannot cross are untouched. The `dev` tag observed during this
> release, `0.0.0-dev.202609250737.3bd5a51`, sits below `alpha`/`latest` at
> `0.4.0-alpha.0` exactly as the ordering rule requires; a MINOR step changes
> nothing about that. `last-verified` deliberately NOT bumped — it already
> reads 2026-09-24 from an earlier change, and this note re-reads only
> `CONNECTOR_VERSION` and the channel constant's value.
>
> **Re-verification (#3509):** coupled because `packages/backend/src/config.ts`
> is in this doc's `covers:`. The only change there adds one field, `config.ops`
> (the ops console's settings, parsed by `config/ops.ts`), plus its import, and
> adds `ops_auth` to the two TRUST_PROXY_HOPS boot-warning strings.
> `connectorChannel` / `parseConnectorChannel` and `requestValidationMode`, the
> two `config.ts` claims this document makes, have no diff
> (`git diff origin/dev -- packages/backend/src/config.ts`). `last-verified` is
> not bumped. Scope of this note: the config claims — nothing else in this
> document was re-verified.
>
> **Re-verification (#3510):** coupled for the same reason. The only change to
> `packages/backend/src/config.ts` adds one field, `opsDatabaseUrl` (parsed by
> `parseOpsDatabaseUrl` in `config/ops.ts`) and its comment, plus its import.
> `connectorChannel` / `parseConnectorChannel` and `requestValidationMode` have
> no diff. `last-verified` is not bumped; nothing else here was re-verified.
>
> **Re-verification (#3799, 2026-10-09, the upgrade hint's per-agent suffix).**
> This diff touches covered connect files (`doctor.ts`, `cli.ts`, `args.ts`,
> `storage.ts`) and `packages/backend/src/middleware/client-compat.ts`. For
> the connector packages only, `client_update.upgrade_command` may append
> ` --name <slug>` — normalised from `agents.mcp_server_name` (migration 067)
> with a fail-closed slug check, `haven` → no flag, anything the connector's
> parser would refuse → no flag. The suffix is added in the backend hint
> (from the SAME auth SELECT that authenticated the request — no second read
> in `onSend`), not in core or the SDK: `@haven_ai/core`'s
> `upgradeCommandFor` keeps the bare `/ --doctor$/` form,
> `connector-upgrade-command-parity.test.ts` is unchanged and green, and
> `/discovery`, `/.well-known/haven.json` and `/releases` keep the bare
> command. The connect-side changes are directory selection and refusal
> wording (`--doctor`/`--repair --name <slug>` now resolve through the shared
> pair-record rule); channel selection, dist-tag resolution, version
> ordering and the snapshot path do not move. `last-verified` is not bumped:
> this note is the scope. Nothing else in this document was re-verified.
>
> **Re-verification (#3304):** coupled because `packages/core/src/client-compat.ts`
> is in this doc's `covers:`. The only edit there is a comment: the sentence
> saying the public release documents "will read" the table became "read", now
> that `client-releases.ts` does. The snapshot exemption this doc states
> (`isSnapshotVersion`, a `0.0.0-dev.*` client never hinted or refused) is
> unchanged: `evaluateClient` and `isSnapshotVersion` have no diff. The new
> release documents publish `released_version` per package; a snapshot is not a
> release, so nothing a `--snapshot` run writes appears in them. `last-verified`
> is not bumped.

> **Re-verification (#3032, slice-4 default flip, 2026-09-25):** this doc is
> coupled once more through the same `covers:` entry on
> `packages/backend/src/config.ts`, and this time the DEFAULT did move:
> `parseRequestValidationMode` now returns `enforce` when
> `HAVEN_REQUEST_VALIDATION` is unset or empty (previously `shadow`), per epic
> #3028 slice 4 — every constrained module is listed in `index.ts` and the
> rollout completes. Step 5's claim was rewritten for the new default (the
> accepted values `off`/`shadow`/`enforce`, the refuse-the-boot shape, the
> restart semantics and the variable's irrelevance to package selection are
> untouched). `last-verified` is bumped by this edit: the claim it anchors
> changed.
> Scope of this note: the default in step 5 — nothing else in this document
> was re-verified.

> **Re-verification (0.4.0-alpha.0 release, 2026-09-19):** coupled because the
> bump rewrites `CONNECTOR_VERSION` (`packages/connect/src/runtime.ts`), which
> is in this doc's `covers:`. Verified rather than asserted: the constant moved
> `0.3.0-alpha.0` → `0.4.0-alpha.0`, and the bump's own checks report channel
> `alpha` agreeing across the source, the built connect bundle and the SDK that
> bundle resolves. **No channel behaviour changed** — measured over the whole
> promotion range and over this bump's own diff, neither touches
> `publish.yml`, `release-channel.mjs`, `release-snapshot-version.mjs` or
> `release-version-order.mjs`
> (`git log origin/main..origin/dev -- <those four>` is empty, as is
> `git diff --name-only` for them here), so the `0.0.0-dev.*` snapshot path and
> the rule that the two channels cannot cross are untouched. Specific to this
> release: a MINOR step changes nothing about channel ordering — `0.0.0-` still
> sorts below every real version, and the `dev` tag observed during this release
> (`0.0.0-dev.202609190936.6937e31`) sits below `alpha`/`latest` at
> `0.3.0-alpha.0` exactly as the ordering rule requires. `last-verified`
> deliberately NOT bumped — **it already reads 2026-09-19 from an earlier change
> today** (#3122) — and a scoped check of one constant is not a re-verification
> of this document; #1366 rates a rubber stamp worse than a stale date. Scope:
> `CONNECTOR_VERSION`, the channel constant's value, and the four
> channel-machinery files named above.

> **Re-verification (#3305):** `release-bump.mjs` gained a second documentary
> write, and the snapshot path skips it exactly like the CHANGELOG heading. The
> write regenerates the client release data file in `@haven_ai/core` (the
> public release data behind `/releases`) from the CHANGELOGs, and a real
> release first refuses a hand-edited copy. In snapshot mode neither the refusal
> nor the write runs: the bump logs that the data was skipped because a dev
> snapshot is not a release, and `release-bump.test.mjs` pins the guard with a
> mutation that goes red. A snapshot therefore never depends on that file; CI
> keeps the committed copy in step with the CHANGELOGs. Nothing about the snapshot version format, the five guards,
> `HAVEN_CONNECTOR_CHANNEL` or the publish job moved.

> **Re-verification (changelog-heading gap, 2026-09-14):** `release-bump.mjs`
> gained one responsibility — rewriting `## Unreleased` to
> `## <version> — <date>` in each published package's CHANGELOG — and the
> snapshot path deliberately does **not** take it. A `0.0.0-dev.*` snapshot is
> not a release, so stamping a release heading for one would be false even
> though the tree is throwaway and no CHANGELOG reaches a tarball; the bump
> logs `CHANGELOG headings: skipped — a dev snapshot is not a release` instead,
> and a test pins the `!snapshot` guard. Nothing about the snapshot version
> format, the five guards, `HAVEN_CONNECTOR_CHANNEL` or the publish job moved.

> **Re-verification (#2908, naming epic #2906 phase 1):** the connector's
> covered files changed in what they WRITE and READ, not in how the channel
> works — `runtime.ts` hands `writeCredentials` an `accountAddress` (written to
> disk as `account_address`, no `safe_address`), and `doctor.ts`'s
> `credentials` check reports which name a stored set carries. Nothing about
> `HAVEN_CONNECTOR_CHANNEL`, the re-run hint, the runtime-spec override or the
> publish job moved. The epic's O3 proof is exactly this loop: after the
> release carrying #2908 lands on `@dev`, re-run `npx @haven_ai/connect@dev`
> on one founder machine whose credential files and `~/.haven` env still
> carry the OLD names (`safe_address`, `HAVEN_SAFE_ADDRESS`), confirm
> `--doctor` says `stored under the pre-#2908 name safe_address — still read`,
> pay one x402 call, and confirm the receipt's `payer` field is populated —
> recorded on #2906 before promotion.
>
> **Half of that proof expires with #2914 and half does not, and the
> difference is the whole point.** The credential-FILE half stands: a file on
> disk never rewrites itself, so `safe_address` is read permanently and
> `--doctor` still says so. The ENV half does not: `HAVEN_SAFE_ADDRESS` and
> `HAVEN_WALLET_ADDRESS` are no longer read at all, so that machine now needs
> `HAVEN_ACCOUNT_ADDRESS` set. Re-running the O3 proof after the contraction
> without that change tests a machine that cannot resolve its account, and
> would read as a regression in the connector rather than the intended
> retirement.

Re-verified again 2026-09-17 against the #2914 FOLLOW-UP (the release that
removes the two response twins and the third retired response name). That
change is RESPONSE-side only: `GET /user/accounts` drops the `safes` envelope
twin, the `GET /transactions` feed drops `safeName`, and
`GET /transactions/filters` renames `safes` to `accounts`. The paragraph
above is about a REQUEST field on `POST /agent-connection-setups`, and that
field's behaviour is unchanged — `safe_id` stays declared and stays refused
with a 400, for the reason the paragraph gives. `CONNECTOR_PACKAGE`,
`CLI_PACKAGE`, `config.connectorChannel` and the `/discovery` shape are again
untouched. The doc is a contract doc for this change because
`middleware/retired-safe-names.ts` is in its `covers:` list; what changed
there is the deletion of the two twin helpers, not the refusal machinery this
document depends on.

Re-verified again 2026-09-21 against PR #3207 (#3030, request validation
slice 2): the only `config.ts` change is the JSDoc above
`requestValidationMode`, whose example list of `enforcedModules` had been
stale since #3167 and now points at `index.ts` as the list's one home; the
key's parser, its three values and the boot refusal on any other value are
untouched, `connectorChannel` and `/discovery` are untouched, so no claim in
this document moved and `last-verified` is left where it is — the
comment-only rule above.

Re-verified again 2026-09-23 against #3255 (backend RPC failover):
`config.ts` gains `PUBLIC_RPC_BASE` / `PUBLIC_RPC_BASE_SEPOLIA` (the two
public-node literals `warnPublicRpc` already used, now named once) and
`rpcUrlBaseFallback` / `rpcUrlBaseSepoliaFallback` (the optional
`RPC_URL_BASE*_FALLBACK` second provider, trimmed by `parseRpcFallbackUrl`).
`connectorChannel`, its parser and `/discovery` are untouched, so no claim in
this document moved and `last-verified` is left where it is.

Re-verified again 2026-09-20 against PR #3202 (epic #3077 decision 14):
the only `config.ts` change is the comment above `marketplaceProspectsEnabled`,
which now states the prospects gate as "the explicit marketplace list names a
testnet" instead of "no mainnet listed"; the key's parser (`parseBooleanFlag`,
the #3015 shape this document holds up), `connectorChannel` and `/discovery`
are untouched, so no claim in this document moved and `last-verified` is left
where it is — the comment-only rule above.

Re-verified again 2026-09-17 against #3078
(the marketplace's slice 1): `config.ts` gains `marketplaceChainIds` and
`marketplaceProspectsEnabled` (the latter through the same `parseBooleanFlag`
this document holds up as the #3015 shape) — two read-side keys beside
`connectorChannel`, which is not touched, and `/discovery` is not touched
either. Identifiers only for this section:

> **Re-verified #3772 (2026-10-08):** `packages/connect/src/runtime.ts`
> gains a stale-session sentence in a rebind run's `activation.instruction`
> and human output. `CONNECTOR_VERSION`, the channel resolution and the
> install path are untouched; nothing in this document changes meaning.
> Nothing else here was re-verified, and `last-verified` is not bumped.

> **Re-verified #2963:** for a *pinned* (non-override) install `--doctor`'s
> `signer_runtime` check compares intactness against the sidecar and currency
> against the manifest — a dev-channel snapshot that is intact but behind the
> pin now reads as version drift, not `stale or empty`; the override path
> described above is unchanged (it already compared against the sidecar).

> **Re-verified #3120:** the doctor/repair surfaces this loop uses keep their
> contracts. `--doctor` now resolves the runtime from the agent directory's
> `last-connect-outcome.json` when the `--runtime` flag is absent; `--repair`
> is refused by the parser without `--runtime` (#3210), so it never inherits a
> runtime — the override flow above always names its runtime, so it never
> enters either path. The section's commands keep explicit `--runtime <name>`
> flags and behave exactly as written; the snapshot channel rules, the five
> guards and `HAVEN_CONNECTOR_CHANNEL` did not move.

> **Re-verification (#3332, unrelated `config.ts` addition, 2026-09-27):** this
> diff adds one new field to `config.ts` — `ownerCompanyDetailsEnabled`
> (`HAVEN_OWNER_COMPANY_DETAILS`), a strict boolean flag for an unrelated
> settings feature. It does not touch `HAVEN_CONNECTOR_CHANNEL`, the channel
> validation regex, or any field this document names; nothing about channel
> selection, dist-tag resolution, or the snapshot path moves. Scope of this
> note: confirming that. Nothing else in this document was re-verified.

> **Re-verification (release-bump constant table, 2026-09-29):** coupled
> through `scripts/release-bump.mjs`. The snapshot path is untouched: it
> rewrites the same constants, now read from
> `scripts/release-version-constants.mjs`, with `SIGNER_VERSION` in
> the signer's `tools.ts` since #3454. The snapshot version format, the
> guards, `HAVEN_CONNECTOR_CHANNEL` and the `dev` dist-tag publish did not
> move.

> **Re-verified #3996 (2026-10-15 — an additive env reader in
> `packages/mcp/src/credentials.ts`).** The diff touches two covered paths:
> `packages/mcp/src/credentials.ts`, which gains the exported
> `chainRpcsFromEnv(env)` helper, and `packages/mcp/src/server.ts`, newly
> declared in `covers:` so this doc is implicated the next time that file
> changes. The helper scans for `HAVEN_RPC_URL_<chainId>` scalars, consumed by
> `resolveHavenClient`. It does not touch `HAVEN_CONNECTOR_CHANNEL`, the
> credential-file shape, the consent inputs, any version constant, or any
> field this document names; nothing about channel selection, dist-tag
> resolution, the snapshot path or publish behaviour moves. Scope of this
> note: confirming that. Nothing else in this document was re-verified.

> **Re-verified unchanged (#4371, 2026-10-23 — `publish.yml`'s invariant
> comment).** The comment over the dev-tag invariant in
> `.github/workflows/publish.yml` now says five enforcement places, matching the
> five it lists and the "**Five** independent guards" this document already
> states. Comment only: no step, guard, channel resolution or dist-tag behaviour
> changes. Scope of this note: that comment. Nothing else in this document was
> re-verified.

> **Re-verified unchanged (#4514, 2026-10-28 — descriptive text in
> `packages/backend/src/config.ts`).** The comment over
> `accountingEntitlementMode` and the text of the
> `parseAccountingEntitlementMode` boot-refusal message no longer name a
> deployment as the one that runs mode `all`. The parser still accepts exactly
> `granted` and `all` and still refuses the boot on any other non-empty value,
> so step 5's "the same refuse-the-boot shape for its own two values" still
> holds. `parseConnectorChannel` and `HAVEN_CONNECTOR_CHANNEL` are untouched.
> Scope of this note: confirming that. Nothing else in this document was
> re-verified.
```

## `docs/operations/promoting-dev-to-main.md`

<!-- sha256: 4b16a5f7110ecd5e08f82c792c96d6d837fb63acd91a2d03ae342cc911fd8973 -->
```markdown
> **Re-verified 2026-10-19 (weekly docs audit #3645, at dev `cf88627c`):**
> the whole checklist was re-read. Changed: the npm item names the #3797
> hold-back; the request-validation item names the right three routes enforced
> on test evidence (#3223) and keeps reconciliation-events in shadow; the docs
> audit item points at the open standing issue rather than the closed #2645;
> and the closing note no longer says `main` has not moved since June.
> Checked and accurate: the 19 required contexts (15 + 4, read from the live
> rulesets), `dismiss_stale_reviews_on_push` and the strict up-to-date rule on
> `main`, the one CODEOWNERS rule, `release:scope`'s exit codes 2 and 1, the
> RPC probe's defaults (batch 10, burst 20, cap 50), the public RPC defaults,
> `SWEEP_MIN_USDC`'s `0.01` default, and the `enforce` default. Not checkable
> from the repo: the npm token's expiry date.

> **Re-verified 2026-10-25 (#4372 part H, at dev `e778da444`):** the whole
> checklist was re-read. Changed: the merge item records that *Dev gate* now
> allows only the `merge` method on `main`, and the closing note names #4338
> as the latest promotion. Checked and accurate: the 19 required contexts (15
> on *Haven automerge rules* for `main` and `dev`, plus `gate`, `qa-freshness`,
> *Design visual regression* and *Frontend browser smoke* on *Dev gate*), the
> strict up-to-date rule on `main` only, `dismiss_stale_reviews_on_push`, the
> one CODEOWNERS rule (migration files), *External intake gate* required on
> `dev` only, the workflow names, `publish.yml`'s `promote-tags` job and its
> FAILED rows, `release:scope`'s exit codes 2 and 1, the RPC probe's defaults
> (batch 10, burst 20, cap 50, logs range 500), `SWEEP_MIN_USDC`'s `0.01`
> default, the `enforce` default, and every link anchor. Not checkable from the
> repo: the npm token's expiry date.
```

## `docs/product/accounting-connections.md`

<!-- sha256: 3ad65aa1542df045f8d08f52fb464983230ddd4e749a878a77fd3f68855885d5 -->
```markdown
> **Re-verified #3093 (frontend hooks: wire keys default instead of crashing):**
> this diff touched `hooks/useAccounting.ts`, in this document's coverage list, by
> defaulting the array keys it stores (`?? []`) so an API answer without the key degrades to an empty state instead
> of sending the route into the ErrorBoundary. No endpoint, flow or
> behaviour this document describes changes. Scope of this note: those
> expressions. Nothing else in this document was re-verified.
```

## `docs/product/agent-key-rotation.md`

<!-- sha256: 3f57a3f5f011aa57a597d4d90506d510c6320b6beb83a62213ac0878c71eff62 -->
```markdown
Re-verified 2026-10-24 (#4372 part C, at dev `795c50fc7`), end to end. Changed:
the preflight reads the old address's USDC balance (`sweepUsdcAddress`); the
carry table gains the end date (the carry expires at `min(boundary, expires_at)`
and the steady grant keeps the original `expires_at`, `rekey-carry.ts`); the
dashboard step says approve, once per replacement budget rule, and that a
carried budget is up to two rules (`ReplaceSigningKeyModal.tsx`, "one approval
each"); `--rekey-finish` reinstalls the signer runtime only with `--runtime`
(`rekey.ts`, `prepareSignerRuntime` inside the `options.runtime` branch); and an
unrecorded MCP name reads "not recorded" in the agent Settings tab's MCP server
name row (`McpServerName.tsx`, #4209); and, from review round 1, the
Compromised choice lists up to five recent payments under "Recent spending to
review" — there is no exposure-time input (`ReplaceSigningKeyModal.tsx`).
Re-checked without change: owner-only
routes and `refuseAgentCaller`; revoke before issue; the remainder and boundary
carry, the dormant re-issue, the expired grant and the dropped cross-period
carry (`planCarry`); the old API key rotating in the completion transaction;
`pending_signature` intents expiring (`INVALIDATE_OLD_PAYER_INTENTS_SQL`); the
passport re-anchor and its `pending` case (`reanchor.ts`); the connector's
legacy-rail and revoked refusals and its 24-hour parked keypair; `--doctor`'s
`identity_match` and parked-re-key report; the #1868 adoption refused after a
new grant; #1849, #1868, #1878, #1911, #2413 and #3728 closed.
```

## `docs/product/analytics.md`

<!-- sha256: e04cfef2510a5f0a9c57a0718b84c45a7863e4f153cd43736fc5add38256f1fb -->
```markdown
Re-verified 2026-09-30 for #3195 (PR #3176's round-3 items), scope = the
*Currency basis* paragraph above and the front-matter stamp: #3195 moved the
ONE per-currency locale rule into `lib/format.ts`'s `currencyLocale`, and this
doc's covered `lib/analytics-format.ts` (`analyticsCurrencyLocale`) now
delegates to it rather than carrying a byte-identical copy of the ternary —
no rendered voice changed, which the `lib/__tests__/analytics-format.test.ts`
byte-level pins prove. In the same scope pass: the *Currency basis* paragraph
(whose SEK sums wording came from the 2026-09-20 #3127 round-3 edits) was
re-read against the analytics endpoint and is still accurate — the page
requests `currency=sek` and renders the endpoint's booked figures, no client
derivation. The stamp this bump replaces was set by #3205 (2026-09-21), which
did not touch the SEK passages; they were never explicitly re-verified since
they landed until this pass. Nothing else in this file was re-read.

Re-verified 2026-10-24 (#4372 part C, at dev `795c50fc7`), end to end, after
#4331, #4332 (#4373) and #4333 (#4380). Changed: the endpoint's parameters
include `agentId`; Spent is net of delegate sweeps in the same window (#3755,
the inline ratio in `TOTALS_SPEND_SQL`/`BY_DAY_SPEND_SQL`/`PER_AGENT_SPEND_SQL`); the Refused tile always shows its attempts; Agents near
their budget renders "N/M" and "—" without budgets; the Fees tile is a fifth
tile; an agent's chart fill is its avatar tint and the agents table carries no
swatch (#4331); the page no longer prints the unsettled-payments sentence
(#4380 dropped `UnsettledEvidenceFootnote`), while the endpoint still reports
the count and the empty-window rule still treats it as activity; the API
reports the refusal ledger's floor (`basis.refusals_recorded_from`, #3013);
the sponsored-gas count rides the Fees tile; the populated fixture's third
merchant is an unresolved row (`kind: 'unknown'`); review round 1 found two
more stale claims and corrected them: there is no "based on N payments" basis
line (`analytics.visual.spec.ts:197`), and `analytics-empty` captures the
no-activity state, because `/agents` still answers the harness's agents
(`analytics.visual.spec.ts:230`); `covers:` gains `packages/ui/src/StatTile.tsx`.
Re-checked without change:
`?period=` and `haven.analytics.range` with `replaceState`; the Agent facet
from `useAgents`, its 404 notice and the agent-scoped Review link; the
Payments caption; the agents-table columns and the #3540 inclusion rule; the
merchant naming order (`counterparty-name.ts`), its kind lines and the
`/transactions?search=…` target; the balance copy and "Net change"; the
`tz` default and 400; `MIN_CHARTABLE_DAYS = 3`; migration 086's date.

Re-verified 2026-11-02 (weekly docs audit #4605, at dev `fc8ac1eb6`). Changed:
the trailing note that said #4334 "rewrites that paragraph" is gone — #4334
landed in `ee7fdd27c` on 2026-10-24 and the *Spend over time* paragraph above
already carries its content (one slot per local calendar date, sub-cent tick
decimals, the refusal mark under a slot), so the note was describing shipped
work as pending. Re-checked without change: the endpoint's `range` /
`currency` / `tz` / `agentId` parameters (`routes/analytics-overview.ts`); the
`PeriodPicker` presets and `haven.analytics.range`; the Agent facet's
`?agentId=` and its 404 notice; the Refused tile's Review link
(`/agents/<id>?tab=activity&status=refused`); the "N/M" budget band; the
agents-table columns and the compact `style: 'row'` budget caption; the Fees
tile as a fifth tile; the spend chart above the agents table with the avatar
stack in Top merchants (#4509); the green Net change tone (#4480); migration
086's date and migration 090's SEK column; and the three screenshot scenarios
(`analytics-populated`, `analytics-empty`, `analytics-error`) in
`scripts/screenshot.mjs`.
```

## `docs/product/cli-json-conventions.md`

<!-- sha256: fd3d2f98ba02cbdf1f722cd031a80c128fd241c99a97046f6e801bf3854efa1e -->
```markdown
Re-verified 2026-09-30 (weekly docs audit #3413, at dev `5b5bd059`). No claim
needed rewriting. `npm run lint:vocabulary` exits green at this head with the
same census the doc describes (31 receipt fields, 35 transaction fields, 11
declared concepts, 0 open, 17 CLI envelope emitters). Re-read in code: the
`wallets balances` `chainId` re-map is still the one CLI-chosen casing on a
forwarded value (`commands.ts` `emit(d, …, { …, chainId: safe.chain_id, … })`);
the auth envelope's mixed `expires_at` beside `apiBaseUrl`, the pure-snake
`--no-wait` device envelope, `guide`'s `{ ok, format: 'markdown', content }`,
`agents connect --run`'s `connector_command`/`connector_exit_code`/`relay`
snake result, and the grant/revoke prepared-action key sets are all verbatim
as documented; the CSV header row is unchanged (all twelve names, in order);
the `safe_address` permanent fallback in the connector's doctor
(`doctor.ts` `has('safe_address')` path) is as written. The covered-file
commits since the last verification touched no envelope: `#3415` changed
upgrade-hint TEXT only, and the 0.7.0-alpha.0 release bump is the version
constant.

Re-verified 2026-10-19 (weekly docs audit #3645, at dev `cf88627c`).
`npm run lint:vocabulary` is green with 31 receipt fields, 40 transaction
fields, 11 declared concepts, 0 open and 18 CLI envelope emitters. Changed:
the census counts eighteen emitters (`cmdFeedbackSubmit`, #3597); the revoke
envelope's `live_delegations` (#3729) and `feedback submit`'s envelope are
documented; the device flow's ok-less pending object (exit 3) is documented;
the five `Transaction` fields added since (#3763, #3778, #3824) are named;
and the failure section lists the two further typed refusals (#3729, #3933).
Run here: `haven guide --json` (the `{ ok, format, content }` envelope) and
`whoami --json` / `activity list --json` signed out (the failure shape, exit
3). Re-read in code and unchanged: the `wallets balances` re-map, the auth
literals, the grant/revoke key sets, the CSV header row, and the doctor's
`safe_address` fallback.

Re-verified 2026-10-25 (#4372 part H, at dev `e778da444`). `npm run
lint:vocabulary` is green with 31 receipt fields, 42 transaction fields, 11
declared concepts, 0 open and 18 CLI envelope emitters. Changed: the two
`Transaction` fields #4319 added (`settlementTracking`, `settlementProof`) are
named, so the count above is seven. Since `cf88627c` the only change to
`commands.ts` is the `CLI_VERSION` constant, and `output.ts` and `doctor.ts`
are unchanged, so every envelope, key set, the CSV header row, the
`wallets balances` re-map and the doctor's `safe_address` fallback stand as
the 2026-10-19 read left them. The seven no-`ok` emitters were re-counted
from the map's `cliConventions.envelopes`.
```

## `docs/product/copy-guidelines.md`

<!-- sha256: 443f01164710da3b6aa9f72e755dffe461c7d37d2085374c97cf29818b8cdf5a -->
```markdown
Re-verified 2026-10-02 (#3596, the agent-skills index and step files): this
PR touches `packages/sdk/src/agent-guidance.ts` (three cross-reference fixes
inside `HAVEN_AGENT_RUNBOOK_MD`, so no standalone step file points at another
section by position) and adds no new agent-facing prose file under `lib/` — the new
`packages/frontend/src/lib/agent-skill-steps.ts` and `agent-skill-index.ts`
hold slug/title/description metadata and JSON-builder code, not rendered
copy, so neither belongs in `SCAN_FILES`. No wording constraint in this guide
or `casp-risk-guardrails.md` § Product Copy Rules is affected: all three are
cross-reference fixes (a dangling "(below)"; a "Steps 1-3 … as above" that
leaned on two other sections once split; a "the setup above"), not changes to
what the runbook claims. Nothing else in this document was re-verified.

Re-verified 2026-10-10 (#3882): the 2026-10-02 call above is reversed for
the agent-skills index. Its slugs and builder code are not copy, but each
step's `description`, the index's own first entry and its `mcp.note` are
agent-read prose served in `/.well-known/agent-skills/index.json` that
appears nowhere else (no description is in the runbook), which is the bar
`agent-guidance.ts` and `for-agents.md` already meet. `agent-skill-steps.ts`
and `agent-skill-index.ts` are now in `SCAN_FILES`, with four more `lib/`
prose files the naming convention could not catch: `dashboard-attention.ts`
(the "Needs attention" titles, subtitles and empty-state lines), `agent-list-filters.ts` (agent-list filter
and sort labels), `agent-credential.ts` (the `notes` prose in the downloaded
credential file) and `sub-budget.ts` (form validation and error copy). A pin
test keeps all six listed. `src/hooks` prose (step headings, `setError`
strings) stays unscanned — a separate follow-up. The script's `SCAN_FILES`
is the list; the named files in the bullets above are examples.

Re-verified 2026-10-10 (#3884): that follow-up landed. `src/hooks` is now a
scanned directory. Measured first: 49 files, two hits, both code rather than
copy (a regex in `useAgentRekey.ts`, a JSDoc comment in
`useAccountSigners.ts`), held as permanent reviewed entries in
`packages/frontend/copy-lint-baseline.json` — the reason is on `SCAN_DIRS` in
the script, since the baseline file cannot carry one. Nothing else in this
document was re-verified.

Re-verified 2026-09-21 (weekly docs audit #3206, at dev `7f17c9f3`): the
enforcement claims above match the code at this head: `npm run lint:copy` /
`lint:copy:update` in the root `package.json`, the scan set (`src/app`,
`src/components`, plus the explicit `SCAN_FILES` allowlist for prose-holding
`lib/` files), the cannot-add ratchet in `scripts/lib/ratchet.mjs` (#2728), and
the baseline file (currently one entry: `page.tsx` "policy engine"). The
biggest intervening commit (#3167, per-user labels) followed exactly this
procedure: its shared label copy lives in `lib/label-copy.ts` and is named in
`SCAN_FILES`.
```

## `docs/product/design-review.md`

<!-- sha256: a18e00d56d222dd68c3aa937aa0f3b1b5670595de518a05b39f201b86dbb1d3a -->
```markdown
Re-verified 2026-09-30 (weekly docs audit #3413, at dev `5b5bd059`). No claim
needed rewriting; every covered file still exists (all six named modals/cards,
`TransactionActivityRow` in `components/haven/`, `TransactionsTable` in
`components/transactions/`). Re-checked against the code: `RetiredRailNotice`
is still absent from the frontend; `.v2-tabular` and the
`prefers-reduced-motion: no-preference` gate are in `globals.css`; the `Card`
primitive implements exactly the three elevations the checklist describes
(`flat`/`raised`/`anchor`, with `anchor` still absent from the static
design-system table as noted); `Tooltip` still carries the #2038 hover-only
nesting rule; the shared `Table` emits `aria-sort` and the transactions table
sorts amount on the raw `value` field, not the display string; the
`delegator_hybrid` filtering lives in `useAgentPanelState` and the account/agent
hooks as described. The intervening UI drift (#3442 token-label wrap, #3437
releases wrap, #3482 faucet/onramp, #3408 receive side, #3198 agent labels,
#3205 chart callouts, #3087 marketplace) changed screens the checklist reviews
without changing any review criterion, primitive name, or process step here. (`TransactionsTable` was deleted after this re-verification, with #4266.)

Re-verified 2026-10-24 (#4372 part C, at dev `795c50fc7`), end to end. Changed:
the regulatory trigger says "account or signer setup", as `AGENTS.md` does;
`design-system.md` § 3 now lists all three `Card` elevations, so the note that
the static table lacked `anchor` is gone; `Design visual regression` is a
required check on `main` and advisory on `dev` (the branch rulesets), not
blocking everywhere, and compares `/design-system` through scoped captures
only (#2635); and, from review round 1, the token values live in
`packages/ui/src/tokens.css` since #3508 (`.v2-tabular` in
`packages/ui/src/type.css` since #3611), new code imports shared primitives from
`@haven_ai/ui`, and `covers:` gains `packages/ui/src/**`. The 2026-09-30 note
above predates #3508 and is left as written. Re-checked without change: the `#patterns` anchor and the
#4109 rule; every ledger and the dashboard preview rendering
`TransactionActivityRow`; the one
permanently-open showcase (`WalletPopover`, pinned by
`showcase-permanently-open-pin.test.ts`); the #2038 Tooltip rule; `aria-sort`
in `Table`; the every-PR `haven-reviewer` rule in `CLAUDE.md` § How shipping
is governed; the environment badge beside the sidebar wordmark and the
`#main-content` skip link.

Re-verified 2026-11-02 (weekly docs audit #4605, at dev `fc8ac1eb6`). Changed:
the loading bullet now names the shared `Spinner` beside `Skeleton` (#4563/
#4568 made it the one busy indicator, and the checklist named only `Skeleton`).
Re-checked without change: the shared primitives' home in `@haven_ai/ui` with
`components/ui` re-export shims; `TransactionActivityRow` in ledger mode under
day bands on `/transactions` and both Activity tabs; `Card`'s three elevations
(`flat`/`raised`/`anchor`); the `#patterns` anchor and the #4109 new-pattern
rule; the one permanently-open showcase (`WalletPopover`'s two states, pinned
by `showcase-permanently-open-pin.test.ts`); the #2038 Tooltip rule;
`aria-sort` in `Table`; the *Design visual regression* job name and its
required-on-`main`/advisory-on-`dev` split; the every-PR `haven-reviewer` rule
in `CLAUDE.md` § How shipping is governed; and the environment badge beside the
sidebar wordmark. The week's UI sweep (#4562–#4603: `ui/Modal` dialog anatomy,
`DialogResult`, `EmptyState`/`InlineAlert` load-error states, the one
`StatusBadge` vocabulary, `RouteLoading` and `Spinner`, the one `CopyButton`
path) changed screens this checklist reviews without changing any criterion,
primitive name or process step here.
```

## `docs/product/design-system.md`

<!-- sha256: e15783bacfccff3ef8b832acd012831f6cd42eacfa570b87369b1dd83c49b29b -->
```markdown
> Re-verified 2026-10-30 for #4562: § Modal (the dialog anatomy — close button
> by default, open-time focus in the body, the field-label style, the width
> mapping) and § Dialog actions (the single-screen footer rule beside the
> multi-screen one). This note covers those passages only.
>
> Re-verified 2026-10-22 for #4237: the navigation bullets (floating tab bar —
> the concentric-capsule indicator, the pill's `p-1` inset, the bar-only
> "Home" label and the relaxed one-active-idiom rule for the bar). This note
> covers those passages only.

> Re-verified 2026-10-19 for #4063: the navigation bullets (floating tab bar —
> the dark pill's own token pair and the re-measured ratios — and active
> idiom). This note covers those passages only.

> Re-verified 2026-10-17 for #4058: § z-index scale (the rule paragraph and the
> nav-tier paragraph), § Safe areas (the phone-navigation paragraph), the
> navigation bullets (floating tab bar, active idiom, More cell, More sheet) and
> § Tap targets' "both states" bullet.
> This note covers those passages only.

> Re-verified 2026-10-17 for #4056: § Tap targets' `SegmentedControl` passage
> (44px hit area, inset brand outline on the selected option). This note covers
> that passage only.

> Re-verified 2026-10-27 for #4496: § Tap targets' `SegmentedControl` passage
> (44px hit area, the 5px overhang past the group's border, the outlined/divided
> look and the selected segment's brand-soft fill + brand ink + semibold with no
> outline), and § *Below `lg`*'s tab-bar bullet, where `SegmentedControl`'s
> selected option is named. This note covers those passages only.

> Re-verified 2026-09-03 for #2468: the investor-briefing route, its tap-target
> borrower, and its marketing exemption were retired; the surviving focus-ring
> census intentionally keeps a one-member anti-vacuity floor. This note covers
> the affected references only; the rest of this document was not re-read.

> Re-verified 2026-10-06 for #3701: § Arrows' expected-output table was retired
> (the shell pipeline's output had drifted from the table pasted beside it) and
> the comment-aware allowlist test is named the check of record instead. This
> note covers § Arrows and the § Icons pointer to it only; the rest of this
> document was not re-read.

Re-verified 2026-09-21 (weekly docs audit #3206, at dev `7f17c9f3`): the
token table was checked mechanically against `globals.css`: all 16 rows match
the light and dark definitions exactly, zero mismatches. The dark-mode
sections (#2927–#2929) already describe the shipped three-part work, and the
theme picker reads "Settings → Theme" with the row rendering `Theme`
(`SettingsClient.tsx`, `t.settings.theme.label`), matching the product README.
Intervening commits that touched covered files (#3147 marketing dark sweep,
#3167 labels + `LabelChip`, #3197 AgentCard wrapper, #3204/#3205 analytics
primitives and `Row.tsx`) changed components inside the documented system; the
doc's token, typography, and gate claims needed no rewrite. `StatTile` and the
`/analytics` work it shipped remain consistent with the § Statistics tile
guidance.

Re-verified 2026-09-30 for #3195 (the round-2 design nits from PR #3176's
review), scope = § Statistics tile's formatting guidance and § Buttons'
distribution paragraph: the dashboard's metric tiles now render their compact
SEK tier in the UI's voice (en-US: `SEK 5.19K`) instead of sv-SE's scale
words (`5,19 tn kr` — "tn" is tusen), scoped so the standard tier keeps the
#3127 currency-locale voice byte-for-byte; the hero's change line writes its
percent half through `Intl` in the currency's locale (`+1,00 %` under
sv-SE/de-DE, byte-identical `+1.00%` under en-US), so the line stops mixing
a decimal comma with a hand-rolled English percent scaffold; and the
per-currency locale rule lives once in `lib/format.ts` (`currencyLocale`),
with the dashboard wrappers and `lib/analytics-format.ts` delegating to it
instead of carrying a third copy of the ternary. The three items are fixes
the round-2 review had pinned; the rest of this document was NOT re-read.
```

## `docs/product/README.md`

<!-- sha256: fadfc3c13e417045f694a839ed0ebe9b37200b0b83dbfb35978febcd9afaf7fe -->
```markdown
Re-verified 2026-10-24 (#4372 part C, at dev `795c50fc7`), end to end. Changed:
the focused first-run view's money card steps its Receive down to ghost with
Send disabled (#4105 replaced Add funds and Deposit address with Receive,
#4167); "Coming soon" is no longer acceptable on Settings (#4356 owner decision
3, #4358/#4359); the money-movement rule says account funds, not Safe funding.
Re-checked without change: the theme control under Settings → General →
Preferences; "Get started", "N of 3 done", "Hide for now" and "You're set up";
the low-balance and zero-USDC hold-back; the inline "Connect your first agent"
on `/agents`; Analytics second in the Overview group; the raised money panel
with the 30-day spending; `design-system.md` § Cards; `.v2-modal-backdrop` with
no blur; `MaxButton`/`PasteButton`; the `#main-content` skip link; `Button`
`sm` 36px and `md` 40px with a 44px hit area (#1726).

Re-verified 2026-11-02 (weekly docs audit #4605, at dev `fc8ac1eb6`). Changed:
the Loading And Feedback rules now name the shared `Spinner` beside `Skeleton`
(#4563/#4568 made it the one busy indicator, and the section named only
`Skeleton`). Re-checked without change: the theme control under Settings →
General → Preferences; "Get started", "N of 3 done", "Hide for now" and
"You're set up" (`dashboard/NeedsYou.tsx`); the low-balance and zero-USDC
hold-back; the inline "Connect your first agent" on `/agents`; Analytics second
in the Overview group (`sidebar/Sidebar.tsx`); the raised money panel with the
30-day spending; `design-system.md` § Cards; `.v2-modal-backdrop` with no blur;
`MaxButton`/`PasteButton`; the `#main-content` skip link; `Button` `sm` 36px
and `md` 40px with a 44px hit area (#1726); `TransactionActivityRow` in ledger
mode under day bands; and `PageHeader`'s `back` prop with `BackLink` for the
branches that have no `PageHeader`. The week's UI sweep (#4562–#4603) changed
screens this guide governs without changing any rule, primitive name or
process step here.
```

## `docs/product/screen-recipes.md`

<!-- sha256: 92cb305e1a1df256624a2fbf09faec504f3bbe5725b10fa10384e5bc2308a606 -->
```markdown
Re-verified 2026-11-02 (weekly docs audit #4605, at dev `fc8ac1eb6`). Changed:
the Transaction History ledger row now states the phone layout — below `sm` it
is two bands, title and amount then description and clock time (#4572), where
the recipe described only the desktop arrangement. Re-checked without change:
the agent card's one `StatusBadge` and its `agentBadge` labels ("Needs setup",
"Budget ended", "Paused", "N% used" at 90% or more, plus "Archived" and
"Revoked"); the one Set budget dialog and its `?grant=` prefill (#4564/#4600);
the accounting vocabulary rendered through `StatusBadge` from
`accountingStatusPresentation` (`In <Provider>` / `Evidence archived` /
`Tracked` / `Sending…` / `Not sent`, #4567); the Receive dialog's QR
`Skeleton`; the tool-call tab's `MCP_TOOL_NAMES` labels, `errorCodeLabel` and
`ListShowMore` footer; the connect flow's close affordances (X, backdrop,
Escape) and the step past the line that removes them; and the Settings
Business-tab sections. The week's UI sweep (#4562–#4603) changed screens these
recipes describe without changing any structure, label or rule they state.
```

## `docs/regulatory/casp-changelog/README.md`

<!-- sha256: 5e9e4a0c6fde4c39bb956d8e4b9a0db29058f9890179477576d0f54e2f6077a3 -->
```markdown
Re-verified 2026-10-24 (#4372 part G, at dev `b79b112ec`), end to end:

- **Count and names.** The directory holds 677 shards plus this README:
  `git ls-tree --name-only b79b112ec docs/regulatory/casp-changelog/` prints
  678 lines. The same command at `5b5bd059` prints 508, which is 507 shards
  plus the README, the previous note's count. 39 of the 677
  do not match `YYYY-MM-DD-<issue>.md` or `YYYY-MM-DD-<version>-release.md`
  exactly: they carry a suffix (`-1441b`, `-2769-pending-nonce`), a topic
  slug instead of an issue (`2026-10-07-blockscout-api-key.md`) or the
  pre-#1789 release names. 28 of those were already present at `5b5bd059`, so
  the previous note's "every one still matching" was wrong when written. That
  is consistent with *Nothing validates a shard filename* above:
  `git grep casp-changelog` over `scripts/` and `.github/` finds no name check.
  The newest shard is `2026-10-24-4387.md`; the newest release shard is
  `2026-10-23-0.11.0-alpha.0-release.md`.
- **Shape.** 119 of the 677 shards use nested bullets (81 of October's 161),
  and 78 have no match for `/perimeter (is )?(unchanged|narrow)/i` once
  whitespace is flattened (`\s+` to one space). Without flattening the count
  is 96, because 18 shards carry the verdict across a hard line wrap.
  `2026-10-24-4387.md` matches either way, as a control. The
  *Content* bullet now says so and that nothing checks either.
- **Gate.** The added-match rule (#2192) is `implicatedDocs` in
  `scripts/docs/coupling-gate.mjs`, with `parseNameStatus` counting only `A`
  lines, so a rename does not count. The previous note said #2192 was the last
  behaviour change; #2323 came after it and reports a shard-cleared parent as
  an advisory finding. Editing a parent doc clears it because the gate skips
  any doc the diff touches. `04-x402-payment-sequence.md` carries the same
  `satisfied-by` glob (#1496); the *The gate* bullet named only the CASP doc.
- **Release naming.** `scripts/release-bump.mjs` prints
  `docs/regulatory/casp-changelog/<date>-${newVersion}-release.md` as its next
  step, and every release shard from 0.1.30 on follows that pattern (0.1.29's is
  `2026-08-22-1783-release.md`, the guess the *Filename, release PRs* bullet
  describes).
- **Weekly audit.** #1248 is a closed instance of the weekly audit issue.
  `docs-audit.yml` (cron `0 6 * * 1`) upserts one open tracking issue, now
  #3645.
- **Exemption.** `validate-frontmatter.mjs:236` exempts every file here but
  this README.

Re-verified 2026-11-02 (weekly docs audit #4605, at dev `fc8ac1eb6`). Changed:
the live *The parent doc* bullet named #3645 as the tracking issue, but #3645
was closed on 2026-10-25 and `docs-audit.yml`'s upsert opened #4605 in its
place, so the bullet now names #4605. Re-checked without change: the filename
conventions and the release-shard rule; the `satisfied-by` globs on both
`casp-risk-guardrails.md` and `04-x402-payment-sequence.md`; the added-match
rule (#2192) in `scripts/docs/coupling-gate.mjs`; the advisory
"coupling satisfied, body NOT re-read" finding (#2323); the immutability
rules and the transcription-defect exception; `release-bump.mjs`'s
`<date>-<version>-release.md` next step; and the front-matter exemption at
`validate-frontmatter.mjs:236`. The directory now holds 713 shards plus this
README (714 files), up from the 677 the 2026-10-24 note measured; the newest
shard is `2026-11-02-4601.md`.
```

## `docs/regulatory/casp-risk-guardrails.md`

<!-- sha256: b71671d26cb548b301a045b08070ede1c14dc5fadc969989288b9d70d1517842 -->
```markdown
> **Re-verified unchanged (#4265, 2026-10-22, published CLI boundary):** the
> covered CLI commands and regression fixture send no own-transfer-folding flag
> and keep both transaction legs plus the existing local CSV behavior. No
> covered payment, signing, key, custody, advice, settlement or
> merchant-acquiring surface changes. Scope: §7's factual-history preference
> and the non-custody boundary for the published CLI only;
> the document-wide `last-verified` date is not re-stamped.
>
> **Re-verified #4350 (2026-10-23, the budget end date):** the diff touches
> covered SDK/CLI files only in their agent-facing PROSE — the runbook's
> "What Haven is" paragraph (`packages/sdk/src/agent-guidance.ts`, its CLI
> copy and the served skill files) now says the budget ends on a date the
> user chose (30, 90, 180 or 365 days) and that renewal is a new approval.
> That CLOSES the § *Make All Agent Authority User-Approved* ":725" gap for
> expiry disclosure on the dashboard surfaces, and it is authority-NARROWING
> only: the owner-facing presets keep an expiry mandatory (no "never"
> option), the on-chain `Timestamp` caveat is unchanged, and #4351 adds the
> server-side 365-day cap. No covered payment, signing, key, custody,
> advice, settlement or merchant-acquiring surface changes; Haven still
> signs nothing. Scope: the guidance text only; the document-wide
> `last-verified` date is not re-stamped.

> **Re-verified unchanged (#4408, 2026-10-25, migration comment truthing):**
> the diff touches one covered file — `db/migrations/066_catalog_submissions.ts`
> — in its doc comment only: the status-progression block now says `delisted`
> is set by operator SQL and that no lifecycle path sets it (verified by
> sweep on `dev`), replacing the stale "operator action, or lifecycle expiry"
> wording. No covered payment, signing, key, custody, advice, settlement or
> merchant-acquiring surface changes; the migration's DDL is untouched.
> Scope: the migration comment only; the document-wide `last-verified` date
> is not re-stamped.

> **Re-verified unchanged (#4534, 2026-10-29, the purchase correlation key):**
> the diff touches four covered areas — `modules/mpp/**` (a new
> `purchase-group.ts` derivation module plus two OPTIONAL inputs on the
> evidence report), `infra/repositories/machine-payments.ts` (three new
> evidence-row SQL helpers), `modules/accounting/**` (the entry, feed payload
> and receipt underlag carry two more fields) and `db/migrations/**`
> (migration 123 adds two NULLABLE columns to `machine_payment_evidence`).
> None of them is a payment, signing, key, custody, advice, settlement or
> merchant-acquiring surface. The two fields are DESCRIPTIVE metadata on a
> document the accounting feed already produces: `purchase_group_id` is the
> merchant's own invoice/order id (or an agent-supplied group key) and
> `parent_payment_id` is the purchase payment a fee call paid for. They
> authorize nothing, gate nothing, change no amount, and are written
> first-write-wins on the evidence row only — `payment_intents`, settlement
> and custody are untouched. An ungrouped payment is fed exactly as before
> with both fields null, so nothing is withheld because its group could not
> be resolved, and no historical row is backfilled. Haven still signs nothing
> and holds no key material. Scope: those four areas; the document-wide
> `last-verified` date is not re-stamped.

> **Re-verified unchanged (#4569, 2026-10-31, empty and load-error states):**
> the diff touches one covered area — `packages/frontend/src/app/(authenticated)/accounting/**`
> — in the Accounting page's PRESENTATION only: its first-load and failed-refetch
> branches now render the shared load-error shape (`EmptyState`, title, a
> "what is still true" body, and a Try again wired to the hook's own `refetch`)
> instead of a raw red line with no action. No covered payment, signing, key,
> custody, advice, settlement or merchant-acquiring surface changes: the page
> still reads `GET /accounting/feed/status` and posts nothing new, the sync and
> verify controls are untouched, and the accounting guardrail's disclaimer line
> is unchanged. Haven still signs nothing and holds no key material. Scope: the
> Accounting page's error branches; the document-wide `last-verified` date is
> not re-stamped.

> **Re-verified 2026-11-02 (weekly docs audit #4605, at dev `fc8ac1eb6`):** a
> targeted pass over the week's drift, not a second full re-read — the scope is
> stated in § *Scope of the current `last-verified`* below, which this pass
> rewrote. No obligation, red line or invariant changed. Two factual
> corrections: the money-path floor is now **52 of the 71** globs (54 runtime
> minus the two `EXEMPT` entries, none of the 17 `controlGlobs`; #4381 added
> the two `domain/x402-*` files), where the text still carried the 50-of-67
> measurement from #4303; and `SUPPORTED_X402_EXPECTED_VERSIONS` is defined in
> `signer/src/core.ts` and consumed by `capabilities.ts` and `tools.ts`,
> so the scope note now names the definition. The week's
> behaviour changes (#4465, #4483, #4516, #4558, #4536, #4535, #4544, #4546,
> #4583, #4587, #4369) are narrowings or descriptive additions, each
> shard-covered or recorded in the note above.

>
> The one caveat this section carried — recorded by the #2244 re-verification
> and now **closed** ([#2245](https://github.com/d-hinders/Haven-AI/issues/2245)):
> on `POST /x402/authorize` a caller-supplied `settlementScheme: 'erc7710'` or
> `facilitatorAddresses` used to be validated *above* the rail resolution, so a
> retired-rail account setting that field got a 400 — whose body asserted that
> the retired rail "settles via EIP-3009 only" — instead of the 410 tombstone.
> The spend decision was never affected (both answers were refusals, both
> fail-closed with nothing read on-chain and nothing written), which is why the
> sentence above was true throughout; what was affected was what the account
> was TOLD. #2245 deleted those two rail-dependent guards
> (`validateGenericSchemeRail`) rather than rewording them: both tested
> `agent.execution_rail !== 'delegation'`, the same field `resolveExecutionRail`
> reads, so the seam already refused every input they refused. The seam is once
> again the only thing that decides whether a retired-rail account may spend AND
> the only thing that makes a rail-specific claim to it, on this route as on the
> others. Note the second half is narrower than "the only thing that answers it",
> deliberately: refusals that are not rail claims still precede the seam, and a
> sentence that swallowed them would be false. What still precedes the 410 there
> is rail-INDEPENDENT and makes no claim about any rail. **Since #3031 most of
> it is the request SCHEMA, not the route**: required fields, address and
> network shape and the `settlementScheme` enum are refused by the
> request-validation plugin at `preValidation`, and the route keeps only the
> rules JSON Schema cannot state (a non-zero amount, the network/chain
> agreement, the 64 KB `paymentRequired` bound). The position is unchanged —
> ahead of the seam, the same place `POST /payments` puts its own gate, the
> same class as the 401 auth hook — and so is the property: the refusal names
> a FIELD, never a rail. One consequence is recorded rather than glossed: a
> request that is BOTH malformed and on a retired rail now meets the 400
> before the 410. Pinned by
> `routes/__tests__/allowance-rail-retired.test.ts` → "a caller-supplied
> settlementScheme cannot divert the tombstone (#2245)", whose assertions
> moved to the plugin's envelope in that slice.
>
> **Token resolution no longer belongs in that list**
> ([#2274](https://github.com/d-hinders/Haven-AI/issues/2274)). This sentence
> named it as still preceding the 410, and it did, on both routes: a retired-rail
> account naming an unsupported asset received a 400 carrying `supported: [...]`
> — the assets it can pay with — before being told the rail is gone and it can
> pay with none of them. Rail-INDEPENDENT, so the sentence above was true as
> written and the spend decision was again never affected (both answers refusals,
> nothing read on-chain, nothing written); what was affected was again what the
> account was TOLD. #2274 moved the rail gate ABOVE token and amount resolution
> on `POST /x402/authorize` and `POST /payments` **together** — one route alone
> would recreate the asymmetry #2245 removed. Pinned by the same file →
> "the 410 precedes TOKEN RESOLUTION too (#2274)", with positive controls proving
> a delegation-rail account still receives its 400 *with* the supported list, and
> a structural-precedence assertion proving the tombstone did not become the
> route's error handler. Full analysis:
> `docs/regulatory/casp-changelog/2026-08-31-2274.md`.
>
> Since #1986 (epic #1440) that covers BOTH retired rails — the session rail
> (#834) and the legacy Safe AllowanceModule rail — so the delegation rail is
> the only rail that can spend. The #1121 queued-approval carve-out is
> history: #1986 closed the approval queue's approvable path (the only rail
> that ever fed the queue was being retired, so leaving it approvable would
> have left Haven manufacturing executable payment transactions for a rail it
> had declared gone), and #2055 dropped the `approval_requests` table itself
> under the recorded #2021 owner decision.
> Since #1130 a valid key on a `pending_approval` agent gets a NAMED
> `403 agent_pending_approval` with the required action on normal agent API
> requests, instead of the false `401 Invalid or revoked API key` — the
> authentication gate stays a positive allow-list (revoked and unknown statuses
> still 401). The exact sweep-recovery routes are a narrow exception for
> recovering stranded delegate balances; they grant no spending authority.
> Since #988 the agents/smart-accounts data access lives in
> `infra/repositories/` with tenant scoping as REQUIRED function parameters —
> the `WHERE user_id = $1` authorization that used to hide in inline route
> SQL is now a signature the type checker enforces; the SQL itself moved
> verbatim and is PREPARE-checked against the real schema in CI.
> #1167 extended the same treatment to the user, dashboard and agent-activity
> surfaces. Two of those had NO tenant column to make required: the
> agent-activity reads filter by `agent_id`, so the authorization is the
> caller's prior ownership check rather than a parameter — stated as an
> explicit contract in the repository's header and on each function, and
> unchanged from what the inline SQL did.

**Re-verified against `fc8ac1eb6`** (from the staleness audit #4605; the
replaced 2026-10-25 pass read `615686369` as a targeted pass over that week's
drift, and the 2026-10-23 pass before it read `ffca80f36` end to end, #4303).
This was a targeted pass over the week's drift, not a second full re-read: 34
covered commits since 10-25, all narrowing, additive or doc-fix in kind.

- **Every named file, symbol and test was re-checked to exist at this head:**
  `requireDelegationBound` (`modules/x402/settlement-sweeper.ts`),
  `assertNonAsserting` (`modules/accounting/fortnox-connector.ts`),
  `resolveExecutionRail`, `SUPPORTED_X402_EXPECTED_VERSIONS`
  (`signer/src/core.ts`, consumed by `capabilities.ts` and `tools.ts`),
  `legacyBookkeepingEnabled` and
  `HAVEN_HOSTED_MCP_URL` (`config.ts`), `modules/passport/issuance.ts`,
  `routes/__tests__/allowance-rail-retired.test.ts`, both
  `non-custody-onchain-*.contract.test.ts` suites, and the census pin.
- **Measured claims were re-measured:** `node --test
  scripts/ci/money-path.test.mjs` — 24/24 pass, the pin holds at the current
  globs, and the floor is now **52 of the 71** (54 runtime globs minus the two
  `EXEMPT` entries, none of the 17 `controlGlobs`; #4381 added the two
  `domain/x402-*` files). The previous "50 of 67" was measured at #4303.
- **The fail-closed sweep attribution is intact after #4075** (proof-header
  settlement reports, AuthorizationUsed↔Transfer pairing): the observation
  path still passes `requireDelegationBound: true`
  (`settlement-sweeper.ts:764`), and the never-from-transfer-shape property
  is unchanged.
- **The week's behaviour changes are narrowings or descriptive additions, each
  shard-covered:** #4376's `delegation_expired` refusal (an expired-only
  budget answers 403 with the end date, in `modules/budget-scope/`), #4465's
  typed `delegation_expired` body on the x402 expired-budget path, #4483's ten
  typed task-/sub-budget payment-scope refusals (MCP layer), #4516's
  retry-or-stop by failure cause, #4558's recorded merchant rejection reason,
  #4536's settlement-evidence `payment_header` prefill, #4535/#4544/#4546's
  accounting transaction kind, purchase correlation key and direct-payment
  underlag, #4583/#4587's receipt field renames and six declared served keys,
  and #4369's 365-day `expires_at` cap. None widens authority, custody or the
  merchant-acquiring surface; CASP shards exist for each
  (`2026-10-26-4429.md`, `2026-10-26-4458.md`, `2026-10-27-4468.md`,
  `2026-10-27-4470.md`, `2026-10-29-4530.md`, `2026-10-29-4532.md`,
  `2026-10-29-4533.md`, `2026-10-30-4552.md`, `2026-10-30-4577.md`,
  `2026-10-30-4578.md`, `2026-10-30-4579.md`, `2026-11-02-4601.md`, and the
  `2026-10-30-0.13.0-alpha.0-release.md` release shard), except #4534, which
  used the parent-doc escape hatch and is recorded in the note at the top of
  this file.
- **Deliberately NOT covered by this date, as before:** the inline *Current
  state* notes' dated history (present-tense claims were checked; narratives
  were read, not re-derived), the frozen historical bullet log, the MiCA /
  ESMA / Finansinspektionen / EBA citations (legal claims, no legal review
  here), the #1985 dust-Safe live balances, the #832 exit story's live
  demonstration, and the #3333 counsel position (recorded, not asserted).
```

## `docs/security/delegation-rail-security-model.md`

<!-- sha256: 8e30584e98e3d324b6b42a7776e1956895f05b3de84998fb7ca3d5313960ea2b -->
```markdown
> **Re-verified unchanged (Refs #4560, 2026-11-02, Set budget layout fix):**
> the diff touches one covered file, `packages/frontend/src/components/DelegationBudgetCard.tsx`,
> and only in PRESENTATION. The "No budget yet." line passes `align="start"`
> to `EmptyState`, so it sits on the column's left edge above the Set budget
> button. No grant form, budget row, Stop control, passkey path, delegation,
> caveat, enforcer term, budget pre-check, settlement window, funding leg or
> sweep moves. The Set budget button keeps its ref, its handler and its
> `?grant=` prefill. Scope: that one line. The document-wide `last-verified`
> date is not re-stamped.

> **Re-verified unchanged (#4569, 2026-10-31, empty and load-error states):**
> the diff touches one covered file — `packages/frontend/src/components/DelegationBudgetCard.tsx`
> — in its PRESENTATION only: the "No budget yet." line became the shared
> `EmptyState` one-line form (`size="inline" bare`), and the card's existing
> load-error shape is untouched. No grant form, budget row, Stop control,
> passkey path, delegation, caveat, enforcer term, budget pre-check, settlement
> window, funding leg or sweep moves; the Set budget button keeps its ref and
> its `?grant=` prefill behaviour, and the card still renders nothing that
> grants authority on a retired agent. Scope: that one line; the document-wide
> `last-verified` date is not re-stamped.

> **Re-verified (0.13.0-alpha.0 release, 2026-10-30):** coupled through
> `SIGNER_VERSION` in `packages/signer/src/tools.ts`, which this bump rewrote
> from `0.12.0-alpha.0` to `0.13.0-alpha.0`. **The edit to that file is the
> version literal only** — one line, read in the diff rather than taken from
> the bump's report. No tool schema, signing input, typed-data check,
> recipient pin, allowlist, binding, delegation, caveat, enforcer term, budget
> pre-check, settlement window, funding leg or sweep moves, and
> `packages/signer/src/core.ts` is not in this bump's diff at all.
>
> **Signing-surface changes in the promoted range, already re-verified where
> they merged.** The range `origin/main..origin/dev` carries **three** changes
> to files on this document's cover list:
>
> - **#4448** (`#4529`), `packages/backend/src/infra/repositories/agents.ts` —
>   `UNARCHIVE_AGENT_SQL` clears only `archived_at` and recolours an agent only
>   when its stored tint is now held by another non-archived agent. Presentation
>   data; its own note is at line 4243.
> - **#4534** (`#4544`), `packages/sdk/src/client.ts` — the purchase correlation
>   key, whose own note is at the end of this document (2026-10-29). It
>   authorizes nothing, produces or consumes no signature, and no spend decision
>   reads its value.
> - **the release bump**, `packages/signer/src/tools.ts` — the `SIGNER_VERSION`
>   literal, one line, no signing surface.
>
> The release's other change, **#4530**'s
> `PaymentStatusResult.merchantSettlementTxHash`, is a read-only status field
> on a type this document does not cover; it touches no signing path.
>
> The shipped delta, re-measured at the door (`origin/dev` `745d4ebf`), is 16
> files, +162/−20, over 14 commits — ten of them the bump's own version
> literals. `@haven_ai/signer` publishes a version literal over otherwise
> byte-identical contents; its two test files in range are #4550's low-s
> wire-byte assertions, which pin a property the bridge already had.
> `last-verified` is re-stamped to 2026-10-30 for this note.

> **Re-verified #4492 (2026-10-27, the shared select primitive draws its own chevron).**
> The covered file this diff touches is one, `components/DelegationSendModal.tsx`,
> and the change is presentation-only: its raw `<select>` for the token symbol
> becomes the shared select primitive, so the field gains the family's
> `py-2`/focus ring and a lucide `ChevronDown` inside the right edge, and its
> border moves from `--v2-border-strong` to the family's `--v2-border`. The
> wrapper is pinned `w-28 shrink-0` so the amount `Input` beside it keeps the
> row's layout. Nothing else in the file moves: `tokenSymbol` is still the same
> `useState`, the same `tokens` list from `getChainTokens(chainId)` feeds the
> same `<option>`s, and `send()` still reads the same symbol to pick the token
> address and decimals. No handler, fetch, signer call, key read, caveat value,
> allowance, budget pre-check or settlement path changes, and no user-visible
> claim about who signs, what may be spent, or when revocation bites changes —
> a border token and a decorative, `aria-hidden`, `pointer-events-none` glyph
> are not a semantics change. The rest of the diff (the select primitive itself,
> its new test, the `/design-system` specimen copy and `docs/product/design-system.md`)
> is outside this document's coverage. Scope of this note: the modal diff above.
> Nothing else in this document was re-verified for it, and `last-verified` is
> bumped to 2026-10-27 for exactly this coverage.

> **Re-verified #4425 (2026-10-26, undefined `--v2-*` tokens mapped onto the
> existing ink tiers):** the only covered file this diff touches is
> `packages/frontend/src/components/PasskeyElsewhereHint.tsx`, and only one
> class on its `<p>`: `text-[var(--v2-ink-muted)]` becomes
> `text-[var(--v2-ink-3)]`. `--v2-ink-muted` was never defined anywhere in the
> repo, so the declaration was invalid at computed-value time and the hint
> inherited its ancestor's ink; it now resolves to the tertiary ink the
> `text-xs` caption role uses. No copy, no markup, no handler, no gate, no
> write path and no authority surface changes — the hint still says the same
> thing in the same place, in a colour that resolves. Every other file in the
> diff is outside this document's coverage (frontend colour classes, one ops
> border token, a docs line and a new token guard test). Nothing else in this
> document was re-verified, and `last-verified` is not bumped.

> **Re-verified #4415 (2026-10-25, stale comment sweep):** the only covered
> file this diff touches is `packages/sdk/src/redemption-guard.ts` — the
> `assertRedeemsOwnBudgetDelegation` JSDoc now names the THREE shapes the
> function already enforces (single grant, #3329 two-link task-budget chain,
> #3330 three-link sub-budget chain), matching the `refuse()` error text and
> the 1/2/3-link checks verbatim. No check, refusal string, ABI constant or
> control-flow change: what the signer accepts and refuses is byte-identical.
> Every other file in the diff is outside this document's coverage. Nothing
> else in this document was re-verified, and `last-verified` is not bumped.

> **Re-verified, #4411 follow-up (2026-10-25, the comment stripper leaves the
> `@haven_ai/core` barrel):** the only covered file this diff touches is
> `packages/ops/src/__tests__/card-inset-guard.test.ts`, and only its import
> line: it now takes `stripComments` from the `@haven_ai/core/comment-stripper`
> subpath instead of the barrel. The stripper imports `typescript`, and
> mcp-server's build inlines `@haven_ai/core`, so the barrel re-export had put
> the TypeScript compiler into the hosted MCP bundle, which then crashed at
> boot on dev. The guard's
> assertions and the sources it scans are unchanged. It adds no signing step,
> no gate, no write path and no authority surface. Nothing else in this
> document was re-verified, and `last-verified` is not bumped.
>
> **Re-verified #4411 (2026-10-25, source-scan guard tests strip comments with
> the parser):** the only covered file this diff touches is
> `packages/ops/src/__tests__/card-inset-guard.test.ts` (under
> `packages/ops/**`) — a guard test that reads ops sources as text. It replaces
> its hand-rolled two-regex comment stripper with the shared
> `@haven_ai/core` `stripComments` (passing each file's name so `.tsx` sources
> keep their JSX verbatim); the assertions and the sources they scan keep their
> meaning. It adds no signing step, no gate, no write path and no authority
> surface. Every other file in the diff is outside this document's coverage
> (backend/frontend guard tests, a new test-only core helper and its
> re-export). Nothing else in this document was re-verified, and
> `last-verified` is not bumped.

> **Re-verified #4352 (2026-10-23, an expired-only budget is refused as
> `delegation_expired` with the end date):** the covered files that change —
> `infra/repositories/delegation-budgets.ts` (one narrow read-only query
> that can see an EXPIRED row, consulted only on already-refusing paths),
> `modules/mpp/budget-precheck.ts` and `modules/x402/
> delegation-authorize.ts` (the refusal REASON and PROSE at three existing
> refusal sites) — add no signing step, no gate, no write path and no
> authority surface. The enforcers remain the only spend control: an
> expired redemption still reverts on-chain, and the new prose says so.
> The ledger row is still the #3053 choke point's record (same sources, the
> `delegation_expired` reason's second producer documented in the migration
> 086/119 pair); nothing agent-asserted. A live row for the token keeps
> every selection and compare exactly as before (pinned by a test). Nothing
> else in this document was re-verified, and `last-verified` is re-stamped
> to 2026-10-23 for this note.

> **Re-verified #4458 (2026-10-26, the expired refusal's BODY becomes typed on
> both x402 legs and the hosted quote stops on it):** three covered files
> change, and none of them moves a gate, a signing step, a write path or an
> authority surface. `modules/x402/delegation-authorize.ts` — the two
> expired-only 403s now answer the shared typed body (`error_code`,
> `phase`, `next_action`, `budget_ended_at`, the atomic figures, `rail`,
> `network`, `resource_url`, `merchant_address`) instead of a one-line
> `{ error }`; the DECISION is byte-for-byte the same (403, one
> `payment_refusals` row through the #3053 choke point, nothing created or
> signed), and on the EIP-3009 funding leg `merchant_address` is
> `merchantPayTo`, never `payTo` — the funding EOA is still never recorded as
> the merchant, which is the account confusion the 086 allowlist exists to
> prevent. `packages/mcp-server/src/tools/support/quote-response.ts` — the
> quote-time budget reader now recognises that typed 403 and reports
> `sufficient: false` instead of degrading to "unavailable"; that NARROWS
> what an agent may proceed with (it used to fail open and let authorize
> refuse), and the on-chain enforcers remain the only spend control.
> `packages/sdk/src/client.ts` — a JSDoc paragraph on `precheckBudget` naming
> the second refusal shape; no code. Nothing agent-asserted is trusted: the
> end date and the reason come from the server's own read, and the ledger row
> is unchanged. Nothing else in this document was re-verified, and
> `last-verified` already reads 2026-10-26.

> **Re-verified #4327 (2026-10-23, the CSV export's response plumbing
> moves into `domain/csv.ts`):** this diff touches one file in this
> document's coverage list, `routes/transactions.ts`, and adds no signing
> step, no gate, no write and no authority surface. The export's row cap,
> 413 body, headers, BOM and filename move into a shared helper; the route's
> reads, its ownership checks (`accountId` against the caller's accounts,
> `agentId` through `agentExistsForUser`) and its filters are untouched, and
> its 413 body and success headers are pinned byte-for-byte by a test
> written before the move. The new agent ledger export
> (`GET /agent-activity/{id}/activity/export.csv`, `routes/agent-activity.ts`,
> not on this list) answers 404 unless `agentExistsForUser` confirms the
> agent is the caller's, exactly as the list read beside it does. Nothing
> else in this document was re-verified, and `last-verified` is not bumped.

> **Re-verified unchanged (#4265, 2026-10-22, read-only transaction
> route):** the covered transaction route adds an opt-in projection to its
> aggregate JSON and CSV reads. The route still authenticates the owner and
> reads the same owned-account set; this diff adds no signing step, write, key,
> budget decision, authorization branch or authority surface, so the
> delegation-rail invariants are unchanged. Scope: the transaction-history
> ownership and authority claims only; `last-verified` already carries today's
> date and is unchanged.

> **Re-verified #4099 (2026-10-19, the owner-send record):** this diff
> touches two files in this document's coverage list,
> `rails/hybrid-transfers.ts` and the submit route that calls it,
> `routes/hybrid-accounts.ts`. The
> owner send's discipline in §6 ("Owner send (#1083) rides the same op
> discipline") is unchanged: the same prepare/submit split, the submitted
> UserOperation still pinned to the re-derived transfer calldata, the owner
> still the only signer. `submitTransfer` now also RETURNS the UserOp hash
> and the transfer it already validated; the route then writes one
> attribution row to `owner_transfers` (migration 116) after the receipt
> confirmed the transfer, fail-soft — a failed write is logged and the send
> still answers success, and a slow one cannot hold the reply past
> `OWNER_TRANSFER_RECORD_DEADLINE_MS` (500 ms). Nothing on any spend, signing or revocation path
> reads that row; it only lets the transaction feed say "You" instead of
> "Unknown". A characterization test, which passes against the pre-change
> route as well, pins that `submitCall` receives the signed operation
> unchanged and the signature verbatim
> (`routes/__tests__/hybrid-signers.test.ts`). Invariants 1–13 are
> untouched. Scope of this note: the owner-send paragraph of §6 and these
> two files' changes; nothing else in this document was re-read for it.
> `last-verified` already reads 2026-10-19 and is left as is. The
> verification entry is `docs/regulatory/casp-changelog/2026-10-19-4099.md`.

> **Re-verified #4021 (2026-10-19, the account card's "Last payment" field):**
> this diff touches one file in this document's coverage list,
> `infra/repositories/dashboard.ts`, and adds no signing step, no gate, no
> route and no authority surface. What changed is one additive READ beside
> the file's reads — `findLastOutgoingIntentAt`, a `MAX(confirmed_at)` over
> confirmed payment intents joined to ONE account via `agents.account_id`,
> the caller's own account id from the route's existing ownership check —
> consumed by a new presentation module that answers "when did this account
> last send anything" for the `/accounts` card footer. No write, no new
> column, no scope widening; the chain leg re-shapes rows the transactions
> feed already served, and the wire field is an ISO timestamp on the
> portfolio read the route already served. Invariants 1–13 are untouched:
> the file gains a read, not a key, a signer or a spend path. Scope of this
> note: the `dashboard.ts` paragraphs of §6 and §8 and the additive-read
> claims above; nothing else in this document was re-read for it, and
> `last-verified` is bumped to 2026-10-19 for exactly this scope. The
> verification entry for the two `satisfied-by` contract docs this change
> also touches is `docs/regulatory/casp-changelog/2026-10-19-4021.md`.

> **Re-verified #4095 (2026-10-19, the transactions feed and export gain
> FilterBar query parameters):** this diff touches one file in this
> document's coverage list, `routes/transactions.ts` (plus the transactions
> module beside it), and adds no signing step, no gate, no write and no
> authority surface. What changed is additive READ-only narrowing: `GET
> /transactions` and `GET /transactions/export.csv` accept optional
> `direction`, `chainId`, `search`, `period`, `from`, `to` and `tz` query
> parameters, applied server-side BEFORE paging — the browser previously
> filtered direction and network in memory over the loaded page only, so the
> on-screen list and the exported file could disagree. Every read behind both
> routes keeps its ownership scope: the account, contact and receipt-name
> reads the new search resolution adds are the same `listBasicAccountsForUser`
> / `listContactsForUser` / `listReceiptMerchantNamesForUser` user-scoped
> queries the routes already used for name resolution, and a malformed or
> mutually-exclusive filter pair is refused with a structured 400 rather than
> ignored — an ignored filter would widen what the route reads, which is the
> failure direction this document's coverage of the file exists to catch. An
> absent parameter is no filter, so the CLI's calls are unchanged. Scope of
> this note: the routes' filter handling and the ownership claims above;
> nothing else in this document was re-read for it, and `last-verified` is
> not re-stamped (it already reads 2026-10-19): this block is the scope.

> **Re-verified #3930 (2026-10-14, a lost activate response re-reads before it
> reports):** this diff touches one file in this document's coverage list,
> `hooks/useDelegationBudget.ts`, and adds no signing step, no gate, no route
> and no authority surface. What changed is reporting after a lost activate
> response: when the activation POST throws, both `grant` and `editBudget`
> re-read the outcome from the plain, read-only `GET /agents/:id/delegations`
> (deliberately NOT `?include=remaining` — the path adds no chain RPC on the
> client) before saying anything: `active`/`replaced` → the grant landed, and
> `editBudget` runs its Stop step exactly as if the POST had returned;
> `revoked` (a revoke-all won the race) → the honest `failed`; `pending`, an
> absent row, or a failed re-read → a new `unconfirmed` outcome that never
> claims "nothing was granted", because the commit may have landed after a
> proxy 5xx. A per-`(token, recipient)`-slot remembered hash makes the NEXT
> attempt for that slot re-read the remembered hash BEFORE any `/build`, so a
> retry never acts on the stale belief that nothing happened; the remembered
> state is agent-scoped and cleared when the served agent changes. Every
> authority claim stands: the only signatures remain the owner's own
> client-side ones (the delegation and the revoke UserOp); `pickSigningPath`,
> `useActiveSigner` and every signing step are untouched. The
> activate-then-revoke ordering of the #3166 note stands, and a revoke-all
> that raced the activation is now re-read like any other lost response —
> `failed` when the row shows `revoked`, the Stop step when it shows
> `active`/`replaced` — instead of being folded into a blanket "nothing was
> granted". Invariants 1–13 are untouched: the hook gains a read, not a key,
> a signer or a spend path. Scope of this note: `useDelegationBudget.ts` and
> the #3166/#3093 claims above that rest on it; nothing else in this document
> was re-read for it, and `last-verified` is bumped to 2026-10-14 for exactly
> this coverage.

> **Re-verified #2929 (dark-mode epic #2925, slice 3/3):** the dark-token sweep
> touched two files in this document's coverage list, `DelegationSendModal.tsx`
> and `WalletButton.tsx`. Both edits are presentation-only, verified against the
> diff at the base of this branch: the token-symbol input's and the modal
> container's literal `bg-white` became `bg-[var(--v2-bg)]`, the avatar rim's
> `border-white/70` moved to the fixed-paint `.v2-avatar-chrome` utility, and the
> QR container's white box became the never-invert `.v2-light-surface`. No class
> that carries a value a custody or authority statement rests on (the badge
> tones, the `disabled` states) changed. No handler, fetch, signer call, key
> read, caveat value, or user-visible claim about who signs, what may be spent,
> or when revocation bites changed. A CSS token rename in a delegation-surface
> file is not a semantics change: this paragraph is that re-verification record.

> **Re-verified #3812 (in-flow wallet connect):** this change touched three
> files in this document's coverage list. `AccountSignersCard.tsx` and
> `DelegationSendModal.tsx` are presentation-only: each now renders a "Connect
> wallet" / "Switch wallet" control beside the owner-wallet blocker it already
> showed. `useAgentRekey.ts` gains a read-only `signersState`
> (`loading`/`loaded`/`error`), so a connect offer can tell a pending signer
> read from a failed one; `signingBlockedReason` and every signing step are
> unchanged. Elsewhere the change only adds restrictions: "Sign new budget" and
> the off-ramp "Sign transfer" are disabled while no one on this device can
> sign. (`WalletButton.tsx`, whose
> disconnect-then-reopen-the-picker logic moved unchanged into a shared
> `useSwitchWallet` hook, is not in the coverage list.) Nothing that decides
> who may sign changed: `useActiveSigner`, `pickSigningPath`,
> `useAccountOperationGate` and every `ready` predicate are untouched. The
> control renders only where the caller is already not ready, and connecting
> a wallet that is not the set's named owner still leaves the account blocked
> (#2068). The statements in §6 about the header pill and the `wrong_wallet`
> caption stand. `last-verified` is not re-stamped: this note is the scope,
> and nothing else in this document was re-verified.

> **Re-verified #4377 (2026-10-23, #4372 part B).** Scope of this note:
> the "Where the signed delegation lives" paragraph below, the leak table's
> "Delegate key alone" row, and §1 item 2. They said the agent "receives it
> through the existing credential channel", that a delegate key alone gets
> "no delegation", and that a delegation is "a signed message the agent
> holds" whose exfiltration is "sufficient to spend" with the key. None holds.
> The connector's credential files hold no delegation (see
> `docs/architecture/02-identity-and-custody.md`); Haven stores it
> (`agent_delegations.delegation_json`) and every redemption carries the
> owner-signed chain in its `DelegationManager.redeemDelegations` calldata, on
> every rail: the UserOp Haven prepares for a direct payment and for the
> EIP-3009 funding leg (`rails/delegation-rail.ts` `prepareRedemption` →
> `buildRedemptionCall`), and the merchant's or facilitator's redemption on
> erc7710, whose `payment_header` carries the encoded `[settlement child, …,
> budget]` chain (`modules/x402/x402-delegation.ts`
> `assembleSettlementPayload`, called from `modules/x402/settle.ts`). The
> delegation is therefore not secret: the agent's signer sees it in the
> typed data it fetches, the bundler sees it on submission, an erc7710
> merchant or facilitator sees it in the header, and a mined redemption
> leaves it in public transaction calldata. Its delegate is the agent's
> delegate account (`rails/delegation-policy.ts`, `to:
> policy.delegateAccountAddress`), which the delegate key controls, so once
> the agent has paid under a budget the key alone reaches the "Both" row's
> bound. That bound — the caveat stack — is unchanged. This matches the
> 2026-10-07 owner decision behind the dashboard's pause copy (#3717;
> `agent-pause-copy.ts`: a raw-key holder "can still redeem within the budget
> OUTSIDE Haven"), which assumed the key holder has the delegation; this
> note adds that the delegation is obtainable. `last-verified` is not
> re-stamped: nothing else in this document was re-verified for this note.

> **Re-verified (#3450, 2026-09-28):** #3439's own re-check did not by itself
> stop two CONCURRENT issue calls on one (not abandoned) re-key from both
> inserting — the stage stays `metered` until one of them reaches
> `markIssued`, so a second call whose `nextDelegationVersion` read landed
> after the first call's own insert but before that first call's
> `markIssued` still passed the same re-check and landed a genuine duplicate
> `pending` row — per the #3450 spec review's uncommitted scratch test (40
> staggered trials per tree, 0–19ms stagger), dev 23/40 and #3439's head
> 11/40; reproduced deterministically (not statistically) in the shipped
> suite by `agent-rekey-issue-concurrent.test.ts`, which pins the exact
> interleaving with a control point rather than relying on timing luck. The
> issue route now runs its whole piece-build loop plus
> `markIssued` inside ONE transaction
> (`withRekeyIssueTransaction`/`withTransaction`), so the first call's insert
> takes the `agents` row lock and holds it — together with every lock and
> row this re-key's own pieces take — until that call's `markIssued` commits.
> A second call blocks on that same lock and, once released, re-runs
> #3439's `stage = 'metered'` re-check as a fresh READ COMMITTED statement
> against the now-committed `issued` row, so it inserts nothing. The re-check
> itself is unchanged; only the transaction it now runs inside is new. No
> authority moves and no new network call runs inside the transaction — the
> one RPC this route makes (`computeHybridAccountAddress`) still runs before
> the loop opens. The rest of this document was not re-read for it, and
> `last-verified` is not bumped.

> **Re-verified #3769 (2026-10-08):** #3769 adds an `http_method`
> correction column to the catalog verifier's success UPDATE — the same
> statement that records `merchant_catalog.pay_to`. The payTo contract above
> is unchanged: `pay_to` is still written AS SEEN from the challenge (never
> COALESCEd), still collected only across `accepts[]` options on the recorded
> network, still refused when the options disagree, and the advertised-method
> correction never applies to an MCP row (an `http`-protocol guard). A row's
> `http_method` says how the verifier PROBES the resource; it feeds no budget
> pin, no caveat, and no authority path. Scope of this re-read: this section
> (Merchant-locked budgets) and the `merchant-catalog.ts`/`merchants.ts`
> coverage it names; the rest of the document was not re-read for it, and
> `last-verified` stays 2026-10-08.

> **Re-verified #3980 (2026-10-15):** #3980 touches `merchants.ts` (a USDC
> lowest-price aggregate over the counted offers) without touching the payTo
> path: `pay_to` is still written as seen from the challenge and never
> COALESCEd, and the new price column feeds no budget pin, no caveat, and no
> authority path — it is a display field on the listing reads only. Scope of
> this re-read: the Merchant-locked budgets section above and the
> `merchant-catalog.ts`/`merchants.ts` coverage it names; the rest of the
> document was not re-read for it.

> **Re-verified #4408 (2026-10-25):** #4408 touches `merchants.ts` comment
> text only — the offer-aggregates doc block now cites `agentsThatCanPay`
> (the #4004 client-side replacement for the deleted `withinBudget`) where it
> named a function that no longer exists. The payTo path is untouched:
> `pay_to` is still written as seen from the challenge and never COALESCEd,
> and a comment rename feeds no budget pin, no caveat, and no authority path.
> Scope of this re-read: the Merchant-locked budgets section above and the
> `merchants.ts` coverage it names; the rest of the document was not re-read
> for it, and `last-verified` is bumped to 2026-10-25 for exactly this
> coverage.

> **Re-verified #4245 (2026-10-22):** #4245 adds `merchant_catalog.source`
> (`'operator'` | `'bazaar'`, migration 117) and widens the `CatalogRow` type
> in `merchant-catalog.ts`; in `sdk/src/client.ts` only a doc comment on
> `discoverTools` changed. The payTo contract above is unchanged: the
> merchant-locked budget's pin is still read from `pay_to` across the
> merchant's active, verified offers, and `source` feeds no budget pin, no
> caveat, and no authority path — it is a provenance label on the catalog
> read. A Bazaar row's `pay_to` takes part in its merchant's funding target
> exactly as before #4245 (a disagreeing offer still refuses the budget).
> Scope of this re-read: the Merchant-locked budgets section and the
> `merchant-catalog.ts`/`client.ts` coverage it names; the rest of the
> document was not re-read for it, and `last-verified` is not bumped.

> **Re-verified #4245 follow-up (2026-10-22):** the follow-up only rewords text
> ("curated" dropped): three catalog tool descriptions, the
> `CATALOG_ENTRY_NOT_FOUND` refusal message, the OpenAPI `GET /catalog`
> summary and description, code comments (including the `getCatalogEntry`
> doc comment in `sdk/src/client.ts`) and four docs. No code path, budget pin, caveat or authority changed.
> Scope of this re-read: the text named above and the `client.ts` coverage;
> nothing else in this document was re-read for it.

> **Re-verified #4281 (2026-10-22):** #4281 changes only the transport of the
> catalog probe in `merchant-catalog.ts`: `probeCatalogEntry` and
> `refreshCatalog` now default to `guardedCatalogFetch`, which goes through
> the SSRF guard. What a successful probe writes is unchanged, `pay_to`
> included: it is still written as the challenge names it. A refused probe
> writes no `pay_to`. It counts a miss, exactly like a probe that
> received no 402, so a row that stays unreachable is degraded after the
> existing streak and leaves the merchant's active offers. The payTo
> contract above is unchanged. Scope of this re-read: the Merchant-locked
> budgets section and the `merchant-catalog.ts` coverage it names; the rest
> of the document was not re-read for it.

> **Re-verified #4300 (2026-10-23):** #4300 bounds a `refreshCatalog` run to
> 10 min and takes rows least recently updated first. What a probed row
> writes is unchanged, `pay_to` included. A row the run does not reach is
> not written at all: it keeps its current `pay_to`, status and failure
> streak until a later run reaches it, which takes the least recently
> updated rows first. A merchant's verified payTo can therefore stay
> deferred until the rotation reaches it when a run hits its budget; with
> the seeded rows a run finishes well inside it. ~~A row whose write fails
> (for example a 402 the database cannot store) is logged and not counted,
> so it too keeps its current `pay_to`, status and failure streak.~~ The
> payTo contract above is unchanged. Scope of this re-read: the
> Merchant-locked budgets section and the `merchant-catalog.ts` coverage
> it names; the rest of the document was not re-read for it.
>
> **Re-verified #4341 (2026-10-23):** #4341 closes the write-failure hole
> the #4300 note above described. A row whose VERIFIED write fails (the
> reviewer's repro: a well-formed 402 whose string field carries a NUL
> byte, which Postgres rejects with `invalid byte sequence for encoding
> "UTF8": 0x00`) is no longer left unchanged forever — it is recorded as a
> MISS, so the failure streak moves and the row degrades after the usual
> three, per the #3331 doctrine that an unverifiable merchant degrades.
> The row keeps its stored `pay_to` through those misses (a miss never
> writes `pay_to`), but the degraded row stops being advertised and a
> verified run — the challenge the database CAN store — still rewrites
> `pay_to` as seen. A row whose MISS write itself fails is logged, not
> counted, and keeps its current streak; that is unchanged. A probe whose
> challenge does not parse is now logged with the row's `resource_url` and
> the error message (nothing from the merchant payload) instead of
> silently reading as a miss. In discovery, a candidate whose write fails
> (e.g. an index entry whose name carries a NUL byte) is counted and
> skipped, and the run reaches later candidates. Scope of this re-read:
> the Merchant-locked budgets section and the `merchant-catalog.ts`
> coverage it names; the rest of the document was not re-read for it.

> **Re-verified #4389 (2026-10-24):** #4389 changes how the catalog probe
> in `merchant-catalog.ts` chooses the option it records. It keeps the
> `accepts[]` options the pay path keeps (the SDK's `normalizePaymentRequired`,
> which every pay path runs first: an option with no string `payTo`, or with
> a `maxAmountRequired` that is present but not a positive decimal string, is
> dropped), then runs the pay path's own selector (`selectX402SettlementScheme`
> from `@haven_ai/sdk`, with the delegation rail) over all of them instead of
> reading `accepts[0]`. The recorded network, the one `pay_to` and
> `asset_transfer_methods` are scoped to, is the selected option's, written
> as CAIP-2. A payable erc7710 option is always selected first, so a challenge
> that names one on either Base network is recorded on that network; the
> bullet's "lacking ERC-7710 there" case now needs the other network's
> erc7710 option to be one the pay path could not settle. A challenge with no
> option the pay path could settle (for example a scheme other than `exact`,
> a network other than Base or Base Sepolia, an asset other than their USDC,
> an unsupported transfer method or payment flow, or no `payTo`) is now a
> probe MISS, so such a row degrades after the usual three misses instead of
> staying verified. The asset is labelled from the chain registry on the
> selected option's own chain only, the chain authorize resolves it on
> (`resolvePaymentToken(agent.chain_id, asset)`); Base USDC named on a Base
> Sepolia option is a miss although the SDK selector accepts it, so the
> catalog is deliberately stricter than the selector there.
> `asset_transfer_methods` counts only options on the recorded network that
> the SDK's erc7710 or EIP-3009 selector accepts. Before, every option there
> was recorded by its `extra.assetTransferMethod` (default `eip3009`), so a
> `permit2` option was recorded as `permit2` and an option with an
> unsupported `extra.paymentFlow` and no method as `eip3009`; options with an
> unsupported transfer method or payment flow are now not recorded at all.
> The payTo contract above holds with one new consequence: `pay_to` is still
> written as seen from the challenge, still collected only across options on
> the recorded network, and still refused when they disagree, but a challenge
> that is now a miss (its only option names no `payTo`, or no option is
> payable) leaves the stored `pay_to` in place, as every miss does (a miss
> writes only the failure count, and `degraded` on the third in a row). Until
> the row degrades, that `pay_to` keeps counting toward its merchant's
> funding target. Before, a challenge whose only
> option named no `payTo` verified the row and cleared `pay_to`. A pin still
> pays only the address it was signed for. Scope of this re-read: the
> Merchant-locked budgets section and the `merchant-catalog.ts` coverage it
> names; the rest of the document was not re-read for it, and
> `last-verified` is not bumped.

> **Re-verified #2946 (analytics overview, slice B of #2944):** this diff
> touched one file in this document's coverage list,
> `middleware/owner-cli.ts`, by adding one entry to the allow-list —
> `GET /analytics/overview`, a read-only, owner-scoped aggregate over booked
> payment, refusal, fee, gas-count and snapshot rows (`DELEGATION_RAIL_ONLY`
> on every join; every statement a `SELECT`). The entry is a literal spec path
> (naming-epic decision), it sits behind `authMiddleware`, and
> `owner-cli-route-census.test.ts` discovered the route and measured
> `routeAllowsOwnerCli` at the door without a hand-edited count — exactly
> the §9 discipline. Nothing an owner-CLI token can now reach signs, moves
> funds or changes authority. §9 otherwise unchanged; nothing else re-read.

> **Re-verified #2945 (payment-refusals ledger, dep-boundary rework):** this
> diff touched one file in this document's coverage list,
> `infra/repositories/smart-accounts.ts`, by pure addition: the refusal
> ledger's owner-scoped account resolution moved verbatim out of
> `modules/payments/refusal-ledger.ts` into this repository as
> `FIND_OWNED_ACCOUNT_ID_BY_ADDRESS_AND_CHAIN_SQL` +
> `findOwnedAccountIdByAddressAndChain` (`SELECT id FROM smart_accounts WHERE
> user_id = $1 AND account_address = $2 AND chain_id = $3 LIMIT 1`,
> executor-last with the pool as default, `rows[0]?.id ?? null`). The new
> function is a read: it grants nothing, signs nothing, and touches no chain
> state; it feeds the fire-and-forget refusal records on the payment path,
> where unknown addresses and lookup failures resolve NULL (the
> swallow-to-NULL catch stays in the ledger's `resolveAccountId`). Every
> predicate, tenant scope, authority check and signing path this document
> describes is unchanged; the §6 owner-scoped `(address, chain)` lookup
> prose, the unlink transaction and the §8 settlement writes are untouched.
>
> **Re-verified #2911 (naming epic #2906, phase 3 — the schema rename):** this
> diff touched twelve files in this document's coverage list (`routes/auth.ts`,
> `routes/agents.ts`, `routes/user-safes.ts`, `routes/hybrid-accounts.ts`,
> `infra/repositories/{agents,dashboard,transaction-history,smart-accounts,
> hybrid-signers}.ts`, `rails/hybrid-account-config.ts`,
> `modules/accounts/mainnet-gate.ts`) by SQL identifier only: `user_safes` →
> `smart_accounts`, `safe_address` → `account_address`, `safe_id` →
> `account_id`, `user_safe_id` → `account_id`, `safe_tx_hash` →
> `account_tx_hash`, plus the row reads that follow. Every predicate, tenant
> scope (`WHERE user_id = $1`), authority check, signer-set rule and signing
> path in this document is unchanged; the four sentences above that named the
> old table or columns now name the new ones with the old in parentheses. The
> wire keys this document quotes (`safe_address`, `safe_id` on responses) are
> still emitted — the #2907 alias mappers are untouched and fed by local shims.
>
> **Superseded by #2914 (2026-09-17), appended rather than rewritten:** that
> last sentence was true when it was written and is not now. The contraction
> deleted `openapi/wire-aliases.ts` and the local shims with it, so the
> responses this document quotes carry `account_address` / `account_id` and
> nothing else. Read the paragraph above as the record of what #2911 did; read
> this one for what the wire does today.
>
> **Extended by the #2914 follow-up (2026-09-17), same day.** #2914 left three
> retired RESPONSE names standing: `safes` on `GET /user/accounts`, `safeName`
> on the `GET /transactions` feed, and `safes` on `GET /transactions/filters`.
> All three are gone now — the first two were deliberate one-release twins for
> the published CLI, the third was simply missed and found in review. So "carry
> `account_address` / `account_id` and nothing else" is true of the ENVELOPE
> keys too, not just the row fields. Nothing in this document's security
> argument moves: an envelope key is not an authority boundary, the queries are
> still `WHERE user_id = $1`, and the retired REQUEST names are still refused
> with a 400 rather than ignored — which is the part that matters here, since
> an ignored `safeId` filter would widen a query the ownership scope is
> supposed to narrow. This document's coverage list gains
> `routes/transactions.ts` and `middleware/retired-safe-names.ts` in the same
> change, because those two files are what make the claims above true and
> neither was declared.
>
> **Scope of this re-read** (so the `last-verified` date is not carrying an
> unstated claim; it is NOT bumped — it already reads 2026-09-17 from an
> earlier change today): the envelope keys on `GET /user/accounts`,
> `GET /transactions` and `GET /transactions/filters`; that every query behind
> them is still scoped to the caller's `user_id`; and that the retired request
> names are still refused with a 400. Nothing else in this document was
> re-read. On the scoping: the two list queries bind it as `$1`, while the
> x402 legs behind `GET /transactions` bind it as `$2` alongside an account-id
> `ANY(...)` — the same ownership property, written differently. An earlier
> draft of this note said `WHERE user_id = $1` flatly; review measured it.

> **Re-verified #3031 (edit budget limits in place):** the diff touched one
> covered backend file, `routes/agent-delegations.ts`, and the change is the
> request-SCHEMA layer only: the file joined the request-validation
> `enforcedModules`, so a body or path parameter whose shape the OpenAPI spec
> does not declare (required `signature`, the `budget_atomic` digits-only
> and uint96 shapes, uuid path params) is refused with the plugin's 400
> envelope BEFORE the handler — the hand-rolled shape rungs are deleted.
> Every authority claim in this document is untouched: the Owner-Signature
> Invariant holds verbatim (a delegation activates, revokes or rekeys only
> after the OWNER's signature is verified — the schema never substitutes for
> it, it only refuses malformed input earlier); budget, expiry, rail and
> delegate-identity checks stay semantic in the handlers; no route, role or
> ceremony was added or reordered. The body-less revoke-prepare shape dev
> always accepted is preserved (an optional requestBody validates declared
> shape OR absent). Nothing else in this document was re-read.

> **Re-verified #3166 (edit budget limits in place):** this diff touched one
> file in this document's coverage list, `hooks/useDelegationBudget.ts` — it
> gains `editBudget`, a frontend composition of the EXISTING lifecycle routes
> (build → owner signs → activate → per-hash revoke prepare → owner signs →
> submit) so the dashboard can change one active budget's limits without
> regenerating the delegate key. Nothing this document describes moves: the
> delegate key and local signer are untouched by construction (the only two
> ceremonies are OWNER signatures made client-side — the delegation itself and
> the revoke UserOp — and no rotate/rekey endpoint is on the flow's wire
> order, pinned by the hook test). Ordering is activate-then-revoke: Haven
> cannot revoke by itself (the revoke UserOp needs an owner signature), and
> revoking first would leave the agent with no budget if the new grant were
> abandoned. While the flow runs the old budget keeps working; between the two
> signatures both delegations exist on-chain (combined exposure = their sum,
> each bounded by its own caveat enforcers) — the window is stated in the UI
> copy and closed by the second signature. Refusals surface verbatim: the
> in-flight re-key guard (§3) refuses the BUILD step, and a revoke-all that
> raced the edit either 409s the activation (old state untouched) or is
> reported as success-shape when the per-hash revoke finds the old row already
> reconciled. Abandoned at any point, the old budget stays live and untouched.
> Scope of this note: that one hook. Nothing else in this document was
> re-verified.
>
> **Re-verified #3093 (frontend hooks: array wire keys default to `[]`):** this
> diff touched one file in this document's coverage list,
> `hooks/useDelegationBudget.ts`, by one expression: `setBudgets(res.delegations)`
> became `setBudgets(res.delegations ?? [])`, so a `GET /agents/{id}/delegations`
> answer without the key renders an empty budget card instead of sending the
> route into the ErrorBoundary. Nothing this document describes moves —
> `pickSigningPath`, the passkey/EOA dispatch, the grant/revoke ceremonies and
> the signer-set read (`/account-signers`) are untouched; a missing key was
> never a security state, only a crash. Scope of this note: that one
> expression. Nothing else in this document was re-verified.

> **Re-verified #3127 (converted amounts on the transaction feed):** this diff
> touched four files in this document's coverage list — `routes/transactions.ts`,
> `infra/repositories/transaction-history.ts`, `routes/auth.ts` and
> `infra/repositories/dashboard.ts` — and none of them moves an authority or
> custody boundary. The transactions change is additive projection only: every
> route keeps its auth hook and its `user_id`-scoped queries (the two
> machine-payment SQL statements gained `mpe.fx_rates` in their SELECT list —
> one more column from the same row, same WHERE, same bind shape); the new
> per-request read is the same scoped preference read the preferences route
> already served, keyed by the JWT subject; the signup's new column rides the
> shared signup INSERT — `INSERT_USER_SQL` in
> `infra/repositories/users.ts` gained the `currency_preference` column with
> `DEFAULT_TRANSACTION_CURRENCY` bound (the caller's own row, from a
> constant), while `routes/auth.ts` changed two response literals only: the
> signup response's `currency_preference` and the `/me` fallback (nothing
> about session issuance, device flow or credential verification moves); and
> `dashboard.ts` gained one WRITE beside its reads — the portfolio-snapshot
> INSERT carries the snapshot's `total_sek` as one more bind on the same row,
> same user scope, no authority surface — and widened two READ statements in
> the same pass: `FIND_PORTFOLIO_SNAPSHOTS_SQL` gained the `total_sek` column
> and the monthly-spend aggregate gained `sek_sum` plus `fallback_amount_sek`
> (more columns from the same rows, same WHERE, same bind shape). No file here
> that signs, delegates, relays or gates is touched. Scope of this note: those
> four files, the two SQL statements' SELECT lists, and the signup INSERT's
> column list. Nothing else in this
> document was re-verified.

> **Re-verified unchanged (#3824, 2026-10-09 — serve-time approx amounts +
> grouped activity):** this diff touched one file in this document's coverage
> list, `routes/transactions.ts`, and none of its authority, custody or
> signing surfaces. The change is additive READ-only projection: the JSON feed
> stamps rows that lack book-time fiat with an OPTIONAL `approxAmount` /
> `approxCurrency` pair priced at serve time (`getServeTimeFiatValues` — one
> cached CoinGecko read per token, null never 0), after the shared enrichment
> helper and only on the JSON route; the CSV export path is byte-identical
> (pinned by test). No filter, scope, tenant bound, query WHERE or route
> ordering moved; the route still writes nothing. The new dashboard activity
> grouping (`modules/transactions/activity.ts`) is a pure in-memory projection
> of the same user-scoped feed and touches no enforcement surface. Scope of
> this note: `routes/transactions.ts`'s response mapping and the new
> transactions-module files. Nothing else in this document was re-verified.
>
> **Re-verified unchanged (#3195, 2026-09-30, the monthly-spend SEK fallback
> predicate):** `infra/repositories/dashboard.ts`'s `fallback_amount_sek`
> predicate in `SUM_MONTHLY_PAYMENT_SPEND_SQL` widened from "rows whose
> `sek_value` IS NULL" to the same two-pronged shape `fallback_amount` (the
> USD/EUR twin) already had — NULL, or a booked zero beside a real token
> amount — so a `zeroPrice()` 0/0/0 row is re-priced into SEK at serve time
> exactly as it already was into USD/EUR (#3195: under the narrower predicate
> the same rows read LOWER under SEK than under USD). It is a display
> re-price of already-confirmed rows at read time: no confirm path, booking
> figure, handler, query scope, signing path or refusal moves, and the
> aggregate decides no spend — budget, recipient and expiry remain enforced
> on-chain by the caveat enforcers. The row shapes stay per-row independent:
> a priced row is collected into neither bucket. Nothing this document claims
> about authority, custody or signing changes. Scope of this note: that one
> CASE predicate. Nothing else in this document was re-verified.

> **Re-verified unchanged (#3778, 2026-10-08 — the optional `delivery_reference`
> delivery pointer):** this diff touched two files in this document's coverage
> list, `packages/sdk/src/client.ts` and
> `packages/backend/src/infra/repositories/transaction-history.ts`, and none of
> their authority, custody or signing surfaces. On `client.ts` the change rides
> the same seam #3764's note scopes — the ACCEPTED arm's
> `/machine-payments/evidence` report — plus the `reportMerchantOutcome`
> pass-through: one new OPTIONAL `deliveryReference` input (≤ 512 chars, the
> NON-SECRET pointer to a delivered good), spread into the evidence payload
> only when present. It authorizes nothing, produces or consumes no signature,
> and no spend decision reads its value; when the caller supplies a
> credential-shaped value the tool refuses pre-write (report) / pre-funding
> (settle) — declining a write the caller opted into by sending the field, not
> narrowing any previously-allowed path (the field did not exist before). On
> `transaction-history.ts` the change is one nullable column added to
> `X402PaymentIntentRow` and its SELECT (`mpe.delivery_reference AS
> delivery_reference`) — the same read-only projection class the #2871 note
> scopes: inside the existing `pi.user_id = $N` + `us.id = ANY($N)` tenant
> scoping, no writer, no authority and no spend path implicated. The dashboard
> surfaces that read the projection display the pointer; they decide nothing.
> Scope of this note: those two files. Nothing else in this document was
> re-verified.

> **Re-verified unchanged (#3770, 2026-10-08 — the delivery-quality report):**
> this diff touched two files in this document's coverage list,
> `packages/sdk/src/receipt.ts` and `packages/sdk/src/client.ts`, and none of
> its authority, custody or signing surfaces. `receipt.ts`'s `payment` block
> gains one OPTIONAL additive field, `deliveryQuality` — the paying agent's
> own evidence-only verdict (`ok` / `unusable` / `partial` + note) on what a
> settled payment DELIVERED — and `verifyPaymentReceipt` still reads only
> `authorization`, so nothing a signature covers moves (the same rule
> `parties` follows); `client.ts` gains `reportDeliveryQuality`, a plain POST
> relay to the backend's agent-scoped report route, which writes a verdict to
> a new evidence table only and never touches `payment_intents` — `settled`,
> `tx_hash`, amounts and status are untouched, no signature is produced or
> consumed, and no spend decision reads the report. Haven holds no new key,
> grant or credential because of it. Scope of this note: those two files.
>
> **Re-verified unchanged (#3781, 2026-10-08 — the catalog tier of the
> purchase label):** this diff touched one file in this document's coverage
> list, `packages/sdk/src/client.ts`, and none of its authority, custody or
> signing surfaces. `getX402MerchantCallContext` maps one new OPTIONAL
> rehydrated field — the catalog row's name (`catalog_name` on the wire,
> `catalogName` on the client type), persisted by
> `haven_prepare_catalog_purchase` so the settle leg can report the catalog
> tier of the purchase label. The field is display metadata from Haven's own
> catalog row: it authorizes nothing, is never merchant content (#1349), and
> is absent on a direct `haven_pay_mcp_tool` purchase. No signature is
> produced or consumed, nothing becomes signable or refused differently, and
> no spend decision reads it. Scope of this note: that one mapping.
> Nothing else in this document was re-verified.

> **Re-verified unchanged (#3764, 2026-10-08 — the SDK's own settlement-evidence
> report):** this diff touched one file in this document's coverage list,
> `packages/sdk/src/client.ts`, and none of its authority, custody or signing
> surfaces. On an ACCEPTED merchant answer to a payment WITH a funding leg,
> `completeX402MerchantCall` now posts the merchant's own settlement
> transaction — already parsed from `PAYMENT-RESPONSE` since #3118 — as a
> SECOND `/machine-payments/evidence` report right after the funding one
> (#3764): one attempt, no backoff, gated on a well-formed, non-zero hash
> different from the funding hash case-insensitively. This is a best-effort
> evidence WRITE after the purchase completed, on the same #3475 seam the
> backend verifies on-chain before recording — the SDK hands Haven a claim,
> not an authority; nothing becomes signable or refused differently, no
> signature is produced or consumed, and no spend decision reads the new
> `settlementEvidenceOutcome` field (the hosted tools map it to agent
> guidance; the local path swallows it by design). The local
> `retryRequest` hook lives in `merchant-completion.ts`, outside this
> document's coverage list. Scope of this note: that evidence path.
> Nothing else in this document was re-verified.

> **Re-verified unchanged (#3727, 2026-10-07 — the folded settlement evidence
> and retry_headers):** this diff touched one file in this document's coverage
> list, `packages/signer/src/tools.ts`, and none of its signing surfaces. The
> signer's `haven_sign_x402` / `haven_x402_sign_header` results now also carry
> `retry_headers` — a `{ <name>: <payment_header> }` echo derived from the
> SDK's live `x402PaymentHeaderNamesFor` rule, naming which headers to set on
> the agent's own merchant retry; the header value itself, its signing, its
> binding spend and its audit entry are untouched, and no payload becomes
> signable or refused differently. The hosted `haven_report_x402_outcome`
> evidence fold lives outside this document's coverage and is
> caller-asserted + chain-verified
> (`docs/regulatory/casp-changelog/2026-10-07-3727.md`), moving no authority.
> Scope of this note: those result-shaped additions. Nothing else in this
> document was re-verified.

> **Re-verified #2912 (naming epic #2906, phase 3b — the `account_type` data
> migration):** this diff touched one file in this document's coverage list,
> `infra/repositories/smart-accounts.ts`, and only its comment: the retired
> `account_type` value is renamed `'safe'` → `'legacy_safe'` by
> `085_account_type_legacy_safe.ts`, and the CHECK is tightened to
> `('legacy_safe','delegator_hybrid')` — no `DELETE`, no row removed, inert
> history kept representable under its new name (epic #1440's decision,
> restated on #2912's issue). `DELEGATION_RAIL_ONLY`'s equality test
> (`= 'delegator_hybrid'`) is unaffected — it was never keyed on the retired
> value's spelling — and the migration's own test asserts the real repository
> query (`listAccountsWithTypeForUser`) still matches only the live-rail rows
> after the rename. Every predicate, tenant scope, authority check and
> signing path in this document is unchanged.

> **Re-verified #2851 (safe-retirement epic #1440, final slice):** the unlink
> transaction in `infra/repositories/smart-accounts.ts` no longer nulls out
> `self_sign_agents.safe_id` before deleting the account row — that step
> existed only to satisfy `self_sign_agents`' own `NO ACTION` foreign key, and
> the table itself is dropped by migration `083`. Nothing above depends on it:
> the guards this section describes (live-delegation, open-sweep, in-flight
> re-key refusal) are unaffected, no permission or chain state changes, and
> the same migration's `account_type` default flip (`'safe'` →
> `'delegator_hybrid'`) changes what an *omitting insert* gets, never the
> `account_type = 'delegator_hybrid'` filter value the list queries above
> compare against.

> **Re-verified #3227 (repository tenant scope):** this diff touched
> `infra/repositories/smart-accounts.ts`, a file this document covers. The
> unlink transaction's orphan and delete, and the re-default's set, used to
> match rows by id alone and relied on the route's ownership check. Now each
> is also scoped to the caller in SQL (`AND user_id = $2`). A cross-tenant
> call matches no row: the unlink returns `false` and promotes nothing, and
> the re-default leaves every row, and the legacy mirror, unchanged. The
> guards this section describes run first and are untouched: live
> delegation, open sweep, in-flight re-key. No permission, signer set or
> chain state changes. Scope of this note: the unlink and re-default writes.
> Nothing else in this document was re-verified.

> **Re-verified #3803 (2026-10-09 — the redesigned dashboard overview):** this
> diff touched one file in this document's coverage list,
> `infra/repositories/dashboard.ts`, and every change is a read. The two
> existing list statements widen: `LIST_DASHBOARD_AGENTS_SQL` adds
> `pending_approval` to its status set — a connect-flow agent the overview
> must show; a status with no spend authority, per §3's #3544 note on what
> `pending_approval` can and cannot become — and `LIST_DASHBOARD_ACCOUNTS_SQL`
> adds `owner_address` plus a `hybrid_account_passkeys` COUNT, the raw
> signer-set inputs so `needsBackupSignerRecommendation` (§7) can be answered
> PER ACCOUNT by the route; the predicate itself is unchanged and still lives
> in `modules/accounts/mainnet-gate.ts`, and the recommendation remains
> advice, not a gate. The rest is additive: seven new SELECT-only grouped
> statements (connection-setup statuses, received sub-budgets, the 7/30-day
> spend groups with the USDC pace, distinct-merchant counts, per-agent last
> payment, refusal row buckets, failed-intent count) over rows the caller's
> own `user_id` already scopes (`$1` in every statement) and, on the
> payment/refusal/intent reads, rail-scoped through the shared
> `DELEGATION_RAIL_JOIN` fragment. The netting reuses analytics'
> `spendNetFactorSql` rather than a fourth verbatim copy of the ratio, and
> every figure — gross, net, pace, buckets — is a display re-projection of
> already-confirmed rows at read time: no confirm path, no booking write, no
> signing path and no spend decision reads them; budget, recipient and expiry
> remain enforced on-chain by the caveat enforcers. The account list keeps its
> `account_type = 'delegator_hybrid'` filter (#2413's rule: no legacy rail
> surface on the dashboard). Scope of this note: those statements and their
> WHERE/JOIN shapes. Nothing else in this document was re-verified.

> **Re-verified #3921 (2026-10-14 — the budget-liveness predicates, epic
> #3919 slice B):** this diff touched one file in this document's coverage
> list, `infra/repositories/dashboard.ts`, and one read in it:
> `RECEIVED_SUB_BUDGETS_FOR_AGENTS_SQL` now answers its `open` column
> through the shared `openSubBudgetSql` predicate (defined in
> `infra/repositories/sub-budgets.ts`) instead of `status = 'open'` alone —
> an EXPIRED `open` grant now reports `open = false`, the same verdict the
> payment path (`sub-budget-service.ts`) and the agent's own open list
> already reached — and the read gained a defaulted `nowSec` parameter for
> that predicate's app clock. A narrowing: nothing that was refused becomes
> allowed, the returned row set is unchanged (pending/closing/closed grants
> still report `open = false` rather than being dropped), and no write,
> signing path or permission changes. Scope of this note: that one statement
> and its signature. Nothing else in this document was re-verified.
>
> **Re-verified #3922 (2026-10-14: budget liveness, epic #3919 slice C).**
> The diff touches covered paths:
> - `routes/agent-delegations.ts`, whose list now selects `is_live` from
>   `spendableDelegationSql(…, { requireStarted: false })`, the view
>   definition;
> - (outside this document's coverage) `infra/repositories/task-budgets.ts`
>   and `sub-budgets.ts`, which add JS mirrors pinned to their SQL
>   predicates by a real-DB matrix test;
> - the `DelegationBudgetCard.tsx` and `useDelegationBudget.ts` readers.
>
> `is_live` is a REPORT field, additive, and read by no payment path: the
> spend-time selectors keep `requireStarted: true`, and every refusal and
> enforcer is untouched.
>
> The still-enabled set gains one exported copy,
> `STILL_ENABLED_DELEGATION_STATUSES` in `@haven_ai/core`, pinned to
> `stillEnabledDelegationSql()` by a test. The CLI revoke refusal and the
> remove dialog stay STATUS-based on purpose: they guard against leaving
> on-chain authority behind (#3343, #3542) and must hold against an older
> backend that sends no `is_live`.
>
> Two display changes narrow what is shown as live. A `closed` sub-budget
> with a future expiry reads "ended" instead of "ends"; a `closing` one still
> reads "ends", because its grant stays enabled until the disable signature
> lands. The fund-merchant "This replaces…" warning no longer fires for an
> expired `active` row, which is still retired on activation but can no
> longer spend. No signing input, permission or custody decision moves.
>
> Scope of this note: those reads only. Nothing else in this document was
> re-verified, and `last-verified` is not bumped.
>
> **Re-verified #3923 (2026-10-14: budget liveness, epic #3919 slice D).**
> The diff touches covered paths:
> - `routes/agent-delegations.ts`: under `?include=remaining`, the existing
>   `readRemainingBudget` chain read now runs only for LIVE rows. An expired
>   `active` row stays in the list with its three remaining fields null and
>   no read. That narrows a read-only enrichment; nothing is signed, prepared
>   or redeemed.
> - `sdk/src/account-reads.ts`: the summary's older-backend filter drops an
>   expired `closing` task budget.
> - `DelegationBudgetCard.tsx`: a `closed` sub-budget reads "closed".
>
> Outside this document's coverage, `modules/sub-budgets/sub-budget-service.ts`
> no longer closes an expired `closing` sub-budget trivially. Its disable is
> re-prepared and signed by the agent's own delegate key (owner decision
> 2026-10-14), so the child is disabled on-chain rather than left to lapse.
> That is authority-reducing only, and Haven still signs nothing. One
> exception (owner decision 2026-10-14): when the delegating agent is revoked
> or archived, the owner `DELETE` closes an expired `closing` row in Haven
> with no on-chain disable, since the child can no longer spend and nobody is
> left to sign. Haven still signs nothing.
>
> No payment selector, enforcer, refusal or signer-set decision moves. Scope
> of this note: those reads and that close path; nothing else in this
> document was re-verified, and `last-verified` is not bumped.
>
> **Re-verified #4350 (2026-10-23: the end date becomes an owner choice).**
> The diff touches a covered path: `hooks/useDelegationBudget.ts` — `grant`
> now forwards the owner's chosen end date as the existing `expires_at` on
> `POST /delegations/build`, and the edit flow always supplies one (the
> row's own when kept). Nothing about the caveat itself moves: the end date
> was already a signed `beforeThreshold` caveat enforced by the
> `Timestamp` enforcer; the owner only now SEES and CHOOSES it before
> signing (30/90/180/365 presets, 90 the default — owner decision 1 on
> #4349). Haven signs nothing and the server still validates the expiry;
> the 365-day ceiling is #4351's build-route cap and is not enforced here.
> No payment selector, enforcer, refusal or signer-set decision moves.
> Scope of this note: that forward only; nothing else in this document was
> re-read for it, and `last-verified` is not bumped (it already reads
> 2026-10-23).
>
> **Re-verified #4351 (2026-10-23: the expiry gains its ceiling).** The diff
> touches a covered path: `routes/agent-delegations.ts` — the build route now
> refuses an `expires_at` more than 365 days out (400, same `{ error }`
> envelope as the future check), exactly as this document's #4350 note
> anticipated. Nothing this document claims about the caveat itself moves:
> the end date is still the signed `beforeThreshold` caveat enforced by the
> `Timestamp` enforcer, and the cap is a route-level admission check that
> only ever REFUSES a build — it adds no authority and touches no selector,
> signer set or custody path. The re-key path is deliberately untouched
> (`agent-rekey.ts` carries the old row's `expires_at` via the meter
> snapshot and `planCarry`, without the build route), so a legacy row past
> the cap stays rotatable; a real-Postgres pin (`agent-rekey-issue-past-cap.test.ts`)
> and a `planCarry` unit pin hold that open. Scope of this re-read: the
> expiry-validation claims above; nothing else in this document was re-read
> for it, and `last-verified` is not bumped (it already reads 2026-10-23).

> **Re-verified #4023 (2026-10-16, per-account deploy salt + create-additional
> account, epic #4022 slice S1):** this diff touches nine files in this
> document's coverage list — `rails/hybrid-account-config.ts`,
> `rails/hybrid-signer-actions.ts`, `rails/hybrid-transfers.ts`,
> `routes/hybrid-accounts.ts`, `routes/agent-delegations.ts`,
> `routes/agent-rekey.ts`, `infra/repositories/smart-accounts.ts`,
> `sdk/src/delegate-account.ts`, `lib/delegationPasskeySigner.ts` — around one
> mechanism: a USER account's CREATE2 address is now derived with a
> **per-account deploy salt** (a never-reused per-(user, signer) counter,
> migration 114) instead of the literal salt-0, so one passkey can own several
> accounts on one chain. Read against the model, nothing moves:
>
> - **Non-custody is untouched.** The salt is a counter value stored on the
>   `smart_accounts` row — not a key, not a signature surface, not spend
>   authority. Haven still provisions through a watch-only owner (invariant 5)
>   and still signs nothing (invariants 7/12/13); the derivation stays the
>   read-only factory call. The new `HybridDerivationMismatchError` REFUSES to
>   deploy when a known address does not match what the config derives — it
>   can only narrow what the relayer will do, never widen it.
> - **The delegate account stays at the literal `'0x'`.**
>   `sdk/src/delegate-account.ts`'s `DEPLOY_SALT` is byte-unchanged (now
>   documented as the delegate-only constant the signer vendors offline), and
>   the rails' delegate entry point is a separate
>   `ensureDelegateHybridDeployed`. Every claim about the agent's own
>   counterfactual account deriving from its delegate key derives exactly as
>   before.
> - **The client never needs the salt.** The signer-set reads
>   (`GET /agents/:id/account-signers`,
>   `GET /accounts/hybrid/:address/signers`) carry the same public-key
>   material as before; the salt deliberately stays server-side, and
>   `lib/delegationPasskeySigner.ts`'s change is its doc comment: the client
>   signs with the signers it is handed and never re-derives the address —
>   the pinned-address rule above holds verbatim.
> - **The signer-set model holds.** Create-additional copies the new
>   account's owner passkey SERVER-SIDE from the source account's stored
>   signer set (never from the request), and the derived address's UNIQUE is
>   scoped per user (migration 114) so a concurrent create cannot 500. One
>   passkey can now front several accounts, but "who can change a signer set"
>   is unchanged: same prepare/submit split, same last-signer guard, one
>   shared implementation (invariant 13).
> - **The provisioning SQL moved into `infra/repositories/`**
>   (`smart-accounts.ts`, `hybrid-signers.ts`) — the last `pg-only-in-infra`
>   waiver in `routes/` is gone. Verbatim move: same SQL constants, same
>   parameter order, every new function takes `userId` as a required
>   parameter and every statement scopes on it, and the transaction still
>   wraps the counter bump, the derived row and the copied passkeys. The
>   schema smoke PREPAREs the same constants.
>
> Scope of this note: the derivation/salt mechanism, the provisioning route's
> data access, and the claims above that rest on the pinned-address rule.
> Invariants 1–13 are untouched. Nothing else in this document was re-read
> for it, and `last-verified` is bumped to 2026-10-16 for exactly this
> coverage.

> **Re-verified unchanged (#4166, 2026-10-20, one heading per section):** this
> diff is presentation chrome only. `components/AccountSignersCard.tsx` drops
> its own "Backup & recovery" heading and intro — the account page's Security
> & details section already carries the one heading ("Who can approve") and
> the one keep-at-least-two sentence, and the card repeated both — and loses
> the `mt-6` offset the duplicate heading implied. Every flow the card owns is
> untouched: add a passkey, add a wallet, remove (the `wayCount < 2`
> last-way gate and both consequence confirmations), the "Lost a device?"
> recovery entry and the #3825 Settings link. The card remains the ONLY
> surface that can change signers or run recovery; nothing about authority,
> signing or the routes above moved. Scope of this re-read: this paragraph and
> the card. The rest of this document was not re-read for it;
> `last-verified` already reads 2026-10-20 and is left as is — this note is
> the scope.

> **Re-verified unchanged (#4307, 2026-10-23 — card order only):** this diff
> is presentation chrome only in `components/AccountSignersCard.tsx`. The
> #3825 Settings link no longer leads the card: it moves below the signers
> and their actions onto its own `Card.Section` — same target (now
> `/settings?tab=security#signers` since #4358 moved the signers onto
> Settings' Security tab), same wording, the #3825 object note kept as a
> comment — the one-signer warning now LEADS the card (same div, its `mt-4`
> offset dropped), and the passkey helper text's offset goes `mt-1.5` to
> `mt-2`. No signing step, signer-set gate, `pickSigningPath` branch, route
> or `wayCount < 2` last-way gate is touched; the card remains the ONLY
> surface that can change signers or run recovery, and nothing about who
> signs, what may be spent, or when revocation bites changed. Scope of this
> re-read: this paragraph and the card; `last-verified` already reads
> 2026-10-23 and is left as is.

> **Re-verified unchanged (#4607, 2026-11-02 — copy only):** this diff is
> presentation copy only in `components/AccountSignersCard.tsx`. The "Lost a
> device?" paragraph's "approved by a signer you already hold" now reads
> "approved by a passkey or wallet you already hold", and the card's three
> i18n strings (`lib/i18n/messages/en.ts`) say "passkeys and wallets" where
> they said "signers" — the owner's term for the approver set (epic #4560 §
> Owner decisions; `copy-guidelines.md` CG:129). No signing step, signer-set
> gate, `pickSigningPath` branch, route, `wayCount < 2` last-way gate or
> authority claim is touched: the card remains the ONLY surface that can
> change signers or run recovery, and nothing about who signs, what may be
> spent, or when revocation bites changed. Scope of this re-read: this
> paragraph and the card; the document-wide `last-verified` date is not
> re-stamped.

> **Re-verified #3518 (2026-10-01):** this PR adds a READ-ONLY export to
> `infra/repositories/delegation-budgets.ts` — `selectBudgetForPaymentReport`,
> the report-side mirror of the payment's own `SELECT_DELEGATION_FOR_PAYMENT_SQL`
> (same recipient match, live window and ordering, over rows the derived view
> already read). It writes nothing, activates nothing, retires nothing, and is
> called only from the budget precheck's compare and the balance-coverage
> report — both of which previously picked the FIRST per-token row, a
> selection that could disagree with the enforcer about which caveat-bounded
> grant a payment draws on. The change moves that off-chain opinion; the
> on-chain gate is unchanged: spend remains bounded by the caveat stack
> (`MultiTokenPeriodEnforcer` + allowed recipients + `Timestamp`), redemption
> still requires the delegate key's signature, and the activation/replace
> transaction this section pins (#1061/#2411/#2415) is untouched. Selection
> opinion is not authority: no grant is created, widened, or redeemed by
> choosing differently which existing owner-signed row a REPORT cites. The
> same round adds read-only columns to `listActiveDelegations`' projection
> (`delegation_hash`, `recipient_address`, `merchant_id`, the window, the
> creation timestamp) — visibility fields for which budget a row is, with no
> writer. Perimeter unchanged.

> **Re-verified #2910 (naming epic #2906, phase 2b):** this diff touched six
> files in this document's coverage list — `routes/auth.ts`,
> `routes/agents.ts`, `routes/user-safes.ts`, `infra/repositories/agents.ts`,
> `rails/hybrid-account-config.ts`, `modules/accounts/mainnet-gate.ts` — by
> identifier rename only: locals and parameters `safeId`/`safeAddress` →
> `accountId`/`accountAddress`, the object-literal fields `NewAgent.safeId` →
> `accountId` and `CreatedAgent.safeInfo` → `accountInfo`, and
> `sessionSafePayload` → `sessionAccountPayload` (the §6 sentence naming it
> updated). Every SQL literal in the
> touched repository files is byte-identical (64 literals, 0 differences), no
> route path, wire key, tenant-scoping clause, signing path or authority
> check changed, and the `RelayerOperation` union lost only its dead
> `'safe_deploy'` member (historical `relayer_gas_events` rows still read —
> pinned by test). Every claim in this document that names one of these
> files still holds under the new identifiers; nothing else re-read.

> **Re-verified #2907 (naming epic #2906, phase 0):** the funding-leg
> `sign_data.components` object (`delegation-authorize.ts`, `replay.ts`) gains
> a `payer_account` field — an additive, same-value twin of the deprecated
> `safe` field, not a rename into `components.account` (which already means
> the *delegate* account address on this shape, a different address). No
> authority, signing path, or invariant mapping changes: `payer_account` is a
> read-side label, mutation-tested equal to `safe`
> (`openapi/payer-account-alias.test.ts`). `routes/user-safes.ts` also gained
> an additive `/user/accounts` prefix registration of the same handler
> module — §2's invariant mapping and this doc's route list are otherwise
> unaffected: no new authority, no new signing path.
>
> **Review-findings correction, same PR:** that additive `/user/accounts`
> mount was NOT reflected in `middleware/owner-cli.ts`'s `OWNER_CLI_ALLOWED_
> ROUTES`, which named only the `/user/safes` literal — `routeAllowsOwnerCli`
> compares the registered route's exact URL, so an `owner_cli` token that
> could read `GET /user/safes` and `GET /user/safes/{safeId}/funding` got a
> 401 on the identical `/user/accounts` / `/user/accounts/{safeId}/funding`
> mount, for the same data, through the same handler. This is a REFUSAL gap,
> not an authorization grant — the token already had this read through the
> `/user/safes` prefix — so fixing it (adding the two twin entries) does not
> widen the owner_cli surface §9 below describes; it makes the surface
> actually reachable through both names, which is the whole point of an
> additive rename. Proven with a parity test that fails 4 assertions when the
> twin entries are removed.
>
> **Superseded at #2914:** the contraction removed the `/user/safes` pair from
> `OWNER_CLI_ALLOWED_ROUTES` rather than keeping both, so the allow-list now
> carries the `/user/accounts` names alone and matches §9 exactly. A reader
> should not act on the "adding the two twin entries" instruction above — it
> records what #2907 did, not what the list holds today.

> **Re-verified #2850:** this diff touched two files in this document's
> covered-paths list — `routes/agent-rekey.ts` and `routes/agents.ts` — each by
> exactly one import-path line: `getTokenBalance` now imports from
> `infra/chain/relayer-reads.ts` (the shared chain-read module renamed out of
> its `rails/allowance-module.ts` name). No handler, authority check, signing
> path, or invariant mapping in either route changes; §2's
> relayer-free/signer-free scans read unchanged bodies at a new import path.

> **Re-verified #3132:** this diff touched one file in this document's
> covered-paths list — `routes/transactions.ts` — by adding a per-row
> `scope: { source: 'wallet', filter }` to the aggregated feed's response
> after filtering and pagination (the feed is wallet-scoped; `agentId` /
> `accountId` are named as narrowing). The read is unchanged in what it
> reads: the same `listBasicAccountsForUser(sub)` ownership scope, the same
> `agentExistsForUser` check on a foreign `agentId`, the same 400 bodies. No
> handler gains authority, no write path is added, no signing path or
> invariant mapping moves; §2's relayer-free/signer-free scans read an
> unchanged body apart from the response map. Nothing else in this document
> was re-verified in this pass.

> **Re-verified #3516 (2026-10-02, console round 3):** the change this note
> rides touches `packages/ops/**` (plus this doc and a `.gitignore` line) —
> the console's wire types collapsed
> onto the generated `ApiSchema<'OpsSystemHealth'>` re-export (#3571 named
> the response schema), a search-input sizing fix, and the #3585 base
> update (whose CSP-nonce note above is that change's own, not re-verified
> here). Re-read against the paragraph above: the client surface is still
> the seven GET readers plus the one audited `reveal` and the sign-in
> navigation (`client.test.ts` walks the client's own keys, so a method
> added anywhere fails before review could miss it); the health page makes
> no call beyond its single read; and the type collapse changes no wire
> field — the generated schema carries every key the pages render, pinned
> by the shrunken mirror test against the generated document itself. The
> backend files this paragraph's claims rest on (`routes/ops.ts`,
> `modules/ops/**`, `middleware/ops-auth.ts`, the read-only role grants)
> are untouched by the diff, so nothing here grants, widens or redeems
> anything and the no-rail-authority claim holds verbatim. Scope of this
> re-read: this paragraph and what the console imports and renders — the
> invariant, custody, redemption and settlement sections were NOT re-read
> (the diff touches no file that implements them), and `last-verified` is
> not bumped.

> **Re-verified #3584 (2026-10-02, console typography):** the change touches
> `packages/ops/src/app/layout.tsx` (Inter through `next/font/google`, which
> self-hosts the font files under `/_next/static/media` at build time, so the
> CSP's `font-src 'self' data:` is unchanged) and `SignInView.tsx` (the
> sign-in button's `size="lg"`). No client method, read, reveal, sign-in
> navigation or backend file changes, so the no-rail-authority claim above
> holds verbatim. Scope of this re-read: this section only; `last-verified`
> is not bumped.

> **Re-verified #3624 (2026-10-04, ops on-chain test clock):** the change
> touches only `packages/backend/src/modules/ops/__tests__/onchain.test.ts`.
> The single-flight cache test now injects a fixed `now`, so the view's
> per-call `generated_at` stamp cannot differ across a millisecond boundary
> and fail the strict equality. No route, read, reveal or ops-auth file
> changes, so the no-rail-authority claim above holds verbatim. Scope of this
> re-read: this section only; `last-verified` is not bumped.

> **Re-verified #3602 (2026-10-06, console Feedback page):** the change adds
> one read route (`GET /ops/feedback` in `routes/ops.ts`) and one allowlisted
> reveal field (`feedback.text`) to the surface this section describes.
> Re-read against the paragraph above: the new route sits behind the same
> `opsAuth` bearer hook (no new auth path), reads only the read-only
> Postgres role's newly granted `feedback` columns, writes its
> `ops_access_log` row before answering, and masks every field server-side —
> the unmasked message text still leaves only through the audited
> `POST /ops/reveal`, which returns that one column after the same
> audit-first write, and an expired row (`expires_at > NOW()`) answers 404
> like a missing one. `POST /ops/reveal` still only reads one allowlisted
> column and records the read first; no route under `/ops` moves funds,
> signs, redeems, changes a signer, delegation or credential, or acts as a
> user, so the no-rail-authority claim holds verbatim. Scope of this re-read:
> the ops-console section above and the files this change touches
> (`routes/ops.ts`, `modules/ops/**`, `infra/repositories/ops-*.ts`,
> `infra/ops-readonly-role.ts`); the invariant, custody, redemption and
> settlement sections were NOT re-read (the diff touches no file that
> implements them). `last-verified` is bumped for exactly this coverage.

> **Re-verified #3611 (2026-10-06, console type ramp):** the change touches
> `packages/ops/src/app/layout.tsx` (one more stylesheet import,
> `@haven_ai/ui/type.css`, the type ramp and `v2-tabular` moved verbatim out
> of the dashboard's `globals.css`), adds a test under
> `packages/ops/src/__tests__/`, and adds a local-only computed-style probe
> to the screenshot script (`packages/ops/scripts/screenshot.mjs`). Plain
> CSS bundled at build time from a workspace package: no script, no network
> origin, so the CSP is unchanged.
> No client method, read, reveal, sign-in navigation or backend file
> changes, so the no-rail-authority claim above holds verbatim. Scope of
> this re-read: this section only; `last-verified` is not bumped.

> **Re-verified #4016 (2026-10-16, console Card.Section alignment):** the
> change touches `packages/ops` UI pages only —
> `src/app/health/page.tsx`, `src/app/doc-health/page.tsx`,
> `src/app/feedback/page.tsx` and `src/components/customer/CustomerView.tsx`
> (flush `Card.Header padding="none"` bands given `className="px-5"`, and
> the default `Card.Section`s moved onto plain `px-5 py-4` blocks), plus a
> new `scripts/measure-card-inset.mjs` geometry probe and a source-level
> `src/__tests__/card-inset-guard.test.ts`. No client method, read, reveal,
> sign-in navigation or backend file changes, so the no-rail-authority
> claim above holds verbatim. Scope of this re-read: this section and the
> files the diff touches; the invariant, custody, redemption and
> settlement sections were NOT re-read (the diff touches no file that
> implements them); `last-verified` is not bumped.

> **Re-verified #4192 (2026-10-21, ignore-step test harness):** the change
> touches `packages/ops` in one test file only,
> `src/__tests__/vercel-ignore-build.test.ts`, which now registers the
> shared ignore-build test harness's new `yieldToEventLoop` as an
> `afterEach` and spawns git through the harness's resolved binary. A turn of
> the event loop between cases keeps vitest's worker RPC from timing out, and
> on macOS the harness skips the slow `/usr/bin/git` shim. No assertion,
> watched path or ignore-build behaviour changes, and no client method, read,
> reveal, sign-in navigation or backend file changes, so the no-rail-authority
> claim above holds verbatim. Scope of this re-read: this section only;
> `last-verified` is not bumped.

> **Re-verified #4372 part K (2026-10-25, ops README re-read):** the only
> file under `packages/ops/**` this change touches is `packages/ops/README.md`,
> prose only. It now says that the Doc health page reads the build-time
> `/ops-doc-health.json` from the console's own origin, that http is allowed
> for every loopback registry host (`LOCAL_HOSTNAMES` in
> `src/lib/environments.ts`), that the CSP's font rule is `'self' data:`, and
> that the client root renders nothing until the sign-in fragment is
> scrubbed. No source, client method, read, reveal, sign-in navigation or
> backend file changes, and the console still reaches no backend route
> outside `/ops/*`, so the no-rail-authority claim above holds verbatim.
> Scope of this re-read: this section only; `last-verified` is not bumped.

> **Re-verified #3167 (2026-09-20):** the covered file this diff touches is
> `routes/agents.ts` — it gains only the `labels[]` read-along on its list,
> by-id, and PUT responses (joined from the new per-user label tables) and no
> authority decision moves: delegation lifecycle, budget derivation, rekey and
> revoke handling are byte-identical, and the new label data access lives in a
> dedicated repository module that nothing in the delegation, budget, or
> enforcement path imports (its header states that boundary; the issue's own
> hard guard demands it). A label is a name and a colour; it carries no grant,
> no caveat, and no key. Perimeter unchanged for this model — the CASP shard
> `docs/regulatory/casp-changelog/2026-09-20-3167.md` carries the full
> analysis.

> **Re-verified #3030 (2026-09-21, request validation slice 2):** this diff
> touches three files in this document's coverage list — `routes/auth.ts`,
> `routes/transactions.ts`, `routes/user-accounts.ts` — and moves no authority
> or custody boundary: it moves SHAPE checks out of the handlers and into the
> OpenAPI request schemas the plugin now ENFORCES on these modules
> (`index.ts` `enforcedModules`). What each file lost is a hand-rolled type or
> pattern check that the spec's schema states (`auth.ts`: the password
> bounds, `typeof` on name/email/user_code/device_code — the email FORM and
> the control-character and blank-after-trim rules stay in the handler, and
> the `via` marker the dashboard sends is now declared; `transactions.ts`:
> the uuid / `user`-or-uuid / `<chain>:<address|native>` / positive-integer /
> `in|out` shapes on its filters, while ownership (`listBasicAccountsForUser`,
> `agentExistsForUser`, `findAccountOwnership`) and chain support stay
> exactly where they were; `user-accounts.ts`: `typeof name` and the
> pre-lookup uuid check, with `renameAccountForUser` still scoped to the
> caller). Auth precedes validation on every ENFORCED route: `authMiddleware`
> runs as an `onRequest` hook and validation is preValidation, so an
> anonymous caller gets 401 before any 400. Three enforced routes had theirs
> as a `preHandler` (after validation) — `POST /auth/device/lookup`,
> `/approve` and `GET /analytics/funnel` — which the enforced schema turned
> into a 400 for an anonymous malformed request (measured in review, both
> rounds); all three moved to `onRequest` in this diff, pinned by
> `auth-device.test.ts` and `analytics.test.ts`. Two shadowed money-path
> modules still register `authMiddleware` as a `preHandler`
> (`agent-passports.ts`, `agent-connection-setups.ts`); their 401-first
> consequence holds today because a module outside `enforcedModules`
> refuses nothing, whatever the mode; both are slice-4 files (#3032) and
> must move to `onRequest` before that slice flips them — #3032's body
> carries that line — and
> the retired Safe-inflow 410s (`POST /user/accounts`, `PUT /user/account`,
> `/deploy`) gained a route-level `onRequest` so they still precede
> validation: a malformed body is told the flow is gone, not to fix its
> request (pinned in `safe-inflow-retired.test.ts`). The three files carry
> no inline tenant SQL; ownership runs in the repositories they call
> (`listBasicAccountsForUser`, `agentExistsForUser`, `findAccountOwnership`,
> `renameAccountForUser`), none of which this diff touches. Scope of this
> note: those three files' request-shape edits and the hook order. Nothing
> else in this document was re-verified.

> **Re-verified #3255 (2026-09-23, backend RPC failover):** this diff touches
> the rail's viem clients in `rails/delegation-rail.ts`,
> `rails/hybrid-provisioning.ts` and the `createTreasuryOps` callers. Each now
> reads through `infra/chain/rpc-transport.ts`, a viem `fallback()` over the
> dedicated endpoint, an optional second provider and the public node, so a
> quota-dead provider no longer fails prepare. What enforces a spend is
> unchanged: budget, recipient pin and expiry still revert in
> `eth_estimateUserOperationGas` on the bundler, which this diff does not
> touch, and every UserOp still needs the account signer's signature. An
> `eth_call` revert is terminal and is never retried on the next node. The
> `disabledDelegations` heal is the exception: it stays on the dedicated
> endpoint only (`dedicatedOnly`, pinned by `rpc-transport-guard.test.ts`),
> keeps its `finalized` tag and two-read rule, and the sentence on lying RPC
> endpoints above now says why. A lagging fallback node can make
> `ensureHybridDeployed` spend relayer gas on a reverting or spurious deploy,
> never move funds. The relayer's ethers provider stays on one node (#1533).
> Scope of this note: those RPC reads. Nothing else in this document was
> re-verified.

> **Re-verified #3032 (2026-09-24, request validation slice 4, independent
> prep):** this diff touches `routes/agent-passports.ts` and
> `routes/agent-connection-setups.ts`, and moves no authority or custody
> boundary. The #3030 note above records both modules as the two shadowed
> money-path files still authenticating in a `preHandler`, and says they must
> move to `onRequest` before slice 4 enforces them. They move in this diff:
> `agent-passports.ts`'s module-level hook and the four owner routes of
> `agent-connection-setups.ts` (`POST /`, `GET /:setupId`,
> `POST /:setupId/budget-approval`, `POST /:setupId/cancel`) now authenticate in
> `onRequest`, so an anonymous caller gets 401 before any 400 once they are
> enforced. This is pinned by `auth-before-request-validation-3032.test.ts`,
> which enforces both modules and includes an authenticated off-spec control
> that must answer 400. Neither module is enforced yet: `enforcedModules` and
> the default flip stay with the rest of #3032, after #3031. The connector
> routes (`/resolve`, `/register`, `/:setupId/install-status`,
> `/:setupId/connector-status`) authenticate inside their handlers by setup
> token or by the agent API key, and are unchanged. The same diff declares the
> four request fields today's connector and dashboard send (`local_mcp`,
> `mcp_server_name`, `skill_installed`, `superseded_agent_ids`); they are
> loosenings, so nothing that is accepted today is refused. Scope of this note:
> those two files and those four fields. Nothing else in this document was
> re-verified.

> **Re-verified #3032 (2026-09-25, request validation slice 4, the
> enforcement itself):** this diff touches four covered files —
> `routes/agents.ts`, `routes/agent-rekey.ts`,
> `routes/agent-connection-setups.ts`, `routes/hybrid-accounts.ts` — and moves
> no authority or custody boundary. What moved is where the request SHAPE is
> decided: the handler-side type/shape rungs (name string-ness, delegate
> address narrowing, bigint serializer rungs, setup-token string-ness,
> passkey coordinate shapes, the 23505 uniques) are deleted because the
> OpenAPI schemas state each one, and the five modules join `enforcedModules`
> with the mode default flipped to `enforce`. The authority checks the
> paragraphs above describe — revoke-precedes-issue, budget carry, owner
> signatures, the delegation rail's approve-verify flow — are handler
> SEMANTICS and are untouched: the schema refuses shapes before the handler,
> never authority after it. The refusal code stays 400 with the plugin's
> envelope (which names a field, never a rail, so the #2245 rail-agnostic
> refusal property holds); an anonymous caller still gets 401 before any 400
> (the #3276 note above). The `agent-passports.ts` module enforces without a
> handler edit — its rung count was already 0. Scope of this note: the four
> files' validation plumbing and the mode default. Nothing else in this
> document was re-verified.

> **Re-verified unchanged (#3638, 2026-10-05):** `direct-payment-guard.ts`
> changes a comment only. `DIRECT_PAYMENT_CHAIN_IDS` stays `{8453, 84532}`, so
> "its chain has pinned delegation contracts (Base, Base Sepolia)" above holds
> verbatim. The same diff narrows the SDK's x402 network and token tables and
> its explorer-link map to Base and Base Sepolia. Those are display and
> client-side option selection; nothing the signer verifies moves. Scope of
> this re-read: the "What is signed" list above. `last-verified` is not bumped.

> **Re-verified unchanged (#3378, 2026-09-26):** `client.ts`'s `payX402Quote`
> now forwards its options (`taskBudgetId`) to `authorizeX402`, as `fetch()`
> already did. No signing check moves: the funding leg still runs the #3271
> binding, the allowlist (which accepts the #3329 two-link task chain) and the
> #3375 recipient pin, whichever delegation the backend redeems under. The rest
> of this document was not re-read for it, and `last-verified` is not bumped.

> **Re-verified (#3392, 2026-09-27):** the idempotent replay on both payment
> routes now refuses a `task_budget` mismatch with a 409 instead of silently
> replaying onto another budget: `POST /payments` compares `task_budget_id`
> alongside token/recipient/amount (`mismatch()`, lower-cased, "absent" is a
> value), and `POST /x402`'s `delegationReplay` compares it on
> `pending_signature` (unexpired) and `confirmed` rows BEFORE the
> confirmed-200 branch — a budget-only check there; enforcing the other
> fields on confirmed rows is out of scope. The SDK's x402 receipt cache and
> in-flight map record the `taskBudgetId` each entry was created under and
> `authorizeX402`/`fetch`/`payX402Quote`/`resumeAuthorizedX402` throw the new
> typed `X402TaskBudgetMismatchError` before any network call. No authority
> moves: the comparison only reports an attribution mismatch the replay used
> to hide — the caller, Haven and the enforcers keep exactly their previous
> powers, and no signature, key role or on-chain surface changes. The rest of
> this document was not re-read for it, and `last-verified` is not bumped.

> **Re-verified (#3330, 2026-09-28):** §10 is AMENDED, not loosened: the
> redemption allowlist admits exactly one more chain shape — the three-link
> sub-budget chain `[sub grant, parent child, budget]` (leaf a real grant TO
> this signer's account from the delegating agent A, middle link A's
> self-delegated narrowing of its own budget, budget link unchanged) — and a
> new typed-data class, the sub-budget child, joins the task child as a
> flow-keyed `haven_sign` signable (`sub_budget_id`), verified by
> `assertOwnSubBudgetChild`/`assertOwnSubBudgetCloseUserOp`
> (`sub-budget-guards.ts`, now named in this document's coverage list). A
> sub-budget child can only
> NARROW its parent (periodAmount ≤ the parent's on the SAME
> periodDuration/startDate window, expiry ≤ the parent's, a recipient pin
> never unpinned), so the chain B redeems is as or more restrictive than the
> two-hop task chain and every hop's caveats still AND into the one
> redemption — the DelegationManager, not Haven, meters the spend. Issuance
> is owner-governed (decision log 2026-09-27: owner co-signs each sub-budget;
> A's delegate key only signs within the owner-approved envelope), so an
> agent still never signs authority for another account's delegator side. The
> signer's x402 arm is unchanged: a three-link redemption moves through
> `haven_sign`'s flow-keyed channel, and the settlement-child verifier's
> shape routing (never a self-delegation, never a root) is untouched. Every
> refusal case is pinned in `redemption-guard.test.ts`. Scope of this note:
> `redemption-guard.ts`, `sub-budget-guards.ts`, `settlement-child.ts`'s
> shape predicates, `signer/tools.ts`'s new `sub_budget_id` channel, and the
> allowlist bullets above. Nothing else in this document was re-read for it,

> **Re-verified (#3475, 2026-09-29):** an agent can report an eip3009
> payment's merchant settlement hash (`haven_report_settlement_evidence`). The
> backend verifies it on-chain with the existing
> `verifySettlementTransferTx` (a Transfer of exactly the amount, in the
> token, from the payment's delegate EOA to its merchant, mined after the
> payment's funding confirmed) and records it on the intent's metadata.
> Nothing is signed, submitted or moved, and the intent's status and funding
> hash stay. The one write is serialized per hash with the erc7710 confirm's
> advisory lock and refuses a hash another payment already holds. That check
> runs from the eip3009 side only (the erc7710 confirm reads `tx_hash`
> alone); the reverse collision would need one transaction to be both an
> account → merchant and a delegate EOA → merchant settlement. Which of two
> same-shaped payments a transfer settled is not decided, because Haven never
> sees the EIP-3009 nonce on this path: a hash can be recorded on any
> payment with the same agent, amount, token, delegate and merchant whose
> funding confirmed before the transfer was mined (within the 120 s skew),
> including one whose merchant leg failed, and that payment's receipt and
> funded-retry remedy then follow the attribution. That takes an agent
> misreporting a payment id; the record itself moves no money. A recorded settlement
> closes the funded-merchant-retry remedy (`isFundedX402AwaitingMerchantLeg`),
> so the delegate key is not asked to sign a second authorization for a
> payment whose merchant settlement is recorded. No signature, key role, delegation, caveat or on-chain surface
> changes. The rest of this document was not re-read for it, and
> `last-verified` is not bumped.

> **Re-verified (#3609, 2026-10-02):** the delegation-rail prepare 502 on
> `POST /payments` and the x402 EIP-3009 funding leg is typed
> (`prepare_reverted` / `prepare_failed`) and its `details` are bounded after
> redaction; every other response `details` built from a caught error is
> bounded the same way (`boundedErrorDetails`), including eight answers that
> were not even redacted before — the delegate sweep (four) and the
> sub-budget routes (three plus their helper's callers) and the account
> address derivation, where an RPC URL with its key could ride the response.
> A source-scan guard pins it. A response carries less of the error than
> before, never more. No authority moves: no signature, key role, delegation, caveat
> or on-chain surface changes, and the enforcer is still the gate. The rest of
> this document was not re-read for it, and `last-verified` is not bumped.

> **Re-verified (#3423 slice C, 2026-09-29):** the SDK's
> `listReceiptsPage` (and `haven_list_receipts` on both surfaces) gains an
> opt-in `compact` that drops three verbatim payload echoes from each
> read-only history row. No authority moves: no signature, key role,
> delegation, caveat or on-chain surface changes, and the default output is
> unchanged. The rest of this document was not re-read for it, and
> `last-verified` is not bumped.

> **Re-verified (#3423 slice B, 2026-09-29):** `settleX402` answers a repeated
> settle of a confirmed erc7710 row (`machine_metadata.settlement_scheme =
> 'erc7710'`, with a `tx_hash`) with a typed 409 `payment_already_settled`
> before any signing, merchant or chain step, and writes nothing. An EIP-3009
> funding row keeps the plain 409, because its `tx_hash` proves only funding.
> No authority moves: no signature, key role, delegation, caveat or on-chain
> surface changes. The rest of this document was not re-read for it, and
> `last-verified` is not bumped.

> **Re-verified (#3417, 2026-09-28):** the SDK's erc7710 `prepare()` now
> recognises `delegationReplay`'s confirmed-200 answer (`status: 'confirmed'`
> with a `tx_hash` and no `sign_data`) before its scheme check. It used to throw
> the scheme-mismatch 500 there, which the hosted MCP relayed as "transient,
> retry once". Because the confirmed branch compares only the task budget
> (#3392 above), the SDK itself checks that the row pays this merchant (`to`)
> for this resource (`resource_url`): only then does it throw the typed
> `X402Erc7710AlreadySettledError`, which the three hosted erc7710 prepare
> sites (`haven_pay_mcp_tool`, `haven_prepare_catalog_purchase`,
> `haven_pay_x402_quote`) turn into a done state that names no tool. Any other
> confirmed row, such as an EIP-3009 funding leg whose payee is the delegate
> and whose `tx_hash` proves only funding, is a 409 key collision, never
> "settled". Nothing is signed on any of these answers, before or after this
> change. A `confirmed` answer without a `tx_hash` keeps the scheme refusal.
> No authority moves: the
> backend is untouched, and no signature, key role, delegation, caveat or
> on-chain surface changes. The rest of this document was not re-read for it,
> and `last-verified` is not bumped.
>
> **Re-verified (#3419, 2026-09-29):** this diff touches two files in this
> document's coverage list, `packages/sdk/src/userop-binding.ts` and
> `packages/signer/src/tools.ts`. `TASK_SIGN_CONTEXT_VERSION` is a new
> exported constant beside `DIRECT_SIGN_CONTEXT_VERSION`: additive data — the
> backend's task sign-context version, now single-sourced for the signer's
> `SUPPORTED_TASK_SIGN_CONTEXT_VERSIONS` and the hosted/local
> `signer_compatibility` notices — that moves no signing check. In `tools.ts`
> every handler's parse became the strict re-parse `parseStrictFor` (the
> registration keeps unknown keys, so the tool layer is the refusal point)
> and `normalizeError` gained the `UNSUPPORTED_ARGUMENT` branch. An undeclared
> top-level argument produced no signature and no audit entry before — the
> old strip-mode parse dropped it before any fetch, so the call either signed
> from the declared keys alone or was refused for missing ones — and still
> produces none; what changes is only what that refusal says: structured
> `UNSUPPORTED_ARGUMENT` (`unknown_arguments`, `signer_version`, `fallback`,
> `next_action: stop_and_tell_user`) where the generic `SIGNING_ERROR` used
> to be, and where the declared keys alone were sufficient the strict parse
> now refuses a call the old signer signed without the key — a change that
> can only narrow what this signer signs. No signature, key role, delegation,
> caveat, allowlist, binding or redemption-guard claim in this document
> moves: the allowlist, the #3271 binding, the #3375 recipient pin and the
> redemption guards all run unchanged, after the parse. The rest of this
> document was not re-read for it, and `last-verified` is not bumped.
>
> **Re-verified unchanged (#3267, 2026-09-24, the Safe-era identifier rename):**
> this diff renames backend-internal identifiers to account vocabulary in the
> files this document spans: `userSafeId` → `accountId`
> (`routes/agent-delegations.ts`, `routes/hybrid-accounts.ts`,
> `infra/repositories/{hybrid-signers}.ts`,
> `rails/{hybrid-signer-actions,hybrid-account-config}.ts`), `safes` /
> `allSafes` / `ownedSafes` and the singular `safe` loop local → account
> vocabulary (`routes/transactions.ts`, one comment in
> `routes/user-accounts.ts`, prose and locals in
> `infra/repositories/{smart-accounts,transaction-history}.ts`,
> comments in `modules/accounts/mainnet-gate.ts`), the `has_bound_safe` →
> `has_bound_account` SQL ALIAS and `AgentAuthRow` field
> (`infra/repositories/agents.ts`, `middleware/agentAuth.ts`), and
> `safeExecutionRail` → `executionRail` (the `routes/payments.ts` comment).
> Re-read against the diff: every query keeps its predicates and tenant scope,
> no statement changes target, no route, handler or signing path moves, the
> `=== false` fail-closed check on the bound-account alias and the `?? true`
> legacy fallback keep their semantics, and the retired-name refusals plus the
> `/user/safes*` tombstone contract are untouched. Nothing this document
> claims about authority, custody or signing moves. Scope of this note: those
> identifier renames in the files named. Nothing else in this document was
> re-verified.
>
> **Re-verified unchanged (#3279, 2026-09-25, Safe-vocabulary copy):** copy-only
> edits in `packages/signer/src/tools.ts` and `packages/signer/src/core.ts`,
> both covered here. `haven_sign_sweep_delegate`'s agent-facing description and
> the sweep `to`-guard refusal message now name the destination as the agent's
> account (Haven wallet) and state the conditional destination check: the local
> comparison runs only when the credential carries an account address (#2247),
> and otherwise the destination rests on Haven's binding signature. The guard
> itself — the `expectedSafe &&` conditional, the `from` check, the binding
> verification and the canonical-USDC assertion — is byte-identical; the field
> comment on `expectedSafe` was reworded and the field keeps its name
> (`SweepSignatureInput` remains unexported by name). No signing, verification
> or sweep logic moves, so nothing this document claims about authority,
> custody or signing changes. Scope of this note: those copy strings. Nothing
> else in this document was re-verified.
>
> **Re-verified unchanged (#3303, 2026-09-25, client-version signal):**
> `packages/signer/src/tools.ts` and `packages/sdk/src/client.ts`, both covered
> here, change only around the sign-context read and the transport. The signer
> sends `X-Haven-Client` on its sign-context reads and maps a 426
> `client_outdated` refusal to a structured `SIGN_CONTEXT_REFUSED` with no
> signature. That is one more way for the signer to decline before signing,
> never a way to sign more. It carries a successful read's `client_update` hint
> onto the result. `HavenClient` gains a read-only `clientUpdate()` accessor,
> and its transport sends the header. §10's allowlist, the binding checks,
> `signForData` and every guard it runs are byte-identical. The backend refusal
> is **not a security layer**: the header is self-reported and unauthenticated,
> so a client that misstates its version simply gets today's behaviour. It can
> only withhold service, never widen it, and spend authority remains the
> on-chain delegation alone. Scope of this note: those files. Nothing else in
> this document was re-verified.
>
> **Re-verified unchanged (#3295, 2026-09-25, last-known balances):** this doc
> is coupled through `routes/user-accounts.ts`, whose change is comment-only:
> the funding endpoint's parity comment now states that `GET
> /balances/:accountAddress` serves a last-known balance on a failed read
> (#3295) while THIS endpoint still answers `'0'` and computes `funded` from
> it — behaviour byte-identical, the marker gap deferred by name to a
> follow-up. No handler, query, response field, or signing path moves; the
> endpoint still reads balances with the same ethers client and spends
> nothing. Nothing this document claims about authority, custody or signing
> changes. Scope of this note: that comment. Nothing else in this document
> was re-verified.
>
> **Re-verified unchanged (#3317, 2026-09-25, funding-endpoint degraded read):**
> this doc is coupled through `routes/user-accounts.ts`, whose funding endpoint
> now JOINS the #3295 degraded read instead of deferring it: a failed balance
> leg serves the last-known balance marked stale (or `'0'` marked
> `unavailable` when never read), the response carries the additive optional
> `balanceFreshness` marker, and `funded` is computed only from known values —
> an RPC blip can no longer report a funded account as unfunded. No handler,
> query, signing path or refusal moves; the endpoint still reads balances with
> the same ethers client, constructs no transfer and grants no authority, and
> budget/recipient/expiry remain enforced on-chain by the caveat enforcers.
> Nothing this document claims about authority, custody or signing changes.
> Scope of this note: that endpoint's response shape. Nothing else in this
> document was re-verified.
>
> **Re-verified unchanged (#3296, 2026-09-26, snapshot skip on unpriceable reads):**
> this doc is coupled through `infra/repositories/dashboard.ts`, whose
> `insertPortfolioSnapshot` the dashboard now calls for the first CLEAN load of
> the day only: a read the accounts module marks unpriceable (#3296, reusing
> #3292's degraded-result marker) skips the insert and logs the skip with the
> user id only, so a degraded figure can no longer stand as a day's baseline.
> The repository function, its SQL and its DO NOTHING conflict arm are
> untouched; a skipped day simply has no row. No handler, query, signing path
> or refusal moves; the snapshot decides no spend — budget, recipient and
> expiry remain enforced on-chain by the caveat enforcers. Nothing this
> document claims about authority, custody or signing changes. Scope of this
> note: which dashboard load writes the daily row. Nothing else in this
> document was re-verified.
>
> **Re-verified (0.7.0-alpha.0 release, 2026-09-29):** the release bump touches
> one file in this document's coverage list, `packages/signer/src/tools.ts`. It
> rewrites the self-reported `SIGNER_VERSION` string literal to
> `0.7.0-alpha.0` and nothing else. No signing check, refusal or allowlist
> moves in that edit. The release's changes to the signing surface (#3330,
> #3419) were each re-verified here when they merged. Nothing else in this
> document was re-verified.
>
> **Re-verified (0.8.0-alpha.0 release, 2026-10-05):** the release bump's only
> covered-file edit is the `SIGNER_VERSION` literal in `packages/signer/src/tools.ts`
> (`0.8.0-alpha.0`). No signing check, refusal or allowlist moves in that edit. The
> range's two signer changes, #3539 (sub-budget `haven_submit` handoff and consent
> text, copy-only) and #3524 (compact `haven_send`/`haven_pay` results), were
> re-verified where they merged. Nothing else in this document was re-verified.

> **Re-verified (0.12.0-alpha.0 release, 2026-10-29):** the release bump's only
> covered-file edit is the `SIGNER_VERSION` literal in `packages/signer/src/tools.ts`
> (`0.12.0-alpha.0`). No signing check, refusal or allowlist moves in that edit.
> Two commits in the range change signer source (`git log origin/main..origin/dev
> -- packages/signer/src` at `feda1617`), and both were read again for this
> release:
> - #4449 (#4462): success results name their next step, and the settlement-child
>   guidance names the MCP route. Recorded below where it merged ("Re-verified
>   unchanged (#4449 …)"); the change is guidance text and next-step fields only.
> - #4415 (#4417): a test title and assertion floor in `cli-args.test.ts`;
>   test-only, not shipped.
>
> Neither adds a signing path or widens a check. Nothing else in this document
> was re-verified.

> **Re-verified (0.11.0-alpha.0 release, 2026-10-23):** the release bump's only
> covered-file edit is the `SIGNER_VERSION` literal in `packages/signer/src/tools.ts`
> (`0.11.0-alpha.0`). No signing check, refusal or allowlist moves in that edit.
> Four commits in the range change signer source (`git log origin/main..origin/dev
> -- packages/signer/src` at `7b2cca38`). Three are recorded where they merged (#4242
> and #4248 above, #4061 below); all four were read again for this release:
> - #4242 (#4247): the binding records the shape it was minted for, and
>   `haven_x402_sign_header` builds an EIP-3009 header only from a funding-leg
>   binding. `haven_sign_x402` refuses a settlement child before signing.
> - #4248 (#4256): a settlement-child binding is retired at mint, never held,
>   and its refusal is the structured `NO_FUNDING_LEG`, checked after the
>   expected-context version.
> - #4061 (#4075): tool description text only, naming the settlement report.
> - #4325: a reworded doc comment in `audit.ts`; no code changes.
>
> All four add refusals or text; none adds a signing path or widens a check.
> Nothing else in this document was re-verified.

> **Re-verified (0.10.0-alpha.0 release, 2026-10-14):** the release bump's only
> covered-file edit is the `SIGNER_VERSION` literal in `packages/signer/src/tools.ts`
> (`0.10.0-alpha.0`). No signing check, refusal or allowlist moves in that edit.
> One commit in the range changes signer source (`git log origin/main..origin/dev
> -- packages/signer/src` at `641f527d`): #3888 (#3893), in `core.ts`. It is
> recorded above where it merged ("Since #3888 the 3009 header's nonce is
> derived, not random"), and it was read again for this release:
> - the nonce is overwritten on the unsigned payload that `preparePaymentHeader`
>   built;
> - the typed data is signed by the library's own `signPaymentHeader`;
> - the binding and expiry checks before it are unchanged.
>
> Nothing else in this document was re-verified.

> **Re-verified (0.9.0-alpha.0 release, 2026-10-09):** the release bump's only
> covered-file edit is the `SIGNER_VERSION` literal in `packages/signer/src/tools.ts`
> (`0.9.0-alpha.0`). No signing check, refusal or allowlist moves in that edit.
> The range's own signer-source changes were each recorded where they merged:
> #3728 (`haven_sign_siwx`, the delegate's Sign-In-With-X signature — moves no
> funds, approves no payment; noted above at its merge), #3727 (ready-made retry
> headers) and #3739 (description text for the request-mode probe). Two changed
> signer source without a note here, both read at this release: #3738 adds an
> advisory identity line (agent id, delegate address) to the signer's
> instructions and leaves the signing path's checks unchanged; #3722 rewords one
> consent line ("pause or revoke" → "stop the agent's budget or remove the
> agent"). Nothing else in this document was re-verified.

> **Re-verified (0.8.1-alpha.0 release, 2026-10-07):** the release bump's only
> covered-file edit is the `SIGNER_VERSION` literal in `packages/signer/src/tools.ts`
> (`0.8.1-alpha.0`). No signing check, refusal or allowlist moves in that edit.
> The range changes no file under `packages/signer/src` (`git log
> origin/main..origin/dev -- packages/signer/src` at `03e07aca` is empty); the
> signer's only shipped change is its README's network-calls section (#3662,
> documentation). Nothing else in this document was re-verified.

> **Re-verified #3331 frontend (2026-09-27, round 2 review fixes):** this diff
> touches `hooks/useDelegationBudget.ts` only. `reload`/`reloadSigners` read
> `/agents/{id}/delegations` and `/agents/{id}/account-signers`, neither
> chain-scoped, so the hook's own reset effect now clears state on an
> `agentId` change only — not a `chainId`-only rerender, which used to blank a
> still-valid signer set for no data reason. `editBudget`'s build call already
> forwarded `merchant_slug` (#3331 round 1); this diff adds a doc-accurate
> JSDoc only, no behaviour change: an edit sends the STORED recipient (the
> row's own `recipient_address`, never re-derived client-side), which the
> server compares against the merchant's CURRENT verified payTo and refuses
> (409) on a mismatch, keeping the merchant label on success — on a refusal
> the old budget stays live and untouched, exactly as the REPLACE composition
> above already guarantees. Nothing here changes which signature authorises
> what: the owner still signs the new grant, then the stop, and the delegate
> key and local signer are never touched. Scope of this note:
> `useDelegationBudget.ts`'s reset effect and JSDoc. Nothing else in this
> document was re-verified.
>
> **Re-verified #3331 frontend (2026-09-27, round 3 review fixes):** this diff
> touches one file in this document's coverage list, `hooks/useDelegationBudget.ts`,
> plus non-authority UI changes in `FundMerchantModal.tsx`, `EditBudgetModal.tsx`,
> `MerchantBudgetsList.tsx` and the merchant page that carry no authority and
> are out of this document's scope. In the covered file: `reload`'s in-flight
> guard (`manualBudgetsReloadInFlight`) changes from a boolean to a counter so
> two overlapping MANUAL reloads (e.g. a fast double click on "Try again")
> both have to finish before a background poll tick can run again — this is
> the reload() manual-vs-poll guard from the round 2 note above, on the READ
> path only: it decides whether a `GET /agents/{id}/delegations` poll fires,
> never whether a build, activation or revoke is authorised. No handler,
> query, signing path or refusal moves; budget, recipient and expiry remain
> enforced on-chain by the caveat enforcers exactly as before. Scope of this
> note: `useDelegationBudget.ts`'s manual-reload counter. Nothing else in this
> document was re-verified.
>
> **Re-verified unchanged (#3426, 2026-09-29, agent tax-declaration opt-in):**
> this diff touches two files in this document's coverage list,
> `infra/repositories/agents.ts` and `db/migrations/index.ts`, and both
> changes are SETTINGS-only by construction. The migration adds
> `agents.tax_declaration_enabled` (BOOLEAN NOT NULL DEFAULT false) and the
> index registers `103_agent_tax_declaration_opt_in.ts`; no delegation,
> budget, re-key, activation or signing query is touched. The repository
> additions are one gated owner write and one agent-scoped read: the write's
> WHERE clause gates only its own new column (switching ON requires the
> owner's company-details row to hold a VIES-valid VAT number; switching OFF
> is never gated) and the read LEFT JOINs `owner_company_details` to answer
> the agent's own declaration content — the unsigned §2.1 fields, never
> `principalId`/`principalAttributionHash` (the SDK computes those locally)
> and never a signature. Nothing this document claims about authority,
> custody or signing moves: no delegation graph shape, caveat enforcer,
> redemption guard, settlement child or signer allowlist changes, and the
> column feeds no path that authorises a payment. Scope of this note: the new
> column, its migration registration, and the two new repository functions.
> Nothing else in this document was re-verified.
>
> **Re-verified unchanged (#4435, 2026-10-26, tax-declaration toggle disabled
> for the default setup):** this diff touches one file in this document's
> coverage list, `infra/repositories/agents.ts`, and the change is
> DISPLAY-only by construction. The agents LIST read gains one correlated
> subquery — `install_status->>'runtime_mcp_mode'` from the agent's most
> recent `agent_connection_setups` row — so the Settings tab can disable the
> tax-declaration toggle for `hosted_plus_signer`: a hosted server with a
> separate signer cannot attach a declaration to a payment, so an opt-in
> there would do nothing. No delegation, budget, re-key, activation, signing
> or refusal query is touched, and the field is read by exactly one component
> (the agent Settings tab's tax-declaration toggle); nothing in the
> delegation, budget, enforcement or client-compat path reads it. The write
> path is unchanged:
> `PUT /agents/:id/tax-declaration` keeps its own gates and is still never
> gated on OFF, so an owner can always withdraw an opt-in. Nothing this
> document claims about authority, custody or signing moves: no delegation
> graph shape, caveat enforcer, redemption guard, settlement child or signer
> allowlist changes. Scope of this note: the one new subquery in the list
> read. Nothing else in this document was re-verified, and `last-verified` is
> not bumped.

> **Re-verified unchanged (#3495 review round 1, 2026-09-30):** this diff
> touches one file in this document's coverage list,
> `packages/signer/src/tools.ts` — the `USEROP_BINDING_MISMATCH` refusal's
> `nextToolOmittedReason` prose now also names the `include_signing_payload:
> true` same-key re-run as a source for relayed `typed_data`, alongside the
> existing "copied unchanged from the payment result" route. No check, guard
> or allowlist moves: `assertUserOpTypedDataBinding`'s recomputation against
> `payload_hash` still runs identically on either source of bytes, the
> refusal still signs nothing, and the on-chain redemption path is untouched.
> Scope of this note: that one string. Nothing else in this document was
> re-verified.

> **Re-verified unchanged (#3492, 2026-09-30):** `client.ts`'s
> `precheckBudget` now forwards an optional `idempotencyKey` to
> `POST /machine-payments/budget-precheck`, and the backend handler
> (`modules/mpp/budget-precheck.ts`) uses it to answer sufficient — without
> its usual `refuse()` ledger write — when the key resolves to an
> already-SETTLED erc7710 payment matching the exact quote being
> pre-checked. No signature, key, delegation graph, caveat enforcer or
> on-chain redemption path changes: the endpoint remains read/decide-only,
> the bypass activates only after re-deriving the same settled-row lookup
> `delegationReplay`'s confirmed+tx_hash branch already trusts
> (`findX402IntentByIdempotencyKey`, scoped to the caller's own agent id),
> and the on-chain ERC20PeriodTransferEnforcer stays the real gate the
> pre-check only mirrors. The rest of this document was not re-read for it,
> and `last-verified` is not bumped.
>
> **Re-verified unchanged (#3527, 2026-10-01):** the #3492 bypass above
> widens from erc7710-only to also accept a settled EIP-3009 row —
> `precheckBudget`'s doc comment now says "erc7710 OR eip3009", and the
> backend's settled-row lookup (`isSettledX402Replay`, renamed from
> `isSettledErc7710Replay`) accepts a `confirmed` row whose `tx_hash` is only
> the EIP-3009 FUNDING leg (treasury → delegate), not a merchant settlement.
> That is still the SAME fact `delegationReplay`'s own confirmed+tx_hash
> branch already answers its stored 200 for, on every settlement scheme, so
> the bypass activates on a lookup the authorize path already trusted — no
> new trust is extended. No signature, key, delegation graph, caveat
> enforcer or on-chain redemption path changes: the endpoint remains
> read/decide-only, and the on-chain ERC20PeriodTransferEnforcer stays the
> real gate either bypass only mirrors. The rest of this document was not
> re-read for it, and `last-verified` is not bumped.
>
> **Re-verified unchanged (#3506, 2026-10-01, sub-budgets user-completable):**
> the agent now submits its own sub-budget signatures. `haven_submit` accepts
> `sub_budget_id` on both MCP runtimes through the SDK's `submitSubBudget`,
> to the existing agent route `POST /sub-budgets/:id/submit`. That route
> already verified, before this change, that the signature recovers the
> DELEGATING agent's delegate key over the exact bytes Haven built, and only
> then opens a `pending` row. The owner's `POST /agents/:id/sub-budgets/:id/sign`
> relay is untouched and stays as an optional path. The decision log's new
> 2026-10-01 line records that the relay was transport, not governance;
> issuance stays owner-only and still refuses a child wider than A's budget
> before anything is signed. Agent A discovers its pending sign targets with
> `GET /sub-budgets?status=awaiting_signature`, scoped to the rows it
> delegates. Expired `pending` rows are omitted, and `closing` rows stay
> listed. The dashboard issues with the owner JWT, as the owner API already
> did. The signer's consent summary and `initialize` block now name
> sub-budget signing and its sign-context versions. That is copy only:
> `SIGNER_CONSENT_SURFACE_VERSION` stays 2, and a test pins the consent hash.
> No signature, key role, delegation shape, caveat, allowlist or redemption
> guard in this document moves. The three-link allowlist and the narrowing
> gate run unchanged. The rest of this document was not re-read for it, and
> `last-verified` is not bumped.

> **Re-verified unchanged (#3669, 2026-10-06, backend supported vs known chains):**
> - **Supported narrows.** The backend's supported set narrows to 8453 and 84532. Gnosis (100) becomes known and history-only: no deploy, relayer, monitor or ingest runs on it.
> - **The rail drops Gnosis.** `VIEM_CHAINS` drops Gnosis. The rail itself already refused chain 100 through `DELEGATION_RAIL_CHAIN_IDS`.
> - **Chiado now fails closed.** Chiado (10200) leaves the mainnet gate's testnet list, so it is classified value-bearing. The §7 recommendation logic is unchanged.
> - **Receipt-key check widens.** The passport receipt-key boot check now compares against every configured relayer key.
> - **Nothing else moves.** No delegation shape, caveat, signer, allowlist or redemption guard in this document moves.
>
> The rest of this document was not re-read for it, and `last-verified` is not bumped.

> **Re-verified unchanged (#3839, 2026-10-09, discovery funding-leg hint):**
> this doc is coupled through `packages/sdk/src/client.ts`, whose catalog
> mapping now carries `asset_transfer_methods` through to discovery as an
> additive field. Discovery also gains a `funding_leg_expected` hint read from
> that same column — the one the merchant-locked budget rule above reads per offer.
> The hint is advisory output only: no delegation shape, caveat, pin rule,
> redemption guard or settlement selection moves, and the per-offer ERC-7710
> reading above is unchanged. The rest of this document was not re-read for
> it, and `last-verified` is not bumped.

> **#3542 (2026-10-01).** Re-verified unchanged except the archive guard
> above. The archive guard and the account-delete guard
> (`HAS_LIVE_DELEGATIONS_FOR_ACCOUNT_SQL`) now count `replaced` rows as live,
> so an agent holding only a still-enabled `replaced` delegation can neither be
> filed under Removed nor orphaned by deleting its account from Haven. Agent
> reads carry `live_delegation_count`, and the dashboard uses it: the
> replaced-agents card revokes the credential and then asks for the owner's
> `revoke-all` signature, the Remove dialog decides the signature from the
> loaded delegation list rather than `agents.status`, and an agent that is
> revoked or archived with live delegations is marked with a Finish revoking
> action. Haven still signs nothing; ending a budget is still only the owner's
> `revoke-all`. The rest of this document was not re-read for it, and
> `last-verified` is not bumped.

> **Re-verified #3693 (2026-10-06, delegations remaining-this-period):** the
> covered file this diff touches is `routes/agent-delegations.ts` — its
> `GET /agents/:id/delegations` list response gains three per-row fields for
> ACTIVE delegations (`remaining_atomic`, `remaining_from_chain`,
> `period_end`; null on non-active rows) — OPT-IN via a single allowlisted
> query parameter, `?include=remaining` (anything else is a 400 from the
> enforced request schema before the handler runs): without it the response
> is the plain lifecycle list, byte-identical to the pre-#3693 shape, and
> neither the json fetch nor the chain read runs. The enrichment is
> answered by the EXISTING
> `readRemainingBudget` chain read the analytics budget views already use,
> now fed the row's signed delegation fetched server-side via
> `listDelegationJsonByIds` and excluded from the response as before
> (asserted). This is a read-only enrichment of data the owner could already
> read on-chain: the reader signs nothing, prepares nothing and redeems
> nothing; a failed or rejected read answers the FULL budget with
> `remaining_from_chain: false` (the conservative bound) and still 200; the
> reads run bounded (the analytics worker pool, four in flight) under the
> reader's existing timeouts. No route, role, ceremony or validation shape
> changes — the optional `include` parameter only chooses whether the
> display enrichment runs — and the Owner-Signature Invariant above is
> untouched — nothing here activates, revokes, rekeys or redeems anything.
> The verification entry for the two `satisfied-by` contract docs this
> change also covers is
> `docs/regulatory/casp-changelog/2026-10-06-3693.md`. Scope of this
> re-read: the delegation-list route paragraphs of this section and the
> files this change touches (`routes/agent-delegations.ts`,
> `infra/chain/delegation-budget-reader.ts`,
> `infra/repositories/delegation-budgets.ts`); `last-verified` already reads
> 2026-10-06 and the date is accurate for this re-read.

> **Re-verified #3695 (2026-10-06, Spending section):** the covered file this
> diff touches is `hooks/useDelegationBudget.ts`, on its READ path only: the
> `?include=remaining` enrichment becomes a per-caller opt-in
> (`includeRemaining`, default off). #3693 had every caller of the hook ask
> for it; now only the agent page's budget card does, so the other callers
> (connect approval, remove, superseded-agent, fund-merchant, edit) go back to
> the plain lifecycle list and no longer trigger the server-side chain read on
> each poll. Which delegations are listed, and every build, activate, edit and
> revoke call, are unchanged — no signing path, ceremony or refusal moves, and
> budget, recipient and expiry stay enforced on-chain by the caveat
> enforcers. The card renders the remaining figure as display only ("used this
> period"); a failed chain read (`remaining_from_chain: false`) is shown as
> unread, never as a measurement. Scope of this note: the hook's read path.
> Nothing else in this document was re-read for it, and `last-verified` is not
> bumped.

> **Re-verified #3723 (2026-10-07, offline receipt verification):** the covered
> file this diff touches is `packages/sdk/src/client.ts`, JSDoc-only: the
> `getReceipt()` doc comment now states that its returned
> `{ receipt, verification }` object is the endpoint's own shape and that
> `verifyPaymentReceipt` (#3723) accepts either layer — the whole object or
> `.receipt` alone. No build, signing, intent, guard or refusal path moves.
> The digest this document describes is untouched: the verifier lives in
> `packages/sdk/src/receipt.ts`, which this diff adds to the front-matter
> coverage list — the offline verifier is trust-critical, so future
> receipt.ts changes re-gate this document. Its #3723 change was re-read from
> that side — the endpoint-response wrapper is unwrapped ONE level and the
> wrapper's `verification` (Haven's own self-check) is never read, so the
> offline evidence is still the recovered delegate signature over the
> delegation digest, nothing server-asserted.
> Scope of this note: the `getReceipt()` doc comment, the new coverage-list
> entry for the verifier, and that re-read; `last-verified` is bumped for exactly
> this coverage.

> **#3747 re-verification (2026-10-07, outbound network policy only).**
> #3747 added the hosted merchant-egress policy, which touches
> `packages/sdk/src/client.ts` (an optional `merchantEgress` config and a
> getter) — on this contract's cover list. The change is network policy on
> the hosted server's own outbound connections only: it gates WHERE a
> request may connect, never whether money moves and never who may spend.
> No new spender, no new authority grant, no new spend path, no mutation of
> a signed payment intent (a refusal is pre-signing or post-relay), and the
> on-chain allowance and caveat stack remain the only spend authority (Red
> Line #4) — the hosted server stays keyless and the policy touches no key
> material. Scope of this note: the client.ts egress wiring; `last-verified`
> is not re-stamped (it already reads 2026-10-07) — this block is the scope.

> **Re-verified unchanged (#3756, 2026-10-07, refusal wording):** this diff
> touches `routes/agents.ts`, a covered file, in one human-readable string
> only: the archive 409 for a non-revoked agent with no live budget now says
> "This agent holds no live budget, so revoke it first (POST
> /agents/:id/revoke), then archive." instead of implying the agent can still
> spend. Re-read §"Archiving cannot hide a live delegation agent (#1436)": its
> claim that the refusal names the remedy that applies (`revoke-all` for live
> budgets, "revoke first" for a live credential) still holds, so the body is
> unchanged. The refusal fires on exactly the same conditions with the same
> 409. (The setup-cancel refusal in `routes/agent-connection-setups.ts`, also
> reworded, is outside the code this document covers.) No authority, signer set,
> delegation or custody path moves. Nothing else in this document was re-read
> for it, and `last-verified` is not bumped.

> **Re-verified unchanged (#3739, 2026-10-07, x402 key lookup):** this diff
> touches `packages/sdk/src/client.ts`, a covered file, with one new read-only
> method, `findX402IntentByIdempotencyKey` (`GET /x402/by-idempotency-key/{key}`,
> agent-authenticated, scoped to the calling agent, 404 for another agent's
> key, never writes). It returns an intent's id, status, scheme, amount,
> asset, network, resource URL, expiry, task budget and signing-window state so the hosted pay tool can answer a replay before
> re-probing a merchant. It creates, signs and authorizes nothing; no
> delegation, caveat, signer set or custody path moves. The rest of this
> document was not re-read for it, and `last-verified` is not bumped.

> **Re-verified unchanged (#3763, 2026-10-08, history read model):** this
> diff touches the transactions/agent-activity read model
> (`modules/transactions/`, `infra/repositories/transaction-history.ts`,
> `infra/repositories/agent-activity.ts`) and `openapi/spec.ts` so the
> dashboard's history views headline the EIP-3009 settlement hash the agent
> reported (#3475) instead of linking the funding leg as "the" payment. It
> reads `machine_metadata` it never wrote and writes nothing; no delegation,
> caveat, enforcer, signer set, budget or custody path moves, and no signing
> input is touched — `hash`/`tx_hash` keep their funding meaning everywhere,
> so no consumer can be tricked into treating a displayed link as an
> authority change. The rest of this document was not re-read for it, and
> `last-verified` is bumped to 2026-10-08 for exactly this coverage.

> **Re-verified unchanged (#3799, 2026-10-09, auth-row display field):** this
> diff touches `infra/repositories/agents.ts` (a covered path) by adding
> `a.mcp_server_name` to `AGENT_BY_API_KEY_SQL` and `AgentAuthRow` (plus the
> `mcp_server_name` pass-through on `AgentContext` in
> `middleware/agentAuth.ts`). The field is migration 067's "a display aid,
> never identity": it only personalises a `client_update.upgrade_command`
> hint string in the client-compat middleware and is read nowhere else on the
> auth path. Authentication still keys on the API-key hash; no delegation,
> enforcer, budget, signer-set or custody decision reads it, and no signing
> input changes. Scope of this re-read: this field only. The rest of this
> document was not re-read for it, and `last-verified` is not bumped.
> **Re-verified #3802 (2026-10-09, expired budgets stop counting as active —
> round 2, owner predicate):**
> this diff touches `infra/repositories/delegation-budgets.ts` (a covered
> path) to stop presenting EXPIRED grants as budgets. Every budget-VIEWING
> read now filters `expires_at > EXTRACT(EPOCH FROM NOW())` (the DATABASE
> clock, exclusive bound) beside `status = 'active'`: ONE shared fragment
> (`delegationLiveWindowSql`) joins `listActiveDelegations` (which feeds the
> dashboard, the agents routes and the agent-facing allowances read), the
> analytics budget-remaining slice, the three ops reads and the connect
> activation check. `start_date` is deliberately NOT filtered (owner
> decision 2026-10-09): a credential rotation writes a dormant "steady" row
> with a future `start_date` beside the live "carry" row, and filtering
> future starts would hide the whole budget for the carry window. The
> payment selection queries keep their own inline `start_date <= now <
> expires_at` copy — pinned by #1698's tests — so a grant is never SELECTED
> for payment before its window opens even though the views show its
> dormant steady sibling; `GET /agents/:id/delegations` keeps listing every
> status on purpose (the round-1 JS windowing there was reverted), and the
> agent-detail `DelegationBudgetCard` excludes expired rows from
> `hasActive` so the grant form shows. Nothing this document pins moves: no
> new grant, signature, signer, key or custody path; the rows' status
> values and every revoke/calldata-binding claim are untouched (the
> still-enabled sets those span `pending`/`active`/`replaced` by status in
> their own queries, not through these views); and the activation check
> plus the allowances read only ever get NARROWER than `status = 'active'`
> — an agent whose only budget expired now reports no budget (readiness
> `needs_approval`) and can no longer activate through connect, matching
> what the on-chain `TimestampEnforcer` already refuses (Red Line #4: the
> chain remains the only spend authority; the views now agree with it).
> Scope of this re-read: the sections whose claims rest on which rows the
> budget views return and on the connect activation check; the invariant,
> custody, redemption and settlement sections were NOT
> re-read (the diff touches no file that implements them). `last-verified`
> is bumped for exactly this coverage.
>
> **Re-verified unchanged (#3799, 2026-10-09, auth-row display field):** this
> diff touches `infra/repositories/agents.ts` (a covered path) by adding
> `a.mcp_server_name` to `AGENT_BY_API_KEY_SQL` and `AgentAuthRow` (plus the
> `mcp_server_name` pass-through on `AgentContext` in
> `middleware/agentAuth.ts`). The field is migration 067's "a display aid,
> never identity": it only personalises a `client_update.upgrade_command`
> hint string in the client-compat middleware and is read nowhere else on the
> auth path. Authentication still keys on the API-key hash; no delegation,
> enforcer, budget, signer-set or custody decision reads it, and no signing
> input changes. Scope of this re-read: this field only. The rest of this
> document was not re-read for it, and `last-verified` is not bumped.
>
> **Re-verified unchanged (#3806, 2026-10-09, budget caption helper):** this
> diff touches two covered files, both display-layer.
> `hooks/useDelegationBudget.ts` adds two fields to the `DelegationBudget`
> interface (`start_date`, `created_at` — Unix-second digit strings the wire
> already carries) so the dashboard can anchor refill captions on the same
> boundary arithmetic the reads use; the hook's `pickSigningPath`, its
> signer-set fetch-on-mount and its visible-only poll are untouched.
> `components/DelegationBudgetCard.tsx` moves caption wording (period words,
> usage/expired/unread captions, the reserved-for-task-budgets note) into the
> shared `lib/budget-caption.ts` helper and renders its states — no signing,
> edit, revoke or confirm path moves, and the card's #3717/#3166 refusal
> explanations stand. The period arithmetic itself moved verbatim to
> `@haven_ai/core` (backend re-export, arithmetic unchanged) and is certified
> by the casp shard for the `satisfied-by` contract doc:
> `docs/regulatory/casp-changelog/2026-10-09-3806.md`. No new spender, no new
> authority grant, no custody change (Red Line #4: the chain remains the only
> spend authority). Scope of this re-read: the two files above and the
> sections whose claims rest on the hook's signing-path selection and the
> card's display of budget state; nothing else in this document was re-read
> for it, and `last-verified` is not bumped.
>
> **Re-verified unchanged (#3845, 2026-10-09, owner-wallet surfaces polish):**
> this diff touches four covered files, all display-layer.
> `hooks/useDelegationBudget.ts` returns one more read-only value,
> `hasPasskeys` (`signers.passkeys.length > 0`, null until the signer read
> lands) — no new fetch, and `pickSigningPath`, `ready` and every signing step
> are untouched. `components/AccountSignersCard.tsx` words the wallet row by
> whether the set has a passkey; the Remove button's `wayCount < 2` gate and
> both consequence confirmations are unchanged. `components/DelegationSendModal.tsx`
> rewords its not-ready line to "Connect your account owner wallet to send."
> `components/DelegationBudgetCard.tsx` renders its failed-signer-load retry
> and its #3812 owner-wallet notice through one shared notice-row component;
> the `signersError` / `needsOwnerWallet` conditions and every Stop and Edit
> gate are unchanged.
> Elsewhere the change only rewords or de-duplicates: the remove dialog and the
> merchant-budget modal stop offering a passkey to an account that has none,
> and the edit-budget modal's retry row uses the same shared component.
> `useAgentRekey.ts` and `lib/signer.ts` are not touched. No new spender, no
> authority grant, no custody change. Scope of this re-read: the four files
> above and the sections whose claims rest on the hook's signing-path
> selection and the signers card's removal gate (§3's #3812 note, §6);
> nothing else in this document was re-read for it, and `last-verified` is not
> bumped.
>
> **Re-verified unchanged (#4049, 2026-10-16, owner money actions say
> "approve", not "sign"):** this diff is copy only. It touches four covered
> files: `components/AccountSignersCard.tsx` and
> `components/DelegationSendModal.tsx` (a cancelled-prompt toast now reads
> "Approval was cancelled."), `components/DelegationBudgetCard.tsx` (helper,
> toast and notice wording; pending sub-budget rows now name the actor,
> "waiting for the sharing agent to sign it"), and
> `hooks/useDelegationBudget.ts` (one JSDoc sentence). `pickSigningPath`,
> `ready`, every signing step, the Stop/Edit/Remove gates and the signer-set
> removal gate are untouched; no signature is added, removed or reordered. The
> owner still authorises every money action with their own passkey or wallet —
> "approve" names that act, it does not move it to Haven, and the re-key
> refusal banner still says Haven can never give that approval for the owner.
> The dated #3812 note in §3 quotes the button names of its day ("Sign new
> budget", "Sign transfer"); they now read "Approve new budget" and "Approve
> transfer", and that note is left as recorded. No new spender, no authority
> grant, no custody change. Scope of this re-read: the four files above and
> the sections that quote UI copy for them (§3's #3812 note, this run of
> notes); nothing else in this document was re-read for it, and
> `last-verified` is not bumped.
>
> **Re-verified (#3825, 2026-10-09, Settings → Signers; wallet pill leaves the
> top bar):** the covered files this diff touches are
> `domain/user-signers.ts` (new: the signer aggregation behind
> `GET /user/signers`), `routes/user.ts` (that route — owner-scoped, read-only),
> `components/PasskeyElsewhereHint.tsx` (new: the shared #1097 line),
> `hooks/useDelegationBudget.ts` (one more read-only return field,
> `passkeyElsewhere`, true only when the passkey path will sign;
> `pickSigningPath` untouched), `hooks/useAccountSigners.ts` and
> `hooks/useDelegationSend.ts` (only their `passkeyElsewhere` return, now gated
> on the passkey path the same way; `pickSigningPath` untouched),
> `components/DelegationSendModal.tsx` and `components/DelegationBudgetCard.tsx`
> (both render the shared hint), and `components/AccountSignersCard.tsx`. The
> card hides the owner address behind "Show address" and the passkey key ids
> entirely, and links to Settings → Signers; its Remove gates
> (`wayCount < 2`), both consequence confirmations, the enrolment action and
> its in-flow wallet connect are unchanged. Outside the coverage list, the
> top bar no longer renders the wallet pill (it stays in the connect flow's
> approval step), and the backend adds the read-only `GET /user/signers`
> described in §6's read surface. §6's wording about the "header wallet pill"
> was updated in place; `useAccountOperationGate`, `pickSigningPath` and every
> signing step are untouched. No new spender, no authority grant, no custody
> change. The #1969 paragraph's "disclosed in the wallet menu" was rewritten
> in place: with the pill gone the menu no longer opens for a ready user, so
> each owner-signing flow now shows the #1097 cross-device line itself — a
> hint beside a working action, never a gate. Scope of this re-read: §6 (read
> surface, the #1969 paragraph and the `wrong_wallet` paragraph) and the
> #3812 note in §3; nothing else in this document was re-read for it, and
> `last-verified` is not bumped.

> **Re-verified (#3813, 2026-10-10, server-saved "Needs you" dismissals):** this
> diff touches one file in this document's coverage list,
> `packages/backend/src/routes/user.ts` — it adds `GET`/`POST
> /user/attention-dismissals` (migration 111's `attention_dismissals` table
> behind them). Both endpoints are presentation-only: a dismissal hides a
> nagging dashboard row and nothing else — it grants no spending ability, does
> not touch `pickSigningPath`, budgets, allowances, signers or any §3/§6
> surface, and no payment-path code reads the table. The POST is scoped to the
> JWT subject with an ownership `EXISTS` against `smart_accounts`/`agents`, so
> a dismissal can never be planted for another user's account or agent, and
> the spec's `oneOf` body plus the table's CHECK refuse every kind except the
> two owner-approved ones. No new spender, no authority grant, no custody
> change. Scope of this re-read: the `routes/user.ts` coverage and the
> endpoints above; nothing else in this document was re-read for it.
> `last-verified` is bumped to 2026-10-10 for exactly this coverage.

> **Re-verified (#4324, 2026-10-23, "Needs attention" acknowledgements):** the
> #3813 note above says the spec's `oneOf` body and the table's CHECK "refuse
> every kind except the two owner-approved ones". That is no longer true:
> migration 118 widens the CHECK, and the `oneOf` gains `budget-reached`,
> `budget-usage`, `budget-scope`, `payments-failed` and `haven-paused`
> (owner decisions on epic #4322, 2026-10-23). The note stays as written; this
> one supersedes that sentence. What the change touches in this document's
> coverage: `routes/user.ts` (the POST now dispatches per kind and refuses a
> kind it does not know) and `infra/repositories/dashboard.ts` (the overview's
> 7-day refusal buckets also return each bucket's latest `created_at`, and the
> failed-intent read returns the latest recorded step of any failed intent in
> the window). The properties the #3813 note relies on still hold: an
> acknowledgement hides a dashboard row and nothing else, no payment-path code
> reads the table, the per-agent writes select through an ownership `EXISTS`
> against `agents`, the user-level rows carry no foreign id, and every row is
> scoped to the JWT subject. No new spender, no authority grant, no custody
> change. Scope of this re-read: the `routes/user.ts` endpoints and the two
> `infra/repositories/dashboard.ts` statements above; nothing else in this
> document was re-read for it, and `last-verified` is not bumped.
>
> **Re-verified (#4378, 2026-10-25, `payment_intents.failed_at`):** the
> #4324 note above describes the failed-intent read as returning "the latest
> recorded step of any failed intent in the window". That is no longer the
> whole truth: migration 120 adds `payment_intents.failed_at` and the three
> failure writers in `infra/repositories/payment-intents.ts` stamp it, so
> `FAILED_INTENTS_7D_SQL` now returns the true failure time where one is
> stamped and the recorded-step fallback only for pre-120 rows. The item
> this document's presentation rests on is unchanged — the read is still
> scoped to the JWT subject's rows, nothing on the payment path gates on
> `failed_at`, and the writers' CAS guards are untouched. No new spender, no
> authority grant, no custody change. Scope of this re-read: migration
> `120_payment_intents_failed_at.ts`, the three writer statements and
> `FAILED_INTENTS_7D_SQL`; nothing else in this document was re-read for it,
> and `last-verified` is not bumped.

> **Re-verified unchanged (#3895, 2026-10-12, connect-step failure copy):**
> this diff touches one covered file, display-layer only:
> `components/DelegationBudgetCard.tsx` passes the budget grant's failure
> sentence to the shared grant control as a prop instead of that control
> hard-coding it — so each surface renders the verb of its own button. This
> card's sentence is byte-identical to the one that was hard-coded ("Haven
> could not set the budget. Nothing changed — try again."); the connect
> modal's approval step now passes its own approve-verb sentence through the
> same prop. No signing step, gate, input or authority surface moves; the
> grant call and its inputs are untouched, as are the Stop and Edit paths.
> No new spender, no new authority grant, no custody change (Red Line #4:
> the chain remains the only spend authority). Scope of this re-read:
> `DelegationBudgetCard.tsx` and the sections whose claims rest on the
> card's grant rendering; nothing else in this document was re-read for it,
> and `last-verified` is bumped to 2026-10-12 for exactly this coverage.
>
> **Re-verified unchanged (#3772 part 1, 2026-10-13, supersession record):**
> this diff touches `infra/repositories/agents.ts` (a covered path) by adding
> `markAgentsSuperseded` / `findAgentSupersession` over two new nullable
> `agents` columns (migration 112, `superseded_by_agent_id`, `superseded_at`).
> A connector `--replace` reports the ids it retired with the NEW agent's API
> key, within 30 minutes of that setup's registration; the UPDATE is scoped to
> the setup's own user and excludes the reporter, so an agent credential can
> only put a warning on a sibling of its own owner, and only while freshly
> connected.
> The record is read nowhere on the auth path (`AGENT_BY_API_KEY_SQL` is
> untouched) and by no delegation, enforcer, budget, signer-set or custody
> decision: the superseded agent keeps its key, status and on-chain budget,
> and removal stays the owner-authenticated control. This is not the
> "agent editing its own authority" the re-key routes refuse — nothing about
> any agent's authority is edited. Scope of this re-read: this repository
> change only; nothing else in this document was re-read for it, and
> `last-verified` is not bumped.

> **Re-verified unchanged in authority, narrowed in evidence (#3925,
> 2026-10-14, agent-reported EIP-3009 settlement attribution):** a merchant
> settlement hash is recorded on an x402 EIP-3009 payment only if the reported
> transaction burned an `AuthorizationUsed(delegate, nonce)` nonce provably
> bound to THAT payment — derived from the payment's id (the #3888 sweep,
> which now passes its own proof explicitly) or signed by the payment's
> delegate in the X-PAYMENT header the settlement report posts
> (`eip3009SettlementProofFromHeader`: header decode, delegate signer check
> via the pinned token EIP-712 domain, then the verifier's new check 9
> matching the receipt's `AuthorizationUsed`). The trusted set is unchanged —
> the chain and Haven's payment row; the agent's `payment_id`, `txHash` and
> header stay untrusted inputs that only NAME what to verify. What closes is
> the shape-only residual where a hash could be recorded on any same-shaped
> payment whose funding confirmed in the window: a same-shaped sibling report
> is now refused (a burned nonce equal to a sibling's derived nonce is
> refused by name, "settles another payment"), and a report with no header,
> a wrong-signer header, or a receipt with no `AuthorizationUsed` from the
> payment's token is refused rather than attributed by shape. No signature,
> key role, enforcer or custody path moves; the residual that remains is the
> accepted one (a merchant that never settles records nothing; the
> notBefore/notAfter funding window stays the funding bound; a random-nonce
> pre-#3888 payment is unattributable on both paths). Scope of this note:
> `packages/backend/src/infra/chain/settlement-transfer-verifier.ts`,
> `modules/x402/eip3009-settlement-evidence.ts`, `modules/mpp/evidence.ts`,
> `infra/repositories/x402-authorizations.ts`; the rest of this document was
> not re-read for it, and `last-verified` is not bumped.

> **Re-verified unchanged in authority, narrowed in evidence (#4061,
> 2026-10-19, the #3925 proof header reaches the backend):** the note above
> assumed that settlement reports post the X-PAYMENT header. None did. The SDK
> posted it with its funding report only, and the hosted plain-HTTP report
> tools had no parameter for it. Now:
>
> - `haven_report_x402_outcome` and `haven_report_settlement_evidence` take
>   `payment_header`, and the SDK's settlement reports post the header their
>   retry sent;
> - a header-less report's 409 carries `error_code:
>   "settlement_proof_header_missing"`;
> - one further misattribution is refused. Payment B's report could carry
>   same-agent sibling A's header together with A's settlement. The delegate
>   is the same, so that passed the signer check, and the burned-nonce check
>   too, and was recorded on B. `observeEip3009MerchantSettlement` now
>   refuses a non-derived proof nonce that is a sibling's derived nonce,
>   before the chain is read.
>
> A further gap is closed. Check 9 now pairs the burned nonce with its own
> transfer: the `Transfer` immediately after its `AuthorizationUsed`, which
> is FiatToken v2's emit order, pinned against a live Base Sepolia receipt.
> Before this, a transaction settling two of a delegate's authorizations
> could lend one nonce the other's transfer. The pairing is FiatToken-specific
> (`AuthorizationUsed` immediately before its own `Transfer`); a token with
> another emit order fails closed, refused rather than verified. The hosted tools also forward
> an agent's header only on the eip3009 settlement branch, which never
> stores it. And the sibling scan is scoped to the same delegate.
>
> The trusted set is unchanged, and the header stays an untrusted input that
> only names what to verify. No signature, key role, enforcer or custody path
> moves. The new checks only refuse. Residual: a non-deriving client's random
> nonce cannot be tied to a sibling, and the burned-nonce check (now paired
> with its own transfer) still binds it to a header the delegate signed.
> Scope of this note: `infra/chain/settlement-transfer-verifier.ts`,
> `modules/x402/eip3009-settlement-evidence.ts`, `modules/mpp/evidence.ts`,
> `infra/repositories/x402-authorizations.ts`, and the SDK's settlement-report
> call sites. The rest of this document was
> not re-read for it, and `last-verified` is not bumped.

> **Re-verified #3967 (2026-10-14, the quote-time budget gate):** the diff
> touches `packages/sdk/src/client.ts` (covered): `precheckBudget` gains an
> optional `recordRefusal` input, and the quote surfaces call it with
> `recordRefusal: false` so a QUOTE never writes a `payment_refusals` row —
> a quote is a read, and the later prepare records its own refusal if the
> agent goes ahead. The quote-time check is advisory and fail-closed on
> authority: its only STOP outcome (a decided 403) is a refusal the
> delegation-rail enforcer (`evaluatePeriodPrecheck`, delegation-authorize)
> would reach at redemption anyway; an unavailable check fails OPEN with an
> `AllowanceCheckUnavailable` warning; and the skip guards (chain mismatch,
> no agent, retired rail) exist so the quote cannot refuse on a question it
> did not ask. No signing, key-role, enforcer or custody path moves. Scope
> of this note: `packages/sdk/src/client.ts`,
> `packages/mcp-server/src/tools/support/quote-response.ts` (the shared
> `runQuoteBudgetPrecheck` / `quoteBudgetCheckFields` helpers the three
> quote surfaces call), `packages/backend/src/modules/mpp/budget-precheck.ts`;
> the rest of this document was not re-read for it, and `last-verified` is
> not bumped.

> **Re-verified #3988 (2026-10-15 — the received sub-budget display read).**
> The diff touches covered paths: `infra/repositories/sub-budgets.ts` gains
> `RECEIVED_GRANTS_FOR_AGENTS_SQL` / `listReceivedGrantsForAgents` — the
> qualifying-chain verdict the display surfaces share (a real grant — never
> a self row — open and unexpired, hanging from a live parent-child row
> (`openSubBudgetSql` twice), carved from the parent agent's currently
> SPENDABLE budget delegation via `spendableDelegationSql` with
> `requireStarted: true`, the payment selectors' own window) — and
> `infra/repositories/dashboard.ts` now delegates to it;
> `routes/agents.ts` and `routes/agent-sub-budgets.ts` add read-only
> endpoints/fields that serve it. Every change is a read, and the verdict
> NARROWS what a display presents as spendable toward what
> `checkSubBudgetForPayment` already refuses — nothing refused becomes
> allowed, and no signing path, permission or custody surface moves. Scope
> of this note: those reads and the additive `Agent.receivedSubBudgets`
> wire field. Nothing else in this document was re-verified;
> `last-verified` already reads 2026-10-15.

> **Re-verified #4062 (2026-10-19 — a plain tool error after funding is a
> rejection, never `settled: true`).** The diff touches one file in this
> document's coverage list, `packages/sdk/src/client.ts`, and none of its
> authority, custody or signing surfaces. `completeX402MerchantCall`'s
> `merchantAccepted` gate now treats a PLAIN `isError: true` tool result —
> neither a #3118 payment-required challenge nor a settlement receipt
> (`PAYMENT-RESPONSE` header or `_meta` transaction) — as a rejection after
> funding: `ok: false`, the reconciliation event is recorded, and the hosted
> refusal maps to MERCHANT_REJECTED_AFTER_FUNDING with verify-then-sweep
> guidance. A tool error BESIDE a settlement hash stays accepted (the money
> moved); a JSON-RPC `error` envelope stays `ok` (#3155 S4 scope, unchanged).
> No signature is produced or consumed, nothing becomes signable, no spend
> decision moves: the change reclassifies a false SUCCESS into the refusal it
> already was on every other merchant answer, which narrows what the agent is
> told, not what anyone may spend. The local-path twin in
> `merchant-completion.ts` is outside this document's coverage list. Scope of
> this note: that acceptance gate. Nothing else in this document was
> re-verified; `last-verified` is bumped to 2026-10-19 for exactly this
> coverage.

> **Re-verified #4120 (2026-10-20 — one shared post-funding merchant-answer
> decision; the hosted hash rule becomes the local rule).** The diff touches
> one file in this document's coverage list, `packages/sdk/src/client.ts`, and
> none of its authority, custody or signing surfaces. The shared decision the
> diff extracts now lives in a new SDK module (`merchant-answer.ts`) that both
> the hosted call and the local retry call; that module and the local-path
> twin in `merchant-completion.ts` are outside this document's coverage list,
> as the #4062 note above already records for the twin. On the D1 input — a
> `PAYMENT-RESPONSE` header with no transaction (or an empty header) beside a
> `_meta` settlement that has one — the HOSTED path now behaves as the local
> path always has: an `isError` answer beside a `_meta` settlement is accepted
> (delivered as evidence, not `MERCHANT_REJECTED_AFTER_FUNDING`); without
> `isError` the result carries the `_meta` settlement hash, the #3764 second
> report is posted with it, and an erc7710 (`noFundingLeg`) completion anchors
> its evidence on it. A header WITH a transaction still wins over a different
> `_meta` transaction on both paths. The 200 `text/plain` `isError` divergence
> stays per caller (hosted parses and rejects; local never reads and accepts).
> No signature is produced or consumed, nothing becomes signable, no spend
> decision moves: the flipped cases classify a merchant answer to a call the
> funding leg already paid for, and the backend still verifies every reported
> hash on-chain before recording it — a wrong or hostile hash is a refused
> report, not a recorded settlement. Scope of this note: the shared acceptance
> gate. Nothing else in this document was re-verified; `last-verified` is
> bumped to 2026-10-20 for exactly this coverage.

> **Re-verified #4026 (2026-10-16 — own-account recipients in the owner send
> flow).** The diff touches one file in this document's coverage list,
> `packages/frontend/src/components/DelegationSendModal.tsx`: the send flow
> now offers the user's OTHER registered accounts on the SENDING account's
> chain as one-tap recipients (by name, deduped by address), prefilling the
> same `recipient` state the manual address input already fed. No new
> authority, signature, or fetch path: the send still goes through the
> unchanged `useDelegationSend` prepare/submit against
> `transfers/prepare|submit`, and `encodeTransfer`'s recipient rule is
> unchanged — any valid non-zero address, "bounded by nothing but the
> owner's signature" — so an own-account target was always permitted; the
> UI merely stops requiring the user to paste an address they already own.
> The chain filter is client-side presentation (a cross-chain own account is
> simply not offered); it adds no restriction the backend enforces, which is
> consistent with the owner-send model above. Nothing that decides who
> signs, what may be spent, or when revocation bites changed. Scope of this
> note: the send-flow recipient selection and the unchanged hook it feeds;
> `last-verified` is bumped to 2026-10-16 for exactly this coverage.

> **Re-verified unchanged (#4570, 2026-10-31 — the "signers" clause is gone):**
> this diff is copy only, in one covered file. `components/NewAccountDialog.tsx`
> now reads "Passkeys and wallets, in Settings, shows which accounts each one
> approves." — the Settings section's own name, per the 2026-10-30 decision that
> "signers" never appears in user copy (CG:129). The same slice rewords the
> device-login disclosure's "change your signers" to "change who can approve"
> (`app/(authenticated)/device/DeviceApprovalClient.tsx`), which keeps its
> meaning: a device login still cannot change the account's approval set. No
> signing step, signer-set gate, `pickSigningPath` branch or passkey ceremony is
> added, removed or reordered; the dialog still asks for ONE assertion and no
> new passkey, and the new account's only signer is still the passkey that
> assertion picks. No new spender, no authority grant, no custody change. Scope
> of this re-read: those two files' copy and §5 (copy rules); nothing else in
> this document was re-read for it, and `last-verified` is not bumped.

> **Re-verified unchanged (#4571, 2026-10-31 — the New account dialog's copy
> is two sentences):** this diff is copy only, in one covered file.
> `components/NewAccountDialog.tsx` compresses the three #4024 facts into two
> sentences ("Secured by the passkey you use next: …" and "Backups don't carry
> over: …") and moves the third — "Nothing is set up on {network} yet …" — to
> the dialog's created state, which is the new account's first screen. The
> "Signers, in Settings" clause stays, folded into the backups sentence, for
> #4570 to rename. No signing step, signer-set gate, `pickSigningPath` branch
> or passkey ceremony is added, removed or reordered; the dialog still asks for
> ONE assertion and no new passkey, and the new account's only signer is still
> the passkey that assertion picks. No new spender, no authority grant, no
> custody change. Scope of this re-read: that one file's copy and §5 (copy
> rules); nothing else in this document was re-read for it, and
> `last-verified` is not bumped.

> **Re-verified unchanged (#4168, 2026-10-20 — say "passkey", never a
> platform name):** this diff is copy only. It touches three covered files:
> `components/AccountSignersCard.tsx` (the "Add a backup passkey" subtext now
> reads "Approve with your passkey (usually your device's screen lock)."),
> `components/NewAccountDialog.tsx` (the first fact drops the platform list:
> "Your device asks for it once, and it becomes …") and
> `components/DelegationSendModal.tsx` (module JSDoc only: "a dismissed
> passkey prompt is a neutral cancel"). No signing step,
> signer-set gate, `pickSigningPath` branch or passkey ceremony is added,
> removed or reordered; the owner still approves with their own passkey or
> wallet, and the new account's only signer is still the passkey the
> assertion picks. No new spender, no authority grant, no custody change.
> Scope of this re-read: the three edits above and §5 (copy rules), which
> quotes no platform name; nothing else in this document was re-read for it,
> and `last-verified` is not bumped.

> **Re-verified unchanged (#4226, 2026-10-22, agent detail tabs and the
> Spending hero):** this diff touches two covered files, display-layer:
> `components/DelegationBudgetCard.tsx` and `components/haven/BudgetMeter.tsx`
> (the latter brought under this document by the same change; corrected by
> #4249). The card is rebuilt on the
> dashboard's money-card pattern (budgets left, Last 30 days right, one
> `Card.Section divided`, stacked below `lg`); each budget's caption moves to
> the shared `budgetCaptionFor` `row` style — the same text the dashboard row
> renders, with one test pinning the two surfaces identical — and a paused
> agent adds the shared pause line under the caption with a muted meter.
> Stop moves into a per-budget ⋯ menu beside Edit: the menu item's only
> action is `setConfirmOpen(true)`, so the same confirm still stands between
> the click and the signature, one irreversible action per menu. "No budget
> yet" becomes a collapsed needs-setup state that still opens the grant form
> (and the `?grant=` prefill), `#delegation-budget-card` survives, the
> statsLoading skeleton is display-only, and `BudgetMeter` gains a `tone`
> prop whose `brand` default renders the exact className it rendered before.
> No signing, edit, revoke or confirm path moves; no fetch or write is added
> or removed; the #3717/#3166 refusal explanations, the failed-signer-load
> retry and the #3812 owner-wallet notice stand. No new spender, no new
> authority grant, no custody change (Red Line #4: the chain remains the
> only spend authority). Scope of this re-read: the card diff above and the
> sections whose claims rest on the card's display of budget state (§3's
> caption and liveness notes, this run of card notes); nothing else in this
> document was re-read for it, and `last-verified` is bumped to 2026-10-22
> for exactly this coverage.

> **Re-verified unchanged (#4260, 2026-10-22, Last 30 days at the
> secondary-figure size):** this diff touches one covered file,
> display-layer: `components/DelegationBudgetCard.tsx`. Only the hero's
> right half (`LastThirtyDays`) and its loading skeleton change: the spent
> figure, payment count and last-paid age render as three labelled figures
> at 20px, and the merchant label moves to its own "Last paid to …" line.
> The figures read the same overview stats as before, through the same
> #4209 merchant helper (never an address). No budget row, caption, meter,
> menu, confirm, signing, edit or revoke path moves; no fetch or write is
> added or removed. No new spender, no new authority grant, no custody
> change (Red Line #4: the chain remains the only spend authority). Scope
> of this re-read: the card diff above and the previous note's card
> display claims; nothing else in this document was re-read for it, and
> `last-verified` stays 2026-10-22.

> **Re-verified unchanged (#4274, 2026-10-22, hero reads net + Activity
> summary count):** this diff touches one covered file, display-layer:
> `components/DelegationBudgetCard.tsx` (the hero's `LastThirtyDays` now
> reads `d30.net` — the same #3803 net figure the dashboard's money card
> and agents section read — with an unpriced-bucket-with-net-0 rendering
> "—", `Amount amount={null}`, and no new unpriced note) and, outside this
> document's coverage, `AgentActivityTab.tsx` (its ListToolbar `summary`
> prop removed per owner decision (a) — no "Out <total>" figure; the
> toolbar's count stands alone). No budget row, caption, meter, menu,
> confirm, signing, edit or revoke path moves; no fetch or write is added
> or removed; the read stays a display-only projection of the overview wire
> the card already carried. No new spender, no new authority grant, no
> custody change (Red Line #4: the chain remains the only spend authority).
> Scope of this re-read: the card diff above and the previous notes' card
> display claims; nothing else in this document was re-read for it, and
> `last-verified` stays 2026-10-22.

> **Re-verified unchanged (#4261, 2026-10-22, Edit/Add budget into each
> budget's ⋯ menu):** this diff touches one covered file, display-layer:
> `components/DelegationBudgetCard.tsx`. The per-budget menu now holds Edit
> budget (`onEdit`, the #3166 modal — unchanged), Add budget (`openForm`,
> the collapsed grant form — unchanged) and Stop budget…; the visible Edit
> button and the list's Add budget button are gone. The Stop item's only
> action is still `setConfirmOpen(true)`, so the #3717 confirm still stands
> between the click and the signature. The trigger is now disabled only
> while `busy`: with no reachable signer the menu opens and the Stop item
> is the disabled element, while Edit and Add open controls that gate their
> own signature behind the #3812/#3812-style connect hints (the form's
> `notReadyHint` and the modal's review-step hint) — a dead menu item does
> not become a new spending path, and nothing signs without `ready`. Focus
> plumbing (collapse returning to the originating trigger via a
> `data-budget-trigger` lookup, a `?grant=` prefill falling back to the
> first row's trigger or Set budget, then the section heading) moves no
> state. No signing, edit, revoke or confirm path moves; no fetch or write
> is added or removed. No new spender, no new authority grant, no custody
> change (Red Line #4: the chain remains the only spend authority). Scope
> of this re-read: the card diff above and the sections whose claims rest
> on the card's affordances (this run of card notes, the #3812 owner-wallet
> notice); nothing else in this document was re-read for it, and
> `last-verified` stays 2026-10-22.

> **Re-verified unchanged (#4371, 2026-10-23 — a JSDoc in the SDK client).**
> The `getPostPurchaseAllowanceSummary` JSDoc in `packages/sdk/src/client.ts`
> keeps that it reuses the read path `getAllowances` uses, and drops the claim that
> #1306's catalog-purchase preflight reads it too: since #3054 that preflight
> calls `POST /machine-payments/budget-precheck`. JSDoc only: no signing,
> settlement, budget read or authority path changes. Scope of this note: that
> comment. Nothing else in this document was re-read for it.

> **Re-verified unchanged (#4379, 2026-10-23 — import paths and one constant's
> home).** `modules/x402/delegation-authorize.ts` and
> `modules/mpp/budget-precheck.ts` now import `refuse`, the refusal-ledger
> classifiers and the prepare-failure helpers through `../payments/index.js`
> rather than private payments files. `MAX_SETTLEMENT_WINDOW_SECONDS` (600) is
> now defined in `domain/x402-settlement-timing.ts` and re-exported unchanged
> by `modules/x402/x402-delegation.ts`, which still clamps the settlement
> child's window with it; the new file joins the paths this document's front
> matter covers, and the money-path globs. No delegation, caveat, enforcer term, settlement
> window, budget pre-check or refusal changes. Scope of this note: those lines.
> Nothing else in this document was re-verified.

> **Re-verified unchanged (#4387, 2026-10-24 — a JSDoc in
> `packages/backend/src/routes/agent-rekey.ts`).** The route's "Where the SQL
> is" comment no longer refers to a `dep-lint-exempt` waiver the file does
> not carry: the completion runs as one `withTransaction` inside
> `completeRekey` in `infra/repositories/agent-rekeys.ts`. Comment
> only: no re-key step, revocation order, credential swap or delegation
> changes. Scope of this note: that comment. Nothing else in this document was
> re-verified for it.

> **Re-verified unchanged (#4400, 2026-10-24 — the agent Spending hero's
> Last 30 days layout in `packages/frontend/src/components/DelegationBudgetCard.tsx`).**
> The three figures (Spent, Payments, Last paid) take two rows below `sm`
> instead of three equal tracks; from `sm` they sit across in equal thirds,
> Spent's track widening past its third only when its figure needs it
> (`minmax(max-content,1fr)`). The Spent cell drops `break-words`,
> because the shared money figure is now `whitespace-nowrap`; the loading skeleton
> takes the same shape. Layout only: no budget read, figure, caption,
> delegation, revoke, grant or edit path changes. Scope of this note: that
> grid. Nothing else in this document was re-verified for it.

> **Re-verified unchanged (#4353, 2026-10-25 — `GET /dashboard/overview`
> gains a per-agent `budgetEndedAt` and splits `delegation_expired` out of the
> refusal `budget` bucket).** Both are display-only reads in
> `infra/repositories/dashboard.ts` / `routes/dashboard.ts`: the first is a
> grouped `SELECT` over the agent's `active` `agent_delegations` rows whose
> `expires_at` has passed, on the agent's own account chain (liveness doubled
> in SQL and in the route, so a live row is never reported as ended), the
> second regroups existing `payment_refusals` counts. Nothing writes, signs,
> selects a delegation for payment or widens authority; the enforcers
> (including the TimestampEnforcer) remain the only gate on an expired
> redemption, and the user-level `budgetStops` figure is unchanged. Scope of
> this note: those two reads. Nothing else in this document was re-verified
> for it.

> **Re-verified unchanged (#4429, 2026-10-26 — a stored display colour on
> `agents`, migration 121).** The covered files this diff touches are
> `infra/repositories/agents.ts` and `infra/repositories/dashboard.ts`, and in
> both the change is one added `SELECT` column (`a.avatar_tint`) plus the
> matching row-shape field. The column is `SMALLINT NOT NULL CHECK
> (avatar_tint BETWEEN 1 AND 6)`, filled by a `BEFORE INSERT` trigger from the
> lowest tint no held agent of that user holds, handed to a replacement by an
> `AFTER UPDATE OF superseded_by_agent_id` trigger (dropped by 122, #4448 — see
> the note below), and backfilled once. It is
> display data on the same boundary as `labels` (#3167) and `organization_id`
> (#3164): no delegation, caveat, enforcer term, budget pre-check, allowance,
> settlement window or refusal reads it, and the inherit trigger's `UPDATE` is
> scoped to the replacement's own `id` and `user_id` and to a held row, so it
> cannot recolour a released agent or cross a tenant. No route, signing,
> revocation or grant path changes. Scope of this note: those two reads and the
> migration. Nothing else in this document was re-verified for it.

> **Re-verified unchanged (#4448, 2026-10-29 — a superseded agent keeps its
> tint, migration 122).** The covered files this diff touches are
> `infra/repositories/agents.ts` (the unarchive statement) and the migration
> directory. 122 drops the `agents_inherit_avatar_tint` trigger and its
> function, redefines `agent_holds_avatar_tint` to `archived_at IS NULL` alone,
> and backfills the collisions 121 left behind; `UNARCHIVE_AGENT_SQL` may
> reassign a tint on unarchive when another non-archived agent of the same user
> holds it. All of it is display data on the same boundary as `labels` (#3167)
> and `organization_id` (#3164): no delegation, caveat, enforcer term, budget
> pre-check, allowance, settlement window or refusal reads `avatar_tint` or
> `superseded_by_agent_id`, and the unarchive statement's tint `CASE` is scoped
> to the row's own `id` and `user_id`. No route, signing, revocation or grant
> path changes. Scope of this note: that statement and the migration. Nothing
> else in this document was re-verified for it.

> **Re-verified unchanged (#4449, 2026-10-26 — the signer's success next-step
> family).** The covered files this diff touches are
> `packages/signer/src/tools.ts` and `packages/signer/src/no-funding-leg.ts`, and
> in both the change is guidance only: six success results gain the `next_tool`
> family (or a literal `next_tool_omitted_reason`), and the settlement-child
> prose names the MCP-merchant settle beside the plain-HTTP one. No signing
> decision, typed-data check, allowlist, binding, delegation, caveat, enforcer
> term, budget pre-check, allowance, settlement window or refusal changes;
> `SUPPORTED_X402_EXPECTED_VERSIONS` is untouched and no field is removed.
> Scope of this note: those two files. Nothing else in this document was
> re-verified for it, and `last-verified` already reads 2026-10-26.

> **Re-verified unchanged (#4476, 2026-10-27 — the Spending section's
> description is removed).** The covered file this diff touches is one,
> display-layer: `components/DelegationBudgetCard.tsx`. The private
> `SpendingHeading` loses its description paragraph (and the `retired` prop
> that only chose between two sentences); the heading stays above the card
> with the same `mb-3` gap, and the `headingRef` focus target (#4261) is
> untouched. The removed sentence ("Budgets are enforced on-chain: a payment
> over budget is declined before any money moves") was display copy, not a
> control: no delegation, caveat, enforcer term, budget pre-check, allowance,
> settlement window or refusal reads it, and the enforcement it described is
> unchanged — the chain remains the only spend authority (Red Line #4). The
> outcome is still stated where it happens, in the Activity tab's refusal row
> (`lib/refusal-reasons.ts`: "Over its budget · No money moved"). No budget
> row, caption, meter, menu, confirm, signing, edit or revoke path moves; no
> fetch or write is added or removed; no new spender, no new authority grant,
> no custody change. Scope of this note: the card diff above. Nothing else in
> this document was re-verified for it, and `last-verified` is bumped to
> 2026-10-27 for exactly this coverage.

> **Re-verified unchanged (#4491, 2026-10-27 — the budget card stops clipping
> its ⋯ menu).** The covered file this diff touches is one, display-layer:
> `components/DelegationBudgetCard.tsx`. The card root loses its
> `overflow-hidden` class so the per-budget ⋯ menu — an in-flow `absolute`
> panel, not portalled — is no longer cut off at the card's bottom edge. That
> is a paint change and nothing else: the menu's items, their handlers
> (`onEdit`, `onAdd`, `setConfirmOpen(true)`), the #3717 confirm between the
> click and the signature, the trigger's `busy` gate, and every signing, edit
> and revoke path are untouched. No fetch or write is added or removed; no
> delegation, caveat, enforcer term, budget pre-check, allowance, settlement
> window or refusal reads the class. No new spender, no new authority grant,
> no custody change (Red Line #4: the chain remains the only spend authority).
> Scope of this note: the card diff above. Nothing else in this document was
> re-verified for it, and `last-verified` already reads 2026-10-27.

> **Re-verified unchanged (#4474, 2026-10-27 — the account Security tab's
> layout, copy and which controls show).** The covered file this diff touches
> is one, display-layer: `components/AccountSignersCard.tsx`. The card loses
> its heading, intro sentence and in-card Settings row (they move to the page's
> shared section heading), the single-signer warning becomes the shared warning
> banner naming the kind of the one signer, each signer row becomes a two-line
> `Row` (kind over "Added {date}"), and the two add actions plus "Lost a
> device?" share one divided footer row. **Remove is now ABSENT
> rather than disabled while one signer remains** — the same refusal the chain
> already enforced (`CannotRemoveLastSigner`), expressed by not rendering the
> control; with two or more signers every row still carries it, and the
> existing drop-to-one confirmations still stand between the click and the
> signature. No call to `useAccountSigners` changes: `enrollBackupPasskey`,
> `enrollOwnerWallet`, `removePasskey` and `removeOwner` are invoked exactly as
> before, with the same `busy` / `ready` gates. No fetch or write is added or
> removed; no delegation, caveat, enforcer term, budget pre-check, allowance,
> settlement window or refusal reads the layout. No new spender, no new
> authority grant, no custody change (Red Line #4: the chain remains the only
> spend authority). Scope of this note: the card diff above and the page's
> Security-tab section headings. Nothing else in this document was re-verified
> for it, and `last-verified` already reads 2026-10-27.

> **Re-verified unchanged (#4470, 2026-10-27 — failure causes and the funding
> wait's outcomes).** The covered files this diff touches are
> `packages/sdk/src/client.ts`, `x402-erc7710.ts` and `x402-funding-leg.ts`.
> In the first two, the change is the error each refusal throws: the same
> guards fire on the same answers, and nothing is signed after them, but the
> errors now carry `{ kind: 'deterministic' }` through
> `HavenApiError.deterministic(...)`, so the hosted step stops instead of
> saying "re-call once". In `x402-funding-leg.ts`, the funding wait still runs
> before any merchant retry and still throws when the funding leg is not
> confirmed. A wait that times out or cannot read the chain now throws
> `FundingConfirmationUnknownError`, and a reverted receipt throws
> `FundingRevertedError`; the merchant is still never called after either.
> No signing decision, typed-data check, recipient pin, allowlist, binding,
> delegation, caveat, enforcer term, budget pre-check, settlement window,
> funding leg or sweep changes. Scope of this note: those three files.
> Nothing else in this document was re-verified for it.

> **Re-verified unchanged (#4534, 2026-10-29 — the purchase correlation key):**
> this diff touched one file in this document's coverage list,
> `packages/sdk/src/client.ts`, and none of its authority, custody or signing
> surfaces. The change rides the same seam #3778's note scopes — the ACCEPTED
> arm's `/machine-payments/evidence` report — plus the
> `reportX402MerchantOutcome` pass-through: two new OPTIONAL inputs,
> `purchaseGroupId` (≤ 128 chars, the merchant's own invoice/order id or a
> caller-chosen group key) and `merchantResponse` (the merchant's paid
> response body, read by a small explicit per-merchant map on the backend and
> never stored — only the derived id is). Both are spread into the evidence
> payload only when present, and only on an accepted outcome. They authorize
> nothing, produce or consume no signature, and no spend decision reads their
> value; the backend writes them first-write-wins onto the evidence row and
> never touches `payment_intents`, settlement or custody. A caller that
> supplies neither is byte-identical to before. Scope of this note: that one
> file. Nothing else in this document was re-verified for it.

> **Re-verified unchanged (#4563, 2026-10-30 — the Settings link label):** this
> diff touched one file in this document's coverage list,
> `packages/frontend/src/components/AccountSignersCard.tsx`, and the change is
> a JSDoc comment only: the sentence that names the page's link to Settings now
> says "Passkeys and wallets" instead of "All signers in Settings", per the
> owner's 2026-10-30 copy decision (`docs/product/copy-guidelines.md` § *The
> Settings section is "Passkeys and wallets"*). No rendered string, no prop, no
> row, no control and no flow changes — the card's own markup is untouched, and
> the link itself lives on the page above it (`AccountDetailClient.tsx`, not in
> this document's coverage). Nothing about who can approve, what is signed,
> which delegation is issued, which caveat or enforcer term applies, the budget
> pre-check, the settlement window or custody reads the label. Scope of this
> note: that one comment. Nothing else in this document was re-verified for it,
> and `last-verified` already reads 2026-10-30.

> **Re-verified unchanged (#4564, 2026-10-31 — the Set budget dialog):** this
> diff touched two files in this document's coverage list,
> `packages/frontend/src/components/DelegationBudgetCard.tsx` and
> `packages/frontend/src/components/PasskeyElsewhereHint.tsx`, and neither
> changes what is signed, who signs it, or what the signer accepts. The grant
> form moved out of the Spending card into a shared-shell dialog
> (`SetBudgetDialog.tsx`, new, outside this document's coverage) and the
> `PasskeyElsewhereHint` moved from the top of the card to the moment of
> approval — inside that dialog and in the Stop confirm. The hint's copy,
> markup and class are byte-identical; only its mount sites changed. The
> signing hooks (`useDelegationBudget.ts`) are untouched: the same
> `grant`/`editBudget`/`revoke` calls, the same owner-signature ceremonies, the
> same `slot_occupied` routing to the edit flow, the same sub-budget entry. No
> caveat, enforcer term, budget pre-check, settlement window, custody or
> authority surface changes. Scope of this note: those two files. Nothing else
> in this document was re-verified for it, and `last-verified` already reads
> 2026-10-30.
```
