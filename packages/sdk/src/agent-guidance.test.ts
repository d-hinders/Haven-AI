/**
 * The agent-facing README section is ONE string with six copies (#2533, A6).
 *
 * All five published packages plus the repo README carry it. They are static
 * Markdown that imports nothing, so nothing at build time keeps them in step —
 * this test is the mechanism, exactly as `for-agents-runbook.test.ts` is for
 * the served runbook and `agent-skill-bundle.test.ts` is for the skill.
 *
 * Why it is worth a test at all: #2310 was a drift bug across published
 * package metadata, and a section hand-maintained in six files is the same
 * shape of mistake waiting to happen — each copy edited by whoever touched
 * that package, diverging a sentence at a time until an agent reading two of
 * them gets two different instructions.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { AGENT_README_SECTION_MD } from './agent-guidance.js'

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..')

/** The five READMEs that ship to npm. */
const PUBLISHED_READMES = [
  'packages/sdk/README.md',
  'packages/signer/README.md',
  'packages/mcp/README.md',
  'packages/connect/README.md',
  'packages/cli/README.md',
] as const

const REPO_README = 'README.md'

function read(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), 'utf8')
}

describe('AGENT_README_SECTION_MD', () => {
  it.each(PUBLISHED_READMES)('is carried verbatim by %s', (rel) => {
    expect(read(rel)).toContain(AGENT_README_SECTION_MD)
  })

  it('is carried verbatim by the repo README too', () => {
    expect(read(REPO_README)).toContain(AGENT_README_SECTION_MD)
  })

  it('appears exactly once per README — six copies, not seven', () => {
    for (const rel of [...PUBLISHED_READMES, REPO_README]) {
      const occurrences = read(rel).split(AGENT_README_SECTION_MD).length - 1
      expect(occurrences, `${rel} carries ${occurrences} copies`).toBe(1)
    }
  })

  it('sits above the first section heading, where a reader meets it early', () => {
    // "Near the top" is the acceptance criterion, and it is checkable: the
    // section must precede every OTHER `## ` heading in the file, so it cannot
    // drift down into the middle as a README grows.
    for (const rel of [...PUBLISHED_READMES, REPO_README]) {
      const body = read(rel)
      const at = body.indexOf(AGENT_README_SECTION_MD)
      const headingsBefore = body
        .slice(0, at)
        .split('\n')
        .filter((l) => l.startsWith('## '))
      expect(headingsBefore, `${rel} buries the section under ${headingsBefore.join(', ')}`).toEqual([])
    }
  })

  it('states the human-only step, which is the epic invariant it exists to carry', () => {
    // Not a prose-interpretation assertion: these are literal commitments the
    // section makes, and an edit that drops one changes what an agent is told
    // it may do. The epic's invariant is that the human keeps every signature.
    expect(AGENT_README_SECTION_MD).toContain('Your user creates the account and the passkey')
    expect(AGENT_README_SECTION_MD).toContain('never ask for their password')
  })

  it('offers a link that resolves for a reader who has no Haven host', () => {
    // The path alone is unfollowable on npmjs.com, which is where these
    // READMEs are most often read. The repository URL is the fallback, and it
    // must point at a file that exists — asserted by reading it.
    expect(AGENT_README_SECTION_MD).toContain('/for-agents.md')
    expect(AGENT_README_SECTION_MD).toContain(
      'https://github.com/d-hinders/Haven-AI/blob/dev/packages/frontend/public/for-agents.md',
    )
    expect(read('packages/frontend/public/for-agents.md')).toContain('# Haven for agents')
  })

  it('uses the settled vocabulary, not a synonym', () => {
    expect(AGENT_README_SECTION_MD).toContain('connector command')
    expect(AGENT_README_SECTION_MD).toContain('setup prompt')
    expect(AGENT_README_SECTION_MD).not.toContain('connect command')
    expect(AGENT_README_SECTION_MD).not.toContain('setup command')
  })
})

describe('the settled agent vocabulary across the artifacts (#2533)', () => {
  /** Every surface the issue names, plus the HTML twin of 402.md. */
  const SURFACES = [
    ...PUBLISHED_READMES,
    REPO_README,
    'packages/frontend/public/llms.txt',
    'packages/frontend/public/llms-full.txt',
    'packages/frontend/public/402.md',
    'packages/frontend/public/402/index.html',
    'packages/frontend/public/for-agents.md',
  ] as const

  it.each(['connect command', 'setup command', 'connection command'])(
    'no surface says %s',
    (banned) => {
      const offenders = SURFACES.filter((rel) => read(rel).toLowerCase().includes(banned))
      expect(offenders).toEqual([])
    },
  )

  it('positive control: the instrument CAN find a term that is present', () => {
    // Without this, the "no surface says X" results above are equally
    // consistent with a broken reader. `connector command` is the term those
    // sweeps replaced, so it must be found on more than one surface.
    const found = SURFACES.filter((rel) => read(rel).toLowerCase().includes('connector command'))
    expect(found.length).toBeGreaterThan(1)
  })

  it('no product surface mints an sk_live_ credential', () => {
    // `sk_live_` is another product's shape; Haven mints `sk_agent_`. The
    // backend's Pimlico redaction tests legitimately contain the string and
    // are deliberately out of this list.
    const offenders = [...SURFACES, 'packages/frontend/src/app/how-it-works/page.tsx'].filter((rel) =>
      read(rel).includes('sk_live_'),
    )
    expect(offenders).toEqual([])
  })
})
