---
owner: "@d-hinders"
status: current
covers:
  - packages/backend/src/routes/safe-deploy.ts
  - packages/backend/src/lib/safe-deployer.ts
  - packages/backend/src/routes/passkeys.ts
  - packages/backend/src/routes/user-safes.ts
  - packages/backend/src/routes/agents.ts
  - packages/backend/src/routes/auth.ts
  - packages/backend/src/routes/payments.ts
  - packages/backend/src/routes/x402.ts
  - packages/backend/src/routes/safe-exec.ts
  - packages/backend/src/routes/agent-connection-setups.ts
  - packages/backend/src/lib/allowance-module.ts
  - packages/backend/src/lib/agent-connection-setup.ts
  - packages/backend/src/lib/chains.ts
  - packages/backend/src/lib/passkey-signer.ts
  - packages/backend/src/lib/relayer.ts
  - packages/backend/src/lib/sweep.ts
  - packages/backend/src/lib/safe-details.ts
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
last-verified: "2026-06-29"
---

# Haven — Identity & Key/Credential Custody

The identities, keys, and credentials used by Haven's primary account and agent
flows, plotted with the party that holds them. This is the diagram to consult
when reasoning about blast radius: "if X is compromised, what can move?".

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
  delegate address, and challenge proof, then writes separate owner-only
  `identity.json` and `signer.json` files. Registration sends only the API-key
  hash/prefix; later API calls present the plaintext API key as a bearer
  credential that Haven hashes for lookup. Haven never stores that plaintext
  API key and never receives the delegate key
  ([connector runtime](../../packages/connect/src/runtime.ts),
  [credential storage](../../packages/connect/src/storage.ts)).
- **Manual `/agents` flow:** the backend still generates an API key, returns it
  once, and stores only its SHA-256 hash and prefix. The caller supplies the
  public delegate address; the delegate private key remains outside Haven
  ([agent routes](../../packages/backend/src/routes/agents.ts)).
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
