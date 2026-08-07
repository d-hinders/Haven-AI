// Dependency-boundary rules for packages/backend (#982, epic #980).
//
// These rules are the machine-checkable form of the seven rules in
// docs/architecture/10-module-boundaries.md. That doc is the prose; THIS FILE
// IS AUTHORITATIVE — if the two disagree, the doc is the bug.
//
// Only the subset checkable against TODAY's tree is enabled. The structural
// rules (domain purity, module entry points, http/ thinness) arrive with the
// directories they police, as epic #980 creates them. Each rule below names
// the sub-issue that will drive its baseline to zero.
//
// Existing debt is ratcheted in packages/backend/dep-lint-baseline.json and may
// only SHRINK — see scripts/dep-lint.mjs and the shared engine in
// scripts/lib/ratchet.mjs.
//
//   npm run lint:deps           # check against the baseline
//   npm run lint:deps:update    # rewrite the baseline (shrink, or a reviewed add)

// Chain SDKs, confined to infra/ and rails/ behind the ChainClient port
// (#994) — `rails/` landed in #998, joining `infra/` as the two directories
// allowed to import a chain SDK directly (rule 4). `chain-sdk-not-in-routes`
// below only polices `routes/**` today; widening it to assert the positive
// (infra/rails ARE the only importers, everywhere) is follow-up work, not
// this issue's scope.
// NOTE: dependency-cruiser reports npm dependencies by their RESOLVED path, so
// this must match `node_modules/<pkg>` — a bare `^ethers` matches nothing and
// silently passes. That false negative is covered by a unit test.
const CHAIN_SDKS = 'node_modules/(ethers|viem|permissionless|@metamask/smart-accounts-kit)/'

