# Haven — Local MCP vs. Hosted MCP + Edge Signer

Deployment model decision guide for agent developers.

> **Default: hosted MCP + edge signer — for every runtime.** The connector
> (`npx @haven_ai/connect`) writes the hosted topology for all supported agent
> environments. Local MCP is an **advanced, explicit opt-in** (`--local`),
> available only for Claude Code and Codex. See
> "Advanced: fully-local MCP" below for when that trade-off makes sense.

## The two models

| | **Local MCP** (`@haven_ai/mcp`) | **Hosted MCP + Edge Signer** (`@haven_ai/mcp-server` + `@haven_ai/signer`) |
|---|---|---|
| **Server** | Runs on the user's machine alongside the agent runtime | Haven's hosted endpoint (e.g. `https://mcp.haven.ai/v1`) |
| **Signing key** | On the local machine, loaded by the MCP process at startup | On the local machine, held exclusively by `@haven_ai/signer` |
| **Agent config** | Points to a local `npx @haven_ai/connect`-managed server | Points to the hosted URL + Bearer token; separate signer config |
| **Setup complexity** | One tool call: `npx @haven_ai/connect` | Two MCP servers: one hosted URL, one local signer binary |
| **Key exposure surface** | Loaded into the MCP process that also runs the business logic | Loaded only into the dedicated signer process; never the hosted server |
| **Runtime requirement** | Node.js on the user's machine | Internet access to Haven's endpoint; Node.js for the local signer only |
| **Multi-runtime** | One local server per agent runtime | One hosted URL shared across all runtimes; each runtime runs its own signer |

## The default: hosted MCP + edge signer

`npx @haven_ai/connect` writes the hosted topology for every runtime — a hosted
MCP entry (URL + Bearer API key) plus a local `haven-signer` stdio entry. This
is the path all users land on unless they explicitly opt out:

- **Uniform key isolation** — the delegate key lives only in the dedicated
  sign-only signer process on every runtime; funding relay sends only
  `{ payment_id, signature }` to the hosted server.
- **Server-side updatability** — construct/relay fixes ship once, centrally;
  no local MCP package for users to keep current.
- **Central audit** — every payment is logged by Haven's hosted infrastructure
  (Layer 5 of the security model).
- **One well-tested path** — a single topology across all runtimes instead of
  a silent per-runtime fork.

See [Connect Agent 2 local-key pairing](../archive/connect-agent-2-local-key-pairing.md)
for the pairing flow.

## Advanced: fully-local MCP (no hosted dependency)

Local MCP (`@haven_ai/mcp`) is the only topology where Haven's hosted
infrastructure is **not** in the construct/relay path. It remains available as
an explicit opt-in for users who need:

- **Offline / air-gapped-adjacent operation** — no dependency on hosted-MCP
  uptime or latency.
- **Self-hosting / privacy** — payment construction and relay happen entirely
  on your machine.

Opt in with the connector flag (Claude Code and Codex only):

```bash
npx -y @haven_ai/connect --setup hv_setup_... --api https://api.haven.example --ack-local-tools --runtime claude-code --local
```

Trade-offs you accept with `--local`:

- **No central audit** — Haven keeps no hosted log of payment construction.
- **You update it yourself** — fixes ship as new package versions you must
  pick up; nothing updates server-side.
- **Wider key surface** — the delegate key is loaded into the same process
  that runs construct/relay business logic, instead of a dedicated signer.
- **No usage-based relay** — hosted-relay features do not apply.

On unsupported runtimes the flag fails with a clear error and the connector
suggests re-running without `--local`.

## Why the split exists (CASP/MiCA compliance)

Haven's hosted server is **non-custodial by design**. A hosted server that held the delegate private key would be a **custodial agent wallet** — which triggers CASP (Crypto Asset Service Provider) licensing requirements under MiCA in the EU.

The hosted MCP + edge signer split satisfies CASP/MiCA Red Line #2:

