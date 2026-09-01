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
  - packages/frontend/src/components/ConnectAgentModal.tsx
  - packages/frontend/src/components/UsingYourAgentInfo.tsx
  - packages/frontend/src/lib/agent-credential.ts
  - packages/frontend/src/lib/agent-handoff.ts
  - packages/frontend/src/lib/chains.ts
  - packages/frontend/src/lib/passkey.ts
  - packages/frontend/src/lib/signer.ts
last-verified: "2026-09-01" # #2313-followup: corrects the shipped #2313 entry below rather than rewriting it — that entry reached `dev` in PR #2336, so per this doc's own #2131 -> #2145 precedent it is kept VERBATIM as the historical record and superseded here. One correction: it said the nine `payment receipt` hits under `packages/` were "prose, a comment or an OpenAPI description, none a shipped label", while the next sentence called the underlag PDF title "the one string that IS still shipped". Both are true and the unqualified word was not: the underlag title IS shipped, it is simply not a **UI label**, which is the claim the bullet tests. Re-verified for this correction: the counts still reproduce (203 files for `receipt`, 9 for `payment receipt`, `/usr/bin/grep -rlI -i <term> packages/`) and all nine were re-read and re-categorised by hand. NOT re-verified here: the § Enforcement scope bullet from #2317 immediately above, the gap bullets other than the receipt one, the terminology mapping, the tone/structure sections, the Swedish guidance, or this doc's `covers:` files. Prior: #2317: the § Enforcement section gains the scope bullet this doc could not previously state truthfully — `npm run lint:copy` scanned `app/` + `components/` ONLY, so `packages/frontend/src/lib/agent-skill-bundle.ts` (downloaded verbatim as `SKILL.md` from the connect-agent success screen) was never read by the required *Banned product-copy terms* check, and PR #2311 added six lines of new prose there under a green check that had looked at none of it. The script now carries a `SCAN_FILES` allowlist of five prose-bearing files outside those directories. Checked rather than assumed: all five are clean against the full `BANNED` list today (0 findings), and every entry was proven able to FAIL by mutation, exit code as the signal — the pre-change script scored exit 0 on the same mutated tree. Scope: the § Enforcement section only. NOT re-verified: the terminology mapping table, the copy-gap bullets, the tone/structure sections, the Swedish guidance, or this doc's other `covers:` files. Prior: #2313: the third "Known implementation copy gaps" bullet claimed "the approval and send surfaces label it `Payment receipt`". Those surfaces were deleted by #1989 and the label survives on NO surface — checked case-insensitively over `packages/` (the scope the sentence names, not `packages/frontend`), against a control that returns 203 files for `receipt` and 9 for `payment receipt` (`/usr/bin/grep -rlI -i <term> packages/`, node_modules excluded): every one of those 9 is prose, a comment or an OpenAPI description, none a shipped label. Both reviewers caught the first version of this note quoting **186**, which was the `*.ts`-only count written up as if it covered `packages/` — the conclusion held, the evidence sentence did not, which is exactly the scope-mismatch the ship-next rework caps name. The bullet is re-based on the one string that IS still shipped and still wrong, `HAVEN PAYMENT RECEIPT` at `packages/backend/src/modules/reporting/receipt-underlag.ts:91`; `betalningsbevis` re-confirmed absent from the Swedish catalog, and the copy-lint scope caveat re-confirmed unchanged. Scope: that one bullet. NOT re-verified: the other two gap bullets, the terminology mapping, the tone/structure sections, the Swedish guidance, or this doc's `covers:` files. Prior: #2261: the "Known implementation copy gaps" bullet naming `PasskeyEnrollFlow.tsx` ("a private key only this device can use", which overstates what WebAuthn guarantees) is REMOVED, because the file it names is deleted in the same diff — the flow has been unreachable since #1984 (epic #1440) and #2261 deletes it with its suite. A copy gap that outlives its string is worse than no entry: it sends the next reader looking for a file that is not there, and it inflates the list this doc asks contributors to shrink. Checked before removing rather than assumed: the offending claim existed ONLY at `PasskeyEnrollFlow.tsx:79`; the surviving onboarding flow, `HybridEnrollFlow.tsx`, makes no device-scoping claim at all, so nothing live loses its entry. The § "Passkey deployment progress" heading is a SECOND, worse instance of the same staleness and is re-based rather than left: its "Preferred" block prescribed the four step labels and four helper lines of the deleted `PasskeyEnrollFlow` (measured — five of its six quoted strings now exist nowhere under `packages/`), so the doc was standardising a progress sequence no surface implements. Rewritten against `HybridEnrollFlow.tsx`, which has two waiting states, and renamed to "Account-creation progress" (no inbound link to the old anchor). A removed gap bullet only mis-points a reader; a stale Preferred block tells the next contributor to build the retired shape. Found by haven-doc-reviewer. Scope: that bullet and that section. The other three gap bullets, the terminology mapping, the tone and structure sections and the Swedish guidance were NOT re-verified in this pass. Prior: #2145: the same `agent-handoff.ts` x402 paragraph #2131 rewrote is rewritten AGAIN, because the premise inverted — the backend now emits `retry_original_x402_request` (server-derived funded-but-undelivered on the eip3009 bridge), so the paragraph tells the agent to gate resume on that value instead of claiming no signal exists. Checked against this doc rather than assumed: no banned phrase, and the new wording does not breach the #2063 decline-is-never-pending rule — it describes a crash-recovery signal for a payment that already spent, not a decline described as waiting. The #2131 entry below is now a historical record of the interim state, kept verbatim. Scope: that one paragraph in one covered file; nothing else re-verified. Prior: #2131: `packages/frontend/src/lib/agent-handoff.ts` is a `covers:` file and its COPY changed — the x402 paragraph told a user's agent to "send the merchant x402 payment header only when Haven reports `next_action: "retry_original_x402_request"`", a value nothing emits, so the condition could never be met. Replaced with the fact that the pay helpers perform the merchant retry themselves. Checked against this doc rather than assumed: no banned phrase, and the new wording REINFORCES the #2063 rule that a decline must never be described as pending, queued or waiting — "there is no resume signal to wait for" is that rule applied to a signal rather than a decline. The sibling artifact `agent-skill-bundle.ts` changed identically but is deliberately NOT in this doc's `covers:`, correctly: its canonical copy lives in `packages/sdk/src/skill-content.ts` and a parity test enforces byte-identity, so it is not a separate copy surface. Scope: that one paragraph in one covered file. NOT re-verified: the rest of this doc's guidance, its other covered files, or the banned-term list. Bumped rather than left silent on `haven-design-reviewer`'s correction — I had argued a date overclaims when only the intersection was checked, and this chain's own prior entries (#1991, #2063, #2097) show the convention is to bump WITH a scoped note, which is what a narrow check is supposed to look like here. Prior: #2097: files this doc `covers:` by exact path were re-verified — `docs/product/README.md` and `docs/product/design-review.md` both record (or point to) the initiator-semantics rule; the copy guidance itself is unchanged — `Payment sent by you` remains in the allowed product voice, now explicitly human-initiated-only per the transaction-history invariant. Scope: those covered-file relationships only. Prior: #1991: the two Safe-funding-framed lines (the limit-claim scoping sentence; positioning example 2) re-based on the delegation rail to match the rewritten guardrails Product Copy Rules — pre-existing drift surfaced by the #1991 coupling review; only those two lines changed. Prior: #2063: the agent-transparency rule presumed a two-state model ("automatic" vs "waiting for the user") — the second state does not exist for payments on the live rail; restated as declined-before-money-moves, with the one-time budget-grant/revoke signatures named as the only waiting states. ONLY that rule re-read. Prior: #1813: dropped two `covers:` entries pointing at files this change deleted (`haven/HostedConnectCard.tsx`, `lib/hosted-connect.ts`) — both unreachable since #345 retired their call site. A covers entry naming a path that no longer exists silently stops mapping anything, so the doc looks better-covered than it is. No copy RULE here changes; the deleted component's user-facing strings simply no longer exist. Prior: re-verified for #1251 (MPP seam refusal) — no claim here affected
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

