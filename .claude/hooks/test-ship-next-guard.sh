#!/bin/sh
# Self-test for the ship-next PR guard. Run: sh .claude/hooks/test-ship-next-guard.sh
#
# This exists because the guard's worst failure is SILENCE. A blocking gate that
# breaks is obvious — nothing ships. A warning hook that breaks looks exactly
# like a warning hook with nothing to warn about, so it can rot for months while
# everyone believes it is watching. (It already had that bug once: with
# CLAUDE_PROJECT_DIR unset the command resolved to /.claude/... and the guard
# was installed but inert.)
#
# The negative cases matter as much as the positive ones. A guard that fires on
# every `curl .../pulls` would warn on listing PRs, reading one, or editing a
# body — and a warning that cries wolf gets tuned out, which is the same failure
# as not having it.

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
    printf '  FAIL  %-44s expected %s, got %s\n' "$1" "$2" "$actual"
  fi
}

# --- must warn: these open a pull request -------------------------------
check "mcp create_pull_request" fire '{"tool_name":"mcp__github__create_pull_request","tool_input":{"title":"x"}}'
check "gh pr create" fire '{"tool_name":"Bash","tool_input":{"command":"gh pr create --base dev"}}'
check "curl -X POST /pulls -d" fire '{"tool_name":"Bash","tool_input":{"command":"curl -X POST https://api.github.com/repos/o/r/pulls -d @b.json"}}'
check "curl /pulls --data (implicit POST)" fire '{"tool_name":"Bash","tool_input":{"command":"curl -H a https://api.github.com/repos/o/r/pulls --data @b.json"}}'
check "curl quoted url" fire '{"tool_name":"Bash","tool_input":{"command":"curl -X POST \"https://api.github.com/repos/o/r/pulls\" -d @b.json"}}'

# --- must stay silent: everything else ----------------------------------
check "list PRs (GET collection)" silent '{"tool_name":"Bash","tool_input":{"command":"curl -s https://api.github.com/repos/o/r/pulls?state=open"}}'
check "read one PR" silent '{"tool_name":"Bash","tool_input":{"command":"curl -s https://api.github.com/repos/o/r/pulls/1012"}}'
check "PATCH a PR body" silent '{"tool_name":"Bash","tool_input":{"command":"curl -X PATCH https://api.github.com/repos/o/r/pulls/1012 -d @p.json"}}'
check "read PR reviews" silent '{"tool_name":"Bash","tool_input":{"command":"curl -s https://api.github.com/repos/o/r/pulls/1012/reviews"}}'
check "git push" silent '{"tool_name":"Bash","tool_input":{"command":"git push origin HEAD"}}'
check "unrelated MCP tool" silent '{"tool_name":"mcp__github__add_issue_comment","tool_input":{"body":"hi"}}'

# --- must never crash ---------------------------------------------------
check "empty stdin" silent ''
check "malformed json" silent 'not json'
check "missing tool_input" silent '{"tool_name":"Bash"}'


# --- text ABOUT the workflow is not an invocation (the guard fired on the
# --- very commit that introduced it, because the message described it) ------
check "heredoc commit msg mentioning gh pr create" silent '{"tool_name":"Bash","tool_input":{"command":"cat > /tmp/m.txt <<MSG\nguard on PR creation (gh pr create, curl POST to /pulls)\nMSG\ngit commit -F /tmp/m.txt"}}'
check "heredoc mentioning curl POST /pulls -d" silent '{"tool_name":"Bash","tool_input":{"command":"cat > d.md <<EOF\nrun: curl -X POST https://api.github.com/repos/o/r/pulls -d @b.json\nEOF"}}'
check "quoted heredoc delimiter" silent '{"tool_name":"Bash","tool_input":{"command":"cat > f <<\u0027EOF\u0027\ngh pr create --base dev\nEOF"}}'
check "real create AFTER a heredoc block" fire '{"tool_name":"Bash","tool_input":{"command":"cat > /tmp/b.md <<EOF\nsome body\nEOF\ngh pr create --body-file /tmp/b.md"}}'

# --- the warning must carry the gates, not just a pointer ---------------
body=$(printf '%s' '{"tool_name":"mcp__github__create_pull_request"}' | sh "$GUARD" 2>/dev/null \
  | jq -r '.hookSpecificOutput.additionalContext' 2>/dev/null)
for needle in "CODEOWNERS" "coupling-gate.mjs" "origin/dev" "docs:check"; do
  case "$body" in
    *"$needle"*) pass=$((pass + 1)) ;;
    *) fail=$((fail + 1)); printf '  FAIL  warning text is missing: %s\n' "$needle" ;;
  esac
done

printf '\nship-next guard: %d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
