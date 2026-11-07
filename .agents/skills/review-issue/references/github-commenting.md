# Commenting on a reviewed issue

The comment pattern for [review-issue](../SKILL.md) § *Comment mode*. It applies
only in **review and comment** and **review and repair**; review-only posts
nothing.

## Before the first write

1. Re-read the authorization mode from the user's request and state it in one
   line. If the request was "review this issue", stop — there is nothing to post.
2. Re-read the issue's comment thread. A verdict for the same reviewed SHA that
   already says the same thing is a duplicate; do not post it again. A later
   verdict on a later SHA is a delta, and says so.
3. Draft every comment before posting any of them, so the verdict's
   `Corrections:` count is known before the first write.

## Standalone issue

One comment, on the issue itself: the verdict. No child-style comment, and no
second comment restating the same findings.

## Epic

One **actionable comment on each affected child issue**, plus one verdict on the
tracking issue. A child that the review found nothing wrong with gets no
comment — silence is the finding.

Each child comment carries four parts, in this order:

- **Evidence** — the command and its output, or the comment and its author, that
  establishes the defect.
- **Consequence** — what a builder would get wrong if the slice shipped as
  written.
- **Minimum correction** — the smallest body edit that closes the finding.
- **Regression case** — the check that would catch the defect coming back.

## The verdict

One verdict per pass, on the tracking issue for an epic and on the issue itself
for a standalone task. It:

- **starts** with `Spec-review verdict on`;
- names the **reviewed SHA** and the **readiness** (`ready`, `ready after
  mechanical cleanup`, `not queue-ready`, or `blocked on owner decision`);
- lists the corrections applied and the open questions, naming who answers each;
- links or summarizes the child findings when the review covered an epic;
- **ends** with `Corrections: <n>.`

`Corrections` counts **issue-body changes caused by the review** — wrong claims
fixed, scope gaps settled, criteria rewritten — not comments. It is `0` when the
body stood, and the line is written on every verdict, `0` included, because the
registered re-measurement in [§ Re-measure](../SKILL.md#re-measure-registered-2026-09-24-2781-discipline)
reads it.

Shape:

````markdown
Spec-review verdict on `origin/dev` @ `3d056b8f`: 9 claims re-run, 8 reproduce,
1 wrong (fixed): "27 `-rgb` twins" measures 20 (`grep -rc "rgb(" packages/frontend/src/app`).
Readiness: ready after mechanical cleanup — the stale count in slice 3 is the
only remaining edit.
Child findings: #4101 (blocking, criterion cannot observe the transition),
#4102 (should-fix, missing caller).
Open questions: whether refusal caps belong on the ledger or the agent card.
Corrections: 1.
````

In **review-only** mode the same text is the report to the user, not a comment.

## Read back every comment

A posted comment is not a delivered comment until it is read back and matched to
the intended issue. After posting, fetch the comment by id and check three
things:

```bash
gh api repos/{owner}/{repo}/issues/comments/<id> \
  --jq '{issue: .issue_url, author: .user.login, first: (.body | split("\n")[0])}'
```

- the `issue_url` is the issue the comment was meant for — an epic's child
  finding posted on the tracking issue, or the reverse, is a mis-post;
- the first line is the intended verdict or finding;
- the body is not truncated.

A mismatch is corrected by posting the comment on the right issue and, when the
wrong one is still live, saying so in a reply on it. Report the read-back result
in the pass summary; "posted" without a read-back is not evidence.
