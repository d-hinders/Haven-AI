#!/bin/sh
# PreToolUse guard: warn (never block) when a PR is opened outside /ship-next.
#
# Why this exists: CLAUDE.md named the workflow, at the bottom of a long file,
# and that prose was read and not followed — twice. The cost was a PR reported
# as ready when its merge gate had never been checked, and a doc snippet
# shipped to merchants with a signature-verification bug in it. A hook fires at
# the moment of the action regardless of how the session started.
#
# Non-blocking by owner decision (2026-07-26): it warns and lets the call
# through. So the message carries the SUBSTANCE of what is skipped, not just a
# pointer — a nag that only says "you forgot" is worth nothing when it can be
# walked past.
#
# ## Scope shrank on purpose (#1023, #1024, #1025)
#
# It used to list four gates. The fourth — the ACCEPTANCE GATE (docs:check /
# docs:test) — became a CI required check (#1023), so repeating it here is
# noise; the other three survive as the judgement layer no check performs. A
# clause inside the old first gate, that money-path needs in-session approval,
# became simply false (#1024) and is gone. Contract-doc coupling is also a
# required check now, but that gate is #646, not #1023.
#
# The framing also changed (#1025): ship-next is the default ROUTE, not a
# mandate. Opening a PR outside it is allowed; this warning states what you are
# taking on, not that you did something wrong.
#
# ## Marker matching is per ISSUE (#1028, fixed)
#
# The marker used to be a single flag the guard consumed. That is fragile in a
# session shipping several issues: the flag is a session-level fact being used
# to answer a per-PR question, so whether the 2nd PR warns depends on incidental
# ordering between the writer and the guard rather than on whether the workflow
# was followed. A false positive there is a false positive on a COMPLIANT pull
# request — the muted-guard failure this header warns about, self-inflicted.
#
# HONESTY NOTE: an earlier version of this comment said the failure was
# "observed on PR #1027". It was not: the old writer re-created the marker on
# each invocation, so that PR would have been silent. The defect is structural,
# not something I watched happen, and review was right to press on it.
#
# It is now a list of tokens keyed to issue numbers; the guard reads
# `Closes #N` off the pull request and clears that token. See
# fire_unless_ship_next below and ship-next-marker.sh.
#
# One residual gap, deliberately left on the noisy side: two consecutive
# NO-ARGUMENT invocations (`/ship-next` with no issue) share a single `*`
# token, so the second such PR warns. A spurious warning costs a moment; a
# spurious silence costs the guard.
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
# The settings file that activates this script (personal, gitignored — see
# README.md in this directory) resolves it via
# `${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel || echo .)}`.
# CLAUDE_PROJECT_DIR is NOT always set (verified unset in a real session), so
# the git fallback is what carries the common cases: repo root and any
# subdirectory. If cwd is outside the repo entirely, the script is not found and
# the guard is silently inert — the same class of failure it exists to prevent.
# There is no fix at this layer: a repo-level hook cannot locate its repo from
# outside it without the env var. Accepted, not solved. `sh <file>` invocation
# means the exec bit is irrelevant, so that is not an additional failure mode.

set -u

# Set by the Bash route to the ONE segment that creates the PR; empty means
# the issue number could not be scoped and only a wildcard may silence.
pr_body=""

input=$(cat 2>/dev/null) || exit 0
[ -n "$input" ] || exit 0

tool=$(printf '%s' "$input" | jq -r '.tool_name // ""' 2>/dev/null) || tool=""
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null) || cmd=""

