---
owner: "@d-hinders"
status: current
covers:
  - packages/frontend/public/exit/index.html
  - packages/frontend/public/exit/exit-core.mjs
  - packages/frontend/src/lib/passkey.ts
  - packages/backend/scripts/exit-acceptance-proof.ts
last-verified: "2026-07-12"
---

# Your exit path — inspect and revoke agent budgets without Haven

This is Haven's non-custody guarantee made operational (#832, epic #821): a
person holding only their account credentials can **inspect and revoke every
agent budget on their account, and keep control of the account itself, without
Haven's website, servers, or support.** The self-hosted [exit page](../../packages/frontend/public/exit/index.html)
is a convenience wrapper; THIS document is the guarantee, and it needs nothing
but a block explorer and a wallet.

## What an "agent budget" is on-chain

A budget is a **delegation**: a signed message your account (the *delegator*)
issued, letting an agent spend within audited *caveat enforcers* (a period
budget, a recipient pin, an expiry). It is redeemed through MetaMask's
**DelegationManager** contract. Revoking one is an operation your account signs
(details in §2) — Haven cannot block it and is not involved.

## Pinned contracts (verify these)

| Chain | DelegationManager |
|---|---|
| Base (8453) | `0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3` |
| Base Sepolia (84532) | `0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3` |

These are the audited MetaMask deployments (Consensys Diligence, 2024/2025) and
match Haven's `packages/backend/src/rails/delegation-contracts.ts`. If an address
you are asked to interact with differs from this, stop.

## Manual path (explorer only — the guarantee)

### 1. Inspect: is a budget still active?

Every delegation has a 32-byte **delegation hash** (its identity). On the
DelegationManager, call the read function:

```
disabledDelegations(bytes32 delegationHash) → bool
```

`false` = still spendable; `true` = already revoked. Haven shows you each
budget's hash in the dashboard and in the delegation object it hands your
agent, but you never need Haven to read this — the contract answers directly.

To DISCOVER budgets without Haven, scan the manager's public events for your
account:

```
event RedeemedDelegation(address indexed rootDelegator, address indexed redeemer, Delegation delegation)
```

filtered on `rootDelegator = your account address`. Each event carries the full
delegation object, so any that has ever been used is discoverable and
decodable by anyone — no Haven decoding needed.

### 2. Revoke: stop a budget

`disableDelegation` is a **delegator-ACCOUNT operation** — the DelegationManager
requires `msg.sender == delegation.delegator`. Your Hybrid account is the
delegator, and a Hybrid is an ERC-4337 account, so the call runs as a **UserOp
your account's owner signs**, submitted through the EntryPoint — a bare wallet
call to the manager reverts. Two backend-independent ways to do it:

**a. Owner-signed UserOp.** Build a UserOp whose call is
`account.execute(disableDelegation(delegation))`, sign it with your owner key
(an EOA owner signs EIP-712 typed data over the packed UserOp — domain
`HybridDeleGator`; a **passkey account** signs the userOpHash with a WebAuthn
assertion from an enrolled passkey), and submit it via the EntryPoint. You can submit through any
public bundler, or call `EntryPoint.handleOps([userOp], you)` directly from any
EOA and pay the gas yourself — neither involves Haven. `disableDelegation` takes
the `Delegation` tuple:

```
(address delegate, address delegator, bytes32 authority,
 (address enforcer, bytes terms, bytes args)[] caveats,
 uint256 salt, bytes signature)
```

paste the object Haven gave you or the one decoded from a RedeemedDelegation
event. After it confirms, `disabledDelegations(hash)` reads `true` and any
further redemption reverts.

**b. The universal backstop (no UserOp tooling).** Your account's own signers
can rotate/remove the delegate key or move funds to a fresh account at any
time. This ends every budget without needing to revoke each one individually,
and needs nothing but your wallet and the account's standard owner operations.

**Passkey-only owners: a passkey works only on the site it was created on.**
WebAuthn binds a passkey to its relying party, and Haven's passkeys use the
Haven site's hostname as that relying party
(`packages/frontend/src/lib/passkey.ts`, `getDefaultRpId`). A browser offers
the passkey only on that site, so an owner whose **only** signer is a passkey
can produce the owner signature for 2a only through Haven's site — and not at
all if that site is gone. To keep a signer that works without Haven, add a
wallet to the account (**Add a wallet**, in the **Security & details** tab on
your account page; see [account recovery](../product/account-recovery.md)). A
wallet signs the UserOp from anywhere.

*Live-verified (2026-07-11) via `pilot:exit-proof` on Base Sepolia: enumerate →
owner-signed disableDelegation → redemption then reverts. tx links in the
epic #832 / DoD record.*

### 3. Why the guarantee is unconditional

- **You can revoke any delegation you can reconstruct** — `disableDelegation`
  needs only the object, not Haven's cooperation or prior on-chain use.
- **Your account's own signers always win** — they can rotate/remove keys and
  move funds directly, regardless of any delegation (§2b). In the worst case,
  moving funds to a fresh account ends every budget at once.

## Honest limitation

A delegation Haven issued but that has **never been redeemed** is an off-chain
object — no third party can *discover* it until first use (there is no on-chain
record yet). This does not weaken the guarantee: discovery is not required for
revocation (the backstop above), and Haven surfaces the full list to you in the
dashboard while it is your provider. The limitation is about *third-party
discoverability of unused grants*, not about your control.

## The exit page

[`packages/frontend/public/exit/index.html`](../../packages/frontend/public/exit/index.html)
works on Base (8453, the default) and Base Sepolia (84532). It discovers your
budgets via public events, shows each one's **delegation hash** and its
**status** read from `disabledDelegations(hash)` (*not revoked*, *revoked*, or
*status unknown* when the read fails), and surfaces the exact delegation object,
hash and `disableDelegation` calldata you need to revoke (§2). Paste a delegation
to check one the scan did not find.

It talks only to an RPC and the pinned manager — **no Haven backend**. Its logic
is in [`exit-core.mjs`](../../packages/frontend/public/exit/exit-core.mjs), which
computes the hash the way the DelegationManager does (checked against the
contract's own `getDelegationHash` and against the `hashDelegation` Haven's
backend uses), and ethers is vendored next to it, so the page loads no
third-party script. It is statically hostable anywhere and works if Haven is gone.
Revocation itself is the account operation in §2 (the page does not embed a
UserOp signer); the guarantee is identical to the manual path.

**Discovery and public RPCs.** The public Base endpoints the page uses by default
cap `eth_getLogs` at a few hundred blocks per query (measured 2026-10-24:
`sepolia.base.org` answers "limited to a 200 range"; `mainnet.base.org` also
rate-limits). The page scans from the manager's first block in chunks of the
size the RPC names and stops after a few hundred queries, telling you how far
it got. For a full scan, enter an RPC that allows wider log queries or a later
"from block", use the manager's event log on the explorer, or paste the
delegation to check it by hash — the status read is a single call that any RPC
answers.
