---
owner: "@d-hinders"
status: archived
covers: []  # narrative — no direct code mirror
last-verified: "2026-07-01"
---

# Archive

Frozen, point-in-time documents kept for context only. **Nothing here describes
current state** — each file carries an `ARCHIVED` banner explaining what
superseded it. Do not action tasks or follow setup steps from these docs.

| Document | What it was | Superseded by |
|---|---|---|
| [passkey-onboarding.md](passkey-onboarding.md) | Design doc for passkey-native Safe onboarding. | Shipped in `packages/backend` + `packages/frontend`; see [architecture](../architecture/00-overview.md). |
| [redesign-handoff.md](redesign-handoff.md) | Implementation handoff for the v2 light redesign migration. | [product/design-system.md](../product/design-system.md) and the rest of `docs/product/`. |
| [agentic-workflow-audit.md](agentic-workflow-audit.md) | 2026-06-02 audit of the agentic delivery workflow. | [contributing/ai-agent-workflow.md](../contributing/ai-agent-workflow.md). |
| [agent-ux-feedback-connect-and-x402.md](agent-ux-feedback-connect-and-x402.md) | 2026-06-17 agent UX report for Connect and x402 paid-MCP flows. | Current [x402 sequence](../architecture/04-x402-payment-sequence.md), [hosted connect topology](../architecture/06-hosted-mcp-connect-flow.md), and [edge signer](../architecture/07-edge-signer.md). |
| [sweep-delegate-split-signer-gap.md](sweep-delegate-split-signer-gap.md) | 2026-06-16 incident and implementation design for the original hosted sweep gap. | Current SDK, signer, hosted MCP, and backend gasless sweep implementation. |
| [connect-agent-2-local-key-pairing.md](connect-agent-2-local-key-pairing.md) | Detailed staged-pairing contract for shipping Connect Agent 2 (#230–#237). | Current connect mechanism: [architecture 6](../architecture/06-hosted-mcp-connect-flow.md) & [7](../architecture/07-edge-signer.md). |
| [connect-agent-2-rollout-closeout.md](connect-agent-2-rollout-closeout.md) | Merge-readiness / rollout report for #237. | n/a — shipped and superseded by current code. |
