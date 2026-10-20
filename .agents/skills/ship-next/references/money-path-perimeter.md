# Money-path perimeter — annotated

Loaded by [`ship-next`](../SKILL.md) § *Merge Gate* when you need the reasoning
behind a money-path path. The authoritative answer is
[`.github/money-path-globs.json`](../../../../.github/money-path-globs.json) (#1030);
this file is its annotated twin, and `scripts/ci/money-path.test.mjs` holds the two
**equal** (#4177).

## How the test reads this file

Only a line of exactly the form ``- `<path>` `` counts as a perimeter entry: a
hyphen, one space, one backticked repo-root path, nothing after it. A backticked
path anywhere else (in a sentence, a heading or a parenthetical) is prose and is
not read. Every list item in this file must be such an entry, whatever its
marker (hyphen, star, plus, `1.` or `1)`), indent or `>` blockquote: a list item
that names a path and then explains it is a near miss, and the test fails on it
rather than skipping it, because a skipped near miss reads to a human as perimeter
while the machinery never sees it.

Code fences are not special. An entry inside a fence still counts, and a `## `
line inside a fence still switches the section. That fails closed: a fence can add
a finding, never hide one. So do not put example entries in a fence here.

Entries under the runtime heading must equal `globs` and entries under the control
heading must equal `controlGlobs`, as sets, in both directions. A missing path, an
extra path, a suffix such as `routes/payments.ts`, a concrete file that a pattern
already covers, or a runtime path moved into the control section each fails CI.
Write the glob string exactly as the JSON writes it. The `###` groups and the prose
under them are for the reader; the test ignores both.

Before #4177 this list was a bullet list in the Merge Gate, and the test matched
backticked prose tokens against the end of a glob. That matcher let `src/**` name
six of the eight SDK globs and a file that does not exist (#4122, fixed in PR #4131),
and let a suffix or a covered concrete file stand in for a glob. Exact equality has
no such class of blind spot.

## Runtime perimeter: `globs`

These are labelled money-path **and** counted by the `qa-freshness` promotion gate:
the money-flow harness exercises them, so a green run is evidence about them.

### Payment route files

All three are live route files. #996/#997 moved their *logic* into the modules
below and left thin validation and auth shells, which the old Merge Gate line
described for a year as the files having "dissolved". They had not; all three are
registered in `index.ts`. A parenthetical that reads as an exclusion is worse than
an omission, because nobody re-checks it (#1892).

- `packages/backend/src/routes/payments.ts`
- `packages/backend/src/routes/x402.ts`
- `packages/backend/src/routes/machine-payments.ts`

### x402, MPP and the payment domain

#1987 deleted the off-chain coverage-arithmetic module and the allowance-nonce
coordinator with the AllowanceModule rail, so both left this list: a glob naming a
file that no longer exists guards nothing, and the "no phantom globs" assertion in
`scripts/ci/money-path.test.mjs` fails CI on one. The reads-only survivor stays. It
was `rails/allowance-module.ts` until #2850 renamed it to `infra/chain/relayer-reads.ts`;
the AllowanceModule filename was the last false claim the retired rail left behind.
The `domain/machine-payment-lifecycle.ts` entry guards the backend re-export shim;
the code itself lives in `packages/core` (see below, #1905).

- `packages/backend/src/modules/x402/**`
- `packages/backend/src/modules/mpp/**`
- `packages/backend/src/domain/payment-token.ts`
- `packages/backend/src/domain/machine-payment-lifecycle.ts`
- `packages/backend/src/infra/chain/relayer-reads.ts`

### Budget scope

#3649: the #2099 fail-open period pre-check, the task cap and the typed refusal.
The pre-check lived inline in `modules/x402/delegation-authorize.ts` until #3616
created this module and #3617 deleted the inline copy; both x402 authorize legs and
POST /payments now decide through it. The move took the decision off the perimeter,
which is #1892's accident of location again: where the comparison lives is not what
makes it a spend decision.

- `packages/backend/src/modules/budget-scope/**`

### Task budgets and sub-budgets

#3661: these build the task child and the sub-budget children, including the A→B
grant that hands spend authority to another agent, and run the pre-sign cap and
narrowing refusals. `agent-sub-budgets.ts` is where the owner issues a sub-budget,
the same reason `agent-connection-setups.ts` is listed. `agent-task-budgets.ts` is
not listed: it is GET only.

- `packages/backend/src/modules/task-budgets/**`
- `packages/backend/src/modules/sub-budgets/**`
- `packages/backend/src/routes/task-budgets.ts`
- `packages/backend/src/routes/sub-budgets.ts`
- `packages/backend/src/routes/agent-sub-budgets.ts`

### Payments decision files

`direct-sign-context.ts` builds the bytes the local signer signs for a direct
payment (#3271). `submission-reconciler.ts` settles the terminal state of a
submitted payment whose UserOp may have landed (#3564). `agent-payment-status.ts`
holds `isFundedX402AwaitingMerchantLeg`, which decides whether x402 sign-context
re-signs a confirmed payment; a wrong clause can pay a merchant twice. File-level
on purpose: the rest of the module is the refusal record, receipts and
prepare-failure reporting, pinned as off-list in `scripts/ci/money-path.test.mjs`
(#3661).

- `packages/backend/src/modules/payments/direct-sign-context.ts`
- `packages/backend/src/modules/payments/submission-reconciler.ts`
- `packages/backend/src/modules/payments/agent-payment-status.ts`

### The rail seam

- `packages/backend/src/rails/execution-rail.ts`

### The delegation rail, re-key and connection setup

Re-key revokes and re-issues an agent's on-chain spend authority. It was missing
here, in the JSON and in the labeler from #1698 until #1892, while
`infra/repositories/**` already covered its storage layer: a PR touching the re-key
repository was labelled and one touching only the route was not.
`agent-connection-setups.ts` joined on the same rationale (#2264): its
budget-approval route verifies the signed delegation against the setup and flips
setup and agent to `active`, so it is where an owner's approval becomes an agent's
on-chain spend authority. Since #1984 made connect the only onboarding path, that
job had moved into the list's blind spot.

- `packages/backend/src/rails/delegation-*.ts`
- `packages/backend/src/rails/hybrid-provisioning.ts`
- `packages/backend/src/rails/hybrid-account-config.ts`
- `packages/backend/src/rails/hybrid-signer-actions.ts`
- `packages/backend/src/rails/hybrid-transfers.ts`
- `packages/backend/src/routes/agent-delegations.ts`
- `packages/backend/src/routes/agent-connection-setups.ts`
- `packages/backend/src/routes/agent-rekey.ts`
- `packages/backend/src/modules/agents/rekey-*.ts`

### Funds recovery, gas, the outbound queue and persistence

Funds recovery, gas payment, the durable outbound-tx queue and its bump worker,
the relayer spend guard and monitor, the delegate exposure monitor, the
contract-call and persistence layers, and the mainnet authority floor. #1045 added
the relayer and mainnet entries after review found them missing while they move or
gate money. The outbound entries came after epic #1554 shipped files that
broadcast and replace real transactions without appearing here. `infra/delegate-*.ts`
came from #1892's own review, which found the delegate balance monitor unlisted
while its equally read-only sibling `infra/relayer-balance-monitor.ts` was matched
by prefix accident; the two share an alert channel. That sibling is covered by
`infra/relayer*.ts` and is not listed on its own line: an entry is the glob, not a
file it covers.

- `packages/backend/src/rails/sweep.ts`
- `packages/backend/src/infra/relayer*.ts`
- `packages/backend/src/infra/delegate-*.ts`
- `packages/backend/src/infra/outbound-*.ts`
- `packages/backend/src/infra/chain/**`
- `packages/backend/src/infra/repositories/**`
- `packages/backend/src/modules/accounts/mainnet-gate.ts`

### Request validation

#3029, epic #3028: the request-validation plugin. Runtime, not control: it sits in
front of every payment route, so a green money-flow run exercises it on every leg.
It refuses on the modules the backend's own `enforcedModules` install option names
and shadow-logs everywhere else; read that list in the source, never a count here.
It is a shape validator: it reads the request against the spec, refuses or logs,
and never authorizes or constructs spend intent. It does rewrite values where the
spec declares a type and ajv coerces: #3082 found a shadow-mode body reaching
handlers with `null` turned into `''`, which refused every open budget. Shadow
bodies are restored since then and the divergence is counted; querystring and
params coercion, and enforce-mode bodies, still rewrite by design.

- `packages/backend/src/openapi/request-validation.ts`

### Hybrid accounts

User-signed execution and account provisioning. The approval queue's route file
was deleted with its table by #2055, so its glob left the perimeter rather than
being repointed: the code is dead, not moved. The owner-signed relayed execution
route left the same way in #2847, deleted with the last of the Safe rail's live
behaviour.

- `packages/backend/src/routes/hybrid-accounts.ts`

### Signing schemes and the edge signer

Signing schemes are spend authority. The SDK entry point was listed; the
edge-signer package that holds the delegate key material was on no list at all,
and is the stronger case of the two (#1896).

- `packages/sdk/src/signer.ts`
- `packages/signer/**`

### SDK guards and the merchant-answer decision

The delegate key's signing-surface guard moved out of `packages/signer/` into the
SDK by #3283, with the #3271 binding check both packages import; their location is
not what makes them spend authority. The task and sub-budget guards join them on
the same rule (#3661): the signer's own checks on task and sub-budget children
before it signs. `merchant-completion.ts` joins as runtime (#4122):
`MerchantCompletion.retryRequest` decides, after the funding leg has moved USDC,
whether the merchant accepted or the payment is a rejection after funding, and
reports the settlement hash Haven records. `merchant-answer.ts` joins as runtime
too (#4120): the one post-funding merchant-answer decision shared by the hosted
`completeX402MerchantCall` and the local `MerchantCompletion.retryRequest`. The
decision moved out of `merchant-completion.ts` into this module in the same PR,
and the move would otherwise have taken it off the perimeter (the #3283
accident-of-location rule).

The SDK client stays off deliberately (#3283, re-taken by the owner on #4120): it
only wires these guards in, and listing it would put every SDK transport change on
the runtime list. `scripts/ci/money-path.test.mjs` pins `packages/sdk/src/client.ts`
off by name.

- `packages/sdk/src/delegate-account.ts`
- `packages/sdk/src/direct-payment-guard.ts`
- `packages/sdk/src/redemption-guard.ts`
- `packages/sdk/src/settlement-child.ts`
- `packages/sdk/src/userop-binding.ts`
- `packages/sdk/src/task-budget-guards.ts`
- `packages/sdk/src/sub-budget-guards.ts`
- `packages/sdk/src/merchant-completion.ts`
- `packages/sdk/src/merchant-answer.ts`

### The machine-payment domain

The machine-payment domain lives here since #987; the backend
`domain/machine-payment-lifecycle.ts` entry above guards the re-export shim, not
the code (#1905).

- `packages/core/src/machine-payment-lifecycle.ts`

### Agent authentication

- `packages/backend/src/middleware/agentAuth.ts`

### The hosted MCP tool surface

#2300. `tools.ts` decides *whether* a funding userop is relayed and *in what
order*, and four money defects lived in it with no money-path label by the file
half: #2282's funding-before-merchant-context relay, #2312's silently stripped
`tx_hash`, #2348's stripped `idempotencyKey` that made a retry a second spend, and
#2051's merchant-steerable cap bypass. Runtime, not control: the hosted MCP deploys
from `dev` and the money-flow harness drives it through `QA_HOSTED_MCP_URL`, so a
green run covers it, which the frontend decision surfaces could not claim. Scoped
to `src/**` on a measured 3-of-113-commits delta for the package's README,
Dockerfile and config files; the command and window are in the JSON note.

- `packages/mcp-server/src/**`

### The demo merchant's settlement surface

#3098. `x402.ts` verifies the buyer's authorization and submits it on-chain, and the
prod instance runs on Base mainnet. The CASP guardrails doc had covered the package
since #650 while the classifier never had, and two settlement-semantics changes
shipped through that gap: #2969 / PR #2977 unlabelled, and #2979 / PR #2982
labelled only because it also touched the hosted MCP package. Runtime, not
control: it deploys from `dev` on Railway and the money-flow harness pays it
through `QA_DEMO_MERCHANT_URL`. Scoped to `src/**` like the hosted MCP entry.

- `packages/demo-merchant-mcp/src/**`

### Migrations

- `packages/backend/src/db/migrations/**`

## Control surface: `controlGlobs`

The safeguard's own control surface. These are labelled money-path, so a PR
weakening the gate gets the [`money.md`](../../../../docs/contributing/ship-playbooks/money.md)
playbook and a human, but they are excluded from the freshness re-run: re-running
the money-flow harness proves nothing about a CI config change (#1903).

### Release and version rules

`release-version-order.mjs` is the forward-only version rule #2580 lifted out of
`release-bump.mjs`. A rule that decides which version may reach npm belongs on the
same footing as the script that applies it.

- `scripts/release-bump.mjs`
- `scripts/release-version-order.mjs`
- `.github/workflows/publish.yml`

### The money-path gate itself

- `scripts/ci/qa-freshness.mjs`
- `scripts/ci/money-path.test.mjs`
- `scripts/ci/money-path-restatement-scan.mjs`
- `.github/money-path-globs.json`
- `.github/CODEOWNERS`
- `.github/workflows/dev-gate.yml`
- `.github/workflows/qa-dev.yml`

### The docs coupling gate

- `scripts/docs/coupling-gate.mjs`
- `scripts/docs/validate-frontmatter.mjs`
- `.github/workflows/docs-coupling.yml`

### Frontend spend-authority signing

The same call as the CI files: the harness exercises the deployed backend, not the
client, so a QA re-run proves nothing about a change to which signer signs a
spend-authority action, but a human should read it (#1903).

- `packages/frontend/src/lib/signer.ts`
- `packages/frontend/src/hooks/useAgentRekey.ts`
