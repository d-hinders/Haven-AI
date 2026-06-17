# Haven — Architecture Diagrams

Internal engineering reference for how identity, custody, and authority flow
through Haven today. Mermaid in markdown is canonical; some diagrams also have
exported PNG and SVG alongside.

| # | Diagram | Use when |
|---|---|---|
| 0 | [Architecture Overview](00-overview.md) | First stop — the whole stack at a glance: components, default topology, connect flow, external pieces. |
| 1 | [System Context](01-system-context.md) | Onboarding, security reviews, "who talks to who" questions. Shows trust boundaries. |
| 2 | [Identity & Custody Map](02-identity-and-custody.md) | Reasoning about blast radius — what is held by user, Haven, agent, and on-chain. |
| 3 | [Payment Execution Sequence](03-payment-sequence.md) | Tracing a payment from API call to on-chain settlement; auto-execute vs over-allowance branches. |
| 4 | [x402 Payment Sequence](04-x402-payment-sequence.md) | Agent encounters HTTP 402 from a resource server and pays through Haven; one-shot vs two-step modes. |
| 5 | [Agent API OpenAPI Contract](05-agent-api-openapi.md) | Public OpenAPI surface for non-TypeScript agent integrators and external reviewers. |
| 6 | [Hosted MCP Connect Flow & Edge-Signing Contract](06-hosted-mcp-connect-flow.md) | Designing/reviewing the hosted MCP server — the wire contract, the two-credential split, and the non-custodial rule that the delegate key never reaches Haven. |
| 7 | [Edge Signer](07-edge-signer.md) | The local component that holds the delegate key and signs — its form (signer core + local stdio MCP), the pay/x402 orchestration, and custody invariants. |
| 8 | [Local vs Hosted MCP](08-local-vs-hosted-mcp.md) | Choosing the deployment model — the default hosted MCP + edge signer vs the advanced fully-local MCP opt-in, with the custody rationale and tool parity. |
| 9 | [Rail-agnostic Fee Module](09-fee-module.md) | Designing/reviewing the per-transaction fee — the shared policy/accounting module vs. per-rail on-chain settlement, and the surcharge/allowance invariants. |

The detailed Connect Agent 2 contract and its rollout closeout were point-in-time
artifacts for shipping that feature; they now live in
[`docs/archive/`](../archive/connect-agent-2-local-key-pairing.md) for reference.
The current connect mechanism is covered by docs 6 (hosted MCP connect flow) and
7 (edge signer).

## Regenerating exports

Mermaid is the source of truth. Regenerate PNG/SVG after editing when the
Mermaid CLI is available:

```sh
# Needs a headless Chromium; run where one is available.
for f in docs/architecture/[0-9]*-*.md; do
  base="${f%.md}"
  npx -y @mermaid-js/mermaid-cli@latest -i "$f" -o "$base.png" -b transparent
  npx -y @mermaid-js/mermaid-cli@latest -i "$f" -o "$base.svg" -b transparent
done
# mmdc appends -1, -2, ... per diagram. Single-diagram files drop the suffix;
# multi-diagram files (e.g. 04) keep -1/-2.
( cd docs/architecture
  for base in $(ls *-1.png 2>/dev/null | sed 's/-1\.png$//'); do
    [ -e "${base}-2.png" ] && continue
    mv "${base}-1.png" "${base}.png"; mv "${base}-1.svg" "${base}.svg"
  done )
```

## Scope notes

- Current code supports **Gnosis Chain (id 100)** and **Base (id 8453)** for
  Haven wallet/Safe flows where configured. Standard merchant x402 demos focus
  on Base USDC.
- **API-key agents only.** (An earlier self-sign / EIP-191 agent path was
  removed — it is no longer part of the codebase.)
- Diagrams reflect what the code does, not the aspirational model in
  [CLAUDE.md](../../CLAUDE.md). Where they diverge (e.g. Safe ownership is not
  on-chain-verified at import; the delegate EOA is user-supplied, not
  Haven-generated), the diagrams reflect the code.
