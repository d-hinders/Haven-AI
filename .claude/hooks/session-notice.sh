#!/bin/sh
# SessionStart notice: state the shipping rule where it will actually be read.
#
# CLAUDE.md already says this — on line 304 of 304. That placement is the
# problem: it arrives at the bottom of a long file, and a session that begins as
# analysis or discussion drifts into shipping without ever passing a point that
# forces a re-read. This puts it at the top, every time, in three lines.
#
# Fails open: any error exits 0 and the session starts normally.

set -u

# Clear stale ship-next markers. They are session_id-keyed so they cannot leak
# between sessions by construction, but a crashed session leaves the file
# behind; prune anything older than a day so /tmp does not accumulate.
find "${TMPDIR:-/tmp}" -maxdepth 1 -name 'claude-ship-next-*' -mtime +0 -delete 2>/dev/null || true

jq -n '{
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext: "Haven shipping rule: shipping a GitHub issue goes through /ship-next (.agents/skills/ship-next/SKILL.md) — it loads the right playbook, runs the acceptance gate and the doc-reviewer step, and routes the merge (a db/migrations/ diff needs an INDEPENDENT code-owner approval; the PR authors own approval does not count). A PreToolUse hook warns, but does not block, if a PR is opened outside it."
  }
}' 2>/dev/null || exit 0

exit 0
