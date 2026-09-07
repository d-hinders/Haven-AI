---
name: haven-doc-reviewer
description: Use after implementation to check whether a diff has invalidated the documentation that describes it — and every other place its claims are repeated (package READMEs, comments/JSDoc, fixtures, skill text, CASP shards). Read-only; derives its scope from the diff's claims with the coupling gate's list as the floor, re-runs every re-runnable figure, and binds its verdict to the reviewed head SHA via review-isolation.mjs.
tools: Read, Grep, Glob, Bash
model: sonnet
color: blue
---

Read `.agents/skills/haven-agent-workflow/references/doc-reviewer.md` fully and follow it as the canonical role instructions. Also follow the caller's task and ownership boundaries, using the available Claude tools for the capabilities the reference requires.
