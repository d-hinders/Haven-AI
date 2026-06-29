---
owner: "@d-hinders"
status: current
covers: []  # narrative — no direct code mirror
last-verified: "2026-06-28"
---

# Haven UX Copy Guidelines

Haven’s UX copy should make agentic stablecoin payments feel simple, safe, and approachable. The product is built on advanced crypto infrastructure, but the user-facing language should focus on what the user is doing, what they control, and what happens next.

## Core principle

Write for users first, not for the protocol.

Avoid exposing implementation details unless they are necessary for trust, transparency, or advanced users. Haven can use Safe, passkeys, smart accounts, modules, spending policies, and relayers under the hood, but most onboarding and product copy should describe the user-facing outcome.

For payment execution, agent authority, Safe setup, relaying, SDK payment APIs, x402/MPP, merchant, fiat/card, swap, yield, or advice copy, also apply `docs/regulatory/casp-risk-guardrails.md`. Product copy must not imply that Haven holds funds, controls keys, transfers money on the user's behalf, manages a portfolio, acts as a payment processor, or gives agents unrestricted wallet access.

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
- “Haven is your payment processor”

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

### Use “Haven wallet” when referring to where funds are held

Prefer:
- “Create your Haven wallet”
- “Add funds to your Haven wallet”
- “This is where you hold the funds your agents can spend”

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

It is okay to mention passkeys, but connect them to Face ID / Touch ID and the user benefit.

Preferred:
- “Use Face ID / Touch ID”
- “Create a secure passkey to approve actions in your Haven account”
- “Fastest option. Creates a secure passkey.”
- “Continue with Face ID / Touch ID”

Avoid:
- “Create a passkey for this browser”
- “Enroll passkey signer”
- “Passkey-backed signer”
- “WebAuthn credential”

Do not over-explain device/browser limitations unless necessary. Most users will use synced passkeys through Apple Passwords or Google Password Manager, so avoid copy that implies the passkey only works on one device.

### Use “agent rules” or “agent budgets” instead of “spending policies”

Preferred:
- “Set agent rules”
- “Create agent budgets”
- “Choose how much an agent can spend, who it can pay, and what it can pay for”
- “It can now make payments within the rules you set”

Avoid:
- “Spending policies”
- “Policy engine”
- “Allowance module”
- “Session key permissions”

“Spending policies” can be used in more advanced contexts, but onboarding and landing pages should prefer “rules” or “budgets”.

### Use “credential” carefully

“Credential” is acceptable when describing what is given to an agent, but avoid making it sound overly technical.

Preferred:
- “Add your Haven credential to Claude, GPT, or your own agent”
- “Connect your agent”
- “Your agent can now make payments within your rules”

Avoid:
- “Generate credentials”
- “Hand the credential to your agent”
- “Drop the credential into your agent”

## Copy examples

### Onboarding: choosing sign-in method

Preferred:

```text
Choose your network and sign-in method

Select where to create your account, then choose how you want to approve actions.

Network
Base

Use Face ID / Touch ID
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

Use Face ID / Touch ID
Fastest option. Creates a secure passkey.

Connect a wallet instead
Use an existing crypto wallet.
```

### Onboarding: passkey creation screen

Preferred:

```text
Use Face ID or Touch ID

Create a secure passkey to approve actions in your Haven account.

Continue with Face ID / Touch ID
```

Avoid:

```text
Create a passkey for this browser, enroll it with Haven, and deploy a Safe that uses that passkey-backed signer as its owner.
```

### Onboarding: successful setup

Preferred:

```text
Your Haven account is ready

Your account is live on Base. You can now add funds, create agent budgets, and start making payments.

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
Creating passkey
Preparing your account
Creating your Haven wallet
Finishing setup
```

Preferred helper text:

```text
Approve the prompt to create your secure passkey.

Saving your sign-in method to your Haven account.

Creating your Haven wallet.

Linking your wallet to your Haven account.
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
Use Face ID / Touch ID or connect your wallet. Either way, you stay in control of your account.

03 — Set up your Haven wallet
We create your Haven wallet in the background. This is where you hold the funds your agents can spend.

04 — Add funds
Add USDC, EURe, or another supported token to start making payments.

05 — Set agent rules
Choose how much an agent can spend, who it can pay, and what it can pay for.

06 — Connect your agent
Add your Haven credential to Claude, GPT, or your own agent. It can now make payments within the rules you set.
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
| Session key | Agent credential / Haven credential |
| Transaction hash | Setup transaction |
| Wallet address / Safe address | Account address |

## Writing rules

1. Lead with the user outcome, not the infrastructure.
2. Keep headlines short and action-oriented.
3. Use one idea per sentence.
4. Explain control and safety in plain language.
5. Avoid crypto jargon in onboarding unless it is necessary.
6. Use “Haven account” and “Haven wallet” consistently.
7. Mention passkeys, but connect them to Face ID / Touch ID.
8. Use “rules” and “budgets” for agent spending controls.
9. Keep advanced details available, but not central.
10. Prefer confidence over over-explanation.

## Product positioning in copy

Haven should communicate three things consistently:

### 1. Users stay in control

Examples:
- “You approve actions.”
- “You set the rules.”
- “Your agent can only pay within your limits.”

### 2. Agents can pay, but only with limits

Examples:
- “Set how much an agent can spend.”
- “Choose who it can pay.”
- “Payments stay within the rules you set.”

### 3. Setup should feel simple

Examples:
- “No wallet extension needed.”
- “Create a secure passkey.”
- “Your account is ready.”
- “Add funds and start making payments.”

The overall copy should make Haven feel like a safe, modern, agent-native finance product, not a crypto wallet setup flow.
