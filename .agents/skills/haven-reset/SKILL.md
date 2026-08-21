---
name: haven-reset
description: Safely reset a local Haven MCP and credential setup, verify a clean slate, guide reconnection, and optionally perform an explicitly authorized payment smoke check. Use when a user asks to reset, remove, clean, reconnect, or retest Haven in a supported agent client.
---

# Haven Reset

Reset the active client without guessing its configuration model.

## Select A Verified Client Procedure

- For Claude Code, read and follow [references/claude-code.md](references/claude-code.md).
- For Codex CLI or Desktop, read and follow [references/codex.md](references/codex.md).
- For any other client, stop and identify the unsupported client. Do not edit an assumed configuration path.

Read the selected client reference completely before changing state.

## Required Sequence

1. Confirm that the user explicitly requested destructive reset. A request to diagnose, inspect, or reconnect alone does not authorize credential deletion.
2. Back up every configuration file the verified procedure will mutate.
3. Remove both the Haven service and local signer entries using the client's supported configuration command.
4. Before deleting anything under `~/.haven`, tombstone each agent credential directory: `npx @haven_ai/connect@alpha --tombstone ~/.haven/agents/<id> --reason "haven-reset"`. Then delete the key material (`identity.json`, `signer.json`, runtime files) but PRESERVE each directory's `bin/haven-signer.mjs` tombstone and `TOMBSTONE.json`. A long-lived MCP host that started before the reset keeps spawning the old wrapper path; the tombstone converts its masked "Connection closed" into a logged diagnosis naming the retirement. Delete the tombstones themselves only when the user confirms every long-lived host has been restarted (a fully clean `~/.haven` removal is then fine).
5. Instruct the user to restart EVERY long-lived MCP host (gateways, TUI workers, editors, desktop apps) — each holds the MCP wiring snapshot from its own start time, so after a chain of setups each process can be parked on a DIFFERENT retired agent. One restart of one host is not sufficient evidence the machine is clean.
6. Verify the relevant configuration scopes, credential directory, and client MCP listing are all clean.
7. Report exactly what was removed. Do not call the slate clean while any Haven entry remains.
8. Guide a fresh published connector setup and restart the client.
9. Verify that the signer and `x402_binding_signer` were provisioned without manual patching.
10. Treat a real payment smoke check as a separate money-moving action. Execute it only when the user explicitly authorizes that payment; otherwise provide the command and expected result.

Stop at the first failed phase and report its output. Never hand-patch a missing binding signer: report the deployment/configuration fault instead.
