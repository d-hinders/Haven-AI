---
owner: "@d-hinders"
status: current
covers:
  - packages/backend/src/routes/safe-deploy.ts
  - packages/backend/src/modules/accounts/safe-deployer.ts
  - packages/backend/src/routes/passkeys.ts
  - packages/backend/src/routes/user-safes.ts
  - packages/backend/src/routes/agents.ts
  - packages/backend/src/routes/auth.ts
  - packages/backend/src/routes/payments.ts
  - packages/backend/src/routes/x402.ts
  - packages/backend/src/routes/agent-delegations.ts
  - packages/backend/src/routes/hybrid-accounts.ts
  - packages/backend/src/rails/delegation-rail.ts
  - packages/backend/src/rails/delegation-policy.ts
  - packages/backend/src/routes/safe-exec.ts
  - packages/backend/src/routes/agent-connection-setups.ts
  - packages/backend/src/rails/allowance-module.ts
  - packages/backend/src/modules/agents/agent-connection-setup.ts
  - packages/backend/src/domain/chains.ts
  - packages/backend/src/modules/accounts/passkey-signer.ts
  - packages/backend/src/infra/relayer.ts
  - packages/backend/src/rails/sweep.ts
  - packages/backend/src/modules/accounts/safe-details.ts
  - packages/backend/src/config.ts
  - packages/backend/src/middleware/agentAuth.ts
  - packages/backend/src/db/migrations/006_user_passkeys.ts
  - packages/backend/src/db/migrations/017_agent_connection_setups.ts
  - packages/frontend/src/context/AuthContext.tsx
  - packages/frontend/src/lib/api.ts
  - packages/frontend/src/lib/passkey*.ts
  - packages/frontend/src/lib/safePasskeySigner.ts
  - packages/connect/src/runtime.ts
  - packages/connect/src/key.ts
  - packages/connect/src/storage.ts
  - packages/sdk/src/types.ts
  - packages/sdk/src/x402.ts
  - packages/sdk/src/sweep.ts
  - packages/signer/src/core.ts
last-verified: "2026-08-24" # #1984: "import-only" corrected — importing a Safe now answers 410, so the legacy rail admits nothing new. Re-read the custody claims against the diff: the perimeter NARROWS (one relayer-gas surface with no per-caller ownership check is closed) and no custody relationship is created. Prior: #1878: the "Default Connect Agent flow" bullet listed what the connector sends Haven as a closed set ("only the API-key hash/prefix, public delegate address, and challenge proof") and the resolved MCP server name is now also on that wire. Corrected in place, and its second "sends only" — which was about the API KEY specifically, not the payload as a whole — is reworded to say so, since the two "only"s sat one line apart and the first becoming wrong made the second read as wrong too. The custody claim itself does not move: the delegate private key and the plaintext API key still never reach Haven. Scope: that bullet; no other custody, key-handling or passkey claim re-verified. Prior: #1700: Provisioning Paths gains a fourth entry — re-key REPLACES an agent's delegate key, and its credential split is asymmetric where every other path's is not: the delegate key is generated locally, the API key is minted by the backend under owner authorisation and pasted in. The existing three entries were re-read against the diff and none is contradicted (the Connect flow's "generates both locally" is still true OF the Connect flow); this is a missing path rather than a wrong claim. Custody Invariants re-read and unchanged — Haven still never receives a delegate private key and nothing here moves one between machines. Prior: #1199: signer-removal recovery change re-verified; client-signing and custody claims unchanged
---

# Haven — Identity & Key/Credential Custody

The identities, keys, and credentials used by Haven's primary account and agent
flows, plotted with the party that holds them. This is the diagram to consult
when reasoning about blast radius: "if X is compromised, what can move?".

