#!/usr/bin/env node
// The `packages/**/*.md` boundary, made explicit (#2088).
//
// ## The gap this closes
//
// `validate-frontmatter.mjs` and `coupling-gate.mjs` enumerate `docs/**` plus
// the four root gravity files — 89 files. Every other Markdown file in the repo
// was outside the docs-quality system ENTIRELY: no `owner`, no `covers`, no
// `last-verified`, never implicated by the coupling gate, skipped by the
// staleness audit, and pointed at by no gate. That is the same shape as the
// `covers: []` blind spot #1993 closed — a system reporting success about the
// part it can see — except one bucket further out, and it has already bitten:
// `packages/qa-agent/README.md` described three legacy-rail QA legs as live
// long after #1986 made all three impossible, and a human found it (#1992).
//
// ## Why this is a manifest and not front-matter in the files
//
// Five of these files are the npm landing pages for `@haven_ai/sdk`, `signer`,
// `mcp`, `connect` and `cli`. A `---` YAML block at the top of a published
// README renders — as a metadata table on GitHub, and as loose text under a
// horizontal rule wherever the renderer has no front-matter plugin. Defacing a
// user-facing artifact to satisfy an internal hygiene gate is the wrong trade,
// so the governance metadata lives here instead: one reviewable place, which is
// what #2088 proposed. The schema is deliberately the SAME four keys as
// front-matter, so a reader who knows one knows the other.
//
// ## The two sets, and why both must be explicit
//
// Every `packages/**/*.md` must appear in exactly one of `GOVERNED_PACKAGE_DOCS`
// or `EXEMPT_PACKAGE_DOCS`. A file in neither is a HARD ERROR naming the file —
// that is the whole point. Making the enforced set bigger was never the fix;
// making the BOUNDARY visible is, so that a new package README cannot land
// silently outside both sets the way these thirteen did.
//
// Scope, stated so a green run is not over-read: this covers `packages/**` only.
// See `boundaryScopeNotes()` for what is deliberately left out and why.

import { globToRegExp } from './validate-frontmatter.mjs'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const STATUSES = new Set(['current', 'research', 'archived'])

/**
 * Package Markdown brought INTO the docs-quality system.
 *
 * The line drawn: a **package-root README** is a contract. For the five
 * published packages it is literally the npm landing page — the artifact a user
 * reads before installing — and for the three private ones it describes a
 * deployed service, a demo merchant, or the QA harness whose claims about the
 * live rails already went stale once. All eight describe code whose behaviour
 * can drift out from under the prose, so all eight get real `covers:` and become
 * implicable by the coupling gate.
 *
 * ⚠️ `last-verified` here is SEEDED from each file's last commit date, not from
 * a verification pass performed in #2088. Registering a doc is not verifying it,
 * and a rubber-stamped date is worse than a stale one because the weekly
 * staleness audit ranks on it. The first PR the coupling gate implicates is the
 * one that re-reads the body and bumps the date.
 */
