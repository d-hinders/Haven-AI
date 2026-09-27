// The package-to-job routing matrix (#1623, epic #1621).
//
// One row per routing decision the CI change classifier makes, with the FULL
// expected output — all thirteen flags, not just the one that turns true. This is a
// characterization fixture: it is written to describe what routing does today,
// before #1624/#1625 make the rule data declarative and #1626 starts enforcing
// completeness. Refactors are supposed to leave it untouched. A row that has to
// change is a routing change, and should be argued for as one.
//
// Every row carries a `kind`, because the two are not the same obligation:
//
//   CONTRACT — a required compatibility constraint. Something depends on this
//     routing: a guard only runs in that job, or a package's suite would stop
//     covering its own code. Changing it needs a reason and a migration.
//
//   RETAINED — current behaviour, deliberately preserved so the extraction and
//     the declarative slices stay honest, but NOT endorsed. These are the rows
//     #1626 (routing completeness) is expected to revisit. Pinning them is what
//     makes a future change visible instead of accidental.
//
// The distinction only means something if RETAINED rows really are the arguable
// ones, so each says what is arguable about it.
//
// Consumed by routing-matrix.test.mjs. Dependency-free, like everything in this
// directory, so it runs in the unconditional `ci_config_checks` job.

/** A required compatibility constraint — something depends on this routing. */
export const CONTRACT = 'contract'

/** Current behaviour, pinned but not endorsed — a later slice may change it. */
export const RETAINED = 'retained'

/**
 * Shorthand for "every flag true".
 *
 * Spelled out rather than imported from the classifier: a fixture that derives
 * its expectation from the code under test cannot fail when that code is wrong,
 * which is the one thing a characterization table must not do.
 */
const ALL = ['code', 'frontend', 'backend', 'sdk', 'connect', 'mcp', 'mcp_server', 'signer', 'cli', 'demo_merchant', 'core', 'qa_agent', 'full']

/**
 * @typedef {object} RoutingCase
 * @property {string[]} files   changed paths, as `git diff --name-only` emits them
 * @property {string[]} expect  the flags that must be TRUE; every other flag must be false
 * @property {'contract'|'retained'} kind
 * @property {string} why       why this routing is required, or what is arguable about it
 */

