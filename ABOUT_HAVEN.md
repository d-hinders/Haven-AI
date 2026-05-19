# About Haven

## Product Summary

Haven is an agentic stablecoin payment wallet. Users create or link a Haven account, add funds to a Haven wallet, and give AI agents constrained spending ability through agent rules and budgets.

Haven is non-custodial smart account software. It helps users configure, verify, relay, and understand payment activity, but it does not hold funds, hold user or agent private keys, make API credentials sufficient to spend, or make discretionary transfer decisions.

## Core Model

- User funds live in a user-controlled Safe, shown in product copy as a Haven wallet.
- Each agent has a Haven identity, an API credential for authentication, and a credential address / delegate address for payment authority.
- The user grants per-token budgets to the agent credential address through the Safe AllowanceModule.
- The agent runtime holds and signs with its delegate private key. Haven's backend never holds that key.
- The API key identifies the agent. It is not spending authority.
- Spending authority comes from a valid agent/delegate signature and the on-chain Safe allowance state.
- Payments within remaining on-chain budget can execute automatically through the allowance path.
- Payments above remaining budget are queued for user approval.
- Users can pause, revoke, reject, or stop agent authority.

## What Exists Today

- Haven account and Haven wallet flows.
- Agent creation with per-token budget and reset period.
- Agent credential generation and handoff artifacts.
- Direct agent payments through the Haven SDK.
- x402 and Haven machine-payment challenge handling in the SDK.
- Dashboard, account, agent, approval, and transaction surfaces.
- Agent pause and revoke flows.
- Quality, review, and agent workflow documentation for implementation work.

## Agent Credentials

The generated agent credential file is a handoff artifact for the agent runtime. It should include enough context for the agent to authenticate, identify the correct wallet, and sign payments without implying that Haven is the custodian or controller of funds.

Current credential context should include:

- Haven API URL.
- Agent ID.
- API key.
- Haven wallet / Safe address.
- Credential address / delegate address.
- Chain ID and token context when needed by the runtime.
- Delegate private key only when Haven generated it client-side for the user and shows it once.

If the user brings their own credential address, Haven must not invent, recover, or store the private key. The generated instructions should tell the user or agent runtime to provide the matching delegate key through their own secret handling.

## Payment Flow

1. Agent requests a payment with token, amount, recipient, and optional memo/context.
2. Haven authenticates the API key and loads the agent, wallet, and allowance context.
3. The agent/delegate signature provides payment authority.
4. The Safe AllowanceModule enforces the automatic spend budget on-chain.
5. If the request is within remaining on-chain budget, Haven relays the valid allowance transfer.
6. If the request exceeds the remaining budget or needs human review, Haven queues it for approval.
7. Haven records status and presents the result in approvals and transaction history.

Haven can help construct and relay the transaction, but it must not alter the signed payment amount, token, recipient, route, or authority boundary.

## x402 And Machine Payments

The SDK supports `haven.fetch()` for standard x402 and Haven machine-payment challenge flows.

For standard x402 merchant payments, the delegate wallet is the merchant-facing payer because the merchant protocol verifies an EIP-3009 authorization from an externally owned account. The current flow is:

1. Agent encounters an HTTP 402 challenge.
2. Haven checks agent identity, wallet context, and remaining allowance.
3. Haven can fund the delegate wallet from the Safe within budget.
4. The agent signs the merchant-facing EIP-3009 payment from the delegate wallet.
5. The SDK retries the request with the payment proof.
6. Haven tracks funded, settled, failed, and stranded-payment states where relevant.

This means the delegate key is a hot payment key and should be treated carefully. Keep x402 budgets small and reset-bound, rotate exposed keys, and reconcile/sweep stranded delegate balances before scaling high-volume payment traffic.

Production merchant facilitation, Stripe MPP, fiat/card rails, and merchant settlement are not current production surfaces. Treat them as future or review-required work under `docs/regulatory/casp-risk-guardrails.md`.

## Guardrails

Haven must stay within these product and architecture constraints:

- Haven does not custody user assets.
- Haven does not hold user or agent private keys on the backend.
- API credentials alone cannot spend.
- Off-chain database policy is not the real spend control.
- Automated payment execution must be constrained by Safe AllowanceModule or equivalent on-chain control.
- User-approved Safe transactions establish or modify agent authority.
- Users can access and revoke Safe permissions outside Haven.
- Haven must not operate swaps, ramps, fiat/card rails, merchant settlement, yield, treasury management, or financial advice flows without separate product, legal, and security review.

Use `docs/regulatory/casp-risk-guardrails.md` before changing payment execution, agent authority, Safe setup, relaying, SDK payment APIs, x402/MPP flows, merchant-facing demos, fiat/card surfaces, swaps, yield, or treasury features.

## Product Language

Prefer these terms in primary UX and user-facing docs:

- Haven account.
- Haven wallet.
- Agent rules.
- Agent budget.
- Haven credential.
- Approve actions.
- Connect your agent.

Avoid exposing Safe, module, relayer, signer, owner, transaction hash, and raw address detail in primary UX unless the surface is explicitly advanced, account detail, transaction detail, or developer-facing.

## Current Tech Snapshot

- Frontend: Next.js and React.
- Backend: Fastify, TypeScript, and PostgreSQL.
- SDK: `@haven_ai/sdk`.
- Smart account model: Safe plus AllowanceModule.
- Current chain focus: Gnosis for Safe/AllowanceModule flows and Base-relevant x402 flows.
- Payment surfaces: direct payments, x402, and Haven machine-payment challenge demos.

## Mental Model

```
User controls the Haven wallet and budgets.
Agent requests payments and signs with its credential.
Haven authenticates, verifies, relays, records, and presents status.
On-chain Safe rules decide what can move automatically.
User approval decides what can move outside the automatic budget.
```

## Future Work

The following are possible future directions, not current production promises:

- Broader protocol adapters.
- Merchant acceptance or facilitator flows.
- Stripe MPP, fiat rails, card rails, or merchant settlement.
- Session keys, guards, or alternative on-chain permission systems.
- Multi-chain expansion.
- Micropayment batching, tabs, or payment channels.

Any future work in these areas must preserve the non-custodial model and pass the guardrails in `docs/regulatory/casp-risk-guardrails.md` before being treated as product behavior.
