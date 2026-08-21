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

# --- reviewer gate: satisfy it for the ship-next cases ----------------------
#
# The guard now BLOCKS pull request creation unless an independent reviewer pass
# is recorded for the branch (reviewer-marker.sh). That is a DIFFERENT policy
# from the ship-next warning these cases measure, and it runs first — so without
# this setup every warning case would be blocked before the warning is reached
# and read as a false "silent". Record a pass for each session the suite uses;
# the reviewer gate has its own cases at the end of this file.
#
# The sanitized names matter: session_id is mapped through
# `tr -c 'A-Za-z0-9_-' '_'`, so `../../etc/passwd` becomes `______etc_passwd`.
TEST_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null) || TEST_BRANCH=""
reviewed() {
  [ -n "$TEST_BRANCH" ] || return 0
  printf '%s\n' "$TEST_BRANCH" > "$MARKER_DIR/claude-reviewed-$1" 2>/dev/null || true
}
unreviewed() { rm -f "$MARKER_DIR/claude-reviewed-$1" 2>/dev/null || true; }
for _s in testsess sess1 sess2 wsess gatesess x ______etc_passwd; do reviewed "$_s"; done
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
# Bash payload for a NAMED session. b() hardcodes `testsess`, which silently
# made marker assertions vacuous — the marker was under sess1, the payload
# under testsess, so nothing could ever match.
bs() { printf '{"session_id":"%s","tool_name":"Bash","tool_input":{"command":%s}}' "$1" "$(printf '%s' "$2" | jq -Rs .)"; }
prbody() { printf '{"session_id":"%s","tool_name":"mcp__github__create_pull_request","tool_input":{"body":"%s"}}' "$1" "$2"; }
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

# --- gaps review found by MUTATION: each of these left 88/88 green ---------
# A safeguard with no test that fails when it is deleted is not covered, however
# many cases surround it.

# 1. The CLOSING KEYWORD is required. A bare `#N` reference must never consume a
#    token — otherwise "as in #1030" in a PR body silences a PR for #1030.
mktok sess1 1030
check "bare '#1030' mention does NOT consume a token" fire "$(prbody sess1 'builds on #1030, see also #1030')"
if mkhastok sess1 1030; then pass=$((pass+1)); else fail=$((fail+1)); printf '  FAIL  a bare mention consumed the token\n'; fi
mkrm sess1

# 2. The issue must come from THIS PR's body, not anywhere in the payload. The
#    Bash route chains commands: a `git commit -m "closes #N"` in one segment
#    must not be read as what the `gh pr create` segment closes.
mktok sess1 1030
check "cross-segment: commit msg does not supply the issue" fire \
  "$(bs sess1 'git commit -m "closes #1030" && gh pr create --title t --body "Closes #999"')"
if mkhastok sess1 1030; then pass=$((pass+1)); else fail=$((fail+1)); printf '  FAIL  a commit message consumed an unrelated token\n'; fi
mkrm sess1

# ...and the PR-creating segment itself DOES supply it.
mktok sess1 999
check "the gh pr create segment does supply the issue" silent \
  "$(bs sess1 'git commit -m "wip" && gh pr create --title t --body "Closes #999"')"
mkrm sess1

# 3. Every failure of the clear operation must fail NOISY. With awk unavailable
#    the guard used to keep the token and silence every later PR in the session.
mktok sess1 '*' '*'
BADAWK="${TMPDIR:-/tmp}/badawk-$$"; mkdir -p "$BADAWK"
printf '#!/bin/sh\nexit 1\n' > "$BADAWK/awk"; chmod +x "$BADAWK/awk"
# Real PATH kept, awk shadowed by a failing stub — otherwise `rm` disappears too
# and the cleanup this test is checking cannot run for an unrelated reason.
printf '%s' "$(pr sess1 500)" | PATH="$BADAWK:$PATH" sh "$GUARD" >/dev/null 2>&1
# The PR that triggered the failure may go either way; what must NOT happen is
# the marker surviving to silence everything after it.
if mkhas sess1; then fail=$((fail+1)); printf '  FAIL  clear-failure left the marker intact (silences later PRs)\n'; else pass=$((pass+1)); fi
check "after a clear-failure, the next PR warns" fire "$(pr sess1 501)"
rm -rf "$BADAWK" 2>/dev/null
mkrm sess1