### Name credentials “passkey”, never a platform brand ([#1679](https://github.com/d-hinders/Haven-AI/issues/1679))

A platform name is an anchor, never the *name* of a credential. “Face ID /
Touch ID” as a row label is wrong three ways: it inverts the anchor rule above,
it is false on Windows and Android, and any positional variant (“Face ID for
the first key, Backup N for the rest”) silently misnames the surviving key
after a recovery removes the original.

Credential rows (signer lists, “ways to approve”):

- A passkey row is **“Passkey · added {date}”** — the kind plus when it was
  enrolled, e.g. “Passkey · added March 3, 2026”. When a credential has no
  stored date (it predates timestamp exposure), fall back to **“Passkey 1”**,
  “Passkey 2”, … in enrollment order — never to a platform name.
- An EOA row is **“Wallet”** with the address underneath — not “External
  owner”, “signer”, or “owner” (the sign-in rule above already bans those).

Action copy keeps the anchor pattern — passkey first, familiar examples second,
ideally as subtext:

- Button “Add a backup passkey” with subtext “Approve with Face ID, Touch ID,
  Windows Hello, or your device PIN”
- “Create account with a passkey”
- “Waiting for your passkey…” / “The passkey prompt was cancelled.”

Avoid:

- “Face ID / Touch ID” as a row label or credential name
- “Add a backup with Face ID / Touch ID”
- “Waiting for Face ID or Touch ID...”
- “a second Face ID” (say “a backup passkey”)

