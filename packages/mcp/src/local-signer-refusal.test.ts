/**
 * #4825 — on a `--local` install, no result names a signer tool.
 *
 * The local MCP registers no signing tool: its instructions say it "signs
 * in-process with the delegate key it holds" (`server.ts`), and the connector's
 * local mode REMOVES the signer server on every runtime that supports local
 * mode (`packages/connect/src/runtime-install.ts`,
 * `packages/connect/src/config-writers.ts`). Before this change five result
 * sites handed the agent to `mcp__haven-signer__haven_sign`, a tool that is not
 * in the local tool list and whose server the connector deleted.
 *
 * This file drives all five sites and holds the invariant the issue states:
 * every `next_tool` the local MCP can emit is a name in its own tool list, and
 * the signer namespace appears nowhere in `tools.ts`.
 *
 * The five sites:
 *   1. `haven_open_task_budget` — now refuses (TASK_BUDGET_SIGNING_UNAVAILABLE).
 *   2. `haven_close_task_budget` on a budget that needs a signature — refuses.
 *   3. `haven_get_agent`'s `pendingSubBudgetSignatures[]` rows.
 *   4. `haven_submit { sub_budget_id }` on success, when the tree's other row is
 *      pending.
 *   5. `haven_submit { sub_budget_id }` on `CLOSE_NEEDS_REPREPARE`.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { HavenApiError, type HavenClient } from '@haven_ai/sdk'
import { createToolHandlers, toolSchemas } from './tools.js'

const SIG = `0x${'ab'.repeat(65)}`
const PARENT_CHILD = '11111111-1111-4111-8111-111111111111'
const GRANT = '22222222-2222-4222-8222-222222222222'

const LOCAL_TOOL_NAMES = Object.keys(toolSchemas)

function pendingRow(id: string) {
  return {
    subBudgetId: id,
    parentSubBudgetId: id === PARENT_CHILD ? null : PARENT_CHILD,
    purpose: 'open',
    what: id === PARENT_CHILD ? 'parent-child' : 'grant',
    subAgentId: id === PARENT_CHILD ? null : 'agent-b',
    tokenAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    recipientAddress: null,
    periodAmountAtomic: '500000',
    expiresAt: 4102444800,
    isExpired: false,
  }
}

/** A client that answers only what the five sites need, and fails loudly otherwise. */
function stubHaven(overrides: Record<string, unknown> = {}): HavenClient {
  const base = {
    getTaskBudget: vi.fn(async () => ({
      id: 'tb_1',
      status: 'open',
      isExpired: false,
      isLive: true,
      openedAt: '2026-11-01T00:00:00Z',
      closedAt: null,
    })),
    openTaskBudget: vi.fn(async () => {
      throw new Error('the local haven_open_task_budget reached openTaskBudget')
    }),
    closeTaskBudget: vi.fn(async () => {
      throw new Error('the local haven_close_task_budget reached closeTaskBudget')
    }),
    getAgentSummary: vi.fn(async () => ({ id: 'agt_1', pendingSubBudgetSignatures: [pendingRow(GRANT)] })),
    submitSubBudget: vi.fn(async (id: string) => ({
      subBudget: { id, status: 'open', parentSubBudgetId: id === PARENT_CHILD ? null : PARENT_CHILD },
      status: 'open',
    })),
    listPendingSubBudgetSignatures: vi.fn(async () => [pendingRow(GRANT)]),
    closeSubBudget: vi.fn(async () => ({ subBudget: { id: GRANT, status: 'closing' }, signData: {} })),
    withRequestContext: async (_ctx: unknown, run: () => Promise<unknown>) => run(),
    clientUpdate: () => undefined,
    ...overrides,
  }
  return base as unknown as HavenClient
}

/** Every `next_tool` a payload carries, at the top level and on each pending row. */
function nextToolsIn(payload: unknown): string[] {
  const out: string[] = []
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item)
      return
    }
    if (!value || typeof value !== 'object') return
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key === 'next_tool' && typeof child === 'string') out.push(child)
      else visit(child)
    }
  }
  visit(payload)
  return out
}

