---
owner: "@d-hinders"
status: archived
covers: []  # frozen provenance record — the moved tail of one last-verified chain, no code mirror
last-verified: "2026-09-03"
---

# Archived `last-verified` chain — `docs/operations/mcp-runtime-compatibility.md`

> **ARCHIVED.** This is the older tail of that document's `last-verified` provenance chain, moved here verbatim on
> 2026-09-03 (#2477) when the line was compacted under `scripts/docs/chain-integrity.mjs`'s 64 KiB ceiling.
> Nothing here describes current state; the live chain is the `last-verified:` line in the source document.
> Entries are newest first, exactly as they sat in the chain. The full history is also in `git log -- docs/operations/mcp-runtime-compatibility.md`.

38 entries. Each block below is one chain entry, byte-for-byte.

## 1. #1719

#1719: the connector resolves its own runtime — the #1672 ladder gains an agent self-report rung (at hint precedence, so it still loses to detection) and an installed-client scan + TTY prompt that populates choices and NEVER selects, skipped entirely under --json / non-TTY; an unrecognised runtime name refuses (runtime_unrecognized) instead of falling through, or loses loudly to a detection; new stable codes runtime_undetermined, runtime_unrecognized, runtime_force_unrecognized, runtime_no_installed_clients, runtime_prompt_aborted (all pre-side-effect, connector-exit only) and runtime_config_unreadable (post-credential, reaches the dashboard, split from the retryable runtime_config_write_failed). No tool, capability, or version-skew surface moves; the Supported Runtime Manifest is unchanged.

## 2. #1697

#1697: --doctor is per-agent — it enumerates every credential directory and classifies each wired/superseded/retired/orphaned instead of "newest wins", runs the full check set per WIRED agent, and exits non-zero if ANY wired agent fails ANY check; --json gains agents[] (slug/agentId/directory/classification/checks) while the flat checks[] still describes one agent so single-agent installs read unchanged. New identity_match check compares the agent the stored API key authenticates as (GET /machine-payments/agent, read-only) against signer.json's delegate_address — a mismatch fails hard. No tool, capability, or version-skew surface moves.

## 3. #1696

#1696: connect gains --name <slug> — a NAMED agent writes the #1695 haven-<slug>/haven-signer-<slug> MCP pair, stores credentials at ~/.haven/agents/<slug>/ (unnamed keeps ~/.haven/agents/<agent-uuid>/), and records the slug as server_name in signer-runtime.json/mcp-runtime.json. The slug is validated at the ARGUMENT (before any key is minted or file written) and a taken slug refuses before registration, so a re-run can never orphan an agent or overwrite credentials; "haven"/"haven-signer" and the reserved signer/signer-* family are refused. Omitting --name is byte-identical to today. No tool, capability, or version-skew surface moves; --doctor/--repair stay bare-pair-scoped until #1697.

## 4. #1695

#1695: every runtime config writer (Cursor/VS Code/Claude Desktop JSON, Codex TOML, Hermes YAML+env, Claude Code CLI) is parametrized on a server-name pair — an optional serverName slug yields haven-<slug>/haven-signer-<slug> entries (Hermes: its own MCP_HAVEN_<SLUG>_API_KEY) that coexist with the bare pair; a writer touches ONLY the pair it owns, which removes the #1569 clobbering class (slugs "signer"/"signer-*" are reserved — the one family whose derived names could collide across pairs). The UNNAMED path is byte-identical to before (pinned by characterization tests) — no wired host changes, no tool, capability, or version-skew surface moves; #1696 wires the --name flag.

## 5. #1681

#1681: connect gains --tombstone <dir> (retire a credential directory in place: diagnostic wrapper + TOMBSTONE.json; no keys touched, nothing revoked, no token/--runtime) and --doctor reads tombstones in the superseded scan (keys removed => informational retired; key present => the #1688 live-probe verdict unchanged); restart guidance widens to EVERY long-lived host. No tool, capability, or version-skew surface moves.

## 6. #1688 re-verify

#1688 re-verify: --doctor gains the superseded_agents check (probes every unselected credential dir with its own key; live ⇒ failing check + revoke repair) and setup completion names superseded agents — diagnostics only, no tool, capability, or version-skew surface moves, and the doctor/repair contract this doc describes stands with one addition it now records.

## 7. #1690

#1690: x402 expected-context VERSION 3 (payer identity) ships signer-first — SUPPORTED_X402_EXPECTED_VERSIONS widens to [1,2,3] (capability handshake and instructions render the new set automatically, both derived from the constant), the signer refuses another agent's quote naming both identities, and the backend keeps emitting v2 until the operator flips X402_EMIT_PAYER_CONTEXT per environment. The version-skew contract is unchanged in shape: a v3 context on a v1/v2 signer produces the existing machine-readable refusal carrying users to `npx @haven_ai/connect@alpha`. No tool schema moves; the signer tool boundary gains OPTIONAL payer_delegate/payer_agent_id passthrough fields.

## 8. #1682

#1682: the runtime picker is name-first — the collapsed "AI agent" row is replaced by a flat product-name list, and a new "The picker is name-first" subsection carries the row→modality table, the folded vscode-insiders id, and the OpenClaw row's dependency on a published connect release. Detection precedence, the Node floor, and every skew/manifest claim re-read against the diff and unchanged.

## 9. #1672

#1672: runtime selection is detection-first — the setup command drops --runtime on command-path runtimes, detection overrides a contradicting hint (notice printed; --runtime-force escape hatch), and no-detection-no-flag refuses before any side effect; new "Runtime selection is detection-first" section documents it. No manifest, tool, capability, or version-skew surface moves.

## 10. Release 0.1.28-alpha.0

Release 0.1.28-alpha.0: the Supported Runtime Manifest table is re-pinned to match packages/connect/src/runtime-manifest.ts. Version strings only — no tool, capability, or version-skew surface moves, and the skew contract paragraphs below re-read against the diff stand unchanged. The bump exists because the #1620 SDK decomposition epic (#1614, #1618, #1619, #1631, #1634, #1636, #1655) rewrote packages/sdk/src/client.ts AFTER 0.1.27-alpha.0 was published, and publish.yml skips versions already on npm — so without it the same version string holds different code on npm and in-repo, and the entries below that document that epic would describe an SDK npm does not yet ship. That epic reduced client.ts from ~2500 lines to a compatibility facade over extracted lifecycle modules, exactly the change class that could move a consumer-visible surface silently, so it was MEASURED rather than assumed: the built dist/index.d.ts diffed against the @haven_ai/sdk@0.1.27-alpha.0 tarball from npm shows 155 top-level declarations with zero added and zero removed, and no changed line in the 227-line type diff that is not a private member or a comment. What moved is which module owns a code path, never what a consumer may call.

## 11. #1618 re-verify

#1618 re-verify: the SDK's EIP-3009 x402 funding leg moved out of HavenClient into internal modules (x402-protocol.ts / x402-funding-leg.ts). Behaviour-preserving and INTERNAL — no tool schema, capability, runtime-floor, or version-skew surface moves, and the published set this doc governs is unchanged. This doc was pulled in only because connect's package-smoke test had a comment naming the renamed method; every claim here re-read against the diff stands.

## 12. Release 0.1.27-alpha.0

Release 0.1.27-alpha.0: the Supported Runtime Manifest table is re-pinned to match packages/connect/src/runtime-manifest.ts. Version strings only — no tool, capability, or version-skew surface moves, and the skew contract paragraphs below re-read against the diff stand unchanged. The bump exists because #1593, #1595, #1597 and #1598 changed connect, the hosted server and the SDK AFTER 0.1.26-alpha.0 was published, and publish.yml skips versions already on npm — so without it `npx @haven_ai/connect@alpha` keeps resolving to a build with no --doctor, and this table's own #1589/#1587/#1588 entries would document a connector that npm does not yet ship.

## 13. #1593

#1593: the LOCAL MCP runtime install is hardened like #1586 did the signer's — same honest budget (SIGNER_INSTALL_TIMEOUT_MS, replacing the spurious 120s timeout) and 15s onProgress heartbeats, threaded through installRuntime (integration-proven; the unthreaded-callback mutation fails the test). Setup reliability only — no tool, capability, or version-skew surface moves.

## 14. #1591

#1591: hosted tool-description prose slimmed ~49% with flow-generic guidance consolidated into the server instructions (sign-by-payment_id, settle shapes, expiry re-run, version-mismatch branch, sweep pointer) — prose only; no tool schema, capability, or version-skew surface moves, and the skew contract paragraphs re-read against the diff stand unchanged.

## 15. #1590

#1590: haven_get_agent gains spend_authority_readiness (readiness stays as a deprecated same-value alias) — additive field + prose stating the local-signer exclusion; no tool schema, capability, or version-skew surface moves.

## 16. #1589

#1589: --doctor/--repair documented.

## 17. #1588

#1588: runtime-neutral next_tool_server/next_tool_name pair documented.

## 18. #1587

#1587: hosted-topology setup handshake-probes the local signer before reporting success; troubleshooting entry added.

## 19. #1586

#1586: signer preinstall fails closed (no config write, no npx fallback), 10-min budget + heartbeats; troubleshooting entry added.

## 20. #1549 re-verify

#1549 re-verify: haven_pay_mcp_tool/haven_prepare_catalog_purchase stop echoing payment_required by default (the signer's #1355 payment_id fetch is the source; include_signing_payload=true restores it — the same replay escape this doc already documents for typed_data), and signer_compatibility.check is shorter prose with the #1309 machine fields unchanged. No tool schema, capability, or version-skew surface moves; the skew table's quote/prepare row and the #1309 contract paragraphs re-read against the diff and stand.

## 21. #1548 re-verify

#1548 re-verify: tool-description prose gains the no-user-cap convention (quote first, cap = live quote) — guidance text only; no tool, capability, or version-skew surface moves, and every claim here re-read against the diff stands unchanged.

## 22. #1547

#1547: the pre-payment skew guidance stops asking agents to compare against the signer's MCP initialize result (unperformable in most harnesses — they cannot see the handshake); the documented protocol is now "sign; branch on the signer's machine-readable version-mismatch refusal (#1309)". Enforcement location unchanged — the signing-time refusal was always the only hard gate; the initialize capability surfaces stay advertised. Also: haven_prepare_catalog_purchase gains the #1450 scheme selection (erc7710 direct settlement when rail+merchant allow; mcpCallContext persisted on that scheme too), so its skew paragraph is scheme-aware now.

## 23. #1569

#1569: the Claude Code LOCAL-stdio writer now removes stale haven/haven-signer entries before re-adding, mirroring the hosted writer — a second local-stdio setup previously collided on the existing entry and left the runtime wired to the previous agent's wrapper. The troubleshooting advice here ("rerun the connector") becomes reliably true on that path; the add-json → add fallback claim is unchanged. No tool, capability, or version-skew surface moves.

## 24. #1545 re-verify

#1545 re-verify: --json discoverability (a one-sentence mention in the dashboard's setup prompt; README documents that structured runs skip the approval wait — matching what this doc already said) and the "approve the budget" gate rename sweep across the setup prompt and dashboard connect-flow copy, converging on the term this doc's handoff section already uses (#1542). Every claim here re-read against the diff and unchanged — no tool, capability, or version-skew surface moves.

## 25. #1544 re-verify

#1544 re-verify: characterization tests + a README "Running setup again" section pin connect's re-run behavior (consumed setup fails before any local write; new agent lands in a sibling credential directory; managed MCP entries replaced, never duplicated). Tests and docs only — zero behavior change, and every claim in this doc re-read against the diff stands unchanged.

## 26. #1543

#1543: the connector sends an early install-status report when the runtime config write settles, so the dashboard's budget-approval unlock stops waiting on probes + skill install; the final report stays authoritative. Readiness-metadata timing only — no tool, capability, or version-skew surface moves.

## 27. #1542

#1542: the Connect completion handoff is approval-aware — the "Completion handoff after Connect" section is rewritten to match (handoff shaped by the wait's observed outcome; immediate first check before the waiting line; "budget" is the one name for the gate in connector output; restart step carries its why). Output prose and poll timing only — no tool, capability, or version-skew surface moves, and the --json structured outcome is unchanged.

## 28. #1521 ships to npm

#1521 ships to npm: release 0.1.26-alpha.0 — the Supported Runtime Manifest table is re-pinned to match packages/connect/src/runtime-manifest.ts. Version strings only; no tool, capability, or version-skew surface moves. The bump exists because #1521 changed packages/sdk/src/client.ts AFTER 0.1.25-alpha.0 was published and publish.yml skips versions already on npm — without it, npm's SDK would keep signing EIP-3009 authorizations against a spent delegate on an idempotency replay (the exact defect class the 0.1.25 note below records for #1511). First release under the #1526 pin rules: mcp-server's version bumps in lockstep while its "*" workspace pins are untouched, verified by verifyPrivateConsumersUnpinned at bump time.

## 29. #1526

#1526: mcp-server and demo-merchant-mcp are now flagged `private: true` with "*" internal pins, matching what the unpublished-workspace-packages list here already said. NO runtime-floor, version-skew, or Supported Runtime Manifest surface moves — the published set this doc governs is unchanged at sdk/signer/mcp/connect/cli, and the connect package-smoke pin check now derives that set from each package's own `private` field instead of a hardcoded list that had drifted in both directions (mcp-server wrongly in, cli wrongly absent and therefore unguarded).

## 30. Release 0.1.25-alpha.0

Release 0.1.25-alpha.0: the Supported Runtime Manifest table is re-pinned to match packages/connect/src/runtime-manifest.ts. A version bump only — no tool, capability, or skew-contract surface moves, and the version-skew rules below are unchanged. The bump exists because #1511 changed packages/sdk/src/client.ts AFTER 0.1.24-alpha.0 was published, so that version on npm and in-repo would otherwise hold different code; publish.yml skips versions already on npm, so without a new version the fix never reaches SDK consumers.

## 31. #1508 (actual fix)

#1508 (actual fix): completeX402MerchantCall gains an opt-in no-funding-leg path so a hosted erc7710 settlement reaches the merchant — its readiness gate and mandatory funding-tx hash both encoded the 3009 lifecycle. NO tool schema, capability, or version-skew surface moves: haven_settle_mcp_tool's request/response shapes are byte-identical and 3009 callers take the unchanged path (pinned by a test that a submitted intent without the flag is still refused). Prior #1508: haven_settle_mcp_tool's erc7710 branch no longer runs the funding-confirmation wait — a scheme with no funding leg has no transaction to confirm, and the underlying ensureFundingConfirmed reads GET /payments/:id unconditionally, which 409s on the 'submitted' intent a successful erc7710 settle produces. NO tool schema, capability, or version-skew surface moves: the request and response shapes of haven_settle_mcp_tool are byte-identical, older callers that send payment_header still take the 3009 path unchanged, and nothing here about skew detection or the runtime manifest is affected. A settled payment stops being REPORTED as failed; what may be spent is untouched.

## 32. Release 0.1.24-alpha.0 (PR #1503)

Release 0.1.24-alpha.0 (PR #1503): the Supported Runtime Manifest table is re-pinned to match packages/connect/src/runtime-manifest.ts. A version bump only — no tool, capability, or skew-contract surface moves, and the version-skew rules below are unchanged.

## 33. #1469

#1469: haven_pay_x402_quote normalizes payment_required — malformed accepts entries now refuse with guidance instead of erroring; valid callers unchanged. #1476: haven_sign now refuses a Delegation-shaped typed_data with no expected context; callers using { payment_id } or haven_sign_x402 are unaffected, and the #1254 direct-payment UserOp path is unchanged. #1456: haven_settle_mcp_tool accepts an OPTIONAL payment_header — its absence selects erc7710. Older callers always send one, so their behaviour is unchanged. #1455 re-verify: the signer gained local caveat verification for erc7710 settlement children — a REFUSAL added, no capability/version surface changed, so nothing here about runtime compatibility or the version-skew contract moves. #1426 re-verify: the connector celebration line now phrases reset periods in the dashboard voice (per week/per month/in total) — output wording only, the completion-handoff ordering and no-secret boundaries here are untouched. #1332: guidance-surface parity — setup installs the canonical skill via each runtime's documented instruction mechanism (Hermes skills dir, Codex global AGENTS.md managed section); Claude Code unchanged.

## 34. #1397 hosted-only quote tools.

#1397 hosted-only quote tools.

## 35. #2155

#2155: re-verified, NOT edited in the body. Scope: `packages/connect/**` is in this doc's covers, and the diff touches `packages/connect/src/tombstone.ts`, `src/cli.ts` and `src/doctor.ts` (+ tests) so a tombstone record survives deletion of its agent directory: `writeAgentTombstone` mirrors the record under `~/.haven/tombstones/<agent_id>.json` (0600, same redaction) and returns `recordPath`; `--tombstone` output names the mirror; `--doctor` reads mirrored records whose dir no longer exists and lists them as `retired (dir removed)` — informational, never a fail, and read from the doctor's own `homeDir` so an explicit `--credentials-dir` never consults the machine-wide default root. Re-read the Troubleshooting (--tombstone / --doctor / --rekey) and Credential-safety sections against the diff: the tombstone entry's claim that a tombstone "touches no key material and revokes nothing" stands — the mirror is the same record, same redaction, same no-key boundary (mutation-proven in tombstone.test.ts, which now checks the mirror explicitly); the credentials-location sentence is untouched — a mirror record carries no key, just agent_id/retired_at/reason; the doctor description's severity/exit-code rule is unchanged because the dir-removed listing can never fail the doctor (no key, no dir, no spend path), matching the existing #1681 inform-only discipline; the re-key entry is untouched (no slug or MCP-pair move). No tool schema, capability handshake, runtime floor, failure-code, or Supported Runtime Manifest surface moves — release-bump.mjs's table is untouched. Scope: that verification only.

## 36. #2169

#2169: re-verified, NOT edited in the body. Scope: `packages/connect/**` is in this doc's covers, and the diff adds `--unwire` — connect's first REMOVAL surface: tombstone-first teardown of ONE agent's wiring, removing the hosted + signer pair from Hermes YAML, Codex TOML and the JSON MCP configs plus the Hermes dotenv key (`MCP_HAVEN_API_KEY` / `MCP_HAVEN_<SLUG>_API_KEY`), then tearing down the target directory's own key material (signer.json, any abandoned re-key, the identity API key) so `--doctor` reports `retired` rather than the still-spend-capable `superseded` — the doctor's mutation-proof rule is a tombstone never excuses a live key. An UNNAMED pair is only removed when this directory's wrapper is the one the config launches (or its key is the one the Hermes env holds), mirroring `agentIsWired`'s reasoning; otherwise the command refuses rather than unwire a different agent. Nothing revokes on the backend (#1688: connect reports, the user decides). Re-read the Troubleshooting (--tombstone / --doctor), Credential-safety and version-skew sections against the diff: no tool schema, capability handshake, runtime floor, failure-code or Supported Runtime Manifest surface moves, and release-bump.mjs's table is untouched. Scope: that verification only.

## 37. #1397 hosted-only quote tools. origin/dev

#1397 hosted-only quote tools. origin/dev

## 38. #2301

#2301: re-verified, NOT edited (agent-discovery metadata pass). The change touches packages/{mcp,connect,signer}/package.json but ONLY description, keywords and homepage — no version constants (MCP_VERSION/SIGNER_VERSION/CONNECTOR_VERSION untouched), no dependency pins, no tool schemas, no runtime-manifest rows, no expected-context versions. Verified the Supported Runtime Manifest table still matches the source constants on this branch; the connect one-liner this doc and the new public artifacts both print (npx @haven_ai/connect@alpha) is unchanged and now declared sync-critical in docs/operations/agent-discovery-listings.md.
