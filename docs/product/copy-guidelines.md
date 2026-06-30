---
owner: "@d-hinders"
status: current
covers:
  - docs/product/README.md
  - docs/regulatory/casp-risk-guardrails.md
  - packages/frontend/src/app/page.tsx
  - packages/frontend/src/app/how-it-works/**
  - packages/frontend/src/app/protocols/**
  - packages/frontend/src/app/onboarding/**
  - packages/frontend/src/components/ConnectAgent2Modal.tsx
  - packages/frontend/src/components/UsingYourAgentInfo.tsx
  - packages/frontend/src/components/haven/HostedConnectCard.tsx
  - packages/frontend/src/lib/agent-credential.ts
  - packages/frontend/src/lib/agent-handoff.ts
  - packages/frontend/src/lib/chains.ts
  - packages/frontend/src/lib/hosted-connect.ts
  - packages/frontend/src/lib/passkey.ts
  - packages/frontend/src/lib/signer.ts
last-verified: "2026-06-29"
---

# Haven UX Copy Guidelines

Haven’s UX copy should make agentic stablecoin payments feel simple, safe, and approachable. The product is built on advanced crypto infrastructure, but the user-facing language should focus on what the user is doing, what they control, and what happens next.

## Core principle

Write for users first, not for the protocol.

Avoid exposing implementation details unless they are necessary for trust, transparency, or advanced users. Haven can use Safe, passkeys, smart accounts, modules, spending policies, and relayers under the hood, but most onboarding and product copy should describe the user-facing outcome.

For payment execution, agent authority, Safe setup, relaying, SDK payment APIs,
x402/MPP, merchant, fiat/card, swap, yield, treasury, reporting/accounting, tax,
or advice copy, also apply `docs/regulatory/casp-risk-guardrails.md`. Product
copy must not imply that Haven holds funds, controls keys, transfers money on
the user's behalf, manages a portfolio, makes accounting or tax judgments, acts
as a payment processor, or gives agents unrestricted wallet access.

Good:
- “Your Haven account is ready”
- “Create a secure passkey”
- “Set agent rules”
- “Add funds”
- “Approve actions in your Haven account”

Avoid:
- “Safe deployed”
- “Enroll signer”
- “Passkey-backed signer”
- “Relayer”
- “Metadata”
- “Deploy smart account”
- “Owner type”
- “Haven holds your funds”
- “Haven manages your wallet”
- “Haven transfers money for you”
- “Haven executes payments on your behalf”
- “Haven is your payment processor”
- “Haven gave you the private key”
- “Haven signs and settles the payment”
- “Haven signs from your account”
- “Haven signed the transfer”

Say who actually authorizes the action: a user-held or agent-held key signs,
while Haven may validate and relay the signed request. An API key identifies the
agent but cannot authorize a payment by itself.

## Tone

The tone should be:

- Clear
- Calm
- Confident
- Minimal
- Trust-building
- Slightly product-led, but not hype-driven

Haven should feel like modern fintech infrastructure for agentic payments, not like a crypto developer tool.

Use plain English. Prefer short sentences. Avoid overly technical nouns. Avoid explaining everything at once.

## Preferred language patterns

### Use “Haven account” for the main user-facing object

Prefer:
- “Create your Haven account”
- “Your Haven account is ready”
- “Approve actions in your Haven account”

Avoid leading with:
- “Safe account”
- “Smart account”
- “Smart wallet”
- “Safe smart account”

Safe can be shown later in account details, transaction details, advanced settings, or developer-facing documentation.

### Use “Haven wallet” for where the user's treasury funds are held

Prefer:
- “Create your Haven wallet”
- “Add funds to your Haven wallet”
- “This is where you hold the funds available to your agent rules”

Avoid:
- “Deploy your Safe”
- “Create a smart contract wallet”
- “Deploy smart wallet”

### Use “sign in” and “approve actions” instead of “signer” or “owner”

Prefer:
- “Choose how you sign in”
- “Choose how you want to approve actions”
- “Create a secure passkey to approve actions in your Haven account”

Avoid:
- “Choose owner type”
- “Pick the signer”
- “Signer metadata”
- “Passkey-backed signer as owner”

The user does not need to understand ownership architecture during onboarding.

### Use “passkey” but anchor it in familiar actions

It is okay to mention passkeys. Say “passkey” first, then connect it to familiar
examples such as Face ID, Touch ID, Windows Hello, or a device PIN.

Preferred:
- “Use a passkey”
- “Approve with Face ID, Touch ID, Windows Hello, or your device PIN”
- “Create a secure passkey to approve actions in your Haven account”
- “Fastest option. Creates a secure passkey.”
- “Continue with a passkey”

Avoid:
- “Create a passkey for this browser”
- “Enroll passkey signer”
- “Passkey-backed signer”
- “WebAuthn credential”

Do not promise that a passkey is either synced across devices or restricted to
one device. Haven currently relies on local browser enrollment metadata before
offering passkey approval. When approval is unavailable, state which enrolled
device or browser the user should return to and give a concrete recovery action.

### Use “agent rules” or “agent budgets” instead of “spending policies”

Preferred:
- “Set agent rules”
- “Create agent budgets”
- “Choose how much an agent can spend, who it can pay, and what it can pay for”
- “Payment requests made through Haven are checked against the rules you set”

Avoid:
- “Spending policies”
- “Policy engine”
- “Allowance module”
- “Session key permissions”

“Spending policies” can be used in more advanced contexts, but onboarding and landing pages should prefer “rules” or “budgets”.

### Separate authentication from payment signing

“Haven credential” or “Haven setup” may describe the complete agent handoff, but
do not present it as one secret with payment authority. The setup can contain
two distinct credentials:

- The API key identifies the agent to Haven. It cannot authorize a payment by
  itself.
- The private signing key authorizes payments locally and stays with the user or
  agent runtime. Haven's backend must never receive it.

Preferred:
- “Connect your agent”
- “Add your Haven setup to Claude Code, Codex, or your own agent”
- “The API key identifies your agent but cannot spend by itself”
- “The private signing key stays with your agent runtime”
- “Haven checks the agent's payment requests against your rules”

Avoid:
- “Generate credentials”
- “Hand the credential to your agent”
- “Drop the credential into your agent”
- “The API key can make payments”
- “The Haven credential signs payments”
- “Haven generated/gave you the private key”

In advanced setup, recovery, and x402 copy, disclose that the private signing key
controls any funds already held in the agent wallet. Pausing or revoking Safe
funding does not recover that balance; present sweep or recovery as a separate
action where relevant.

## Copy examples

### Onboarding: choosing sign-in method

Preferred:

```text
Choose your network and approval method

Select where to create your account, then choose how you want to approve actions.

Network
Base

Use a passkey
Fastest option. Creates a secure passkey.

Connect a wallet instead
Use an existing crypto wallet.
```

Alternative:

```text
Set up your Haven account

Choose a network, then pick how you want to access your account.

Network
Base

Use a passkey
Fastest option. Creates a secure passkey.

Connect a wallet instead
Use an existing crypto wallet.
```

### Onboarding: passkey creation screen

Preferred:

```text
Use a passkey

Create a secure passkey to approve actions in your Haven account.

Continue with a passkey
```

Avoid:

```text
Create a passkey for this browser, enroll it with Haven, and deploy a Safe that uses that passkey-backed signer as its owner.
```

### Onboarding: successful setup

Preferred:

```text
You're in

Your Haven account is live on Base. Add funds, set agent budgets, and you're ready to pay.

Account address
0x...

Setup transaction
0x...

Go to Dashboard
```

Avoid:

```text
Safe deployed

Your non-custodial smart account is live on Base.
```

### Passkey deployment progress

Preferred step labels:

```text
Creating your passkey
Saving it to your account
Bringing your account online
Tying it to Haven
```

Preferred helper text:

```text
Approve your device's passkey prompt.

Saving your approval method to your Haven account.

Creating your on-chain Haven account.

Linking your on-chain account to your Haven profile.
```

Avoid:

```text
Enrolling signer
Deploying Safe
Registering with Haven
Saving your signer metadata to Haven.
Haven is asking the relayer to deploy your Safe.
```

### How it works page

Preferred:

```text
01 — Create your Haven account
Sign up with your email. No credit card and no setup call needed.

02 — Choose how you sign in
Use a passkey or connect your wallet. Either way, you stay in control of your account.

03 — Set up your Haven wallet
We create your Haven wallet in the background. This is where you hold your main funds and set what agents can request.

04 — Add funds
Add a supported token such as USDC on your selected network to start making payments.

05 — Set agent rules
Choose how much an agent can spend, who it can pay, and what it can pay for.

06 — Connect your agent
Add your Haven setup to Claude Code, Codex, or your own agent. Haven checks its payment requests against the rules you set.
```

## Technical term mapping

Use this mapping when replacing technical language with product-facing language.

| Technical/internal term | User-facing term |
| --- | --- |
| Safe | Haven account / Haven wallet |
| Safe deployed | Your Haven account is ready |
| Smart account | Haven account |
| Smart wallet | Haven wallet |
| Signer | Sign-in method / approval method |
| Owner | Control / approve actions |
| Owner type | Sign-in method |
| Passkey signer | Secure passkey |
| Enroll signer | Save your sign-in method |
| Relayer | Avoid mentioning |
| Metadata | Avoid mentioning |
| Deploy | Create / set up |
| Spending policy | Agent rule / agent budget |
| Allowance module | Rules / budget controls |
| API key | Agent identity / API key; never payment authority |
| Delegate private key / session key | Private signing key (advanced setup and recovery copy) |
| Complete credential bundle | Haven setup / Haven credential |
| Transaction hash during onboarding | Setup transaction |
| Transaction hash in advanced or transaction detail | Transaction ID / explorer link |
| Safe address in primary account UI | Account address / Haven wallet address |
| Agent delegate address | Agent wallet address (advanced and recovery copy) |
| Connected or recipient wallet address | Wallet address when the control or destination distinction matters |

## Writing rules

1. Lead with the user outcome, not the infrastructure.
2. Keep headlines short and action-oriented.
3. Use one idea per sentence.
4. Explain control and safety in plain language.
5. Avoid crypto jargon in onboarding unless it is necessary.
6. Use “Haven account” and “Haven wallet” consistently.
7. Mention passkeys first, then use the user's biometric or device PIN as a familiar example.
8. Use “rules” and “budgets” for agent spending controls.
9. Keep advanced details available, but not central.
10. Prefer confidence over over-explanation.

## Money and authority copy

For payments, budgets, approvals, revocation, recovery, and sweeps, make the
relevant facts explicit:

- Who or which agent is acting.
- Which Haven wallet and network are involved.
- The amount and asset.
- The recipient, merchant, or allowed scope.
- Which rule applies and whether user approval is required.
- What has already happened and what happens next.
- How the user can reject, pause, revoke, stop, recover, or sweep funds.

Do not imply that every agent payment requires user approval. Distinguish
automatic requests within the Haven flow from actions that are waiting for the
user. Likewise, do not say an agent “can only pay within your limits” without
scoping the claim: Safe-originated funding is constrained by the user's
on-chain rules, while a private signing key can separately control funds already
held in the agent wallet.

## Product positioning in copy

Haven should communicate three things consistently:

### 1. Users stay in control

Examples:
- “You approve actions.”
- “You set the rules.”
- “Haven checks agent payment requests against your rules.”

### 2. Agent payments follow explicit rules

Examples:
- “Set an agent budget.”
- “Choose who it can pay.”
- “Safe funding stays within the on-chain rules you set.”

### 3. Setup should feel simple

Examples:
- “Use a passkey — no wallet extension needed.”
- “Create a secure passkey.”
- “Your account is ready.”
- “Add funds and start making payments.”

The overall copy should make Haven feel like a safe, modern, agent-native finance product, not a crypto wallet setup flow.

## Known implementation copy gaps

The following shipped strings do not meet this guide and are not approved
precedents:

- The homepage, `UsingYourAgentInfo.tsx`, and the protocol marketing pages use
  absolute rules/credential claims or say or imply that Haven gives users a
  private key or signs and settles payments.
- `PasskeyEnrollFlow.tsx` says the passkey private key is usable only on the
  current device, which overstates what WebAuthn guarantees.
- The How it works page advertises EURe even though current account creation
  offers Base and Base Sepolia, where USDC is the payment-token example.

Correct these in product-copy changes; do not weaken this guide to match them.
