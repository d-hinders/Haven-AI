---
owner: "@d-hinders"
status: current
covers:
  - scripts/docs/**
  - .github/workflows/docs.yml
  - .github/workflows/docs-coupling.yml
  - .agents/skills/haven-agent-workflow/references/doc-reviewer.md
  - .vale.ini
  - .lychee.toml
  - .markdownlint.json
  - .github/vale/**
  - packages/backend/src/openapi/spec.test.ts
  - packages/backend/src/docs-drift/docs-drift.test.ts
last-verified: "2026-07-01"
---

# Documentation-quality system

Keep the repo's docs trustworthy as code ships — so both agents and people can
read this repository and know its real state. This is the living spec for epic
[#642](https://github.com/d-hinders/Haven-AI/issues/642).

## Why

We've repeatedly hit inaccurate docs after code changed. Nothing coupled docs to
the code they describe, so drift was silent. The one exception — the OpenAPI
drift test (`packages/backend/src/openapi/spec.test.ts`) — is exactly the
pattern this system generalizes: fail loudly when a doc and the code it mirrors
disagree.

## Design principles

- **Defense in depth.** Several independent layers, cheapest and most
  deterministic first, the LLM/agent layer last.
- **Advisory before blocking.** New checks land non-blocking. They are promoted
  to required only once the signal is trusted (Phase 4).
- **The mapping is the linchpin.** You cannot detect a stale doc without knowing
  which code it describes. That mapping lives in each doc's `covers:`
  front-matter and every later layer hangs off it.

## Front-matter schema (Phase 1)

Every doc under `docs/` plus the root gravity files (`CLAUDE.md`, `AGENTS.md`,
`README.md`, `ABOUT_HAVEN.md`) carries:

```yaml
---
owner: "@handle"           # who keeps this doc honest
status: current            # current | research | archived
covers:                    # repo globs of the code this doc describes
  - packages/backend/src/routes/payments.ts
last-verified: "2026-06-28" # YYYY-MM-DD a human last confirmed accuracy
---
```

- `covers` is **required** but may be empty (`covers: []`) for narrative docs
  with no direct code mirror (indexes, research, archives, process prose). Keep
  it **tight** — list only the code whose change would actually invalidate the
  doc, so the Phase 2 coupling gate stays high-signal.
- `status` must match location: `docs/archive/**` is `archived`,
  `docs/research/**` is `research`.

### Scaffold a new doc

Don't hand-write the header — scaffold it so it's valid on the first try:

```bash
npm run docs:new -- docs/operations/new-thing.md          # → owner @d-hinders, status current, today's date
npm run docs:new -- docs/research/idea.md --owner "@you"   # status inferred as research
```

`scripts/docs/new-doc.mjs` emits a correct front-matter block (owner default
`@d-hinders` overridable with `--owner`, `status` inferred from the path,
`covers: []` with a hint comment, `last-verified` = today) plus an H1 heading,
then you fill in `covers` and the body. It refuses to overwrite an existing
file and is dependency-free like the other `scripts/docs/*` tools.

### Validate locally

```bash
npm run docs:check   # validate every doc's front-matter + covers globs
npm run docs:test    # unit tests for the docs and agent-skill validators
```

`scripts/docs/validate-frontmatter.mjs` is dependency-free (no `js-yaml`): it
checks required keys, the `status` enum, the `last-verified` date format, and
that every `covers` glob resolves to at least one real path. It exits non-zero
on any problem.

`scripts/docs/validate-agent-skills.mjs` validates the canonical skills under
`.agents/skills/`, their relative references, the thin client-adapter targets,
and the boundary between portable workflow text and client-specific mechanics.
It is dependency-free and runs as part of `npm run docs:check`.

## Check layers

### Phase 1 — deterministic checks (this PR)

Run by `.github/workflows/docs.yml`, only when docs or the docs tooling change:

| Check | Tool | Blocking? |
| --- | --- | --- |
| Front-matter + `covers` resolution | `scripts/docs/validate-frontmatter.mjs` | Fails the job (advisory overall — see below) |
| Agent-skill structure + adapter alignment | `scripts/docs/validate-agent-skills.mjs` | Fails the job (advisory overall — see below) |
| Link health | lychee (`.lychee.toml`) | Advisory (`continue-on-error`) |
| Markdown hygiene | markdownlint-cli2 (`.markdownlint.json`) | Advisory |
| Product-copy terminology | Vale (`.vale.ini`, scoped to `docs/product/**`) | Advisory |

`docs.yml` is **not** a required status check, so even the front-matter step
cannot block a merge yet — it only turns the Docs-quality check red. Vale is
scoped to `docs/product/**` on purpose: engineering docs legitimately use
"Safe", "AllowanceModule", and "signer", so the terminology rule must not flood
them.

### Phase 2 — coupling gate + drift tests ([#644](https://github.com/d-hinders/Haven-AI/issues/644))

**Coupling gate** (`.github/workflows/docs-coupling.yml` →
`scripts/docs/coupling-gate.mjs`): on every PR, finds docs whose `covers` globs
match a changed file the PR did **not** also touch, and posts a single advisory
sticky comment naming each doc and its `last-verified` age. The script always
exits 0 and the workflow is not a required check, so it can never block a merge.
Run it locally with `node scripts/docs/coupling-gate.mjs --changed=path/a,path/b`.
A doc whose `last-verified` is **today** is suppressed — once you've confirmed it
accurate in a day's work, subsequent edits to a covered file won't re-flag it
the same day (a noise-reduction heuristic; the gate is advisory regardless).

**Drift tests** (`packages/backend/src/docs-drift/docs-drift.test.ts`): vitest
tests, modeled on the OpenAPI drift test, that pin hand-maintained `CLAUDE.md`
claims to the code they mirror:

| Mirror | Pinned to |
| --- | --- |
| `CLAUDE.md` API surface table | `openapiSpec.paths` (path + method) |
| `CLAUDE.md` chain claims (Base 8453 / Gnosis 100) | `lib/chains.ts` registry |

Each carries a `because:` allowlist for intentional exceptions — the default is
"document it correctly", not "add an exception".

### Phase 3 — `haven-doc-reviewer` agent ([#645](https://github.com/d-hinders/Haven-AI/issues/645))

The canonical `haven-doc-reviewer` role under
`.agents/skills/haven-agent-workflow/references/` is read-only. Given a diff, it finds the docs whose `covers:` globs match
the changed code and reports any **specific** claim the diff made stale,
missing, or broken — with the smallest correct update. It's wired into the
agentic workflow (`ai-agent-workflow.md`) and the autonomous loop
(`autonomous-pr-loop.md`): when the coupling gate flags implicated docs, run the
doc reviewer and update them before opening the PR. Advisory in this phase — it
never blocks auto-merge.

### Phase 4 — promotion + audit cron (deferred, [#646](https://github.com/d-hinders/Haven-AI/issues/646))

Promote a short list of contract docs to blocking checks, and add a scheduled
audit that opens issues for the stalest docs. Deferred until the advisory
signal from Phases 1–3 is proven low-noise.
