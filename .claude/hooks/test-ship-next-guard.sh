#!/bin/sh
# Self-test for the ship-next PR guard. Run: sh .claude/hooks/test-ship-next-guard.sh
#
# This exists because the guard's worst failure is SILENCE. A blocking gate that
# breaks is obvious — nothing ships. A warning hook that breaks looks exactly
# like a warning hook with nothing to warn about, so it can rot for months while
# everyone believes it is watching.
#
# The negative cases matter as much as the positive ones. A guard that fires on
# every mention of the workflow gets tuned out, which is the same outcome as not
# having it.
#
# ## Cases are ISOLATED on purpose
#
# A review of the first version mutation-tested it: deleting the verb check, or
# broadening the path-boundary check, left every test green — because each
# "silent" fixture tripped BOTH safeguards at once (a PATCH that also used a
# numbered path), so neither was ever exercised alone. Fixtures below isolate
# one condition at a time. If you add a case, make it fail for exactly one
# reason, or it proves nothing about the condition you think it covers.

set -u
GUARD="$(dirname "$0")/ship-next-guard.sh"
pass=0
fail=0

check() { # name expected(fire|silent) payload
  out=$(printf '%s' "$3" | sh "$GUARD" 2>/dev/null)
  if [ -n "$out" ]; then actual=fire; else actual=silent; fi
  if [ "$actual" = "$2" ]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    printf '  FAIL  %-52s expected %s, got %s\n' "$1" "$2" "$actual"
  fi
}
b() { printf '{"session_id":"testsess","tool_name":"Bash","tool_input":{"command":"%s"}}' "$1"; }
MARKER_DIR="${TMPDIR:-/tmp}"
mk() { : > "$MARKER_DIR/claude-ship-next-$1"; }          # set marker
mkrm() { rm -f "$MARKER_DIR/claude-ship-next-$1"; }      # clear marker
mkhas() { [ -f "$MARKER_DIR/claude-ship-next-$1" ]; }    # marker still there?
WRITER="$(dirname "$0")/ship-next-marker.sh"
pr() { printf '{"session_id":"%s","tool_name":"mcp__github__create_pull_request","tool_input":{}}' "$1"; }

# --- must warn: these open a pull request --------------------------------
check "mcp create_pull_request" fire '{"tool_name":"mcp__github__create_pull_request","tool_input":{"title":"x"}}'
check "gh pr create" fire "$(b 'gh pr create --base dev')"
check "gh pr create after &&" fire "$(b 'git push && gh pr create --base dev')"
check "gh pr create with env prefix" fire "$(b 'GH_TOKEN=x gh pr create --base dev')"
check "curl -X POST /pulls -d" fire "$(b 'curl -X POST https://api.github.com/repos/o/r/pulls -d @b.json')"
check "curl /pulls --data (implicit POST)" fire "$(b 'curl -H a https://api.github.com/repos/o/r/pulls --data @b.json')"
check "curl quoted url" fire "$(b 'curl -X POST \"https://api.github.com/repos/o/r/pulls\" -d @b.json')"
check "httpie POST (no -X token)" fire "$(b 'http POST https://api.github.com/repos/o/r/pulls title=x')"
check "python requests.post" fire "$(b 'python3 -c \"requests.post(\\\"https://api.github.com/repos/o/r/pulls\\\")\"')"
check "node fetch method POST" fire "$(b 'node -e \"fetch(\\\"https://api.github.com/repos/o/r/pulls\\\", {method: \\\"POST\\\"})\"')"

# --- ISOLATED safeguard coverage (each fails for exactly ONE reason) ------
# Verb check alone: bare COLLECTION path + writes, but an explicit PATCH.
check "ISOLATED verb: PATCH on bare collection" silent "$(b 'curl -X PATCH https://api.github.com/repos/o/r/pulls -d @p.json')"
# Path-boundary alone: explicit POST + writes, but a NUMBERED path.
check "ISOLATED path: POST to /pulls/123" silent "$(b 'curl -X POST https://api.github.com/repos/o/r/pulls/123 -d @p.json')"
# Write check alone: bare collection, no verb, no data.
check "ISOLATED write: GET bare collection" silent "$(b 'curl -s https://api.github.com/repos/o/r/pulls')"

# --- must stay silent: reading and editing, not creating ------------------
check "list PRs with query" silent "$(b 'curl -s https://api.github.com/repos/o/r/pulls?state=open')"
check "read one PR" silent "$(b 'curl -s https://api.github.com/repos/o/r/pulls/1012')"
check "read PR reviews" silent "$(b 'curl -s https://api.github.com/repos/o/r/pulls/1012/reviews')"
check "git push" silent "$(b 'git push origin HEAD')"
check "unrelated MCP tool" silent '{"tool_name":"mcp__github__add_issue_comment","tool_input":{"body":"hi"}}'
# Unrelated POST in one segment, unrelated /pulls in another — segmentation
# must stop them combining into a false match.
check "cross-segment: POST elsewhere + /pulls echo" silent "$(b 'curl -X POST https://api.example.com/data -d @p.json && echo saved to /pulls/archive')"

