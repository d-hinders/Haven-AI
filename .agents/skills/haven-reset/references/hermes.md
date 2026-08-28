# Hermes Agent reset procedure

Use this procedure only when the active client is Hermes Agent and the user explicitly requested a reset. Hermes has a YAML MCP configuration **and** a dotenv API-key entry; remove both. Leaving the dotenv key behind can make a later setup quote as one agent while an old signer still signs as another.

The default Hermes home is `~/.hermes`. If `HERMES_HOME` is set, use that directory instead. The two files to inspect are:

- `$HERMES_HOME/config.yaml`
- `$HERMES_HOME/.env`

## Reset

1. Back up each existing Hermes file before changing it. Keep the backups until the reset is verified:

   ```bash
   reset_hermes_home="${HERMES_HOME:-$HOME/.hermes}"
   reset_stamp=$(date +%Y%m%d-%H%M%S)
   cp -p "$reset_hermes_home/config.yaml" "$reset_hermes_home/config.yaml.haven-reset-$reset_stamp.bak"
   cp -p "$reset_hermes_home/.env" "$reset_hermes_home/.env.haven-reset-$reset_stamp.bak"
   ```

   Run each `cp` only when its source file exists. Do not print or paste the dotenv file: it contains credentials.

2. In `$HERMES_HOME/config.yaml`, remove the complete Haven pair from `mcp_servers`; do not remove or rewrite unrelated servers.

   - The unnamed pair is `haven` and `haven-signer`.
   - A named pair for slug `<slug>` is `haven-<slug>` and `haven-signer-<slug>`.

   For an unnamed setup, the entries have this shape (paths and URLs vary):

   ```yaml
   mcp_servers:
     haven:
       url: <hosted-mcp-url>
       headers:
         Authorization: Bearer ${MCP_HAVEN_API_KEY}
       enabled: true
     haven-signer:
       command: <agent-credential-directory>/bin/haven-signer.mjs
       args: []
       enabled: true
   ```

   A named setup uses the same shape under its two suffixed names. An unnamed `haven` name alone does **not** identify which agent is live; confirm the signer wrapper path before deleting that credential directory.

3. In `$HERMES_HOME/.env`, remove the exact API-key assignment for the pair you removed. This is a required reset step, not a cleanup note:

   - Unnamed pair: `MCP_HAVEN_API_KEY`
   - Named pair: `MCP_HAVEN_<SLUG>_API_KEY`, where `<SLUG>` is uppercased and each hyphen becomes `_` (for example, `research-west` becomes `MCP_HAVEN_RESEARCH_WEST_API_KEY`).

   Delete the assignment line only. Preserve unrelated dotenv entries, and never copy the key into a command, issue, or chat.

4. Tombstone every Haven credential directory before removing its key material. **Enumerate the directories — do not build a path from an agent id.** `ls ~/.haven/agents` lists them, and `--doctor --json` reports each one's `directory`. A named agent lives at its wiring **slug**, which never equals its agent id ([#1696](https://github.com/d-hinders/Haven-AI/issues/1696)); a path built from an id simply does not exist for it, and the command refuses with `tombstone_directory_not_found` rather than retiring anything. For each real directory, run:

   ```bash
   npx @haven_ai/connect@alpha --tombstone <directory> --reason "haven-reset" --json
   ```

   **Check the result before deleting anything.** Success is exit 0 with `{"tombstoned": true, …}` on stdout; a refusal is exit 1 with `{"tombstoned": false, "error": {"code": …}}` on stdout and the prose on stderr. Confirm `TOMBSTONE.json` is present in the directory (`test -f <directory>/TOMBSTONE.json`). Do not proceed on the absence of visible output — a harness that stopped reading the stream sees the same nothing either way ([#2175](https://github.com/d-hinders/Haven-AI/issues/2175)).

   Only after that verification, delete the directory's `identity.json`, `signer.json`, `signer-runtime.json`, and other runtime/key files. Preserve `bin/haven-signer.mjs` and `TOMBSTONE.json`: a process started before the reset may still invoke that old path, and the tombstone names the retired agent instead of masking the failure as a closed connection. A tombstone does not revoke an agent; revoke it on the Haven agent page if its authority must end.

5. Restart **every** long-lived Hermes host that could have loaded the former configuration. Start a new session for a normal Hermes session. In Hermes Gateway, run `/restart` instead. Restarting one session or one Gateway is not evidence that the machine is clean: each gateway, TUI worker, editor, or other long-lived host keeps the MCP wiring snapshot it had at startup and can be parked on a different retired agent.

## Verify

1. Inspect `$HERMES_HOME/config.yaml` and confirm no removed `haven` / `haven-signer` pair, or named `haven-<slug>` / `haven-signer-<slug>` pair, remains under `mcp_servers`.
2. Inspect `$HERMES_HOME/.env` without exposing its values and confirm its corresponding `MCP_HAVEN…_API_KEY` assignment is gone.
3. Run the runtime-aware diagnostic as an inventory check:

   ```bash
   npx @haven_ai/connect@alpha --doctor --runtime hermes
   ```

   After a full credential reset, this command normally exits non-zero because there is no remaining `identity.json` / `signer.json`; that is expected until fresh setup. Verify that it names no live `superseded` credential directory and reports preserved tombstone directories as `retired`. If a wired Haven pair intentionally remains, its `identity_match` check must pass. That check proves the hosted API identity and local signing key belong to the same agent. A failed `identity_match` means Hermes would quote as one agent and sign as another; stop and resolve it rather than reconnecting or paying.
4. Treat any remaining usable credential directory that is no longer referenced by Hermes as a `superseded` finding, not a clean slate. Tombstone it first, then remove its key material and re-run `--doctor`. A tombstoned directory whose keys are gone is reported as `retired`; keep that tombstone until every long-lived host has restarted.

Do not continue to reconnect until the configuration and credential inventory match the reset you performed. If YAML cannot be safely edited or the diagnostic reports a mismatch, stop and report the failing step rather than hand-patching credentials.

## Reconnect And Retest

1. Run the published connector to create a fresh pair:

   ```bash
   npx @haven_ai/connect@alpha --setup <token> --api <url> --runtime hermes
   ```

2. Start a new Hermes session, or run `/restart` in every Hermes Gateway that will use the new pair.
3. Run `npx @haven_ai/connect@alpha --doctor --runtime hermes` again. A clean reconnection report exits zero, `identity_match` passes, and no `superseded` agent is named. Retained tombstone directories may still be reported as `retired` until every long-lived host has restarted.
4. Run a real payment only after separate explicit authorization. Do not use a reset or reconnect request as payment authorization.