# 4. No scratch file may be left in the marker namespace — it would be readable
#    and prunable as if it were a marker.
mktok sess1 1030 1031
printf '%s' "$(pr sess1 1030)" | sh "$GUARD" >/dev/null 2>&1
if ls "$MARKER_DIR"/claude-ship-next-sess1.* >/dev/null 2>&1; then
  fail=$((fail+1)); printf '  FAIL  scratch file left inside the claude-ship-next-* namespace\n'
  rm -f "$MARKER_DIR"/claude-ship-next-sess1.*
else pass=$((pass+1)); fi
mkrm sess1

# 5. Multiple closing references: GitHub closes them all, so any may match.
mktok sess1 222
check "second Closes in the body can match" silent "$(prbody sess1 'Closes #111 and Closes #222')"
mkrm sess1

# 6. Writer: an argument that is not a bare number must never become a token.
for badarg in '10 30' '1030 extra' '1030 1031'; do
  mkrm wsess
  printf '{"session_id":"wsess","hook_event_name":"UserPromptSubmit","prompt":%s}' \
    "$(printf '/ship-next %s' "$badarg" | jq -Rs .)" | sh "$WRITER" 2>/dev/null
  if mkhastok wsess '*'; then pass=$((pass+1)); else fail=$((fail+1)); printf '  FAIL  expected wildcard for arg: %s\n' "$badarg"; fi
done
mkrm wsess

# 7. A Skill payload with NO args field — the shape most likely in reality.
printf '{"session_id":"wsess","hook_event_name":"PreToolUse","tool_name":"Skill","tool_input":{"skill":"ship-next"}}' | sh "$WRITER" 2>/dev/null
if mkhastok wsess '*'; then pass=$((pass+1)); else fail=$((fail+1)); printf '  FAIL  Skill payload without args did not write a wildcard\n'; fi
mkrm wsess


# --- the asymmetry: broken marker machinery must WARN, never silence ------
check "missing session_id -> warns" fire '{"tool_name":"mcp__github__create_pull_request","tool_input":{}}'
check "empty session_id -> warns" fire '{"session_id":"","tool_name":"mcp__github__create_pull_request","tool_input":{}}'
# A session_id that sanitizes to a path-traversal attempt must not resolve to
# some other file that happens to exist.
check "path-traversal session_id -> warns" fire "$(pr '../../etc/passwd')"


rcheck() { # name expected_exit payload
  printf '%s' "$3" | sh "$GUARD" >/dev/null 2>&1
  actual=$?
  if [ "$actual" = "$2" ]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    printf '  FAIL  %-52s expected exit %s, got %s\n' "$1" "$2" "$actual"
  fi
}

# --- the last silence path: an unparseable payload that IS a PR creation --
# Found by review, outside the scope it was asked to check. The top-level jq
# extraction used to `|| exit 0`, bypassing the marker gate entirely — so the
# documented "can never fail toward silence" property was not actually true.
#
# These two now BLOCK rather than warn, which is a stronger form of the property
# they were written to protect: a PR-shaped payload the guard cannot parse must
# never pass unnoticed. Warning was the strongest response available before the
# reviewer gate existed; with it, an unverifiable pull request is refused. The
# assertions moved from stdout to exit status for the same reason the F2 bypass
# survived the suite — a case that reads stdout cannot see a block.
# These two carry NO structural signal — no `"tool_name": "...create_pull_request"`,
# no `"command": "... gh pr create"` — only the bare phrase in mangled text. They
# WARN rather than block, and that is the settled answer after three rounds on
# this branch:
#
#   round 1: they warned, and an unparseable PR-shaped payload could dodge the
#            gate entirely -> called a bypass.
#   round 2: made every such payload BLOCK -> false-blocked any malformed
#            payload merely MENTIONING the phrase, and these files are full of it.
#   round 3: block on a structural signal, warn otherwise.
#
# Why warning is enough here: a payload this mangled is not a tool call the
# harness would execute either — it sees the same bytes. Blocking unrecognisable
# garbage protects against nothing, while false-blocking real work is a live
# cost. The property these cases were written to defend is intact: a PR-shaped
# payload must never pass UNNOTICED, and a warning is not silence.
check "malformed payload naming create_pull_request warns" fire '{"session_id":"x","tool_name":BROKEN,"create_pull_request"'
check "malformed payload containing gh pr create warns" fire '{"session_id":"x",BROKEN gh pr create'
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


# --- the reviewer gate (blocking) -------------------------------------------
#
# Distinct from every case above: those measure the ship-next WARNING on stdout,
# this measures a BLOCK — exit 2 with a message on stderr. check() reads stdout,
# so it cannot see this; these assert the exit status directly.
WRITER_R="$(dirname "$0")/reviewer-marker.sh"

