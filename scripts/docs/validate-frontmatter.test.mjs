// Unit tests for the front-matter parser and glob matcher.
// Run with: node --test scripts/docs/  (or `npm run docs:test`).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseFrontMatter, globToRegExp } from './validate-frontmatter.mjs'

test('parses a complete block-list header', () => {
  const r = parseFrontMatter(
    '---\nowner: "@x"\nstatus: current\ncovers:\n  - packages/a.ts\n  - packages/b.ts\nlast-verified: "2026-06-28"\n---\n\n# Title\n',
  )
  assert.equal(r.ok, true)
  assert.equal(r.data.owner, '@x')
  assert.equal(r.data.status, 'current')
  assert.deepEqual(r.data.covers, ['packages/a.ts', 'packages/b.ts'])
  assert.equal(r.data['last-verified'], '2026-06-28')
})

test('strips trailing # comments on block-list items (regression: SF-1)', () => {
  const r = parseFrontMatter(
    '---\nowner: "@x"\nstatus: current\ncovers:\n  - packages/a.ts  # the a route\nlast-verified: "2026-06-28"\n---\n',
  )
  assert.equal(r.ok, true)
  assert.deepEqual(r.data.covers, ['packages/a.ts'])
})

test('treats covers: [] as an empty (narrative) list, comment ignored', () => {
  const r = parseFrontMatter(
    '---\nowner: "@x"\nstatus: archived\ncovers: []  # narrative\nlast-verified: "2026-06-28"\n---\n',
  )
  assert.equal(r.ok, true)
  assert.deepEqual(r.data.covers, [])
})

test('parses inline list form', () => {
  const r = parseFrontMatter('---\ncovers: [a.ts, "b.ts"]\n---\n')
  assert.equal(r.ok, true)
  assert.deepEqual(r.data.covers, ['a.ts', 'b.ts'])
})

test('handles CRLF line endings', () => {
  const r = parseFrontMatter('---\r\nowner: "@x"\r\nstatus: current\r\ncovers: []\r\nlast-verified: "2026-06-28"\r\n---\r\n')
  assert.equal(r.ok, true)
  assert.equal(r.data.owner, '@x')
  assert.deepEqual(r.data.covers, [])
})

test('rejects a file with no front-matter', () => {
  const r = parseFrontMatter('# Just a heading\n')
  assert.equal(r.ok, false)
  assert.match(r.error, /missing front-matter/)
})

test('rejects an unterminated front-matter block', () => {
  const r = parseFrontMatter('---\nowner: "@x"\n')
  assert.equal(r.ok, false)
  assert.match(r.error, /unterminated/)
})

test('globToRegExp: ** matches across directories, * does not', () => {
  assert.match('packages/backend/src/openapi/spec.ts', globToRegExp('packages/backend/src/openapi/**'))
  assert.match('packages/x/y.ts', globToRegExp('packages/**'))
  assert.doesNotMatch('packages/a/b.ts', globToRegExp('packages/*.ts'))
  assert.match('packages/a.ts', globToRegExp('packages/*.ts'))
})

test('globToRegExp: an exact file path matches only itself', () => {
  const re = globToRegExp('packages/backend/src/lib/chains.ts')
  assert.match('packages/backend/src/lib/chains.ts', re)
  assert.doesNotMatch('packages/backend/src/lib/chains.test.ts', re)
})

// ── #1366: satisfied-by is its OWN key — it must never clobber covers ─────────

import { test as test1366fm } from 'node:test'
import assert1366fm from 'node:assert'
import { parseFrontMatter as pfm1366 } from './validate-frontmatter.mjs'

test1366fm('satisfied-by parses as a separate list and covers survives (#1366)', () => {
  const raw = [
    '---',
    'owner: "@x"',
    'status: current',
    'covers:',
    '  - packages/signer/**',
    'satisfied-by:',
    '  - docs/regulatory/casp-changelog/**',
    'last-verified: "2026-08-12"',
    '---',
    '',
  ].join('\n')
  const parsed = pfm1366(raw)
  assert1366fm.strictEqual(parsed.ok, true)
  // The clobber bug this guards: both list keys writing to data.covers would
  // leave covers = the satisfied-by items — silently un-covering the code.
  assert1366fm.deepStrictEqual(parsed.data.covers, ['packages/signer/**'])
  assert1366fm.deepStrictEqual(parsed.data['satisfied-by'], ['docs/regulatory/casp-changelog/**'])
})

