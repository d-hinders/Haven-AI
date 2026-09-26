# @haven_ai/sdk

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

### Added

- **Task budgets (#3329).** Six new `HavenClient` methods — `openTaskBudget`, `getTaskBudget`, `listTaskBudgets`, `getTaskBudgetSignContext`, `submitTaskBudget`, `closeTaskBudget` — reserve, inspect, sign and close a short-lived, self-delegated child of the agent's own budget delegation, scoped to one task. `PaymentRequest`, `X402AuthorizationOptions` and `prepareX402Erc7710`'s options all gain an optional `taskBudgetId`, spending against that open task budget's own child delegation instead of the agent's budget delegation directly. New exports from `task-budget-guards.ts`: `MAX_TASK_BUDGET_TTL_SECONDS`, `isTaskChildTypedData`, `assertOwnTaskChild`, `assertOwnTaskBudgetCloseUserOp`, `hashDelegation`, and the `TaskChildTypedData` / `TaskChildExpectation` / `TaskBudgetCloseExpectation` types. `getAgentSummary()` gains a third, fail-soft read (`listOpenTaskBudgetsSummary` — an older backend or a transport failure degrades to `[]`, never throws) alongside the agent and allowance reads it already ran in parallel.

### Changed

- **Agent runbook: "If something breaks" (#3304, epic #3302).** `HAVEN_AGENT_RUNBOOK_MD` (served at `/for-agents.md`, mirrored into `@haven_ai/cli`'s `haven guide`) gains a short section: a `client_update` on a Haven result means run its `upgrade_command` and retry, `required: true` means payments are refused until you do, and the release notes live at `/releases`. Text only; no API change.

- **`signForData` / the redemption guard now accept a second chain shape (#3329).** Beyond a single budget-delegation grant made directly to the agent's own account, `assertRedeemsOwnBudgetDelegation` (and `assertBoundDirectPaymentUserOp`, which calls it) now also accepts the two-link `[task child, budget]` chain: a task-budget child self-delegated by the agent's own account, redeemed under its parent budget delegation. Any other multi-link chain, or a leaf delegated by a third party, is still refused. `HavenSigningError`'s refusal wording now names both accepted shapes instead of describing only the single-grant case.

### Removed

- **BREAKING (#3306, epic #3130) — the four deprecated `HavenPaymentReceipt` twins are gone.** `mapPaymentReceipt` no longer emits `rail`, `proofStatus`, `resourceUrl` or `merchantAddress`, and `HavenPaymentReceipt` no longer declares them. Read the survivors #3134 added in `0.5.0-alpha.0`: `source`, `paymentProofStatus`, `x402ResourceUrl`, `x402MerchantAddress` (same columns, same values). Removed under the condition #3134 wrote on `mapPaymentReceipt`: `@haven_ai/sdk` `latest`, `@haven_ai/mcp` `latest` and the hosted mcp-server's `serverInfo.version` all read `0.5.0-alpha.1`, at or above the twin-bearing `0.5.0-alpha.0`. Breaking for any reader of an old key, so the release carrying this entry takes a **MINOR** bump under the 0.x convention (`docs/operations/mcp-runtime-compatibility.md`). A `.d.ts` diff shows the type change but is blind to the matching tool-output break: `haven_list_receipts` rows lose the same four keys on both MCP runtimes. The backend wire (`RawHavenPaymentReceipt`) is unchanged; no route, no migration.

## 0.5.0-alpha.1 — 2026-09-25

- **Client identity on Haven API requests (#3303, epic #3302).** Every Haven API request now carries `X-Haven-Client: <package>/<version>`, `@haven_ai/sdk/<version>` by default. An embedding package names itself with the new `HavenClientConfig.clientIdentity`. The transport writes the header last, so neither `defaultHeaders` nor a request context can override it. The backend may answer an outdated client with a `client_update` hint (`HavenClientUpdate`): read the one the current `withRequestContext` dispatch received with the new `HavenClient.clientUpdate()`. Below a minimum the deployment has explicitly set, the payment-initiating routes answer 426 `client_outdated`, surfaced as a `HavenApiError` with that body. New exports: `SDK_VERSION` (bump-managed, never hand-edit), `HAVEN_CLIENT_HEADER`, `SDK_CLIENT_IDENTITY`, `havenClientIdentity`, `readClientUpdate` and the `HavenClientUpdate` type. `HAVEN_CLIENT_HEADER`, `havenClientIdentity`, `readClientUpdate` and the type are also exported from `@haven_ai/sdk/edge`. No response is parsed differently, and nothing is refused client-side.

## 0.5.0-alpha.0 — 2026-09-25

- **`@haven_ai/sdk/edge` gains `assertFundingLegPaysDelegate` and `assertOwnSettlementChild` (#3281, epic #3284).** `assertFundingLegPaysDelegate(typedData, { delegateAddress, asset, amount })` refuses an x402 funding-leg UserOp whose single execution is not a `transfer` of `amount` of `asset` to `delegateAddress`, throwing `HavenTypedDataRefusedError`. `@haven_ai/signer`'s x402 arm runs it; `HavenClient.signForData` does not yet. `@haven_ai/sdk/test-support` gains `buildFundingLegUserOp`. One SDK client change: a malformed settlement child (caveat terms that do not parse) is now refused with `HavenTypedDataRefusedError` (`TYPED_DATA_NOT_ALLOWED`) instead of escaping as a raw parse error. It was already never signed.
- **Behaviour change — `signForData` refuses what a delegate key must never sign (#3283, epic #3284).** `HavenClient.signForData` (used by `pay()`, the x402 EIP-3009 funding leg and `settleX402Erc7710()`) no longer signs whatever the Haven API response hands it. An `eip712_userop` payload is signed only when, beyond the #3271 binding, it is this key's own derived delegate account redeeming exactly one budget delegation granted to it by another account, through a single `execute(DelegationManager, 0, redeemDelegations(...))` on Base or Base Sepolia (`assertBoundDirectPaymentUserOp`). Anything else throws the new `HavenTypedDataRefusedError` (code `TYPED_DATA_NOT_ALLOWED`) before signing, and nothing is submitted. An `eip712_delegation` settlement child is signed only after `verifySettlementChild` accepts it against the merchant's own 402 option: payee, amount, token, chain, advertised facilitators (redeemer caveat), and an expiry of at most 600 seconds. It must also be a re-delegation from this key's own account; a ROOT authority or a foreign delegator is refused. With no such expectation, `signForData` refuses. Every refusal these checks add is `HavenTypedDataRefusedError` (code `TYPED_DATA_NOT_ALLOWED`); the #3271 binding check keeps `HavenUserOpBindingError` and a missing `typed_data` keeps `HavenSigningError`. New exports: `HavenTypedDataRefusedError`, `TYPED_DATA_NOT_ALLOWED`, `assertBoundDirectPaymentUserOp`, `deriveDelegateAccountAddress`, `verifySettlementChild`, `ROOT_AUTHORITY` and the `SettlementChildExpectation` type from the barrel. The same guard modules, the ABIs and the enforcer pins are also available from `@haven_ai/sdk/edge`, which `@haven_ai/signer` now imports instead of its own copies. New `@haven_ai/sdk/test-support` subpath: the shared guard-valid UserOp fixture builders for sibling packages' tests (test fixtures only; nothing the SDK or signer runs imports it). `HavenClient.sign(hash)` and the exported signing primitives are unchanged, verbatim, for embedders.
- Docs only (#3279): JSDoc and README no longer name the retired Safe as a live destination or funding source. `sweepDelegate()`, `SweepAuthorization.to`, `SweepResult.toAddress`, `SweepConfirmation` and `AgentPaymentNextAction.SweepStrandedFunds` now say the agent's Haven account (the sweep sends to `accountAddress`); the x402 funding leg is described as account → delegate EOA, redeemed through the budget delegation; `AgentPaymentRail.Direct` is described as a budget-delegation redemption. No type, value or behaviour change; mentions of the retired Safe rail as history are kept.
- Direct-payment UserOp binding check (#3271): `HavenClient.pay()` now signs a delegation-rail direct payment's `sign_data` through the same `signForData()` path every other rail uses, instead of signing `signData.hash` directly. `signForData`'s `eip712_userop` branch — shared by direct payments (`POST /payments`, `haven_send` / `haven_pay`) and the EIP-3009 bridge's funding leg — now refuses to sign unless the typed data's own domain, types and message recompute to exactly `sign_data.hash` in the HybridDeleGator domain of the typed data's own sender, against the ERC-4337 v0.7 EntryPoint: new `HavenUserOpBindingError` (code `USEROP_BINDING_MISMATCH`) from a new `assertUserOpTypedDataBinding` (plus `packedUserOperationHash`, `isPackedUserOperationTypedData`, and the vendored `HYBRID_DELEGATOR_DOMAIN_NAME` / `HYBRID_DELEGATOR_DOMAIN_VERSION` / `PACKED_USER_OPERATION_FIELDS` / `ENTRY_POINT_V07` / `DIRECT_SIGN_CONTEXT_VERSION` constants), exported from the barrel (the check, `packedUserOperationHash`, `isPackedUserOperationTypedData`, `ENTRY_POINT_V07`, `DIRECT_SIGN_CONTEXT_VERSION` and the error also from `@haven_ai/sdk/edge`). The domain is pinned exactly: no extra keys such as `salt`, and a declared `types.EIP712Domain` must be the canonical four fields. A direct-payment typed-data payload that reached the signer corrupted by even one byte — the failure mode reproduced on dev 2026-09-24, an `AA24 signature error` from the bundler after the fact — is now refused before signing rather than producing a valid-looking signature over the wrong digest.
- `HavenPaymentReceipt` vocabulary convergence (#3134, epic #3130 slice 4/4): four new keys carry the transactions feed's names for values the receipt already reported — `source` (= `rail`), `paymentProofStatus` (= `proofStatus`), `x402ResourceUrl` (= `resourceUrl`), `x402MerchantAddress` (= `merchantAddress`). The four old names are **deprecated twins**, emitted beside the new ones for ONE full release; they are removed only when `npm view @haven_ai/sdk dist-tags` and `npm view @haven_ai/mcp dist-tags` both read a `latest` at or above the release carrying this entry AND the hosted mcp-server deploy reports a `serverInfo.version` on MCP `initialize` at or past it — mcp-server is not on npm, so the live handshake is that clock's instrument (the condition is written on `mapPaymentReceipt`). The backend wire (`RawHavenPaymentReceipt`) is unchanged; no route, no migration. `haven_list_receipts` on both MCP runtimes passes the mapped rows through, so both gain the keys with this SDK.
- `@haven_ai/sdk/edge` (#3173): a second, ethers-free entry for the local signer — the error classes, the refusal/next-action code enums and constants (`AgentPaymentFailureCode`, `AgentPaymentNextAction`, `SignerRefusalCode`, `SIGNER_UPDATE_FALLBACK`), `createNextStepBuilder`, `connectorRerunCommand` and `HAVEN_CONNECTOR_CHANNEL`, the Node-floor helpers, base64 helpers, the x402 message builders (`buildX402ExpectedMessage`, `selectStandardPaymentOption`, `toStandardPaymentRequirements`, `x402AuthorizationAmount`, `x402V2PaymentEnvelope`), the sweep builders, and `addressFromKey` / `signHash` / `verifySignature` re-implemented on viem + `@noble/curves` (new direct dependency, pinned `1.9.1` — exactly what viem pins, so a consumer install of sdk + viem hoists one copy; in this monorepo a newer copy is hoisted for other dependents, so the SDK resolves its own nested `1.9.1` beside viem's nested `1.9.1` — two instances of the same version, exchanging only hex strings, which the byte-equivalence test does not depend on) with byte-equivalence to the ethers forms pinned by test — stricter, never looser: a `0X` prefix on a signature and the 64-byte compact signature are refused where ethers accepts them; on a private key ethers is inconsistent — `ethers.Wallet` (the ethers `addressFromKey`) accepts an unprefixed key and refuses `0X`, `ethers.SigningKey` (the ethers `signHash`) does the reverse — and the edge helpers refuse both forms in both places (stated in the test, with ethers control assertions). `edge-imports.test.ts` fails if the subpath's import graph ever reaches ethers, `x402`, the client or its transports. The package barrel is unchanged. **Build:** tsup now emits a shared chunk (`dist/chunk-*.js` / `.cjs`) so a class imported from the barrel and from the subpath is the same class (`instanceof` across the two entries holds, verified in ESM and CJS).
- Unknown-session recovery on the paid retry (#3171): when the merchant answers the paid `tools/call` with HTTP 404 + JSON-RPC `-32001` carrying `error.data = { settled: false, next_action: 'reinitialize_then_retry_same_payment_header' }`, `fetch()`, `payX402Quote()`, `resumeX402Payment()` and `completeX402MerchantCall()` re-initialize once and resend the SAME payment header on the new session instead of surfacing `merchant_status=404` as a rejection after funding. Only that exact shape licenses the resend — a bare `-32001`, any other 404, a failed re-initialize or a second 404 is returned unchanged. Internal `mcp-merchant-transport` module: `deliverPaymentRecoveringSession`, `sessionNotFoundRecovery`, `SESSION_NOT_FOUND_NEXT_ACTION` (not on the package index); the `HavenClient` facade and public export list are unchanged.
- `HavenPaymentReceipt.scope` (#3132): each receipt row states its list scope as two values, `{ source: 'agent', filter: null }` — this agent's evidence rows, no query-time narrowing — so a receipt read is never mistaken for the wallet's transaction history (`GET /transactions`, `{ source: 'wallet', filter }`). Present when the backend states it; absent on an older backend, never invented. `haven_list_receipts`'s selection guidance says the same in words. New type export `HavenListScope`.
- Native x402 MCP transport profile (#3118): `fetch()`, `quoteX402()`, `quoteMcpX402()` and `completeX402MerchantCall()` now recognise a payment-required TOOL RESULT (`isError: true`, `PaymentRequired` as `structuredContent`, text fallback) answered with HTTP 200 and quote it like a 402; the paid retry adds the payment as `params._meta["x402/payment"]` beside the unchanged `PAYMENT-SIGNATURE` / `X-PAYMENT` headers whenever the body is a `tools/call` request; settlement is read from `result._meta["x402/payment-response"]` when there is no `PAYMENT-RESPONSE` header. An in-band refusal (an `isError` challenge on the paid retry, or `success: false`) is a rejection, never a success. The tool-result challenge is read only from a response declaring `application/json` or `text/event-stream`; any other content type passes through untouched. The helpers live in the internal `mcp-merchant-transport` module (not on the package index); the `HavenClient` facade and the public export list are unchanged.

## 0.4.0-alpha.0 — 2026-09-19

- #3128: `listReceiptsPage({ limit, cursor })` returns `{ receipts, total, hasMore, nextCursor }` (the three page fields are `null` against a backend older than #3128); `listReceipts()` keeps returning the first page's array. `HavenAllowance.remainingDisplay` (derived client-side) and `HavenAgentAllowanceSummary.id` / `.tokenAddress` added, so the compact and detailed allowance reads agree field for field. `haven_list_receipts` on both MCP runtimes accepts `cursor` and returns the page object instead of a bare array.

## 0.3.0-alpha.0 — 2026-09-17

### Removed

- **BREAKING (#2914, naming epic #2906 phase 5).** The Safe-vocabulary
  compatibility half promised by 0.2.0-alpha.0 is gone, one release later as
  stated there.
  - `safeAddress` leaves `HavenAgent` and `HavenAllowanceSummary`;
    `safe_address` / `safe_id` leave the raw server shapes.
  - `SignData.components.safe` is gone. `payer_account` is the account the
    payment is drawn from; `components.account` still means the DELEGATE
    account address — a different address, deliberately never merged.
  - `AgentPaymentNextAction.FundSafeOrRaiseAllowance` is now
    `FundAccountOrRaiseAllowance`, value `fund_account_or_raise_allowance`.
    `AgentPaymentNextActionAccountAlias`, `canonicalAgentPaymentNextAction`
    and `isFundAccountOrRaiseAllowance` are deleted — there is one spelling to
    switch on now.
  - The dual-name read helpers collapse to single-name reads.

## 0.2.1-alpha.0 — 2026-09-16

### Added

- `reportSettlementEvidence(paymentId, settlementTxHash)` on `MerchantCompletion` — an
  erc7710 agent hands Haven the merchant's settlement hash, which Haven verifies
  on-chain before the payment counts as settled (#2973).
- `HavenPaymentReceipt.fundingTxHash` and `.settlementTxHash` name the two legs the
  single unlabeled `txHash` conflated; `txHash` is now `@deprecated` but still emitted
  (#2998).
- `parties` on `HavenPaymentReceipt` and `AgentPaymentSummary` —
  `{ treasury_account, delegate, delegate_account, merchant }` (#2965). Optional.
- `EvidenceReportOutcome`, `HavenZeroSettlementHashError`, `isZeroSettlementTxHash`.

### Changed — read this before upgrading

- **`settled` now means verified.** An erc7710 payment where the merchant returned 200
  without an on-chain confirmation reports `settled: false` where it previously
  reported `true`, and a zero transaction hash never rides out (#2968, #2971). If you
  branch on `settled`, this is a behaviour change, not only a type change.
- **Two exported unions widened**, which is a compile-time break for consumers doing an
  exhaustive `switch` with a `never` check, or building their own
  `Record<AgentPaymentFailureCode, string>`:
  `AGENT_PAYMENT_NEXT_ACTION_VALUES` gains `"awaiting_settlement_evidence"`, and
  `AGENT_PAYMENT_FAILURE_CODE_VALUES` gains `"MERCHANT_NOT_READY"`. No value was
  removed; runtime behaviour for existing values is unchanged.
- `MERCHANT_UNRESPONSIVE_AFTER_FUNDING` on erc7710 no longer advises a sweep — there is
  no funding leg to sweep on that scheme — and says to check status instead (#3000).

### Known gap

- `PaymentParties` is declared but **not re-exported from the package barrel**, so the
  type named by the two `parties` fields above cannot be imported by name yet. The
  fields are structurally usable. Tracked for a follow-up; not fixed in this release,
  which is a version bump.

## 0.2.0-alpha.0 — 2026-09-14

### Breaking (public type shape) — naming epic #2906, phase 1 (#2908)

Under the 0.x convention this is a **minor** bump (`0.1.x → 0.2.0`). Every
renamed field is additive during the one-release window: the new name is
added, the old name is kept with the same value and a `@deprecated` JSDoc.
**Removal release: the release after the one carrying #2908 (#2914).**

| Old (deprecated, removed at #2914) | New | Where |
|---|---|---|
| `PaymentReceipt.payment.safe` | `PaymentReceipt.payment.account` (optional for the window) | `getReceipt()`/`verifyPaymentReceipt()` input — additive; verification reads only `authorization` |
| `HavenAgent.safeAddress` | `HavenAgent.accountAddress` | `getAgent()`, `getAgentSummary()` (also the hosted `haven_get_agent` output) |
| `HavenAllowanceSummary.safeAddress` | `HavenAllowanceSummary.accountAddress` | `getAllowances()` (also the hosted `haven_get_allowances` output) |
| `RawHavenAgent.safe_address` (now optional) | `RawHavenAgent.account_address` | `@internal` wire shape |
| `RawHavenAllowanceSummary.safe_address` (now optional) | `RawHavenAllowanceSummary.account_address` | `@internal` wire shape |
| `RawX402AuthorizeResponse.safe_address` | `RawX402AuthorizeResponse.account_address` | `@internal` wire shape |
| `SignData.components.safe` | `SignData.components.payer_account` | response metadata — NOT part of the signed expected-context payload; no version change |
| `AgentPaymentNextAction.FundSafeOrRaiseAllowance` (`fund_safe_or_raise_allowance`) | `AgentPaymentNextActionAccountAlias.FundAccountOrRaiseAllowance` (`fund_account_or_raise_allowance`) | accepted and documented now; the server keeps emitting the old value until #2914 |

Added: `AgentPaymentNextActionWire` (the `AgentNextStep.next_action` type,
widened by the alias), `canonicalAgentPaymentNextAction()`,
`isFundAccountOrRaiseAllowance()`, and the `account-naming` helpers
`readAccountAddress()`, `readAccountId()`, `accountAddressTwins()`,
`readX402ReceiptPayer()`.

Behaviour: the x402 receipt builder resolves `payer` as
`raw.payer ?? raw.account_address ?? raw.sign_data?.components.payer_account ?? raw.safe_address ?? raw.sign_data?.components.safe`
(never `components.account`, which is the delegate). `next_action` values are
canonicalised at the read boundary, so a `switch` on the taxonomy const keeps
matching after the server flips its emit. Tool descriptions document both
enum spellings, list `accountAddress` first with `safeAddress` as a deprecated
alias, and say "originating account" instead of "originating Safe".

`SUPPORTED_X402_EXPECTED_VERSIONS` is untouched (`[1, 2, 3]`).
