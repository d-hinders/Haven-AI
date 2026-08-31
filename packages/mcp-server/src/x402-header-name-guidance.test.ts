/**
 * #2330 — every agent-facing mention of the x402 payment header names BOTH
 * wire names, across every surface an agent reads.
 *
 * ## What this exists to catch
 *
 * #2289 fixed the header name where Haven makes the request: `deliverPayment`
 * sets `PAYMENT-SIGNATURE` and `X-PAYMENT` to the same value, and every
 * SDK-driven retry routes through it. Eight tests pin that.
 *
 * It did not fix the header name where Haven *tells the agent* to make the
 * request — and `haven_pay_x402_quote`'s whole premise is "retry the merchant
 * YOURSELF". Three descriptions still said `X-PAYMENT` alone, two more named
 * no header at all, and NOTHING anywhere named `PAYMENT-SIGNATURE` to an
 * agent. An agent following that guidance against a strict x402 v2 merchant
 * sets only the v1 name, the merchant ignores the header, and on the EIP-3009
 * bridge the funding leg has already moved the money — the epic's originating
 * CoinGecko failure, reproduced by following Haven's own instructions.
 *
 * Every one of #2289's tests exercised `deliverPayment`. None read a
 * description. The wire was pinned; the instruction telling anyone what to put
 * on the wire was not.
 *
 * ## Why the assertion is shaped this way
 *
 * Per-DESCRIPTION, not per-line: the legitimate form names both names, and
 * they routinely land on different lines of the same string. Purely literal —
 * it asks whether one substring appears when another does, and never
 * interprets a sentence (ship-next § Rework caps). It cannot verify that the
 * surrounding prose is *sensible*; human review is the control for that. What
 * it does guarantee is that no surface can go back to naming v1 alone.
 *
 * ## Scope, stated rather than assumed
 *
 * Covers the exported description records of all three tool surfaces an agent
 * reads, AND the SDK's `havenTools` tool definitions.
 *
 * That last one is here because the first version of this guard did not have
 * it, and was green while the primary defect sat un-covered: the SDK's
 * `AUTHORIZE_X402_DESCRIPTION` — the one string in this whole issue that says
 * "when doing a manual HTTP retry" in as many words — is not in
 * `toolDescriptions`, it is a `description` field on `havenTools.claude` /
 * `.openai`. Reverting it to its v1-only wording passed every test. Two
 * plausibly-named exports, only one of them the one that mattered; the guard
 * now walks both and a mutation confirms it.
 *
 * It does NOT cover runtime error strings, code comments, or the `reason`
 * field of `buildAgentGuidance` — `reason` is built per-call inside a handler
 * and is not reachable from a static record.
 *
 * That sentence originally ended "...so the two guidance strings this issue
 * fixed there are pinned separately in `tools.test.ts`." **That was false when
 * written**: no test in this repository asserted a header name on either
 * `reason`. Review caught it. Claiming a safety net that does not exist is
 * worse than naming the gap, because the next person to revert either site
 * sees green and believes it. The two `reason` strings are pinned in
 * `tools.test.ts` NOW — search it for `PAYMENT-SIGNATURE` — and this paragraph
 * stays as the reason that claim is worth re-checking rather than trusting.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { toolDescriptions as hostedDescriptions } from './tools.js'
import { toolDescriptions as signerDescriptions } from '@haven_ai/signer'
import { toolDescriptions as sdkDescriptions, havenTools } from '@haven_ai/sdk'

const V2_NAME = 'PAYMENT-SIGNATURE'
const V1_NAME = 'X-PAYMENT'

/** Flatten a shared-description record to one searchable string per key. */
function flatten(record: Record<string, unknown>): Array<[string, string]> {
  return Object.entries(record).map(([name, value]) => [
    name,
    typeof value === 'string' ? value : JSON.stringify(value),
  ])
}

/** Every `description` on a tool definition, keyed by the tool's own name. */
function toolDefinitionDescriptions(defs: unknown): Array<[string, string]> {
  if (!Array.isArray(defs)) return []
  const out: Array<[string, string]> = []
  for (const def of defs) {
    const record = def as { name?: unknown; description?: unknown; function?: unknown }
    // OpenAI shape nests name+description under `function`.
    const fn = record.function as { name?: unknown; description?: unknown } | undefined
    const name = typeof record.name === 'string' ? record.name : fn?.name
    const description =
      typeof record.description === 'string' ? record.description : fn?.description
    if (typeof name === 'string' && typeof description === 'string') out.push([name, description])
  }
  return out
}

