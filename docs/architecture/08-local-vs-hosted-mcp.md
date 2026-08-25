---
owner: "@d-hinders"
status: current
covers:
  - packages/mcp/**
  - packages/mcp-server/src/**
  - packages/connect/src/**
  - packages/signer/src/**
  - packages/sdk/src/client.ts
  - packages/sdk/src/account-reads.ts
  - packages/sdk/src/delegate-sweep.ts
  - packages/sdk/src/haven-api-transport.ts
  - packages/sdk/src/mcp-merchant-transport.ts
  - packages/sdk/src/x402.ts
  - packages/backend/src/routes/payments.ts
  - packages/backend/src/routes/x402.ts
  - packages/backend/src/middleware/agentToolAudit.ts
last-verified: "2026-08-24" # #1986: the rail split re-read — the hosted keyless x402 construct now has NO working rail, because the allowance rail it served fails closed. Added; the local-vs-hosted signing/relay distinction itself is unchanged and re-verified. Prior: #1672: the local-MCP example command drops --runtime claude-code — runtime selection is detection-first now (see mcp-runtime-compatibility.md); everything else re-read and unchanged. Prior: re-verified for #1352 (Node floor 24->22: engines/constant only; grep-checked: no numeric floor claim in this doc; floor prose lives in mcp-runtime-compatibility.md)
---

# Haven — Local MCP vs Hosted MCP + Edge Signer

The default is hosted MCP plus the local edge signer. The connector writes this
topology for supported runtimes. Local MCP is an advanced `--local` option for
Claude Code and Codex.

| | Local MCP (`@haven_ai/mcp`) | Hosted MCP + edge signer |
|---|---|---|
| MCP process | Runs locally | Runs at Haven's configured hosted URL |
| Signing | Delegate key is loaded by the local MCP process | Delegate key is isolated in local `@haven_ai/signer` |
| Haven API | Still used to construct, submit, and poll payments | Used through hosted MCP orchestration |
| Updates | User picks up package releases | Hosted orchestration updates centrally |
| Audit | Payment/API tool activity reaches the Haven backend | Backend plus hosted-transport activity is visible |

Local MCP removes the hosted MCP transport. It is not offline or air-gapped:
the SDK still depends on the configured Haven API and its relay/chain services,
plus merchant services. Its privacy and availability trade-off is therefore
narrower than running the whole Haven stack locally.

Opt in on a supported runtime:

```bash
npx -y @haven_ai/connect --setup hv_setup_... --api https://api.haven.example --ack-local-tools --local
```

## Custody boundary

The hosted service must never hold, process, or transmit the delegate private
key. Doing so would violate Haven's non-custodial architecture and materially
increase custody and CASP risk; any such change requires product and legal
review. The regulatory guardrails are risk guidance, not a legal opinion.

Local MCP keeps signing local but loads the key into the same process that
performs orchestration. Hosted mode narrows that key surface to a dedicated,
no-network signer.

## Tool model

Both modes expose the common reads, direct-payment operations, x402 and MPP
quote/resume/status operations, receipt operations, and discovery where their
semantics match. They are not byte-for-byte identical:

- Local MCP can perform some one-call flows because it owns the local key.
- Hosted MCP exposes prepare/submit and paid-MCP orchestration helpers so the
  edge signer can authorize without sharing the key.
- Hosted MCP provides gasless sweep orchestration; the signer supplies
  `haven_sign_sweep_delegate`.

Treat the registered tool unions in `packages/mcp/src/tools.ts`,
`packages/mcp-server/src/tools.ts`, and `packages/signer/src/tools.ts` as the
source of truth.

The four edge-signer tools are `haven_sign`, `haven_x402_sign_header`,
`haven_sign_x402`, and `haven_sign_sweep_delegate`.

## x402 comparison

Local MCP can orchestrate a one-shot `haven_pay_x402` flow from its local
process; Haven's backend still constructs and relays the payment.

For a paid MCP tool in hosted mode, prefer:

```text
haven_pay_mcp_tool → haven_sign_x402 → haven_settle_mcp_tool
```

The decomposed generic hosted flow remains:

```text
haven_pay_x402_quote → haven_sign → haven_submit
  → haven_x402_sign_header → merchant retry
```

In both cases, Haven's backend constructs and records the payment intent.
Hosted MCP never signs; it relays already signed, context-bound payloads.

The modes also differ by rail. The local flow dispatches on the
server-provided `sign_data.signature_scheme`, including the delegation rail's
EIP-712 typed data. The hosted keyless construct rejects typed-data funding
intents with a hard `HavenSigningError` before any signing context reaches the
edge signer, so x402 for delegation-rail accounts currently requires the local
flow (`HavenClient` with `delegateKey`).

⚠️ **Since #1986 that leaves hosted x402 with no working rail at all.** The
hosted construct only ever served the legacy AllowanceModule rail, and that
rail no longer executes payments — `POST /x402/authorize` answers HTTP 410 for
an `allowance_module` account, above the funding leg, so no funding intent
reaches the edge signer from either rail. Hosted x402 is therefore a local-flow
capability today, full stop; restoring it means building it on the delegation
rail. Direct payments are unaffected in kind: `POST /payments` serves both
rails and its delegation branch is untouched.

## Related docs

- [Hosted connect flow](06-hosted-mcp-connect-flow.md)
- [Edge signer](07-edge-signer.md)
- [CASP / MiCA guardrails](../regulatory/casp-risk-guardrails.md)
