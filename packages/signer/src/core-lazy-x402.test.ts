import { describe, expect, it, vi } from 'vitest'
import { HavenSigningError } from '@haven_ai/sdk/edge'
import { loadX402Schemes } from './core.js'

// #3173: `x402/schemes` is loaded on first merchant-header use. A broken
// install used to fail at process start, where the connector doctor sees it;
// now it must surface as a structured refusal naming the doctor — never as
// an UNKNOWN_ERROR after the funding leg was already signed.
vi.mock('x402/schemes', () => {
  throw new Error("Cannot find module 'x402/schemes'")
})

describe('lazy x402/schemes load (#3173)', () => {
  it('a load failure is a HavenSigningError that names the connector doctor and says nothing was sent', async () => {
    await expect(loadX402Schemes()).rejects.toBeInstanceOf(HavenSigningError)
    await expect(loadX402Schemes()).rejects.toThrow(/npx @haven_ai\/connect --doctor/)
    await expect(loadX402Schemes()).rejects.toThrow(/nothing was sent to the merchant/)
  })
})
