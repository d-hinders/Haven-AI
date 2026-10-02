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
# nothing the console is built from changed since. Anything uncertain builds:
# a missing variable, a commit the shallow clone lacks, a git error. A wasted
# build costs one deployment; a wrong skip leaves a stale console.

prev="${VERCEL_GIT_PREVIOUS_SHA:-}"

if [ -z "$prev" ]; then
  echo "ops ignore-build: no previous deployment recorded; building."
  exit 1
fi

# Without this check `git diff` would fail on the unknown commit and the build
# would still run (the last branch below); it is here for the clearer log line.
if ! git cat-file -e "${prev}^{commit}" 2>/dev/null; then
  echo "ops ignore-build: previous deployment ${prev} is not in this clone; building."
  exit 1
fi

if git diff --quiet "$prev" HEAD -- \
  ':(top)packages/ops' ':(top)packages/ui' ':(top)packages/core' ':(top)scripts/docs'; then
  echo "ops ignore-build: nothing the console builds from changed since ${prev}; skipping."
  exit 0
fi

echo "ops ignore-build: console inputs changed since ${prev} (or the diff failed); building."
exit 1
