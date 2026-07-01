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
4. Delete `~/.haven` only within the explicitly requested reset.
5. Verify the relevant configuration scopes, credential directory, and client MCP listing are all clean.
6. Report exactly what was removed. Do not call the slate clean while any Haven entry remains.
7. Guide a fresh published connector setup and restart the client.
8. Verify that the signer and `x402_binding_signer` were provisioned without manual patching.
9. Treat a real payment smoke check as a separate money-moving action. Execute it only when the user explicitly authorizes that payment; otherwise provide the command and expected result.

Stop at the first failed phase and report its output. Never hand-patch a missing binding signer: report the deployment/configuration fault instead.
