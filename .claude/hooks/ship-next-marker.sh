#!/bin/sh
# Records that /ship-next is driving THIS session, so the PR guard can stay
# silent on a compliant pull request.
#
# ## Why a hook writes this and not the skill
#
# The obvious implementation is a line in ship-next's SKILL.md telling the agent
# to touch a marker. That reintroduces the exact bug this whole line of work
# exists to fix: #1016 shipped because instructions the model must REMEMBER are
# what failed, twice. A marker the model has to remember to write is the same
# class of thing. So the harness writes it, from two independent events:
#
#   * PreToolUse on the `Skill` tool where `.tool_input.skill` is ship-next —
#     covers the model invoking the skill.
#   * UserPromptSubmit where the prompt starts with `/ship-next` — covers the
#     harness expanding the slash command WITHOUT a Skill tool call, which the
#     first path alone would miss.
#
# Either one is sufficient; both firing is harmless (the marker is idempotent).
#
# ## The marker is session-scoped and single-use
#
# Keyed on `session_id` from the hook payload, so it cannot leak between
# sessions by construction. The PR guard CONSUMES it: ship-next ships exactly
# one issue per invocation, so consuming gives per-PR precision — a second,
# hand-rolled PR in the same session still warns.
#
# Fails open (exit 0) like every hook here. Note the asymmetry that matters:
# failing to WRITE the marker costs a spurious warning, which is merely
# annoying. Failing to write it can never silence the guard — silence requires
# the marker to be positively present. That direction is deliberate.

set -u

input=$(cat 2>/dev/null) || exit 0
[ -n "$input" ] || exit 0

event=$(printf '%s' "$input" | jq -r '.hook_event_name // ""' 2>/dev/null) || exit 0
tool=$(printf '%s' "$input" | jq -r '.tool_name // ""' 2>/dev/null) || tool=""
skill=$(printf '%s' "$input" | jq -r '.tool_input.skill // ""' 2>/dev/null) || skill=""
prompt=$(printf '%s' "$input" | jq -r '.prompt // ""' 2>/dev/null) || prompt=""
session=$(printf '%s' "$input" | jq -r '.session_id // ""' 2>/dev/null) || exit 0

# No session id means no safe key. Do nothing — the guard will warn, which is
# the correct direction to fail.
[ -n "$session" ] || exit 0

driving=0
[ "$tool" = "Skill" ] && [ "$skill" = "ship-next" ] && driving=1
case "$prompt" in
  /ship-next|/ship-next[[:space:]]*) driving=1 ;;
esac
# Guard against an unexpected event shape writing a marker off a stray field.
[ "$event" = "PreToolUse" ] || [ "$event" = "UserPromptSubmit" ] || driving=0

[ "$driving" -eq 1 ] || exit 0

# Sanitize: session_id becomes part of a path.
safe=$(printf '%s' "$session" | tr -c 'A-Za-z0-9_-' '_' 2>/dev/null) || exit 0
[ -n "$safe" ] || exit 0

: > "${TMPDIR:-/tmp}/claude-ship-next-$safe" 2>/dev/null || true
exit 0
