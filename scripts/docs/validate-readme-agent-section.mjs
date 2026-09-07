#!/usr/bin/env node
/**
 * The agent-facing README section is one string with six copies (#2533).
 *
 * WHY THIS RUNS HERE AND NOT ONLY IN THE SDK SUITE. The typed pin lives beside
 * the constant (`packages/sdk/src/agent-guidance.test.ts`), which is the right
 * home for it — it imports the real export rather than a copy of the text. But
 * the SDK job is surface-gated: `scripts/ci/change-classifier.mjs` routes
 * `packages/sdk/*` to the `sdk` surface, and a change touching ONLY a README
 * routes to no surface at all. Measured, not assumed:
 *
 *   classifyChangedFiles(['packages/cli/README.md'])  -> no surface enabled
 *
 * So the one edit this guard exists to catch — someone changing a single
 * package's README — is precisely the edit that would not run the SDK job.
 * The docs `validate` job has `pull_request:` with no `paths:` filter, so it
 * runs on every pull request; that is why the check is duplicated here.
 *
 * The two instruments are not redundant. This one reads the constant as TEXT
 * and can therefore run without a build; the SDK test imports it and proves
 * the exported value is what the READMEs carry. Either alone leaves a gap.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SOURCE = 'packages/sdk/src/agent-guidance.ts'
const CONSTANT = 'AGENT_README_SECTION_MD'

export const README_COPIES = Object.freeze([
  'README.md',
  'packages/sdk/README.md',
  'packages/signer/README.md',
  'packages/mcp/README.md',
  'packages/connect/README.md',
  'packages/cli/README.md',
])

/**
 * Pull the template literal out of the TypeScript source.
 *
 * Deliberately strict: an extraction that silently returned '' would make
 * every `includes('')` below pass, which is the failure mode where a guard
 * reports green having checked nothing. A miss throws.
 */
export function extractCanonicalSection(sourceText) {
  const start = sourceText.indexOf(`export const ${CONSTANT} = \``)
  if (start === -1) {
    throw new Error(
      `${SOURCE}: could not find \`export const ${CONSTANT} = \`…\`\`. ` +
        'If the constant was renamed or its declaration reformatted, update this validator ' +
        '— do not delete it.',
    )
  }
  const open = sourceText.indexOf('`', start)
  let i = open + 1
  let out = ''
  while (i < sourceText.length) {
    const ch = sourceText[i]
    if (ch === '\\') {
      // Only the escapes this literal actually uses; anything else is passed
      // through so an unexpected escape shows up as a mismatch rather than
      // being silently normalised away.
      const next = sourceText[i + 1]
      out += next === '`' || next === '\\' || next === '$' ? next : ch + next
      i += 2
      continue
    }
    if (ch === '`') return out
    out += ch
    i += 1
  }
  throw new Error(`${SOURCE}: unterminated template literal for ${CONSTANT}.`)
}

function main() {
  const source = readFileSync(path.join(REPO_ROOT, SOURCE), 'utf8')
  const canonical = extractCanonicalSection(source)

  if (canonical.trim().length < 100) {
    throw new Error(
      `${SOURCE}: ${CONSTANT} extracted as ${canonical.length} characters, which is too short to ` +
        'be the real section. Refusing to check six READMEs against a value this guard probably ' +
        'mis-parsed.',
    )
  }

  const missing = []
  const duplicated = []
  for (const rel of README_COPIES) {
    const body = readFileSync(path.join(REPO_ROOT, rel), 'utf8')
    const count = body.split(canonical).length - 1
    if (count === 0) missing.push(rel)
    else if (count > 1) duplicated.push(`${rel} (${count} copies)`)
  }

  if (missing.length || duplicated.length) {
    console.error('\n✗ The agent-facing README section has drifted (#2533).\n')
    if (missing.length) {
      console.error('  Does not carry it verbatim:')
      for (const rel of missing) console.error(`    - ${rel}`)
    }
    if (duplicated.length) {
      console.error('  Carries it more than once:')
      for (const rel of duplicated) console.error(`    - ${rel}`)
    }
    console.error(
      `\n  The section is ONE string: ${CONSTANT} in ${SOURCE}.\n` +
        '  Edit the constant and re-paste it into all six copies — never edit a README copy alone.\n',
    )
    process.exitCode = 1
    return
  }

  console.log(`✓ Agent-facing README section identical across ${README_COPIES.length} copies (#2533).`)
}

if (import.meta.url === `file://${process.argv[1]}`) main()