// `havenTools.claude` / `.openai` are zero-arg FACTORIES, not arrays — the
// first widening of this guard assumed arrays, got zero entries from both, and
// the non-vacuity assertion is what caught that rather than a silent pass.
const sdkToolDefs = havenTools as unknown as { claude: () => unknown; openai: () => unknown }
const sdkClaudeTools = sdkToolDefs.claude()
const sdkOpenaiTools = sdkToolDefs.openai()

const SURFACES: Array<[label: string, entries: Array<[string, string]>]> = [
  ['hosted MCP', flatten(hostedDescriptions as unknown as Record<string, unknown>)],
  ['edge signer', flatten(signerDescriptions as unknown as Record<string, unknown>)],
  ['sdk shared', flatten(sdkDescriptions as unknown as Record<string, unknown>)],
  ['sdk havenTools.claude', toolDefinitionDescriptions(sdkClaudeTools)],
  ['sdk havenTools.openai', toolDefinitionDescriptions(sdkOpenaiTools)],
]

describe('#2330 — no agent-facing surface names the v1 header alone', () => {
  it.each(SURFACES)('%s descriptions never name X-PAYMENT without PAYMENT-SIGNATURE', (_label, entries) => {
    // Non-vacuity: an empty record would satisfy every assertion below.
    expect(entries.length).toBeGreaterThan(0)

    for (const [name, description] of entries) {
      if (!description.includes(V1_NAME)) continue
      expect(
        description,
        `${name} names ${V1_NAME} without ${V2_NAME}. A strict x402 v2 merchant reads only ` +
          `${V2_NAME}; an agent told to send the legacy name alone reproduces the #2288 failure, ` +
          'with the funding leg already spent. Name both, v2 first.',
      ).toContain(V2_NAME)
    }
  })

  it('at least one surface actually names both — the guard is not vacuously green', () => {
    // Every assertion above is a conditional. If no description mentioned the
    // header at all they would all pass while the guidance said nothing, which
    // is the state #2291 left two of these strings in.
    const naming = SURFACES.flatMap(([, entries]) => entries).filter(
      ([, description]) => description.includes(V2_NAME) && description.includes(V1_NAME),
    )
    expect(naming.length).toBeGreaterThan(0)
  })

  it("the SDK's manual-retry instruction names both — the site the first guard missed", () => {
    // AUTHORIZE_X402_DESCRIPTION is the only string that explicitly addresses a
    // manual HTTP retry, and it lived outside the record the first version of
    // this guard read. Asserted by name so the coverage cannot silently narrow
    // again if havenTools is reshaped.
    const claude = toolDefinitionDescriptions(sdkClaudeTools)
    const authorize = claude.find(([name]) => name === 'authorize_x402_payment')
    expect(authorize, 'authorize_x402_payment missing from havenTools.claude').toBeDefined()
    expect(authorize![1]).toContain(V2_NAME)
    expect(authorize![1]).toContain(V1_NAME)
    expect(authorize![1]).toContain('manual HTTP retry')
  })

  it('the hosted plain-HTTP quote path — where the AGENT retries — names both', () => {
    // The specific surface the originating purchase used. Asserted by name
    // rather than left to the sweep, because this is the one that mattered.
    const quote = (hostedDescriptions as Record<string, string>).haven_pay_x402_quote
    expect(quote).toContain(V2_NAME)
    expect(quote).toContain(V1_NAME)
    expect(quote).toContain('retry the merchant YOURSELF')
  })
})

/**
 * #2330 (review finding) — the description sweep above could not have caught
 * the surface review actually found: a copy-pasteable code sample on the
 * public `/protocols/x402` page setting `'X-PAYMENT'` alone. A developer
 * pasting it against a strict v2 merchant reproduces the epic's originating
 * failure, and no description record contains it.
 *
 * So this scans the tree for the act of SETTING the header — an object-literal
 * key, a `headers.set(...)`, or a header line in a Markdown code fence — and
 * requires the file to name the v2 name somewhere too. File-level granularity
 * on purpose: a file that sets this header and never mentions
 * `PAYMENT-SIGNATURE` is the shape of the defect, and anything finer starts
 * guessing at how far "nearby" reaches.
 *
 * It matches the ACT, not the mention, so the many legitimate discussions of
 * the v1 name — historical changelog entries, retired-rail sections, spec
 * references — are untouched without needing to be listed.
 */
const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..')

