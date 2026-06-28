---
owner: "@d-hinders"
status: current
covers:
  - scripts/docs/**
  - .github/workflows/docs.yml
  - .vale.ini
  - .lychee.toml
  - .markdownlint.json
  - .github/vale/**
last-verified: "2026-06-28"
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

### Validate locally

```bash
npm run docs:check   # validate every doc's front-matter + covers globs
npm run docs:test    # unit tests for the validator's parser & glob matcher
```

`scripts/docs/validate-frontmatter.mjs` is dependency-free (no `js-yaml`): it
checks required keys, the `status` enum, the `last-verified` date format, and
that every `covers` glob resolves to at least one real path. It exits non-zero
on any problem.

## Check layers

### Phase 1 — deterministic checks (this PR)

Run by `.github/workflows/docs.yml`, only when docs or the docs tooling change:

| Check | Tool | Blocking? |
| --- | --- | --- |
| Front-matter + `covers` resolution | `scripts/docs/validate-frontmatter.mjs` | Fails the job (advisory overall — see below) |
| Link health | lychee (`.lychee.toml`) | Advisory (`continue-on-error`) |
| Markdown hygiene | markdownlint-cli2 (`.markdownlint.json`) | Advisory |
| Product-copy terminology | Vale (`.vale.ini`, scoped to `docs/product/**`) | Advisory |

`docs.yml` is **not** a required status check, so even the front-matter step
cannot block a merge yet — it only turns the Docs-quality check red. Vale is
scoped to `docs/product/**` on purpose: engineering docs legitimately use
"Safe", "AllowanceModule", and "signer", so the terminology rule must not flood
them.

### Phase 2 — coupling gate + drift tests (planned, [#644](https://github.com/d-hinders/Haven-AI/issues/644))

A CI step that, when a PR changes a file matched by some doc's `covers` glob
without touching that doc, posts an advisory comment naming the doc and its
`last-verified` age. Plus vitest drift tests (modeled on the OpenAPI test) for
hand-maintained mirrors such as the `CLAUDE.md` API table and `.env.example`.

### Phase 3 — `haven-doc-reviewer` agent (planned, [#645](https://github.com/d-hinders/Haven-AI/issues/645))

A read-only review agent that flags specific doc claims a diff has invalidated,
wired into the `/ship-next` loop so doc updates become part of done.

### Phase 4 — promotion + audit cron (deferred, [#646](https://github.com/d-hinders/Haven-AI/issues/646))

Promote a short list of contract docs to blocking checks, and add a scheduled
audit that opens issues for the stalest docs. Deferred until the advisory
signal from Phases 1–3 is proven low-noise.
