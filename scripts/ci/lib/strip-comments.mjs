/**
 * `stripComments` — shared by the queue-framing census and by any test that
 * has to scan SOURCE for a claim rather than for prose.
 *
 * Extracted from `scripts/ci/queue-framing-census.test.mjs` by #2110. It used
 * to live in that file, and importing it from a `.test.mjs` module ran the
 * census's ~40 `node:test` registrations as an import side effect — coupling
 * an unrelated unit test's pass/fail to a repo-wide scan, and re-running that
 * scan on every load. A helper that tests import must not itself register
 * tests.
 */
/**
 * Strip `//` line comments and block comments so a maintainer comment that
 * NAMES the retirement is not mistaken for a claim that re-asserts it. Crude
 * on purpose: it does not parse strings, so a banned phrase inside a string
 * literal that happens to follow a `//` on the same line would be missed. That
 * has never been the shape of this defect — the defect is whole sentences — and
 * the positive controls below prove the scanner still detects real prose.
 */
export function stripComments(source, { markdown = false } = {}) {
  const stripped = source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
  // JSDoc continuation lines (` * …`) and `#` comments are noise in SOURCE
  // files. In MARKDOWN both are content — `# Heading` and `* bullet` — and
  // blanking them would hide a queue claim written in a heading or a
  // star-bulleted list from the census entirely. Reviewer finding on #2100:
  // no live false negative, but a latent hole in three published READMEs.
  const decommented = markdown ? stripped : stripped.replace(/^\s*[*#]\s?.*$/gm, ' ')
  // Join adjacent string literals. A banned sentence in source is almost never
  // one literal — it is `'…is queued for the ' + 'wallet owner…'` wrapped across
  // lines by the formatter, and a contiguous-substring scanner sails straight
  // past it. This was not hypothetical: the three hosted guidance payloads the
  // #2100 review found had exactly that shape, and the census caught them only
  // because a SECOND banned phrase happened to sit inside one literal.
  return decommented.replace(/['"`]\s*\+\s*['"`]/g, '')
}
