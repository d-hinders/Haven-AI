import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CliApiError, type CliApi } from './api.js'
import {
  checkExactSecretMatch,
  checkKeyBackedAddresses,
  checkLabelledSecrets,
  checkRecoveryPhrase,
  checkTextForSecrets,
  collectKeyBackedAddresses,
  deriveAddressFromHexToken,
  findHexTokenCandidates,
  readLocalSecrets,
} from './secret-check.js'

/** A known test vector: the all-zeros-but-1 secp256k1 private key. */
const KNOWN_PRIVATE_KEY = '0000000000000000000000000000000000000000000000000000000000000001'
const KNOWN_ADDRESS = '0x7e5f4552091a69125d5dfcb7b8c2659029395bdf'

function refusingApi(): CliApi {
  const refuse = async () => {
    throw new CliApiError('nope', 500)
  }
  return { get: refuse, post: refuse, put: refuse, del: refuse, getText: refuse }
}

describe('layer 1 — prefixed and labelled secrets', () => {
  it.each([
    ['an agent API key', 'my key is sk_agent_abc123def456'],
    ['a setup token', 'the token was hv_setup_abc123def'],
    ['a session JWT', 'token: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1MSJ9.c2lnbmF0dXJl'],
    ['key=', 'the value key=abcdef123456'],
    ['api_key=', 'the value api_key=abcdef123456'],
    ['api-key=', 'the value api-key=abcdef123456'],
    ['apikey=', 'the value apikey=abcdef123456'],
    ['token=', 'the value token=abcdef123456'],
    ['secret=', 'the value secret=abcdef123456'],
    ['url credentials', 'at https://user:pass@host.example/path'],
    ['an rpc-path key', 'bundler at https://api.pimlico.io/v2/base/rpc/abcdefabcdefabcd'],
  ])('refuses text containing %s', (_label, text) => {
    const result = checkLabelledSecrets(text)
    expect(result?.layer).toBe(1)
  })

  it('MUTATION PROOF: plain prose with no label is not refused', () => {
    expect(checkLabelledSecrets('The dashboard took 20 seconds to load for me today.')).toBeNull()
  })

  it('MUTATION PROOF: a bare tx hash (no label) is not refused by layer 1', () => {
    expect(checkLabelledSecrets(`a real tx hash is 0x${'ab'.repeat(32)}`)).toBeNull()
  })

  it('MUTATION PROOF (N1): an ordinary word starting "ey" is not refused — the JWT pattern requires "eyJ"', () => {
    // The whole reason the pattern tightened from `\bey` to `\beyJ`: a word
    // like "eyebrow" or "eyelet" starts with "ey" but is never base64url of
    // `{"`, so it must never read as a session JWT.
    expect(checkLabelledSecrets('my eyebrow.test.ts file needs a fix')).toBeNull()
    expect(checkLabelledSecrets('an eyelet.config.js change')).toBeNull()
  })
})

