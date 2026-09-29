- **Release tooling: the bump rewrites `SIGNER_VERSION` where it is now declared
  (2026-09-29). Tooling only: no funds move, no signing path changes, no
  authority, custody or perimeter change.** #3454 moved the signer's
  self-reported `SIGNER_VERSION` from `packages/signer/src/server.ts` into
  `tools.ts`, which `server.ts` re-exports. `scripts/release-bump.mjs` still
  looked in `server.ts`. The 0.7.0-alpha.0 cut died after rewriting the
  `package.json` files, and nothing was published or committed.
  - **Change.** The bump's constant table moves into
    `scripts/release-version-constants.mjs` and names `tools.ts` for
    `SIGNER_VERSION`. The rewrite regex is the same one, now shared. The bump
    writes the same six constants as before.
  - **Guard.** `scripts/release-version-constants.test.mjs`, run in CI beside
    `release-bump.test.mjs`, asserts that each named file declares its
    constant exactly once, and that a re-export does not count. Pointing
    `SIGNER_VERSION` back at `server.ts` turns it red (5 pass, 1 fail).
  - **Stale path references updated:** `scripts/README.md`'s release
    `git add` list and `docs/operations/agent-qa.md`. The qa-freshness
    exemption is keyed on the constant's name, not its file, so it is
    unaffected.
  - **Perimeter.** No route, credential scope, key handling or spend path is
    added or widened. Custody unchanged. Perimeter unchanged.