// ── `covers: []` must state a reason (#1993) ─────────────────────────────────
//
// Positive AND negative control for the rule, because the rule's own value is
// that it can distinguish "deliberately uncoupled, here is why" from "nobody
// decided". A detector that only ever answers "fine" would make that
// distinction unmeasurable — which is the failure the rule exists to catch,
// one layer up.
import { emptyCoversNote } from './validate-frontmatter.mjs'

test('emptyCoversNote: reads the inline reason on a literal `covers: []`', () => {
  const raw = '---\nowner: "@x"\nstatus: current\ncovers: []  # narrative — no direct code mirror\nlast-verified: "2026-08-26"\n---\n'
  assert.equal(emptyCoversNote(raw), 'narrative — no direct code mirror')
})

test('emptyCoversNote: an UNEXPLAINED `covers: []` returns null — the finding', () => {
  const raw = '---\nowner: "@x"\nstatus: current\ncovers: []\nlast-verified: "2026-08-26"\n---\n'
  assert.equal(emptyCoversNote(raw), null)
})

test('emptyCoversNote: a bare `#` with no text is not a reason', () => {
  const raw = '---\ncovers: []  #\n---\n'
  assert.equal(emptyCoversNote(raw), null)
})

test('emptyCoversNote: a NON-empty covers list is out of scope (returns null)', () => {
  const raw = '---\ncovers:\n  - packages/backend/src/index.ts  # not a reason\n---\n'
  assert.equal(emptyCoversNote(raw), null)
})

test('emptyCoversNote: CRLF front-matter is read the same way', () => {
  const raw = '---\r\ncovers: []  # process playbook\r\n---\r\n'
  assert.equal(emptyCoversNote(raw), 'process playbook')
})

test('emptyCoversNote: the non-canonical empty spellings fail CLOSED, not open', () => {
  // Both parse to an empty `covers` list, so the caller blocks; neither can be
  // rescued by a reason written on them. Pinned so the fail-closed direction is
  // a decision on record rather than an accident (#1993, from review).
  assert.equal(emptyCoversNote('---\ncovers: [ ]  # spaced inline\n---\n'), null)
  assert.equal(emptyCoversNote('---\ncovers:  # block header, no items\n---\n'), null)
})

test('emptyCoversNote: a `#` inside the reason text survives', () => {
  const raw = '---\ncovers: []  # narrative — see #1993 for why\n---\n'
  assert.equal(emptyCoversNote(raw), 'narrative — see #1993 for why')
})
// --- CLI: the refusals in `main()` (#2723, slice 3 of epic #2720) ------------
//
// Everything above calls `parseFrontMatter` / `globToRegExp` / `emptyCoversNote`
// directly. `main()` is what `npm run docs:check` step 1 executes, and its
// refusal -- `if (errors.length) { …; process.exit(1) }` -- is not reachable
// from any of them. That matters more here than for most guards:
// `covers-gaps.mjs` says in its own comment that it may fail open on an
// unparseable doc BECAUSE this step already refused it. If this refusal is
// lost, several downstream guards become fail-open by inheritance instead of
// by design, and every one of them still reports green.
//
// The fixture is a throwaway tree with the script copied into it, so the
// REPO_ROOT it derives from its own location is the fixture's; the real
// `docs/` is never scanned. See scripts/test-support/guard-cli.mjs.
import { runGuard } from "../test-support/guard-cli.mjs";
import { GOVERNED_PACKAGE_DOCS, EXEMPT_PACKAGE_DOCS } from "./package-docs.mjs";

const GOOD = `---
owner: "platform"
status: current
covers: []  # narrative — no code mirror by design
last-verified: "2026-09-08"
---

# A Doc
`;

/**
 * The minimum tree `main()` accepts.
 *
 * `checkPackageDocBoundary` carries its own positive control: a scan that
 * enumerates ZERO `packages/**` Markdown files reports an error rather than a
 * pass (#2088). So a fixture holding only `docs/` cannot reach exit 0 at all,
 * and the accept path has to carry the whole boundary. Both sets and every
 * `covers` glob are read from the guard's own constants rather than copied
 * here, so this fixture cannot drift out of sync with the rows it satisfies.
 */
