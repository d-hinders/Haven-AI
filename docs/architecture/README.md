# Haven — Architecture Diagrams

Internal engineering reference for how identity, custody, and authority flow
through Haven today. Each diagram is Mermaid in markdown (canonical) with
exported PNG and SVG alongside.

| # | Diagram | Use when |
|---|---|---|
| 1 | [System Context](01-system-context.md) | Onboarding, security reviews, "who talks to who" questions. Shows trust boundaries. |
| 2 | [Identity & Custody Map](02-identity-and-custody.md) | Reasoning about blast radius — what is held by user, Haven, agent, and on-chain. |
| 3 | [Payment Execution Sequence](03-payment-sequence.md) | Tracing a payment from API call to on-chain settlement; auto-execute vs over-allowance branches. |
| 4 | [x402 Payment Sequence](04-x402-payment-sequence.md) | Agent encounters HTTP 402 from a resource server and pays through Haven; one-shot vs two-step modes. |
| 5 | [Agent API OpenAPI Contract](05-agent-api-openapi.md) | Public OpenAPI surface for non-TypeScript agent integrators and external reviewers. |
| 6 | [Hosted MCP Connect Flow & Edge-Signing Contract](06-hosted-mcp-connect-flow.md) | Designing/reviewing the hosted MCP server — the wire contract, the two-credential split, and the non-custodial rule that the delegate key never reaches Haven. |
| 7 | [Edge Signer](07-edge-signer.md) | The local component that holds the delegate key and signs — its form (signer core + local stdio MCP), the pay/x402 orchestration, and custody invariants. |

## Regenerating exports

Mermaid is the source of truth. Regenerate PNG/SVG after editing:

```sh
for f in docs/architecture/0*-*.md; do
  base="${f%.md}"
  npx -y @mermaid-js/mermaid-cli@latest -i "$f" -o "$base.png" -b transparent
  npx -y @mermaid-js/mermaid-cli@latest -i "$f" -o "$base.svg" -b transparent
done
# mmdc adds a -1 suffix when input is .md; drop it
( cd docs/architecture && for f in *-1.png *-1.svg; do mv "$f" "${f%-1.*}.${f##*.}"; done )
```

## Scope notes

- POC state on **Gnosis Chain (id 100)**. Multi-chain is future work.
- **API-key agents only.** A self-sign (EIP-191) agent path also exists in
  the code but is intentionally excluded from these diagrams.
- Diagrams reflect what the code does, not the aspirational model in
  [CLAUDE.md](../../CLAUDE.md). Where they diverge (e.g. Safe ownership is not
  on-chain-verified at import; the delegate EOA is user-supplied, not
  Haven-generated), the diagrams reflect the code.