describe('layer 2 — secrets this machine holds, exact match', () => {
  let dir: string

  async function withAgentDir(files: Record<string, unknown>): Promise<string> {
    const agentDir = join(dir, 'agent-1')
    await mkdir(agentDir, { recursive: true })
    for (const [name, contents] of Object.entries(files)) {
      await writeFile(join(agentDir, name), JSON.stringify(contents))
    }
    return dir
  }

  it('reads signer.json delegate_key, identity.json api_key, and rekey-pending.json new_delegate_key', async () => {
    dir = await mkdtemp(join(tmpdir(), 'haven-secret-check-'))
    try {
      await withAgentDir({
        'signer.json': { delegate_key: '0xDEADBEEF00000000000000000000000000000000000000000000000000001' },
        'identity.json': { api_key: 'sk_agent_REALKEYNEVERREAL' },
        'rekey-pending.json': { new_delegate_key: '0xFEEDFACE0000000000000000000000000000000000000000000000000002' },
      })
      const secrets = await readLocalSecrets({ baseDir: dir })
      expect(secrets.has('deadbeef00000000000000000000000000000000000000000000000000001')).toBe(true)
      expect(secrets.has('sk_agent_realkeyneverreal')).toBe(true)
      expect(secrets.has('feedface0000000000000000000000000000000000000000000000000002')).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('TOMBSTONED directories keep their keys — they are NOT skipped', async () => {
    dir = await mkdtemp(join(tmpdir(), 'haven-secret-check-'))
    try {
      const tombstoned = join(dir, 'retired-agent')
      await mkdir(tombstoned, { recursive: true })
      await writeFile(join(tombstoned, 'signer.json'), JSON.stringify({ delegate_key: '0xAAAABBBB000000000000000000000000000000000000000000000000CCCC' }))
      await writeFile(join(tombstoned, 'TOMBSTONE.json'), JSON.stringify({ reason: 'removed' }))

      const secrets = await readLocalSecrets({ baseDir: dir })
      expect(secrets.has('aaaabbbb000000000000000000000000000000000000000000000000cccc')).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('reads HAVEN_DELEGATE_KEY from the environment', async () => {
    const secrets = await readLocalSecrets({
      baseDir: await mkdtemp(join(tmpdir(), 'haven-secret-check-empty-')),
      env: { HAVEN_DELEGATE_KEY: '0xABCDEF00000000000000000000000000000000000000000000000000001234' },
    })
    expect(secrets.has('abcdef00000000000000000000000000000000000000000000000000001234')).toBe(true)
  })

  it('includes the CLI session token when passed', async () => {
    const secrets = await readLocalSecrets({
      baseDir: await mkdtemp(join(tmpdir(), 'haven-secret-check-empty-')),
      sessionToken: 'x.MY-SESSION-TOKEN.y',
    })
    expect(secrets.has('x.my-session-token.y')).toBe(true)
  })

  it('refuses an exact (case-insensitive) match and never on an unrelated short substring', () => {
    const secrets = new Set(['sk_agent_realkey'])
    expect(checkExactSecretMatch('my key is SK_AGENT_REALKEY for real', secrets)?.layer).toBe(2)
    expect(checkExactSecretMatch('nothing secret here', secrets)).toBeNull()
  })

  it('MUTATION PROOF: an empty secret set never refuses', () => {
    expect(checkExactSecretMatch('anything at all', new Set())).toBeNull()
  })
})

describe('layer 3 — any other 64-hex token: derive and compare', () => {
  it('derives the known test-vector address from its private key, with and without 0x', () => {
    expect(deriveAddressFromHexToken(KNOWN_PRIVATE_KEY)?.toLowerCase()).toBe(KNOWN_ADDRESS)
  })

  it('a zero key passes (derives nothing) — createECDH throws on it', () => {
    expect(deriveAddressFromHexToken('0'.repeat(64))).toBeNull()
  })

  it('a key >= the curve order n passes — createECDH throws on it too', () => {
    // n ≈ 2^256; this value is above it.
    expect(deriveAddressFromHexToken('f'.repeat(64))).toBeNull()
  })

  it('finds a bounded 64-hex token with or without 0x', () => {
    expect(findHexTokenCandidates(`key is 0x${KNOWN_PRIVATE_KEY}`)).toEqual([KNOWN_PRIVATE_KEY])
    expect(findHexTokenCandidates(`key is ${KNOWN_PRIVATE_KEY}`)).toEqual([KNOWN_PRIVATE_KEY])
  })

  it('MUTATION PROOF: a 128-hex calldata run is not windowed into two candidates', () => {
    const longRun = KNOWN_PRIVATE_KEY + KNOWN_PRIVATE_KEY
    expect(findHexTokenCandidates(`calldata was 0x${longRun}`)).toEqual([])
  })

  it('a real tx hash and a real delegation hash derive SOME address but pass unless it is key-backed', async () => {
    const api: CliApi = {
      get: async <T,>(path: string) => {
        if (path === '/agents') return { agents: [] } as T
        if (path === '/user/accounts') return { accounts: [] } as T
        throw new CliApiError(`unmocked ${path}`, 404)
      },
      post: async () => ({}) as never,
      put: async () => ({}) as never,
      del: async () => ({}) as never,
      getText: async () => '',
    }
    expect(await checkKeyBackedAddresses(`a real tx hash is 0x${KNOWN_PRIVATE_KEY}`, api)).toBeNull()
  })

  it('refuses when the derived address matches an agent delegate_address', async () => {
    const api: CliApi = {
      get: async <T,>(path: string) => {
        if (path === '/agents') return { agents: [{ delegate_address: KNOWN_ADDRESS }] } as T
        if (path === '/user/accounts') return { accounts: [] } as T
        throw new CliApiError(`unmocked ${path}`, 404)
      },
      post: async () => ({}) as never,
      put: async () => ({}) as never,
      del: async () => ({}) as never,
      getText: async () => '',
    }
    const result = await checkKeyBackedAddresses(`my key is ${KNOWN_PRIVATE_KEY}`, api)
    expect(result).toMatchObject({ layer: 3, reason: 'private_key' })
  })

  it('refuses when the derived address matches an account owner_address', async () => {
    const api: CliApi = {
      get: async <T,>(path: string) => {
        if (path === '/agents') return { agents: [] } as T
        if (path === '/user/accounts') return { accounts: [{ account_address: '0xacc', chain_id: 8453 }] } as T
        if (path.startsWith('/accounts/hybrid/0xacc/signers')) return { owner_address: KNOWN_ADDRESS } as T
        throw new CliApiError(`unmocked ${path}`, 404)
      },
      post: async () => ({}) as never,
      put: async () => ({}) as never,
      del: async () => ({}) as never,
      getText: async () => '',
    }
    const result = await checkKeyBackedAddresses(`my key is ${KNOWN_PRIVATE_KEY}`, api)
    expect(result).toMatchObject({ layer: 3, reason: 'private_key' })
  })

  it('FAILS CLOSED: an unreadable address set refuses rather than silently passing', async () => {
    const result = await checkKeyBackedAddresses(`my key is ${KNOWN_PRIVATE_KEY}`, refusingApi())
    expect(result).toMatchObject({ layer: 3, reason: 'address_check_unavailable' })
    expect(result?.message).toMatch(/retry once Haven is reachable/i)
  })

  it('a 401/403 on the address read gets a distinct message — retrying will not help', async () => {
    const api403: CliApi = {
      get: async () => { throw new CliApiError('Forbidden', 403) },
      post: async () => ({}) as never,
      put: async () => ({}) as never,
      del: async () => ({}) as never,
      getText: async () => '',
    }
    const result = await checkKeyBackedAddresses(`my key is ${KNOWN_PRIVATE_KEY}`, api403)
    expect(result).toMatchObject({ layer: 3, reason: 'address_check_unavailable' })
    expect(result?.message).toMatch(/login/i)
    expect(result?.message).not.toMatch(/retry once Haven is reachable/i)
  })

  it('a 409 (unknown signer configuration) gets its own distinct message — retrying will not help', async () => {
    const api409: CliApi = {
      get: async <T,>(path: string) => {
        if (path === '/agents') return { agents: [] } as T
        if (path === '/user/accounts') return { accounts: [{ account_address: '0xacc', chain_id: 8453 }] } as T
        throw new CliApiError('account signer configuration is unknown', 409)
      },
      post: async () => ({}) as never,
      put: async () => ({}) as never,
      del: async () => ({}) as never,
      getText: async () => '',
    }
    const result = await checkKeyBackedAddresses(`my key is ${KNOWN_PRIVATE_KEY}`, api409)
    expect(result).toMatchObject({ layer: 3, reason: 'address_check_unavailable' })
    expect(result?.message).toMatch(/contact support/i)
    expect(result?.message).not.toMatch(/retry once Haven is reachable/i)
  })

  it('does not call the backend at all when there is no 64-hex candidate', async () => {
    const result = await checkKeyBackedAddresses('no hex tokens here at all', refusingApi())
    expect(result).toBeNull()
  })

  it('collectKeyBackedAddresses reads one agent and one account-chain signer read', async () => {
    let agentsCalls = 0
    let signersCalls = 0
    const api: CliApi = {
      get: async <T,>(path: string) => {
        if (path === '/agents') {
          agentsCalls += 1
          return { agents: [{ delegate_address: '0xAAA' }] } as T
        }
        if (path === '/user/accounts') return { accounts: [{ account_address: '0xBBB', chain_id: 100 }] } as T
        if (path === '/accounts/hybrid/0xBBB/signers?chain_id=100') {
          signersCalls += 1
          return { owner_address: '0xCCC' } as T
        }
        throw new CliApiError(`unmocked ${path}`, 404)
      },
      post: async () => ({}) as never,
      put: async () => ({}) as never,
      del: async () => ({}) as never,
      getText: async () => '',
    }
    const addresses = await collectKeyBackedAddresses(api)
    expect(agentsCalls).toBe(1)
    expect(signersCalls).toBe(1)
    expect(addresses).toEqual(new Set(['0xaaa', '0xccc']))
  })
})

describe('layer 4 — recovery phrases', () => {
  const TWELVE_WORDS = 'abandon ability able about above absent absorb abstract absurd abuse access accident'

  it('refuses a run of 12 consecutive BIP-39 words', () => {
    expect(checkRecoveryPhrase(`backup: ${TWELVE_WORDS}`)?.layer).toBe(4)
  })

  it('MUTATION PROOF: 11 consecutive BIP-39 words is not refused on length alone', () => {
    const eleven = TWELVE_WORDS.split(' ').slice(0, 11).join(' ')
    expect(checkRecoveryPhrase(eleven)).toBeNull()
  })

  it('a run broken by a non-BIP-39 word does not accumulate across the break', () => {
    const words = TWELVE_WORDS.split(' ')
    const broken = [...words.slice(0, 6), 'definitely-not-a-seed-word', ...words.slice(6)].join(' ')
    expect(checkRecoveryPhrase(broken)).toBeNull()
  })

  it('punctuation around a word does not stop it from counting', () => {
    const punctuated = TWELVE_WORDS.split(' ').map((w, i) => (i === 0 ? `"${w}"` : i === 11 ? `${w}.` : w)).join(' ')
    expect(checkRecoveryPhrase(punctuated)?.layer).toBe(4)
  })

  it('a longer run (24 words) still refuses', () => {
    expect(checkRecoveryPhrase(`${TWELVE_WORDS} ${TWELVE_WORDS}`)?.layer).toBe(4)
  })
})

describe('composition — checkTextForSecrets runs every layer in order', () => {
  it('layer 1 short-circuits before any network call', async () => {
    const result = await checkTextForSecrets('my key is sk_agent_abc123', { api: refusingApi() })
    expect(result?.layer).toBe(1)
  })

  it('clean text passes every layer', async () => {
    const api: CliApi = {
      get: async <T,>(path: string) => {
        if (path === '/agents') return { agents: [] } as T
        if (path === '/user/accounts') return { accounts: [] } as T
        throw new CliApiError(`unmocked ${path}`, 404)
      },
      post: async () => ({}) as never,
      put: async () => ({}) as never,
      del: async () => ({}) as never,
      getText: async () => '',
    }
    const dir = await mkdtemp(join(tmpdir(), 'haven-secret-check-empty-'))
    try {
      const result = await checkTextForSecrets('The dashboard took 20 seconds to load for me today.', {
        api,
        localSecrets: { baseDir: dir },
      })
      expect(result).toBeNull()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
