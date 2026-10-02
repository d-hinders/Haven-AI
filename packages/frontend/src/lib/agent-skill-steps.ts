/**
 * Metadata for the agent onboarding runbook's step files (#3596).
 *
 * `HAVEN_AGENT_RUNBOOK_MD` (`packages/sdk/src/agent-guidance.ts`) is the
 * canonical runbook, served whole at `/for-agents.md`. This epic additionally
 * serves it as small, linked step files — the pattern Circle's agent stack
 * uses at `https://agents.circle.com/.well-known/agent-skills/index.json`:
 * one small skill per step, each linking to the next.
 *
 * Each step file is a **byte-slice of the runbook at a `## ` boundary** —
 * never separately written prose — so the step files keep the runbook's
 * existing content guards (chain-assertion, dead-host, one-liner parity)
 * meaningful. `STEP_HEADING` is the exact heading line the slice starts at,
 * used both to locate the slice boundary and to detect drift if a heading is
 * reworded without updating this list.
 *
 * The step files are committed static files under
 * `packages/frontend/public/agent-skills/` — the `/for-agents.md` model: the
 * frontend has zero `@haven_ai/*` runtime dependencies, so nothing here
 * imports the SDK. `packages/cli/scripts/sync-agent-guidance.mjs` carries the
 * matching slicing logic for `GENERATED_COPIES` (`--check` parity) and to
 * (re)write the files; this module is the frontend's read-only copy of the
 * same step list, for the index route and its tests. Keep the two in sync by
 * hand — the same discipline `HAVEN_AGENT_RUNBOOK_MD`'s own copies already
 * require (#2334).
 */

export interface AgentSkillStep {
  /** Filename stem under `public/agent-skills/` and the slug in the index. */
  slug: string
  /** The exact `## ` heading line in `HAVEN_AGENT_RUNBOOK_MD` this step slices from. */
  heading: string
  /** Human-facing title, reused as the generated "Next" link text. */
  title: string
  /** One-line description for the agent-skills index. */
  description: string
}

export const AGENT_SKILL_STEPS: readonly AgentSkillStep[] = [
  {
    slug: 'what-haven-is',
    heading: '## What Haven is, in three sentences',
    title: 'What Haven is, in three sentences',
    description:
      'The budget model: a signed, on-chain delegation on the user’s own account, never a wallet or a key.',
  },
  {
    slug: 'the-sequence',
    heading: '## The sequence',
    title: 'The sequence',
    description: 'The six onboarding steps, which are the human’s and which are yours.',
  },
  {
    slug: 'budget-changes-later',
    heading: '## Budget changes later (second token, raise, revoke)',
    title: 'Budget changes later',
    description: 'Granting a second token, raising a budget, or revoking one after the agent exists.',
  },
  {
    slug: 'hand-off-scripts',
    heading: '## Hand-off scripts',
    title: 'Hand-off scripts',
    description: 'The exact messages to send your user at each step that needs their signature.',
  },
  {
    slug: 'what-you-run',
    heading: '## What you run',
    title: 'What you run',
    description: 'The connector command shape and the rules that govern running it.',
  },
  {
    slug: 'how-to-verify',
    heading: '## How to verify',
    title: 'How to verify',
    description: 'Reading spend_authority_readiness to confirm the budget is live before you pay.',
  },
  {
    slug: 'if-you-cannot-open-a-browser',
    heading: '## If you cannot open a browser',
    title: 'If you cannot open a browser',
    description: 'Completing onboarding by handing your user links instead of a browser session.',
  },
  {
    slug: 'if-something-breaks',
    heading: '## If something breaks',
    title: 'If something breaks',
    description: 'What a client_update result means, and how to update before retrying.',
  },
  {
    slug: 'vocabulary',
    heading: '## Vocabulary',
    title: 'Vocabulary',
    description: 'The five agent-facing terms this runbook uses, defined once.',
  },
] as const

/** `public/agent-skills/<slug>.md`, same-origin relative form. */
export function stepPath(slug: string): string {
  return `/agent-skills/${slug}.md`
}

/**
 * Slice `runbook` into one chunk per `AGENT_SKILL_STEPS` entry, boundary-exact
 * (concatenating every `body` reproduces `runbook` byte-for-byte). The first
 * step's body carries the preamble (the title and intro above the first `##`
 * heading) — there is no tenth, headless step file for it.
 */
export function sliceRunbookSteps(runbook: string): Array<AgentSkillStep & { body: string }> {
  const starts = AGENT_SKILL_STEPS.map((step, i) => (i === 0 ? 0 : runbook.indexOf(step.heading)))
  starts.forEach((start, i) => {
    if (start < 0) throw new Error(`heading not found in runbook: ${AGENT_SKILL_STEPS[i].heading}`)
  })
  const bounds = [...starts, runbook.length]
  return AGENT_SKILL_STEPS.map((step, i) => ({ ...step, body: runbook.slice(bounds[i], bounds[i + 1]) }))
}

/**
 * The generated "Next" link appended to every step file except the last — the
 * runbook's own final line (`Next: [your agent hit a 402]...`) is untouched
 * content, not this. Exported so the parity test can strip exactly this
 * suffix back off a served step file before comparing it to its slice.
 */
export function nextLinkSuffix(next: AgentSkillStep | undefined): string {
  if (!next) return ''
  return `\n\n---\n\nNext: [${next.title}](${stepPath(next.slug)})\n`
}
