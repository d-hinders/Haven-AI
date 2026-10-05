#!/bin/sh
# Vercel "Ignored Build Step" shared by the Vercel projects (#3594; the rule
# itself is #3591's). Vercel runs a project's `ignoreCommand` before every
# build: exit 0 skips the build, any other exit builds.
#
#   sh scripts/vercel/ignore-build.sh <FORCE_VARIABLE> <watch file>
#
# <FORCE_VARIABLE> names an environment variable that, set to 1, forces one
# build. <watch file> is a repo-relative file (scripts/vercel/watch/*.txt)
# listing, one per line, the repo-relative paths the project is built from;
# `#` starts a comment. Paths may not contain whitespace (the list is
# word-split); the harness refuses such an entry. The list lives in a file, not in vercel.json, so the
# ignoreCommand stays short. Each project's test reads the same file.
#
# The rule. It compares HEAD with the last commit this project actually
# DEPLOYED (VERCEL_GIT_PREVIOUS_SHA), never with HEAD's own parent. A
# `git diff HEAD^ HEAD` form skipped every build whose newest commit happened
# not to touch the project, so once the build for a change was lost (the daily
# deployment cap, a failed build) the change never deployed (#3591).
#
# It skips ONLY when it can prove nothing watched changed. Anything uncertain
# builds: a wasted build costs one deployment, a wrong skip leaves a stale site.
#
#   - Previous deployment known and in the clone: skip iff nothing watched
#     changed since it.
#   - No previous deployment, on a PREVIEW branch other than dev or main (a
#     PR's first preview): skip iff a merge base with dev can be found and
#     nothing watched changed on the branch since it. Vercel's clone holds the
#     deployed branch only, so when no dev ref is present the script fetches
#     dev's recent history: from origin, else from the repository's public
#     GitHub URL (Vercel's clone may carry no usable origin, #3594). If the
#     shallow histories share no commit it deepens both sides once. If all of
#     that fails it builds, and its log line names the step that failed.
#   - No previous deployment otherwise (production, an unset or empty
#     VERCEL_ENV, or the dev and main branches, whose deployments are the dev
#     host and production): build.

# The watched paths are word-split below; never glob-expand them.
set -f

if [ "$#" -ne 2 ]; then
  echo "vercel ignore-build: usage: ignore-build.sh <FORCE_VARIABLE> <watch file>; building." >&2
  exit 1
fi

force_var=$1
watch_file=$2
case "$force_var" in
  '' | [0-9]* | *[!A-Za-z0-9_]*)
    echo "vercel ignore-build: invalid force-variable name '${force_var}'; building." >&2
    exit 1
    ;;
esac

top=$(git rev-parse --show-toplevel 2>/dev/null) || {
  echo "vercel ignore-build: not inside a git checkout; building." >&2
  exit 1
}
if [ ! -f "$top/$watch_file" ]; then
  echo "vercel ignore-build: watch file ${watch_file} not found; building." >&2
  exit 1
fi
WATCHED=$(sed -e 's/#.*//' -e 's/[[:space:]]*$//' -e '/^$/d' "$top/$watch_file")
if [ -z "$WATCHED" ]; then
  echo "vercel ignore-build: watch file ${watch_file} lists no paths; building." >&2
  exit 1
fi

# `:(top)` pathspecs: Vercel runs this from the project's Root Directory
# (packages/<project>), where a relative pathspec would match nothing and
# always skip.
watched_unchanged() {
  base=$1
  set --
  for path in $WATCHED; do
    set -- "$@" ":(top)$path"
  done
  git diff --quiet "$base" HEAD -- "$@"
}

# Rebuilding an UNCHANGED commit after changing a build-time variable (Next
# inlines every NEXT_PUBLIC_* value) would always skip, because nothing changed
# since the last deployment. Setting the project's force variable to 1 forces
# one build; remove it afterwards (docs/operations/ops-console.md,
# docs/operations/dev-environment.md).
eval "force_value=\${${force_var}:-}"
if [ "$force_value" = "1" ]; then
  echo "vercel ignore-build: ${force_var}=1; building."
  exit 1
fi

# A fetch that never prompts and gives up on a stalled connection.
quiet_fetch() {
  GIT_TERMINAL_PROMPT=0 GIT_SSH_COMMAND='ssh -o BatchMode=yes -o ConnectTimeout=20' \
    git -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=20 \
    fetch -q --no-tags "$@" >/dev/null 2>&1
}

