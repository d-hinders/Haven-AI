Issue bodies for scripts/docs/issue-method.test.mjs (#4771).

repo-*.md read commit 249c77ca0, the base commit of the small repository the
test builds with fixed author, committer and dates, so the SHA is the same on
every machine. The test asserts that SHA before it uses these files.

real-*.md read 49747fac3, a commit of this repository. They run only where
that commit and origin/dev are present; a depth-1 CI checkout has neither, and
the test says so by skipping those cases by name.

Every body here is test input. None of it is ever executed.
