#!/bin/sh
# PreToolUse guard: warn (never block) when a PR is opened outside /ship-next.
#
# Why this exists: CLAUDE.md already states that `ship-next` is the default way
# to ship a GitHub issue — on its last line, in a 304-line file. That prose was
# read and not followed, twice, and the cost was a PR reported as ready when its
# merge gate had never been checked, and a doc snippet shipped to merchants with
# a signature-verification bug in it. Prose is at its ceiling here; a hook fires
# at the moment of the action regardless of how the session started.
#
# Non-blocking by owner decision (2026-07-26): it warns and lets the call
# through. So the message carries the SUBSTANCE of the gates most often skipped,
# not just a pointer — a nag that only says "you forgot" is worth nothing when
# it can be walked past.
#
# ## Detection: segment first, then match at COMMAND POSITION
#
# The naive version — substring-match the whole command — is wrong in both
# directions, and both directions were observed for real:
#
#   * It fired on the commit that INTRODUCED it, because the message described
#     what it detects. Any commit message, doc, or comment mentioning the
#     workflow tripped it. A guard that cries wolf gets muted, and a muted guard
#     is worth exactly as much as no guard.
#   * It also missed real invocations, and silently: a heredoc whose delimiter
#     contained punctuation truncated the delimiter, so the terminator never
#     matched and every following line — including a real `gh pr create` — was
#     swallowed as heredoc body.
#
# So: strip heredoc bodies, split the command into segments, and require the
# invocation to sit at the START of a segment. Text that merely mentions the
# workflow is never at a command position; a real invocation always is. This
# also stops one segment's `/pulls` from combining with a different segment's
# POST (`curl -X POST /other -d x && echo /pulls`).
#
# Fails open by design. Any error here exits 0 silently: a broken guard must
# never wedge a tool call.
#
# ## Known residual gap — silent inertness outside the repo
#
# settings.json resolves this script via
# `${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel || echo .)}`.
# CLAUDE_PROJECT_DIR is NOT always set (verified unset in a real session), so
# the git fallback is what carries the common cases: repo root and any
# subdirectory. If cwd is outside the repo entirely, the script is not found and
# the guard is silently inert — the same class of failure it exists to prevent.
# There is no fix at this layer: a repo-level hook cannot locate its repo from
# outside it without the env var. Accepted, not solved. `sh <file>` invocation
# means the exec bit is irrelevant, so that is not an additional failure mode.

set -u

input=$(cat 2>/dev/null) || exit 0
[ -n "$input" ] || exit 0

tool=$(printf '%s' "$input" | jq -r '.tool_name // ""' 2>/dev/null) || tool=""
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null) || cmd=""

fire() {
  MSG='⚠️  Opening a PR OUTSIDE /ship-next.

Havens canonical shipping workflow is .agents/skills/ship-next/SKILL.md —
CLAUDE.md: "ship-next is the default way to ship anything defined as a GitHub
issue or sub-issue". Prefer stopping here and invoking /ship-next instead.

If opening this PR directly is deliberate, you now own these gates. They are
listed because they are the ones actually skipped in practice, not for
completeness:

1. MERGE ROUTING — a diff touching db/migrations/ needs an INDEPENDENT
   code-owner approval (.github/CODEOWNERS). The PR AUTHORs own approval does
   NOT satisfy it; GitHubs self-approval rule means the author must not be the
   approver. money-path (the label OR the file list in the skills Merge Gate,
   union not intersection) needs in-session user approval. Only non-money-path
   may auto-merge.

2. DOC-REVIEWER — run: node scripts/docs/coupling-gate.mjs
   If the diff touches code that any docs `covers:` front-matter maps to,
   reviewing those docs is a HARD definition-of-done step. Do not open the PR
   with a covers:-mapped doc unreviewed. Editing the doc yourself is not the
   same as reviewing it.

3. INDEPENDENT REVIEW of the COMPLETE candidate diff vs origin/dev — including
   any fixes written in response to an EARLIER review. Reviewed findings plus
   unreviewed fixes is not a reviewed PR.

4. ACCEPTANCE GATE — package tests + typecheck; and when the diff touches any
   Markdown, anything under docs/ or scripts/docs/, or a root gravity file
   (CLAUDE.md, README.md, AGENTS.md, ABOUT_HAVEN.md): npm run docs:check AND
   npm run docs:test, as a hard gate.

This warning does not block. It is on you.'

  jq -n --arg msg "$MSG" '{
    systemMessage: "PR opened outside /ship-next — gate checklist injected into context.",
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext: $msg
    }
  }' 2>/dev/null || true
  exit 0
}


