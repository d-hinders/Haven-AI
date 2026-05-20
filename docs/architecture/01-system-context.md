# Haven — System Context

A C4-L1 view of every actor and system Haven touches today, grouped by
**trust boundary**. Reading the colored groupings tells you the non-custodial
story at a glance: user funds live in the Safe; Haven holds operational
credentials only (JWT, hashed API keys, relayer gas wallet); the agent holds
its own delegate private key.

```mermaid
flowchart LR
  classDef userCustody    fill:#dbeafe,stroke:#1d4ed8,color:#0b1d51
  classDef havenCustody   fill:#ede9fe,stroke:#6d28d9,color:#1f1147
  classDef agentCustody   fill:#ffedd5,stroke:#c2410c,color:#3a1c08
  classDef onchain        fill:#dcfce7,stroke:#15803d,color:#0a2a17
  classDef external       fill:#f3f4f6,stroke:#4b5563,color:#111827

  subgraph USER["User custody"]
    U([User])
    WALLET[Connected wallet<br/>or Passkey]
  end
  class U,WALLET userCustody

  subgraph HAVEN["Haven custody"]
    WEB[Haven web app<br/>Next.js]
    BE[Haven backend<br/>Fastify + Postgres]
    RELAYER[Relayer wallet<br/>RELAYER_PRIVATE_KEY]
  end
  class WEB,BE,RELAYER havenCustody

  subgraph AGENT_BOX["Agent custody"]
    AGENT[External agent runtime]
  end
  class AGENT agentCustody

  subgraph CHAIN["On-chain — Gnosis Chain (id 100)"]
    SAFE[Safe smart account]
    AM[AllowanceModule]
    ERC20[ERC20 tokens<br/>USDC, EURe, ...]
    OWNERS[Safe owners<br/>on-chain EOAs / passkeys]
  end
  class SAFE,AM,ERC20,OWNERS onchain

  subgraph EXT["External"]
    X402[x402 server<br/>/ facilitator]
    RPC[Gnosis RPC]
  end
  class X402,RPC external

  %% User control
  U -->|email + password<br/>JWT 7d| WEB
  WEB -->|REST + JWT| BE
  U -->|controls| WALLET
  WALLET -->|signs SafeTx:<br/>enable module,<br/>set allowance,<br/>manual send| BE
  U -.->|controls owner keys| OWNERS
  OWNERS -->|owners of| SAFE
  SAFE -->|holds| ERC20
  SAFE -->|module enabled| AM

  %% Agent control
  AGENT -->|POST /payments<br/>POST /x402/authorize<br/>Bearer sk_agent_*| BE
  AGENT -->|signs sign_hash<br/>with delegate key| BE
  AGENT -->|HTTP 402 challenge| X402

  %% Haven execution
  BE -->|reads allowance,<br/>builds sign_hash| RPC
  BE -->|relays execTransaction<br/>for manual sends| RPC
  RELAYER -->|signs + pays gas for<br/>executeAllowanceTransfer| RPC
  RPC --> AM
  AM -->|spend within allowance| ERC20
```

## Notes

- **Haven never holds delegate private keys.** Agents bring their own EOA
  ([packages/backend/src/routes/agents.ts:101](../../packages/backend/src/routes/agents.ts)).
- **The relayer wallet is the on-chain tx signer** for
  `executeAllowanceTransfer`; the delegate's signature is just calldata
  ([packages/backend/src/lib/allowance-module.ts](../../packages/backend/src/lib/allowance-module.ts)).
- **Safe ownership is trusted at import.** Haven does not query or store the
  on-chain owners list today
  ([packages/backend/src/routes/user-safes.ts](../../packages/backend/src/routes/user-safes.ts)).
- **Manual sends route through the user's wallet/passkey**, not the relayer
  ([packages/frontend/src/lib/signer.ts](../../packages/frontend/src/lib/signer.ts),
  [packages/frontend/src/lib/safe-tx.ts](../../packages/frontend/src/lib/safe-tx.ts)).
