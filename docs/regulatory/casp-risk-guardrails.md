---
owner: "@d-hinders"
status: current
contract: true
covers:
  - packages/backend/src/config.ts
  - packages/backend/src/routes/x402.ts
  - packages/backend/src/modules/x402/**
  - packages/backend/src/routes/x402-resources.ts
  - packages/backend/src/routes/payments.ts
  - packages/backend/src/routes/machine-payments.ts
  - packages/backend/src/modules/mpp/**
  - packages/backend/src/domain/payment-token.ts
  - packages/backend/src/routes/catalog.ts
  - packages/backend/src/routes/reporting.ts
  - packages/backend/src/routes/accounting.ts
  - packages/backend/src/routes/fortnox.ts
  - packages/backend/src/modules/reporting/fortnox.ts
  - packages/backend/src/modules/reporting/fortnox-connection.ts
  - packages/backend/src/rails/allowance-module.ts
  - packages/backend/src/infra/repositories/payment-intents.ts
  - packages/backend/src/infra/repositories/approval-requests.ts
  - packages/backend/src/infra/repositories/x402-authorizations.ts
  - packages/backend/src/infra/repositories/machine-payments.ts
  - packages/backend/src/infra/repositories/account-entitlements.ts
  - packages/backend/src/infra/repositories/agents.ts
  - packages/backend/src/modules/accounting/accounting-entry.ts
  - packages/backend/src/modules/catalog/catalog-discovery.ts
  - packages/backend/src/modules/catalog/merchant-catalog.ts
  - packages/backend/src/domain/payment-coverage.ts
  - packages/backend/src/infra/relayer.ts
  - packages/backend/src/modules/reporting/**
  - packages/backend/src/modules/accounts/safe-deployer.ts
  - packages/backend/src/middleware/agentAuth.ts
  - packages/backend/src/middleware/reportingFeed.ts
  - packages/backend/src/db/migrations/**
  - packages/backend/src/routes/agent-connection-setups.ts
  - packages/backend/src/routes/passkeys.ts
  - packages/backend/src/routes/safe-deploy.ts
  - packages/backend/src/routes/user-safes.ts
  - packages/frontend/src/app/(authenticated)/accounting/**
  - packages/frontend/src/app/(authenticated)/reporting/**
  - packages/frontend/src/components/AddFundsModal.tsx
  - packages/frontend/src/components/ApprovalQueue.tsx
  - packages/frontend/src/components/UsingYourAgentInfo.tsx
  - packages/sdk/src/**
  - packages/connect/src/**
  - packages/mcp/src/**
  - packages/mcp-server/src/**
  - packages/signer/src/**
  - packages/demo-merchant-mcp/src/**
last-verified: "2026-08-12" # #1330 Hermes identity handoff + release 0.1.22-alpha.0 runtime constants re-verified; no custody or authority change
---

# Haven CASP / MiCA Risk Minimisation Guardrails

## Purpose

Haven must be built as non-custodial smart account software, not as a custodial wallet, exchange, broker, payment processor, merchant acquirer, fiat payment service provider, or discretionary asset manager.

This document gives engineering guardrails for minimising the risk that Haven is treated as a Crypto-Asset Service Provider, or CASP, under MiCA. It is product and architecture guidance, not a formal legal opinion.

## Regulatory Context

MiCA regulated crypto-asset services include custody and administration, exchange, execution of orders, reception and transmission of orders, advice, portfolio management, and transfer services for crypto-assets on behalf of clients. Finansinspektionen lists the same categories for Swedish CASP authorisation purposes.

The most relevant categories for Haven are:

- **Custody and administration:** safekeeping or controlling crypto-assets or the means of access to crypto-assets, including private keys.
- **Transfer services:** transfer of crypto-assets from one distributed ledger address or account to another on behalf of a person.

ESMA has clarified that crypto-asset transfer services are a self-standing MiCA service. Treat this as a serious perimeter risk even when transfer functionality is part of a broader product.

References:

- [Finansinspektionen: Cryptoasset services](https://www.fi.se/en/payments/apply-for-authorisation/crypto-assets-and-crypto-asset-services/cryptoasset-services/)
- [MiCA Article 3 definitions](https://www.mica.wtf/mica/title-i-subject-matter-scope-and-definitions-art.-1-3/article-3)
- [ESMA Q&A 2071](https://www.esma.europa.eu/publications-data/questions-answers/2071)
- [EBA no-action letter on PSD2/3 and MiCA](https://www.eba.europa.eu/publications-and-media/press-releases/eba-publishes-no-action-letter-interplay-between-payment-services-directive-psd23-and-markets-crypto)

## One-Line Engineering Principle

Haven may help users and agents prepare, validate, and relay Safe transactions, but Haven must never become the party that holds keys, controls funds, authorises transfers, expands permissions, or makes discretionary financial decisions.

## Core Design Principle

Haven should never be the party that holds funds, holds keys, controls access, makes discretionary transfer decisions, or expands payment authority.

Haven may provide:

- UI for configuring user-controlled Safe permissions.
- Transaction construction from explicit user, agent, or protocol instructions.
- Optional pre-checks that mirror on-chain rules.
- Non-discretionary relay of independently valid signed transactions.
- Indexing, transaction status, receipts, and proof management.
- Developer and agent APIs that require independently valid user or agent signatures.

Payment authority must always come from external signatures and the applicable
on-chain controls:

```text
Safe-originated funding
  -> user-controlled Safe
  + user-approved transaction or agent-signed module call
  + on-chain Safe module or guard constraints

Standard x402 delegate-to-merchant payment
  -> agent-held delegate key
  + exact authenticated merchant/amount/asset/network/resource context
  + delegate's available token balance
```

The source of payment authority must never be:

```text
Haven backend
  + Haven database policy
  + Haven-controlled signer
  + Haven discretion
```

> **Current state (2026-07-18, #946):** the delegation rail settles x402 by
> two schemes. erc7710 direct settlement redeems the budget delegation itself
> (authority = the caveat stack, at settlement). The EIP-3009 fallback funds
> the agent's delegate EOA by redeeming the same budget delegation (authority
> = the caveat stack, at the funding hop; agent-signed sponsored UserOp), and
> the merchant leg is then the standard agent-signed EIP-3009 transfer bound
> to the exact authenticated payment context — the same shape as the legacy
> rail's merchant leg described above. In both schemes Haven prepares and
> relays only; no leg is authorised by Haven policy alone. Recipient-pinned
> budgets cannot fund the EOA and are therefore erc7710-only — the fallback
> never weakens an on-chain pin. Since #1058 the settlement child can also be
> **redeemer-pinned**: when the merchant's 402 advertises
> `extra.facilitatorAddresses`, only those addresses can redeem the child —
> narrowing, never widening, who can execute the settlement Haven prepared.
> Since #1059 every delegation-rail intent also records `budget_delegation_hash`
> — the metering budget, uniform across schemes — so attribution in the
> accounting feed never depends on parsing prepared execution state.
> Since #994 no route handler imports a chain SDK: chain reads go through
> the `ChainClient` port and pure amount formatting through `@haven_ai/core`
> (characterized byte-identical to the prior implementation) — enforced at
> zero-tolerance by the dependency ratchet, so the HTTP layer cannot regrow
> direct chain access.
> Since #1139 every migration in the mainnet-money table set carries a
> structural `down()` (proven by an up-then-down-all run against a real
> schema) — rollback is operator tooling, never runner behavior, and the
> additive-by-design philosophy is unchanged.
> Since #717 relayer-paid operations run under per-identity gas budgets
> (429 on over-cap, spend recorded per agent/user for attribution) — an
> availability control on the shared gas sponsor, deliberately fail-open on
> database errors because it gates gas, never funds.
> Since #993 the retired session rail's fail-closed refusal (HTTP 410,
> nothing written) is decided and produced in ONE place
> (`rails/execution-rail.ts`), and enforced at every agent-payment entry point
> (/payments, sign, MPP authorize + replay, /machine-payments/send, x402
> authorize) regardless of the account's permission/chain configuration.
> Queued-approval completion is not a gap (#1121, investigated): the
> dashboard executes an OWNER-signed Safe transaction — owner authority,
> outside any agent rail — so the seam is rightly not consulted there.
> Since #1130 a valid key on a `pending_approval` agent gets a NAMED
> `403 agent_pending_approval` with the required action, instead of the
> false `401 Invalid or revoked API key` — the authentication gate stays a
> positive allow-list (revoked and unknown statuses still 401), the refusal
> just stopped lying about its cause.
> Since #988 the agents/user-safes data access lives in
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

> **Current state (2026-07-27, #976):** the erc7710 settle response carries a
> `passport` reference — `{ attestation_uid, chain_id }`, plus an optional
> convenience `verify_url` — or `null`. This is **outside the perimeter this
> document draws** and does not move it: it verifies no payment, settles
> nothing, holds nothing, takes no fee, and creates no merchant-acquiring
> relationship. The reference is a pointer to an EAS attestation already public
> on-chain, returned to the agent that owns it, answering a governance question
> ("is this agent issued, governed and revocable?") — never an identity or KYC
> claim, which is L2 and not issuable.
>
> Be precise about what "already public" covers, because it does not cover the
> whole answer. `attestation_uid` and `chain_id` are public on-chain data. What
> `verify_url` leads to is a **Haven-signed receipt** whose interesting content
> is LIVE STANDING — whether the agent is currently revoked — which the anchor
> cannot express and which is the actual product. The reference being harmless
> therefore does not rest on "it's all public"; it rests on the receipt
> asserting governance state and nothing about a payment, a person, or a
> counterparty. Same discipline as the #956 note below, which is careful not to
> let a true narrow claim stand in for a broader one.
>
> The reference is deliberately NOT placed in the `X-PAYMENT` payload, so it
> cannot alter the authenticated payment context or any leg's authority. Absent
> (`null`) is a normal answer, and a lookup **error** degrades to `null` rather
> than affecting the payment. (The header itself is x402 v2-shaped since
> #1064 — it additionally echoes the accepted requirements entry, which is
> public payment metadata the merchant already quoted: no new data class, no
> authority change.)

> **Current state (2026-07-18, #956):** agents may report the MERCHANT's own
> receipt after a settled payment (`POST /machine-payments/:id/merchant-receipt`,
> agent-scoped, size-capped). The reporting feed attaches it verbatim next to
> the Haven-generated payment evidence, under a provenance banner stating
> Haven asserts nothing about its contents — data tooling, not accounting
> judgment. URL-referenced receipts are fetched server-side at feed time under
> strict guards (https-only, private/internal hosts refused, content-type
> whitelist, 5MB cap); string-level host blocking does not defeat DNS
> rebinding — revisit before production rollout.

## Hard Architecture Invariants

Preserve these facts as non-negotiable implementation invariants:

- User treasury funds are held in the user's Safe. An agent-held delegate EOA may also have a pre-existing, newly funded, or residual balance used for a standard x402 merchant payment; Haven controls neither account.
- Haven never holds user private keys, agent private keys, or seed phrases.
  Passkey-owned delegation-rail accounts store only PUBLIC key material
  (`hybrid_account_passkeys`: credential id + P256 x/y coordinates) — the
  private key never leaves the user's authenticator, and public coordinates
  grant no signing or spending authority.
- Haven never operates an unrestricted server-side signer.
- Haven cannot unilaterally move funds.
- Haven cannot bypass Safe owners, Safe modules, Safe guards, or on-chain constraints.
- Agent spend authority is created or changed only through Safe transactions approved by the user.
- Safe-originated agent funding flows through Safe's Allowance Module, a user-approved Safe transaction, or an equivalent on-chain control. A standard x402 merchant leg is a separate agent-signed transfer from the delegate's available balance, bound to the exact authenticated payment context; it is not itself a Safe module call.
- Allowance limits are enforced on-chain, not only by Haven.
- Agent-initiated transactions, including the standard x402 merchant leg, are signed by an agent private key held by the agent or user, not by Haven.
- Haven may relay execution, but authority comes from the user or agent signature and the controls applicable to that leg, never from Haven authentication or database policy alone.
- Users can access their Safe through other Safe-compatible UIs.
- Users can revoke or modify agent authority independently of Haven.
- Haven cannot block users from transacting with their Safe outside Haven.

**Delegation-rail x402 signing is local-signer-only (owner decision, 2026-08-06, #1138).** The hosted/edge keyless path never signs an account UserOp: on this rail the agent's signature is produced by the local signer holding the delegate key, exactly as invariant "signed by an agent private key held by the agent or user, not by Haven" requires. Haven's role is limited to *declaring* what is to be signed — an expected context it signs with a dedicated binding key — which the signer verifies before signing and can refuse. Because the account validates EIP-712 typed data rather than the bare ERC-4337 hash, that declaration commits to the typed data's digest (expected context v2); the signer re-derives the digest from the payload it actually signs and refuses any mismatch, so Haven cannot substitute a different operation behind a correctly-signed declaration. The refusal extends to declarations the signer does not *understand*: an expected-context version outside the set that signer supports is rejected before any content check (#1143, `SUPPORTED_X402_EXPECTED_VERSIONS`), so a newer backend cannot obtain a signature by declaring a context whose rules the signer cannot evaluate — the same property, applied to the version field itself. Since #1155 the signer also *advertises* that supported set at its MCP `initialize` handshake, so an agent can spot the skew before it quotes. That advertisement is metadata — version numbers, no key material and no authority — and it is advisory by decision: it adds no refusal to the payment path, and the signing-time refusal above remains the control. This is a boundary, not a staging decision: teaching the hosted signer to sign account UserOps would put Haven in the signing path and is out of scope by construction.

**Delegation rail (epic #821, dark-launched 2026-07):** a second account type (MetaMask Hybrid DeleGator) is being introduced with the same custody posture — every invariant above maps one-to-one per [`docs/security/delegation-rail-security-model.md`](../security/delegation-rail-security-model.md) (§2, implemented as CI checks in #831). Two Safe-specific formulations generalise rather than weaken: "Safe-compatible UIs" becomes the independent exit path (#832, now DEMONSTRABLE — live-verified enumerate + owner-signed revoke with no Haven involvement; see [`docs/exit/README.md`](../exit/README.md)), and "Safe transactions approved by the user" becomes owner-signed delegations. The payment path (#829) moves funds ONLY via the agent's owner-signed delegation, redeemed through audited enforcers that carry the budget, recipient and expiry on-chain; Haven relays sponsored operations and signs nothing (invariants 5-d/7-d/11/12 in CI).

Any feature that weakens one of these assumptions needs legal and product review before implementation.

## Red Lines

Do not build these features without separate legal and product review.

### 1. Server-Side User Key Custody

Never implement:

- Server-side custody of Safe owner keys.
- Encrypted user private keys stored by Haven, even if encrypted at rest.
- Seed phrase backup or recovery controlled by Haven.
- Key export/import flows where the Haven backend can access key material.
- Recovery where Haven can regain access to a user's Safe without user-controlled authentication or signing.

Preferred pattern:

- User keys remain in the user's wallet, passkey stack, hardware device, or security environment.
- Haven stores the public passkey credential ID, P-256 public-key coordinates, and optional raw attestation for future verification. Current enrollment does not cryptographically verify that attestation. Authentication flows may verify assertions and signatures, and Haven may receive signed transaction payloads, but it never receives passkey private material.
- Recovery uses Safe-native recovery, additional owners, guardians, or other user-controlled mechanisms.

### 2. Server-Side Agent Key Custody

Never implement:

- Agent private keys generated on the Haven backend.
- Agent private keys stored in the Haven database.
- Agent private keys encrypted with a Haven-managed key.
- Hosted agent wallet functionality.
- Any flow where Haven can sign an Allowance Module transfer on behalf of an agent.

Preferred pattern:

- Agent keys are generated and held by the user or agent runtime.
- Haven may help the user register an agent public key or spender address with the Safe.
- The agent signs payment requests or module transactions externally.
- Haven verifies signatures and relays only if the transaction is independently valid.

### 3. API Credential As Payment Instrument

Never implement:

- API key alone can trigger payment.
- Bearer token alone can authorise transfer.
- `agent_secret` is sufficient to spend from a Safe.
- Haven database policy is the only thing preventing spend.
- Haven backend converts an API-authenticated request into a signed transfer using Haven-controlled authority.

Implementation rule:

> API auth is identity. Signature is authority. On-chain module state is enforcement.

### 4. Off-Chain-Only Spend Control

Never implement:

- Spend limits that exist only in Haven's database.
- Recipient allowlists that are the only effective transfer control.
- Daily limits enforced only by API checks.
- Category limits that can result in automated transfers without an on-chain constraint.
- Soft policy where Haven says no, but a compromised backend could still move funds.

Preferred pattern:

- Haven may mirror policies off-chain for UX and pre-validation.
- Safe-originated funding must still be constrained by Safe modules, Safe guards, user-approved Safe transactions, or equivalent on-chain controls. A delegate-to-merchant x402 transfer must be externally signed and bound to the exact authenticated payment context rather than authorised by Haven policy alone.
- If a policy cannot be enforced on-chain, treat it as advisory and require manual user approval for execution.

### 5. Discretionary Transfer Authority

Never implement logic where Haven decides:

- Which asset to send without explicit user or agent instruction.
- Which recipient to pay without explicit user or agent instruction.
- Whether to optimise or reroute a payment based on Haven's own judgement.
- Whether to split, aggregate, convert, or redirect funds without pre-approved user rules.
- Whether to choose a different payment route that changes the economic substance of the transaction.

Preferred pattern:

- Haven executes deterministic instructions within pre-approved constraints.
- Inputs come from the user, the agent, or a protocol challenge.
- Haven does not make discretionary financial decisions.

### 6. Exchange, Broker, Swap, Or Ramp Functionality

Never implement without review:

- Token swaps.
- Crypto-to-fiat or fiat-to-crypto exchange.
- Crypto-to-crypto exchange.
- On-ramp or off-ramp.
- RFQ, order routing, best execution, or brokerage-like flows.
- Spread capture, price risk, or proprietary capital exposure.
- Routing orders to trading venues or liquidity providers.

Preferred pattern:

- Keep MVP flows to direct transfers from user-controlled Safes.
- If swaps or ramps are added later, use licensed partners and run a separate regulatory review.

### 7. Advice, Yield, Or Portfolio Management

Never implement without review:

- Recommended yield.
- Best asset to hold.
- Optimise my treasury.
- Automated asset allocation.
- Automated Aave, yield, or treasury deposits.
- Risk-based portfolio recommendations.
- Personalised recommendations about crypto-assets or crypto-asset services.
- Discretionary treasury management.

Preferred pattern:

- Show factual balances and transaction history.
- Let users manually choose actions.
- Avoid personalised financial recommendations.

### 8. Merchant Acquiring Or Facilitator Functionality

Never implement in production without review:

- Haven as a production x402 facilitator for third-party merchants.
- Haven receiving funds for merchants.
- Haven settling merchant balances.
- Haven validating payments as a commercial acceptance layer.
- Haven operating merchant dashboards for payment acceptance.
- Haven taking a fee from merchant settlement.
- Haven acting as merchant of record.

Preferred pattern:

- Support buyer-side outbound x402 payments and discovery of live merchants without becoming the merchant's facilitator, acquirer, processor, or settlement provider.
- Keep Haven-operated merchant endpoints clearly marked as internal technical demos.
- Do not provide third-party merchants with commercial payment acceptance, validation, balances, or settlement services.
- Do not let funds flow through Haven.

### 9. Reporting, Accounting, Or Tax Assertions

Never implement without review:

- Automatic posting of asserted accounts, VAT treatment, tax treatment, or journal entries.
- Product claims that Haven has completed bookkeeping, reconciliation, tax filing, or accounting judgment for the user.
- A live accounting connector that turns Haven suggestions into asserted records without user or accountant confirmation.
- Personalised tax or accounting advice.

Preferred pattern:

- Export or sync factual source data as draft, non-asserting transactions.
- Label categories and account mappings as suggestions.
- Require the user or accountant to review, code, and confirm entries in the accounting system.
- Obtain separate product and regulatory review before enabling a live connector or any asserted accounting judgment.

**Current state (2026-07, epic #491):** the live Fortnox feed (#496/#498) follows
the preferred pattern — each settled payment is pushed as an **unattested
supplier invoice** carrying no account, no VAT, and no voucher rows
(`assertNonAsserting()` in `modules/reporting/fortnox-connector.ts` makes the
non-asserting payload a runtime invariant), with the Haven-generated
payment-evidence PDF attached as underlag. Nothing is booked until a human
attests it in Fortnox. The earlier asserting voucher-push surface
(`POST /accounting/fortnox/push`) is disabled by default behind
`config.legacyBookkeepingEnabled` and returns 410 when off; re-enabling it is a
review trigger under this red line.

### 10. Fiat And Card Rails

Never implement without review:

- Card issuing or virtual cards issued by Haven.
- Fiat account balances.
- Fiat custody.
- Payment initiation from bank accounts.
- Stripe, MPP, or other fiat rail execution where Haven becomes the payment service provider.
- Handling card PANs or raw card credentials.
- Holding or settling fiat funds.

Preferred pattern:

- Licensed partners handle fiat, card, and regulated payment services.
- Haven remains a policy, UX, and smart account software layer.
- Haven never becomes the payment account provider, issuer, acquirer, or PSP.
- Haven never handles raw card details.

### 11. Haven Lock-In Over Funds

Never implement:

- Lock-in where users can only transact through Haven.
- Safe setup where Haven is required to revoke agents.
- Safe setup where Haven is required to recover the account.
- Safe setup where Haven controls essential modules.
- Backend dependency that prevents users from accessing or managing their Safe elsewhere.

Preferred pattern:

- Users can access their Safe through alternative Safe-compatible UIs.
- Users can revoke agent spend authority on-chain.
- Users can remove modules or guards according to Safe rules.
- Haven is replaceable infrastructure, not the account controller.

## Required Architecture Patterns

### Separate Authentication From Authorisation

Authentication examples:

- API key.
- Agent ID.
- OAuth-style token.
- Session token.

Authorisation examples:

- User signature.
- Agent-held private key signature.
- Safe owner approval.
- Safe module permission.
- On-chain allowance.

Implementation rule:

> A request is not executable merely because it is authenticated. It must be independently authorised by a user-held or agent-held key. Safe-originated funding must also satisfy on-chain Safe constraints; a standard x402 merchant leg must match the authenticated exact payment context.

Where the signed payload is fully reconstructable server-side, "authorised by an agent-held key" must be **verified, not assumed**. On the delegation rail's erc7710 settlement (`POST /x402/:id/settle`), Haven recovers the signer from the child delegation's EIP-712 typed data and refuses a signature that is not the agent's registered delegate key — with a `400` raised *before* the intent status changes, so a mis-signed request leaves the intent re-signable instead of consuming it (#1061). A shape check alone (`0x…`-prefixed hex) is not authorisation.

Where the payload is not fully known server-side (the AllowanceModule path in `payments.ts`), authority still rests with the on-chain check on the relayed transaction; the difference is stated so the weaker case is not mistaken for the stronger one.

### Use On-Chain Enforcement Wherever Safe Authority Is Exercised

Haven can pre-check:

- Budget.
- Asset.
- Recipient.
- Expiry.
- Rate limit.
- Protocol type.
- Transaction metadata.

The final gate for Safe-originated funding should be:

- Safe owners.
- Safe module.
- Safe guard.
- Allowance Module.
- On-chain spender limits.

For a standard x402 delegate-to-merchant leg, the final gates are the agent-held
delegate signature, token-contract authorization rules, and exact authenticated
merchant, amount, asset, network, resource, and expiry context.

Implementation rule:

> If Haven's backend and database disappeared, the user's Safe permissions and restrictions should still be understandable, revocable, and enforceable on-chain.

**The agent-facing spend-authority report is rail-aware and grants nothing (#1135).** `GET /machine-payments/allowances` — the endpoint behind the SDK's readiness signal — is a read/reporting mirror per rail: on the legacy rail it reads the live AllowanceModule state on-chain; on the delegation rail it derives remaining budget from the agent's own active, owner-signed delegations (the same #1090 derivation the dashboard uses, so the two surfaces cannot disagree); a retired session-rail account gets the #993 fail-closed 410 rather than a state read. Enforcement is unchanged by this endpoint on every rail — the AllowanceModule and the delegation caveats remain the gates, and an over-budget delegation redemption reverts on-chain rather than being queued by Haven.

### Make All Agent Authority User-Approved

Agent authority should only be created through:

- A user signature that is itself the authority: a Safe transaction signed by the user or Safe owner on the legacy rail, or an owner-signed delegation on the delegation rail (the generalisation recorded above under "Hard Architecture Invariants").
- Clear UI explaining spender, token, amount, reset period, expiry, and revocation.
- On-chain registration of the relevant spender or agent authority.
- Audit log of user consent.

Implementation rule:

> Haven must not silently create or expand an agent's authority.

**The dashboard's signing surfaces are rail-honest (#1079).** The signer layer types the two authorities apart: a Safe transaction can only be signed by a `SafeCapableSigner` (EOA or Safe passkey), never by a Hybrid account's passkey — the compiler enforces the exclusion at every Safe-shaped call site (send, approval execution, owner changes, AllowanceModule edits), and Safe-only controls are hidden on delegation accounts rather than dead-ending at a signer they cannot use. This is a UI/type-layer hardening only; the on-chain authority model above is unchanged.

**Where a setup flow marks an agent approved, Haven verifies the authority rather than accepting the client's word for it.** Both connect-setup approval routes work this way (`routes/agent-connection-setups.ts`): the legacy `wallet-approval` reads the live AllowanceModule state on-chain, and the delegation rail's `budget-approval` reads the agent's own active, owner-signed delegations. The latter takes an empty request body precisely so that no amount, recipient, or hash a caller supplies can influence the outcome, and it refuses when the signed budget's amount or period differs from the one the user reviewed. A pinned recipient is accepted where the reviewed budget was unpinned, because that is strictly narrower authority than the user approved (#1073). (#985 moved this route's SQL into `infra/repositories/agent-connection-setups.ts`; the verification itself — reading live AllowanceModule state, and reading the agent's own active owner-signed delegations — still runs in the route and is unchanged. The approval write is now one locked, guarded function, so the checks and the write it protects cannot be run apart.) Since #1074 a delegation-rail setup also refuses more than one allowance at CREATE — a multi-allowance setup could never satisfy this verification (only the first budget is ever granted), and a clean 400 with the remedy beats a permanently unapprovable setup; fail-closed either way.

**Connection setup never hands out another environment's hosted MCP endpoint (#1129).** The production hosted MCP URL is served as a built-in default only when the backend's own resolved public URL is the production host; any other deployment must set `HAVEN_HOSTED_MCP_URL` explicitly, or `/resolve` and `/register` refuse with an explicit configuration error naming the variable — raised before any state is written, so a misconfigured environment can neither consume the client's one-shot setup token nor leave a registration half-created, and an agent's credentials are never pointed at a different environment's backend. Fail-closed, same as the authority checks above.

### Keep Agent Spend Authority Narrow

Scope each agent authority by as many of these as possible:

- Token.
- Amount.
- Reset period.
- Expiry.
- Recipient allowlist, where feasible.
- Protocol allowlist.
- Per-transaction cap.
- Total cap.
- Revocation path.
- Human approval threshold.

Avoid broad permissions:

- Unlimited token spend.
- Unlimited recipient spend.
- No expiry.
- No reset.
- No per-transaction cap.
- No user-visible revocation.

### Treat Relaying As Non-Discretionary Infrastructure

Haven relay may:

- Receive a signed request.
- Validate syntax and signature.
- Check that the transaction matches user-approved on-chain authority.
- Submit the transaction to the network.
- Return transaction status.

Haven relay must not:

- Alter recipient.
- Alter amount.
- Alter token.
- Choose a different asset.
- Choose a different merchant.
- Decide whether a user should pay.
- Batch transactions in a way that changes user or agent economic intent without explicit prior approval.

Server key roles must remain narrow and distinct:

- `RELAYER_PRIVATE_KEY` and per-chain `RELAYER_PRIVATE_KEY_<chainId>` keys fund gas and submit delegate-signed Allowance Module calls. A relayer key does not supply the delegate signature and cannot authorise a payment by itself.
- `X402_BINDING_PRIVATE_KEY` signs the exact expected x402 authorization context, including the corresponding sweep context. It authenticates Haven-provided context; it does not sign the payment or spend funds.
- The relayer additionally signs **L0 agent passport attestations** as *issuer* (epic #970). That is governance metadata, not spend authority: the transaction targets the pinned EAS contract, carries `value: 0`, encodes no transfer, and involves no user key, delegation, or allowance. It is triggered by the owner opting in — never by a payment — so it sits outside the payment paths entirely. The owner opts in from two entry points that run the identical eligibility check and fire-and-forget issuance path: `POST /agents`' `issue_passport` flag, and (#1072) an `issue_passport` flag recorded on the Connect Agent 2 setup at creation and acted on once `POST /agent-connection-setups/register` has created the agent row. Neither path can make issuance block, delay, or roll back agent creation/registration.
- `PASSPORT_RECEIPT_SIGNING_KEY` signs merchant-facing verification receipts. Its address is published for pinning, it asserts only an agent's governance standing, and it is refused at boot if it matches the relayer key.
- No key above may be reused as an agent, user, or unrestricted payment signer.
- Vendor infrastructure credentials (bundler/sponsorship URLs) are read at one choke point and must never reach an error surface, a log line, or an API response. `redactVendorSecrets` covers the shapes vendors actually ship: `apikey=`/`api_key=`/`api-key=`/`key=`/`token=`/`secret=` query params, URL basic-auth, and key-in-path segments (#1061). A chain-scoped bundler URL is also asserted against the chain being served, so a misconfigured deployment fails as a config error rather than relaying at the wrong chain's endpoint.

### Keep Transaction Construction Deterministic

Transaction construction should be based on:

- Agent or user signed intent.
- Protocol challenge.
- Configured Safe/module state.
- Explicit user-approved settings.

Avoid:

- Hidden business logic.
- Implicit routing.
- Best-route decisions.
- Financial optimisation.
- Unapproved fallbacks.
- Automatic conversion.

### Maintain Evidence That Haven Does Not Control Funds

The codebase should make it easy to prove:

- Haven has no private key storage table.
- Haven has no signer capable of spending user funds.
- Agent keys are not stored by Haven.
- All executable transfers require external signatures.
- On-chain Safe/module limits constrain Safe-originated funding; external signatures and exact authenticated context constrain the standard x402 merchant leg.
- Users can revoke permissions outside Haven.

Add comments, docs, tests, and PR notes around these points when touching payment, agent authority, relaying, Safe setup, SDK, or demo payment flows.

## Feature Review Triggers

Escalate for legal and product review if a proposal or PR introduces any of the following:

- Server-side private key generation.
- Server-side private key storage.
- Agent key custody.
- API-key-only payment execution.
- Off-chain-only spend limits.
- Haven-controlled signer that can spend user funds.
- Token swaps.
- On-ramp or off-ramp.
- Fiat balances.
- Card issuing or virtual cards.
- Raw card credential handling.
- Merchant payment acceptance.
- Payment settlement for third parties.
- Aave, yield, or treasury automation.
- Personalised financial recommendations.
- Automated asset allocation.
- Optimise payment route logic.
- Any ability for Haven to expand, override, or bypass Safe module constraints.
- Any user lock-in that prevents Safe access outside Haven.

## Third-Party On-Ramp Integration

Haven's "Add funds" feature embeds a link to a licensed third-party on-ramp provider (currently Coinbase Onramp). The regulatory position is as follows:

**Haven's role:** UI only. Haven constructs a provider URL containing the user's Safe address as the fixed destination. Haven never receives, holds, transmits, or processes fiat funds or crypto-assets at any point in the flow.

**Provider's role:** The third-party provider (Coinbase) handles KYC/AML, fiat custody during purchase, fiat-to-crypto conversion, and direct settlement of USDC to the user's Safe address on-chain.

**Why this does not create a Haven CASP exposure:**
- Haven does not participate in the fiat leg, the conversion, or the settlement.
- Haven does not receive any fees, spreads, or commissions from the provider for routing users (if a referral programme is used, re-evaluate this claim).
- USDC settles directly to the user's Safe — Haven never holds it in transit.
- The user contracts directly with the provider; Haven is the referring product, not a party to the purchase.

**Constraints that must be maintained to preserve this position:**
- The Safe address must be the non-editable destination inside the widget context; Haven must never allow a user to redirect the destination to an arbitrary address through Haven-controlled UI.
- Haven must not co-mingle on-ramp proceeds with Haven-controlled funds.
- If a revenue-share or referral arrangement with the provider is introduced, obtain a separate legal review before enabling it.
- If Haven ever pre-funds purchases (e.g., instant availability before on-chain settlement), this becomes a credit or payment service — do not implement without a separate regulatory review.

## Payment-Related Merge Checklist

> Since #995, all payment/x402/machine-payment SQL lives in
> `packages/backend/src/infra/repositories/` (routes and libs hold control flow
> only), and every settlement statement is PREPARE-checked against the real
> schema in CI via `db-schema-smoke` — a schema/query drift on the money path
> now fails the build instead of 500ing in production.

Before merging any payment-related, agent-authority, Safe, SDK, x402/MPP, or relayer change, verify:

- [ ] Haven does not store user private keys.
- [ ] Haven does not store agent private keys.
- [ ] Haven does not store seed phrases.
- [ ] Haven does not operate a server-side signer that can spend user funds.
- [ ] API keys cannot authorise payments by themselves.
- [ ] Every automated payment requires an agent-held or user-held key signature.
- [ ] Every Safe-originated automated funding transfer is constrained by Safe Allowance Module or equivalent on-chain control; any standard x402 merchant leg carries the agent-held delegate signature and matches exact authenticated payment context.
- [ ] Haven database policy is not the only spend control.
- [ ] A user signature establishes or modifies agent authority — a user-approved Safe transaction on the legacy rail, an owner-signed delegation on the delegation rail.
- [ ] Users can revoke agent authority on-chain.
- [ ] Users can access their Safe through another UI.
- [ ] Haven cannot block or freeze user funds.
- [ ] Haven cannot expand agent allowances without user approval.
- [ ] Haven cannot change recipient, amount, token, route, or timing after signature.
- [ ] Haven does not perform swaps, ramps, fiat payments, card issuing, yield, advice, or merchant settlement.
- [ ] Logs clearly show user or agent signature, Safe/module state, transaction hash, and relay status.
- [ ] Product copy does not say Haven holds, manages, transfers, or controls user funds.

## Product Copy Rules

Use wording like:

- Haven helps you configure agent spending limits on your Safe.
- Agents can request payments within user-approved on-chain limits.
- Safe funding is signed by your agent key and constrained by your Safe; a standard x402 merchant payment is separately signed by the same agent-held key from its available balance and bound to the exact payment context.
- Haven relays policy-limited Safe transactions.
- Haven cannot move funds outside the limits you approve.
- You can revoke agent access through your Safe.

Avoid wording like:

- Haven holds your funds.
- Haven manages your wallet.
- Haven transfers money for you.
- Haven executes payments on your behalf.
- Haven gives agents access to your wallet.
- Haven is your payment processor.
- Haven optimises your treasury.
- Haven recommends the best yield.
- Haven gave you the private key.
- Haven signs and settles the payment.

Known compliance gap: `UsingYourAgentInfo.tsx` still uses both of the final two
phrases above. Do not copy that wording into new surfaces; update that component
in a product-copy change before treating the covered UI as compliant with this
rule.

## Preferred Architecture Summary

```text
User funds
  -> held in user-controlled Safe

Delegate balance
  -> held in agent-controlled EOA, never by Haven
  -> may be pre-existing, newly funded from the Safe, or residual

User authority
  -> Safe owner wallet/passkey
  -> user signs Safe transactions

Agent authority
  -> user-approved Safe Allowance Module permission
  -> agent-held or user-held private key
  -> on-chain limits
  -> Safe-originated funding follows on-chain Safe constraints
  -> standard x402 merchant leg is exact-context-bound and spends delegate balance

Haven role
  -> UI
  -> transaction construction
  -> policy display and pre-check
  -> non-discretionary relay
  -> logs, receipts, and status

Haven must not be
  -> custodian
  -> key holder
  -> payment processor
  -> exchange
  -> broker
  -> portfolio manager
  -> merchant acquirer
  -> fiat PSP
```

## Verification log

Every re-verification of this document, newest last. A contract doc covering
broad globs is touched by nearly every backend change, so this is the audit
trail of *what was checked and found unchanged* — not a changelog of the
document's own edits.

It lives here rather than in the `last-verified` front-matter comment, where it
grew into one ever-lengthening line ([#1194](https://github.com/d-hinders/Haven-AI/issues/1194)).
Because every PR appended to that same line, two concurrent PRs conflicted
there **by construction** — five times in one day — and each resolution risked
silently dropping someone's entry, which is the one thing this record exists to
prevent. Separate lines merge cleanly. The tooling never read the comment
anyway: `validate-frontmatter.mjs` strips it and `audit-staleness.mjs` reads
only the date.

**Adding an entry:** append a bullet, bump `last-verified` to the date you
actually re-read this document. A rubber-stamped date is worse than a stale
one — the staleness audit ranks on it.

- **#997** — covers updated (lib/machine-payments.ts moved into modules/mpp/**; the shared token-resolution primitive lives in domain/payment-token.ts) — no perimeter change, the same routes/repositories still enforce it.
- **#998** — covers + body re-read after the lib/ fold (execution-rail.ts -> rails/, fortnox-connector.ts already under modules/reporting/, accounting-entry.ts/catalog-discovery.ts/merchant-catalog.ts/safe-deployer.ts relocated) — pure path move, the perimeter and the non-asserting Fortnox invariant are unchanged.
- **#999** — fortnox-connection persistence moved verbatim behind infra/repositories, agents.ts gained the auth/last-seen queries, and the exempted routes carry inline dep-lint-exempt waivers — perimeter unchanged.
- **#1167** — routes/user.ts, routes/dashboard.ts and routes/agent-activity.ts moved their SQL verbatim behind infra/repositories (agents.ts gained a read-only id+name projection for the activity feed); no statement's predicate, scope or result changed, no new authority, nothing on the money path — perimeter unchanged.
- **#1179** — the two duplicate actionable-approval COUNT statements converged into one in approval-requests.ts (identical predicate and status set — the copies differed only in AS/as casing); it is a display counter that gates nothing, the queue's own authority model and the owner-signed execution path are untouched — perimeter unchanged.
- **#1189** — the hosted MCP's relayed expected context now carries the resource_url Haven signed rather than the accepted option's own — a fail-CLOSED bug (the signer refused a divergent reconstruction), so no payment was ever authorised under an unverified field; no route, authority or perimeter changed.
- **#1154** — the mcp-server change is a TEST ONLY (x402-expected-wire-contract.test.ts) — no route, module or wire shape moved, so the perimeter is unchanged. It strengthens the non-custody claim rather than restating it: the delegate key is now proven, in CI, never to leave the edge signer, and the money path's default topology (hosted MCP + local signer) is exercised end to end on Base Sepolia by the qa-dev leg that feeds the promotion gate.
- **#1161** — connect/signer/mcp gained a Node-version floor (refuse below the declared engines floor at setup and at signer/MCP startup) sourced from a single SDK constant. No custody, authority, key-handling or payment-path change — nothing signs, relays, or moves value differently; the change only REFUSES to run an existing signing component on an undeclared runtime, which narrows the operating envelope rather than widening it. Every invariant in this doc re-read against the diff and unchanged — perimeter unchanged.
- **#1187** — TEST ONLY (hosted-signer-integration.test.ts extended to the delegation rail's v2 path) — it strengthens the custody claim rather than restating it, since the key-never-in-hosted-traffic assertion now covers BOTH rails instead of only the legacy one; no route, module or authority changed.
- **#1155** — the signer publishes its supported expected-context version set at handshake and the hosted quote reports the version it will emit. Both are observability on the payment path, not authority over it — no key role added or widened, no relay discretion introduced, no new refusal (a quote whose version the signer may not know still succeeds), and the binding-verification path in signer/core.ts is untouched. Invariants re-read against the diff — perimeter unchanged.
- **#1145** — the delegation rail's reported `remaining` now comes from the ERC20PeriodTransferEnforcer's own storage rather than always reporting the full period budget — a REPORTING correction with no new authority (the enforcer already gated every redemption and still does; an over-budget attempt reverted before this change and reverts after it). It makes Haven's guidance match what the chain will allow instead of overstating it, and a failed read falls back to the old number rather than to a zero that would stop a funded agent — no route, perimeter or control changed.
- **#718** — the allowance-nonce coordinator gained a shared Postgres watermark so a multi-replica backend waits on the highest nonce ANY replica confirmed; it is an optimisation that avoids a revert-and-retry, fail-open in BOTH the repository and the coordinator, and the #693 preflight remains the control that actually prevents a double-spend — no authority, route or perimeter changed, and no path became able to move funds it could not move before.
- **#1196** — the #692 nonce coordinator now runs on all FOUR legacy-rail sign-hash builders instead of one (`routes/payments.ts`, `modules/mpp/send.ts` and `modules/mpp/authorize.ts` joined `modules/x402/legacy-authorize.ts`), with the shared watermark prefetched alongside each site's existing chain reads. Purely an accuracy/latency change on which nonce a signature targets: no new authority, no new refusal, and the #693 preflight remains the control that prevents a double-spend on every path — it simply makes three paths revert-and-retry as rarely as the fourth already did. Perimeter unchanged.
- **Promotion-batch review** — remediation of the review of the full `dev → main` batch. Two guards that did not guard were repaired: `nonce-coverage.test.ts` asserted the nonce coordinator was *called* but not that its result was *assigned*, and `auth.test.ts`'s #1069 guard was satisfied by an import line, so `/auth/me` could silently drop `account_type`. Both were proven by mutation before and after. Also bounded the delegation budget read for real (`retryCount: 0` — viem's `timeout` bounds an attempt, not the call) and corrected three claims that #1153 had made false, including `CLAUDE.md`'s statement that the #908 signer floor is still ENFORCED. No enforcement point, authority, route or perimeter moved: this is test strength, one transport option and prose accuracy.
- **#1209** — the #692/#1196 nonce-coordinator wait at all four legacy-rail sign-hash builders moved BELOW each site's coverage/divert decision, so the queue and insufficient branches (which sign nothing and return before any hash exists) no longer pay a bounded wait for a nonce they discard. Ordering only: the wait still runs before every `generateTransferHash`, its result is still assigned, the shared-watermark prefetch is unchanged, and the #693 preflight remains the double-spend control on every path — no authority, refusal, route or perimeter changed. A structural test now pins the ordering at all four sites.
- **#1229** — a user may now hold more than one passkey per chain (migration 056 drops the `(user_id, chain_id)` unique), so a legacy passkey Safe can take a second passkey as a Safe OWNER. This is the recovery mechanism line 261 already claims ("additional owners… user-controlled") finally being reachable on this rail — it was refused at enrolment before, which meant the only backup available was a wallet. Custody is unchanged and, if anything, less concentrated: Haven still holds no private material (only credential id + P-256 public coordinates), the owner change is a Safe self-call signed by an EXISTING owner and merely relayed by Haven, and nothing here lets Haven add, remove or use a signer. `/safe/exec` gained a `credential_id` field to say WHICH of the user's passkeys signed, and authorises an as-yet-unbound one only when the chain reports it as an owner. Be precise about that last clause, because the first draft of this entry was not: measured against the PRE-PR state it is a WIDENING of relayer eligibility, not a narrowing. Before, the route relayed only for a Safe recorded in `user_passkeys.safe_address` — a column written solely by `/safe/deploy`, i.e. Safes Haven itself created for that passkey. Now it will also relay for any Safe on the chain whose on-chain owner list contains an enrolled signer of the authenticated user, including Safes created outside Haven entirely. Accepted deliberately: a backup passkey has no binding until it is used, so refusing unbound rows would refuse exactly the recovery case this change exists to enable. The exposure is GAS, bounded by the #717 per-user relayer budget and by the requirement that the caller actually be an owner of the target Safe. The "who may move funds" half is unchanged and unarguable — the Safe verifies every signature on-chain, and a wrong answer here can waste relayer gas but can never move value. Perimeter unchanged.
- **Migration 057** — a one-row data correction in `merchant_catalog`: the MPP demo entry's `resource_url` pointed at a path that never existed (`/demo/mpp/resource`, seeded by 019) and now points at the real route (`/demo/mpp/market-summary`). Catalog metadata only: no authority, no key material, no payment path, no refusal changed — the row describes where a demo merchant lives, and the payment that follows it still runs the full challenge → signed-transfer flow under the on-chain allowance. Perimeter unchanged.
- **#1254** — the direct-payment path (hosted `haven_pay`/`haven_send` → local `haven_sign`) now carries the delegation-rail signing contract end-to-end: the hosted tool forwards the backend's `signature_scheme` + EIP-712 `typed_data` verbatim, and the local signer signs the TYPED DATA when present instead of raw-signing `payload_hash`. This is the #1138 boundary applied to a path that had silently escaped it — the delegate key still never leaves the local signer, Haven still only *declares* what is to be signed, and the fix makes the local signer produce the signature the account actually validates (previously the bare-hash signature was rejected on-chain, AA24, fail-closed with no funds moved). No new authority, no new route, no refusal removed; both fixes proven by mutation. Perimeter unchanged.
- **#1255** — delegation-rail signing payloads now travel in a second, copy-through-safe transport: the hosted tools return `typed_data_b64` (the same EIP-712 payload as one opaque base64 string) alongside `typed_data`, and the local signer accepts it, decoding into the SAME digest verification against the Haven-signed expected context. Pure transport: nothing new can be signed (a decoded payload that does not match the committed digest is refused exactly as before — the live incident this fixes was that refusal firing on an agent-mangled copy), no authority, route, key or refusal moved. Perimeter unchanged.
- **#1256** — the SDK's EIP-3009 authorization window gained a 300 s settlement forward margin on top of the #715 clamp (total forward validity ≤900 s, previously ≤600 s), applied at the single pre-sign choke point. This widens the life of a signed-but-leaked merchant authorization by up to 300 s and was accepted deliberately: without the margin the header cannot satisfy the facilitator's `validBefore ≥ now + maxTimeoutSeconds` verify rule after Haven's funding leg confirms, so every purchase against a ≥300 s-timeout merchant failed structurally (proven live on Base mainnet; funds fail-stranded on the funding leg, recovered by sweep). Exposure remains bounded by the same clamp discipline and the exact-amount funding; no authority, route, signer or refusal changed. Perimeter unchanged.
- **#1263** — the local signer's MCP layer gained its ONE network capability: a read-only, agent-credential-authenticated `GET /x402/:id/sign-context` that fetches a pending delegation-rail intent's exact signing payload + a freshly Haven-signed expected context, so the agent relays only `payment_id` instead of a language model re-emitting multi-KB EIP-712 bytes (the #1255-class failure that stalled two live production purchases AFTER the transport hardening). Boundary analysis: the signer CORE stays network-free; the fetch is a strictly better byte source than model relay (TLS to Haven versus a model context window, which was already the implicitly trusted channel); fetched bytes pass the SAME Haven-binding verification and digest re-derivation as tool-argument bytes, so nothing new can be signed; the backend endpoint constructs nothing — it re-serves what the #961 replay could always rebuild from the stored row, agent-scoped, read-only, with 404-on-foreign-id. The delegate key still never leaves the process and Haven still never signs. The consent surface tells the truth about it: the first-launch consent text now discloses the read-only fetch, and a SIGNER_CONSENT_SURFACE_VERSION folded into the acknowledgement hash re-prompts every existing install exactly once — an ack given under the old "does not call the Haven API" text does not silently cover the new behavior. Perimeter unchanged in authority; widened by one authenticated outbound READ, recorded here deliberately.
- **#1251** — MPP entry points (`modules/mpp/authorize.ts`, `send.ts`) now REFUSE delegation-rail accounts (422 `rail_not_supported`) instead of falling through to legacy allowance coverage, which manufactured approvals that could never execute (AllowanceModule reads zero for a Hybrid; approving reverted on-chain). Fail-closed narrowing at the rail seam, the #745/#993 pattern: no authority added, no payment path widened — a path that silently produced dead approvals now answers honestly. The rail gate moved ABOVE the allowance-config check so the refusal never depends on legacy display rows. Found live during the #908 mainnet canary. Perimeter unchanged.
- **below-min sweep mapping (PR #1269)** — the hosted `haven_sweep_delegate` phase-1 result now maps the backend's deliberate `below_min` response (#700 dust floor) to `status: 'below_minimum'` with the floor named, instead of falling through to `signature_required` with `authorization`/`expected_auth` undefined — an instruction to sign a payload that does not exist. Response-mapping only: no authority, route, signing surface or refusal changed; the floor itself (and the fact that no authorization is built below it) is untouched. Perimeter unchanged.
- **skip-settle chain gate (PR #1277)** — the demo merchant's verify-without-settle QA hook (#603) is now code-gated to Base Sepolia: startup refuses with `MERCHANT_SKIP_SETTLE_PRODUCT` set on any other chain. Before this, one copy-pasted env var on a mainnet instance made every listed product deliverable against a merely well-formed EIP-3009 authorization from an empty wallet — the only balance check lives inside the settlement call the hook skips. Adds a refusal, removes nothing; merchant-side only, no Haven authority or custody surface involved. Perimeter tightened.
- **reverted-settlement retry (PR #1280)** — the demo merchant's settlement retry now distinguishes a MINED-AND-REVERTED tx (typed signal from the receipt check) from a transient receipt-fetch failure: a proven revert clears the in-process attempt so a replay of the same payment header resubmits, while a transient error still re-confirms the same hash (pinned from both sides by tests — a slow-but-successful tx can never be double-submitted). Liveness fix on the merchant side only: verification, amounts, recipients and delivery ordering unchanged; resubmission after a proven revert is bounded by on-chain EIP-3009 nonce uniqueness (erc7710: delegation state). Perimeter unchanged.
- **audit tail (PR for #1279)** — three demo-merchant hardenings from the correctness audit: `validBefore = 0` is now refused as expired (EIP-3009 on-chain semantics — the old special case read it as "no expiry", the opposite of what the chain does); an authorization whose forward validity exceeds the quoted timeout by more than a bounded slack (covers the #1256 client margin) is refused instead of silently accepted; and `formatUsdc` renders invoice-facing amounts with pure bigint math. Plus the two missing test classes: restart+replay (on-chain nonce uniqueness proven as the backstop against double delivery) and the 3009 twin of the cross-product nonce guard. All refusal-adding or test-only; nothing weakened. Perimeter tightened.
- **#1275** — hosted MCP tool descriptions now make `max_amount` the normal path for paid merchant calls, and both quote surfaces carry a soft `cap_warning` when it is omitted. Guidance and observability only: the enforcement itself (live-quote comparison before any funding, refusal over the cap) predates this and is unchanged, and the cap remains an ADDITIONAL per-purchase user-intent ceiling — never a replacement for the on-chain agent budget. No authority, route or refusal changed. Perimeter unchanged.
- **#1207** — `POST /payments` gained the idempotency contract its money-path siblings have carried since migration 020, on the same key column: a retried request returns the FIRST request's result (a still-signable intent replays its original sign_data — delegation rows rebuild the exact stored signing payload, never a fresh estimation; a pending approval replays as 202 so a retry can never open a SECOND approval), a key reused for a different transfer is 409, and a 23505 race replays the winner. This closes the one direction a client timeout costs money (retry → second transfer). No authority, signer or custody surface changed — the payment still requires the same delegate signature and the same on-chain policy; this only makes the retry safe. SDK/MCP surfaces plumb the previously-dropped key through. Perimeter unchanged.
- **#1266** — the internal demo merchant now advertises both EIP-3009 and ERC-7710 settlement options when the operator-configured DelegationManager matches the pinned per-chain registry, including Base mainnet. This retires the older "mainnet never advertises erc7710" demo guard deliberately: the replacement is pin-and-refuse, not bare-env trust. EIP-3009 remains first/default for shipped client compatibility; missing or mismatched ERC-7710 config omits that option instead of crash-looping hosted prod; ERC-7710 verification still simulates the pinned DelegationManager and advertises `facilitatorAddresses` for redeemer caveats. Demo merchant only, no Haven custody, merchant-acquiring, fee, or settlement-provider role added. Perimeter unchanged in authority.
- **#1272** — the hosted x402 quote tools no longer emit the delegation-rail signing payload (`typed_data`/`typed_data_b64`) by default; the local signer fetches the exact bytes itself via the #1263 authenticated read and runs the same Haven-binding verification and digest re-derivation regardless of transport. An explicit `include_signing_payload=true` restores the full response for diagnostics and pre-#1263 signers, and the recovery loop replays the ORIGINAL sign_data under the #1207 idempotency contract — the bytes a signer sees can never change between the compact and full forms of the same intent. Response-shape narrowing only: nothing new can be signed, no authority, route, key, custody surface or refusal changed; the model-relayed transport (the #1255 corruption class) becomes opt-in instead of default. The #1154 QA leg now asserts the compact shape and signs through the payment_id fetch, so the promotion gate exercises the production default. Perimeter unchanged.
- **#1271** — `haven_pay_mcp_tool` accepts a base merchant URL: a non-402 probe miss triggers ONE discovery pass — GET of exactly two fixed paths (`/.well-known/haven-demo-merchant`, `/`) on the SAME origin as the input, `redirect: 'error'`, 5 s timeout, 64 KB read cap — and one retry at the document's `mcp_url`, accepted only when it stays on that origin (an off-origin `mcp_url` is refused at validation and never fetched, mutation-proven). This widens hosted MCP's outbound surface by two bounded same-origin GETs and nothing else: no redirect following, no URL from the document other than the same-origin `mcp_url`, no probing beyond the fixed list — deliberately not a general network scanner. Discovery finds endpoints only; signing, spend checks, budgets and refusals are untouched, and the resolved URL is reported back to the agent (`merchant_url` + `merchant_url_discovered_from`) rather than acted on silently. Perimeter widened by a bounded read, recorded here deliberately.
- **#1297** — the merchant catalog now carries product-variant `tool_arguments`, seeds the standalone demo merchant's CloudNest/NordShield rows for Base Sepolia and Base mainnet, and filters agent-key catalog reads to the authenticated agent's chain. This is discovery metadata and a refusal-to-advertise-mismatched-networks guard only: the live x402 402 still supplies the authoritative recipient, asset, network, amount, and settlement options; Haven still receives no delegate key; API credentials alone still cannot spend; and every purchase still requires the existing local signature plus on-chain account policy. Perimeter unchanged.
- **#1273/#1274** — the demo merchant's `list_products` now returns stable, machine-readable per-product metadata (`product_id`, `arguments_schema`, `supported_settlement_methods`, `default_settlement_method`, `mcp_url`, …) built from the same #1266 settlement-method resolution the merchant already advertises — it consumes, never re-decides, the eip3009-first/erc7710-pinned-manager gate, so that contract is inherited rather than restated. `buy_vpn`/`buy_cloud_storage` now also return a top-level `summary` (status, product, amounts, tx hash) read straight off the already-SETTLED `SettledPayment`, never re-derived from the quoted catalog price. Both are DISPLAY/REPORTING data only, documented as such in code: the `x-receipt-json` header, invoice and on-chain settlement state are untouched, and `status: 'confirmed'` is reachable only after on-chain settlement is proven. Demo merchant only, no Haven custody, merchant-acquiring, fee, or settlement-provider role added. Perimeter unchanged.
- **#1300** — every merchant-facing SDK fetch (x402/MPP probes, MCP handshakes, paid retries, resume retries — ten call sites) is now bounded by `merchantTimeout` (default 60 s, caller signals combined via AbortSignal.any), with a timeout surfaced as a clear 504 naming the URL; and quoteX402's non-402 miss became the typed `X402UnexpectedStatusError`. Availability hardening and error typing only: no authority, route, signing surface, custody boundary or refusal changed — a hung merchant can no longer hold a hosted tool call open indefinitely, which narrows a DoS surface rather than widening anything. Perimeter unchanged.
- **#1300 (calibration)** — the post-merge review found the 60 s merchant-fetch default contradicted the repo's own tolerances (the merchant's advertised `maxTimeoutSeconds: 300`; viem's 180 s settlement wait), risking client-side aborts of legitimately-settling payments; the default is now 300 s (test-pinned ≥ the contract) and a timeout AFTER confirmed funding is routed to a distinct `MERCHANT_UNRESPONSIVE_AFTER_FUNDING` code whose guidance is verify-then-sweep — an unanswered paid retry is NOT proof of rejection, the merchant holds a valid EIP-3009 authorization and may settle late, so blind sweeping could race a late settlement. Availability calibration and failure classification only; no authority, route, signing surface or custody boundary changed. Perimeter unchanged.
- **#1308** — x402 MCP purchase responses gained a structured next-step contract (`next_action` from the existing taxonomy, `next_tool`/`next_arguments`, `safe_to_continue`, `agent_summary`, advisory `warnings[]` where MISSING_MAX_AMOUNT absorbs the #1275 cap nudge back-compatibly). Guidance and observability only: warnings never replace a refusal, failure codes are unchanged, pending-approval explicitly marks `safe_to_continue: false` so an agent cannot read over-budget as continuable, and no authority, route, signing surface or custody boundary moved. Perimeter unchanged.
- **#1301** — the #1271 bounded discovery helper (two fixed same-origin GETs, `redirect: 'error'`, 5 s timeout, 64 KB read cap, off-origin `mcp_url` refused unfetched) moved from mcp-server into `@haven_ai/sdk` and is now shared verbatim by the local/self-signed MCP runtime's `haven_pay_mcp_tool` — closing the parity gap where a base merchant URL only worked against the hosted topology. Same bound, same behavior, one more caller: the local flow's miss predicate differs only in SHAPE, not in scope — `haven.fetch()` never surfaces a bare 402 to the caller (it resolves one itself), so a non-ok `Response` from the untouched first hop is the local equivalent of the hosted probe's typed `X402UnexpectedStatusError`, and both route into the exact same same-origin-only helper (mutation-proven in both packages: severing the origin check fails the off-origin test in mcp-server, packages/mcp, AND the SDK's own unit tests). Discovery still finds endpoints only — no payment authority, no key material, no probing beyond the fixed two paths on either surface. Perimeter widened by the same bounded read #1271 already recorded, now reachable from one more entrypoint; nothing new was granted.
- **#1307** — the settle-leg twin of #1263: `haven_settle_mcp_tool` / `haven_complete_mcp_tool` accept `merchant_url`/`tool_name`/`arguments`/`mcp_transport` as OPTIONAL and, when omitted, Haven rehydrates them by `payment_id` via a new read-only `GET /x402/:id/merchant-call-context`, extending the #1263/#961 `rebuildDelegationSignContext` rehydration precedent to a second piece of stored state. `haven_pay_mcp_tool` persists the merchant call context it was invoked with on the funding intent's EXISTING `machine_metadata` JSONB column at quote time (the same blob `settlement_scheme` already lives in — no migration, no new table). This is convenience metadata for retrying the MERCHANT's own JSON-RPC call — where to redeliver the already-signed X-PAYMENT header — never payment authority: a wrong or missing value fails the outbound merchant HTTP call, it cannot redirect funds, alter the signed payment intent, or expand what the agent may spend, because the funding leg's signature verification, the on-chain policy check, and (for EIP-3009) the merchant facilitator's own exact-context check are all untouched and still the only things that authorize a transfer. The endpoint is agent-scoped (`findIntentForAgent`) and read-only (no write on a non-expired read, mutation-proven — this is also the idempotency guard: a merchant-delivery retry after `MERCHANT_UNRESPONSIVE_AFTER_FUNDING` must not be forced into a fresh, re-funding quote just because the funding intent's original signing window lapsed while awaiting the merchant). Refusals: unknown/foreign `payment_id` → 404 (same answer either way, no enumeration signal); no stored context, or an incomplete one → 409 naming the fallback (re-send the four fields explicitly — the pre-#1307 shape, or a plain non-MCP-tool x402 resource that was never quoted with a call context); the funding/quote window expired → 410, lazy-expiring only a still-`pending_signature` row past its window, exactly like #1263 — a row that already moved past `pending_signature` (funding submitted/confirmed) stays servable indefinitely, so it can never be starved into re-funding by this read. The old explicit-context path is unchanged and remains the version-skew fallback. Perimeter unchanged: no new key role, no new signer, no route gained the ability to move funds it could not move before — only a rehydration READ was added, agent-scoped and non-discretionary like #1263's precedent.
- **#1308 (review-komplettering)** — guidance-kontraktet täcker nu även den dekomponerade quote-vägens pending-approval (samma `safe_to_continue: false` som en-anropsverktyget) och settle-verktygets icke-bekräftade funding-gren (kö-för-approval = användarbeslut/unsafe; transient bekräftning = poll/safe); typen döptes till AgentPaymentSummary före publicering. Vägledning enbart: inga refusals ändrade, ingen auktoritet flyttad. Perimeter oförändrad.
- **#1306** — the guided catalog-purchase preflight (`haven_prepare_catalog_purchase`) composes EXISTING reads and the EXISTING quote/intent path — it adds no new spend authority. `GET /catalog/:id` (chain-scoped for free by the #1299 SQL), `GET /machine-payments/agent`, `GET /machine-payments/allowances` (rail-aware since #1135), and `POST /x402` (`createX402Intent`, identical to `haven_pay_mcp_tool`) are all reused verbatim; the merchant quote probe (including the #1271 discovery fallback) is now one shared helper (`quoteMcpToolCall`) instead of two copies. One additive field was needed to label the allowance block correctly without a second derivation: `GET /machine-payments/agent` now also returns `execution_rail: 'legacy' | 'delegation'` — reporting only, the same two-value bucketing `GET /machine-payments/allowances` already branches on internally (#1135), so it tells a caller nothing the backend didn't already decide for itself on every request. The response's `allowance` block (`{ rail, sufficient, remaining_atomic?, source }`) is read-only guidance: a failed read degrades to `sufficient: null` plus a warning rather than a fabricated true/false, and NEVER fails the preflight — the on-chain policy remains the actual gate either way. Rail behavior is asymmetric ON PURPOSE and matches what each rail's real enforcement already does: on the legacy rail an insufficient allowance still proceeds to `createX402Intent`, which (as it always has) queues the resulting payment for wallet-owner approval; on the delegation rail, where no approval queue exists, an over-budget quote is refused HERE, before any funding intent exists, rather than letting a same-day on-chain redemption revert later — this NARROWS what the preflight will construct, it does not widen anything the delegation caveats did not already enforce. API-key auth remains identity only throughout: every refusal and every guidance value is derived from data the backend already computed (the catalog row's own chain scope, the account's own `execution_rail`, the account's own derived budget/allowance), never from anything the caller asserts. Perimeter unchanged.
- **#1310** — successful x402 MCP settlement responses (`haven_settle_mcp_tool`'s `settled: true` branch) and `haven_get_payment_status` for a genuinely settled x402 payment (`rail: 'x402'`, `phase: 'payment_confirmed'`; `funded_but_unsettled` deliberately excluded) now carry a post-purchase `allowance` summary — read-only reporting, no new backend endpoint or route. The new SDK method `HavenClient.getPostPurchaseAllowanceSummary(paymentId)` resolves the settled token from the EXISTING `GET /machine-payments/:id/status`, then reads through the EXACT same path #1306's preflight block and `haven_get_allowances` already use (`GET /machine-payments/agent` + `GET /machine-payments/allowances`; delegation-rail values are the #1090 `deriveDelegationBudgets`-backed enforcer read, never `agent_allowances`) — so it can never disagree with `haven_get_allowances` for the same fixture (parity-tested in both directions: SDK unit tests and mcp-server tool tests assert equality, not similarity). The summary shape (`{ rail, remaining_atomic, remaining_display?, token_symbol?, token_address?, reset_period?, source }`) deliberately reuses #1306's field spellings, minus the preflight-only `sufficient` field. A failed read (status lookup, agent lookup, or the allowance/budget lookup itself) NEVER converts a succeeded settlement into a failure — mutation-proven by severing the method's try/catch, which flips the "settled:true despite a failed allowance read" test from pass to fail; it degrades to `{ allowance: null, warnings: [ALLOWANCE_CHECK_UNAVAILABLE] }`, the SAME warning code #1306 introduced (confirmed SDK-side-only per #1318, reused rather than respelled). Local `@haven_ai/mcp`'s `haven_get_payment_status` gained the identical attachment for entrypoint parity; local `haven_pay_mcp_tool`'s architecturally-different single-call flow (a transparent `fetch`-like proxy with no payment_id surfaced to the caller) was deliberately left out of scope — flagged to the captain as a follow-up rather than silently dropped. No key material, no new refusal, no authority change: the response only says what remains, never what may be spent. Perimeter unchanged.
- **#1309** — the #1143 signer-version refusal (unsupported x402 expected-context / sweep-binding version) is now STRUCTURED instead of Zod-prose-adjacent free text: `packages/signer/src/core.ts`'s `assertSupportedBindingVersion` throws a typed `HavenUnsupportedSignerVersionError` (`@haven_ai/sdk`) carrying `code` (`UNSUPPORTED_EXPECTED_CONTEXT_VERSION` | `UNSUPPORTED_SWEEP_BINDING_VERSION`), `supportedVersions`/`receivedVersion` DERIVED at the throw site from `SUPPORTED_X402_EXPECTED_VERSIONS`/`SUPPORTED_SWEEP_BINDING_VERSIONS` (never a second literal), and `fallback` recovery text; the tool boundary (`haven_sign`/`haven_sign_x402`/`haven_sign_sweep_delegate`'s `normalizeError`) relays those fields plus `next_action: 'stop_and_tell_user'` — the EXISTING `AgentPaymentNextAction` value, no new taxonomy entry, so this needed no sdk→backend→spec→api-types four-gate (these codes never reach the backend's REST/OpenAPI surface; they are local-signer-only). The refusal's CONTENT is byte-identical to before: same prose `message`, same "do not rewrite `auth.version`" instruction, same fail-closed point before any content check, nothing newly signable and nothing newly refused — an agent-diagnosability improvement only, exactly the gap `docs/operations/mcp-runtime-compatibility.md`'s Zod-prose rows document. The hosted quote's ALREADY-SHIPPED (#1155) advisory `signer_compatibility` field gained one field, `fallback`, carrying the SAME `SIGNER_UPDATE_FALLBACK` string (`@haven_ai/sdk`) as the signer's own refusal — single source, so an agent reading either surface as data gets identical guidance; the field remains advisory (hosted MCP still cannot see the local signer's `initialize` handshake, #1155's design, unchanged) and adds no new refusal to the quote path. No key material, no authority, no route, no weakened verification: mutation-proven both ways (hardcoding `supported_versions` in the refusal instead of deriving it fails the new derivation tests; severing the structured refusal back to prose-only fails the new structured-refusal tests). Perimeter unchanged.
- **#1311** — agent-facing x402 tool descriptions reordered scan-first (critical path, then the structured-fields instruction, protocol notes demoted to a labeled tail — nothing deleted); the duplicated post-purchase-summary attach block deduplicated into one SDK method. Prose order and code hygiene only: every test-pinned guard string survives verbatim (mutation-proven), signer descriptions and both consent hashes untouched, no field, refusal, route or authority changed. Perimeter unchanged.
- **#1321** — the hosted paid-MCP quote now establishes the merchant's Streamable HTTP MCP lifecycle (`initialize` then `notifications/initialized`) before sending the unpaid `tools/call` that obtains the 402. The keyless hosted client may read the agent's existing public delegate address solely to supply `x402-wallet`; it receives no delegate key, creates no signature, and fails before quote/funding when the merchant does not establish a session. The later paid retry continues to establish its own fresh session and still relays only the locally signed, exact-context-bound authorization. Compatibility hardening and a fail-closed pre-funding refusal only: no payment authority, custody, merchant-settlement role, signed context, or on-chain control changed. Perimeter unchanged.
- **#1326** — Connect can now write the existing hosted-MCP-plus-local-signer topology into Hermes Agent's protected YAML configuration. The file contains the same API-key identity entry and an absolute-path local signer entry as other supported runtimes; it neither transmits the delegate key nor grants API-key-only authority. Malformed YAML is refused before writing and the signer, approval, on-chain rules, and payment paths are unchanged. Perimeter unchanged.
- **#1330** — Hermes hosted-MCP identity storage now follows Hermes's own split: the API key is stored in its owner-only `.env`, while `config.yaml` holds an environment-reference template; the local prepared signer wrapper and its local signer credentials stay unchanged. The generated setup prompt explicitly approves that non-interactive local config + `.env` handoff and warns against printing secrets, but it never embeds credential material or delegates the work to a Hermes-internal script. This reduces plaintext secret exposure in the configuration artifact but changes no credential's authority: the API key remains identity-only, the delegate key never leaves the local signer, and approved on-chain rules still constrain funds. Perimeter unchanged.
- **#1319** — two #1318-review follow-ups on the #1306 preflight's allowance block, both observability: (1) test coverage only — no route, module or wire shape moved — for the delegation-rail allowance-read HTTP-failure path (degrades to `sufficient: null` + `ALLOWANCE_CHECK_UNAVAILABLE`, intent still created) and the `haven.getAgent()`-failure hard-refusal path (before any intent, mutation-proven no `POST /x402` call). (2) the #1145 fallback's provenance is now on the wire: `GET /machine-payments/allowances`' delegation-rail `onchain` rows gained an additive, optional `remaining_is_from_chain` boolean (false only when the #1145 on-chain enforcer read failed and `remaining` is the fallback full configured budget — the fallback ITSELF is unchanged, still fund-safe, still never a fabricated zero); the #1306 preflight reads it and adds a new, distinct warning (`ALLOWANCE_READ_OPTIMISTIC`, SDK-only per #1318) when the read is optimistic, alongside a real `sufficient` true/false rather than a degraded null. Wording is deliberately careful not to claim the preflight is the enforcer: the warning names the on-chain budget caveat enforcer as the actual gate at redemption either way. No key material, no new refusal, no authority added or narrowed, no route added — a read that could already happen now says more about itself. Perimeter unchanged.
- **agent-prompt refresh (audit A/B/E)** — the generic skill (`packages/sdk/src/skill-content.ts`, mirrored byte-for-byte in the frontend download) was rewritten to the shipped #1306/#1307/#1308/#1309/#1310/#1311 contracts (guided catalog purchase as the primary MCP path, follow-the-response-fields-first, payment_id-only sign/settle, the verify-then-sweep `MERCHANT_UNRESPONSIVE_AFTER_FUNDING` distinction, post-purchase reporting from `agent_summary`/`allowance`); `buildHostedMcpServer` and `buildMcpServer` now set MCP `instructions` (a compact, version-literal-free critical path, mutation-proven present); `signerInstructions()` gained one line naming the #1309 refusal's machine-readable fields. All prose/orientation surfaces: no tool schema, refusal, route, signature, or authority changed, and neither consent hash (`packages/mcp/src/consent.ts` hashes identity + tool NAMES + allowance summary; `packages/signer/src/consent.ts` hashes identity + tool NAMES + `SIGNER_CONSENT_SURFACE_VERSION`) reads instructions or tool description text, so none of this re-triggers consent. Perimeter unchanged.