> The hosted server never holds, processes, or transmits the delegate private key. It constructs unsigned payment hashes and relays signed payloads. Signing authority stays at the edge with the user's local signer.

See [`docs/regulatory/casp-risk-guardrails.md`](../regulatory/casp-risk-guardrails.md) for the full guardrails.

## Tool surface parity

Both deployment models expose the same tool names wherever the semantics map cleanly:

| Tool | Local MCP | Hosted MCP |
|---|---|---|
| `haven_get_agent` | ✓ | ✓ |
| `haven_get_allowances` | ✓ | ✓ |
| `haven_get_payment_status` | ✓ | ✓ |
| `haven_get_resume_state` | ✓ | ✓ |
| `haven_list_receipts` | ✓ | ✓ |
| `haven_quote_x402` | ✓ | ✓ |
| `haven_pay_x402_quote` | Signs locally in one call | Returns `payload_hash` for edge signer |
| `haven_pay_x402` (one-shot) | ✓ (full round-trip) | — (agent orchestrates; see flow below) |
| `haven_resume_x402_payment` | ✓ | Returns signing context for edge signer |
| `haven_quote_mpp` | ✓ | ✓ |
| `haven_pay_mpp_challenge` | Signs locally | Returns `payload_hash` for edge signer |
| `haven_resume_mpp_payment` | ✓ | Returns signing context for edge signer |
| `haven_pay` (SafeTransfer) | ✓ | ✓ returns `payload_hash` |
| `haven_submit` | — | ✓ relays signature to Haven |

**Edge signer tools** (local only, paired with hosted MCP):

| Tool | Purpose |
|---|---|
| `haven_sign` | Signs a payment hash or x402 funding hash locally; returns `{ signature, x402_binding }` |
| `haven_x402_sign_header` | Builds the EIP-3009 X-PAYMENT header for the merchant leg of an x402 payment |

## x402 payment flow comparison

### Local MCP (one-shot)

```
Agent: haven_pay_x402 { url }
  ↳ MCP: probes merchant, creates funding intent, signs EIP-3009 header, retries merchant
Agent: receives merchant response
```

### Hosted MCP + Edge Signer

```
Agent → Hosted MCP:  haven_quote_x402 { url }
                     → returns { payment_required, ... }

Agent → Hosted MCP:  haven_pay_x402_quote { payment_required }
                     → returns { payment_id, payload_hash, x402.expected }

Agent → Signer:      haven_sign { payload_hash, x402_expected }
                     → returns { signature, x402_binding }
                     (key never leaves signer process)

Agent → Hosted MCP:  haven_submit { payment_id, signature }
                     → funds the delegate wallet via Safe AllowanceModule
                     → returns { status: "confirmed", tx_hash }

Agent → Signer:      haven_x402_sign_header { payment_required, x402_binding }
                     → returns { payment_header }
                     (EIP-3009 authorization signed locally)

Agent → Merchant:    GET /data   X-PAYMENT: <payment_header>
                     → receives the paid resource
```

For paid MCP tools, the final merchant call can be `haven_complete_mcp_tool`
instead: the agent passes the funding `payment_id`, merchant tool arguments, and
signed `payment_header` back to hosted MCP. Hosted MCP does not sign; it relays
the header to the merchant and records success evidence or a reconciliation
event if the merchant rejects after funding.

## Custody invariant

The hosted server must **never** receive the delegate private key:

- Funding relay sends only `{ payment_id, signature }` via `haven_submit`.
- Paid MCP-tool completion can send a signed, single-use `payment_header` back
  to hosted MCP with the funding `payment_id`; the header is already bound to
  the merchant, amount, and nonce, and is not a key.
- The hosted MCP boot guard (`createHostedHavenClient`) throws if a delegate key is detected on the client.
- Deep links and setup tokens from Haven may carry the hosted URL and Bearer token, but **never** the delegate key.

See [`06-hosted-mcp-connect-flow.md`](06-hosted-mcp-connect-flow.md) for the full sequence and
[`07-edge-signer.md`](07-edge-signer.md) for the signer design rationale.
