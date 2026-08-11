# Repo Agent Skills

This directory is the repo-owned source of truth for portable Haven agent
skills. Keep reusable workflows here instead of burying them in one harness'
command format.

## Layout

- `skills/<name>/SKILL.md`: Agent Skills open-standard playbook with `name` and
  `description` frontmatter.
- `skills/<name>/references/`: Optional details loaded only when the skill asks
  for them.

## Install

Install or refresh the skills for local harnesses:

```bash
npm run skills:install
```

By default this symlinks every folder in `.agents/skills` into:

- `${CODEX_HOME:-~/.codex}/skills`
- `~/.claude/skills`

Use `--copy` when a harness or filesystem cannot follow symlinks:

```bash
npm run skills:install -- --copy
```

Use `npm run skills:check` before changing these skills. It validates required
frontmatter without writing outside the repo. Use `npm run docs:check` for the
full repo agent-skill validation, including wrappers and relative links.

Claude slash commands in `.claude/commands` should stay thin wrappers that route
to these skills. Codex users can invoke the installed skills directly, for
example `$haven-reset`, `$ship-next`, or `$quality-scan`.