/**
 * Setting the header, in every shape review could construct. The first version
 * matched an object-literal key, `.set(...)`, and a line-opening Markdown
 * header — and review demonstrated a live miss by rewriting the `/protocols`
 * sample to use `Headers.append`, which is not only a normal way to do this but
 * a WORSE one for this bug, since `append` does not overwrite a stale value.
 * Computed keys, bracket assignment, header tuple arrays and an inline
 * `curl -H "X-PAYMENT: ..."` were the other confirmed blind spots. None had a
 * live instance; the point is that a guard with known holes is the failure this
 * whole issue is about, so the holes are closed rather than noted.
 *
 * It matches the header as a KEY, never as a value. `paymentProofHeaderName:
 * 'X-PAYMENT'` RECORDS which name a merchant was sent — evidence, not an
 * instruction — and a first draft that matched a bare quoted name flagged three
 * such fixtures plus a doc comment. Over-matching would have been the more
 * expensive mistake: a guard that cries wolf gets an allowlist entry per
 * false positive until the allowlist is the real config.
 */
const SETS_V1_HEADER = new RegExp(
  [
    // Object-literal KEY: `{ 'X-PAYMENT': token }`. Quotes, not backticks —
    // backticked mentions are prose, and a first draft that accepted them
    // flagged three evidence fixtures and a doc comment in `client.ts`.
    `(['"]X-PAYMENT['"]\\s*:)`,
    // The header-mutating APIs, including a template-literal argument.
    `((?:\\.set|\\.append|\\.setHeader)\\(\\s*['"\`]X-PAYMENT['"\`])`,
    // Computed key, bracket assignment, or a header tuple: `['X-PAYMENT']:`,
    // `headers['X-PAYMENT'] =`, `[['X-PAYMENT', token]]`.
    `(\\[\\s*['"]X-PAYMENT['"]\\s*[,\\]])`,
    // A curl example anywhere on the line.
    `(-H\\s+['"]?X-PAYMENT:)`,
    // A header line opening a Markdown code fence.
    `(^\\s*X-PAYMENT:\\s*\\S)`,
  ].join('|'),
  'm',
)

const SCAN_ROOTS = ['packages', 'docs']
const SKIP_DIRS = new Set(['node_modules', 'dist', '.next', 'coverage', '.turbo'])
const SKIP_PATHS = [
  // Historical compliance records: they describe what was true when written.
  'docs/regulatory/casp-changelog/',
  // The demo merchant RECEIVES; accepting the v1 alias is its documented job.
  'packages/demo-merchant-mcp/',
]
const ALLOWLIST = new Map<string, string>([
  [
    'packages/sdk/src/mcp-merchant-transport.test.ts',
    'plants a STALE X-PAYMENT on the caller init to prove deliverPayment ' +
      'overwrites it — naming v1 alone is the point of the fixture',
  ],
  [
    'packages/sdk/src/x402-payment-header-name.test.ts',
    'same stale-header fixture as its sibling above. Listed explicitly because ' +
      'review proved it was passing by COINCIDENCE — unrelated tests later in ' +
      'the file happen to mention the v2 name, and redacting those made the ' +
      'guard fail. An accidental pass is not coverage',
  ],
])

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) yield* walk(full)
    else if (/\.(ts|tsx|md)$/.test(entry)) yield full
  }
}

describe('#2330 — nothing SETS the v1 header alone', () => {
  it('every file that sets X-PAYMENT also names PAYMENT-SIGNATURE', () => {
    const offenders: string[] = []
    let scanned = 0
    let setters = 0

    for (const root of SCAN_ROOTS) {
      for (const file of walk(join(REPO_ROOT, root))) {
        const rel = relative(REPO_ROOT, file).split('\\').join('/')
        if (SKIP_PATHS.some((skip) => rel.startsWith(skip))) continue
        scanned += 1
        const source = readFileSync(file, 'utf8')
        if (!SETS_V1_HEADER.test(source)) continue
        setters += 1
        if (ALLOWLIST.has(rel)) continue
        if (!source.includes(V2_NAME)) offenders.push(rel)
      }
    }

    // Non-vacuity, both directions: the walk found files, and it found files
    // that actually set the header. A broken glob would otherwise report a
    // clean sweep of nothing — the exact way this test could go green while
    // the next /protocols-style sample ships.
    expect(scanned).toBeGreaterThan(100)
    expect(setters).toBeGreaterThan(0)

    expect(
      offenders,
      `these files set ${V1_NAME} without naming ${V2_NAME}. A strict x402 v2 merchant ` +
        `reads only ${V2_NAME}; setting the legacy name alone is indistinguishable from ` +
        'sending no header, and on the EIP-3009 bridge the funding leg has already moved ' +
        'the money. Set both, or add an allowlist entry saying why v1 alone is correct here.',
    ).toEqual([])
  })
})
