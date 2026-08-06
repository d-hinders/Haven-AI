# Codex reset procedure

Use this procedure only when the active client is Codex CLI or Codex Desktop and the user explicitly requested a reset.

Haven's connector writes Codex MCP configuration to `~/.codex/config.toml`. Current published configuration uses `haven` and `haven_signer`.

## Reset

1. If `~/.codex/config.toml` exists, create a timestamped backup before mutation.
2. Inspect `codex mcp list` and the config for `haven`, `haven_signer`, and any stale `haven-signer` entry.
3. Remove only entries that exist, using the supported command:

   ```bash
   codex mcp remove haven
   codex mcp remove haven_signer
   ```

   If the listing contains a stale `haven-signer`, remove that exact name too.
4. Delete `~/.haven`.

`codex mcp remove` is verified for the user configuration. Inspect a repository-local `.codex/config.toml` when present, but do not mutate it automatically: stop and give the exact remaining table and file path because project-scope removal is not verified by this procedure.

## Verify

1. Confirm `~/.codex/config.toml` has no `[mcp_servers.haven]`, `[mcp_servers.haven_signer]`, stale `[mcp_servers.haven-signer]`, or descendant table.
2. Confirm `~/.haven` is absent.
3. Confirm `codex mcp list` has no Haven row.
4. Report the backup path, removed entries, credential-directory result, user-config scan, project-config scan, and list result.

Do not continue unless every relevant scope is clean.

## Reconnect And Retest

1. Ask the user to restart the Codex session so configuration is reloaded.
2. Guide the user to run the published connector:

   ```bash
   npx @haven_ai/connect@alpha --setup <token> --api <url>
   ```

3. Verify the new `~/.haven/agents/<id>/signer.json` contains `x402_binding_signer`. If missing, report the likely deployed backend configuration fault; do not patch it manually.
4. Confirm `codex mcp list` shows `haven` and `haven_signer` connected and the signer tools are available.
5. Run a small real payment only after separate explicit authorization. Confirm signing and settlement without manual intervention.

Stop and report the failing command and output when any phase fails.
