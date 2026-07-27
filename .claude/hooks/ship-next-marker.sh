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
# Either one is sufficient; both firing is harmless (see dedupe below).
#
# ## The marker is a LIST OF ISSUE TOKENS, not a single flag (#1028)
#
# It used to be an empty file that the guard CONSUMED — a session-level fact
# used to answer a per-PR question. Whether the 2nd PR of a session warned then
# depended on incidental ordering between this writer and the guard, not on
# whether the workflow was followed. (An earlier version of this comment claimed
# the failure was "observed on PR #1027"; it was not — the old writer re-created
# the marker each invocation. The defect is structural, and review was right to
# press on the unsupported claim.)
#
# Now each invocation appends a TOKEN:
#   * the issue number, when the invocation names one (`/ship-next 1030`);
#   * `*` otherwise (`/ship-next`, `label=…`, `epic=#…`, a freeform task) —
#     the issue is not knowable until the skill selects it.
#
# The guard reads `Closes #N` off the pull request and clears the matching
# token, falling back to one `*`. So a hand-rolled PR in a ship-next session
# still warns, which was the point of consuming in the first place.
#
# ## Dedupe, and the limitation it leaves
#
# A token is appended only if not already present. That makes the two events
# above idempotent for one invocation. The cost: two consecutive NO-ARGUMENT
# invocations share a single `*`, so the second PR warns. That is a real
# residual gap, and it is deliberately on the NOISY side — a spurious warning
# costs a moment's annoyance, a spurious silence costs the whole guard.
#
# Fails open (exit 0) like every hook here, and note the asymmetry that matters:
# failing to WRITE a token can never silence the guard, because silence requires
# a token to be positively present.

set -u

input=$(cat 2>/dev/null) || exit 0
[ -n "$input" ] || exit 0

event=$(printf '%s' "$input" | jq -r '.hook_event_name // ""' 2>/dev/null) || exit 0
tool=$(printf '%s' "$input" | jq -r '.tool_name // ""' 2>/dev/null) || tool=""
skill=$(printf '%s' "$input" | jq -r '.tool_input.skill // ""' 2>/dev/null) || skill=""
args=$(printf '%s' "$input" | jq -r '.tool_input.args // ""' 2>/dev/null) || args=""
prompt=$(printf '%s' "$input" | jq -r '.prompt // ""' 2>/dev/null) || prompt=""
session=$(printf '%s' "$input" | jq -r '.session_id // ""' 2>/dev/null) || exit 0

# No session id means no safe key. Do nothing — the guard will warn, which is
# the correct direction to fail.
[ -n "$session" ] || exit 0

driving=0
raw=""
if [ "$tool" = "Skill" ] && [ "$skill" = "ship-next" ]; then
  driving=1
  raw="$args"
fi
case "$prompt" in
  /ship-next|/ship-next[[:space:]]*)
    driving=1
    # Everything after the command name, if anything.
    raw=$(printf '%s' "$prompt" | sed -e 's|^/ship-next[[:space:]]*||' 2>/dev/null) || raw=""
    ;;
esac
# Guard against an unexpected event shape writing a token off a stray field.
[ "$event" = "PreToolUse" ] || [ "$event" = "UserPromptSubmit" ] || driving=0

[ "$driving" -eq 1 ] || exit 0

# A BARE issue number — digits and nothing else — is the only form that names
# an issue up front. The class below used to admit SPACES, so `/ship-next 10 30`
# became token `1030` and would have silenced a real PR closing #1030. `label=…`,
# `epic=#…` and a quoted freeform task all resolve to an issue the skill picks
# later, so they get the wildcard. Digits-only on purpose: matching the `5` out
# of `epic=#5` would clear a token for an unrelated issue.
token='*'
case "$raw" in
  '') token='*' ;;
  *[!0-9]*) token='*' ;;
  *)
    n=$(printf '%s' "$raw" | tr -cd '0-9')
    [ -n "$n" ] && token="$n"
    ;;
esac

# Sanitize: session_id becomes part of a path.
safe=$(printf '%s' "$session" | tr -c 'A-Za-z0-9_-' '_' 2>/dev/null) || exit 0
[ -n "$safe" ] || exit 0
marker="${TMPDIR:-/tmp}/claude-ship-next-$safe"

# Append unless already present. `grep -Fx` is an exact WHOLE-LINE match, so
# token 103 never collides with 1030.
if [ -f "$marker" ] && grep -Fxq "$token" "$marker" 2>/dev/null; then
  exit 0
fi
printf '%s\n' "$token" >> "$marker" 2>/dev/null || true
exit 0
