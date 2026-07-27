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
mkrm() { rm -f "$MARKER_DIR/claude-ship-next-$1"; }      # clear marker
mkhas() { [ -f "$MARKER_DIR/claude-ship-next-$1" ]; }    # marker still there?
# Write tokens, one per line: mktok sess1 1030 '*'
mktok() { s=$1; shift; : > "$MARKER_DIR/claude-ship-next-$s"; for tk in "$@"; do printf '%s\n' "$tk" >> "$MARKER_DIR/claude-ship-next-$s"; done; }
# Does the marker still hold this exact token?
mkhastok() { grep -Fxq "$2" "$MARKER_DIR/claude-ship-next-$1" 2>/dev/null; }
mkcount() { [ -f "$MARKER_DIR/claude-ship-next-$1" ] && grep -c . "$MARKER_DIR/claude-ship-next-$1" 2>/dev/null || echo 0; }
WRITER="$(dirname "$0")/ship-next-marker.sh"
# A PR payload. $2 = issue it closes (optional).
# NOTE: no \n in the body — printf would turn it into a REAL newline inside a
# JSON string, making the payload invalid. The guard then takes its fail-noisy
# unparseable path and never reaches the marker logic, so every marker test
# would pass-or-fail for the wrong reason. Cost an hour once; don't reintroduce.
pr() { if [ -n "${2:-}" ]; then printf '{"session_id":"%s","tool_name":"mcp__github__create_pull_request","tool_input":{"body":"does things. Closes #%s"}}' "$1" "$2"; else printf '{"session_id":"%s","tool_name":"mcp__github__create_pull_request","tool_input":{}}' "$1"; fi; }

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


# --- #1018/#1028: silent when /ship-next is actually driving --------------
mkrm sess1
check "no marker -> warns (unchanged)" fire "$(pr sess1 1030)"

mktok sess1 1030
check "matching issue token -> SILENT (compliant PR)" silent "$(pr sess1 1030)"
if mkhastok sess1 1030; then fail=$((fail+1)); printf '  FAIL  token was not cleared\n'; else pass=$((pass+1)); fi
check "token cleared -> same PR again warns" fire "$(pr sess1 1030)"

# THE #1028 REGRESSION. Two issues shipped in one session: BOTH must be silent.
# The old single-flag marker was consumed by the first, so the second warned on
# a compliant PR — observed on PR #1027.
mktok sess1 1023 1024
check "#1028: 1st of two issues -> silent" silent "$(pr sess1 1023)"
check "#1028: 2nd of two issues -> ALSO silent" silent "$(pr sess1 1024)"
check "#1028: a third, unlisted issue -> warns" fire "$(pr sess1 9999)"
mkrm sess1

# A token for a DIFFERENT issue must not silence this PR — that would make the
# guard silent for any PR once ship-next ran once, which is the whole hole.
mktok sess1 1023
check "non-matching issue token -> warns" fire "$(pr sess1 1024)"
if mkhastok sess1 1023; then pass=$((pass+1)); else fail=$((fail+1)); printf '  FAIL  a warning consumed an unrelated token\n'; fi
mkrm sess1

# Prefix collisions: 103 must not clear 1030, and vice versa.
mktok sess1 1030
check "token 1030 is not matched by issue 103" fire "$(pr sess1 103)"
mkrm sess1
mktok sess1 103
check "token 103 is not matched by issue 1030" fire "$(pr sess1 1030)"
mkrm sess1

# Wildcard: an invocation that could not name an issue up front.
mktok sess1 '*'
check "wildcard token covers a PR with any issue" silent "$(pr sess1 777)"
check "wildcard consumed -> next PR warns" fire "$(pr sess1 778)"
mkrm sess1

mktok sess1 '*'
check "wildcard covers a PR with NO Closes line" silent "$(pr sess1)"
mkrm sess1

# An exact token is preferred over the wildcard, so the wildcard survives for
# the PR that actually needs it.
mktok sess1 1030 '*'
check "exact token wins over wildcard" silent "$(pr sess1 1030)"
if mkhastok sess1 '*'; then pass=$((pass+1)); else fail=$((fail+1)); printf '  FAIL  wildcard was spent on a PR with an exact token\n'; fi
check "wildcard still covers the next PR" silent "$(pr sess1 4242)"
mkrm sess1

# Only ONE occurrence is cleared per PR.
mktok sess1 '*' '*'
check "two wildcards: 1st PR silent" silent "$(pr sess1 1)"
check "two wildcards: 2nd PR silent" silent "$(pr sess1 2)"
check "two wildcards: 3rd PR warns" fire "$(pr sess1 3)"
mkrm sess1

# Other closing keywords GitHub honours.
for kw in Closes closes Fixes fixed Resolves resolved; do
  mktok sess1 555
  body=$(printf '{"session_id":"sess1","tool_name":"mcp__github__create_pull_request","tool_input":{"body":"%s #555"}}' "$kw")
  check "closing keyword '$kw' is recognised" silent "$body"
  mkrm sess1