> **Two rails.** The zones, diagram, and invariants below describe the
> **legacy AllowanceModule rail** (RETIRING under #1440 — closed to new accounts
> entirely since #1984; existing accounts only). The Smart
> Sessions **session rail is retired** (#834): `session_key` accounts get
> HTTP 410 from the payment paths. New accounts run on the
> **delegation rail** (`account_type='delegator_hybrid'`, epic #821); its custody
> semantics and the full invariant→invariant mapping are in
> [`docs/security/delegation-rail-security-model.md`](../security/delegation-rail-security-model.md).
> The [delegation-rail custody](#delegation-rail-custody-new-accounts) subsection
> below summarizes the differences that matter for blast-radius reasoning.

The four custody zones:

| Zone | Holds | Worst-case if compromised |
|---|---|---|
| **User** | password, browser JWT, owner EOA key or passkey authenticator | A stolen bearer token exposes account APIs but not signing authority. Enough owner credentials to meet the Safe threshold can change owners and move funds. |
| **Haven-operated** | JWT signing secret, API-key hashes, public signer/passkey metadata, authorization-context key, gas relayer keys | Compromise exposes service data and relayer gas. Safe-held funds still require an existing allowance with a delegate signature or a threshold-valid owner signature. |
| **Agent environment** | plaintext API key and local delegate key | Can use the remaining Safe allowance and spend any assets already held by the delegate EOA, including stranded x402 funds. |
| **On-chain** | Safe state, AllowanceModule state | Authoritative source of truth |

```mermaid
flowchart TB
  classDef userZone   fill:#dbeafe,stroke:#1d4ed8,color:#0b1d51
  classDef havenZone  fill:#ede9fe,stroke:#6d28d9,color:#1f1147
  classDef agentZone  fill:#ffedd5,stroke:#c2410c,color:#3a1c08
  classDef chainZone  fill:#dcfce7,stroke:#15803d,color:#0a2a17
  classDef secret     fill:#fee2e2,stroke:#b91c1c,color:#3a0a0a,stroke-dasharray: 4 2

  subgraph USER["User-controlled"]
    direction TB
    U([User])
    PW[(Email + password)]:::secret
    JWTPT[(Browser bearer JWT<br/>7-day expiry)]:::secret
    EOAKEY[(Owner EOA private key)]:::secret
    PASSKEY[(Passkey authenticator<br/>private key)]:::secret
  end
  class U userZone

  subgraph HAVEN["Haven-operated infrastructure"]
    direction TB
    USERS[(users table<br/>email, password_hash)]
    JWTSECRET[(JWT_SECRET<br/>server signing key)]:::secret
    AGENTS_TBL[(agents table<br/>delegate_address,<br/>api_key_hash,<br/>api_key_prefix)]
    PASSKEYS_TBL[(user_passkeys<br/>credential id, public coordinates,<br/>signer/Safe metadata, attestation)]
    BINDINGKEY[(X402_BINDING_PRIVATE_KEY<br/>authorization-context signer)]:::secret
    RELAYERKEY[(Gas relayer key(s)<br/>global + per-chain payment keys)]:::secret
  end
  class USERS,AGENTS_TBL,PASSKEYS_TBL havenZone

  subgraph AGENT_ZONE["Agent-controlled environment"]
    direction TB
    AGENT[API client / agent runtime]
    SIGNER[Local edge signer]
    APIKEYPT[(identity.json<br/>plaintext sk_agent_*)]:::secret
    DELEGATEKEY[(signer.json<br/>delegate private key)]:::secret
  end
  class AGENT,SIGNER agentZone

  subgraph CHAIN["On-chain — Base, Gnosis, Base Sepolia"]
    direction TB
    SAFE[Safe smart account]
    OWNERS_LIST[Safe owners + threshold]
    PASSKEY_SIGNER[Passkey signer contract]
    AM[AllowanceModule]
    DELEGATE_ADDR[Delegate EOA<br/>+ per-token allowance<br/>+ any held assets]
  end
  class SAFE,OWNERS_LIST,PASSKEY_SIGNER,AM,DELEGATE_ADDR chainZone

  %% User identity and owner authority
  U --> PW
  U --> EOAKEY
  U --> PASSKEY
  PW -->|authenticates| USERS
  JWTSECRET -->|auth route signs| JWTPT
  JWTPT -->|verified with| JWTSECRET
  EOAKEY -->|EOA owner| OWNERS_LIST
  PASSKEY -->|WebAuthn assertion| PASSKEY_SIGNER
  PASSKEY_SIGNER -->|contract owner| OWNERS_LIST
  PASSKEY -->|public registration metadata| PASSKEYS_TBL
  OWNERS_LIST -->|threshold controls| SAFE

  %% Split agent identity and signing authority
  AGENT --> APIKEYPT
  SIGNER --> DELEGATEKEY
  APIKEYPT -->|SHA-256 hash only| AGENTS_TBL
  DELEGATEKEY -.->|public key =| DELEGATE_ADDR
  AGENTS_TBL -.->|delegate_address| DELEGATE_ADDR
  SAFE -->|setAllowance grants| DELEGATE_ADDR

  %% Haven-operated execution without spending-key custody
  APIKEYPT -->|backend matches SHA-256 hash| AGENTS_TBL
  DELEGATEKEY -->|produces signatures for| DELEGATE_ADDR
  DELEGATE_ADDR -->|signature verified as calldata| AM
  RELAYERKEY -->|pays gas for authorized calls| AM
  RELAYERKEY -->|deploys accounts/signers or relays<br/>threshold-valid passkey Safe tx| SAFE
  BINDINGKEY -.->|context signature verified locally| SIGNER
  AM -->|spends within allowance| SAFE
```

## Provisioning Paths

- **Default Connect Agent flow:** the connector generates both the API key and
  delegate key locally. It sends Haven only the API-key hash/prefix, public
  delegate address, challenge proof, and the MCP server name it wired the agent
  as (#1878 — a non-secret display label, never authority), then writes separate
  owner-only `identity.json` and `signer.json` files. Of the API key itself,
  registration sends only the hash/prefix; later API calls present the plaintext
  API key as a bearer
  credential that Haven hashes for lookup. Haven never stores that plaintext
  API key and never receives the delegate key
  ([connector runtime](../../packages/connect/src/runtime.ts),
  [credential storage](../../packages/connect/src/storage.ts)).
- **Manual `/agents` flow:** the backend still generates an API key, returns it
  once, and stores only its SHA-256 hash and prefix. The caller supplies the
  public delegate address; the delegate private key remains outside Haven
  ([agent routes](../../packages/backend/src/routes/agents.ts)).
- **Re-key flow (#1700):** an agent's delegate key is REPLACED rather than
  provisioned, and the split is asymmetric in a way the other paths are not.
  The connector generates the new delegate key locally and sends Haven only the
  public address — but the new API key is minted by the BACKEND, during an
  owner-authorised re-key, and reaches the machine by the owner pasting it. So
  unlike the Connect flow above, only one of the two credentials originates
  here. What is unchanged is the part that matters for custody: Haven still
  never receives a delegate private key, and there is still no mechanism that
  could move one between machines. The credential files are rewritten in place
  at an unchanged path, and the rotation is authorised by the account owner
  through the dashboard — an agent cannot re-key itself, which the backend
  enforces by refusing an agent credential on every re-key route
  ([re-key client flow](../../packages/connect/src/rekey.ts),
  [re-key routes](../../packages/backend/src/routes/agent-rekey.ts)).
- **Passkey owner flow:** the authenticator retains the private key. Haven stores
  the credential id, public P-256 coordinates, predicted signer address, chain,
  Safe association, and optional raw attestation. The current registration
  route stores the attestation but does not verify it
  ([passkey routes](../../packages/backend/src/routes/passkeys.ts),
  [browser passkey helper](../../packages/frontend/src/lib/passkey.ts)).

## Custody Invariants

1. **Haven cannot move Safe-held user funds without existing authority.** An
   allowance transfer needs the matching delegate signature and remains bounded
   by the on-chain allowance. Owner actions need enough valid signatures to meet
   the Safe threshold.
2. **Relayers provide gas, not authority.** They can deploy Haven wallets and
   passkey signer contracts and submit already authorized calls. Compromise can
   lose relayer gas funds, but cannot forge a delegate or threshold-valid owner
   signature.
3. **Haven cannot impersonate an agent on-chain.** The AllowanceModule verifies
   the delegate signature against the granted address. Haven stores the public
   address and API-key hash, not the delegate key.
4. **API-key compromise is not sufficient to spend.** The key identifies the
   agent, but `/payments/:id/sign` still requires a valid delegate signature
   ([payment routes](../../packages/backend/src/routes/payments.ts)).
5. **Delegate-key exposure includes delegate-held assets.** In addition to the
   remaining Safe allowance, a compromised delegate can spend assets already in
   its EOA—for example, funds left after the Safe-to-delegate x402 funding leg
   confirms but the merchant rejects the paid retry. Keep budgets small and use
   the gasless sweep recovery flow.
6. **Owner compromise is threshold-dependent.** One stolen owner credential is
   sufficient only for a threshold-one Safe. Enough compromised owner
   credentials to meet the configured threshold can change owners, disable
   modules, or move funds directly. The Safe remains the root of trust.

## Delegation rail custody (new accounts)

On the delegation rail the Haven wallet is a MetaMask Hybrid DeleGator smart
account, not a Safe + AllowanceModule, and the policy primitive is a **signed
delegation the agent holds** rather than on-chain allowance state. The custody
line is unchanged — Haven never holds a signer that can spend — but the blast
radius shifts in a few ways worth mapping explicitly:

- **Authority is a held object.** The agent receives a signed budget delegation
  (period budget with native refill + optional recipient pin + expiry) through the
  same credential channel as its API key. Haven stores a copy for reconstruction,
  revocation targeting, and observability. It is **not key material**, but it is
  spend-enabling *in combination with* the delegate key, so it is protected like
  `api_key_hash`-class data: encrypted at rest, never logged.
- **The delegate key alone still cannot spend**, and the delegation alone still
  cannot spend. Full agent compromise (both) is bounded by the caveat stack:
  ≤ one period's budget, only to pinned recipients, until expiry or the owner's
  `disableDelegation` kill-switch. Blast radius is therefore **identical in kind**
  to the retired session rail's per-period allowance.
- **No funding leg on the primary paths, so no standing delegate balance.**
  Direct payments and erc7710 x402 settle account→recipient/merchant directly.
  The **EIP-3009 x402 fallback (#946) is the deliberate exception**: the budget
  delegation is redeemed to transiently fund the agent's delegate EOA, which
  signs the standard merchant header — so in 3009-mode invariant 5's
  "delegate-key exposure includes delegate-held x402 funds" DOES apply,
  bounded by the period budget (metered at the funding hop) and covered by the
  reused sweep/monitor machinery. Recipient-pinned budgets cannot fund the EOA
  and stay erc7710-only.
- **The account owner is watch-only in Haven**, and the DeleGator's UUPS upgrade
  authority is the account's own signers — never Haven. Haven-side compromise can
  construct malicious payloads but cannot sign grants, redemptions, or upgrades.
- **The signer set is user-managed and can be pure-passkey (#836).** An account
  holds one or more P256 passkeys and/or an EOA owner; enrolling or removing a
  signer (`addKey`/`removeKey`/`transferOwnership`) is prepared by Haven and
  signed by an EXISTING signer — WebAuthn or EOA, whichever of the account's
  signers the signing DEVICE can produce (the client requests the scheme,
  validated against the real signer set — a mixed account is never forced onto
  its owner wallet). Haven
  stores only PUBLIC key material (`hybrid_account_passkeys`), synced to chain
  state after the op confirms and pinned to the signed calldata. Recovery and
  the backup-signer recommendation (#1153): [account-recovery](../../docs/product/account-recovery.md)
  and the security model §6.

Full invariant-by-invariant mapping (including the CI checks that enforce each
one) and the independent exit/revocation story:
[`docs/security/delegation-rail-security-model.md`](../security/delegation-rail-security-model.md)
and [`docs/exit/README.md`](../exit/README.md)
([delegation rail](../../packages/backend/src/rails/delegation-rail.ts),
[delegation policy](../../packages/backend/src/rails/delegation-policy.ts)).
