---
owner: "@d-hinders"
status: current
covers:
  - .claude/agents/haven-reviewer.md
last-verified: "2026-06-28"
---

# AI Review Patterns

Use this as shared memory for PR review feedback that was worth fixing. Keep it pattern-based, not PR-based, so future agents can apply it to new surfaces.

The patterns below are also the items checked by the **Captain Self-Check Preflight** in `docs/contributing/ai-agent-workflow.md` and the **Recurring traps** must-check list in `.claude/agents/haven-reviewer.md`. The three lists should stay in sync.

## Data Semantics

- Keep raw and formatted values separate. Raw amounts, ids, hashes, timestamps, and addresses should not be replaced with display strings.
- Treat totals, counts, pagination, and dashboard summaries as derived contracts. If rows are merged, filtered, or deduped on the client, verify that counts still mean what the UI says they mean.
- Do not render fallback activity rows with missing safe, wallet, chain, recipient, or source identifiers unless the empty value is intentional and explained in the UI.

## Status And State Transitions

- New statuses need end-to-end support: database constraints or migrations, backend validation, shared types, frontend labels, filters, notifications, tests, and empty states.
- Error copy must describe the state after the action already taken. If a backend row was saved as approved, do not tell the user the request is still waiting for review.
- Approved, proposed, submitted, executed, rejected, cancelled, and expired states should be visually and behaviorally distinct when they lead to different next actions.

## API And Hook Contracts

- Avoid optional hook or function arguments when missing values make the old call compile but fail at runtime. Make required context required in TypeScript.
- Audit all callers after changing hook signatures, response fields, status values, or API payloads.
- Async hooks that fetch keyed data must ignore late responses from older keys. Use a generation guard or abort signal when address, chain, agent id, filters, or enabled state can change while a request is in flight.
- Prefer explicit response fields over matching on free-text reason strings. If a free-text fallback is necessary, document it as temporary.
- When SDK or API behavior changes, review generated examples, credential handoff files, demo scripts, and skill bundles for stale instructions.
- When renaming technical fields to product-facing names, keep compatibility aliases when external users or generated artifacts may already depend on the old env var or field.

## Async UX And Modals

- Primary action hierarchy should match the next useful action. A "Close" button should not be visually stronger than the action the copy asks the user to take.
- Disabled actions should explain what is missing, and labels should not flicker between meanings while prerequisite data is loading.
- Modal content should fit normal laptop screens when practical. If more information is needed, prefer a step, disclosure, or detail surface over forcing scroll.
- Check z-index, backdrop, close, Escape, and unsaved-work behavior for modals that contain required actions or wallet/signing controls.

## Signer Readiness Gates

- A connected wallet address is not the same as a ready signer. EOA signing paths that use `useActiveSigner` require both `address` and `walletClient`; gates must stay aligned with the signer hook instead of checking `address` or `isConnected` alone.
- If wallet or passkey readiness is incomplete, the UI must keep the recovery action visible. A warning such as "Wallet approval unavailable" must be paired with `WalletButton`, passkey guidance, or an equivalent next action.
- Tests for wallet-gated money or authority actions should cover the intermediate state where a wallet address is present but `walletClient` is not ready. That state should remain blocked and recoverable, not visually ready or silently disabled.

## Recipient And Form Behavior

- Do not hijack typing with eager exact-name matching or autocomplete side effects. Suggestions should be committed by an explicit user action or a clearly bounded blur behavior.
- Client-side duplicate checks should be backed by server-side uniqueness or a clear API error.
- Network and chain context should be visible before a user sends or receives funds, especially when saved contacts are chain-neutral.

## Shared UI And Cross-Surface Consistency

- If the same movement, transaction row, status badge, contact row, or money summary appears in multiple places, prefer one shared component or utility.
- Keep dashboard, account detail, agent detail, transaction history, approvals, and design-system examples aligned after changing shared presentation.
- If a temporary frontend shim or preview backfill is added, label it clearly and avoid letting it redefine backend-owned totals or durable semantics.

## Generated Artifacts And Developer Handoffs

- Treat generated Markdown, `.env` examples, SDK quickstarts, demo scripts, and agent skill bundles as product surfaces. They should be reviewed when payment capabilities, credential semantics, or SDK APIs change.
- Credential handoffs should include the current payment paths the agent can use, such as direct payments, x402, and Haven machine-payment flows when supported.
- Generated artifacts should explain queued approval behavior and avoid implying the agent can spend beyond the user's rules.
- Keep developer-facing details accurate without leaking stale primary-UX vocabulary. Prefer `Haven wallet`, `credential address`, `agent rules`, and `agent budget`; mention Safe/module details only when they are necessary for advanced integration clarity.
- Do not remove established env vars from generated files without a compatibility plan. Add clearer aliases alongside older names when external integrations may already rely on them.

## Numeric Formatters

- Separate the sign before formatting bigint magnitudes. BigInt `%` preserves sign, so a naive `${quotient}.${remainder}` on a negative input renders as `"-5.-5"`. Format magnitude, then re-attach the sign.
- Reject scientific-notation strings explicitly. `Number("1e20").toFixed(4)` silently loses precision near `MAX_SAFE_INTEGER`; pass the original through unchanged so the upstream problem stays visible instead of producing a wrong-looking number.
- A single shared formatter must own both the raw-bigint and already-decimal input paths. Callers should not be able to reintroduce the bug by passing the "other" shape. See `packages/frontend/src/lib/allowance-format.ts` as the canonical example.

## Counter And Summary Buckets

