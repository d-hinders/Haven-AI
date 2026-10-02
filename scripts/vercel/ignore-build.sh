#!/bin/sh
# Vercel "Ignored Build Step" shared by the Vercel projects (#3594; the rule
# itself is #3591's). Vercel runs a project's `ignoreCommand` before every
# build: exit 0 skips the build, any other exit builds.
#
#   sh scripts/vercel/ignore-build.sh <FORCE_VARIABLE> <watched path>...
#
# <FORCE_VARIABLE> names an environment variable that, set to 1, forces one
# build. The watched paths are repo-relative and are everything the project is
# built from. Each project's vercel.json passes both; the project's tests read
# that list from vercel.json, so it has one copy.
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
#     PR's first preview): skip iff the clone has the merge base with dev and
#     nothing watched changed on the branch since it. A frontend PR therefore
#     always gets a preview, even when its newest push is docs-only, while a
#     backend-only PR spends no deployment.
#   - No previous deployment otherwise (production, an unset VERCEL_ENV, or the
#     dev and main branches, whose deployments are the dev host and production):
#     build.

# The watched paths are word-split below; never glob-expand them.
set -f

if [ "$#" -lt 2 ]; then
  echo "vercel ignore-build: usage: ignore-build.sh <FORCE_VARIABLE> <watched path>...; building." >&2
  exit 1
fi

force_var=$1
shift
case "$force_var" in
  '' | [0-9]* | *[!A-Za-z0-9_]*)
    echo "vercel ignore-build: invalid force-variable name '${force_var}'; building." >&2
    exit 1
    ;;
esac

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
WATCHED="$*"

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

prev="${VERCEL_GIT_PREVIOUS_SHA:-}"

if [ -z "$prev" ]; then
  ref="${VERCEL_GIT_COMMIT_REF:-}"
  if [ "${VERCEL_ENV:-}" != "preview" ] || [ "$ref" = "dev" ] || [ "$ref" = "main" ]; then
    echo "vercel ignore-build: no previous deployment recorded (env '${VERCEL_ENV:-unset}', branch '${ref:-unset}'); building."
    exit 1
  fi
  base=""
  for candidate in origin/dev dev; do
    if git rev-parse -q --verify "${candidate}^{commit}" >/dev/null 2>&1; then
      base=$(git merge-base HEAD "$candidate" 2>/dev/null) && break
      base=""
    fi
  done
  if [ -z "$base" ]; then
    echo "vercel ignore-build: first preview of '${ref:-unset}' and no merge base with dev in this clone; building."
    exit 1
  fi
  if watched_unchanged "$base"; then
    echo "vercel ignore-build: first preview of '${ref:-unset}' and nothing watched changed since its merge base with dev (${base}); skipping."
    exit 0
  fi
  echo "vercel ignore-build: first preview of '${ref:-unset}' and watched paths changed since its merge base with dev (or the diff failed); building."
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
