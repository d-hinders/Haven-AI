---
description: "Reset Haven agent setup and walk through a full clean-slate retest — removes all Haven MCP entries + ~/.haven credentials, verifies the slate is clean, then guides a fresh connect + x402 payment check"
---

Fully reset the local Haven setup and prepare a clean-slate retest of the connect flow.

There are **two** Haven MCP entries — `haven` (hosted, HTTP) and `haven-signer` (local stdio, holds the delegate key). Earlier resets only removed `haven` and left a stale `haven-signer` behind (sometimes hand-patched to a local `node` path), which then shadowed the connector's fresh write. **Always remove both, across all scopes.**

## Phase 1 — Reset

1. Back up the config first: `cp ~/.claude.json ~/.claude.json.bak-$(date +%Y%m%d-%H%M%S)` (skip silently if `~/.claude.json` doesn't exist).
2. Remove **both** entries across **all** scopes (ignore "not found" errors):
   - `claude mcp remove haven -s user` / `-s local` / `-s project`
   - `claude mcp remove haven-signer -s user` / `-s local` / `-s project`
3. Delete local credentials: `rm -rf ~/.haven`

## Phase 2 — Verify the slate is clean (do not skip)

4. Confirm **no** Haven entries remain in `~/.claude.json` `mcpServers` (scan for any key matching `/haven/i`). If any survive — e.g. a hand-edited `haven-signer` with a `node` command the `claude mcp remove` matcher missed — remove them directly from `~/.claude.json` and re-check.
5. Confirm `~/.haven` is gone.
6. Confirm `claude mcp list` shows no Haven rows.
7. Report exactly what was removed and the verification result. If anything is still present, say so plainly and fix it before continuing — do not report "clean" unless all three checks pass.

## Phase 3 — Fresh connect (guide the user)

8. Tell the user to **restart Claude Code** so it drops the removed Haven MCP connections from memory.
9. Have them run the published connector pinned to the alpha tag (always latest fixed release, no hardcoded version):
   `npx @haven_ai/connect@alpha` (plus their `--setup <token> --api <url>` from the dashboard).
10. After it runs, **verify the binding signer was auto-provisioned**: the new `~/.haven/agents/<id>/signer.json` must contain `x402_binding_signer`. If it's there **without** any manual patch, the connect flow is healthy end-to-end. If it's **missing**, that points at the deployed backend (`X402_BINDING_PRIVATE_KEY` / `HAVEN_X402_BINDING_SIGNER` not set), not the connector — flag it rather than hand-patching.
11. Confirm the signer connected: `claude mcp list` should show `haven-signer` connected (not `✘ Failed to connect`), and `haven_sign` / `haven_x402_sign_header` should be available.

## Phase 4 — Payment smoke check

12. Run a small real payment (e.g. the x402 test merchant) and confirm it signs and settles with no manual intervention. A successful settlement is the end-to-end proof of the retest.

If any phase fails, stop and report the failing step with its output rather than proceeding.
