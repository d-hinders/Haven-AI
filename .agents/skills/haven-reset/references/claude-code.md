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

3. Delete `~/.haven` — but **not before** the tombstone step. This procedure does not
   restate it: follow [SKILL.md](../SKILL.md) *Required Sequence* step 4, which
   enumerates the real agent directories (never a path built from an agent id — a
   named agent's directory is its slug, [#1696](https://github.com/d-hinders/Haven-AI/issues/1696)),
   tombstones each one, and **verifies** `{"tombstoned": true}` and the presence of
   `TOMBSTONE.json` before any key material is deleted. Deleting `~/.haven` outright
   first destroys the very record a stale long-lived host needs in order to say which
   agent it is parked on ([#2175](https://github.com/d-hinders/Haven-AI/issues/2175)).

## Verify

1. Inspect `~/.claude.json` and confirm no key under `mcpServers` matches `haven` case-insensitively.
2. Inspect the repository `.mcp.json` when present and confirm its `mcpServers` contains no Haven entry.
3. If a stale hand-edited entry remains, restore safety by removing only that verified Haven entry from the corresponding backed-up config structure, then inspect both files again.
4. Confirm `~/.haven` holds no live credential material — `identity.json`,
   `signer.json` and runtime files gone from every agent directory. A retired
   directory that still holds `bin/haven-signer.mjs` and `TOMBSTONE.json` is
   **correct, not residue**: `SKILL.md` *Required Sequence* step 4 preserves it
   deliberately so a stale long-lived host can name the agent it is parked on.
   `npx @haven_ai/connect@alpha --doctor --runtime claude-code` reports such a
   directory as `retired`; that is a clean result. Do **not** delete `~/.haven`
   outright to make this check read "absent" — that destroys the diagnosis this
   reset exists to leave behind ([#2175](https://github.com/d-hinders/Haven-AI/issues/2175)).
   Full absence is correct only after the user confirms every long-lived host
   has restarted, per step 4's own condition.
5. Confirm `claude mcp list` has no Haven row.
6. Report every backup path, removed entry and scope, both config-scan results, credential-directory result, and list result.

Do not continue unless all three checks are clean.

## Reconnect And Retest

1. Ask the user to restart Claude Code so in-memory MCP connections are dropped.
2. Guide the user to run the published connector:

   ```bash
   npx -y <connector_package> --setup <token> --api <url>
   ```

   Use the package the target backend's own setup response names — its
   `connector_package`, which is also the package named inside its
   `connector_command`. Since #2422 that dist-tag is set per deployment by
   `HAVEN_CONNECTOR_CHANNEL` and is `@alpha` only in production; pinning
   `@alpha` by hand against a `@dev` backend installs a signer that skews
   against it.

3. Verify the new `~/.haven/agents/<id>/signer.json` contains `x402_binding_signer`. If missing, report the likely deployed backend configuration fault; do not patch it manually.
4. Confirm `haven-signer` is connected and the signer tools are available.
5. Run a small real payment only after separate explicit authorization. Confirm signing and settlement without manual intervention.

Stop and report the failing command and output when any phase fails.
