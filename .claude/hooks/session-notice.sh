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

# Also prune EMPTY markers, whatever their age. Since #1028 a marker holds one
# token per issue, so a zero-byte file carries no permission and can never
# silence anything — it is either a pre-#1028 leftover or a crashed write.
# Removing it costs nothing and stops a meaningless file looking meaningful.
find "${TMPDIR:-/tmp}" -maxdepth 1 -name 'claude-ship-next-*' -empty -delete 2>/dev/null || true

# Scratch files from the guard's token clear, if one ever dies mid-write. They
# deliberately live OUTSIDE the claude-ship-next-* namespace so they can never
# be read as a marker.
find "${TMPDIR:-/tmp}" -maxdepth 1 -name '.claude-ship-next-scratch-*' -mtime +0 -delete 2>/dev/null || true

jq -n '{
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext: "Haven shipping: /ship-next (.agents/skills/ship-next/SKILL.md) is the DEFAULT ROUTE, not a mandate (#1025) — working differently is allowed. The mechanical standards are CI required checks either way. What the route adds is the layer no check performs: the independent review passes, the covers: doc-reviewer step, playbook routing, and closeout evidence — skip it and you own an equivalent review yourself. Merge routing still matters: a /packages/backend/src/db/migrations/ diff needs an INDEPENDENT code-owner approval, which the PR author cannot supply for their own PR. A PreToolUse hook warns, but does not block, when a PR is opened outside the route."
  }
}' 2>/dev/null || exit 0

exit 0
