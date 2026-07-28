// Unit coverage for the passport reference attached to an erc7710 settle
// response (#976). The route-level tests in `routes/__tests__/x402-delegation.test.ts`
// exercise the same function through Fastify, and review found two things they
// structurally cannot reach:
//
//  1. `verify_url` was invisible to the suite — the only assertion used
//     `toContain('/passport/verify?uid=…')`, so the BASE was never checked and
//     neither branch of the URL decision had a test.
//  2. The `!row` clause survived deletion. Removing it makes `row.status` throw
//     on `undefined`, the total try/catch converts that to `null`, and the
//     route test asserting `passport === null` still passes. A safeguard whose
//     deletion no test notices is not covered, it is coincidentally green.
//
// (2) is why `log` exists on the options bag: the error path now has an
// observable that the normal-absence path does not, so the two `null`s can be
// told apart here.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const { mockFindByAgent, mockSigningConfigured } = vi.hoisted(() => ({
  mockFindByAgent: vi.fn(),
  mockSigningConfigured: vi.fn(),
}))
vi.mock('../../../infra/repositories/agent-passports.js', () => ({
  findByAgent: mockFindByAgent,
}))
vi.mock('../receipt.js', () => ({
  isReceiptSigningConfigured: mockSigningConfigured,
}))

const { passportReferenceFor } = await import('../x402-delivery.js')

const UID = '0x' + 'ab'.repeat(32)
const anchored = (over: Record<string, unknown> = {}) => ({
  agent_id: 'agent-1',
  chain_id: 84532,
  status: 'anchored',
  attestation_uid: UID,
  ...over,
})

let log: { warn: ReturnType<typeof vi.fn> }
const saved = { haven: process.env.HAVEN_API_URL, publicUrl: process.env.PUBLIC_API_URL }

beforeEach(() => {
  vi.clearAllMocks()
  log = { warn: vi.fn() }
  process.env.HAVEN_API_URL = 'https://api.haven.example'
  delete process.env.PUBLIC_API_URL
  mockSigningConfigured.mockReturnValue(true)
})

afterEach(() => {
  if (saved.haven === undefined) delete process.env.HAVEN_API_URL
  else process.env.HAVEN_API_URL = saved.haven
  if (saved.publicUrl === undefined) delete process.env.PUBLIC_API_URL
  else process.env.PUBLIC_API_URL = saved.publicUrl
})

describe('passportReferenceFor — what is looked up', () => {
  it('queries the agent it was given', async () => {
    mockFindByAgent.mockResolvedValue(anchored())
    await passportReferenceFor('agent-1', { log })
    expect(mockFindByAgent).toHaveBeenCalledWith('agent-1', undefined)
  })

  it('passes an explicit executor through, so it can join a caller transaction', async () => {
    const db = { query: vi.fn() }
    mockFindByAgent.mockResolvedValue(anchored())
    await passportReferenceFor('agent-1', { db: db as never, log })
    expect(mockFindByAgent).toHaveBeenCalledWith('agent-1', db)
  })
})

describe('passportReferenceFor — absence vs. failure', () => {
  // The distinction this whole describe exists for: both produce `null`, and
  // only one is a problem. Before the log line they were indistinguishable
  // from outside the process AND from inside a test.
  it('returns null WITHOUT logging when the agent simply has no passport', async () => {
    mockFindByAgent.mockResolvedValue(undefined)
    expect(await passportReferenceFor('agent-1', { log })).toBeNull()
    // Deleting the `!row ||` guard makes `row.status` throw here, the catch
    // converts it to the same null, and this assertion is what notices.
    expect(log.warn).not.toHaveBeenCalled()
  })

  it.each([
    ['pending, UID already present', anchored({ status: 'pending' })],
    ['failed, UID already present', anchored({ status: 'failed' })],
  ])('returns null WITHOUT logging for a %s passport', async (_name, row) => {
    // Each fixture differs from the anchored one in exactly the status, so it
    // pins the `status !== 'anchored'` clause on its own. A non-anchored
    // passport is deliberately indistinguishable from none: a reference a
    // merchant cannot resolve produces a failed lookup that reads as a REVOKED
    // agent, which is worse than saying nothing.
    mockFindByAgent.mockResolvedValue(row)
    expect(await passportReferenceFor('agent-1', { log })).toBeNull()
    expect(log.warn).not.toHaveBeenCalled()
  })

  it('returns null AND logs when the lookup throws', async () => {
    mockFindByAgent.mockRejectedValue(new Error('db down'))
    expect(await passportReferenceFor('agent-1', { log })).toBeNull()
    expect(log.warn).toHaveBeenCalledTimes(1)
    expect(log.warn.mock.calls[0][0]).toMatchObject({ err: 'db down', agent_id: 'agent-1' })
  })

  it('still returns null when no logger is supplied', async () => {
    // The logger is optional and must not become a second failure mode: this is
    // the money path, and `opts.log?.warn` throwing would defeat the try/catch
    // it lives inside.
    mockFindByAgent.mockRejectedValue(new Error('db down'))
    expect(await passportReferenceFor('agent-1')).toBeNull()
  })
})

