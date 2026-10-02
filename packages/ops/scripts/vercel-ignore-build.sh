#!/bin/sh
# Vercel "Ignored Build Step" for the ops console (#3591). Vercel runs this
# before every build: exit 0 skips the build, any other exit builds.
#
# It compares HEAD with the last commit this project actually DEPLOYED
# (VERCEL_GIT_PREVIOUS_SHA), not with HEAD's own parent. The #3580 form,
# `git diff HEAD^ HEAD`, skipped every build whose newest commit happened not
# to touch the console. So once the build for an ops change was lost (the
# daily deployment cap, a failed build), the change never deployed: every
# later dev commit was "unrelated" (#3591).
#
# It skips ONLY when the previous deployment's commit is in the clone and
# nothing the console is built from changed since. For production, anything
# uncertain builds: a missing variable, a commit the shallow clone lacks, a
# git error. A wasted build costs one deployment; a wrong skip leaves a stale
# console.
#
# One exception keeps the daily deployment cap intact: a PREVIEW branch with
# no earlier deployment (its first push) falls back to the newest commit's own
# diff, so a frontend-only PR does not build an ops preview. Previews are
# disposable; a stale production console is the failure this script exists
# to prevent. An unset VERCEL_ENV counts as production.

# `:(top)` pathspecs: Vercel runs this from the Root Directory (packages/ops),
# where a relative pathspec would match nothing and always skip.
console_unchanged() {
  git diff --quiet "$1" HEAD -- \
    ':(top)packages/ops' ':(top)packages/ui' ':(top)packages/core' ':(top)scripts/docs'
}

# Rebuilding an UNCHANGED commit (after changing a build-time variable such as
# NEXT_PUBLIC_OPS_ENVIRONMENTS, which Next inlines) would always skip, because
# nothing changed since the last deployment. OPS_FORCE_BUILD=1 in the project's
# environment variables forces one build; remove it afterwards
# (docs/operations/ops-console.md).
if [ "${OPS_FORCE_BUILD:-}" = "1" ]; then
  echo "ops ignore-build: OPS_FORCE_BUILD=1; building."
  exit 1
fi

prev="${VERCEL_GIT_PREVIOUS_SHA:-}"

if [ -z "$prev" ]; then
  if [ "${VERCEL_ENV:-}" = "preview" ] && git rev-parse -q --verify HEAD^ >/dev/null 2>&1; then
    if console_unchanged HEAD^; then
      echo "ops ignore-build: first preview of this branch and its newest commit does not touch the console; skipping."
      exit 0
    fi
    echo "ops ignore-build: first preview of this branch and its newest commit touches the console (or the diff failed); building."
    exit 1
  fi
  echo "ops ignore-build: no previous deployment recorded; building."
  exit 1
fi

# Without this check `git diff` would fail on the unknown commit and the build
# would still run (the last branch below); it is here for the clearer log line.
if ! git cat-file -e "${prev}^{commit}" 2>/dev/null; then
  echo "ops ignore-build: previous deployment ${prev} is not in this clone; building."
  exit 1
fi

if console_unchanged "$prev"; then
  echo "ops ignore-build: nothing the console builds from changed since ${prev}; skipping."
  exit 0
fi

echo "ops ignore-build: console inputs changed since ${prev} (or the diff failed); building."
exit 1
