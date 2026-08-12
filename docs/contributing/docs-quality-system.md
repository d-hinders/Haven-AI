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
  - packages/backend/src/docs-drift/env-example-drift.test.ts
  - .env.example
last-verified: "2026-08-12" # #1337: strict-gaten släpper en BEVISAT beräknad tom change-set (ren merge/sync-PR); okänd/trasig diff förblir fail-closed (#1076)
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
contract: true             # OPTIONAL (Phase 4): promotes the coupling gate
                           # from advisory to BLOCKING for this doc
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

Run by `.github/workflows/docs.yml` on **every** pull request:

| Check | Tool | Blocking? |
| --- | --- | --- |
| Front-matter + `covers` resolution | `scripts/docs/validate-frontmatter.mjs` | **Blocking** |
| Agent-skill structure + adapter alignment | `scripts/docs/validate-agent-skills.mjs` | **Blocking** |
| Link health | lychee (`.lychee.toml`) | Advisory (`continue-on-error`) |
| Markdown hygiene | markdownlint-cli2 (`.markdownlint.json`) | Advisory |
| Product-copy terminology | Vale (`.vale.ini`, scoped to `docs/product/**`) | Advisory |

The two validators are whole-repo and dependency-free, which is why the
`pull_request` trigger carries **no `paths:` filter** — a required check must
report on every PR or auto-merge deadlocks waiting for a run that never happens
(the #933 lesson; see [`autonomous-pr-loop.md`](autonomous-pr-loop.md) §One-time
setup). Add **Docs front-matter & agent skills** to the "Haven automerge rules"
ruleset for the blocking column above to be true.

