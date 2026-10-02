import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The For agents page may not drift from the runbook (#3577, epic #3572).
 *
 * `/for-agents` is the human-readable face of `/for-agents.md`, which is
 * byte-pinned to the SDK constant (`for-agents-runbook.test.ts`) and cannot
 * be edited to fit the page. So the page is the side that must move: every
 * command it shows in a code or terminal block has to appear VERBATIM in the
 * served runbook. Change a command here without changing it there and this
 * file goes red.
 *
 * Navigation links are deliberately outside this test: the runbook does not
 * contain its own path (`grep -cF '/for-agents.md' public/for-agents.md` → 0),
 * so requiring page hrefs in the runbook text would forbid the page from
 * linking it. The mockup's `EXAMPLE-SETUP-TOKEN` is the case this test
 * exists for — the runbook's token is `EXAMPLE-SETUP-TOKEN-NOT-REAL`, so a
 * page that shortened it fails here while every other check stays green.
 */

const FRONTEND_ROOT = join(__dirname, '..', '..', '..', '..', '..', '..')
const PAGE_SOURCE = readFileSync(
  join(FRONTEND_ROOT, 'src/components/marketing/site/for-agents/ForAgentsPage.tsx'),
  'utf8',
)
const RUNBOOK = readFileSync(join(FRONTEND_ROOT, 'public/for-agents.md'), 'utf8')

/**
 * The command and code spans the page shows in code/terminal blocks, taken
 * from the SOURCE so a rendered variant can never pass while the source
 * drifted. `SiteCode` renders its child text inside a `<pre>`; inline `code`
 * elements render command names and flags. Extracted as string literals:
 * JSX text of every `<code>` and of the two `SiteCode` blocks' command
 * constants, which are module-level strings in the same file.
 */
const SHOWN: ReadonlyArray<string> = (() => {
  const shown = new Set<string>()
  // Module-level command constants the page renders in its code blocks.
  for (const match of PAGE_SOURCE.matchAll(
    /(?:CONNECTOR_COMMAND|DOCTOR_COMMAND)\s*=\s*'([^']+)'/g,
  )) {
    shown.add(match[1])
  }
  // Inline code spans: their text content, `<name>` placeholders unescaped.
  for (const match of PAGE_SOURCE.matchAll(/>\s*([a-z0-9_@./<>= -]+)\s*<\/code>/g)) {
    const text = match[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim()
    if (text) shown.add(text)
  }
  return [...shown]
})()

describe('the For agents page shows only commands the runbook has (#3577)', () => {
  it('found the commands it must check (guard against a vacuous pass)', () => {
    expect(SHOWN.length).toBeGreaterThan(0)
    // The three command forms the issue names, asserted present so an
    // extraction regression cannot silently empty the check above.
    expect(SHOWN).toContain(
      'npx -y @haven_ai/connect@<channel> --setup EXAMPLE-SETUP-TOKEN-NOT-REAL --api <api-url> --ack-local-tools',
    )
    expect(SHOWN).toContain('npx -y @haven_ai/connect@<channel> --doctor')
    expect(SHOWN).toContain('haven_get_agent')
  })

  it.each(SHOWN)('%s appears verbatim in public/for-agents.md', (command) => {
    expect(RUNBOOK).toContain(command)
  })

  it('shows the runbook token, never the mockup’s shortened one', () => {
    expect(PAGE_SOURCE).toContain('EXAMPLE-SETUP-TOKEN-NOT-REAL')
    expect(PAGE_SOURCE).not.toMatch(/EXAMPLE-SETUP-TOKEN(?!-NOT-REAL)/)
  })

  it('signs the reader up with the runbook’s own link shape (#2619)', () => {
    // The runbook's "Before signup" script hands the human
    // /signup?next=/agents&via=agent; a page that took agents somewhere else
    // would send attribution and the funnel through a link the agent
    // composed itself.
    expect(PAGE_SOURCE).toContain('/signup?next=/agents&via=agent')
  })

  it('keeps the headline at the epic-decided form (epic decision 14)', () => {
    expect(PAGE_SOURCE).toContain(
      'You are an AI agent. Here is how to pay with a budget, not a credit card.',
    )
    // The body keeps the runbook's wording, including "not their wallet".
    expect(PAGE_SOURCE).toContain('not their wallet')
  })
})