describe('#4825 — the local MCP emits no signer tool name', () => {
  it('the local tool list has no signing tool at all (the scan\'s reproduction)', () => {
    expect(LOCAL_TOOL_NAMES.filter((name) => name.includes('sign'))).toEqual([])
  })

  it('tools.ts names no signer tool (git grep -c "mcp__haven-signer__" is 0)', () => {
    const source = readFileSync(new URL('./tools.ts', import.meta.url), 'utf8')
    expect(source.match(/mcp__haven-signer__/g) ?? []).toEqual([])
  })

  it('drives all five sites: every next_tool is a name in the local tool list', async () => {
    const sites: Array<{ site: string; payload: unknown }> = []

    // 1. haven_open_task_budget — refuses, no next tool.
    sites.push({
      site: 'haven_open_task_budget',
      payload: await createToolHandlers(stubHaven()).haven_open_task_budget({
        max_amount_human: '5',
        ttl_minutes: 60,
      }),
    })

    // 2. haven_close_task_budget on an OPEN budget — refuses, no next tool.
    sites.push({
      site: 'haven_close_task_budget',
      payload: await createToolHandlers(stubHaven()).haven_close_task_budget({ task_budget_id: 'tb_1' }),
    })

    // 3. haven_get_agent's pendingSubBudgetSignatures[] rows.
    sites.push({
      site: 'haven_get_agent',
      payload: await createToolHandlers(stubHaven()).haven_get_agent({}),
    })

    // 4. haven_submit { sub_budget_id } on success, sibling row pending.
    sites.push({
      site: 'haven_submit (sibling pending)',
      payload: await createToolHandlers(stubHaven()).haven_submit({ sub_budget_id: PARENT_CHILD, signature: SIG }),
    })

    // 5. haven_submit { sub_budget_id } on CLOSE_NEEDS_REPREPARE.
    sites.push({
      site: 'haven_submit (close_needs_reprepare)',
      payload: await createToolHandlers(
        stubHaven({
          submitSubBudget: vi.fn(async () => {
            throw new HavenApiError('close_needs_reprepare', 409, { error_code: 'close_needs_reprepare' })
          }),
        }),
      ).haven_submit({ sub_budget_id: GRANT, signature: SIG }),
    })

    expect(sites).toHaveLength(5)
    for (const { site, payload } of sites) {
      // The signer namespace appears nowhere, in any field.
      expect(JSON.stringify(payload), site).not.toContain('mcp__haven-signer__')
      for (const name of nextToolsIn(payload)) {
        expect(LOCAL_TOOL_NAMES, `${site} names ${name}`).toContain(name)
      }
    }

    // Anti-vacuity: the walker does find a next_tool where one exists, and the
    // sites that hand off name none.
    expect(nextToolsIn(sites[2].payload)).toEqual([])
    expect(nextToolsIn(sites[3].payload)).toEqual([])
    expect(nextToolsIn(sites[4].payload)).toEqual([])
    expect(nextToolsIn({ next_tool: 'haven_get_agent' })).toEqual(['haven_get_agent'])
  })

  it('the two task-budget refusals carry the typed code and a reason, not a next tool', async () => {
    const open = await createToolHandlers(stubHaven()).haven_open_task_budget({
      max_amount_human: '5',
      ttl_minutes: 60,
    })
    const close = await createToolHandlers(stubHaven()).haven_close_task_budget({ task_budget_id: 'tb_1' })
    for (const payload of [open, close]) {
      expect(payload).toMatchObject({
        success: false,
        code: 'TASK_BUDGET_SIGNING_UNAVAILABLE',
        next_action: 'stop_and_tell_user',
      })
      const failure = payload as { next_tool?: string; next_tool_omitted_reason?: string }
      expect(failure.next_tool).toBeUndefined()
      expect(failure.next_tool_omitted_reason).toMatch(/hosted MCP install/)
    }
  })
})