done

# An empty marker file holds no tokens — it must NOT silence anything. The old
# design treated mere existence as permission.
mktok sess1
check "empty marker file does not silence" fire "$(pr sess1 1030)"
mkrm sess1

# Cross-session isolation: another session's marker must not silence this one.
mkrm sess1; mktok sess2 1030
check "other session's token does not silence" fire "$(pr sess1 1030)"
mkrm sess2

# --- the asymmetry: broken marker machinery must WARN, never silence ------
check "missing session_id -> warns" fire '{"tool_name":"mcp__github__create_pull_request","tool_input":{}}'
check "empty session_id -> warns" fire '{"session_id":"","tool_name":"mcp__github__create_pull_request","tool_input":{}}'
# A session_id that sanitizes to a path-traversal attempt must not resolve to
# some other file that happens to exist.
check "path-traversal session_id -> warns" fire "$(pr '../../etc/passwd')"


# --- the last silence path: an unparseable payload that IS a PR creation --
# Found by review, outside the scope it was asked to check. The top-level jq
# extraction used to `|| exit 0`, bypassing the marker gate entirely — so the
# documented "can never fail toward silence" property was not actually true.
check "malformed payload naming create_pull_request" fire '{"session_id":"x","tool_name":BROKEN,"create_pull_request"'
check "malformed payload containing gh pr create" fire '{"session_id":"x",BROKEN gh pr create'
# ...but an unidentifiable payload must still stay quiet, or every unparseable
# tool call becomes noise and the guard gets muted that way instead.
check "malformed payload, nothing PR-shaped" silent 'not json at all'
check "no tool_name, nothing PR-shaped" silent '{"session_id":"x"}'

# --- the writer sets the marker from BOTH paths --------------------------
mkrm wsess
printf '{"session_id":"wsess","hook_event_name":"PreToolUse","tool_name":"Skill","tool_input":{"skill":"ship-next","args":"1030"}}' | sh "$WRITER" 2>/dev/null
if mkhastok wsess 1030; then pass=$((pass+1)); else fail=$((fail+1)); printf '  FAIL  Skill-tool path did not record issue 1030\n'; fi
mkrm wsess

printf '{"session_id":"wsess","hook_event_name":"UserPromptSubmit","prompt":"/ship-next 1018"}' | sh "$WRITER" 2>/dev/null
if mkhastok wsess 1018; then pass=$((pass+1)); else fail=$((fail+1)); printf '  FAIL  /ship-next prompt path did not record issue 1018\n'; fi
mkrm wsess

# No argument, or an argument that does not NAME an issue, gets the wildcard.
for p in '/ship-next' '/ship-next label=code-quality' '/ship-next epic=#5' '/ship-next "add a copy button"'; do
  mkrm wsess
  printf '{"session_id":"wsess","hook_event_name":"UserPromptSubmit","prompt":%s}' "$(printf '%s' "$p" | jq -Rs .)" | sh "$WRITER" 2>/dev/null
  if mkhastok wsess '*'; then pass=$((pass+1)); else fail=$((fail+1)); printf '  FAIL  expected wildcard for: %s\n' "$p"; fi
done
mkrm wsess

# `epic=#5` must NOT record issue 5 — that would clear a token for an
# unrelated issue and silence a PR it should have warned on.
printf '{"session_id":"wsess","hook_event_name":"UserPromptSubmit","prompt":"/ship-next epic=#5"}' | sh "$WRITER" 2>/dev/null
if mkhastok wsess 5; then fail=$((fail+1)); printf '  FAIL  epic=#5 was recorded as issue 5\n'; else pass=$((pass+1)); fi
mkrm wsess

# Dedupe: the two events for ONE invocation must not add two tokens.
printf '{"session_id":"wsess","hook_event_name":"UserPromptSubmit","prompt":"/ship-next 1030"}' | sh "$WRITER" 2>/dev/null
printf '{"session_id":"wsess","hook_event_name":"PreToolUse","tool_name":"Skill","tool_input":{"skill":"ship-next","args":"1030"}}' | sh "$WRITER" 2>/dev/null
if [ "$(mkcount wsess)" = "1" ]; then pass=$((pass+1)); else fail=$((fail+1)); printf '  FAIL  double-fire wrote %s tokens, expected 1\n' "$(mkcount wsess)"; fi
mkrm wsess

# Two DIFFERENT issues accumulate — this is what fixes #1028.
printf '{"session_id":"wsess","hook_event_name":"UserPromptSubmit","prompt":"/ship-next 1023"}' | sh "$WRITER" 2>/dev/null
printf '{"session_id":"wsess","hook_event_name":"UserPromptSubmit","prompt":"/ship-next 1024"}' | sh "$WRITER" 2>/dev/null
if mkhastok wsess 1023 && mkhastok wsess 1024; then pass=$((pass+1)); else fail=$((fail+1)); printf '  FAIL  two invocations did not accumulate tokens\n'; fi
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
