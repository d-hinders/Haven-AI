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
- Prompt-first **Connect your agent** handoff with hosted MCP snippets for common runtimes.
- Hosted/keyless MCP server and local edge signer split.
- Local MCP server for runtime-local credential-file integrations.
- Direct agent payments through the Haven SDK.
- x402 and Haven machine-payment challenge quote/pay/resume handling in the SDK and local MCP.
- `get_allowances` tooling for live "what can this agent spend?" questions.
- Dashboard, account, agent, approval, transaction, activity, and tool-invocation surfaces.
- Agent pause, resume, revoke, and API-key rotation flows.
- Internal demo merchant MCP package for Base USDC x402 test purchases and Swedish invoice output.
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
- Current budget summary as a snapshot, not the authority source.
- Revoke URL and creation timestamp where useful.
- Delegate private key only when Haven generated it client-side for the user and shows it once.

If the user brings their own credential address, Haven must not invent, recover, or store the private key. The generated instructions should tell the user or agent runtime to provide the matching delegate key through their own secret handling.

Haven stores only API-key hashes and display prefixes. Rotating an API key creates a new one-time-visible key and invalidates the old API key immediately. API-key rotation is useful when the API key was exposed or lost; it does not rotate the delegate signing key. If the delegate private key was exposed or lost, the user should pause or revoke the agent and create a new key path.

## Connect-Agent And MCP

The primary connect-agent flow is now hosted MCP plus local signing:

- Hosted MCP receives the agent API key as Bearer identity.
- Hosted MCP reads state, constructs unsigned payment payloads, and relays signatures.
- The local runtime or `@haven_ai/signer` holds the delegate private key and signs.
- Hosted snippets and deep links must never include the delegate private key.
- MCP tool calls are tagged and audited so users can see activity and last-seen status.

The local `@haven_ai/mcp` package remains available for stdio deployments where the MCP server runs beside the agent and reads a local credential file. It signs locally and should not be run as a hosted multi-tenant signer.

Audit logs and last-seen timestamps are informational UX and debugging surfaces. They are not the spend gate. On-chain Safe AllowanceModule state remains the spend gate.

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

The SDK supports `haven.fetch()`, quote-first helpers, and resume helpers for standard x402 and Haven machine-payment challenge flows.

For standard x402 merchant payments, the delegate wallet is the merchant-facing payer because the merchant protocol verifies an EIP-3009 authorization from an externally owned account. The current flow is:

1. Agent encounters an HTTP 402 challenge.
2. Haven checks agent identity, wallet context, and remaining allowance.
3. Haven can construct and relay a budget-constrained Safe-to-delegate funding step.
4. The agent signs the merchant-facing EIP-3009 payment from the delegate wallet.
5. The SDK retries the request with the standard `X-PAYMENT` header.
6. Haven tracks funded, executed, failed, and stranded-payment states where relevant.

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
- MCP: local `@haven_ai/mcp`, hosted/keyless `@haven_ai/mcp-server`, and local `@haven_ai/signer`.
- Smart account model: Safe plus AllowanceModule.
- Current chain focus: Gnosis and Base for Safe/AllowanceModule flows; Base USDC for standard x402 demo merchant flows.
- Payment surfaces: direct payments, x402, Haven machine-payment challenge demos, and internal demo merchant MCP.

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