export const GOVERNED_PACKAGE_DOCS = [
  {
    doc: 'packages/sdk/README.md',
    owner: '@d-hinders',
    status: 'current',
    covers: ['packages/sdk/src/**'],
    'last-verified': '2026-08-28',
  },
  {
    doc: 'packages/signer/README.md',
    owner: '@d-hinders',
    status: 'current',
    covers: ['packages/signer/src/**'],
    // #2243: first real verification pass since #2088 seeded this date. Every
    // claim in the body re-read against `packages/signer/src/**` and rewritten
    // where it had drifted: the tool table (two tools -> the four in
    // `SignerToolName`), `haven_x402_authorize` (a deprecated alias for
    // `haven_pay_x402_quote`, `mcp-server/src/tools.ts:81`), the
    // `{ payment_id }`-only preferred call (#1263/#1355), the retired
    // `funds Safe -> delegate EOA` leg (#1440/#1986), the entirely absent
    // erc7710 scheme and its local caveat verification (#1455/#1476/#2041),
    // the payer-delegate guard (#1690), the version-compatibility handshake
    // (#1155 — referenced, deliberately NOT restated as numbers, since the
    // constants in `core.ts` are the single source), the Node >= 22 floor and
    // the `npx @haven_ai/connect@alpha` install path. A FALSE SECURITY CLAIM
    // was corrected here and filed as #2242: "the signer makes no network
    // calls", untrue since #1263's authenticated read-only sign-context fetch;
    // #2242 stays open for the same claim's copy in `credentials.ts` JSDoc.
    // NOT re-verified in this pass, and deliberately carried forward
    // unchanged: the "Connect Agent 2 may create the signer credential file
    // locally during setup" paragraph under Custody — it describes
    // `packages/connect`, which is outside this doc's `covers:` and was not
    // read.
    'last-verified': '2026-08-30',
  },
  {
    doc: 'packages/mcp/README.md',
    owner: '@d-hinders',
    status: 'current',
    covers: ['packages/mcp/src/**'],
    'last-verified': '2026-08-28',
  },
  {
    doc: 'packages/connect/README.md',
    owner: '@d-hinders',
    status: 'current',
    covers: ['packages/connect/src/**'],
    'last-verified': '2026-08-28',
  },
  {
    doc: 'packages/cli/README.md',
    owner: '@d-hinders',
    status: 'current',
    covers: ['packages/cli/src/**'],
    'last-verified': '2026-06-26',
  },
  {
    doc: 'packages/mcp-server/README.md',
    owner: '@d-hinders',
    status: 'current',
    covers: ['packages/mcp-server/src/**'],
    'last-verified': '2026-08-27',
  },
  {
    // The #1992 file. Its prose is mostly about BACKEND behaviour — which
    // payment routes refuse what, on which rail — so pinning it to its own
    // `src/**` alone would have missed the exact drift that motivated #2088.
    doc: 'packages/qa-agent/README.md',
    owner: '@d-hinders',
    status: 'current',
    covers: [
      'packages/qa-agent/src/**',
      'packages/backend/src/routes/payments.ts',
      'packages/backend/src/rails/execution-rail.ts',
    ],
    'last-verified': '2026-08-27',
  },
  {
    doc: 'packages/demo-merchant-mcp/README.md',
    owner: '@d-hinders',
    status: 'current',
    covers: ['packages/demo-merchant-mcp/src/**'],
    'last-verified': '2026-08-11',
  },
]

/**
 * Package Markdown deliberately OUTSIDE the system, each with a stated reason.
 *
 * The shared shape: a note to the next maintainer of one directory, describing
 * why the files beside it are the way they are. There is no code mirror worth
 * coupling — the code IS the neighbouring directory, and a `covers:` glob
 * pointing at it would fire on every edit and be dismissed every time, which is
 * how a gate teaches people to ignore it. Being explicitly outside is the
 * outcome #1993 chose for `covers: []`, and it is the right one here too.
 */
export const EXEMPT_PACKAGE_DOCS = {
  'packages/backend/src/infra/repositories/README.md':
    'Maintainer note for one directory. Its rule is ENFORCED by `pg-only-in-infra` in ' +
    '`.dependency-cruiser.cjs` and its prose lives in `docs/architecture/10-module-boundaries.md`, ' +
    'which is already governed — a `covers:` here would duplicate that doc\'s coupling.',
  'packages/connect/tests/install-smoke/README.md':
    'Explains why one CI job exists. It names its own test file and workflow inline; the ' +
    'thing that catches its drift is the job going red, not a doc gate.',
  'packages/frontend/src/lib/loop-harness/README.md':
    'Rationale note for a differential-testing harness. The harness IS its own proof — if the ' +
    'invariant it describes stops holding, the harness fails, not the prose.',
  'packages/qa-agent/src/pilot/README.md':
    'Index of hand-run testnet proof scripts, each of which documents itself in its own header. ' +
    'Governed one level up: `packages/qa-agent/README.md` carries the QA harness contract.',
  'packages/sdk/src/__fixtures__/README.md':
    'Provenance record for one generated test fixture — a regeneration recipe, not a description ' +
    'of behaviour. It is correct or it is not; there is no state it can drift out of sync with.',
}