Until [#1023](https://github.com/d-hinders/Haven-AI/issues/1023) these ran as a
hard gate only inside `ship-next`, which made the canonical workflow stricter
than opening a pull request by hand — a standard's enforcement should not depend
on which tool opened the PR.

Vale is scoped to `docs/product/**` on purpose: engineering docs legitimately use
"Safe", "AllowanceModule", and "signer", so the terminology rule must not flood
them.

### Phase 2 — coupling gate + drift tests ([#644](https://github.com/d-hinders/Haven-AI/issues/644))

**Coupling gate** (`.github/workflows/docs-coupling.yml` →
`scripts/docs/coupling-gate.mjs`): on every PR, finds docs whose `covers` globs
match a changed file the PR did **not** also touch, and posts a single advisory
sticky comment naming each doc and its `last-verified` age.

**Run `npm run docs:coupling` locally — it is the strict, CI-equivalent form.**
The bare `node scripts/docs/coupling-gate.mjs` is the *advisory* posture: it always
exits 0, so it does not tell you what CI will say. Since Phase 4 the same script
also runs `--strict`, where a `contract: true` doc is **blocking** (see below).
`--changed=path/a,path/b` still forces an explicit file list.

With no `--changed` and no `BASE_SHA`, the candidate set is the working tree —
`origin/dev...HEAD` **plus** staged, unstaged and untracked files. Committed
changes alone reported "no covered docs implicated" for an uncommitted diff, and
that false green is how [#1076](https://github.com/d-hinders/Haven-AI/pull/1076)
reached CI with an untouched contract doc ([#1077](https://github.com/d-hinders/Haven-AI/issues/1077)).
For the same reason an empty candidate set is reported as "nothing was checked"
and fails closed under `--strict`, rather than passing.

A doc whose `last-verified` is **today** is suppressed — once you've confirmed it
accurate in a day's work, subsequent edits to a covered file won't re-flag it
the same day. This is a noise-reduction heuristic for the advisory comment and it
does **not** apply to a contract doc under `--strict`: a blocking check must not
depend on wall-clock time, and a doc some *other* PR verified today says nothing
about whether this one made it stale.

**Scoping `covers` (#1077).** `covers` means *this doc describes that code*, not
*this doc applies to that code*. A standing checklist that globs
`src/components/**` fires on every frontend PR and buries the one ⚠️ finding that
mattered — so scope a checklist to the design system it checks against **plus the
money and authority screens it actually contains rules about**, not to every
screen it is applied to. Narrowing to zero is the opposite failure: a doc that
matches nothing never gets the doc-reviewer nudge, so keep a real net.
Two related rules the gate applies for you:
test files and generated files (`__tests__/`, `*.test.*`, `*.spec.*`,
`packages/core/src/api-types.ts`) implicate a doc only when `covers` names the
path **exactly** — a wildcard does not sweep them up, since prose is not made
stale by a test being added; and a `#` comment may only trail a `covers` item,
never occupy its own line, which would silently truncate the list.

**Drift tests** (`packages/backend/src/docs-drift/`): vitest tests, modeled on
the OpenAPI drift test, that pin hand-maintained doc/config claims to the code
they mirror:

| Mirror | Pinned to | Test |
| --- | --- | --- |
| `CLAUDE.md` API surface table | `openapiSpec.paths` (path + method) | `docs-drift.test.ts` |
| `CLAUDE.md` chain claims (Base 8453 / Gnosis 100) | `domain/chains.ts` registry | `docs-drift.test.ts` |
| `.env.example` documented keys | env vars read in the code (`process.env.X`, `requireEnv`/`optionalEnv`) | `env-example-drift.test.ts` |

The `.env.example` mirror is two-directional: every var the **backend** reads
must be documented, and every documented key must be read **somewhere** in the
repo (backend, frontend, scripts, or the qa/demo packages) — so config docs
can't silently drift from what a deployment actually reads.

Each carries a `because:` allowlist for intentional exceptions — the default is
"document it correctly" / "delete the dead key", not "add an exception". The
`.env.example` allowlists are self-checked so they can't rot: an entry that no
longer applies (the var is now documented, or is no longer read) fails the suite.

### Phase 3 — `haven-doc-reviewer` agent ([#645](https://github.com/d-hinders/Haven-AI/issues/645))

The canonical `haven-doc-reviewer` role under
`.agents/skills/haven-agent-workflow/references/` is read-only. Given a diff, it finds the docs whose `covers:` globs match
the changed code and reports any **specific** claim the diff made stale,
missing, or broken — with the smallest correct update. It's wired into the
agentic workflow (`ai-agent-workflow.md`) and the autonomous loop
(`autonomous-pr-loop.md`): when the coupling gate flags implicated docs, run the
doc reviewer and update them before opening the PR. Advisory in this phase — it
never blocks auto-merge.

### Phase 4 — promotion + audit cron ([#646](https://github.com/d-hinders/Haven-AI/issues/646), shipped 2026-07-18)

Two mechanisms, both live:

- **Contract docs block.** A doc marked `contract: true` in front-matter is
  promoted from advisory to blocking: the `Contract-doc coupling` job in
  `docs-coupling.yml` reruns the gate with `--strict`, which exits 1 when a
  contract doc's covered code changed but the doc wasn't touched in the PR
  (a crash also fails closed in strict mode). The fix is always in-PR: update
  the doc, or genuinely re-verify it and bump `last-verified`. The advisory
  comment marks contract findings with ⚠️. Initial contract set:
  `dev-environment`, `branch-and-release-flow`,
  `delegation-rail-security-model`, `casp-risk-guardrails`,
  `mcp-runtime-compatibility`. **Operator note:** the check must be added to
  the "Haven automerge rules" ruleset's required checks — without a paths
  filter (the #933 lesson).
- **Weekly staleness audit.** `scripts/docs/audit-staleness.mjs` ranks every
  covered, non-archived doc by commits touching its `covers:` paths since its
  `last-verified` date. `docs-audit.yml` runs it Mondays 06:00 UTC and upserts
  the report into one tracking issue ("Docs staleness audit (weekly)") — a
  standing queue of which doc is most likely lying, never a spam of new
  issues. Run it locally anytime: `node scripts/docs/audit-staleness.mjs`.
