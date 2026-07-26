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
# Fails open by design. Any error here exits 0 silently: a broken guard must
# never wedge a tool call.

set -u

input=$(cat 2>/dev/null) || exit 0
[ -n "$input" ] || exit 0

tool=$(printf '%s' "$input" | jq -r '.tool_name // ""' 2>/dev/null) || exit 0
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null) || cmd=""

is_pr=0
case "$tool" in
  mcp__github__create_pull_request)
    is_pr=1
    ;;
  Bash)
    case "$cmd" in
      *"gh pr create"*) is_pr=1 ;;
    esac
    # A curl that CREATES a pull request. Three conditions, all required —
    # each one exists to silence a real false positive:
    #   1. an explicit non-POST verb disqualifies it   (PATCH = editing a PR body)
    #   2. the path is the /pulls COLLECTION, not /pulls/<n>  (a numbered path is
    #      an existing PR: update, merge, review — never a create)
    #   3. it actually writes                          (a bare GET is listing)
    if [ "$is_pr" -eq 0 ]; then
      if printf '%s' "$cmd" | grep -qE -- '-X[[:space:]]*(PATCH|PUT|DELETE|GET)|--request[[:space:]]*(PATCH|PUT|DELETE|GET)' 2>/dev/null; then
        : # explicit non-POST verb — not a create
      elif printf '%s' "$cmd" | grep -qE '/pulls([^/A-Za-z0-9_-]|$)' 2>/dev/null &&
           printf '%s' "$cmd" | grep -qE -- '-X[[:space:]]*POST|--request[[:space:]]*POST|[[:space:]]-d[[:space:]]|--data' 2>/dev/null; then
        is_pr=1
      fi
    fi
    ;;
esac

[ "$is_pr" -eq 1 ] || exit 0

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
   Markdown, anything under docs/, or a root gravity file (CLAUDE.md, README.md,
   AGENTS.md, ABOUT_HAVEN.md): npm run docs:check AND npm run docs:test, as a
   hard gate.

This warning does not block. It is on you.'

jq -n --arg msg "$MSG" '{
  systemMessage: "PR opened outside /ship-next — gate checklist injected into context.",
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    additionalContext: $msg
  }
}' 2>/dev/null || exit 0

exit 0
