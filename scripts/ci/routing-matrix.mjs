// The package-to-job routing matrix (#1623, epic #1621).
//
// One row per routing decision the CI change classifier makes, with the FULL
// expected output — all ten flags, not just the one that turns true. This is a
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
const ALL = ['code', 'frontend', 'backend', 'sdk', 'connect', 'mcp', 'mcp_server', 'signer', 'cli', 'full']

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
    files: ['docs/product/agent-passport.md'],
    expect: [],
    kind: CONTRACT,
    why: 'Same, for the docs/ tree. The docs-quality gates cover these on their own workflow.',
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
    why: 'The ONE Markdown exception. CLAUDE.md mirrors the API surface table and chain registry that packages/backend/src/docs-drift pins, so a CLAUDE.md-only edit must run the backend suite or the drift test never guards it.',
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

  // ─── Dependency propagation ────────────────────────────────────────────────
  {
    files: ['packages/sdk/src/client.ts'],
    expect: ['code', 'sdk', 'backend', 'connect', 'mcp', 'mcp_server', 'signer'],
    kind: CONTRACT,
    why: 'Every published package builds on the SDK and the backend is pinned against its wire types, so an SDK edit must run all of them. The widest fan-out in the graph; frontend stays out because it consumes @haven_ai/core, not the SDK.',
  },
  {
    files: ['packages/mcp/src/index.ts'],
    expect: ['code', 'mcp', 'connect', 'mcp_server'],
    kind: CONTRACT,
    why: 'connect bundles the MCP runtime it hands out, so it must rebuild when mcp changes. mcp_server joined in #2348 on the same reasoning as the signer row below: its strict-tool-input test imports @haven_ai/mcp toolSchemas to pin the local-vs-hosted argument spellings against the real local surface rather than restating them as literals, and mcp_server_checks runs that test -- so a rename in the local schemas must run it, which is exactly what the pin is for.',
  },
  {
    files: ['packages/signer/src/index.ts'],
    expect: ['code', 'signer', 'connect', 'mcp_server'],
    kind: CONTRACT,
    why: 'connect bundles the signer, and mcp_server consumes it too — its hosted-signer-integration test imports @haven_ai/signer, and mcp_server_checks runs that test. mcp_server was MISSING here until #1625 derived fan-out from the real dependency graph; a signer change could break that test with its job never running.',
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
  // Seven guards, ten files, grouped into four SURFACE_RULES entries — the three
  // counts differ, so it is worth being explicit. The guards are: the
  // dependency-cruiser rule set, dep-lint, the db-mock ratchet, the API-type
  // generator, the shared ratchet engine, the wire-type ratchet, and the
  // network-map pin test. Four of them ship a self-test as a separate file,
  // which is where ten files come from; rules that share a target package are
  // collapsed into one entry, which is where four comes from.
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
    files: ['scripts/generate-api-types.mjs'],
    expect: ['code', 'backend'],
    kind: CONTRACT,
    why: 'Generates the API types the backend spec check compares against.',
  },
  {
    files: ['scripts/lib/ratchet.mjs'],
    expect: ['code', 'backend', 'frontend'],
    kind: CONTRACT,
    why: 'The shared ratchet engine backs BOTH the backend db-mock gate and the frontend wire-type gate (#1447). Weakening it must run both — routing it to one would leave the other unguarded.',
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
    files: ['scripts/network-map-pins.test.mjs'],
    expect: ['code', 'backend', 'sdk', 'signer', 'connect', 'mcp', 'mcp_server'],
    kind: CONTRACT,
    why: 'The network-map pin test (#1478) spans backend, sdk and signer sources, so it must run every job that would have caught the drift. The sdk flag then fans out, which is why connect/mcp/mcp_server appear without being named by the rule.',
  },

  // ─── Retained: routes nowhere today, and that is arguable ──────────────────
  {
    files: ['packages/core/src/chains.ts'],
    expect: ALL,
    kind: RETAINED,
    why: 'packages/core is the shared kernel backend and frontend both consume, but it has no job of its own, so it falls to the packages/* catch-all and runs EVERYTHING. Safe but blunt — a core edit runs cli and signer suites that cannot see it. A dedicated core arm is #1626’s call.',
  },
  {
    files: ['packages/qa-agent/src/run.ts'],
    expect: ALL,
    kind: RETAINED,
    why: 'Same catch-all. qa-agent is a private workspace whose code no product job builds, so the full matrix is pure cost here — the opposite trade-off from core.',
  },
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
    why: 'An empty diff routes nothing — and must still emit all ten flags rather than an empty object.',
  },
  {
    files: ['', '   ', 'packages/cli/src/index.ts'],
    expect: ['code', 'cli'],
    kind: CONTRACT,
    why: 'git output ends with a newline, so a trailing empty element is always present; blank entries must not be classified.',
  },
]
