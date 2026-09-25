# @haven_ai/signer

Release headers are written by the release bump (`npm run release:bump`), never by
hand — true since the changelog-heading gap, and stated here only because it was asserted for a long
time while being false. The bump rewrites the `## Unreleased` heading below into
`## <version> — <date>`; add entries under `## Unreleased` and leave the heading
alone.

## Unreleased

## 0.5.0-alpha.0 — 2026-09-25

- **BREAKING (x402 arm): `signX402FundingTypedData` signs only a guarded funding leg or a verified settlement child (#3281, epic #3284).** A valid Haven binding is no longer enough. The x402 arm (`haven_sign` with `x402_expected` or a fetched x402 context, and `haven_sign_x402`) now signs exactly two shapes:
  - a funding-leg `PackedUserOperation` that passes the #3271 binding against the declared `payloadHash` and the #3272 direct-payment allowlist, and whose single execution is a `transfer` of the quoted amount of the quoted token to **this signer's own delegate EOA** (`assertFundingLegPaysDelegate`);
  - an erc7710 settlement child that passes `verifySettlementChild`, now also required to be delegated by this signer's own account (and never ROOT).

  Anything else is refused however validly Haven's binding key declared it: a `TransferWithAuthorization`, a `Permit`, an empty-context redemption, a funding leg paying another address. The refusal is `TYPED_DATA_NOT_ALLOWED` or `USEROP_BINDING_MISMATCH`, structured as on the unbound branch, with no signature and no audit entry. A settlement child that fails verification (including the older payee, amount, token, chain and expiry checks) now also answers `TYPED_DATA_NOT_ALLOWED` with a `stop_and_tell_user` next step, instead of a bare `SIGNING_ERROR`; its message is unchanged. Check order is unchanged ahead of the new checks: version, binding, payer, then shape. The expected budget-delegation hash is not checked: it is knowable only by trusting Haven for it, and the invariant does not need it.
- **Safe-vocabulary copy fix (#3279).** The first-launch consent block names the agent's signed budget delegation as the real spend gate instead of "On-chain Safe rules", and `haven_sign_sweep_delegate`'s description, the `signSweepAuthorization` JSDoc, the `expectedSafe` field comment and the `to`-guard refusal message name the destination as the agent's account (Haven wallet) and state the real destination check: it runs only when the local credential carries an account address, and otherwise rests on Haven's binding signature — the old copy overclaimed an unconditional check. Copy only: no hash input, no behaviour, no identifier changes (`expectedSafe` keeps its name; `SweepSignatureInput` remains unexported by name), and **the consent hash is unchanged** — `computeSignerConsentHash` covers identity, tool names and the surface version, never the text, so nobody is re-prompted; `SIGNER_CONSENT_SURFACE_VERSION` stays 2 and a new test pins it with that reason. The #3172 sentence here and in the README that said the consent text is "kept unchanged … because editing it moves the consent hash" was wrong and is corrected: the hash covers identity, tool names and the version, as the consent-screen section already said.
- **Guard modules moved into `@haven_ai/sdk` (#3283, epic #3284).** `delegate-account.ts`, `redemption-guard.ts`, `settlement-child.ts` and the direct-payment allowlist now live in `@haven_ai/sdk` and are imported from `@haven_ai/sdk/edge`, so the signer and `HavenClient.signForData` run one implementation. `haven_sign`'s behaviour, its `TYPED_DATA_NOT_ALLOWED` refusal (code, message, next step) and the tool surface are unchanged; `HavenTypedDataNotAllowedError` now extends the SDK's `HavenTypedDataRefusedError`. `deriveDelegateAccountAddress` is still exported from this package. One tightening reaches the x402 arm through the shared verifier: a settlement child with ROOT authority is now refused (the backend always emits a re-delegation of the budget). Requires the matching `@haven_ai/sdk`, pinned exactly as before.
- **BREAKING: `haven_sign`'s unbound branch signs only a bound direct-payment UserOp; x402 expected-context v1 is retired (#3272).** The unbound typed-data branch (the arm reached when no Haven-signed x402 context is supplied) used to sign *any* well-formed EIP-712 payload the caller supplied — a probe with an invented domain, a delegate USDC `TransferWithAuthorization` or `Permit`, a `PackedUserOperation` for a third party's account, or one that self-calls the account (`transferOwnership`, `updateSigners`, `upgradeToAndCall`) — because `payload_hash` is caller-supplied alongside the typed data and binds nothing on its own. It now signs exactly one shape: a `PackedUserOperation` whose `#3271` binding (`assertUserOpTypedDataBinding`) already holds, AND whose chain is one the delegation rail has pinned contracts for (8453, 84532), whose `sender`/`verifyingContract` is *this signer's own* counterfactual HybridDeleGator account (derived offline, CREATE2, from the delegate key's own address — no runtime dependency on `@metamask/smart-accounts-kit`, which stays a devDependency), and whose `callData` decodes as a single `execute(DelegationManager, 0, redeemDelegations(...))` — never a batch execute, `executeFromExecutor`, a self-call, or a call to any other contract. Everything else is refused with the new structured `TYPED_DATA_NOT_ALLOWED` (`next_action: stop_and_tell_user`, typed step, no signature, no audit entry ever), modelled on `HavenUserOpBindingRefusedError` / `HavenBareHashRefusedError`. The x402 arm (`x402_expected` / a fetched x402 context) is unaffected by this entry — it was already bound to a Haven-signed digest (its own shape checks came with #3281, above). **The boundary decision:** the allowlist lives in `tools.ts`, not `core.ts` — `createEdgeSigner().signDelegationTypedData` stays a verbatim, unopinionated primitive for embedders; only the MCP tool `haven_sign` gates it. New module `delegate-account.ts` (`deriveDelegateAccountAddress`, exported from the package index), pinned against the kit by `delegate-account.pins.test.ts` (including against a real Base Sepolia payload served by the dev backend) for Base and Base Sepolia. The redemption's arguments are decoded as well (`redemption-guard.ts`): exactly one delegation, a single grant made to this signer's own account by a different account (an empty or multi-link chain is refused), `SingleDefault` mode, canonical encoding at every level. An empty permission context would otherwise make the DelegationManager execute as the account itself (a self-call capture), and a regression test pins it. `domain.chainId` must be a number or bigint.
  Separately, and for an unrelated reason (owner decision 2026-09-24): x402 expected-context **v1** — Haven's internal bare-hash binding format inherited from the retired Safe rail, not the x402 *protocol* version — is dropped. `SUPPORTED_X402_EXPECTED_VERSIONS` is now `[2, 3]`; `EdgeSigner.signX402FundingHash` is removed; a v1 context (no `typedDataHash`) is refused with the existing structured `UNSUPPORTED_EXPECTED_CONTEXT_VERSION` refusal, whether or not typed data was even supplied, and nothing is signed. x402 protocol v1 (`X-PAYMENT`) and v2 (`PAYMENT-SIGNATURE`) merchant headers are untouched.
  Also fixed: the audit log now records the EIP-712 digest **actually signed** — on both the unbound direct-payment branch and the x402 typed-data arm — never the caller-supplied `payload_hash`, which is a different value (the ERC-4337 UserOp hash) the `#3271` binding check merely cross-checks the typed data against. And a redundant self-comparison of `expected.payloadHash` inside `signX402FundingTypedData`'s binding check was removed; the existing digest-equality check (Haven's `typedDataHash` against the typed data in hand) moved into `assertExpectedBinding`. What gets signed on the x402 arm is unchanged.
  Prior claims corrected to match the above: `haven_sign`'s tool description (`tools.ts`), the install-consent line (`consent.ts:16`), this package's README (the library-boundary and allowlist paragraphs), `docs/architecture/07-edge-signer.md`, `docs/architecture/06-hosted-mcp-connect-flow.md`, `docs/operations/local-to-hosted-mcp.md`, a re-verification note in `docs/operations/mcp-runtime-compatibility.md`, and a new signer-surface section in `docs/security/delegation-rail-security-model.md` (§10) that records the blast-radius questions. **Upgrade:** a signer installed before this release keeps the old signing surface until it is upgraded (re-run the connector); Haven cannot gate it.
- **Direct-payment UserOp binding check, and `haven_sign` fetches its sign-context by `payment_id` too (#3271).** A direct payment's (`POST /payments`, `haven_send` / `haven_pay`) typed data is now checked against its own `payload_hash` before `haven_sign` signs it — recomputed from the typed data's own domain, types and message, in the HybridDeleGator domain of its own sender, against the ERC-4337 v0.7 EntryPoint. A mismatch refuses with the new structured `USEROP_BINDING_MISMATCH` (`next_action: stop_and_tell_user`, typed step, no signature, no audit entry), modelled on `BARE_HASH_REFUSED` (#3169). The check runs on this typed data wherever it reaches `haven_sign` — a tool argument, `typed_data_b64`, or the new `payment_id` fetch below; a fetched direct context that is not a `PackedUserOperation` is refused by the same check. The domain is pinned exactly: no extra keys such as `salt`, and a declared `types.EIP712Domain` must be the canonical four fields. The x402 EIP-3009 funding leg keeps its existing digest check against the Haven-signed expected context in this signer. `haven_sign` also gains a fallback fetch, `GET /payments/:id/sign-context` (new `fetchDirectSignContext`, `SUPPORTED_DIRECT_SIGN_CONTEXT_VERSIONS`), used only when the existing x402 fetch answers the backend's 409 `sign_context_unavailable` — `payment_id` alone now works for a direct payment exactly as it already did for delegation-rail x402. `haven_sign_x402` never takes this fallback. Capability advertisement gains `direct_sign_context_versions` (derived from the SDK's `DIRECT_SIGN_CONTEXT_VERSION`) beside the existing x402/sweep version sets, in both the machine-readable handshake and `signerInstructions()`. New module-internal names: `HavenUserOpBindingRefusedError`, `USEROP_BINDING_MISMATCH`, `fetchDirectSignContext`, `FetchedDirectSignContext`, `SUPPORTED_DIRECT_SIGN_CONTEXT_VERSIONS`. They are not re-exported from `@haven_ai/signer`, whose only entry is `.`, so importing them from the package does not compile. No tool added or renamed; the consent surface is unchanged.
- **Cold start halved; CLI refuses unknown options; the consent screen is human-sized (#3173).** The signer imports `@haven_ai/sdk/edge` (new in the SDK this version — ethers-free) instead of the SDK barrel, and loads `x402/schemes` only when it builds a merchant header. Measured: `--help` 1.47 s → 0.71 s, consent refusal 1.55 s → 0.77 s, SDK import 1135 ms → 385 ms; zero `ethers` / `x402` modules resolve at startup. Requires `@haven_ai/sdk` at the version pinned in this package (the subpath does not exist on older SDKs). Stricter key shape at startup: a delegate key that is not lowercase-`0x`-prefixed is refused when the signer starts, with a clear message — an unprefixed key, which ethers accepted at address derivation and only failed at the first signature, and an uppercase `0X` one; every Haven-issued key is `0x`-prefixed. An unknown CLI option is refused with one line naming `--help` and exit 2 (`--ack-local-tools` is named as the connector's flag); `--help` lists every registered tool and `npx @haven_ai/connect --doctor`. The consent block summarises each tool in one line and ends with the connector-doctor hint; the no-consent exit message names the doctor. New module-level exports in `cli-args.ts` (`parseSignerArgs`, `helpText`, `CONNECTOR_DOCTOR_COMMAND`) and `consent.ts` (`toolSummaries`, `CONNECTOR_DOCTOR_HINT`) — not added to the package index. Consent hash unchanged; no tool added, renamed or re-shaped.
- **The signing audit sidecar is owner-only and bounded (#3172).** `<credential>.signer-audit.jsonl` was created with the default mode (`0644`) beside a `0600` credential, and grew without bound. It is now created `0600`; a sidecar found permissive is tightened to `0600` on the next append, before any rotation (one stderr line per occurrence; a refused `chmod` gets the same `chmod 600` remedy as the credential warning; a symlink at the path is never chmod-ed through — rows are still written through it, so the line says `rm <path>`); the file rotates to `<path>.1` at `AUDIT_ROTATE_BYTES` (8 MiB), keeping one predecessor — two signer processes at the bound can discard that predecessor generation, never the current entry. An audit write that fails — disk full, read-only, two appends racing at the bound — is reported on stderr and no longer fails the signing call whose signature was already produced, so the consent block's "appended for every signing operation" is best-effort from this version (its text is unchanged — not because editing it would move the consent hash, which it would not: the hash covers identity, tool names and the surface version, never the text). The credential warning is unchanged in wording and behaviour: it still judges a symlinked credential path by its target (`stat`), while the sidecar check judges the link (`lstat`) because it goes on to `chmod`. `payload_hash` and `typed_data_hash` are bounded on the tool schemas to a 32-byte hash (`0x` + 64 hex) — any other length is `INVALID_INPUT` before signing or auditing, where before the regex accepted hex of any length and wrote it verbatim to the sidecar. Every value Haven produces for these fields is a 32-byte hash, so a conformant caller sees no change. New exports: `AUDIT_ROTATE_BYTES`, `OWNER_ONLY_MODE`, `permissiveMode`, `tightenIfFilePermissive`, `warnIfFilePermissive`, and the types `AppendAuditOptions`, `PermissionLog`, `PermissiveFile`, `TightenOutcome`. Consent text unchanged.
- **`haven_sign` refuses a bare `payload_hash` (#3169).** Called with no `payment_id`, no `typed_data` / `typed_data_b64` and no `x402_expected`, the tool answered raw secp256k1 over the caller's bytes — a blind-signing oracle for the delegate key (a digest of an EIP-3009 transfer out of the delegate wallet signed valid; a pre-hashed `Delegation` bypassed the #1476 refusal). That arm served only the retired AllowanceModule rail. It now answers the structured `BARE_HASH_REFUSED` refusal (`next_action: stop_and_tell_user`, typed step naming `payment_id` / `typed_data` / `x402_expected`) and audits nothing. `EdgeSigner.signPaymentHash` is removed from the object `createEdgeSigner` returns. No tool added or renamed; the consent surface is unchanged.

## 0.4.0-alpha.0 — 2026-09-19

- **Refusals carry a typed next step (#3103, epic #3105).** `HavenSignContextError`
  and every structured signer refusal now also carry the `next_tool` family:
  a backend refusal of the signing context names the hosted status read
  (`next_tool_server_role: hosted`, `next_tool_name: haven_get_payment_status`,
  `next_arguments: { payment_id }`); a transport failure, malformed body,
  expired window or version skew carries `next_tool_omitted_reason`. Additive;
  no signing decision, expected-context version or binding version changes.

## 0.3.0-alpha.0 — 2026-09-17

### Removed

- **BREAKING (#2914, naming epic #2906 phase 5).** `HAVEN_WALLET_ADDRESS` and
  `HAVEN_SAFE_ADDRESS` are no longer read from the environment;
  `HAVEN_ACCOUNT_ADDRESS` is the only name. A machine configured through
  either old variable resolves **no** account address, which is the condition
  under which the sweep-destination check degrades to "no local value to
  compare against" — set `HAVEN_ACCOUNT_ADDRESS` before upgrading.
- `SignerCredentials.safeAddress` is removed; `accountAddress` is the field.

### Unchanged, and deliberately

- The credential-FILE fallback `account_address ?? safe_address ?? safeAddress`
  is **permanent**. A file on disk never rewrites itself. So is the audit
  JSONL's persisted `safe_address` key, while the in-memory field it comes
  from is now `accountAddress` — the two spellings differ on purpose.
- `SUPPORTED_X402_EXPECTED_VERSIONS` is still `[1, 2, 3]`. This rename moves
  no signed payload and no consent hash: the hash takes the resolved address,
  not the key it arrived under, so an existing acknowledgement stays valid.

## 0.2.1-alpha.0 — 2026-09-16

### Added

- Sign-context refusals carry `code`, `fallback` and `next_action`, matching the shape
  the version-mismatch refusal already used (#3001). Additive: no refusal was removed
  and no field became required.

### Fixed

- `fetchX402SignContext` aborts after 15 seconds instead of hanging the agent
  indefinitely (#2985). A timeout is a refusal to proceed, never a decision to sign.

## 0.2.0-alpha.0 — 2026-09-14

### Naming epic #2906, phase 1 (#2908) — reads both names, prefers the new

| Reader | Chain (earlier wins) | Window |
|---|---|---|
| credential file (`loadSignerCredentials`) | `account_address ?? safe_address ?? safeAddress` | the two old keys are read **permanently** (a file on disk never rewrites itself) |
| environment | `HAVEN_ACCOUNT_ADDRESS ?? HAVEN_WALLET_ADDRESS ?? HAVEN_SAFE_ADDRESS` | `HAVEN_WALLET_ADDRESS` / `HAVEN_SAFE_ADDRESS` removed at #2914 |

`SignerCredentials` gains `accountAddress`; `safeAddress` is kept with the
same value and `@deprecated` — **removed in the release after the one
carrying #2908 (#2914)**. Exported: `readAccountAddressField()`,
`readAccountAddressEnv()`.

**No expected-context version change:** `SUPPORTED_X402_EXPECTED_VERSIONS`
stays `[1, 2, 3]` (asserted by `naming-window-no-version-change.test.ts`);
`sign_data.components.*` is response metadata, never part of the signed
payload. `capabilities.ts` and `core.ts` are unchanged except comments.
