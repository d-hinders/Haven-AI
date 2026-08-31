---
owner: "@d-hinders"
status: current
covers:
  - packages/mcp-server/src/**
  - packages/connect/**
  - packages/signer/**
  - packages/frontend/src/components/ConnectAgentModal.tsx
  - packages/backend/src/routes/agent-connection-setups.ts
  - packages/backend/src/routes/payments.ts
  - packages/backend/src/routes/x402.ts
  - packages/backend/src/rails/sweep.ts
  - packages/sdk/src/client.ts
  - packages/sdk/src/account-reads.ts
  - packages/sdk/src/delegate-sweep.ts
  - packages/sdk/src/haven-api-transport.ts
  - packages/sdk/src/mcp-merchant-transport.ts
  - packages/sdk/src/payment-mappers.ts
  - packages/sdk/src/payment-state.ts
  - packages/sdk/src/x402.ts
last-verified: "2026-08-27" # #2130: the balance-aware x402 coverage bullets presented the three-way split — including the "queues for approval" middle branch — as LIVE, with no rail qualifier. The ⚠️ banner two lines below scopes a DIFFERENT claim (hosted keyless x402 on the legacy rail) and never disclaimed the arithmetic, so a reader could take it as current delegation-rail behaviour. Now framed as the legacy rail's history, with the live refusal stated per scheme (502 with no intent row on EIP-3009, 403 delegation_budget_exceeded on erc7710 per #2082, 410 on the legacy rail per #1986). Worth recording: #2041's note says it "re-read the balance-aware coverage bullets... unchanged" — a prior re-verification pass read this exact text and did not flag it. Also, on review: the relabelling first introduced a THIRD banner style in this file for "this used to be true", two lines above an existing bare-⚠️ paragraph — making one louder made its neighbour read as a redundant afterthought when it is actually the lead-in to the #2041 scope correction. The two ⚠️ blocks are now MERGED into one (both were "the legacy rail is dead"), and the #2041 correction stands as unbannered prose, which is the different rhetorical job it was always doing. The Review checklist's "Queued or insufficient requests expose no signable hash" was also corrected — it treated "queued" as a live outcome three sections below text saying nothing is queued. Scope: those bullets, the merged banner, the sentence under them, that checklist line, and the correction paragraph's opening clause — the merge removed the sentence it used to point at, so it had to be re-pointed, and review caught the first attempt claiming the banner does NOT say "hosted x402" when the merged banner's headline contains that phrase verbatim. The distinction it draws is SCOPE (rail-scoped vs. all-accounts), not vocabulary; the trust-boundary table, the topology/credential-split sections and the erc7710 flow blocks were NOT re-verified in this pass. Prior: #2102: three live-rail corrections. The Trust boundary table's enforcement row named the Safe AllowanceModule and had NO delegation-rail row at all; it now names the budget delegation's caveat enforcers. The Direct payment section said an over-budget request "queues for user approval and returns no signable hash" and that submit "executes the AllowanceModule transfer" — neither happens: it is declined before any money moves, and submit relays a sponsored UserOp redeeming the delegation. Why this doc drifted while its neighbours did not: its own last-verified chain scopes every prior pass (#1986, #2041) to the x402 subsection, so the Direct payment section above it was never in one. Also corrected, after review declined to confirm my judgement that it was fine: the connect-flow step's legacy half said the agent "cannot spend until the AllowanceModule permission exists on-chain", whose parallel with the delegation-rail sentence beside it implies spend then becomes possible. It does not — #1986 refuses every payment path unconditionally — and `tryVerifySetupAuthority` is live, so a user can still walk the step and land in a dead end. Scope: the table row, the Direct payment steps, and the connect-flow step's legacy-rail sentence. (This note said "two" while describing three until review caught it — the count and the Scope line were not updated when the third paragraph was inserted between them. Recorded rather than silently corrected: a verification note that miscounts its own scope is the same defect class as the doc-disagreeing-with-itself this change exists to fix.) Prior: #2041: the generic decomposed path gains its erc7710 shape, and the #1986 warning banner is SCOPE-CORRECTED rather than deleted. It said hosted keyless x402 works for NO account; the true claim is rail-scoped (the legacy allowance rail 410s), and the second premise it rested on -- that the hosted construct refuses typed-data funding intents -- had already been overtaken by #1254/#1456, as `08-local-vs-hosted-mcp.md` measured on 2026-08-25. #2041 falsifies the blanket claim a second, independent way, which is why it is fixed here rather than left contradicting `08`: a delegation-rail account now completes an erc7710 payment end to end through exactly this generic surface. Also re-read the balance-aware coverage bullets and the connect-flow sections: unchanged. Scope: the x402 subsection only. Prior: #1986: the "hosted keyless construct is allowance-rail only" note re-read against the payment 410 — it is now a statement that hosted x402 works for nobody, and says so. Direct-payment flow confirmed rail-agnostic and unaffected. Registration/connect steps re-read and unchanged. Prior: #1878: two claims corrected, both of the same shape — an exhaustive list of what registration sends. Step 4 said the connector sends "only" the setup token, runtime/version, public address and proof, and API-key hash/prefix, and the review checklist said registration contains "public proof and hashed API-key metadata only". Both are now false: the connector also sends the resolved MCP server name it wired the agent as. It is a non-secret display label and the custody half of each sentence is untouched — no private key, no plaintext API key — but "only" is a strong word and a reader auditing the wire boundary against this page would have found a field the page denies exists. Both now name it AND say what it is not (never authority, not unique, nothing keys off it), because a new field in a custody checklist reads as a custody change unless the doc says otherwise. Scope: those two lines; the rest of the flow, the hosted/local topology split and the remaining checklist items were re-read only for contradiction, and none contradicts. Prior: #1702: re-verified, NOT edited. Implicated only because `packages/connect/**` is in `covers:` and #1702 rewrites that package's README; the body makes no claim about credential-overwrite semantics, `--name`, or re-key, and its review-checklist line "API-key rotation changes identity credentials, not signing authority" is about the separate `POST /agents/:id/rotate-key` route and stays true. Recorded so the coupling-gate loop is closed in the audit trail rather than left as an unaddressed flag. Prior: #1813: dropped the `covers:` entry for `lib/hosted-connect.ts`, deleted as unreachable. No claim in the body named it — the flow described here is served by ConnectAgentModal, not the retired hosted card. Prior: re-verified for #1352 (Node floor 24->22: engines/constant only; grep-checked: no numeric floor claim in this doc; floor prose lives in mcp-runtime-compatibility.md)
---

# Haven — Hosted MCP Connect Flow And Edge-Signing Contract

Hosted MCP is keyless: it authenticates agent identity, reads state, constructs
unsigned payment payloads, and relays signatures. Signing stays with the agent
runtime or `@haven_ai/signer`.

## Trust boundary

| Component | Holds | Responsibility |
|---|---|---|
| Hosted MCP | API key / Bearer token | Identity, state reads, orchestration, unsigned payload construction, signature relay |
| Edge signer | Delegate private key | Local signing authority |
| Budget delegation | On-chain caveat enforcers | Automatic-spend enforcement |

API authentication is identity, a delegate signature is authority, and the
on-chain caveat stack is enforcement. Hosted MCP must never accept, store, or log a
delegate key. It has a boot-time guard that rejects an injected key.

For direct funding relay, the agent sends only the locally produced
`{ payment_id, signature }` to hosted MCP. Paid MCP completion may additionally
send a signed, merchant-bound `payment_header`; that single-use authorization
is not a key.

## Current connection flow

Staged Connect Agent pairing is the only current dashboard flow:

1. The user chooses the Haven wallet, agent rules, and agent budget.
2. Haven creates a pending setup and returns a setup token and connector
   command.
3. The connector runs locally, generates the delegate signing key and API key,
   and stores both in protected local runtime configuration.
4. Registration sends only the setup token, runtime/version metadata, public
   signing address and proof, API-key hash/prefix, and the MCP server name the
   connector wired this agent as (`haven`, or `haven-<slug>` — a display label
   the dashboard shows so several agents in one harness can be told apart;
   #1878). No private key or plaintext API key is registered.
5. The user approves, in the modal, with one signature — and that signature is
   the authority. On the legacy rail it is a wallet approval — but note the
   parallel with the next sentence does not hold: since #1986 that
   AllowanceModule permission no longer unlocks spend on any payment path, so
   for an existing legacy Safe this step is vestigial. `tryVerifySetupAuthority`
   is still live code, so a user really can walk through it and land nowhere.
   On the delegation rail it is the budget delegation itself, granted at the same step
   of the same flow; the agent cannot spend until that budget is active, and
   its limits are carried by the caveat enforcers at redemption rather than by
   a module permission.
6. Later hosted requests use the locally stored API key as Bearer identity;
   the local signer retains the delegate key as authority.

Manual fallback is limited to the explicit, warning-gated surfaces that support
it. Setup links and snippets may contain hosted identity configuration, but
never a delegate key.

## Direct payment

1. `haven_pay` asks the backend to construct a payment intent.
2. Within the remaining budget, it returns `payment_id`, `payload_hash`, and
   expiry. Above the remaining budget it is **declined before any money moves**
   — nothing is queued and no one is asked to review it, because there is no
   approval queue on the delegation rail (`approval_requests` went with #2055).
3. `haven_sign` signs the payload locally.
4. `haven_submit` relays the signature; the backend verifies the delegate and
   submits the sponsored UserOp that redeems the budget delegation.

## x402

The recommended paid-MCP path is:

```text
haven_pay_mcp_tool
  → haven_sign_x402
  → haven_settle_mcp_tool
```

Hosted MCP prepares the funding and merchant contexts, the signer locally
authorizes both legs, and hosted MCP relays the signed merchant authorization.

The generic decomposed path remains available, in two shapes since
[#2041](https://github.com/d-hinders/Haven-AI/issues/2041) — the scheme is
chosen by the shared #1450/#1453 selector and reported as `settlement_scheme`,
never inferred by the agent:

```text
EIP-3009 bridge (any rail; the only shape before #2041)
haven_quote_x402 / haven_pay_x402_quote
  → haven_sign
  → haven_submit                       (relays the FUNDING signature)
  → haven_x402_sign_header
  → merchant retry or haven_complete_mcp_tool
  → haven_report_x402_outcome          (only when YOU did the retry)

erc7710 direct settlement (delegation rail + merchant advertises it)
haven_quote_x402 / haven_pay_x402_quote
  → haven_sign                         (signs the SETTLEMENT CHILD)
  → haven_submit { settlement_scheme: "erc7710" }  → payment_header
  → merchant retry
```

**Why the last EIP-3009 step exists at all
([#2292](https://github.com/d-hinders/Haven-AI/issues/2292)).** The two
branches of "merchant retry **or** `haven_complete_mcp_tool`" are not
symmetric, and the asymmetry is the point of this whole flow: on the
`haven_complete_mcp_tool` branch Haven makes the merchant call and therefore
*observes* the outcome, writing the evidence or reconciliation row itself. On
the plain-HTTP branch Haven never contacts the merchant — it holds no key and
speaks to no merchant — so the outcome only exists in the agent. Without a
report, the funded-but-undelivered detection this doc describes could not fire
for fifteen minutes on the one flow Haven prescribes.

`haven_report_x402_outcome` is that channel, and it is a separate tool rather
than a mode on `haven_complete_mcp_tool` for the same reason the branches
differ: one records an observation, the other records an assertion. It records;
it never verifies, because verifying would mean Haven calling the merchant. Its
authority boundary — what is checked, what deliberately is not, and what a
hostile caller can and cannot achieve — is written up in
[`04-x402-payment-sequence.md`](04-x402-payment-sequence.md) rather than
restated here.

The erc7710 shape is shorter by exactly the funding leg: no funding relay to
confirm, no `haven_x402_sign_header`, no delegate hot balance and nothing to
sweep.

> ⚠️ **Nothing on the LEGACY allowance rail runs: not the coverage split below,
> not hosted keyless x402 at all.** The split was that rail's arithmetic, and
> its middle branch is the approval queue epic #1440 retired. Since #1986
> `POST /x402/authorize` answers HTTP 410 for an `allowance_module` account,
> above the funding leg, so no funding intent and no funding hash is ever
> produced for the edge signer to sign on that rail. The split is kept as the
> record of what the rail did (#2130); the live behaviour is stated immediately
> after it.

- `amount <= remaining allowance` could execute;
- `remaining < amount <= remaining + delegate balance` **queued for approval**;
- `amount > remaining + delegate balance` was rejected as insufficient coverage.

**On the live delegation rail there is no middle branch.** An over-budget
amount is refused outright and nothing is queued: on the EIP-3009 shape the
redemption is estimated, so the caveat enforcer's refusal surfaces as a `502`
with no intent row; on erc7710 authorize pre-checks the live remaining budget
and answers `403 delegation_budget_exceeded` (#2082). The legacy rail answers
`410` before either (#1986). No branch of any of them returns a funding hash.

**That 410 is RAIL-SCOPED, and the scope is the correction** — the banner above
says hosted keyless x402 does not run on the LEGACY rail, not that it fails for
any account, and the difference is the whole point. This section previously said
hosted x402 worked for **no** account, reasoning from a second claim — that the
hosted construct refuses typed-data funding intents — which had already stopped
holding when it was written. `docs/architecture/08-local-vs-hosted-mcp.md`
records the measurement (2026-08-25): #1254 forwards `signature_scheme` +
`typed_data` verbatim to the edge signer, #1456 added the hosted erc7710 settle
branch, and BOTH hosted schemes have green QA scenarios against the real
deployed hosted MCP and the real signer. The #1986 fail-close is **rail-scoped**
and applies to both topologies equally: it removed the legacy rail, never the
hosted surface.

[#2041](https://github.com/d-hinders/Haven-AI/issues/2041) falsifies the blanket
claim a second, independent way, which is why it is corrected here rather than
left to contradict `08`: a delegation-rail account now completes an erc7710
x402 payment end to end through exactly this generic decomposed surface —
`haven_pay_x402_quote` → `haven_sign` → `haven_submit` — with no funding leg at
all.

**Hosted DIRECT payments are a separate question and are NOT affected in kind:**
`POST /payments` serves both rails and its delegation branch is untouched by
#1986, so a delegation-rail account still creates a signable intent there. It
is the x402 keyless construct specifically that has no working rail left.

After a successful paid retry — including the hosted completion path
(`completeX402MerchantCall`) — the SDK captures a merchant-issued receipt from
the paid response's `x-receipt-json`/`x-receipt-url` headers and reports it,
best-effort, to `POST /machine-payments/:id/merchant-receipt`.

## Tool surfaces

Hosted MCP provides identity and allowance reads, direct send/prepare/submit,
x402 and MPP quote/resume/status operations, paid-MCP prepare/settle,
receipt listing and verification, discovery, and gasless USDC sweep
orchestration. The exact registered union is in
`packages/mcp-server/src/tools.ts`.

The edge signer exposes four local, no-network tools:

| Tool | Purpose |
|---|---|
| `haven_sign` | Sign a prepared payment hash |
| `haven_x402_sign_header` | Sign the decomposed merchant authorization |
| `haven_sign_x402` | Sign the recommended paid-MCP funding and merchant contexts |
| `haven_sign_sweep_delegate` | Sign a gasless delegate-to-wallet USDC sweep |

## Review checklist

- Hosted services never receive a delegate key.
- Setup registration contains public proof, hashed API-key metadata, and the
  connector-reported MCP server name — a display label only, never authority
  (nothing keys off it, and it is not unique).
- API-key rotation changes identity credentials, not signing authority.
- Declined or insufficient requests expose no signable hash — nothing is queued.
- x402 authorization is bound to amount, merchant, resource, asset, and network.
- Sweep authorization is bound to the registered delegate and Haven wallet.
- Users can pause or revoke in Haven and revoke Safe permissions outside Haven.

## Related docs

- [x402 payment sequence](04-x402-payment-sequence.md)
- [Edge signer](07-edge-signer.md)
- [Local vs hosted MCP](08-local-vs-hosted-mcp.md)
- [CASP / MiCA guardrails](../regulatory/casp-risk-guardrails.md)
