# Claude Code reset procedure

Use this procedure only when the active client is Claude Code and the user explicitly requested a reset.

## Reset

1. If `~/.claude.json` exists, create a timestamped backup before mutation. If the repository has `.mcp.json`, back it up separately before removing project-scope entries. User and local scope are stored through Claude's user configuration; project scope is stored in the repository `.mcp.json`.
2. Remove both `haven` and `haven-signer` from user, local, and project scopes. Ignore only an explicit not-found result:

   ```bash
   claude mcp remove haven -s user
   claude mcp remove haven -s local
   claude mcp remove haven -s project
   claude mcp remove haven-signer -s user
   claude mcp remove haven-signer -s local
   claude mcp remove haven-signer -s project
   ```

3. Delete `~/.haven`.

## Verify

1. Inspect `~/.claude.json` and confirm no key under `mcpServers` matches `haven` case-insensitively.
2. Inspect the repository `.mcp.json` when present and confirm its `mcpServers` contains no Haven entry.
3. If a stale hand-edited entry remains, restore safety by removing only that verified Haven entry from the corresponding backed-up config structure, then inspect both files again.
4. Confirm `~/.haven` is absent.
5. Confirm `claude mcp list` has no Haven row.
6. Report every backup path, removed entry and scope, both config-scan results, credential-directory result, and list result.

Do not continue unless all three checks are clean.

## Reconnect And Retest

1. Ask the user to restart Claude Code so in-memory MCP connections are dropped.
2. Guide the user to run the published connector:

   ```bash
   npx @haven_ai/connect@alpha --setup <token> --api <url>
   ```

3. Verify the new `~/.haven/agents/<id>/signer.json` contains `x402_binding_signer`. If missing, report the likely deployed backend configuration fault; do not patch it manually.
4. Confirm `haven-signer` is connected and the signer tools are available.
5. Run a small real payment only after separate explicit authorization. Confirm signing and settlement without manual intervention.

Stop and report the failing command and output when any phase fails.
