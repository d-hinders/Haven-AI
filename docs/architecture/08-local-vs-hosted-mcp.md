---
owner: "@d-hinders"
status: current
covers:
  - packages/mcp/**
  - packages/mcp-server/src/**
  - packages/connect/src/**
  - packages/signer/src/**
  - packages/sdk/src/client.ts
  - packages/sdk/src/x402.ts
  - packages/backend/src/routes/payments.ts
  - packages/backend/src/routes/x402.ts
  - packages/backend/src/middleware/agentToolAudit.ts
last-verified: "2026-07-01"
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
npx -y @haven_ai/connect --setup hv_setup_... --api https://api.haven.example --ack-local-tools --runtime claude-code --local
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

## Related docs

- [Hosted connect flow](06-hosted-mcp-connect-flow.md)
- [Edge signer](07-edge-signer.md)
- [CASP / MiCA guardrails](../regulatory/casp-risk-guardrails.md)