module.exports = {
  forbidden: [
    {
      // Rule 7 — the one to defend hardest. A cycle makes a module impossible
      // to test in isolation, split, or delete from.
      name: 'no-circular',
      severity: 'error',
      comment:
        'This dependency is part of a cycle. Cycles are defects regardless of intent — ' +
        'break it by moving the shared piece down into domain/ or platform/.',
      from: {},
      to: { circular: true },
    },
    {
      // Rule 3 — tenant isolation. Much of Haven's authorization lives in the
      // `WHERE user_id = $1` clause; it belongs behind repositories where the
      // scoping argument is required and explicit. Driven to zero by #985/#988/#995.
      name: 'pg-only-in-infra',
      severity: 'error',
      comment:
        'Only infra/repositories/ may reach the database. Move the query into a repository ' +
        'that takes its tenant-scoping argument as a required parameter (see #985).',
      from: {
        path: '^packages/backend/src/',
        pathNot: '^packages/backend/src/(db/|infra/repositories/|db\\.ts$)',
      },
      to: {
        path: '^(packages/backend/src/db\\.ts$|node_modules/pg/)',
      },
    },
    {
      // Rule 4 — not tidiness. ethers and viem format payment amounts
      // differently at the edges; confining them makes substitution testable
      // in one place. Driven to zero by #994 — zero-tolerance: this rule
      // carries NO baseline entries for routes/** and must never gain one
      // (the same convention as `no-circular`/`core-stays-pure`).
      name: 'chain-sdk-not-in-routes',
      severity: 'error',
      comment:
        'Route handlers must not import a chain SDK. Go through the ChainClient port ' +
        '(domain/chain-client.ts + infra/chain/, #994); pure helpers like ' +
        'formatTokenAmount/isAddress belong in @haven_ai/core.',
      from: { path: '^packages/backend/src/routes/' },
      to: { path: CHAIN_SDKS },
    },
    {
      // Rule 1 (the pure end of the stable-dependency rule), applied to the
      // shared kernel. @haven_ai/core is imported by a Node server AND a
      // browser bundle, so a framework or chain-SDK dependency here would be
      // wrong in both directions at once.
      //
      // This rule starts at ZERO violations and must NEVER gain a baseline
      // entry. If it fires, the new code belongs in the consumer, not in core.
      name: 'core-stays-pure',
      severity: 'error',
      comment:
        '@haven_ai/core must stay pure — no fastify, pg, ethers, viem, permissionless or ' +
        'smart-accounts-kit. It is shared by the server and the browser bundle. Put the ' +
        'impure part in the consumer.',
      from: { path: '^packages/core/src/' },
      to: {
        path: 'node_modules/(fastify|pg|ethers|viem|permissionless|@metamask/smart-accounts-kit)/',
      },
    },
    {
      // Rule 1, applied to the backend's OWN domain/ (arrives with the
      // directory, #998). domain/ is money/address types, the chain registry,
      // policy predicates, the rail decision, and payment-state taxonomy —
      // none of which need a framework, a database, or a chain SDK. Every
      // file placed in domain/ by #998 was verified pure before landing here
      // (one candidate — `execution-rail.ts`, "the rail decision" per the
      // architecture doc's table — was kept OUT of domain/ specifically
      // because it queries `db.ts` directly; see the #998 PR body). This rule
      // therefore starts at ZERO and, like `core-stays-pure`, must never gain
      // a baseline entry — a violation here means new code was placed in
      // domain/ that does not belong there, not that domain/ needs grandfathering.
      name: 'domain-stays-pure',
      severity: 'error',
      comment:
        'packages/backend/src/domain/ must stay pure — no fastify, pg, ethers, viem, ' +
        'permissionless, smart-accounts-kit, and no path under modules/, infra/, http/ or ' +
        'rails/. It is the stable base every layer depends on; dependencies point INTO domain/, ' +
        'never out of it.',
      from: { path: '^packages/backend/src/domain/' },
      to: {
        path:
          'node_modules/(fastify|pg|ethers|viem|permissionless|@metamask/smart-accounts-kit)/|' +
          '^packages/backend/src/(modules|infra|http|rails)/',
      },
    },
    {
      // Rule 6. `modules/transactions/` (#992), `modules/x402/` (#996) and
      // `modules/mpp/` (#997) already had a public index.ts; #998 gave every
      // remaining modules/** directory one too (accounts/, agents/, payments/,
      // catalog/, accounting/, reporting/, fee/, passport/) and fixed every
      // external call site to import through it. The rule now covers ALL of
      // modules/** at its intended end state — zero violations, and the
      // baseline must never gain an entry for any of them. `platform/`,
      // `domain/`, `infra/` and `rails/` are LAYERS, not domain-capability
      // modules (see the architecture doc's "what belongs where" table), and
      // deliberately do not get barrels — they hold multiple files each with
      // many independent direct importers, so a barrel there would be
      // ceremony, not a boundary.
      name: 'no-deep-cross-module-import',
      severity: 'error',
      comment:
        "Import a module through its public index.ts, not a private file. " +
        'If the module has no index.ts yet, adding one is part of its #980 sub-issue.',
      from: {
        path: '^packages/backend/src/',
        pathNot: '^packages/backend/src/modules/[^/]+/',
      },
      to: {
        path: '^packages/backend/src/modules/[^/]+/',
        pathNot: '^packages/backend/src/modules/[^/]+/index\\.ts$',
      },
    },
  ],

  options: {
    doNotFollow: { path: 'node_modules' },
    // Tests legitimately reach past production boundaries (integration tests
    // touch the pool directly, route tests stub chain SDKs). The rules describe
    // PRODUCTION structure, so scanning tests would fill the baseline with
    // entries nobody should ever "fix".
    exclude: {
      path: '(/__tests__/|\\.test\\.ts$|\\.parity\\.test\\.ts$|/loop-harness/|/docs-drift/)',
    },
    // NOTE: deliberately no `tsConfig`. packages/backend/tsconfig.json extends
    // ../../tsconfig.base.json, and dependency-cruiser resolves that `extends`
    // against the wrong base dir (TS5083). Neither tsconfig declares `paths`,
    // so the only thing tsConfig would buy us is alias resolution we don't use.
    // Re-add it — with a verified extends resolution — if aliases are ever
    // introduced.
    tsPreCompilationDeps: true,
  },
}