User-editable credential nicknames are deliberately deferred (#1679) — date +
kind is enough at two or three credentials; revisit if users accumulate more.

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

### Call the reporting attachment a "payment evidence document", not a "receipt"

The document the reporting feed attaches (#498) is generated by Haven from
settlement evidence — it is NOT the merchant's own receipt. Those rarely exist
for agent payments today; when they do, #956 (shipped) attaches the merchant's
own receipt as a **second, separately labelled** document, so the two must never
share a name. Partner feedback (2026-07-16) showed that plain "receipt"/"kvitto"
reads as the merchant's document and overpromises.

Preferred:
- "Payment evidence document" / "betalningsbevis"
- "A verifiable record of the payment, generated by Haven"
- "Underlag" when the audience is Swedish accounting (with the Haven-generated
  framing nearby)

Avoid:
- Bare "receipt" / "kvitto" where it can be read as the merchant's document
- Implying the merchant issued the attachment

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

### Onboarding: the create screen

Onboarding is **one screen and passkey-only** (#1162). There is no sign-in method
to choose, so there is no copy for choosing one — a wallet is something the user
adds to an existing account later (Accounts → Add account, or Backup & recovery),
described in that surface's copy rather than here.

Preferred:

```text
Welcome, Ada

Create your Haven account

Your face or fingerprint approves everything — budgets, agents, changes.
No wallet, no seed phrase, nothing to install.

Network
Base

Create account with a passkey
```

While it runs, the intro becomes the reassurance:

```text
Setting up your account. Stay on this tab — it takes a few seconds.
```

Avoid:

```text
Choose your network and approval method
Pick how you'll approve payments.
Connect a wallet instead — use an existing crypto wallet.
Create a passkey for this browser, enroll it with Haven, and deploy a Safe that uses that passkey-backed signer as its owner.
```

### Onboarding: passkeys are unavailable

Because onboarding is passkey-only, there is no fallback to offer. Say a passkey
is required and name a concrete way forward — never advise an action with no
destination.

Preferred:

```text
This browser can't create a passkey, and Haven needs one. Open Haven in Safari,
Chrome, or Edge on a device with Face ID, Touch ID, Windows Hello, or a device PIN.
```

Avoid:

```text
This browser does not support passkeys. Connect a wallet instead.
```

### Onboarding: successful setup

Success happens **in place** on the create screen and hands off to the dashboard
on its own after a beat — the dashboard's own onboarding checklist is what
orients the user, so this moment stays short. No address or transaction ceremony
here: that detail lives on the account page, where the user can actually act on it.

Preferred:

```text
You're in

Your Haven account is live on Base. Taking you to your dashboard…

Go to dashboard
```

Avoid:

```text
Safe deployed

Your non-custodial smart account is live on Base.
```

### Account-creation progress

The live reference is `app/onboarding/HybridEnrollFlow.tsx`, and since #2261 it
is the only enroll flow. It has **two** waiting states, not four: the four-step
sequence this section used to prescribe belonged to `PasskeyEnrollFlow`, the
Safe-rail flow deleted with the rest of that rail (epic #1440), and no surface
implements it. Do not reintroduce it.

Preferred step labels:

```text
Waiting for your passkey…
Setting up your account…
```

Name what the user is doing or waiting for, and stop there. Onboarding creates a
counterfactual account in one server call, so a longer progress list would be
narrating steps the user cannot distinguish and does not need.

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
| Transaction hash in first-run / account setup copy | Setup transaction |
| Transaction hash in advanced or transaction detail | Transaction ID / explorer link |
| Safe address in primary account UI | Account address / Haven wallet address |
| Agent delegate address | Agent wallet address (advanced and recovery copy) |
| Connected or recipient wallet address | Wallet address when the control or destination distinction matters |

## Enforcement

These guidelines are enforced on frontend copy, not just documented. `npm run lint:copy` (`scripts/frontend-copy-lint.mjs`) scans user-facing source (`packages/frontend/src/app/**` + `components/**`) for the unambiguous **multi-word** banned phrases drawn from this guide and **fails the PR on any new occurrence** (#902). It is deliberately conservative — only multi-word phrases, never bare words like "safe"/"owner"/"deploy" — so false positives stay near zero. Its `BANNED` list is a superset of the mapping table (it also covers e.g. "policy engine", "smart contract wallet", "webauthn credential"), and it does **not** reach `packages/backend/**` or the i18n catalogs under `src/lib/i18n/messages/**` — rules about strings that live there are documentation-only.

- **Prose outside those two directories is scanned only if it is named (#2317).** `src/lib` and `src/hooks` are excluded by directory on purpose — there the banned phrases are legitimate code identifiers, and widening the rule would bury a blocking check in false positives. But a handful of `lib/` files hold nothing but user-facing prose, and for those the gate was green while reading none of them: `agent-skill-bundle.ts` is downloaded verbatim as `SKILL.md` from the connect-agent success screen, and `agent-pause-copy.ts` / `stranded-funds-copy.ts` are single sentences extracted out of `components/` so two surfaces agree (#2195, #2230). Those files, plus `agent-handoff.ts` and the SDK's canonical `packages/sdk/src/skill-content.ts`, are listed individually in the script's `SCAN_FILES` allowlist. **If you add a prose file under `lib/`, the gate will not see it until you add it there** — a green check on a PR that touched only such a file carries no information about it. Entries must resolve to real files; an emptied allowlist or a path matching nothing fails the run rather than passing quietly.

- **Ratcheting baseline.** Existing debt is captured in `packages/frontend/copy-lint-baseline.json` (file → phrase → count); counts may only **shrink**. A new banned term, or growth of an existing count, fails. After cleaning some up, run `npm run lint:copy:update` to tighten the ratchet. Do the same — with reviewer sign-off — for a genuinely intentional addition.
- **Escape hatch.** For a legitimate advanced/developer-facing surface where the technical term is correct, add `// copy-lint-ignore` on the offending line (or the line directly above). Use it sparingly; it is for developer surfaces, not a way around writing good user copy.
- Docs under `docs/product` are separately checked by the Vale `Haven.Terminology` rule (`.vale.ini`). Vale is **advisory** — `level: suggestion`, and the docs workflow runs it `continue-on-error` — so it nudges, it does not block.
- Where the lint and this guide disagree, **this guide wins**. Known divergence: the lint rewrites "session key(s)" to "agent credential(s)", which pulls copy toward the very framing "Separate authentication from payment signing" warns against; the correct replacement is "private signing key" per the mapping table.

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

Do not imply that any agent payment waits for per-payment user approval:
a payment outside the agent's rules (budget, recipient, expiry) is declined
before any money moves — never describe it as pending, queued, or waiting,
since nothing is held for later approval (#2063). The approvals that DO exist
and may be described as waiting are the owner's one-time budget-grant and
revoke/re-key signatures. Likewise, do not say an agent “can only pay within your limits” without
scoping the claim: account-originated spend is constrained by the budget
delegation the user signed, while a private signing key can separately control
funds already held in the agent wallet.

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
- “Payments stay within the budget you set.”

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
  private key or signs and settles payments. The homepage also says that if a
  credential leaks "your funds stay exactly where they were", which contradicts
  the disclosure required above: a leaked private signing key controls funds
  already held in the agent wallet, and rotation does not recover them.
- The homepage and the How it works page advertise EURe and Gnosis Chain even
  though current account creation offers Base and Base Sepolia, where USDC is
  the payment-token example.
- The "payment evidence document" rule above is not yet reflected in the one
  shipped string that remains: the generated underlag PDF is titled "HAVEN
  PAYMENT RECEIPT" (`packages/backend/src/modules/reporting/receipt-underlag.ts:91`),
  and "betalningsbevis" appears nowhere in the Swedish catalog. The bullet also
  named the approval and send surfaces as labelling it "Payment receipt"; those
  surfaces were deleted with the Safe rail (#1989) and the label survives on no
  surface at all — checked over `packages/` rather than `packages/frontend`,
  case-insensitively, so the claim's scope matches the check's. The rule is
  still unenforced — the remaining drift sits in `packages/backend/**` and the
  i18n catalogs, which the copy lint does not scan.

Correct these in product-copy changes; do not weaken this guide to match them.