/** @type {RoutingCase[]} */
export const ROUTING_MATRIX = [
  // ─── Documentation routes nowhere ──────────────────────────────────────────
  {
    files: ['README.md'],
    expect: [],
    kind: CONTRACT,
    why: 'Prose cannot break a build. Routing it would run the full suite on every doc edit.',
  },
  {
    files: ['docs/product/copy-guidelines.md'],
    expect: [],
    kind: CONTRACT,
    why:
      'Same, for the docs/ tree. The docs-quality gates cover these on their own workflow. ' +
      'Re-pointed here from agent-passport.md by #3346, which made the served docs a real ' +
      'exception; this row is also the CONTROL the same issue asks for — another docs/**/*.md ' +
      'must keep returning all thirteen flags false.',
  },
  {
    files: ['docs/product/account-recovery.md'],
    expect: ['code', 'frontend'],
    kind: CONTRACT,
    why:
      'A SERVED doc (#3346): the frontend serves it at /docs/account-recovery.md from the ' +
      'ALLOWLIST in packages/frontend/scripts/serve-docs.mjs, and served-docs.test.ts pins it — ' +
      'a test only frontend_checks runs. #3287 edited a sibling on the same list, routed ' +
      'NOTHING, and the test went red on dev (#3288). `code` is required alongside `frontend`: ' +
      'the gate job exits 0 when code != true before it ever reads frontend_checks.result.',
  },
  {
    files: ['docs/product/agent-key-rotation.md'],
    expect: ['code', 'frontend'],
    kind: CONTRACT,
    why:
      'A SERVED doc (#3346), same arm as account-recovery.md. Each source on the ALLOWLIST ' +
      'gets its own row rather than one row for a sample: the arm is derived from the ' +
      'generator, so a row per source is what fails the day a source silently stops routing.',
  },
  {
    files: ['docs/product/agent-passport.md'],
    expect: ['code', 'frontend'],
    kind: CONTRACT,
    why:
      'A SERVED doc (#3346). This row used to assert this file routes NOWHERE — "the ' +
      'docs-quality gates cover these on their own workflow" — which stopped being true when ' +
      'the file went onto the serve-docs ALLOWLIST and only frontend_checks could still run ' +
      'the pin test on it. The routing change is argued here rather than deleted: the docs-' +
      'quality gates govern the PROSE, but served-docs.test.ts, discovery-artifacts.test.ts ' +
      'and the Next build read the file as data, and #3288 is what happens when their job ' +
      'never runs.',
  },
  {
    files: ['docs/security/delegation-rail-security-model.md'],
    expect: ['code', 'frontend'],
    kind: CONTRACT,
    why:
      'A SERVED doc (#3346) at /docs/security-model.md, and the file the incident is named ' +
      'for: #3287 edited it in a backend-only PR, it routed nothing, Frontend checks skipped, ' +
      'and served-docs.test.ts went red on dev (#3288). If this row ever fails again, the ' +
      'derived arm in DOC_EXCEPTIONS lost the ALLOWLIST.',
  },
  {
    files: ['docs/exit/README.md'],
    expect: ['code', 'frontend'],
    kind: CONTRACT,
    why:
      'Not served, but read by packages/frontend/src/lib/__tests__/non-custody-no-lockin.test.ts ' +
      '(#3346) — the frontend suite pins the exit story\'s wording, so an edit to this file ' +
      'runs frontend_checks or the pin never guards the edit. Same rationale as the CLAUDE.md ' +
      'row: the file mirrors a contract a package test asserts, so it routes that package.',
  },
  {
    files: ['docs/contributing/ship-playbooks/frontend.md'],
    expect: [],
    kind: CONTRACT,
    why: 'A nested doc is still a doc. Depends on globs not being path-aware — the property that also makes packages/frontend/* cover its subtree.',
  },
  {
    files: ['a/b/c/notes.md'],
    expect: [],
    kind: CONTRACT,
    why: 'Markdown anywhere in the tree is documentation, not only under docs/.',
  },
  {
    files: ['AGENTS.md'],
    expect: [],
    kind: CONTRACT,
    why: 'A gravity file, but prose. Named explicitly in the rules even though *.md already covers it.',
  },
  {
    files: ['LICENSE'],
    expect: [],
    kind: CONTRACT,
    why: 'Extensionless, so *.md does not reach it; it needs its own pattern.',
  },
  {
    files: ['LICENSE.txt'],
    expect: [],
    kind: CONTRACT,
    why: 'The LICENSE.* pattern exists for the suffixed spellings that *.md does not cover.',
  },
  {
    files: ['CLAUDE.md'],
    expect: ['code', 'backend'],
    kind: CONTRACT,
    why:
      'The FIRST Markdown exception, and no longer the only one — #2743 added two more for ' +
      'packages/frontend/public/, so this row states its own case rather than a count. ' +
      'CLAUDE.md mirrors the API surface table and chain registry that ' +
      'packages/backend/src/docs-drift pins, so a CLAUDE.md-only edit must run the backend ' +
      'suite or the drift test never guards it.',
  },

  // ─── One workspace, one job ────────────────────────────────────────────────
  {
    files: ['packages/frontend/src/app/page.tsx'],
    expect: ['code', 'frontend'],
    kind: CONTRACT,
    why: 'Frontend alone fans out to nothing — the check that the full-matrix rule is not firing spuriously.',
  },
  {
    files: ['packages/backend/src/routes/payments.ts'],
    expect: ['code', 'backend'],
    kind: CONTRACT,
    why: 'Backend alone. Nothing depends on the backend, so it fans out to nothing.',
  },
  {
    files: ['packages/connect/src/index.ts'],
    expect: ['code', 'connect'],
    kind: CONTRACT,
    why: 'connect is the leaf of the dependency graph — it consumes mcp and signer, nothing consumes it.',
  },
  {
    files: ['packages/mcp-server/src/tools.ts'],
    expect: ['code', 'mcp_server'],
    kind: CONTRACT,
    why: 'Must NOT be swallowed by the packages/mcp/* rule listed above it — the shared prefix is the ordering mistake that would silently stop routing mcp-server.',
  },
  {
    files: ['packages/cli/src/index.ts'],
    expect: ['code', 'cli'],
    kind: CONTRACT,
    why: 'cli is a leaf of the dependency graph — it consumes the SDK, but nothing consumes it, so it fans out to nothing.',
  },
  {
    files: ['packages/demo-merchant-mcp/src/index.ts'],
    expect: ['code', 'demo_merchant'],
    kind: CONTRACT,
    why: 'demo_merchant is a leaf of the dependency graph (#2996) — it declares no internal @haven_ai/* dependency today, checked against the real package.json, and nothing consumes it, so it fans out to nothing in either direction.',
  },
  {
    files: ['packages/core/src/chains.ts'],
    expect: ['code', 'core', 'frontend', 'backend'],
    kind: CONTRACT,
    why: 'The shared kernel got its own job in #3005, and frontend and backend declare @haven_ai/core, so the table fans both out: the suites that consume core run on a core change WITHOUT the full matrix. Until #3005 this routed ALL — over-routing that ran cli and signer suites blind to core.',
  },
  {
    files: ['packages/qa-agent/src/run.ts'],
    expect: ['code', 'qa_agent'],
    kind: CONTRACT,
    why: 'The QA harness got its own unit-test job in #3005 and fans out to nothing in reverse — no package consumes it. sdk and signer fan out TO it (its tests import both), so this is the direction that stays a leaf.',
  },
  {
    files: ['packages/brand-new-workspace/src/index.ts'],
    expect: ALL,
    kind: CONTRACT,
    why:
      'The packages/* catch-all, characterized directly. Every real workspace now has its own ' +
      'arm above it (#3005 moved the last two, core and qa-agent, out), so the first match that ' +
      'reaches this rule is a workspace that does not exist yet — and routing it EVERYTHING is ' +
      'the safe direction for the unknown, the same over-routing the old core/qa-agent RETAINED ' +
      'rows pinned. This row is what keeps the arm honest now that no real file exercises it.',
  },

  // ─── Dependency propagation ────────────────────────────────────────────────
  {
    files: ['packages/sdk/src/client.ts'],
    expect: ['code', 'sdk', 'backend', 'connect', 'mcp', 'mcp_server', 'signer', 'qa_agent'],
    kind: CONTRACT,
    why: 'Every published package builds on the SDK and the backend is pinned against its wire types, so an SDK edit must run all of them. qa_agent joined in #3005: its tests import the SDK, and its job runs those tests. Frontend stays out because it consumes @haven_ai/core, not the SDK.',
  },
  {
    files: ['packages/mcp/src/index.ts'],
    expect: ['code', 'mcp', 'connect', 'mcp_server'],
    kind: CONTRACT,
    why: 'connect bundles the MCP runtime it hands out, so it must rebuild when mcp changes. mcp_server joined in #2348 on the same reasoning as the signer row below: its strict-tool-input test imports @haven_ai/mcp toolSchemas to pin the local-vs-hosted argument spellings against the real local surface rather than restating them as literals, and mcp_server_checks runs that test -- so a rename in the local schemas must run it, which is exactly what the pin is for.',
  },
  {
    files: ['packages/signer/src/index.ts'],
    expect: ['code', 'signer', 'connect', 'mcp_server', 'qa_agent'],
    kind: CONTRACT,
    why: 'connect bundles the signer, and mcp_server consumes it too — its hosted-signer-integration test imports @haven_ai/signer, and mcp_server_checks runs that test. mcp_server was MISSING here until #1625 derived fan-out from the real dependency graph; a signer change could break that test with its job never running. qa_agent joined for the same reason in #3005: its tests run the real signer in-process.',
  },
  {
    files: ['packages/frontend/src/app/page.tsx', 'packages/cli/src/index.ts'],
    expect: ['code', 'frontend', 'cli'],
    kind: CONTRACT,
    why: 'Flags accumulate across files and never turn back off; two unrelated leaves stay two.',
  },
  {
    files: ['docs/operations/dev-environment.md', 'packages/backend/src/routes/payments.ts'],
    expect: ['code', 'backend'],
    kind: CONTRACT,
    why: 'A doc in the same PR neither adds nor suppresses routing — the common real-world diff shape.',
  },

  // ─── Root config forces the full matrix ────────────────────────────────────
  {
    files: ['package.json'],
    expect: ALL,
    kind: CONTRACT,
    why: 'Root manifest changes can alter any workspace’s install or scripts, so nothing may be skipped.',
  },
  {
    files: ['package-lock.json'],
    expect: ALL,
    kind: CONTRACT,
    why: 'A lockfile change can move any dependency under any package.',
  },
  {
    files: ['tsconfig.json'],
    expect: ALL,
    kind: CONTRACT,
    why: 'Root compiler options are inherited by every package that extends them.',
  },
  {
    files: ['.github/workflows/ci.yml'],
    expect: ALL,
    kind: CONTRACT,
    why: 'A workflow edit can change what any job does — including this classifier itself, which is why a PR touching it runs everything.',
  },
  {
    files: ['.github/workflows/brand-new.yaml'],
    expect: ALL,
    kind: CONTRACT,
    why: 'Both YAML spellings are matched, and a workflow file that does not exist yet is still covered.',
  },
  {
    files: ['packages/backend/tsconfig.json'],
    expect: ['code', 'backend'],
    kind: CONTRACT,
    why: 'The tsconfig*.json rule is anchored at the repo root. A package-local tsconfig must route to its own package, not escalate a one-package change into the full matrix.',
  },

  // ─── Guards outside packages/ that police a package ────────────────────────
  // Nine guards, twelve files, grouped into five SURFACE_RULES entries — the
  // three counts differ, so it is worth being explicit. The guards are: the
  // dependency-cruiser rule set, dep-lint, the db-mock ratchet, the retired-rail
  // prose ratchet, the API-type generator, the shared ratchet engine, the
  // wire-type ratchet, and the network-map pin test. Five of them ship a
  // self-test as a separate file, which is where twelve files come from; rules
  // that share a target package are collapsed into one entry, which is where
  // five comes from.
  //
  // Each exists because the guard lives outside the tree it polices and only
  // that package's job runs it: without the arm, a PR that ONLY weakens the
  // guard goes green with the guard never running.
  {
    files: ['.dependency-cruiser.cjs'],
    expect: ['code', 'backend'],
    kind: CONTRACT,
    why: 'The dependency-boundary rule set (#982). Weakening a rule must run the gate that enforces it.',
  },
  {
    files: ['scripts/dep-lint.mjs'],
    expect: ['code', 'backend'],
    kind: CONTRACT,
    why: 'The dependency-boundary gate itself (#982).',
  },
  {
    files: ['packages/sdk/src/agent-guidance.ts'],
    expect: ['code', 'sdk', 'cli', 'frontend', 'backend', 'connect', 'mcp', 'mcp_server', 'signer', 'qa_agent'],
    kind: CONTRACT,
    why:
      'The canonical agent runbook (#2727). Other packages hold pinned derivations of it so they ' +
      'stay installable alone — the CLI a full-text copy, the frontend a full-text copy PLUS two ' +
      'partial ones (agent-onboarding-prompt.ts, agent-skill-bundle.ts) — and each is byte-pinned ' +
      'by a test in its own job. Before this row, an SDK-only change reached neither cli nor ' +
      'frontend, so none of those tests ran: #2713 edited this file and left the CLI copy stale, ' +
      'and dev did not even go red — cli_checks was skipped, so the stale copy was carried until ' +
      'an unrelated backend PR (#2719) regenerated it. lint:runbook-parity covers the two ' +
      'full-text copies from every job that owns the source; the ' +
      'partial ones are not readable back, so frontend is ROUTED rather than checked. That is the ' +
      'reason both jobs are here, and why removing either silently uncovers a pin test.',
  },
  {
    files: ['packages/cli/scripts/sync-agent-guidance.mjs'],
    expect: [
      'code',
      'sdk',
      'cli',
      'frontend',
      'backend',
      'connect',
      'mcp',
      'mcp_server',
      'signer',
      'qa_agent',
    ],
    kind: CONTRACT,
    why:
      'The generator/verifier for those copies (#2727). It lives under packages/cli/ but reads ' +
      'packages/sdk/ and is run by all three jobs that check a copy, so all three own it. The ' +
      'explicit cli matters: root-guard rules match before the packages/cli/* arm, so omitting ' +
      "it would stop a change here routing the CLI's own suite — a rule that quietly narrows " +
      'what it was added to widen.',
  },
  {
    files: ['packages/frontend/public/402.md'],
    expect: ['code', 'frontend'],
    kind: CONTRACT,
    why:
      'The GENERAL public/ arm (#2743), and the row that reaches it — the for-agents.md row ' +
      'below matches the same glob but resolves to the specific arm ordered before it, so ' +
      'without this row the general arm had no fixture that actually exercised it. 402.md is ' +
      'authored rather than generated, advertised from llms.txt and 402/index.html, and its ' +
      'content is asserted by discovery-artifacts.test.ts — a frontend-only test, which is why ' +
      '`frontend` is the surface that matters and why routing nothing left it unchecked.',
  },
  {
    files: ['packages/frontend/public/for-agents.md'],
    expect: [
      'code',
      'sdk',
      'cli',
      'frontend',
      'backend',
      'connect',
      'mcp',
      'mcp_server',
      'signer',
      'qa_agent',
    ],
    kind: CONTRACT,
    why:
      'The served runbook (#2743) — a GENERATED artifact that happens to be Markdown, so the ' +
      'DOC_ONLY `*.md` arm swallowed it and a hand-edit routed NOTHING, not even `code`. Its ' +
      'sibling copy packages/cli/src/agent-guidance-text.ts routed `cli`, and its NON-MARKDOWN ' +
      'siblings in public/ routed `frontend` — the other Markdown file there, 402.md, was ' +
      'swallowed too, which is why DOC_EXCEPTIONS also carries a general arm for the ' +
      'directory. #2727 routed the SOURCE; this row routes the COPY, the other direction. ' +
      'As above, only `sdk`, `cli` and `frontend` are decided by the arm — the other six come ' +
      'from `dependentsOf(sdk)` (qa_agent joined in #3005) — and `cli`/`frontend` are named by ' +
      'hand because both declare no SDK-dependency fan-out can reach.',
  },
  {
    files: ['packages/sdk/src/skill-content.ts'],
    expect: [
      'code',
      'sdk',
      'frontend',
      'backend',
      'connect',
      'mcp',
      'mcp_server',
      'signer',
      'qa_agent',
    ],
    kind: CONTRACT,
    why:
      'The canonical generic payment skill (#2743). The frontend keeps a decoupled inline copy ' +
      'so it can deploy standalone, and agent-skill-bundle.test.ts imports THIS file to assert ' +
      'byte parity — a test that runs only in frontend_checks. #2727 closed this shape for ' +
      'agent-guidance.ts and left this file behind: sdk routed, frontend did not, so a mutation ' +
      'here failed a test in a job that never ran. Of the nine surfaces, only `sdk` and ' +
      '`frontend` are decided here: backend, connect, mcp, mcp_server, signer and (since #3005) ' +
      'qa_agent arrive by `dependentsOf(sdk)` fanning out through .github/package-dependencies.json. ' +
      'That is also why an entry was the ONLY available mechanism — `frontend` and `cli` both ' +
      'have no dependents and no SDK-reachable fan-in, so no propagation can ever reach either, ' +
      'which is what made them the two surfaces both #2727 and #2743 had to name by hand. ' +
      '`cli` is absent here for a product reason on top of that: the CLI holds no copy of the ' +
      'skill, only of the runbook.',
  },
  {
    files: ['packages/backend/src/infra/chain/x402-binding-signer.ts'],
    expect: ['code', 'backend', 'mcp_server'],
    kind: CONTRACT,
    why:
      'The producer of the Haven-signed x402 expected context (#3046). The mcp-server ' +
      'wire-contract suite imports THIS file across the package boundary — the only runtime ' +
      'import of backend/src from any other package — and runs only in mcp_server_checks. ' +
      'A backend-only PR (#3023) changed its import graph and the MCP job never ran; dev runs ' +
      'skip that job by surface, so the contract proof was absent until the next mcp-server ' +
      'PR failed. `backend` is the generic arm; `mcp_server` is what the manifest entry adds. ' +
      'Nothing fans out from backend, so the entry is the only mechanism (#2727 shape).',
  },
  {
    files: ['packages/backend/src/config/boolean-flag.ts'],
    expect: ['code', 'backend', 'mcp_server'],
    kind: CONTRACT,
    why:
      'The one backend module the binding signer reaches (#3046); it must stay import-free, ' +
      'and an import added here can only be caught by the mcp-server job, so a change routes it.',
  },
  {
    files: ['scripts/dep-lint.test.mjs'],
    expect: ['code', 'backend'],
    kind: CONTRACT,
    why: 'The gate’s own self-test — a lint nobody tests can start passing vacuously.',
  },
  {
    files: ['scripts/db-mock-ratchet.mjs'],
    expect: ['code', 'backend'],
    kind: CONTRACT,
    why: 'The shrink-only db-mock ratchet polices packages/backend tests.',
  },
  {
    files: ['scripts/db-mock-ratchet.test.mjs'],
    expect: ['code', 'backend'],
    kind: CONTRACT,
    why: 'The ratchet’s self-test, same reason as dep-lint’s.',
  },
  {
    files: ['scripts/test-support/guard-cli.mjs'],
    expect: [],
    kind: CONTRACT,
    why:
      'The harness the guard self-tests drive their CLI through (#2721). It routes NOWHERE ' +
      'itself — the classifier reports every flag false — and is covered today only because ' +
      'ci_config_checks and frontend-copy-lint.yml are unconditional and three of its consumers ' +
      'run there. Recorded for the same reason .github/root-guard-ownership.json is: the ' +
      'coverage is incidental, and it evaporates silently the day a consumer moves off an ' +
      'unconditional job (#1624).',
  },
  {
    files: ['scripts/lint-migration-constraint-scope.mjs'],
    expect: ['code', 'backend'],
    kind: CONTRACT,
    why: 'Refuses an unanchored pg_constraint lookup in packages/backend/src/db/migrations/** (#2702); it lives under scripts/ but only the backend job runs it.',
  },
  {
    files: ['scripts/lint-migration-constraint-scope.test.mjs'],
    expect: ['code', 'backend'],
    kind: CONTRACT,
    why: "The guard's own fixtures — the half that can go red, since the guard reports on an already-clean repo (#2702).",
  },
  {
    files: ['scripts/retired-rail-prose-ratchet.mjs'],
    expect: ['code', 'backend'],
    kind: CONTRACT,
    why: 'The shrink-only retired-rail prose ratchet (#2685) polices all of packages/** but only the backend job runs it.',
  },
  {
    files: ['scripts/retired-rail-prose-ratchet.test.mjs'],
    expect: ['code', 'backend'],
    kind: CONTRACT,
    why: 'The ratchet’s self-test, same reason as dep-lint’s.',
  },
  {
    files: ['scripts/lint-request-schemas.mjs'],
    expect: ['code', 'backend'],
    kind: CONTRACT,
    why: 'The shrink-only request-schema ratchet (#3029) polices packages/backend route modules but only the backend job runs it.',
  },
  {
    files: ['scripts/lint-request-schemas.test.mjs'],
    expect: ['code', 'backend'],
    kind: CONTRACT,
    why: 'The ratchet’s self-test, same reason as dep-lint’s.',
  },
  {
    files: ['scripts/lint-next-steps.mjs'],
    expect: ['code', 'backend', 'mcp_server', 'signer', 'mcp', 'connect', 'qa_agent'],
    kind: CONTRACT,
    why: 'The shrink-only typed next-step ratchet (#3104, epic #3105) polices packages/mcp-server, packages/signer and packages/mcp, so it runs in each of their jobs and in backend_checks beside the request-schema ratchet; connect and qa_agent follow from the package dependency table.',
  },
  {
    files: ['scripts/lint-next-steps.test.mjs'],
    expect: ['code', 'backend', 'mcp_server', 'signer', 'mcp', 'connect', 'qa_agent'],
    kind: CONTRACT,
    why: 'The ratchet’s self-test, same reason as dep-lint’s.',
  },
  {
    files: ['scripts/generate-api-types.mjs'],
    expect: ['code', 'backend'],
    kind: CONTRACT,
    why: 'Generates the API types the backend spec check compares against.',
  },
  {
    files: ['scripts/lib/ratchet.test.mjs'],
    expect: ['code', 'backend', 'frontend'],
    kind: CONTRACT,
    why:
      'The shared engine\'s own self-test (#2759). It routes to BOTH surfaces for the same ' +
      'reason the engine does: a weakening reachable from either one must run it. Measured, ' +
      'not assumed — before its entry in .github/root-guard-ownership.json the classifier ' +
      'reported every flag false for this path, so the file would have run nowhere and been ' +
      'weakenable without running. The manifest entry IS the routing rule; this row records ' +
      'what that produces.',
  },
  {
    files: ['scripts/lib/ratchet.mjs'],
    expect: ['code', 'backend', 'frontend'],
    kind: CONTRACT,
    why:
      'The shared ratchet engine backs NINE gates as of #3131 (eight as of #3104, ' +
      'seven as of #3029, six as of #2747): the ' +
      'backend db-mock gate, the ' +
      'frontend wire-type gate (#1447), the retired-rail prose ratchet, the frontend copy ' +
      'lint, packages/frontend/scripts/design-lint.mjs — which an earlier draft of this row ' +
      'missed, and which had the same missing `--update` refusal the copy lint did — ' +
      'scripts/docs/ui-gate-wording.mjs, the request-schema ratchet ' +
      '(scripts/lint-request-schemas.mjs, #3029), the typed next-step ratchet ' +
      '(scripts/lint-next-steps.mjs, #3104) — which this row missed, leaving it stale a ' +
      'THIRD time until #3131 swept it — and the MCP-CLI vocabulary guard ' +
      '(scripts/ci/vocabulary-divergence.mjs, #3131). All nine share one `updateRefusals`; the count is ' +
      'pinned by scripts/lib/ratchet.test.mjs rather than trusted, because this row has now ' +
      'been stale three times. Weakening the module must run both surfaces; ' +
      'routing it to one would leave the other unguarded. Copy lint and design lint are ' +
      'covered regardless (frontend-copy-lint.yml is unconditional, design lint is a blocking ' +
      'frontend job), so this row understates the blast radius rather than overstating it.',
  },
  {
    files: ['scripts/lint-wire-types.mjs'],
    expect: ['code', 'frontend'],
    kind: CONTRACT,
    why: 'The wire-type ratchet (#1447) polices packages/frontend and only the frontend job runs it.',
  },
  {
    files: ['scripts/lint-wire-types.test.mjs'],
    expect: ['code', 'frontend'],
    kind: CONTRACT,
    why: 'Its self-test. Widening the exemption regex without running the gate is the failure this prevents.',
  },
  {
    files: ['scripts/ci/visual-baseline-inventory.mjs'],
    expect: ['code', 'frontend'],
    kind: CONTRACT,
    why: "The visual gate's honesty instrument (#2318). It reads packages/frontend's committed baselines, and the job that prints it beside the pixel tick is gated on the frontend surface — so a pull request touching only this file has to route to frontend_checks or the guard never runs on the change weakening it.",
  },
  {
    files: ['scripts/ci/visual-baseline-inventory.test.mjs'],
    expect: ['code', 'frontend'],
    kind: CONTRACT,
    why: 'Its self-test. The inventory refuses an empty baseline tree; a test that stops checking that refusal lets the pixel gate pass having compared nothing.',
  },
  {
    files: ['scripts/network-map-pins.test.mjs'],
    expect: ['code', 'backend', 'sdk', 'signer', 'connect', 'mcp', 'mcp_server', 'qa_agent'],
    kind: CONTRACT,
    why: 'The network-map pin test (#1478) spans backend, sdk and signer sources, so it must run every job that would have caught the drift. The sdk flag then fans out, which is why connect/mcp/mcp_server (and qa_agent since #3005) appear without being named by the rule.',
  },

  // ─── Guard data and shared vitest/frontend helpers, one entry each (#3229) ─
  // Five files a gated job reads that routed NOWHERE before #3229 (quality scan
  // 2026-09-22, candidate C4): the two ratchet baselines, the vitest global
  // setup that three gated suites share, the escape-marker helper the frontend
  // gates share, and the env-example mirror the backend suite pins. Each row's
  // `expect` is decided by the same two mechanisms as the rows above: the
  // manifest entry names the jobs that read the file, and the dependency table
  // fans out from there (mcp/connect/qa_agent follow from the four baseline
  // jobs; nothing else has dependents to fan out to).
  {
    files: ['.env.example'],
    expect: ['code', 'backend'],
    kind: CONTRACT,
    why:
      'The configuration mirror that packages/backend/src/docs-drift/env-example-drift.test.ts pins in BOTH directions — every variable the backend reads must be documented here, every documented key must be read. That test runs only in backend_checks, so before #3229 a PR editing only this file routed nowhere and the drift test never ran on the edit it exists to catch.',
  },
  {
    files: ['scripts/lint-request-schemas-baseline.json'],
    expect: ['code', 'backend'],
    kind: CONTRACT,
    why:
      'The committed baseline the request-schema ratchet (#3029) compares against. Lowering a count here without the code change that earns it is exactly the weakening the ratchet refuses, and lint:request-schemas runs only in backend_checks — the ratchet and its self-test were registered but the data they read was not, so a baseline-only edit routed nowhere.',
  },
  {
    files: ['scripts/lint-next-steps-baseline.json'],
    expect: ['code', 'backend', 'mcp_server', 'signer', 'mcp', 'connect', 'qa_agent'],
    kind: CONTRACT,
    why:
      'The committed baseline of the typed next-step ratchet (#3104), read by lint:next-steps in the same four jobs as the ratchet itself — backend_checks beside the request-schema ratchet, then mcp_server/signer/mcp where the policed packages live. Lowering a count weakens the same contract; connect and qa_agent follow from the dependency table, as in the ratchet row above.',
  },
  {
    files: ['scripts/vitest/assert-fresh-dist.mjs'],
    expect: ['code', 'connect', 'mcp_server', 'qa_agent'],
    kind: CONTRACT,
    why:
      'The vitest global-setup hook refusing to run a suite against a stale build of sdk, mcp or signer. Three gated suites import it (connect, mcp-server, qa-agent) and each runs it only in its own job, so a weakening that makes the check vacuous is caught only if every consumer\'s job re-runs — the #3046 shape, with no dependents fan-out reaching any of the three.',
  },
  {
    files: ['scripts/lib/lint-escapes.mjs'],
    expect: ['code', 'frontend'],
    kind: CONTRACT,
    why:
      'The shared escape-marker helper: design-lint and the copy lint both import isEscaped from it. The copy lint runs unconditionally (frontend-copy-lint.yml), but design:lint runs inside the gated frontend_checks job, so before #3229 a PR weakening escape recognition skipped the one gated job that consumes it.',
  },

  // ─── Retained: routes nowhere today, and that is arguable ──────────────────
  {
    files: ['.github/labeler.yml'],
    expect: [],
    kind: RETAINED,
    why: 'Routes NOWHERE. It decides which PRs get the money-path label, and scripts/ci/money-path.test.mjs guards it — but that test lives in the unconditional ci_config_checks job, so nothing is currently lost. Fragile for a reason nobody wrote down, which is why it is pinned.',
  },
  {
    files: ['.github/CODEOWNERS'],
    expect: [],
    kind: RETAINED,
    why: 'Routes nowhere. GitHub enforces it directly, so no job would add coverage — but the .github/workflows/* rule sits right next to it and the asymmetry is worth being deliberate about.',
  },
  {
    files: ['scripts/docs/new-doc.mjs'],
    expect: [],
    kind: RETAINED,
    why: 'Routes nowhere from THIS classifier. The docs workflow is a separate file with its own triggers, so docs tooling is covered elsewhere — not an omission, but only true as long as that stays so.',
  },
  {
    files: ['scripts/ci/change-classifier.mjs'],
    expect: [],
    kind: RETAINED,
    why: 'The classifier does not route itself. Correct today only because ci_config_checks is unconditional and collects scripts/ci/*.test.mjs — the moment that job gains a surface filter, the router stops testing its own changes.',
  },
  {
    files: ['scripts/ci/baseline-verdict-gate.mjs'],
    expect: [],
    kind: RETAINED,
    why: 'The baseline change gate (#3232) does not route itself, for the same two reasons as the classifier above: its self-test is collected by the unconditional ci_config_checks glob, and the gate itself runs from the DEFAULT branch inside its own pull_request_target workflow (baseline-verdict-gate.yml) — the PR copy is never executed, so routing it anywhere would run code a gated PR could have edited. The workflow file beside it routes ALL under the generic .github/workflows arm.',
  },
  {
    files: ['scripts/ci/baseline-verdict-gate.test.mjs'],
    expect: [],
    kind: RETAINED,
    why: 'The gate’s self-test, same reason as its script above: it is reachable only through the unconditional scripts/ci/*.test.mjs glob in ci_config_checks. If that job ever gains a surface filter, this row is the one that turns wrong.',
  },
  {
    files: ['.github/root-guard-ownership.json'],
    expect: [],
    kind: RETAINED,
    why: 'Editing the guard-ownership manifest changes routing for ten files, yet routes nowhere itself — `.github/*` is only matched under workflows/. Covered today because ci_config_checks is unconditional and runs root-guard-ownership.test.mjs, exactly as for the classifier above; the same caveat applies (#1624).',
  },
  {
    files: ['Dockerfile'],
    expect: [],
    kind: RETAINED,
    why: 'Routes nowhere. No job builds the image on a PR, so there is nothing to trigger — this becomes wrong the day one does.',
  },
  {
    files: ['.gitignore'],
    expect: [],
    kind: RETAINED,
    why: 'Routes nowhere, and unlike the rows above there is no argument that it should — it is here because an unrecognised top-level path defaulting to "no jobs" is itself the behaviour worth pinning.',
  },
  {
    files: ['.nvmrc'],
    expect: [],
    kind: RETAINED,
    why: 'Routes nowhere, yet every job reads it via node-version-file. Changing the Node version therefore validates against NO package suite. The most arguable row in this table.',
  },

  // ─── Degenerate inputs ─────────────────────────────────────────────────────
  {
    files: [],
    expect: [],
    kind: CONTRACT,
    why: 'An empty diff routes nothing — and must still emit all thirteen flags rather than an empty object.',
  },
  {
    files: ['', '   ', 'packages/cli/src/index.ts'],
    expect: ['code', 'cli'],
    kind: CONTRACT,
    why: 'git output ends with a newline, so a trailing empty element is always present; blank entries must not be classified.',
  },
]