/**
 * What this boundary deliberately does NOT reach, and why.
 *
 * Enumerated in code rather than only in prose so a green run cannot be
 * over-read as "all repo Markdown is now governed". It is not; 322 Markdown
 * files exist and this reaches the 13 under `packages/**`.
 */
export function boundaryScopeNotes() {
  return [
    '`.agents/**` and `.claude/**` (32 files) — already enumerated by a different gate, ' +
      '`validate-agent-skills.mjs`, which checks the structure these files actually have ' +
      '(skills, roles, command→skill targets). Front-matter would be a second, weaker system.',
    '`.github/**` and `scripts/README.md` (4 files) — process notes for the files beside them, ' +
      'the same class as the exempt entries here. Left out to keep this change one population wide; ' +
      'the mechanism generalizes if that is ever wanted.',
    'Behaviour. Registering a doc makes it IMPLICABLE by the coupling gate — it does not read ' +
      'the prose. Nothing here would have caught #1992 on its own; it would have put the file in ' +
      'front of a reviewer, which is the whole claim.',
    '`contract: true`. No package doc is promoted to a BLOCKING contract doc, deliberately: ' +
      'that would fail every PR touching `packages/sdk/src/**` until someone edited the README.',
  ]
}

/** Every `packages/**` Markdown path in a walked file list, sorted. */
export function enumeratePackageDocs(allFiles) {
  // De-duplicated: a caller may hand in a list built from several sources, and
  // reporting the same file twice turns one decision into two error lines.
  return [
    ...new Set(allFiles.filter((p) => p.startsWith('packages/') && p.endsWith('.md'))),
  ].sort()
}

/**
 * Validate the boundary against the real tree. Returns an array of error
 * strings; empty means the boundary holds.
 *
 * Five failure modes, and the fifth is the one that makes the other four
 * trustworthy:
 *   1. a `packages/**` doc in NEITHER set — the gap #2088 is about;
 *   2. a path in BOTH sets — an ambiguous decision is not a decision;
 *   3. a manifest entry naming a file that does not exist — a manifest that
 *      keeps stale rows is how an inventory rots into decoration;
 *   4. a governed entry or exempt reason that is malformed/empty;
 *   5. an EMPTY enumeration — a boundary check with nothing to check passes
 *      everything, which is precisely the defect this file exists to close.
 */