function baseFixture(extra = {}) {
  const files = {};
  for (const root of ["CLAUDE.md", "AGENTS.md", "README.md", "ABOUT_HAVEN.md"])
    files[root] = GOOD;
  files["docs/area/thing.md"] = GOOD;
  for (const entry of GOVERNED_PACKAGE_DOCS) {
    files[entry.doc] = "# governed package doc\n";
    for (const glob of entry.covers) {
      // One concrete file per glob: `a/b/**` is satisfied by `a/b/index.ts`,
      // an exact path by itself. A governed row whose glob resolves to nothing
      // is an error, so this is what keeps the ACCEPT path accepting.
      files[glob.endsWith("/**") ? `${glob.slice(0, -3)}/index.ts` : glob] =
        "// fixture\n";
    }
  }
  for (const path of Object.keys(EXEMPT_PACKAGE_DOCS))
    files[path] = "# exempt package doc\n";
  return { ...files, ...extra };
}

const OPTS = { also: ["docs/package-docs.mjs"] };

test("CLI: a valid tree exits 0 and says how much it checked", () => {
  const { status, out } = runGuard("docs/validate-frontmatter.mjs", {
    ...OPTS,
    files: baseFixture(),
  });
  assert.equal(status, 0);
  // The COUNTS are asserted, not just the ✓. A walker pointed at the wrong
  // root prints the same tick over zero files; `5 docs` is 4 root docs plus
  // the one under `docs/`, and 15 is 8 governed + 7 exempt.
  assert.match(out, /✓ Front-matter valid across 5 docs\./);
  assert.match(out, /boundary declared for 15 file\(s\): 8 governed, 7 exempt/);
});

test("CLI: a doc missing `owner` exits 1 and names the key and the file", () => {
  const { status, out } = runGuard("docs/validate-frontmatter.mjs", {
    ...OPTS,
    files: baseFixture({
      "docs/area/thing.md": GOOD.replace('owner: "platform"\n', ""),
    }),
  });
  assert.equal(status, 1);
  // The header proves the refusal ran to its report rather than crashing on
  // the way there -- a stack trace also exits 1 and also contains the path.
  assert.match(out, /✗ Front-matter validation failed \(1 issue\(s\)\):/);
  assert.match(out, /docs\/area\/thing\.md: missing required key `owner`/);
});

test("CLI: an unparseable front-matter block exits 1 (the fail-open the chain depends on)", () => {
  const { status, out } = runGuard("docs/validate-frontmatter.mjs", {
    ...OPTS,
    files: baseFixture({
      "docs/area/thing.md": '---\nowner: "platform"\n\n# no closing fence\n',
    }),
  });
  assert.equal(status, 1);
  assert.match(out, /✗ Front-matter validation failed/);
  assert.match(out, /docs\/area\/thing\.md: /);
});

test("CLI: a `covers` glob resolving to no files exits 1", () => {
  const { status, out } = runGuard("docs/validate-frontmatter.mjs", {
    ...OPTS,
    files: baseFixture({
      "docs/area/thing.md": GOOD.replace(
        "covers: []  # narrative — no code mirror by design",
        'covers:\n  - "packages/nowhere/src/**"',
      ),
    }),
  });
  assert.equal(status, 1);
  assert.match(out, /✗ Front-matter validation failed/);
  assert.match(
    out,
    /`covers` glob "packages\/nowhere\/src\/\*\*" resolves to no files/,
  );
});

test("CLI: the retired inline `#` chain is refused by name (#2637)", () => {
  const { status, out } = runGuard("docs/validate-frontmatter.mjs", {
    ...OPTS,
    files: baseFixture({
      "docs/area/thing.md": GOOD.replace(
        'last-verified: "2026-09-08"',
        'last-verified: "2026-09-08"  # 2026-09-07 something; 2026-09-06 something else',
      ),
    }),
  });
  assert.equal(status, 1);
  assert.match(out, /carries a retired inline `#` chain/);
  assert.match(out, /migrate-chain-to-list\.mjs/);
});