# Where dev can be fetched from, one per line: the clone's origin, then the
# repository's public GitHub URL from Vercel's system variables. The first
# build log after #3601 showed the origin fetch failing on every first
# preview; the repository is public, so the URL needs no credentials.
# IGNORE_BUILD_DEV_URL replaces that URL (the tests point it at a local
# repository). A non-GitHub provider gets no URL.
dev_sources() {
  if git remote get-url origin >/dev/null 2>&1; then
    echo origin
  fi
  if [ -n "${IGNORE_BUILD_DEV_URL:-}" ]; then
    echo "$IGNORE_BUILD_DEV_URL"
  elif [ -n "${VERCEL_GIT_REPO_OWNER:-}" ] && [ -n "${VERCEL_GIT_REPO_SLUG:-}" ] &&
    { [ -z "${VERCEL_GIT_PROVIDER:-}" ] || [ "${VERCEL_GIT_PROVIDER}" = github ]; }; then
    echo "https://github.com/${VERCEL_GIT_REPO_OWNER}/${VERCEL_GIT_REPO_SLUG}.git"
  fi
}

# Sets `base` to the merge base of HEAD with dev and returns 0, or sets `why`
# to the step that failed and returns 1 (the caller builds). Tries the refs the
# clone has, then one shallow fetch of dev from each source in turn, then, if
# the shallow histories share no commit, one deepening of dev and of the
# deployed branch ($1) from the source that answered.
find_dev_base() {
  base=''
  why=''
  for candidate in origin/dev dev; do
    if git rev-parse -q --verify "${candidate}^{commit}" >/dev/null 2>&1; then
      base=$(git merge-base HEAD "$candidate" 2>/dev/null) && [ -n "$base" ] && return 0
    fi
  done
  sources=$(dev_sources)
  if [ -z "$sources" ]; then
    why='no dev ref in the clone, no origin remote, and no public repository URL (VERCEL_GIT_REPO_OWNER/VERCEL_GIT_REPO_SLUG unset)'
    return 1
  fi
  fetched=''
  for source in $sources; do
    if quiet_fetch --depth=200 "$source" "+refs/heads/dev:refs/remotes/origin/dev"; then
      fetched=$source
      break
    fi
  done
  if [ -z "$fetched" ]; then
    why="fetching dev failed from: $(echo $sources)"
    return 1
  fi
  base=$(git merge-base HEAD origin/dev 2>/dev/null) && [ -n "$base" ] && return 0
  if [ -n "$1" ] &&
    quiet_fetch --deepen=200 "$fetched" "+refs/heads/dev:refs/remotes/origin/dev" "+refs/heads/$1:refs/remotes/ignore-build/branch"; then
    base=$(git merge-base HEAD origin/dev 2>/dev/null) && [ -n "$base" ] && return 0
    why="dev fetched from ${fetched}, but it shares no commit with the branch even after deepening both"
    return 1
  fi
  why="dev fetched from ${fetched}, but it shares no commit with the shallow clone, and deepening failed"
  return 1
}

prev="${VERCEL_GIT_PREVIOUS_SHA:-}"

if [ -z "$prev" ]; then
  ref="${VERCEL_GIT_COMMIT_REF:-}"
  if [ "${VERCEL_ENV:-}" != "preview" ] || [ "$ref" = "dev" ] || [ "$ref" = "main" ]; then
    echo "vercel ignore-build: no previous deployment recorded (env '${VERCEL_ENV:-unset}', branch '${ref:-unset}'); building."
    exit 1
  fi
  if ! find_dev_base "$ref"; then
    echo "vercel ignore-build: first preview of '${ref:-unset}' and no merge base with dev found (${why}); building."
    exit 1
  fi
  if watched_unchanged "$base"; then
    echo "vercel ignore-build: first preview of '${ref:-unset}' and nothing watched changed since its merge base with dev (${base}); skipping."
    exit 0
  fi
  echo "vercel ignore-build: first preview of '${ref:-unset}' and watched paths changed since its merge base with dev (${base}), or the diff failed; building."
  exit 1
fi

# Without this check `git diff` would fail on the unknown commit and the build
# would still run (the last branch below); it is here for the clearer log line.
if ! git cat-file -e "${prev}^{commit}" 2>/dev/null; then
  echo "vercel ignore-build: previous deployment ${prev} is not in this clone; building."
  exit 1
fi

if watched_unchanged "$prev"; then
  echo "vercel ignore-build: nothing watched changed since ${prev}; skipping."
  exit 0
fi

echo "vercel ignore-build: watched paths changed since ${prev} (or the diff failed); building."
exit 1
