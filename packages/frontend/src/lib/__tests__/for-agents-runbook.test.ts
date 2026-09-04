import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
// Canonical runbook lives in the SDK source. The frontend serves it as a static
// file in `public/` and keeps zero @haven_ai/* runtime dependencies (standalone
// Vercel deploys), so the parity is asserted here against the SDK source via a
// relative path — exactly as agent-skill-bundle.test.ts does for the skill.
import {
  HAVEN_AGENT_RUNBOOK_MD,
  AGENT_APPROVAL_RELAY_JSON_SENTENCE,
  AGENT_APPROVAL_RELAY_PROSE_SENTENCE,
  AGENT_COMMAND_MODIFICATION_SENTENCE,
  AGENT_JSON_MODE_SENTENCE,
  AGENT_SECRET_HYGIENE_SENTENCE,
} from '../../../../sdk/src/agent-guidance'
import { PUBLIC_SURFACES } from '@/lib/discovery-surfaces'

/**
 * Guard for the agent onboarding runbook served at `/for-agents.md` (#2523).
 *
 * The file an agent fetches is a static artifact; the string it must equal is
 * SDK source that the backend's setup prompt also reads from. Nothing in a
 * build regenerates the file, so this test is the mechanism that keeps the two
 * from drifting — the same arrangement as the skill (#2334's lesson: a copy no
 * instrument compares is a copy that will differ).
 */

const PUBLIC_DIR = join(__dirname, '../../../public')
const served = readFileSync(join(PUBLIC_DIR, 'for-agents.md'), 'utf8')

describe('/for-agents.md (#2523)', () => {
  it('is byte-for-byte the canonical SDK runbook', () => {
    expect(served).toBe(HAVEN_AGENT_RUNBOOK_MD)
  })

  it('stays small enough for an agent to read cheaply', () => {
    // The issue's budget is ~6 KB: this page is fetched mid-task by a model
    // paying for every token of it. A regression here is prose creep, so the
    // ceiling is stated rather than left to judgement. It sits at 7000 rather
    // than 6144 because the first cold read of the draft (recorded in the PR)
    // came back with five things it could not answer from the page — where
    // `haven_get_agent` comes from, how to run `--doctor` without breaking the
    // two-changes rule, whose voice the imported bullets speak in, where the
    // setup id comes from, and whether the user needs gas as well as USDC.
    // Answering those cost ~480 bytes and is the whole point of the page.
    expect(Buffer.byteLength(served, 'utf8')).toBeLessThan(7000)
  })

  it('states the rules in the SDK words the setup prompt also uses', () => {
    // The point of the shared module: these sentences reach the agent through
    // two routes (this page, and the pasted setup prompt) and must be one text.
    for (const sentence of [
      AGENT_JSON_MODE_SENTENCE,
      AGENT_APPROVAL_RELAY_JSON_SENTENCE,
      AGENT_APPROVAL_RELAY_PROSE_SENTENCE,
      AGENT_COMMAND_MODIFICATION_SENTENCE,
      AGENT_SECRET_HYGIENE_SENTENCE,
    ]) {
      expect(served).toContain(sentence)
    }
  })

  it('carries a hand-off link for every human-only step', () => {
    // Every step the human must do themselves, each as a link the agent can
    // paste. `via=agent` and `next=` are the #2522 shapes.
    expect(served).toContain('/signup?next=/agents&via=agent')
    expect(served).toContain('/login?next=/agents')
    expect(served).toContain('/onboarding?next=/agents')
    expect(served).toContain('/agents?setup=<setup-id>')
    expect(served).toContain('<approval_url>')
  })

  it('tags every step with the actor who performs it', () => {
    const steps = served.split('\n').filter((line) => /^\d+\. \*\*(HUMAN|YOU)/.test(line))
    expect(steps).toHaveLength(6)
    // Four HUMAN steps, not three: account, funding, budget, approval. The
    // page's own prose says four for the same reason — an agent that relays
    // three of them leaves the user stuck at whichever one it dropped.
    expect(steps.filter((s) => s.includes('HUMAN'))).toHaveLength(4)
    expect(served).toContain("Four of the six steps are your user's")
  })

  it('never suggests the agent supplies the account credentials', () => {
    // Owner constraint (2026-09-04): the human keeps every signature, and the
    // runbook must never suggest the agent enters the user's password. The
    // literals are the shapes an instruction to do so would take.
    expect(served).not.toMatch(/enter (?:their|the user's) password/i)
    expect(served).not.toMatch(/I (?:will|can) (?:create|make) (?:the|your) passkey/i)
    expect(served).toContain('I will never ask for your password')
    // Positive control: the same matcher family finds what IS there, so a
    // "no match" above is a fact about the text and not about the regex.
    expect(served).toMatch(/you must not have their password/i)
  })

  it('answers the five questions the first cold read could not', () => {
    // Each of these is a gap a fresh agent hit when given only this page (run
    // recorded in the PR body). They are asserted so a later trim cannot
    // quietly reopen one.
    expect(served).toContain('one of the Haven MCP tools the connector wires into your runtime')
    expect(served).toContain('npx -y @haven_ai/connect@<channel> --doctor')
    expect(served).toContain('so the two-changes rule does not bind it')
    expect(served).toContain('"me" in them is your user, not Haven')
    expect(served).toContain('carries the approval link and the setup id')
    expect(served).toContain('no ETH: Haven sponsors the gas')
  })

  it('names no npm dist-tag of its own', () => {
    // #2423's guard (scripts/release-bump.test.mjs) forbids a published package
    // hard-coding a connector channel in a re-run hint, and this string ships
    // inside @haven_ai/sdk. It matters twice over here: the served file is a
    // committed artifact, so a baked-in channel would also fall out of parity
    // with the SDK the moment release-bump.mjs rewrote the constant.
    const hardCodedChannel = /@haven_ai\/connect@[a-z][a-z0-9-]*/
    expect(hardCodedChannel.test(served)).toBe(false)
    // Positive control: the same pattern on the shape it is meant to catch.
    expect(hardCodedChannel.test('npx -y @haven_ai/connect@alpha --doctor')).toBe(true)
  })

  it('is advertised in the discovery surfaces an agent reads first', () => {
    expect(PUBLIC_SURFACES).toContain('/for-agents.md')
  })

  it('names the connector command shape the backend actually builds', () => {
    // `buildConnectorCommand` in routes/agent-connection-setups.ts emits
    // `npx -y <package> --setup <token> --api <url> --ack-local-tools`. The
    // example here must carry that flag set with an obviously fake token,
    // never a shorter command an agent might run as-is.
    expect(served).toContain('npx -y @haven_ai/connect@<channel> --setup EXAMPLE-SETUP-TOKEN-NOT-REAL')
    expect(served).toContain('--ack-local-tools')
    // The example is illustrative, and the page says so in as many words —
    // `shellQuote` leaves an ordinary token and URL unquoted, and the package
    // tag is per-deployment (`config.connectorChannel`), so an agent that
    // reconstructs the command from this page rather than from its prompt is
    // wrong on both counts.
    expect(served).toContain("Run the prompt's version, not this one")
    expect(served).not.toMatch(/hv_setup_[0-9a-f]/)
  })
})
