## Summary

- _Describe the change._

## Changed Surfaces

- [ ] Docs / prompts only
- [ ] Frontend UI
- [ ] Backend / API
- [ ] SDK
- [ ] MCP / hosted MCP / signer
- [ ] Money movement, agent authority, or payment execution
- [ ] Generated artifacts, examples, credential handoffs, or demo scripts

## Workflow Used

- Captain:
- Agents used:
- Agents skipped, with reason:
- Worker ownership boundaries, if any:

## Local Checks

- [ ] `git diff --check`
- [ ] Package typecheck/test/build commands, if applicable:
- [ ] Not run, with reason:

## Browser Or Headless Verification

- Browser verification:
- **Rendered-screen evidence** (required for rendered-route / shared-primitive diffs — `npm run screenshot -w packages/frontend -- <routes>`, attach or link desktop + mobile PNGs):
- If skipped, reason:
- Headless equivalent, if browser verification was skipped:

## Intentionally Left Out

- _List out-of-scope items or follow-ups._

## Generated Artifacts And Handoffs

- [ ] No generated artifacts or handoffs changed
- [ ] Updated generated docs, `.env` examples, SDK snippets, demo scripts, or skill bundles
- [ ] Reviewed credential semantics and product language

## CASP / MiCA Guardrail Check

- [ ] Not applicable
- [ ] Applicable and reviewed against `docs/regulatory/casp-risk-guardrails.md`
- Notes:

## Review Status

Name each pass and its verdict. A blank line is not a pass — leave it unfilled and
the merge gate stops here.

- `haven-reviewer`: passed / skipped because ___
  - Required on **every** pull request (`AGENTS.md`). Skipping is allowed and has to be
    argued in writing, right here, where a human reads it.
- `haven-design-reviewer`: passed / passed on re-review after fixes / n/a (not `area:frontend`) / skipped because ___
- [ ] Self-reviewed
- [ ] External review requested
- [ ] External review completed

## Issue Link

Write the keyword **bare** — no backticks, no code span — in the body, in the
pull-request title and in the commit messages alike. A backticked keyword reads
as correct and closes nothing. Bare when you mean it, `Refs` when you do not;
the why is in the comment below.

- [ ] Closes #NNN — the default: the merge closes the issue.
- [ ] Refs #NNN — **operator-verify mode**: a human operator step is still
      outstanding, so the issue must outlive the merge. `Closes` is a GitHub
      keyword and closes the issue whatever this body says elsewhere, so a
      sentence promising it stays open does not survive it. Label the issue
      `operator-verify` as well — that is what the merge-time guard reads.
      Use `Refs` in the **commit messages and the pull-request title** too: all
      three reach `dev`, and a clean body does not excuse a commit (#2320).

<!--
Ticking `Closes` needs no justification, and you do not have to say that
operator-verify mode is not the one — the guard reads assertions about an
issue's post-merge state, not the name of the mode (#2327).

Why the placeholders above are bare (#2382). GitHub's body parse respects
Markdown rendering, so a keyword inside a code span in the BODY is not parsed at
all: PR #2364's body carried the backticked form, its `closingIssuesReferences`
came back empty, the merge linked nothing, and #2361 had to be closed by hand.
The opposite holds in a commit message or the pull-request title, where nothing
renders Markdown and the same bytes DO close it (#2268, #2320). So a code span
is not a way to control this in either direction — which is why an author who
ticked the box and filled the backticked placeholder in place shipped a body
that looked right and closed nothing.

The placeholder is `NNN` rather than the `<n>` this repository uses everywhere
else, and only on these two lines. Bare `<n>` is an unrecognised inline HTML tag,
which GitHub-flavoured Markdown strips: an unfilled line would render as
"Closes #" with no visible placeholder at all. `<n>` is safe everywhere it is
wrapped in a code span, which is every other occurrence in the docs.

Writing ABOUT the closing keyword? Use a form GitHub does not parse: `Refs #<n>`,
a non-numeric placeholder like the `#NNN` ones above, or the number with no keyword in
front of it. A code fence does NOT help: a fenced keyword in a commit message is
how #2268 was closed a second time, and the guard reads a fenced keyword in the
body the same way (#2320).
-->


## Merge Readiness

- CI: pending
- Local checks:
- Review status:
- Risk level: low / medium / high
- Why safe to merge:
- Residual risk:
- Recommended merge order:
