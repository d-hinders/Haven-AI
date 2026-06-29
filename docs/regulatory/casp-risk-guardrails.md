---
owner: "@d-hinders"
status: current
covers:
  - packages/backend/src/config.ts
  - packages/backend/src/routes/x402.ts
  - packages/backend/src/routes/x402-resources.ts
  - packages/backend/src/routes/payments.ts
  - packages/backend/src/routes/machine-payments.ts
  - packages/backend/src/routes/catalog.ts
  - packages/backend/src/routes/reporting.ts
  - packages/backend/src/routes/accounting.ts
  - packages/backend/src/lib/allowance-module.ts
  - packages/backend/src/lib/accounting-entry.ts
  - packages/backend/src/lib/catalog-discovery.ts
  - packages/backend/src/lib/merchant-catalog.ts
  - packages/backend/src/lib/machine-payments.ts
  - packages/backend/src/lib/payment-coverage.ts
  - packages/backend/src/lib/relayer.ts
  - packages/backend/src/lib/reporting/**
  - packages/backend/src/lib/safe-deployer.ts
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
last-verified: "2026-06-29"
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

## Hard Architecture Invariants

Preserve these facts as non-negotiable implementation invariants:

- User treasury funds are held in the user's Safe. An agent-held delegate EOA may also have a pre-existing, newly funded, or residual balance used for a standard x402 merchant payment; Haven controls neither account.
- Haven never holds user private keys, agent private keys, or seed phrases.
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

### Make All Agent Authority User-Approved

Agent authority should only be created through:

- Safe transaction signed by the user or Safe owner.
- Clear UI explaining spender, token, amount, reset period, expiry, and revocation.
- On-chain registration of the relevant spender or agent authority.
- Audit log of user consent.

Implementation rule:

> Haven must not silently create or expand an agent's authority.

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
- Neither key may be reused as an agent, user, or unrestricted payment signer.

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

Before merging any payment-related, agent-authority, Safe, SDK, x402/MPP, or relayer change, verify:

- [ ] Haven does not store user private keys.
- [ ] Haven does not store agent private keys.
- [ ] Haven does not store seed phrases.
- [ ] Haven does not operate a server-side signer that can spend user funds.
- [ ] API keys cannot authorise payments by themselves.
- [ ] Every automated payment requires an agent-held or user-held key signature.
- [ ] Every Safe-originated automated funding transfer is constrained by Safe Allowance Module or equivalent on-chain control; any standard x402 merchant leg carries the agent-held delegate signature and matches exact authenticated payment context.
- [ ] Haven database policy is not the only spend control.
- [ ] User-approved Safe transactions establish or modify agent authority.
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