- Buckets in a summary line must be mutually exclusive, or the UI must label them as overlapping. A failed outgoing send is `failed`, not `failed AND sent`; double-counting on a single row produces `1 sent · 1 failed` from one transaction.
- Test the simplest overlap case before shipping. For direction × status summaries, the failed-outbound and failed-inbound cases are the ones that drift.
- Propagate the same tone/colour wiring everywhere a summary is rendered. Dashboard previews routinely lag the canonical surface; audit every caller after changing a row's tone props.

## Conditional Copy Predicates

- When copy says "this will replace **{token} budget**", the predicate must match by precise token identity (address **or** symbol), not by "the agent has any allowance". Predicates broadened for layout or disabled-state reasons routinely leak into copy that should fire only on an exact match.
- Audit every existing-vs-new branch (`Update` vs `Add`, `Replace` vs `Set`, `Resume` vs `Start`) after changing the underlying boolean. Add tests for the no-match and exact-match branches.
- Disabled actions should explain what is missing in a visible caption; do not rely on a silent disabled state alone.

## Animation Discipline

- Every CSS animation that gets a prominent placement must be gated on `@media (prefers-reduced-motion: no-preference)`. Pre-existing animations also need the gate the moment they get a prominent placement, even if they were ungated before.
- Toggling one animation class while another animation class remains on the same element causes browsers to re-initialize the surviving animation — visible as a flash to opacity 0 or a transform reset. Keep one-shot animations stable across state transitions (`animation-fill-mode: both` + leave the class applied).
- A CSS variable like `--v2-stagger-delay` only takes effect on a class that consumes it. `v2-animate-step-rise` does not consume the stagger delay; `v2-animate-stagger` does. When you set a delay, confirm the consuming class is the outer wrapper.

## Cross-Surface Display Drift

- A value rendered in 2+ surfaces (compact card, detail card, dashboard preview, design-system page) must flow through exactly one shared formatter. Two formatters drift, especially when one is inline.
- The input to the formatter must carry enough context (chain id, token decimals, network) to be correct independently of the currently-selected wallet. Agent budget bugs typically appear when an agent's wallet is on a different chain than the selection.
- Backend API responses should include the chain/decimals metadata each row needs; do not require the frontend to join against the selected wallet.

## Loading-State Inference

- Never infer "onboarding step done" or "feature completed" from a paginated or capped preview list. The preview is a UI affordance, not a durable signal.
- Require explicit progress fields on the API (e.g. `onboardingProgress.hasFirstAgentPayment`) and gate the dependent UI until **all** prerequisite hooks have resolved.
- Test the staggered-resolution case: balances resolve before transactions, or transactions resolve before agents. The completed-but-dismissed and incomplete-loading states should both be covered.

## Inline Gate Placement

- `OnchainActionGate` and `NetworkGate` notices render **above** the action row, not inside the `flex-1` wrapper that holds the action button. Nesting the notice inside `flex-1` pushes the primary action out of line with its siblings when the gate triggers.
- Standard pattern: `<OnchainActionNotice />` above the Cancel/Confirm row, with `showNotice={false}` on the gate so it does not double-render. Match the layout used in `SendModal` and `ApprovalQueue`.

## Multi-Entrypoint Parity

- Payment, x402/MPP, MCP, SDK, and demo flows often expose the same capability through multiple entrypoints. A fix in one path is incomplete until header, tool-argument, SDK-helper, direct API, and demo paths share the same validated state or have explicit parity tests.
- Do not verify payment or authority in one layer and then make a downstream handler rediscover it from a different payload shape. Pass the verified payment state through the request context or a shared helper.
- When adding an entrypoint, test the smallest cross-path case that would fail if one path still read stale arguments, stale headers, or a different status field.

## Credential And Modal Lifecycle

- One-time credential state must clear on modal close, account switch, agent switch, and failed or abandoned in-flight actions. Plaintext keys should not survive into a later open cycle unless the user is still in the same intentional reveal flow.
- In-flight flags such as rotating, copying, saving, connecting, or signing must reset when a modal is closed and reopened. A stale spinner with no active request is a product bug, not just polish.
- Generated snippets and setup prompts must be rebuilt from current credential state after rotation, revocation, or runtime selection changes.

## Identifier Entropy

- Displayed prefixes are product identifiers. A key prefix, setup-token prefix, invoice number, nonce, or payment reference should have enough entropy for the population it helps distinguish.
- If a displayed identifier can collide, the UI or backend needs duplicate handling or a longer displayed prefix. Do not treat a short prefix as safe just because the hidden full value is unique.
- Tests should cover duplicate or near-duplicate identifiers when the prefix is used for user recognition, lookup, audit, or support.

## Credential Setup Copy

- Setup copy must be consistent across the modal, generated credential file, hosted-connect prompt, runtime snippets, SDK examples, and docs.
- Lead with the safety property users need to understand: API credentials identify the agent, local signing keys stay local, and agent budget rules cap spending. Do not make users infer that from implementation details.
- Avoid contradictions between warnings, reassurance, and generated commands. If copy says a key stays local, no generated snippet, deep link, or setup prompt may include that private key.

## Browser Or Headless Verification

- If browser verification is skipped for UI, routing, modal, animation, or setup-flow work, the PR must name why and include a headless equivalent for the skipped risk.
- The headless equivalent should match the risk: class stability for animation, shared formatter output for cross-surface display, gated rendering for loading flashes, and render/state tests for empty or populated setup states.
- Do not use "browser skipped" as a blanket waiver for visual or interaction risk on primary money movement or agent authority flows.

## Test Gaps Worth Catching

- Add tests for changed non-happy states: loading, empty, error, proposed/submitted, approved-but-not-executed, expired, cancelled, and duplicate cases.
- For money movement, test the selected account, selected chain, selected token, recipient, and signer context rather than only the happy path rendering.
- If review feedback finds a bug that survived tests, add or update the smallest regression test that would have caught it.