describe('verify_url is emitted only when it can be honest', () => {
  it('is built from the CONFIGURED base, never from a request', async () => {
    // The reference travels to a merchant by way of the agent. An earlier
    // version fell back to `${x-forwarded-proto}://${host}` — raw request
    // headers on a Fastify instance without `trustProxy` — which let the
    // caller choose the host of a URL that still looked server-issued. The
    // function no longer takes a request at all, which is the strongest form
    // of this test: the input does not exist.
    mockFindByAgent.mockResolvedValue(anchored())
    const ref = await passportReferenceFor('agent-1', { log })
    expect(ref?.verify_url).toBe(`https://api.haven.example/passport/verify?uid=${UID}`)
  })

  it('trims a trailing slash rather than emitting a double slash', async () => {
    process.env.HAVEN_API_URL = 'https://api.haven.example/'
    mockFindByAgent.mockResolvedValue(anchored())
    const ref = await passportReferenceFor('agent-1', { log })
    expect(ref?.verify_url).toBe(`https://api.haven.example/passport/verify?uid=${UID}`)
  })

  it('falls back to PUBLIC_API_URL, the documented legacy alias', async () => {
    delete process.env.HAVEN_API_URL
    process.env.PUBLIC_API_URL = 'https://legacy.haven.example'
    mockFindByAgent.mockResolvedValue(anchored())
    const ref = await passportReferenceFor('agent-1', { log })
    expect(ref?.verify_url).toBe(`https://legacy.haven.example/passport/verify?uid=${UID}`)
  })

  it('is OMITTED when no base URL is configured — the reference still ships', async () => {
    delete process.env.HAVEN_API_URL
    delete process.env.PUBLIC_API_URL
    mockFindByAgent.mockResolvedValue(anchored())
    const ref = await passportReferenceFor('agent-1', { log })
    expect(ref).toEqual({ attestation_uid: UID, chain_id: 84532 })
    expect(ref).not.toHaveProperty('verify_url')
  })

  it('is OMITTED when the verifier is switched off, even with a base URL', async () => {
    // `PASSPORT_RECEIPT_SIGNING_KEY` is independent of the schema UID that lets
    // issuance anchor, so a deployment really can hold anchored passports while
    // `GET /passport/verify` 503s. A link that always fails is worse than no
    // link: absence is a documented normal answer, a dead link reads as a
    // broken or fraudulent agent.
    mockSigningConfigured.mockReturnValue(false)
    mockFindByAgent.mockResolvedValue(anchored())
    const ref = await passportReferenceFor('agent-1', { log })
    expect(ref).toEqual({ attestation_uid: UID, chain_id: 84532 })
  })

  it('never omits the UID or chain id — those are the part a merchant verifies', async () => {
    // The degradation must be the CONVENIENCE, not the substance. A merchant
    // resolves `attestation_uid` + `chain_id` against a verifier it already
    // pins, or against EAS directly; dropping either would leave the reference
    // useless while still looking present.
    delete process.env.HAVEN_API_URL
    mockSigningConfigured.mockReturnValue(false)
    mockFindByAgent.mockResolvedValue(anchored())
    const ref = await passportReferenceFor('agent-1', { log })
    expect(ref?.attestation_uid).toBe(UID)
    expect(ref?.chain_id).toBe(84532)
  })
})