# Warning on a COMPLIANT pull request is not a cosmetic annoyance: it trains the
# reader to ignore the guard, which is the muted-guard failure this file's own
# header calls out. The marker is written by the harness (see
# ship-next-marker.sh), never by the model remembering to.
#
# The check is deliberately asymmetric — it can only move toward SILENCE when a
# marker is POSITIVELY PRESENT. No session id, unreadable tmpdir, malformed
# payload, marker missing: every one falls through to the warning. A bug in
# here cannot silence the guard, only make it noisier, because a silent guard
# is indistinguishable from a working one.
#
# That claim was NOT true when first written: the top-level jq extraction did
# `|| exit 0`, so an unparseable payload skipped this gate entirely. Review
# caught it. The caller now routes a PR-shaped raw payload here even when jq
# cannot parse it — the property is enforced, not just asserted in a comment.
#
# BOTH detection paths (the MCP tool and the Bash shapes) route through this.
# An earlier draft had the MCP path call fire() directly and skip the marker
# entirely — caught by the test, which is why the marker case is asserted for
# the MCP payload specifically.
fire_unless_ship_next() {
  session=$(printf '%s' "$input" | jq -r '.session_id // ""' 2>/dev/null) || fire
  [ -n "$session" ] || fire
  safe=$(printf '%s' "$session" | tr -c 'A-Za-z0-9_-' '_' 2>/dev/null) || fire
  [ -n "$safe" ] || fire

  marker="${TMPDIR:-/tmp}/claude-ship-next-$safe"
  if [ -f "$marker" ]; then
    # CONSUME it. ship-next ships exactly one issue per invocation, so a
    # single-use marker gives per-PR precision: a second, hand-rolled PR later
    # in the same session warns as it should.
    rm -f "$marker" 2>/dev/null || true
    exit 0
  fi
  fire
}

if [ -z "$tool" ]; then
  # jq could not parse the payload (or there is no tool_name). Exiting silently
  # here is a SILENCE PATH that bypasses the marker gate entirely — the one
  # thing this guard must not have. So if the RAW text still looks like a PR
  # creation, route it through the gate anyway. Anything else is genuinely
  # unidentifiable and stays quiet, because warning on every unparseable
  # payload would fire on unrelated commands and mute the guard by noise.
  case "$input" in
    *create_pull_request*|*"gh pr create"*) fire_unless_ship_next ;;
  esac
  exit 0
fi
[ "$tool" = "mcp__github__create_pull_request" ] && fire_unless_ship_next
[ "$tool" = "Bash" ] || exit 0
[ -n "$cmd" ] || exit 0

# --- 1. Strip heredoc bodies ------------------------------------------------
# The delimiter is compared as an EXACT STRING, never interpolated into a
# regex. That kills two bugs at once: a delimiter containing regex
# metacharacters cannot corrupt the match, and a delimiter containing
# punctuation (`<<A.B`, `<<my-msg`) is no longer truncated to its leading
# word characters — which previously left `inhd` stuck on forever and
# swallowed every command after the heredoc.
if printf '%s' "$cmd" | grep -q '<<' 2>/dev/null; then
  stripped=$(printf '%s' "$cmd" | awk '
    !inhd && match($0, /<<-?[ \t]*("[^"]*"|'"'"'[^'"'"']*'"'"'|[^ \t;&|<>()]+)/) {
      d = substr($0, RSTART, RLENGTH)
      sub(/^<<-?[ \t]*/, "", d)
      gsub(/^["'"'"']|["'"'"']$/, "", d)
      delim = d; inhd = 1; print; next
    }
    inhd {
      line = $0
      sub(/^[ \t]+/, "", line); sub(/[ \t]+$/, "", line)
      if (line == delim) inhd = 0
      next
    }
    { print }
  ' 2>/dev/null) && cmd="$stripped"
fi

# --- 2. Split into segments -------------------------------------------------
segments=$(printf '%s' "$cmd" | sed -e 's/&&/\n/g' -e 's/||/\n/g' -e 's/;/\n/g' -e 's/|/\n/g' 2>/dev/null) || exit 0

# --- 3. Match each segment at command position ------------------------------
is_pr=0
IFS='
'
for seg in $segments; do
  [ "$is_pr" -eq 0 ] || break

  # (a) `gh pr create` — must START the segment (after optional sudo/env
  #     assignments). A mention inside a message or comment never does.
  if printf '%s' "$seg" | grep -qE '^[[:space:]]*(sudo[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*[[:space:]]+)*gh[[:space:]]+pr[[:space:]]+create([[:space:]]|$)' 2>/dev/null; then
    is_pr=1
    continue
  fi

  # (b) An HTTP call that CREATES a pull request. Three conditions, each one
  #     silencing a real false positive:
  #       1. an explicit non-POST verb disqualifies it  (PATCH = editing a body)
  #       2. the path is the /pulls COLLECTION, not /pulls/<n>  (numbered = an
  #          existing PR: update, merge, review — never a create)
  #       3. it actually writes
  #     Condition 3 covers non-curl clients too (httpie, requests, fetch),
  #     since the caller here is an agent that can just as easily write a
  #     one-liner as shell out to curl.
  printf '%s' "$seg" | grep -qE '/pulls([^/A-Za-z0-9_-]|$)' 2>/dev/null || continue
  printf '%s' "$seg" | grep -qE -- '-X[[:space:]]*(PATCH|PUT|DELETE|GET)|--request[[:space:]]*(PATCH|PUT|DELETE|GET)|\.(patch|put|delete|get)\(' 2>/dev/null && continue
  if printf '%s' "$seg" | grep -qE -- '-X[[:space:]]*POST|--request[[:space:]]*POST|[[:space:]]-d([[:space:]]|$)|--data|(^|[[:space:]])http[[:space:]]+POST|requests\.post|\.post\(|[Mm]ethod[[:space:]]*[:=][^A-Za-z0-9]*POST' 2>/dev/null; then
    is_pr=1
  fi
done
unset IFS

[ "$is_pr" -eq 1 ] || exit 0
fire_unless_ship_next
exit 0
