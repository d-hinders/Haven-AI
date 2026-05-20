# Haven — Identity & Key/Credential Custody

Every identity, key, and credential in the system plotted with the party that
holds it. This is the diagram to consult when reasoning about blast radius:
"if X is compromised, what can move?".

The four custody zones:

| Zone | Holds | Worst-case if compromised |
|---|---|---|
| **User** | password, owner EOA/passkey | Can change Safe owners and move funds directly |
| **Haven** | JWT secret, `api_key_hash`, relayer key | Can call AllowanceModule **only within existing allowances**; cannot change owners or exceed allowances |
| **Agent** | plaintext API key, delegate EOA key | Can spend up to the remaining on-chain allowance for that delegate |
| **On-chain** | Safe state, AllowanceModule state | Authoritative source of truth |

```mermaid
flowchart TB
  classDef userZone   fill:#dbeafe,stroke:#1d4ed8,color:#0b1d51
  classDef havenZone  fill:#ede9fe,stroke:#6d28d9,color:#1f1147
  classDef agentZone  fill:#ffedd5,stroke:#c2410c,color:#3a1c08
  classDef chainZone  fill:#dcfce7,stroke:#15803d,color:#0a2a17
  classDef secret     fill:#fee2e2,stroke:#b91c1c,color:#3a0a0a,stroke-dasharray: 4 2

  subgraph USER["🔵 User custody"]
    direction TB
    U([User])
    PW[(Email + bcrypt password)]:::secret
    OWNERKEY[(Owner EOA / Passkey<br/>private key)]:::secret
  end
  class U userZone

  subgraph HAVEN["🟣 Haven custody"]
    direction TB
    USERS[(users table<br/>email, password_hash)]
    JWT[(JWT — 7d<br/>signed server-side)]:::secret
    AGENTS_TBL[(agents table<br/>delegate_address,<br/>api_key_hash,<br/>api_key_prefix)]
    RELAYERKEY[(RELAYER_PRIVATE_KEY<br/>env var)]:::secret
  end
  class USERS,JWT,AGENTS_TBL havenZone

  subgraph AGENT_ZONE["🟠 Agent custody"]
    direction TB
    AGENT[Agent runtime]
    APIKEYPT[(Plaintext API key<br/>sk_agent_*<br/>shown once at creation)]:::secret
    DELEGATEKEY[(Delegate EOA<br/>private key)]:::secret
  end
  class AGENT agentZone

  subgraph CHAIN["⚫ On-chain — Gnosis"]
    direction TB
    SAFE[Safe smart account]
    OWNERS_LIST[Safe owners list<br/>on-chain only]
    AM[AllowanceModule]
    DELEGATE_ADDR[Delegate address<br/>+ per-token allowance]
  end
  class SAFE,OWNERS_LIST,AM,DELEGATE_ADDR chainZone

  %% User edges
  U --> PW
  U --> OWNERKEY
  PW -->|authenticates| USERS
  USERS -->|issues| JWT
  OWNERKEY -->|listed as owner| OWNERS_LIST
  OWNERS_LIST -->|controls| SAFE
  OWNERKEY -->|signs SafeTx:<br/>enable module,<br/>set allowance| SAFE

  %% Agent edges
  AGENT --> APIKEYPT
  AGENT --> DELEGATEKEY
  APIKEYPT -->|SHA-256<br/>at /agents creation| AGENTS_TBL
  DELEGATEKEY -.->|public key =| DELEGATE_ADDR
  AGENTS_TBL -.->|delegate_address| DELEGATE_ADDR
  SAFE -->|setAllowance grants| DELEGATE_ADDR

  %% Haven execution edge
  AGENTS_TBL -->|backend matches<br/>api_key_hash on request| AGENT
  RELAYERKEY -->|submits<br/>executeAllowanceTransfer| AM
  DELEGATE_ADDR -->|signature passed<br/>as calldata| AM
  AM -->|spends within allowance| SAFE
```

## Custody invariants

1. **Haven cannot move funds outside an existing allowance.** Even with the
   relayer key + full DB access, `executeAllowanceTransfer` is bounded by the
   on-chain allowance the user already granted.
2. **Haven cannot impersonate an agent on-chain.** The delegate signature is
   verified by the AllowanceModule against the granted delegate address; Haven
   does not hold that key.
3. **Compromising the API key ≠ compromising funds.** The plaintext API key
   alone cannot move money — calls to `/payments/:id/sign` require an ECDSA
   signature from the delegate private key
   ([packages/backend/src/routes/payments.ts:305](../../packages/backend/src/routes/payments.ts)).
4. **Owner key compromise is total.** An attacker holding an owner EOA/passkey
   can change owners, disable modules, or move funds directly. This is by
   design — the Safe is the root of trust.
