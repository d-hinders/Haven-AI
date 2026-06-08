---
description: "Reset Haven agent setup — removes MCP config entries and deletes ~/.haven credentials for a clean test run"
---

Remove all Haven MCP entries from Claude Code and delete local credential files so the user can run a fresh Haven connect setup.

Steps:
1. Run `claude mcp remove haven -s user` (ignore errors if not present)
2. Run `claude mcp remove haven -s local` (ignore errors if not present)
3. Run `claude mcp remove haven -s project` (ignore errors if not present)
4. Run `rm -rf ~/.haven`
5. Confirm each step and report what was removed.
6. Tell the user they are now clean and can paste a new Haven setup command.