unreviewed rgate
rcheck "no reviewer pass -> PR creation BLOCKS" 2 "$(pr rgate 1)"
rcheck "no reviewer pass -> gh pr create BLOCKS" 2 "$(bs rgate 'gh pr create --base dev --fill')"
rcheck "no reviewer pass -> a non-PR command is untouched" 0 "$(bs rgate 'git status')"

# A reviewer pass recorded by the real writer must clear it.
printf '{"session_id":"rgate","hook_event_name":"PreToolUse","tool_name":"Agent","tool_input":{"subagent_type":"haven-reviewer"}}' \
  | sh "$WRITER_R" 2>/dev/null
if [ -n "$TEST_BRANCH" ] && grep -Fxq "$TEST_BRANCH" "$MARKER_DIR/claude-reviewed-rgate" 2>/dev/null; then
  pass=$((pass + 1))
else
  fail=$((fail + 1)); printf '  FAIL  reviewer-marker.sh did not record the pass\n'
fi
rcheck "after a reviewer pass -> PR creation proceeds" 0 "$(pr rgate 1)"

# The marker is NOT consumed. Unlike the ship-next token, this answers "did
# review happen for this branch", which does not stop being true after one PR.
rcheck "reviewer pass is not consumed by one PR" 0 "$(pr rgate 2)"

# Only reviewer roles count.
unreviewed rgate2
printf '{"session_id":"rgate2","hook_event_name":"PreToolUse","tool_name":"Agent","tool_input":{"subagent_type":"haven-explorer"}}' \
  | sh "$WRITER_R" 2>/dev/null
rcheck "a non-reviewer subagent does NOT clear the gate" 2 "$(pr rgate2 1)"

# haven-design-reviewer is a SECOND pass, not a substitute (AGENTS.md), so it
# must NOT clear the gate on its own. This case asserted the opposite until
# review pointed out it locked in the very substitution the prose forbids.
unreviewed rgate3
printf '{"session_id":"rgate3","hook_event_name":"PreToolUse","tool_name":"Agent","tool_input":{"subagent_type":"haven-design-reviewer"}}' \
  | sh "$WRITER_R" 2>/dev/null
rcheck "haven-design-reviewer alone does NOT clear the gate" 2 "$(pr rgate3 1)"

# Fail-open on its own malfunction: blocking every PR because the plumbing broke
# would get the hook removed, and then it guards nothing.
rcheck "missing session_id -> does NOT block" 0 '{"tool_name":"mcp__github__create_pull_request","tool_input":{}}'

# F2 regression: an unparseable PR-shaped payload must still hit the gate. The
# two pre-existing cases on this branch assert stdout, and a block writes to
# stderr — so they passed while the bypass was live. Assert the exit code.
unreviewed rgate4
rcheck "unparseable payload with a structural PR signal BLOCKS" 2 \
  '{"session_id":"rgate4","tool_name":"mcp__github__create_pull_request", BROKEN'
check "unparseable payload with only a bare mention warns instead" fire '{"session_id":"rgate4",BROKEN gh pr create'

# F3 regression: a marker that exists but cannot be read is a malfunction, and
# the contract is to fail OPEN. Skipped as root, which can read mode-000 files
# and would make the case pass vacuously.
if [ "$(id -u 2>/dev/null || echo 0)" != "0" ]; then
  unreviewed rgate5
  printf '%s\n' "$TEST_BRANCH" > "$MARKER_DIR/claude-reviewed-rgate5" 2>/dev/null
  chmod 000 "$MARKER_DIR/claude-reviewed-rgate5" 2>/dev/null
  rcheck "unreadable marker fails OPEN, not closed" 0 "$(pr rgate5 1)"
  chmod 644 "$MARKER_DIR/claude-reviewed-rgate5" 2>/dev/null
  unreviewed rgate5
else
  printf '  SKIP  unreadable-marker case (running as root reads mode-000)\n'
fi

# --- strict mode must not false-block on a coincidental mention -------------
#
# The first strict implementation matched `create_pull_request` / `gh pr create`
# anywhere in a malformed payload, so an unrelated tool call that merely
# MENTIONED the phrase was hard-blocked — and these very files are full of the
# phrase. No case covered "malformed + unrelated tool + incidental mention",
# which is why the suite passed while the regression was live. These are the
# reviewer's own reproductions.
unreviewed strictsess
rcheck "malformed Write that merely mentions gh pr create does NOT block" 0 \
  '{"tool_name":"Write","tool_input":{"file_path":"README.md","content":"See gh pr create docs"} BROKEN'
