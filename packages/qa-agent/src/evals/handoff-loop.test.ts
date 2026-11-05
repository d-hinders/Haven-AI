/**
 * #4682 — the hand-off loop, and the leak boundary it must hold.
 *
 * `claude-code.ts` runs one prompt per task and records no `session_id`, so a
 * run that stops at a human hand-off cannot continue. The loop here is the
 * spike's answer: run a turn, detect the hand-off, let the stand-in perform it,
 * resume the SAME session.
 *
 * The leak fixtures are the second half of the issue's acceptance: none of the
 * stand-in's values may enter the agent's prompt, child environment, tool
 * stream or final result. `assertNoStandInValues` is a runtime guard, so the
 * test exercises the same code the loop runs.
 */

import { describe, expect, it } from 'vitest'
import {
  assertNoStandInValues,
  detectHandoff,
  runWithHandoffs,
  turnText,
  type Handoff,
} from './handoff-loop.js'
import type { AgentRunLog } from './types.js'
import { buildChildEnv, buildColdChildEnv, parseClaudeCodeStreamLog } from './claude-code.js'
import { CONNECT_ALLOW_ENV } from './command-tool.js'

const INVENTORY = [
  { name: 'stand_in_owner_key', value: '0xownerkeydeadbeef' },
  { name: 'stand_in_signup_password', value: 'Qa-supersecretpassword' },
  { name: 'stand_in_signup_token', value: 'signup-token-abc' },
  { name: 'stand_in_device_user_code', value: 'ABCD-1234' },
  { name: 'stand_in_approval_authority', value: 'signup-token-abc' },
]

function log(partial: Partial<AgentRunLog>): AgentRunLog {
  return { taskId: 'spike', trial: 1, calls: [], ...partial }
}

describe('detectHandoff', () => {
  it('reads a device link out of the agent text', () => {
    const h = detectHandoff('Open https://app.example/device?code=ABCD-1234 and approve it.')
    expect(h).toEqual({ kind: 'device-login', userCode: 'ABCD-1234', url: '/device?code=ABCD-1234' })
  })

  it('reads "approve the code X" prose', () => {
    expect(detectHandoff('Please approve the code WXYZ-9876 in your dashboard.')).toEqual({
      kind: 'device-login',
      userCode: 'WXYZ-9876',
    })
  })

  it('reads a budget-approval link', () => {
    const h = detectHandoff('Approve the budget at https://app.example/agents?setup=11111111-2222-3333-4444-555555555555')
    expect(h?.kind).toBe('budget-approval')
    expect(h?.setupId).toBe('11111111-2222-3333-4444-555555555555')
  })

  it('does not mistake a transaction hash for a hand-off', () => {
    expect(detectHandoff('The payment settled: 0x9f2c4a1b7e3d5f6081a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708')).toBeNull()
  })

  it('returns null for a plain completion message', () => {
    expect(detectHandoff('Done — the payment settled and the receipt is attached.')).toBeNull()
  })
})

describe('turnText', () => {
  it('includes the final message and the raw stream when the adapter kept it', () => {
    const text = turnText(
      log({ finalMessage: 'I need you to approve something.' }),
      '{"type":"user","message":{"content":[{"type":"tool_result","content":[{"type":"text","text":"open /device?code=ABCD-1234"}]}]}}',
    )
    expect(text).toContain('I need you to approve something.')
    expect(text).toContain('/device?code=ABCD-1234')
  })

  it('falls back to the final message when there is no raw stream', () => {
    expect(turnText(log({ finalMessage: 'done' }))).toBe('done')
  })
})

describe('assertNoStandInValues — fail-closed', () => {
  it('refuses a message carrying any inventory value', () => {
    expect(() => assertNoStandInValues('the token is signup-token-abc', INVENTORY)).toThrow(
      'the resume message carries the stand-in value stand_in_signup_token',
    )
  })

  it('allows a message that carries none', () => {
    expect(() => assertNoStandInValues('The human approved the device login.', INVENTORY)).not.toThrow()
  })
})

