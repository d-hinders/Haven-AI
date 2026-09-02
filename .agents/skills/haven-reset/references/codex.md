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
4. Delete `~/.haven` — but **not before** the tombstone step. This procedure does not
   restate it: follow [SKILL.md](../SKILL.md) *Required Sequence* step 4, which
   enumerates the real agent directories (never a path built from an agent id — a
   named agent's directory is its slug, [#1696](https://github.com/d-hinders/Haven-AI/issues/1696)),
   tombstones each one, and **verifies** `{"tombstoned": true}` and the presence of
   `TOMBSTONE.json` before any key material is deleted. Deleting `~/.haven` outright
   first destroys the very record a stale long-lived host needs in order to say which
   agent it is parked on ([#2175](https://github.com/d-hinders/Haven-AI/issues/2175)).

`codex mcp remove` is verified for the user configuration. Inspect a repository-local `.codex/config.toml` when present, but do not mutate it automatically: stop and give the exact remaining table and file path because project-scope removal is not verified by this procedure.

## Verify

1. Confirm `~/.codex/config.toml` has no `[mcp_servers.haven]`, `[mcp_servers.haven_signer]`, stale `[mcp_servers.haven-signer]`, or descendant table.
2. Confirm `~/.haven` holds no live credential material — `identity.json`,
   `signer.json` and runtime files gone from every agent directory. A retired
   directory that still holds `bin/haven-signer.mjs` and `TOMBSTONE.json` is
   **correct, not residue**: `SKILL.md` *Required Sequence* step 4 preserves it
   deliberately so a stale long-lived host can name the agent it is parked on.
   `npx @haven_ai/connect@alpha --doctor --runtime codex` reports such a
   directory as `retired`; that is a clean result. Do **not** delete `~/.haven`
   outright to make this check read "absent" — that destroys the diagnosis this
   reset exists to leave behind ([#2175](https://github.com/d-hinders/Haven-AI/issues/2175)).
   Full absence is correct only after the user confirms every long-lived host
   has restarted, per step 4's own condition.
3. Confirm `codex mcp list` has no Haven row.
4. Report the backup path, removed entries, credential-directory result, user-config scan, project-config scan, and list result.

Do not continue unless every relevant scope is clean.

## Reconnect And Retest

1. Ask the user to restart the Codex session so configuration is reloaded.
2. Guide the user to run the published connector:

   ```bash
   npx -y <connector_package> --setup <token> --api <url>
   (Use the package the target backend's own setup response names — its `connector_package`,
   which is also the package named inside its `connector_command`. Since #2422 that dist-tag is
   set per deployment by `HAVEN_CONNECTOR_CHANNEL` and is `@alpha` only in production; pinning
   `@alpha` by hand against a `@dev` backend installs a signer that skews against it.)
   ```

3. Verify the new `~/.haven/agents/<id>/signer.json` contains `x402_binding_signer`. If missing, report the likely deployed backend configuration fault; do not patch it manually.
4. Confirm `codex mcp list` shows `haven` and `haven_signer` connected and the signer tools are available.
5. Run a small real payment only after separate explicit authorization. Confirm signing and settlement without manual intervention.

Stop and report the failing command and output when any phase fails.