export function checkPackageDocBoundary(allFiles) {
  const errors = []
  const present = new Set(allFiles)
  const found = enumeratePackageDocs(allFiles)

  // (5) Positive control, first: a scan that sees nothing must not report a
  // perfect pass. If a future refactor points the walker at the wrong root, or
  // an ignore rule swallows `packages/`, this is the line that says so.
  if (found.length === 0) {
    errors.push(
      'package-docs boundary: enumerated ZERO `packages/**/*.md` files. The repo has at least ' +
        'one (every published package ships a README), so the scan is broken, not the tree — ' +
        'a boundary check that sees nothing passes everything (#2088).',
    )
    return errors
  }

  const governedByPath = new Map(GOVERNED_PACKAGE_DOCS.map((e) => [e.doc, e]))
  if (governedByPath.size !== GOVERNED_PACKAGE_DOCS.length) {
    errors.push('package-docs boundary: GOVERNED_PACKAGE_DOCS contains a duplicate `doc` path.')
  }

  // (3) No stale rows in either set.
  for (const entry of GOVERNED_PACKAGE_DOCS) {
    if (!present.has(entry.doc)) {
      errors.push(
        `package-docs boundary: GOVERNED_PACKAGE_DOCS names "${entry.doc}", which does not exist. ` +
          'Remove the row or fix the path.',
      )
    }
  }
  for (const path of Object.keys(EXEMPT_PACKAGE_DOCS)) {
    if (!present.has(path)) {
      errors.push(
        `package-docs boundary: EXEMPT_PACKAGE_DOCS names "${path}", which does not exist. ` +
          'Remove the row or fix the path.',
      )
    }
  }

  // (4) Governed rows carry the same four keys front-matter demands, and their
  // globs must resolve — a `covers:` pointing at nothing is not coupling.
  for (const entry of GOVERNED_PACKAGE_DOCS) {
    const label = `package-docs boundary: ${entry.doc}`
    if (!entry.owner) errors.push(`${label}: missing \`owner\`.`)
    if (!STATUSES.has(entry.status)) {
      errors.push(`${label}: invalid status "${entry.status}" (expected ${[...STATUSES].join(' | ')}).`)
    }
    if (!DATE_RE.test(String(entry['last-verified']))) {
      errors.push(`${label}: \`last-verified\` must be YYYY-MM-DD, got "${entry['last-verified']}".`)
    }
    if (!Array.isArray(entry.covers) || entry.covers.length === 0) {
      // Governed means coupled. A package doc with nothing to couple to belongs
      // in EXEMPT_PACKAGE_DOCS with a reason, not in here with an empty list —
      // that is the `covers: []` shape #1993 closed, and it must not grow back
      // through a side door.
      errors.push(
        `${label}: governed entries need a non-empty \`covers\`. A package doc with no code ` +
          'mirror belongs in EXEMPT_PACKAGE_DOCS with a stated reason (#1993, #2088).',
      )
      continue
    }
    for (const glob of entry.covers) {
      const re = globToRegExp(glob)
      if (!allFiles.some((f) => re.test(f))) {
        errors.push(`${label}: \`covers\` glob "${glob}" resolves to no files.`)
      }
    }
  }

  // (4b) Exempt rows must state a real reason — the #1993 rule, one bucket out.
  for (const [path, reason] of Object.entries(EXEMPT_PACKAGE_DOCS)) {
    if (typeof reason !== 'string' || reason.trim().length === 0) {
      errors.push(
        `package-docs boundary: EXEMPT_PACKAGE_DOCS["${path}"] needs a written reason. ` +
          'An unexplained exemption is indistinguishable from a file nobody decided about.',
      )
    }
  }

  // (1) and (2): every file lands in exactly one set.
  for (const path of found) {
    const isGoverned = governedByPath.has(path)
    const isExempt = Object.prototype.hasOwnProperty.call(EXEMPT_PACKAGE_DOCS, path)
    if (isGoverned && isExempt) {
      errors.push(
        `package-docs boundary: "${path}" is in BOTH GOVERNED_PACKAGE_DOCS and ` +
          'EXEMPT_PACKAGE_DOCS. Pick one.',
      )
    } else if (!isGoverned && !isExempt) {
      errors.push(
        `package-docs boundary: "${path}" is registered in neither GOVERNED_PACKAGE_DOCS nor ` +
          'EXEMPT_PACKAGE_DOCS in `scripts/docs/package-docs.mjs`. Every `packages/**/*.md` must ' +
          'declare which side of the docs-quality boundary it is on: give it `owner`/`status`/' +
          '`covers`/`last-verified` to bring it in, or add it to the exempt map with a reason ' +
          'for leaving it out (#2088).',
      )
    }
  }

  return errors
}

/** Governed package docs as coupling-gate doc records. */
export function packageDocRecords() {
  return GOVERNED_PACKAGE_DOCS.map((e) => ({
    doc: e.doc,
    covers: e.covers,
    lastVerified: e['last-verified'],
    // Never blocking — see boundaryScopeNotes().
    contract: false,
    satisfiedBy: [],
    owner: e.owner,
    status: e.status,
  }))
}
