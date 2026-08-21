#!/bin/sh
# PreToolUse: record that an independent reviewer pass ran for this branch.
#
# Pairs with require_reviewer_pass in ship-next-guard.sh, which BLOCKS pull
# request creation when no such record exists.
#
# ## Why the harness records this and not the model
#
# The same argument ship-next-marker.sh makes, and for the same reason it was
# made there: a step the model must REMEMBER is the step that gets skipped.
# The owner has stated the rule repeatedly, AGENTS.md carried it, and the
# ship-next guard's own warning names independent review as item 1 — and it was
# still skipped three times in one session, each time with a fresh-sounding
# reason ("the diff is script-generated", "docs-only"). A rule re-derived per
# pull request is not a rule. So the marker is written by the harness, from the
# act of actually running a reviewer, and nothing the model believes about the
# change can substitute for it.
#
# ## Keyed by BRANCH, not by commit
#
# A stricter key — the head SHA — would demand a fresh reviewer pass after every
# touch-up commit, which trains people to route around the guard. Branch scope
# asks the question the failure was actually about: did an independent pass ever
# look at this work? Reviewing at one commit and then pushing unreviewed FIXES
# is a real gap the guard cannot see, and the ship-next warning already names it
# ("Reviewed findings plus unreviewed fixes is not a reviewed PR"). That part
# stays judgement.
set -u

input=$(cat 2>/dev/null) || exit 0
[ -n "$input" ] || exit 0

event=$(printf '%s' "$input" | jq -r '.hook_event_name // ""' 2>/dev/null) || exit 0
[ "$event" = "PreToolUse" ] || exit 0

tool=$(printf '%s' "$input" | jq -r '.tool_name // ""' 2>/dev/null) || exit 0
case "$tool" in
  Task|Agent) ;;
  *) exit 0 ;;
esac

# ONLY haven-reviewer clears the gate.
#
# An earlier version accepted haven-design-reviewer too, on the reasoning that
# the marker answers "did an independent look happen" rather than "was it the
# right one". Review caught that this contradicts AGENTS.md in the same commit:
# for area:frontend, haven-design-reviewer is a SECOND pass, NOT a replacement.
# Accepting it would have let a pull request satisfy a rule written as
# unconditional while never running haven-reviewer at all — precisely the
# substitution the prose forbids, locked in by a test asserting it as intended.
sub=$(printf '%s' "$input" | jq -r '.tool_input.subagent_type // ""' 2>/dev/null) || sub=""
case "$sub" in
  haven-reviewer) ;;
  *) exit 0 ;;
esac

session=$(printf '%s' "$input" | jq -r '.session_id // ""' 2>/dev/null) || exit 0
[ -n "$session" ] || exit 0
safe=$(printf '%s' "$session" | tr -c 'A-Za-z0-9_-' '_' 2>/dev/null) || exit 0
[ -n "$safe" ] || exit 0

branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null) || exit 0
[ -n "$branch" ] || exit 0
[ "$branch" = "HEAD" ] && exit 0

marker="${TMPDIR:-/tmp}/claude-reviewed-$safe"
if [ -f "$marker" ] && grep -Fxq "$branch" "$marker" 2>/dev/null; then
  exit 0
fi
printf '%s\n' "$branch" >> "$marker" 2>/dev/null || true
exit 0