fire() {
  MSG='⚠️  Opening a PR OUTSIDE /ship-next.

Haven'"'"'s default shipping route is .agents/skills/ship-next/SKILL.md. Working
differently is ALLOWED (#1025) — the mechanical standards are CI required
checks either way. What you take on is the judgement layer no check performs:

1. INDEPENDENT REVIEW of the COMPLETE candidate diff vs origin/dev — including
   any fixes written in response to an EARLIER review. Reviewed findings plus
   unreviewed fixes is not a reviewed PR. For area:frontend, a rendered pass
   too. Nothing in CI does this, and nothing will tell you it was skipped.

2. DOC-REVIEWER — run: node scripts/docs/coupling-gate.mjs
   If the diff touches code that any docs `covers:` front-matter maps to,
   review those docs. CI only BLOCKS on docs marked `contract: true`; the rest
   are advisory, so this one is on you. Editing the doc yourself is not the
   same as reviewing it.

3. MIGRATION MERGE ROUTING — a diff touching
   /packages/backend/src/db/migrations/ needs an
   INDEPENDENT code-owner approval (.github/CODEOWNERS). The PR AUTHOR'"'"'s own
   approval does NOT satisfy it. (money-path no longer pauses the merge, #1024
   — it selects money.md and its characterization-test bar.)

Not listed, because CI enforces them for you: docs:check / docs:test and
design-system coupling (#1023), visual regression (#897), copy lint (#902),
contract docs (#646). Opening a PR by hand does not skip those.

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
#
# ## Matching is now PER ISSUE (#1028)
#
# The marker is a list of tokens (see ship-next-marker.sh), not a single flag.
# This reads `Closes #N` off the pull request and clears that token, falling
# back to one `*` when the invocation could not name an issue up front.
#
# Consuming a single flag was the old design, and it warned on the 2nd PR of a
# session that shipped several issues under one skill invocation — a false
# positive on a COMPLIANT pull request, which is the muted-guard failure this
# file's own header warns about. Per-issue tokens keep the property that
# motivated consuming (a hand-rolled PR in a ship-next session still warns)
# without that cost.
# BLOCKING: an independent reviewer pass must have run for this branch.
#
# Distinct from the warning below in both force and subject. The warning is
# about which ROUTE you took and is non-blocking by owner decision (2026-07-26).
# This is about whether review HAPPENED, and it blocks.
#
# > **Owner decision (recorded verbatim):** "I have told you many times that all
# > prs should have the review run on it, it is in the claude file too. Why do
# > you keep telling yourself it isn't needed? I want it to run on every PR,
# > full stop." — the owner in-session 2026-08-21.
#
# The written rule was conditional before this ("when the change touches
# user-facing UX, money movement, agent authority, shared behavior, or
# meaningful risk", AGENTS.md), and that conditional was the licence: each skip
# had its own plausible reason, so no skip felt like a pattern. Three happened
# in one session. The rule is unconditional now, and this makes it so at the
# only moment that matters.
#
# Fails OPEN on its own malfunction — missing jq, unreadable marker, a detached
# HEAD. A guard that blocks all pull request creation when its own plumbing
# breaks would be routed around within the hour, and then it guards nothing.
#
# $1 = "strict" makes an UNRESOLVABLE session block instead of fail open.
#
# The two modes exist because "cannot resolve the session" means different
# things on the two paths. On a parseable payload it is a malfunction — jq
# present, JSON valid, no session_id — and blocking on that would stop
# legitimate work over a harness quirk. On the UNPARSEABLE path the payload
# already matched `create_pull_request` / `gh pr create` in raw text: something
# is opening a pull request and the guard cannot verify review. Failing open
# there is a bypass, and a bypass that a malformed payload reaches on purpose.
# Between "block a real PR whose payload is corrupt" and "let an unverifiable PR
# through", a gate the owner asked for as a full stop has to take the first.
require_reviewer_pass() {
  rstrict="${1:-}"
  rsession=$(printf '%s' "$input" | jq -r '.session_id // ""' 2>/dev/null) || rsession=""
  if [ -z "$rsession" ]; then
    [ "$rstrict" = "strict" ] || return 0
    printf '%s\n' 'BLOCKED: this looks like a pull request creation, but the payload could not
be parsed, so no reviewer pass can be verified for it.

If this is a real pull request, open it with a well-formed call after running
haven-reviewer. If the payload is corrupt, fix the caller — the guard cannot
tell an unreviewed PR from an unparseable one, and on a pull-request-shaped
payload it will not guess.' >&2
    exit 2
  fi
  rsafe=$(printf '%s' "$rsession" | tr -c 'A-Za-z0-9_-' '_' 2>/dev/null) || rsafe=""
  if [ -z "$rsafe" ]; then
    [ "$rstrict" = "strict" ] || return 0
    exit 2
  fi

  rbranch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null) || return 0
  [ -n "$rbranch" ] || return 0
  [ "$rbranch" = "HEAD" ] && return 0

  rmarker="${TMPDIR:-/tmp}/claude-reviewed-$rsafe"

  # A marker that EXISTS but cannot be read is a malfunction, not an unreviewed
  # branch, and the documented contract is to fail open on malfunction. The
  # earlier `[ -f ] && grep` conflated the two: -f succeeds without read
  # permission, grep then fails, and control fell through to the BLOCK. Found by
  # review, reproduced as a non-root user — it does NOT reproduce as root, which
  # reads mode-000 files, so the first attempt to confirm it came back clean.
  # Fail open on EXACTLY ONE shape: an existing REGULAR FILE that cannot be
  # read. That is a plausible accident — permissions, a prior process — and
  # blocking on it would stop real work over plumbing.
  #
  # Everything else at this path is treated as ABSENCE, which blocks. An earlier
  # version widened this to "any path malfunction" (directory, symlink loop,
  # dangling link) on the reasoning that malfunctions are symmetric. They are
  # not, and review caught it: `reviewer-marker.sh` only ever appends to a
  # regular file, so a DIRECTORY at this name is not something a real pass can
  # produce — it can only have been put there. The session id is known to the
  # calling agent and the path is deterministic, which made
  #
  #     mkdir -p "$TMPDIR/claude-reviewed-$SESSION_ID"
  #
  # a one-command silencer for the gate the owner asked for as a full stop,
  # certified by three of this file's own tests. It also REGRESSED behaviour
  # that was already correct: before the widening a directory fell through to
  # the block, because `[ -f ]` is false for one.
  #
  # `[ -f ]` is the right test throughout: false for a directory, a dangling
  # link and a symlink loop; true for an unreadable regular file, whose
  # unreadability `[ ! -r ]` then catches.
  # A SYMLINK here is never a marker, whatever it points at.
  #
  # `-f` and `grep` both FOLLOW symlinks, so the previous shape accepted a link
  # to any readable file containing the branch name — and the path is
  # deterministic, the session id known to the calling agent, TMPDIR its own.
  # Two commands silenced the gate with no review run:
  #
  #     echo "$(git rev-parse --abbrev-ref HEAD)" > /tmp/anything
  #     ln -s /tmp/anything "$TMPDIR/claude-reviewed-$SESSION_ID"
  #
  # This is not a fail-open path — it is a false PASS through the branch that is
  # supposed to PROVE a review happened, which is why narrowing the malfunction
  # condition did not touch it and why the tests aimed at that condition could
  # not see it. reviewer-marker.sh appends to a regular file and never creates
  # or follows a link, so a symlink is not something a real pass can produce:
  # absence, which blocks.
  #
  # KNOWN RESIDUAL, accepted: a HARD link is not caught here — `-L` cannot see
  # one. It is left because it buys an attacker nothing: a hard link needs a
  # file already containing the exact branch line, which is the same effort as
  # writing the marker directly, and that is the irreducible limit stated in
  # README.md. The symlink case was different in kind — it pointed at ANY
  # pre-existing readable file, so it cost one `ln -s` and no authorship.
  if [ ! -L "$rmarker" ]; then
    if [ -f "$rmarker" ] && [ ! -r "$rmarker" ]; then
      return 0
    fi

    if [ -f "$rmarker" ] && grep -Fxq "$rbranch" "$rmarker" 2>/dev/null; then
      return 0
    fi
  fi

  printf '%s\n' 'BLOCKED: no independent reviewer pass recorded for this branch.

Run haven-reviewer over the COMPLETE candidate diff against origin/dev, apply
what it finds, then open the pull request.

This is not a risk judgement to make per pull request. "The diff is
script-generated", "it is docs-only", "it is a version bump" are the shapes the
skip takes, and they are why the rule is unconditional: what needs an
independent eye is rarely the lines, it is the judgement around them — whether
a claim was tested or assumed, whether a doc says what you say it says.

Self-review does not clear this. The author is the one person who cannot see the
assumption they already made.

For an area:frontend diff, haven-design-reviewer is a SECOND pass, not a
substitute for haven-reviewer.

If you genuinely need to bypass: unset the hook, and say in the PR that review
was skipped and why. Do not do it silently.' >&2
  exit 2
}

fire_unless_ship_next() {
  session=$(printf '%s' "$input" | jq -r '.session_id // ""' 2>/dev/null) || fire
  [ -n "$session" ] || fire
  safe=$(printf '%s' "$session" | tr -c 'A-Za-z0-9_-' '_' 2>/dev/null) || fire
  [ -n "$safe" ] || fire

  marker="${TMPDIR:-/tmp}/claude-ship-next-$safe"
  # Same symlink reasoning as require_reviewer_pass: -f and grep follow links,
  # and ship-next-marker.sh only ever appends to a regular file. Lower stakes —
  # this one only silences a warning — but identical root cause, so it is closed
  # here too rather than left as the next person's surprise.
  [ -L "$marker" ] && fire
  [ -f "$marker" ] || fire

  # Which issue does this PR close? The source is deliberately NARROW: the MCP
  # payload's own `body` field, or (Bash route) only the segment that actually
  # invokes the PR creation — set by the caller in $pr_body.
  #
  # It used to fall back to the WHOLE raw payload, which let a closing keyword
  # anywhere in it match: `git commit -m "closes #1030" && gh pr create --body
  # "Closes #999"` consumed the #1030 token and silenced a PR for #999. That
  # broke the property the whole design rests on — silence must mean "ship-next
  # shipped THIS pull request", not "some token exists".
  #
  # When the body cannot be identified, no numeric match is attempted at all and
  # only a wildcard can silence. Guessing from unscoped text is what caused the
  # bug; refusing to guess is the fix.
  body="${pr_body:-}"
  [ -n "$body" ] || body=$(printf '%s' "$input" | jq -r '.tool_input.body // ""' 2>/dev/null) || body=""

  # Every closing reference in that body, in order. GitHub itself closes each of
  # them, so any is a legitimate match — but the KEYWORD is required: a bare
  # `#1030` ("as in #1030") must never consume a token.
  issues=$(printf '%s' "$body" \
    | grep -oiE '(clos(e|es|ed)|fix(|es|ed)|resolve(|s|d))[[:space:]]+#[0-9]+' 2>/dev/null \
    | tr -cd '0-9\n') || issues=""

  matched=""
  for cand in $issues; do
    # Exact whole-line match, so token 103 never clears 1030.
    if grep -Fxq "$cand" "$marker" 2>/dev/null; then matched="$cand"; break; fi
  done

  if [ -n "$matched" ]; then
    : # an exact issue token wins; the wildcard is saved for a PR that needs it
  elif grep -Fxq '*' "$marker" 2>/dev/null; then
    # The invocation named no issue up front (`/ship-next`, `label=…`,
    # `epic=#…`, a freeform task). One wildcard covers one pull request.
    matched='*'
  else
    fire
  fi

  # Clear exactly ONE occurrence of the matched token, via a temp file (sed -i
  # is not portable).
  #
  # On ANY failure — missing awk, unwritable TMPDIR, failing mv, unreadable
  # marker — DELETE THE WHOLE MARKER. An earlier version left it intact and a
  # comment claimed that was "the safe direction". It is the opposite: a
  # retained token is SILENCE, so a missing `awk` silenced every subsequent PR
  # in the session. Review caught it by running the script without awk on PATH.
  # Losing the other tokens costs a few spurious warnings; keeping them costs
  # the guard.
  # NOT "$marker.$$": that name matches the `claude-ship-next-*` glob, so a
  # stray temp file both litters the marker namespace and is prunable/readable
  # as if it were a marker. Keep scratch out of that namespace entirely.
  tmp="${TMPDIR:-/tmp}/.claude-ship-next-scratch-$$"
  if awk -v t="$matched" 'BEGIN{done=0} {if(!done && $0==t){done=1; next} print}' \
       "$marker" > "$tmp" 2>/dev/null; then
    if [ -s "$tmp" ]; then
      mv -f "$tmp" "$marker" 2>/dev/null || { rm -f "$tmp" "$marker" 2>/dev/null; }
    else
      rm -f "$tmp" "$marker" 2>/dev/null
    fi
  else
    rm -f "$tmp" "$marker" 2>/dev/null || true
  fi
  exit 0
}

if [ -z "$tool" ]; then
  # jq could not parse the payload (or there is no tool_name). Exiting silently
  # here is a SILENCE PATH that bypasses the marker gate entirely — the one
  # thing this guard must not have. So if the RAW text still looks like a PR
  # creation, route it through the gate anyway. Anything else is genuinely
  # unidentifiable and stays quiet, because warning on every unparseable
  # payload would fire on unrelated commands and mute the guard by noise.
  #
  # The reviewer gate must run here too. It was added only at the two PARSEABLE
  # call sites, leaving this branch as a bypass: a PR-shaped payload that fails
  # to parse reached the non-blocking warning and never the block. Found by
  # review and reproduced —
  #   printf '{"session_id":"x",BROKEN gh pr create' | sh ship-next-guard.sh
  # exited 0. The suite missed it because the two cases covering this branch
  # assert stdout ("fire"), and a block writes to stderr and exits 2, so they
  # passed either way. That is the same defect class as a muted guard: a check
  # that cannot observe the thing it is meant to protect.
  # STRICT applies only on a STRUCTURAL signal, never a bare substring.
  #
  # The first version of this blocked on `*create_pull_request*` / `*gh pr
  # create*` anywhere in the raw payload, which is a false-block generator:
  # these very files contain dozens of literal occurrences, so a malformed
  # payload from an unrelated tool that merely MENTIONS the phrase — editing
  # this hook, a prompt discussing the workflow, a grep — was hard-blocked.
  # Review reproduced it with a Write payload whose content said "See gh pr
  # create docs". That contradicts the fail-open-on-malfunction contract
  # directly, and traded a bypass for a worse defect in the other direction.
  #
  # So strict now requires the phrase to sit where a PR creation would actually
  # put it: inside the tool_name, or inside a command field. Anything else with
  # a coincidental mention falls through to the non-blocking warning, which is
  # what it did before the gate existed.
  #
  # Residual, accepted and stated rather than hidden: a malformed Bash payload
  # whose command merely QUOTES `gh pr create` (`grep "gh pr create"`) still
  # blocks. Command-position parsing is not available here — that is precisely
  # what could not be parsed — and between blocking a grep and letting an
  # unverifiable PR through, this errs toward the grep. It is also recoverable
  # in one step: re-run the command in a well-formed call.
  strict_signal=0
  if printf '%s' "$input" | grep -qE '"tool_name"[[:space:]]*:[[:space:]]*"[^"]*create_pull_request' 2>/dev/null; then
    strict_signal=1
  elif printf '%s' "$input" | grep -qE '"command"[[:space:]]*:[[:space:]]*"[^"]*gh[[:space:]]+pr[[:space:]]+create' 2>/dev/null; then
    strict_signal=1
  fi

  if [ "$strict_signal" -eq 1 ]; then
    require_reviewer_pass strict
    fire_unless_ship_next
  else
    case "$input" in
      *create_pull_request*|*"gh pr create"*) fire_unless_ship_next ;;
    esac
  fi
  exit 0
fi
if [ "$tool" = "mcp__github__create_pull_request" ]; then
  pr_body=$(printf '%s' "$input" | jq -r '.tool_input.body // ""' 2>/dev/null) || pr_body=""
  require_reviewer_pass
  fire_unless_ship_next
fi
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
    # Only THIS segment may supply the issue number. A `git commit -m "closes
    # #N"` earlier in the same chained command is a different segment and must
    # not be read as what this PR closes.
    pr_body="$seg"
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
    pr_body="$seg"
  fi
done
unset IFS

[ "$is_pr" -eq 1 ] || exit 0
require_reviewer_pass
fire_unless_ship_next
exit 0
