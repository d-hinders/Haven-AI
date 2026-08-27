import { readFileSync } from 'node:fs'
import { toolDescriptions } from './tools.js'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  computeConsentHash,
  consentInputFromClient,
  ensureConsent,
  renderConsentBlock,
  type ConsentInput,
} from './consent.js'

function captureWriter() {
  const chunks: string[] = []
  return {
    out: {
      write(chunk: string) {
        chunks.push(chunk)
        return true
      },
    },
    text: () => chunks.join(''),
  }
}

const input: ConsentInput = {
  apiKeyPrefix: 'sk_agent_ab',
  apiUrl: 'https://haven.example',
  agentId: 'agt_test',
  safeAddress: '0xSafe',
  delegateAddress: '0xDelegate',
  chainId: 100,
  toolNames: ['haven_get_agent', 'haven_pay_x402_quote'],
  allowanceSummary: [
    { token: 'USDC', amount: '50.000000', resetMinutes: 1440 },
  ],
}

describe('consent gate', () => {
  it('computes a stable hash regardless of tool / allowance ordering', () => {
    const a = computeConsentHash(input)
    const b = computeConsentHash({
      ...input,
      toolNames: [...input.toolNames].reverse(),
      allowanceSummary: [...input.allowanceSummary].reverse(),
    })
    expect(a).toBe(b)
  })

  it('changes the hash when the credential or surface changes', () => {
    const baseHash = computeConsentHash(input)
    expect(computeConsentHash({ ...input, apiKeyPrefix: 'sk_agent_zz' })).not.toBe(baseHash)
    expect(
      computeConsentHash({
        ...input,
        allowanceSummary: [{ token: 'USDC', amount: '999.000000', resetMinutes: 1440 }],
      }),
    ).not.toBe(baseHash)
    expect(
      computeConsentHash({ ...input, toolNames: ['haven_get_agent'] }),
    ).not.toBe(baseHash)
  })

  it('changes the hash when the Haven wallet, delegate, or chain changes', () => {
    // Regression for PR #176 review P2: a credential swap with identical
    // token/amount/reset summary must invalidate the prior acknowledgement.
    const baseHash = computeConsentHash(input)
    expect(computeConsentHash({ ...input, safeAddress: '0xOtherSafe' })).not.toBe(baseHash)
    expect(computeConsentHash({ ...input, delegateAddress: '0xOtherDelegate' })).not.toBe(baseHash)
    expect(computeConsentHash({ ...input, chainId: 137 })).not.toBe(baseHash)
    expect(computeConsentHash({ ...input, apiUrl: 'https://other.example' })).not.toBe(baseHash)
    expect(computeConsentHash({ ...input, agentId: 'agt_other' })).not.toBe(baseHash)
  })

  it('normalises address casing so cosmetic credential edits do not re-prompt', () => {
    const baseHash = computeConsentHash(input)
    const upper = computeConsentHash({
      ...input,
      safeAddress: input.safeAddress?.toUpperCase(),
      delegateAddress: input.delegateAddress?.toUpperCase(),
    })
    expect(upper).toBe(baseHash)
  })

  it('renders wallet, delegate, and chain in the consent block', () => {
    const hash = computeConsentHash(input)
    const block = renderConsentBlock(input, hash)
    expect(block).toContain('Haven wallet (Safe): 0xSafe')
    expect(block).toContain('Delegate (local signer): 0xDelegate')
    expect(block).toContain('Chain ID:  100')
    expect(block).toContain('Haven API: https://haven.example')
    expect(block).toContain('Agent ID:  agt_test')
  })

  it('accepts an env-var hash match without printing the block', async () => {
    const writer = captureWriter()
    const hash = computeConsentHash(input)
    const decision = await ensureConsent(input, {
      env: { HAVEN_MCP_ACK: hash },
      out: writer.out,
    })
    expect(decision).toMatchObject({ ok: true, reason: 'env_var_match', hash })
    expect(writer.text()).toBe('')
  })

  it('accepts HAVEN_MCP_ACK=skip', async () => {
    const writer = captureWriter()
    const decision = await ensureConsent(input, {
      env: { HAVEN_MCP_ACK: 'skip' },
      out: writer.out,
    })
    expect(decision.ok).toBe(true)
    expect(decision.reason).toBe('env_var_skip')
    expect(writer.text()).toBe('')
  })

  it('refuses and prints when no acknowledgement is present', async () => {
    const writer = captureWriter()
    const decision = await ensureConsent(input, { env: {}, out: writer.out })
    expect(decision.ok).toBe(false)
    expect(decision.reason).toBe('no_acknowledgement')
    const text = writer.text()
    expect(text).toContain('Haven MCP server — first-launch consent')
    expect(text).toContain('haven_pay_x402_quote')
    expect(text).toContain('USDC')
  })

  it('refuses on env-var mismatch and surfaces the expected hash', async () => {
    const writer = captureWriter()
    const decision = await ensureConsent(input, {
      env: { HAVEN_MCP_ACK: 'deadbeef' },
      out: writer.out,
    })
    expect(decision.ok).toBe(false)
    expect(decision.reason).toBe('env_var_mismatch')
    expect(writer.text()).toContain(decision.hash)
  })

  it('uses the sidecar ack file when present', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'haven-mcp-ack-'))
    const credentialsPath = join(dir, 'agent.json')
    await writeFile(credentialsPath, '{}', 'utf8')
    try {
      const hash = computeConsentHash(input)
      await writeFile(`${credentialsPath}.ack.json`, JSON.stringify({ ack: hash }), 'utf8')
      const writer = captureWriter()
      const decision = await ensureConsent(input, {
        env: {},
        credentialsPath,
        out: writer.out,
      })
      expect(decision).toMatchObject({ ok: true, reason: 'ack_file_match' })
      expect(writer.text()).toBe('')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('writes the sidecar ack file when --ack (writeAck) is set', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'haven-mcp-ack-'))
    const credentialsPath = join(dir, 'agent.json')
    await writeFile(credentialsPath, '{}', 'utf8')
    try {
      const writer = captureWriter()
      const decision = await ensureConsent(input, {
        env: {},
        credentialsPath,
        writeAck: true,
        out: writer.out,
      })
      expect(decision).toMatchObject({ ok: true, reason: 'wrote_ack_file' })

      const sidecar = JSON.parse(await readFile(`${credentialsPath}.ack.json`, 'utf8'))
      expect(sidecar.ack).toBe(decision.hash)
      expect(writer.text()).toContain('Haven MCP server — first-launch consent')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rejects --ack when no credentials path is set (env-only setups)', async () => {
    const writer = captureWriter()
    const decision = await ensureConsent(input, {
      env: {},
      writeAck: true,
      out: writer.out,
    })
    // Without a credentials path there is nowhere to write the sidecar;
    // fall through to the "refuse" path so the operator picks the env var.
    expect(decision.ok).toBe(false)
    expect(decision.reason).toBe('no_acknowledgement')
  })

  it('renderConsentBlock surfaces the hash and tool descriptions', () => {
    const hash = computeConsentHash(input)
    const block = renderConsentBlock(input, hash)
    expect(block).toContain(`Consent hash: ${hash}`)
    expect(block).toContain('haven_pay_x402_quote')
    // #2086: this asserted 'Safe AllowanceModule'. The gate named a rail that
    // can no longer pay at all (#1986 answers 410 on the payment paths), so
    // the test was holding the wrong copy in place rather than protecting it.
    expect(block).toContain('signed delegation')
  })

  // ── #2086: the gate must not promise a human backstop ────────────────────
  //
  // The consent block is the LAST thing an operator reads before handing
  // payment tools to a model, and it used to tell them an over-budget payment
  // "pauses for owner approval in the Haven dashboard". Nothing pauses and
  // nobody is asked: the budget delegation's caveat enforcers decline it
  // on-chain, and since #2055 there is not even a table an approval could
  // live in. An operator who believed that sentence would size a budget
  // expecting a second pair of eyes that does not exist.
  //
  // These assertions are deliberately about ABSENCE as well as presence — a
  // rewrite that reads well but leaves one queue sentence behind is the
  // failure mode, and only the negative assertions catch it.
  describe('delegation-rail framing (#2086)', () => {
    const cases: [string, ConsentInput][] = [
      ['with a budget', input],
      ['with no budget configured', { ...input, allowanceSummary: [] }],
    ]

    /**
     * The gate's OWN prose, with the embedded tool inventory removed.
     *
     * `renderConsentBlock` interpolates `toolDescriptions[name]` verbatim, and
     * those descriptions live in `@haven_ai/sdk` (`tool-descriptions.ts`) —
     * a different package, a different surface, and one with its own
     * shrink-only size ratchet (#1591). Seven of them still name the
     * AllowanceModule; that is real residue and is filed as its own issue
     * rather than absorbed here, because rewriting agent-visible tool prose
     * changes what models do and is not this issue's scope.
     *
     * Removing them by exact value rather than by line shape: the layout is
     * incidental, the strings are the thing being excluded, and a formatting
     * change must not silently widen what these assertions cover.
     */
    /**
     * The one vocabulary. Re-review of #2086 found the README test carrying a
     * NARROWER list than the gate's, and demonstrated the hole: editing only
     * the README's audit-log sentence to "…held for a second pair of eyes
     * before they are allowed to settle" left all 25 tests green. The README
     * is hand-maintained prose that no renderer constrains, so it is the
     * easier of the two to re-break — holding it to a weaker standard than the
     * generated block had it exactly backwards.
     *
     * `docs/product/copy-guidelines.md`: never describe an out-of-rules
     * payment as pending, queued, or waiting — nothing is held.
     */
    const HUMAN_BACKSTOP_PATTERNS = [
      /AllowanceModule/i,
      /manual approval/i,
      /owner approval/i,
      /pauses for/i,
      /queue for|pending approval|awaiting approval/i,
      /manual review|sign-off|signed off|flag(ged)? for/i,
      /held for|escalat|second pair of eyes/i,
    ]

    function gateProse(block: string, subject: ConsentInput): string {
      return subject.toolNames.reduce(
        (acc, name) => acc.split(toolDescriptions[name]).join(''),
        block,
      )
    }

    for (const [label, subject] of cases) {
      it(`names no approval queue or AllowanceModule ${label}`, () => {
        const block = renderConsentBlock(subject, computeConsentHash(subject))
        const prose = gateProse(block, subject)
        for (const pattern of HUMAN_BACKSTOP_PATTERNS) {
          expect(prose).not.toMatch(pattern)
        }
      })

      it(`states the on-chain decline, in the product's own terms ${label}`, () => {
        const block = renderConsentBlock(subject, computeConsentHash(subject))
        expect(block).toMatch(/declined/i)
        expect(gateProse(block, subject)).toMatch(/declined/i)
        // The remedy has to be reachable from BOTH states — there is nothing
        // to "raise" when no budget was ever granted.
        expect(block).toContain('grants or raises the budget')
        expect(block).toMatch(/on-chain budget/i)
      })
    }

    it('says explicitly that nobody reviews an over-budget payment', () => {
      // The single most load-bearing sentence in the rewrite: an operator's
      // wrong belief here is a funding decision, not a wording preference.
      const block = renderConsentBlock(input, computeConsentHash(input))
      expect(block).toContain('it is not queued, and no one is asked to review it')
    })

    it('pins the closing paragraph EXACTLY, with nothing appended after it', () => {
      // Review of #2086 demonstrated the hole this closes: every other
      // assertion here is substring-shaped, so appending
      // "...unless the wallet owner has manual review switched on for large
      // payments." right after the pinned true sentence left all 23 tests
      // green. A re-introduced backstop does not have to REPLACE the correct
      // copy — it can simply follow it, and a keyword list can always be
      // out-worded ("manual review", "flag for", "sign-off").
      //
      // So the paragraph is pinned by exact value AND anchored to the line
      // that must come next, which is what makes appending detectable at all.
      const closing = [
        'Anything above the on-chain budget is declined before any money',
        'moves — it is not queued, and no one is asked to review it. If the',
        'agent needs more room, the wallet owner grants or raises the budget',
        'in Haven. Revoking the agent on-chain disables every MCP tool that',
        'would spend.',
      ].join('\n')
      for (const subject of [input, { ...input, allowanceSummary: [] }]) {
        const block = renderConsentBlock(subject, computeConsentHash(subject))
        expect(block).toContain(`${closing}\n\nConsent hash: `)
      }
    })

    it('the shipped README shows the copy the gate actually prints', () => {
      // packages/mcp/package.json ships README.md on npm, and its
      // "first-launch consent" section reproduces the block as an example —
      // so it is operator-facing copy that drifts silently. It DID drift:
      // review of #2086 found it still showing "On-chain allowance (the real
      // spend gate, Safe AllowanceModule)" after the renderer had moved on.
      // Nothing checked it, so nothing said so.
      //
      // Pinning the two load-bearing sentences rather than the whole block:
      // the README example is deliberately abridged (elided tool list, fake
      // hash), so exact equality would fail for reasons that are not drift.
      const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
      expect(readme).toContain('On-chain budget (the real spend gate')
      expect(readme).toContain('it is not queued, and no one is asked to review it')
      // The SAME vocabulary the gate is held to — see HUMAN_BACKSTOP_PATTERNS.
      for (const pattern of HUMAN_BACKSTOP_PATTERNS) {
        expect(readme).not.toMatch(pattern)
      }
    })

    it('does not change the consent hash — prose is not hashed', () => {
      // The hash covers identity + tool names + allowance summary, never the
      // rendered text (`computeConsentHash`). This is why re-basing the copy
      // does NOT invalidate existing HAVEN_MCP_ACK values or sidecar acks, and
      // why the frontend's pre-computed hash (lib/mcp-consent-hash.ts) needs
      // no matching change. Pinned so a future refactor that folds prose into
      // the hash has to argue with a test instead of silently re-prompting
      // every operator.
      const before = computeConsentHash(input)
      const rendered = renderConsentBlock(input, before)
      expect(rendered).toContain(before)
      expect(computeConsentHash(input)).toBe(before)
      expect(computeConsentHash({ ...input, allowanceSummary: [] })).not.toBe(before)
    })
  })

  it('uses credential allowance snapshot when live allowances are not available yet', async () => {
    const seedAllowance = [{ token: 'USDC', amount: '25000000', resetMinutes: 1440 }]
    const haven = {
      getAllowances: async () => {
        throw new Error('not active yet')
      },
    }

    const built = await consentInputFromClient(
      haven as never,
      {
        apiKey: 'sk_agent_abcdef',
        agentId: 'agent-1',
        safeAddress: '0xSafe',
        delegateAddress: '0xDelegate',
        chainId: 100,
        allowanceSummary: seedAllowance,
      },
      ['haven_get_agent'],
    )

    expect(built.allowanceSummary).toEqual(seedAllowance)
    expect(built.delegateAddress).toBe('0xDelegate')
    expect(built.chainId).toBe(100)
  })

  it('uses a successful empty live allowance list instead of the setup snapshot', async () => {
    const seedAllowance = [{ token: 'USDC', amount: '25000000', resetMinutes: 1440 }]
    const haven = {
      getAllowances: async () => ({
        safeAddress: '0xSafeLive',
        delegateAddress: '0xDelegateLive',
        chainId: 100,
        allowances: [],
      }),
    }

    const built = await consentInputFromClient(
      haven as never,
      {
        apiKey: 'sk_agent_abcdef',
        safeAddress: '0xSafe',
        delegateAddress: '0xDelegate',
        chainId: 100,
        allowanceSummary: seedAllowance,
      },
      ['haven_get_agent'],
    )

    expect(built.allowanceSummary).toEqual([])
    expect(built.safeAddress).toBe('0xSafeLive')
    expect(built.delegateAddress).toBe('0xDelegateLive')
  })

  it('binds consent to live on-chain allowance instead of configured metadata', async () => {
    const haven = {
      getAllowances: async () => ({
        safeAddress: '0xSafe',
        delegateAddress: '0xDelegate',
        chainId: 100,
        allowances: [
          {
            tokenSymbol: 'USDC',
            configuredAmount: '25000000',
            resetPeriodMin: 1440,
            onchain: {
              amount: '5000000',
              resetTimeMin: 60,
            },
          },
        ],
      }),
    }

    const built = await consentInputFromClient(
      haven as never,
      {
        apiKey: 'sk_agent_abcdef',
        safeAddress: '0xSafe',
        delegateAddress: '0xDelegate',
        chainId: 100,
        allowanceSummary: [{ token: 'USDC', amount: '25000000', resetMinutes: 1440 }],
      },
      ['haven_get_agent'],
    )

    expect(built.allowanceSummary).toEqual([
      { token: 'USDC', amount: '5000000', resetMinutes: 60 },
    ])
  })
})

describe('consent block — empty allowance', () => {
  let originalEnv: NodeJS.ProcessEnv

  beforeEach(() => {
    originalEnv = { ...process.env }
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('explains what happens when no budget is configured', () => {
    // #2086: this asserted 'manual approval' — the gate told an operator with
    // NO budget that payments would queue for a human. They are declined
    // on-chain; there is no queue and no human.
    const withoutAllowance: ConsentInput = { ...input, allowanceSummary: [] }
    const hash = computeConsentHash(withoutAllowance)
    const block = renderConsentBlock(withoutAllowance, hash)
    expect(block).toContain('On-chain budget: none configured')
    expect(block).toContain('every payment it attempts is declined on-chain')
  })
})
