---
owner: "@d-hinders"
status: current
covers:
  - packages/backend/src/modules/passport/readiness.ts
  - packages/backend/src/modules/passport/receipt.ts
  - packages/backend/src/routes/passport-verify.ts
last-verified: "2026-08-08"
---

# Passport verification setup

Turning on the merchant-facing verifier (`GET /passport/verify`,
`GET /passport/issuer`) for a deployment that issues L0 Agent Passports.

This is the operator half of the passport. The other half — registering the EAS
schema so a deployment can *issue* — is
[`11-agent-passport-schema.md` § Registration and configuration](../architecture/11-agent-passport-schema.md#registration-and-configuration).
The two are configured by **independent** env vars, which is the whole reason
this runbook exists.

## Why both halves matter

`AGENT_PASSPORT_SCHEMA_UID_<chainId>` turns issuance on. `PASSPORT_RECEIPT_SIGNING_KEY`
turns verification on. Nothing couples them, so a deployment can sit in any of
four states — and one of them is a trap:

| Schema UID | Signing key | State | Meaning |
|---|---|---|---|
| unset | unset | `unconfigured` | Passports are off here. Fine. |
| **set** | **unset** | **`issuance_only`** | ⚠️ **Anchors real, revocable passports on-chain that no merchant can verify.** |
| unset | set | `verification_only` | Answers for passports already in the DB; issues nothing new. Fine. |
| set | set | `ready` | Fully operational. |

`issuance_only` is not cosmetic. On the **EIP-3009** settlement path — the one
with actual merchant reach — `GET /passport/verify?address=…` is the *only*
delivery mechanism (`modules/passport/x402-delivery.ts`), so a 3009 merchant has
no way to learn a passport exists at all. On **erc7710**, settle responses still
carry `attestation_uid` + `chain_id` (which is what a merchant should resolve
independently anyway), but `verify_url` is silently omitted.

Dev sat in `issuance_only` with three anchored passports and nobody noticed for
days ([#1151](https://github.com/d-hinders/Haven-AI/issues/1151)). Since then the
state reports itself — see [Check the state](#check-the-state) below.

## 1. Mint a dedicated signing key

```bash
node -e "const{ethers}=require('ethers');const w=ethers.Wallet.createRandom();console.log('Address:',w.address);console.log('Key:',w.privateKey)"
```

**Never reuse an existing key.** Specifically:

- **Never the relayer** (`RELAYER_PRIVATE_KEY` / `RELAYER_PRIVATE_KEY_<chainId>`).
  The relayer pays gas for user-authorised transactions and since
  [#908](https://github.com/d-hinders/Haven-AI/issues/908) holds real Base mainnet
  ETH. This key's *address is published* at `GET /passport/issuer` for merchants
  to pin — a public, permissionless signing role has no business borrowing a key
  that moves value. The backend **refuses to boot** if the two match (compared on
  the key's value, not its text, so a re-cased or `0x`-stripped paste is still
  caught).
- **Never the schema registrar** (`PASSPORT_SCHEMA_REGISTRAR_KEY`). That one is a
  throwaway that sent one on-chain transaction; this one signs assertions
  merchants rely on indefinitely.

The signing key is a **message signer only** — no provider, no transactions, no
funding needed. A non-custody invariant test enforces that rather than trusting
the convention, so it never needs a balance.

## 2. Set it per environment

On the deployment's platform (Railway for the backend — see
[`dev-environment.md`](dev-environment.md)):

```
PASSPORT_RECEIPT_SIGNING_KEY=0x…      # the dedicated key from step 1
HAVEN_API_URL=https://…               # already set; without it `verify_url` is omitted
                                      # (`PUBLIC_API_URL` is a legacy alias for the same value)
```

Environments hold **different** keys. Dev's issuer address is not prod's, and a
merchant pins one deployment's issuer, so copying a key across environments
makes two deployments indistinguishable to anyone verifying offline.

Restart the service — the signer is installed at boot.

> **Prod is a separate decision.** Prod serves 84532 alongside mainnet, so it
> *could* hold Sepolia passports, but Base mainnet issuance is deliberately
> absent from `EAS_DEPLOYMENTS` and rides with the
> [#908](https://github.com/d-hinders/Haven-AI/issues/908) mainnet gate. Decide
> prod's verifier alongside that gate, not by copying this runbook's dev steps.

## Check the state

`GET /health` reports it without credentials. Booleans plus the already-published
issuer address only — no key material, no schema UID:

```bash
curl -s https://havenbackend-dev-8b95.up.railway.app/health | jq .passport
```

```json
{
  "verification": { "configured": true, "issuer": "0x…" },
  "chains": [
    { "chainId": 84532, "issuanceConfigured": true, "verificationConfigured": true, "state": "ready" }
  ],
  "unverifiableChainIds": []
}
```

A non-empty `unverifiableChainIds` is the trap state, and the backend also logs
one warning at boot naming the chain. Both are silent when the deployment is
`ready`, `unconfigured`, or `verification_only` — a warning that fires when
things are fine is a warning people scroll past.

## Smoke check

Two curls, and they must be run in this order: the first proves an issuer exists
to pin, the second proves a **real anchored passport** verifies against it.
`#974`'s tests passing is not the same evidence — they have never answered for a
UID that exists on-chain.

```bash
API=https://havenbackend-dev-8b95.up.railway.app

# 1. The issuer merchants pin. 503 here means the key is not set (or not picked
#    up — restart the service).
curl -s "$API/passport/issuer" | jq
# → { "issuer": "0x…", "version": …, "receipt_ttl_seconds": …,
#     "signature_scheme": "eip191-personal-sign-over-canonical-json" }

# 2. A signed receipt for a passport that is actually anchored. Use a UID from
#    an agent this deployment issued — `agent_passports.attestation_uid`, or the
#    `attestation_uid` on an erc7710 settle response.
curl -s "$API/passport/verify?uid=0x…" | jq
# → { "found": true,
#     "receipt": { "issuer": "0x…", "standing": "active", "evidenceUid": "0x…", … },
#     "signature": "0x…" }
```

Both must succeed. Reading them:

- **503 on either** — `PASSPORT_RECEIPT_SIGNING_KEY` is unset. The endpoint fails
  closed rather than serving an unsigned receipt, because an unsigned "receipt"
  is indistinguishable from a forged one to anything that does not carefully
  check for a missing field.
- **`found: false` with HTTP 200** — a normal answer, not an error: issuance is
  opt-in and most agents have no passport. It means you picked a UID this
  deployment does not hold, not that verification is broken. Re-run with a UID
  from *this* environment's database.
- **`issuer` differs from what a merchant pinned** — the key was rotated.
  Merchants pinning the old address will reject every receipt until they re-pin;
  treat rotation as a breaking change, not an operational tweak.

You can verify a receipt offline exactly as a merchant would, with
`verifyReceipt` from `modules/passport` — a verification path only Haven can
execute proves nothing.

## Related

- [L0 Agent Passport — EAS schema](../architecture/11-agent-passport-schema.md) —
  schema registration, the issuance half, and why `verify_url` is a convenience
  rather than a root of trust.
- [Agent Passport (product)](../product/agent-passport.md) — what the passport
  claims, and why *revocable* is the load-bearing word.
- [Dev environment](dev-environment.md) — where the dev backend's env vars live.