rcheck "malformed Task prompt naming create_pull_request does NOT block" 0 \
  '{"tool_name":"Task","tool_input":{"description":"explain create_pull_request semantics"} SYNTAX_ERROR'
# ...while a malformed payload whose TOOL is the PR tool still blocks.
rcheck "malformed payload whose tool_name IS the PR tool still BLOCKS" 2 \
  '{"session_id":"strictsess","tool_name":"mcp__github__create_pull_request","tool_input":{ BROKEN'
rcheck "malformed payload whose command IS gh pr create still BLOCKS" 2 \
  '{"session_id":"strictsess","tool_name":"Bash","tool_input":{"command":"gh pr create --fill" BROKEN'

# --- a non-regular-file at the marker path is ABSENCE, and must BLOCK -------
#
# These three asserted the OPPOSITE for one commit, and in doing so certified a
# bypass: reviewer-marker.sh only ever appends to a regular file, so a directory
# at this deterministic path cannot come from a real review pass — but it made
# `mkdir -p "$TMPDIR/claude-reviewed-$SESSION_ID"` silence the gate in one
# command. Absence is the correct reading, and absence blocks.
unreviewed dirsess
mkdir -p "$MARKER_DIR/claude-reviewed-dirsess" 2>/dev/null
rcheck "marker path is a DIRECTORY -> still BLOCKS (not a bypass)" 2 "$(pr dirsess 1)"
rmdir "$MARKER_DIR/claude-reviewed-dirsess" 2>/dev/null

unreviewed loopsess
ln -s "$MARKER_DIR/claude-reviewed-loopsess" "$MARKER_DIR/claude-reviewed-loopsess" 2>/dev/null
rcheck "marker path is a SYMLINK LOOP -> still BLOCKS" 2 "$(pr loopsess 1)"
rm -f "$MARKER_DIR/claude-reviewed-loopsess" 2>/dev/null

unreviewed danglesess
ln -s "$MARKER_DIR/definitely-not-there-$$" "$MARKER_DIR/claude-reviewed-danglesess" 2>/dev/null
rcheck "marker path is a DANGLING SYMLINK -> still BLOCKS" 2 "$(pr danglesess 1)"
rm -f "$MARKER_DIR/claude-reviewed-danglesess" 2>/dev/null

# The symlink bypass: a link to a readable file containing the branch name is
# NOT a review pass. `-f` and `grep` both follow links, so this sailed through
# the branch meant to PROVE a review happened — not a fail-open path at all,
# which is why narrowing the malfunction condition never touched it and the
# cases aimed at that condition could not see it.
unreviewed symsess
printf '%s\n' "$TEST_BRANCH" > "$MARKER_DIR/sym-target-$$" 2>/dev/null
ln -s "$MARKER_DIR/sym-target-$$" "$MARKER_DIR/claude-reviewed-symsess" 2>/dev/null
rcheck "symlink to a readable branch-name file does NOT clear the gate" 2 "$(pr symsess 1)"
rm -f "$MARKER_DIR/claude-reviewed-symsess" "$MARKER_DIR/sym-target-$$" 2>/dev/null

# And the same trick against the ship-next token marker must still warn.
mkrm symtok
printf '%s\n' '*' > "$MARKER_DIR/ship-next-target-$$" 2>/dev/null
ln -s "$MARKER_DIR/ship-next-target-$$" "$MARKER_DIR/claude-ship-next-symtok" 2>/dev/null
reviewed symtok
check "symlinked ship-next marker does not silence the warning" fire "$(pr symtok 1)"
rm -f "$MARKER_DIR/claude-ship-next-symtok" "$MARKER_DIR/ship-next-target-$$" 2>/dev/null
unreviewed symtok

# The bypass itself, named, so it cannot be reintroduced quietly.
unreviewed attacksess
mkdir -p "$MARKER_DIR/claude-reviewed-attacksess" 2>/dev/null
rcheck "mkdir at the marker path does NOT silence the gate" 2 "$(pr attacksess 1)"
rmdir "$MARKER_DIR/claude-reviewed-attacksess" 2>/dev/null

# F7: leave no stray markers behind, including the ones seeded at the top.
for _s in rgate rgate2 rgate3 rgate4 rgate5 strictsess dirsess loopsess danglesess attacksess symsess symtok testsess sess1 sess2 wsess gatesess x ______etc_passwd; do
  unreviewed "$_s"
done

printf '\nship-next guard: %d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
