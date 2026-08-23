/**
 * #1923 — the two "remove this budget row" controls must sit on the SAME icon
 * rung.
 *
 * They diverged (12 px in `EditAgentModal`, 14 px in `haven/AgentBudgetCard`)
 * because the design system enforces SET MEMBERSHIP and not WHICH RUNG — both
 * values are on the scale, so `design:lint` was green over the divergence and
 * always will be. `docs/product/design-system.md` § 5 → Size says plainly that
 * no gate can make that judgement; this file is the narrow exception that can,
 * because here the judgement is already made and only needs holding: one
 * decision (14), two call sites, rendered rather than grepped.
 *
 * Rendered, not source-scanned, deliberately — a regex over the file would pass
 * on a `className` the component never puts on the glyph.
 *
 * The explicit timeouts below are not padding for a slow machine. Rendering
 * `EditAgentModal` costs ~4 s here, against vitest's 5 s default — close enough
 * that the design review of #1923 watched this file's first test flake once and
 * then pass at 3937 ms. Evidence that intermittently fails is not evidence, and
 * this test is the ONLY rendered proof of the `EditAgentModal` call site (no
 * screenshot scenario opens that modal's budget list), so the ceiling is stated
 * rather than inherited.
 */
import { render, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const { SAFE_ADDRESS, SIGNER_ADDRESS } = vi.hoisted(() => ({
  SAFE_ADDRESS: '0x1111111111111111111111111111111111111111',
  SIGNER_ADDRESS: '0x3333333333333333333333333333333333333333',
}))

vi.mock('wagmi', () => ({
  usePublicClient: () => ({}),
  useAccount: () => ({ isConnected: true, chain: { id: 100 } }),
  useSwitchChain: () => ({ switchChain: vi.fn(), isPending: false, error: null }),
}))

vi.mock('@/lib/signer', () => ({
  useActiveSigner: () => ({ type: 'eoa', address: SIGNER_ADDRESS }),
  isSafeCapableSigner: (s: { type?: string } | null) => s !== null && s.type !== 'delegator_passkey',
}))

vi.mock('@/hooks/useSafeOperationGate', () => ({
  useSafeOperationGate: () => ({ kind: 'ready' }),
}))

vi.mock('@/lib/safe-tx', () => ({
  getSafeNonce: vi.fn(),
  signSafeTx: vi.fn(),
  executeSafeTx: vi.fn(),
  proposeSafeTx: vi.fn(),
  getSafeTxHash: vi.fn(),
  getChainTokens: () => ({
    xDAI: { symbol: 'xDAI', decimals: 18, address: null },
    EURe: { symbol: 'EURe', decimals: 18, address: '0xcB444e90D8198415266c6a2724b7900fb12FC56E' },
  }),
}))

import EditAgentModal from '../EditAgentModal'
import { AgentBudgetCard } from '../haven/AgentBudgetCard'
import type { Agent } from '@/hooks/useAgents'

/** The rung both controls are converged on (#1923). 14 px = `h-3.5 w-3.5`. */
const RUNG = 'h-3.5 w-3.5'

const EURE = '0xcB444e90D8198415266c6a2724b7900fb12FC56E'

const AGENT: Agent = {
  id: 'agent-1',
  name: 'Food',
  description: 'Foodie',
  delegate_address: '0x2222222222222222222222222222222222222222',
  safe_id: 'safe-1',
  safe_address: SAFE_ADDRESS,
  safe_name: 'Operating wallet',
  safe_chain_id: 100,
  api_key_prefix: 'sk_agent_abc',
  status: 'active',
  created_at: '2026-05-01T00:00:00Z',
  allowances: [
    {
      id: 'allowance-1',
      agent_id: 'agent-1',
      token_address: EURE,
      token_symbol: 'EURe',
      allowance_amount: '2000000000000000000',
      reset_period_min: 1440,
    },
  ],
}

/** The glyph a button renders, as the class list actually on the `<svg>`. */
function glyphClassOf(button: HTMLElement): string {
  const svg = button.querySelector('svg')
  expect(svg, 'the remove control renders a glyph').not.toBeNull()
  return svg!.getAttribute('class') ?? ''
}

// Both helpers query INSIDE their own render container: the third test renders
// both components into the same document, where a document-wide
// `getByRole(name)` would find two matches and throw.
function renderEditAgentModalRemoveButton(): HTMLElement {
  const { container } = render(
    <EditAgentModal
      open
      onClose={vi.fn()}
      agent={AGENT}
      safeAddress={SAFE_ADDRESS}
      chainId={100}
      safeDetails={{ address: SAFE_ADDRESS, owners: [SIGNER_ADDRESS], threshold: 1, nonce: 1 }}
      existingOnChainAllowances={[
        {
          token: EURE,
          amount: 2000000000000000000n,
          spent: 0n,
          resetTimeMin: 1440,
          lastResetMin: 0,
          nonce: 1,
        },
      ]}
      onUpdated={vi.fn()}
    />,
  )
  return within(container).getByRole('button', { name: 'Remove EURe budget' })
}

function renderAgentBudgetCardRemoveButton(): HTMLElement {
  const { container } = render(
    <AgentBudgetCard
      agentName="Food"
      budgets={[{ id: 'b1', tokenSymbol: 'EURe', amount: '2', period: 'per day' }]}
      onRemoveBudget={vi.fn()}
    />,
  )
  return within(container).getByRole('button', { name: 'Remove EURe budget' })
}

describe('#1923 — the remove-budget controls share one icon rung', () => {
  it(
    "EditAgentModal's remove-budget glyph is on the 14 px rung",
    () => {
      expect(glyphClassOf(renderEditAgentModalRemoveButton())).toContain(RUNG)
    },
    20_000,
  )

  it("AgentBudgetCard's remove-budget glyph is on the 14 px rung", () => {
    expect(glyphClassOf(renderAgentBudgetCardRemoveButton())).toContain(RUNG)
  })

  it('the two remove-budget glyphs agree with each other', () => {
    // The assertion that would have caught the original defect: it fails on a
    // divergence even if a future decision moves BOTH to another rung, so it
    // outlives the specific number above.
    const sizeOf = (cls: string) => cls.match(/\bh-[\d.]+ w-[\d.]+\b/)?.[0] ?? cls
    const inModal = sizeOf(glyphClassOf(renderEditAgentModalRemoveButton()))
    const inCard = sizeOf(glyphClassOf(renderAgentBudgetCardRemoveButton()))
    expect(inModal).toBe(inCard)
  }, 20_000)
})