# --- text ABOUT the workflow is not an invocation -------------------------
# The guard fired on the commit that introduced it; then on a one-line -m too.
check "heredoc commit msg mentioning gh pr create" silent "$(b 'cat > /tmp/m.txt <<MSG\nguard on PR creation (gh pr create, curl POST to /pulls)\nMSG\ngit commit -F /tmp/m.txt')"
check "heredoc mentioning curl POST /pulls -d" silent "$(b 'cat > d.md <<EOF\nrun: curl -X POST https://api.github.com/repos/o/r/pulls -d @b.json\nEOF')"
check "quoted heredoc delimiter" silent "$(b 'cat > f <<'EOF'\ngh pr create --base dev\nEOF')"
check "git commit -m mentioning it" silent "$(b 'git commit -m \"explain gh pr create in the docs\"')"
check "echo mentioning it" silent "$(b 'echo \"run gh pr create when ready\"')"
check "shell comment mentioning it" silent "$(b 'ls # gh pr create is what ship-next runs')"

# --- heredoc delimiter shapes (a truncated delimiter used to swallow ------
# --- every following command, silently) ----------------------------------
check "delimiter with dot, real create AFTER" fire "$(b 'cat > f <<A.B\nbody\nA.B\ngh pr create --base dev')"
check "delimiter with dash, real create AFTER" fire "$(b 'cat > f <<my-msg\nbody\nmy-msg\ngh pr create --base dev')"
check "quoted delimiter w/ punctuation, create AFTER" fire "$(b 'cat > f <<'E[O]F'\nbody\nE[O]F\ngh pr create --base dev')"
check "plain delimiter, real create AFTER" fire "$(b 'cat > /tmp/b.md <<EOF\nsome body\nEOF\ngh pr create --body-file /tmp/b.md')"
check "<<- with indented terminator" silent "$(b 'cat > f <<-EOF\n\tgh pr create\n\tEOF')"
check "unterminated heredoc does not crash" silent "$(b 'cat > f <<EOF\ngh pr create')"

# --- must never crash -----------------------------------------------------
check "empty stdin" silent ''
check "malformed json" silent 'not json'
check "missing tool_input" silent '{"tool_name":"Bash"}'
check "empty command" silent "$(b '')"


# --- #1018: silent when /ship-next is actually driving --------------------
mkrm sess1
check "no marker -> warns (unchanged)" fire "$(pr sess1)"

mk sess1
check "marker present -> SILENT (compliant PR)" silent "$(pr sess1)"
if mkhas sess1; then fail=$((fail+1)); printf '  FAIL  marker was not CONSUMED\n'; else pass=$((pass+1)); fi
check "marker consumed -> 2nd PR warns again" fire "$(pr sess1)"

# Cross-session isolation: another session's marker must not silence this one.
mkrm sess1; mk sess2
check "other session's marker does not silence" fire "$(pr sess1)"
mkrm sess2

# --- the asymmetry: broken marker machinery must WARN, never silence ------
check "missing session_id -> warns" fire '{"tool_name":"mcp__github__create_pull_request","tool_input":{}}'
check "empty session_id -> warns" fire '{"session_id":"","tool_name":"mcp__github__create_pull_request","tool_input":{}}'
# A session_id that sanitizes to a path-traversal attempt must not resolve to
# some other file that happens to exist.
check "path-traversal session_id -> warns" fire "$(pr '../../etc/passwd')"

# --- the writer sets the marker from BOTH paths --------------------------
mkrm wsess
printf '{"session_id":"wsess","hook_event_name":"PreToolUse","tool_name":"Skill","tool_input":{"skill":"ship-next"}}' | sh "$WRITER" 2>/dev/null
if mkhas wsess; then pass=$((pass+1)); else fail=$((fail+1)); printf '  FAIL  Skill-tool path did not set the marker\n'; fi
mkrm wsess

printf '{"session_id":"wsess","hook_event_name":"UserPromptSubmit","prompt":"/ship-next 1018"}' | sh "$WRITER" 2>/dev/null
if mkhas wsess; then pass=$((pass+1)); else fail=$((fail+1)); printf '  FAIL  /ship-next prompt path did not set the marker\n'; fi
mkrm wsess

# --- the writer must NOT set it for anything else -------------------------
for bad in '{"session_id":"wsess","hook_event_name":"PreToolUse","tool_name":"Skill","tool_input":{"skill":"new-task"}}' \
           '{"session_id":"wsess","hook_event_name":"UserPromptSubmit","prompt":"tell me about /ship-next"}' \
           '{"session_id":"wsess","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"ls"}}' \
           '{"session_id":"wsess","hook_event_name":"SessionStart","prompt":"/ship-next"}'; do
  mkrm wsess
  printf '%s' "$bad" | sh "$WRITER" 2>/dev/null
  if mkhas wsess; then fail=$((fail+1)); printf '  FAIL  writer set marker for: %s\n' "$bad"; else pass=$((pass+1)); fi
done
mkrm wsess
mkrm testsess

# --- the warning must carry the gates, not just a pointer -----------------
body=$(printf '%s' '{"session_id":"gatesess","tool_name":"mcp__github__create_pull_request"}' | sh "$GUARD" 2>/dev/null \
  | jq -r '.hookSpecificOutput.additionalContext' 2>/dev/null)
for needle in "CODEOWNERS" "coupling-gate.mjs" "origin/dev" "docs:check" "scripts/docs/"; do
  case "$body" in
    *"$needle"*) pass=$((pass + 1)) ;;
    *) fail=$((fail + 1)); printf '  FAIL  warning text is missing: %s\n' "$needle" ;;
  esac
done

printf '\nship-next guard: %d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