describe('runWithHandoffs', () => {
  function harness(turns: AgentRunLog[]) {
    const prompts: string[] = []
    const resumes: Array<string | undefined> = []
    const performed: string[] = []
    let index = 0
    return {
      prompts,
      resumes,
      performed,
      options: {
        instruction: 'Set it all up so my agent can pay for things.',
        inventory: INVENTORY,
        standIn: {
          async approveDeviceLogin(userCode: string) {
            performed.push(`device:${userCode}`)
            return { status: 'approved' }
          },
          async approveBudget() {
            performed.push('budget')
            return { delegationHash: '0xdeadbeef', budgetAtomic: '2500000', periodSeconds: 86_400 }
          },
        },
        async runTurn(instruction: string, opts: { resumeSessionId?: string }) {
          prompts.push(instruction)
          resumes.push(opts.resumeSessionId)
          const next = turns[index++]
          if (!next) throw new Error('the loop ran more turns than the fixture provides')
          return { log: next, session: { sessionId: 'session-1' } }
        },
      },
    }
  }

  it('performs the device hand-off and resumes the same session', async () => {
    const h = harness([
      log({ finalMessage: 'Open https://app.example/device?code=ABCD-1234 and approve it.' }),
      log({ finalMessage: 'Signed in. Now run the connector.' }),
    ])
    const result = await runWithHandoffs(h.options)
    expect(h.performed).toEqual(['device:ABCD-1234'])
    expect(h.resumes).toEqual([undefined, 'session-1'])
    expect(result.handoffs.map((x: Handoff) => x.kind)).toEqual(['device-login'])
    expect(result.stoppedBecause).toBe('the turn asked for no hand-off')
    expect(result.turns).toHaveLength(2)
  })

  it('performs both hand-offs in order and resumes each time', async () => {
    const h = harness([
      log({ finalMessage: 'Approve the code ABCD-1234.' }),
      log({ finalMessage: 'Now approve the budget at https://app.example/agents?setup=11111111-2222-3333-4444-555555555555' }),
      log({ finalMessage: 'The payment settled: 0xabc.' }),
    ])
    const result = await runWithHandoffs(h.options)
    expect(h.performed).toEqual(['device:ABCD-1234', 'budget'])
    expect(h.resumes).toEqual([undefined, 'session-1', 'session-1'])
    expect(result.handoffs.map((x) => x.kind)).toEqual(['device-login', 'budget-approval'])
    expect(result.finalMessage).toContain('settled')
  })

  it('stops when the agent asks for the same hand-off twice', async () => {
    const h = harness([
      log({ finalMessage: 'Approve the code ABCD-1234.' }),
      log({ finalMessage: 'Approve the code ABCD-1234.' }),
    ])
    const result = await runWithHandoffs(h.options)
    expect(h.performed).toEqual(['device:ABCD-1234'])
    expect(result.stoppedBecause).toContain('twice')
  })

  it('stops at the hand-off budget instead of looping forever', async () => {
    const h = harness([
      log({ finalMessage: 'Approve the code ABCD-1234.' }),
      log({ finalMessage: 'Approve the budget at https://app.example/agents?setup=11111111-2222-3333-4444-555555555555' }),
    ])
    const result = await runWithHandoffs({ ...h.options, maxHandoffs: 1 })
    expect(h.performed).toEqual(['device:ABCD-1234'])
    expect(result.stoppedBecause).toContain('hand-off budget (1)')
  })

  it('refuses a resume message that would carry a stand-in value', async () => {
    const h = harness([log({ finalMessage: 'Approve the code ABCD-1234.' })])
    await expect(
      runWithHandoffs({
        ...h.options,
        resumeMessage: () => 'approved with signup-token-abc',
      }),
    ).rejects.toThrow('refusing to send it')
  })

  it('never puts a stand-in value into the prompt it sends', async () => {
    const h = harness([
      log({ finalMessage: 'Approve the code ABCD-1234.' }),
      log({ finalMessage: 'Approve the budget at https://app.example/agents?setup=11111111-2222-3333-4444-555555555555' }),
      log({ finalMessage: 'settled' }),
    ])
    await runWithHandoffs(h.options)
    for (const prompt of h.prompts) {
      for (const entry of INVENTORY) {
        // The user code is the agent's OWN hand-off, so it may appear in the
        // agent's text; the stand-in's secrets may not appear in a prompt.
        if (entry.name === 'stand_in_device_user_code') continue
        expect(prompt).not.toContain(entry.value)
      }
    }
  })
})

// ── The per-turn tool profile (#4682 round 2) ───────────────────────────────
//
// The docs claimed the loop sets `QA_EVAL_COMMAND_ALLOW_CONNECT=1` on the
// post-login turns, but nothing did. These pin the wiring: the flag is absent
// on the turn BEFORE the device hand-off and present on the turn after it.

