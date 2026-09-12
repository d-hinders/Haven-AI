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
  - packages/frontend/src/app/login/page.tsx
  - packages/frontend/src/app/signup/page.tsx
  - packages/frontend/src/components/onboarding/AgentHandoffNote.tsx
  - packages/frontend/src/components/ConnectAgentModal.tsx
  - packages/frontend/src/components/UsingYourAgentInfo.tsx
  - packages/frontend/src/lib/agent-credential.ts
  - packages/frontend/src/lib/agent-handoff.ts
  - packages/frontend/src/lib/chains.ts
  - packages/frontend/src/lib/passkey.ts
  - packages/frontend/src/lib/passkeyLabels.ts
  - packages/frontend/src/lib/signer.ts
  - packages/frontend/src/lib/transaction-labels.ts
  - packages/frontend/src/lib/transaction-presentation.tsx
  - packages/sdk/src/skill-content.ts
  - packages/sdk/src/agent-guidance.ts
  - packages/frontend/src/lib/agent-onboarding-prompt.ts
  - scripts/frontend-copy-lint.mjs
  - scripts/lib/ratchet.mjs
last-verified: "2026-09-09"
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
- “the amount Haven authorizes for that call”

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

### Call the accounting attachment a "payment evidence document", not a "receipt"

The document the accounting feed attaches (#498) is generated by Haven from
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

### Never claim the books are done ([#491](https://github.com/d-hinders/Haven-AI/issues/491), enforced by the copy gate since [#2859](https://github.com/d-hinders/Haven-AI/issues/2859))

The accounting feed is **non-asserting**: Haven delivers the payment and its
evidence into the user's accounting platform as an unbooked object, and the
accountant codes and books it. Haven asserts no VAT, no accounts and no rows.
Copy must not promise the outcome.

- Avoid: "audit-ready", "audit ready", "your books are done", "we do your books"
- Prefer: what actually happens — "the payment appears in Fortnox with its
  evidence attached", "your accountant books it"

`scripts/frontend-copy-lint.mjs` bans `audit-ready`, `audit ready` and
`books are done`. The rule predates the gate — it lived only in
`docs/research/accounting-data-feed.md` and the security model — so it was
remembered rather than enforced until #2859 measured zero occurrences across
the scanned set and added all three.

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
controls any funds already held in the agent wallet. For legacy Safe accounts,
Haven no longer offers agent funding or revocation controls. If the owner is a
known wallet, they can manage remaining permissions through Safe's own interface;
for a passkey-only or unknown owner, do not promise that self-serve path. Removing
a funding permission does not recover an agent-wallet balance, so present sweep or
recovery as a separate action where relevant.

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

### Speaking to an agent that cannot finish the step ([#2524](https://github.com/d-hinders/Haven-AI/issues/2524))

Signup, login and the passkey step are where an AI agent driving a browser
stops, and each of them stops it for the same reason: the password and the
passkey belong to the human. The answer is never "try again" and never a
capability the agent could acquire — it is a **hand-off**: name what you cannot
do, and give the link to send.

Preferred:

```text
Setting up for someone else, or an AI agent? Your user creates the account and
its passkey themselves — send them this link: <url>. Agents: read
/for-agents.md first.
```

Avoid:

```text
Sign in to continue. / Enable passkeys in your browser settings and try again.
```

Two rules this pattern carries, both of them about not lying to a reader who
will act on the sentence:

- **Never imply the agent can do the human's part.** No "enter their password",
  no "create a passkey for them". The whole point of the line is that it cannot.
- **Only claim "this browser cannot" when it cannot.** A known agent user agent
  on a browser that *does* have WebAuthn gets the hand-off as advice above a
  working button, not a wall — see `AgentPasskeyHandoff`'s two variants.

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
| `x402` / `mpp_demo` as a transaction ROW TITLE | Agent payment / Machine payment — the protocol name belongs on the detail drawer, not the row people scan (#2357) |
| Connected or recipient wallet address | Wallet address when the control or destination distinction matters |

### Agent-facing vocabulary — one term each ([#2533](https://github.com/d-hinders/Haven-AI/issues/2533))

Four things in the connect flow had two or three names each across the
agent-readable artifacts, the package READMEs and `/how-it-works`. The cold
test found an agent reading "connect command" in `llms.txt`, "connector
command" in `for-agents.md` and "setup command" in the connect README, and
having to decide whether those were one thing or three.

**These are the names. They are not new — they are `for-agents.md`'s own
Vocabulary table, which shipped with the runbook (#2523), promoted to canonical
rather than replaced.** Picking a fresh set would have meant editing the one
artifact that was already self-consistent.

| Thing | The term | Never |
| --- | --- | --- |
| The text the connect modal hands back for ONE agent, carrying its one-time setup token and the connector command | **setup prompt** | connect prompt, setup text |
| The whole-onboarding text the dashboard offers a signed-in user with no agents, carrying no token | **onboarding prompt** | setup prompt (a different object — see below), agent prompt |
| The `npx -y @haven_ai/connect@…` line the agent runs | **connector command** | connect command, setup command, connection command |
| The agent's API key, `sk_agent_…`, written to `~/.haven` | **agent credential** | `sk_live_…` (a different product's shape and never Haven's), agent key, API token |
| The agent's signing key, made locally and never sent anywhere | **delegate key** | signing key (ambiguous — the user also signs), private key |

**The fourth and fifth rows name two different objects, and the fourth's
definition used to cover both ([#2535](https://github.com/d-hinders/Haven-AI/issues/2535)).**
It read "the text the dashboard hands the user to paste to their agent", which
is true of the connect modal's prompt AND of the onboarding prompt #2535 added —
so the table that exists to stop this class of ambiguity had acquired one. The
row is now scoped by what makes the two genuinely different rather than by where
they appear: the **setup prompt** is per-agent, carries a one-time setup token,
and cannot exist until a setup does; the **onboarding prompt** is static, carries
no token or credential (asserted by test, not intended), and is shown precisely
when no agent exists yet. Anything that can be pasted before there is an agent to
paste it for is the onboarding prompt.

Neither row has an instrument. A literal matcher can catch a banned SPELLING,
which is why `connect command` and `setup command` are enforceable; it cannot
catch the two right names being applied to the wrong objects, which is the
failure this pair is actually exposed to.

**Where this is enforced, and where it is only written
([#2576](https://github.com/d-hinders/Haven-AI/issues/2576)).** #2533 swept the
eleven artifacts it named; #2576 swept the rest of the class — the dashboard
connect modal, the connector's own printed strings, the setup prompt's consent
line and the operations docs. The scope caveat that stood here is gone because
the sweep caught up with the table, not because a checker now watches every
surface. Two of the five rows have an instrument; three do not (#2535 added the
fifth, and it has none for the reason given above):

- **`connect command` / `setup command` are blocked** by the frontend copy lint
  (`scripts/frontend-copy-lint.mjs`, `BANNED`), which is a required check. It
  reads `src/app`, `src/components` and the named prose files in `SCAN_FILES`
  — so the connect modal and both copies of the downloadable skill are covered,
  and `src/hooks`, `packages/connect/src`, `packages/backend/src` and every
  `*.test.ts` are **not**: `walk()` skips test files by name and the scan trees
  are frontend-only.
- **`setup prompt`, `agent credential` and `delegate key` have no checker.** A
  literal matcher cannot catch the absence of a term, and the retired spellings
  for those rows (`agent key`, `signing key`, `private key`) have legitimate
  uses in the same files. Human review is the control, as it is for the
  attribution rules below.

Re-derive the class at any head with the command the sweep used, which is
inline so the count can be checked from this page (a count whose scope lives
elsewhere is a count nobody can check — a `haven-reviewer` finding on the #2533
pull request, which reproduced 48/23 against the author's 54/23 under different
exclusions and could not tell drift from curation):

```
grep -rni "setup command\|connect command" \
  packages/frontend/src packages/connect/src packages/cli/src \
  docs/operations docs/architecture .env.example \
  --include=*.ts --include=*.tsx --include=*.md --include=.env.example
```

**Note the `-i` and the `.env.example`.** #2576's issue printed this command
without either, and both omissions hid real sites: three connector-printed
strings in `packages/connect/src/runtime.ts` said "**C**onnect command" with a
capital C, and one operator comment in `.env.example` lives outside every path
the original command listed. A case-sensitive sweep for a term that starts
sentences is a sweep that reports clean while missing every sentence-initial
use — found by `haven-doc-reviewer`, not by the author.

It returned **58 across 24 files** before #2576 (the original case-sensitive
form returned 54 across 23, missing the four sites the note above describes).
After the sweep the same command returns **6**, and every one of the six is a
`last-verified:` front-matter line this sweep itself wrote — an audit note
quoting the retired term in order to say which term was replaced. Filter those
out and the live-copy figure is **0**: append

```
| grep -v ':last-verified:'
```

Both numbers are stated because the first one is what a future reader actually
gets, and a lone "0" here would make them think the sweep had regressed. The
remaining occurrences are historical records, not live product copy.

Positive control: `grep -rn "connector command" packages/frontend/public README.md`
returns 9 both before and after, so the 0 above means the sweep landed rather
than that the command is broken. Note what the command itself cannot see — it
does not read `packages/backend/src`, where the setup prompt's own consent line
lived, or `docs/**` outside those two folders. Dated records keep the old
wording on purpose: the CASP changelog shards, `docs/archive/**` and the
cold-test report are evidence of what was said at the time.

Two boundaries this table does **not** cross:

- **`npx -y @haven_ai/connect@<channel>` stays verbatim** wherever it appears.
  The rule renames the *thing*, never the command (epic #2519 invariant).
- **"Haven credential"** in user-facing copy still means the whole setup bundle
  and keeps its existing row in the mapping table below. It is not a third name
  for the agent credential; the audiences differ, and `/how-it-works` speaks to
  the user while `for-agents.md` speaks to the agent.

The canonical section every published README carries is one exported string,
`AGENT_README_SECTION_MD` in `packages/sdk/src/agent-guidance.ts`, pinned across
all six copies by `packages/sdk/src/agent-guidance.test.ts`. Edit the constant,
never a README copy — the shared-prose rule this epic follows throughout.

## Enforcement

These guidelines are enforced on frontend copy, not just documented. `npm run lint:copy` (`scripts/frontend-copy-lint.mjs`) scans user-facing source (`packages/frontend/src/app/**` + `components/**`) for the unambiguous **multi-word** banned phrases drawn from this guide and **fails the PR on any new occurrence** (#902). It is deliberately conservative — only multi-word phrases, never bare words like "safe"/"owner"/"deploy" — so false positives stay near zero. Its `BANNED` list is a superset of the mapping table (it also covers e.g. "policy engine", "smart contract wallet", "webauthn credential"), and it does **not** reach `packages/backend/**` or the i18n catalog under `src/lib/i18n/messages/**` — rules about strings that live there are documentation-only.

- **Prose outside those two directories is scanned only if it is named (#2317).** `src/lib` and `src/hooks` are excluded by directory on purpose — there the banned phrases are legitimate code identifiers, and widening the rule would bury a blocking check in false positives. But a handful of `lib/` files hold nothing but user-facing prose, and for those the gate was green while reading none of them: `agent-skill-bundle.ts` is downloaded verbatim as `SKILL.md` from the connect-agent success screen, and `agent-pause-copy.ts` / `stranded-funds-copy.ts` are single sentences extracted out of `components/` so two surfaces agree (#2195, #2230). Those files, plus `agent-handoff.ts`, `passkeyLabels.ts`, `transaction-labels.ts` / `transaction-presentation.tsx` (#2333) and the SDK's canonical `packages/sdk/src/skill-content.ts`, are listed individually in the script's `SCAN_FILES` allowlist. **If you add a prose file under `lib/`, the gate will not see it until you add it there** — a green check on a PR that touched only such a file carries no information about it. Entries must resolve to real files; an emptied allowlist or a path matching nothing fails the run rather than passing quietly.

- **Name extracted copy so the gate can ask for it (#2333).** A hand-maintained list nobody is prompted to extend is a slower version of the hole it closes: the #2195/#2230 extraction pattern — pull a shared sentence out of `components/` into `lib/` so two surfaces say one fact identically — takes copy out of scope **every time it is applied**, and #2333 found three more unscanned modules a fortnight after #2317 added four. So the naming is now normative and enforced: **extracted UI copy under `src/lib` is named `*-copy.ts`, `*-labels.ts` or `*Labels.ts`, and any `.tsx` there renders by definition.** A file matching those shapes that is not in `SCAN_FILES` fails the run, naming the file, at the moment it lands — or is exempted in `CONVENTION_EXEMPT` with a written reason. **Its ceiling, stated as a fact:** it matches names, not content, so calling the next extraction `transactionText.ts` still evades it. What it changes is that following the convention is enforced and evading it is deliberate; it is not a content classifier for `src/lib`, and #2332 (`passkey.ts`, a genuine utility carrying a banned phrase in a developer-facing `throw`) is the standing counter-example for why one would be wrong. It is also not a substitute for reading the copy: the first human pass over the newly-scanned files found a real defect the matcher cannot see — bare "delegate" rendered on the primary transaction row (#2356), invisible because the matcher is multi-word-literal by design and "delegate" is a legitimate identifier everywhere else in the frontend.

- **The list also carries five literal attribution phrases (#2334), and they are not terminology.** `haven authorizes` / `authorises` / `approves` / `grants` / `permits` are banned because they invert the § Core principle rule above — they name Haven as the party granting spend authority, when the authority is the owner-signed budget delegation and the cap is enforced on-chain by the account's caveat enforcers. #2334 shipped exactly one of them, in the downloadable `SKILL.md`. **Read what this can do narrowly:** it is a single-line literal match, so it catches a recurrence of these exact formulations and nothing else — reword the same inversion, or let a reflow put "Haven" and "authorizes" on different lines, and it goes green. `scripts/frontend-copy-lint.test.mjs` asserts both evasions on purpose. Attribution is a human-review control; this is the cheap literal floor under it, never evidence that attribution was checked.

- **Nothing checks the skill text against the tool schemas, and that is why #2353 survived (#2353).** The copy lint matches banned *phrases*. It cannot see "this sentence tells an agent to pass an argument the tool does not declare" — which is what `SKILL.md` did to `haven_complete_mcp_tool` for as long as that paragraph existed, on both the auto-installed (`packages/connect`) and downloaded copies. The hosted server stripped the key silently, the call succeeded, and no gate anywhere was looking. A cross-checking guard was **prototyped and rejected**, with the measurement, so nobody re-derives it: attributing backticked argument names to the nearest tool mention over `HAVEN_SKILL_MD` produced **1 true positive and 10 false positives**, all ten misattributions from sentence-spanning segmentation rather than a vocabulary problem. Suppressing them needs a curated allowlist that pins prose *layout*, which is `ship-next` § *Rework caps* rule 1's prose-interpreting guard — the shape that failed four times on #2131. **What replaced it is a cheap literal floor plus review**: `packages/sdk/src/skill-content.test.ts` asserts the corrected sentence's two load-bearing clauses (mutation-proven — restore the old wording and it goes red), and `packages/mcp-server/src/strict-tool-input.test.ts` § `#2353` pins the refusal over the real transport — it began life pinning the strip, and #2353's switch PR (2026-09-03) flipped both the tool and this pin once the corrected copy had shipped to npm. Read that narrowly: neither knows anything about a *different* tool acquiring the same defect. Checking a new agent-facing sentence's argument names against `toolSchemas` is a human-review obligation, and the field-by-field pass belongs in any PR that edits this text.

- **Two of `casp-risk-guardrails.md` § Product Copy Rules' own avoid-list entries are now literals too (#2246), and the reason they were not is the useful part.** `haven signs and settles` and `haven gave you` were added after both shipped live in `components/UsingYourAgentInfo.tsx` — the dashboard's "Show me how" modal — and survived **two** independent findings by hand (#2063's tracker, which closed without fixing them, and #2347's repo-wide attribution sweep, which re-found them a week later). **Measure why before repeating the diagnosis anyone would guess.** That file is not unscanned and not baselined: it sits under `src/components`, inside `SCAN_DIRS`, has no `copy-lint-baseline.json` entry, and `findCopyIssues` over it returned `[]`. The gate was green because **nothing in `BANNED` described the phrases** — #2334's five entries are `haven authorizes|authorises|approves|grants|permits`, and none of them is either of these. Proven by counterfactual rather than asserted: the pre-#2246 script scores **exit 0** on the unfixed file, the two additions take that same tree to **exit 1** naming the file and both lines, and the fixed tree is back to exit 0.
  **The literals are deliberately shorter than the doc's sentences**, because the doc's sentence would have caught nothing: the live defect read "Haven gave you a credential — a private key", split across a JSX interpolation and a line break, so `haven gave you the private key` matches it at no point. Two nearby generalisations were **rejected on measurement**, each having a true-sentence false positive in the scanned set — `signs and settles` hits "Client signs and settles on‑chain" on the x402 protocol page, and `haven signs` hits "Haven signs nothing.", which is the non-custody claim itself and must stay writable. Same ceiling as the #2334 block: a single-line literal holds a **phrase**, while the avoid list bans a **claim**, so a reword ("the key we issued you") goes green. `scripts/frontend-copy-lint.test.mjs` asserts that evasion on purpose.
- **Ratcheting baseline.** Existing debt is captured in `packages/frontend/copy-lint-baseline.json` (file → phrase → count); counts may only **shrink**. A new banned term, or growth of an existing count, fails. After cleaning some up, run `npm run lint:copy:update` to tighten the ratchet. **That command will not accept an addition (#2728)** — it refuses to raise the baseline and names what grew, as every gate on the shared `scripts/lib/ratchet.mjs` now does. Until #2728 it wrote whatever it was given, with no comparison at all, so the command this page pointed you to for a reviewed addition was also the one that could absorb an unreviewed one silently. A genuinely intentional addition to an existing baseline remains a reviewed manual edit. On a true first run, a missing baseline is created automatically only when the scan is empty; non-empty debt requires an explicit, reviewed `--update --accept-new` invocation (#2758). The flag is first-run-only: an existing `{}` or populated baseline still refuses growth. Since #2759 the shared engine also refuses a MALFORMED baseline at the read boundary: an entry whose count is not a number used to disable itself silently, because the comparison is `count > allowed` and `1 > "x"` is `false` — so the gate reported a clean bill of health over a live violation, and the shrink hint stayed quiet for the same reason.
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

- The homepage says that if a credential leaks "your funds stay exactly where
  they were" (`app/page.tsx:41`), which contradicts the disclosure required
  above: a leaked private signing key controls funds already held in the agent
  wallet, and rotation does not recover them.

  **Re-based by #2246, and two of the three surfaces this bullet named are
  off it.** It previously read "The homepage, `UsingYourAgentInfo.tsx`, and the
  protocol marketing pages use absolute rules/credential claims or say or imply
  that Haven gives users a private key or signs and settles payments."
  `UsingYourAgentInfo.tsx` is off it because #2246 **fixed** it — both
  avoid-listed phrases are gone, and both are now literals in the copy lint's
  `BANNED` list, so the entry is enforced rather than remembered. The
  **protocol marketing pages** are off it because the claim was not true when
  checked: the only `signs and settles` under `app/protocols/**` is
  `x402/page.tsx:12`, "Client signs and settles on‑chain", where the client is
  the actor and the sentence is correct — it was measured as the false positive
  that kept the wider phrase out of `BANNED`. What survives is the homepage
  sentence above, quoted with its line, and it is a different defect from the
  two the bullet used to conflate with it. NOT re-verified here: whether the
  homepage or the protocol pages carry *other* absolute rules/credential claims
  — that is a claim about prose, and this pass only measured the two phrases.
- The homepage and the How it works page advertise EURe and Gnosis Chain even
  though current account creation offers Base and Base Sepolia, where USDC is
  the payment-token example.
- The "payment evidence document" rule above is not yet reflected in the one
  shipped string that remains: the generated underlag PDF is titled `'HAVEN
  PAYMENT RECEIPT (underlag)'` in
  `packages/backend/src/modules/accounting/receipt-underlag.ts` — named by its
  string rather than its line, which drifts (this bullet said `:91` for a
  string that sits at `:100`). This bullet also used to say "betalningsbevis"
  appeared nowhere in the Swedish catalog, and **that was false when it was
  written**: `sv.ts:41` read "…med betalningsbevis bifogat" while `sv.ts:114`
  and `:193` said "betalningsunderlag", so the catalog disagreed with itself on
  exactly this term. #2926 deleted that file, which is what makes the claim
  true now rather than any correction to the copy. The bullet also
  named the approval and send surfaces as labelling it "Payment receipt"; those
  surfaces were deleted with the Safe rail (#1989) and the label survives on no
  surface at all — checked over `packages/` rather than `packages/frontend`,
  case-insensitively, so the claim's scope matches the check's. The rule is
  still unenforced — the remaining drift is the backend string alone; the
  English catalog uses the preferred wording ("payment evidence attached"). The
  copy lint reaches neither.

Correct these in product-copy changes; do not weaken this guide to match them.