describe('the per-turn tool profile', () => {
  it('sets QA_EVAL_COMMAND_ALLOW_CONNECT only AFTER the device hand-off', async () => {
    const envs: Array<Record<string, string> | undefined> = []
    const turns = [
      log({ finalMessage: 'Open https://app.example/device?code=ABCD-1234 and approve it.' }),
      log({ finalMessage: 'Signed in. Now run the connector.' }),
    ]
    let index = 0
    await runWithHandoffs({
      instruction: 'Set it all up so my agent can pay for things.',
      inventory: INVENTORY,
      trialEnv: { QA_EVAL_TRIAL_HOME: '/tmp/trial' },
      standIn: {
        async approveDeviceLogin() {
          return { status: 'approved' }
        },
        async approveBudget() {
          return { delegationHash: '0xdeadbeef', budgetAtomic: '2500000', periodSeconds: 86_400 }
        },
      },
      async runTurn(_instruction: string, opts: { resumeSessionId?: string; trialEnv?: Record<string, string> }) {
        envs.push(opts.trialEnv)
        const next = turns[index++]
        if (!next) throw new Error('the loop ran more turns than the fixture provides')
        return { log: next, session: { sessionId: 'session-1' } }
      },
    })

    expect(envs).toHaveLength(2)
    // Turn 1 is BEFORE the wall: the trial env rides along, the flag does not.
    expect(envs[0]).toEqual({ QA_EVAL_TRIAL_HOME: '/tmp/trial' })
    expect(envs[0]?.[CONNECT_ALLOW_ENV]).toBeUndefined()
    // Turn 2 is after the device hand-off: `agents connect` is now allowed.
    expect(envs[1]).toEqual({ QA_EVAL_TRIAL_HOME: '/tmp/trial', [CONNECT_ALLOW_ENV]: '1' })
  })

  it('does not set the flag when the run never reaches a device hand-off', async () => {
    const envs: Array<Record<string, string> | undefined> = []
    await runWithHandoffs({
      instruction: 'Set it all up.',
      inventory: INVENTORY,
      standIn: {
        async approveDeviceLogin() {
          return { status: 'approved' }
        },
        async approveBudget() {
          return { delegationHash: '0xdeadbeef', budgetAtomic: '2500000', periodSeconds: 86_400 }
        },
      },
      async runTurn(_instruction: string, opts: { resumeSessionId?: string; trialEnv?: Record<string, string> }) {
        envs.push(opts.trialEnv)
        return { log: log({ finalMessage: 'I could not find a way in.' }), session: { sessionId: 'session-1' } }
      },
    })
    expect(envs).toEqual([undefined])
  })
})

// ── The leak fixtures: prompt, child environment, tool stream, final result ──
//
// The issue's acceptance is explicit: fixtures prove none of the stand-in's
// values enter the agent's prompt, child environment, tool stream or final
// result. The prompt and the resume message are covered above; these cover the
// environment and the recorded stream.

describe('the leak boundary (#4682)', () => {
  it('the child env the adapter builds carries none of the stand-in values', () => {
    // A hostile base env: every stand-in value present under a plausible name.
    const base: NodeJS.ProcessEnv = { PATH: '/usr/bin', HOME: '/tmp' }
    for (const entry of INVENTORY) base[entry.name.toUpperCase()] = entry.value
    const env = buildChildEnv(base)
    const values = Object.values(env)
    for (const entry of INVENTORY) expect(values).not.toContain(entry.value)
  })

  it('the cold child env strips them even when the allowlist would keep the name', () => {
    const base: NodeJS.ProcessEnv = { PATH: '/usr/bin', HOME: '/tmp' }
    for (const entry of INVENTORY) base[entry.name.toUpperCase()] = entry.value
    const env = buildColdChildEnv(base, { HOME: '/tmp/trial-home' })
    const values = Object.values(env)
    for (const entry of INVENTORY) expect(values).not.toContain(entry.value)
  })

  it('a recorded stream that never echoed a stand-in value parses to a log that carries none', () => {
    const raw = [
      '{"type":"system","subtype":"init","session_id":"s-1"}',
      '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tu_1","name":"run_command","input":{"argv":["npx","@haven_ai/cli@dev","login","--json","--no-wait"]}}]}}',
      '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu_1","content":[{"type":"text","text":"open https://app.example/device?code=ABCD-1234"}]}]}}',
      '{"type":"result","subtype":"success","result":"I need you to approve the login."}',
    ].join('\n')
    const { log } = parseClaudeCodeStreamLog(raw, { taskId: 'spike', trial: 1 })
    const text = turnText(log, raw)
    // The agent's OWN hand-off (the user code) is expected; the stand-in's
    // secrets are not.
    for (const entry of INVENTORY) {
      if (entry.name === 'stand_in_device_user_code') continue
      expect(text).not.toContain(entry.value)
    }
  })
})
