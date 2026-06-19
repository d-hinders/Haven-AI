import { mkdtemp, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createSessionStore } from './session.js'

const SESSION = {
  token: 'jwt-abc',
  apiBaseUrl: 'https://api.haven.example',
  user: { id: 'u1', email: 'ada@example.com', name: 'Ada' },
}

describe('session store', () => {
  it('saves owner-only and round-trips', async () => {
    const home = await mkdtemp(join(tmpdir(), 'haven-cli-session-'))
    const store = createSessionStore(home)

    expect(await store.load()).toBeNull()
    await store.save(SESSION)
    expect(await store.load()).toEqual(SESSION)

    const mode = (await stat(store.path)).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('clears the session', async () => {
    const home = await mkdtemp(join(tmpdir(), 'haven-cli-session-'))
    const store = createSessionStore(home)
    await store.save(SESSION)
    await store.clear()
    expect(await store.load()).toBeNull()
  })

  it('treats a malformed file as no session', async () => {
    const home = await mkdtemp(join(tmpdir(), 'haven-cli-session-'))
    const store = createSessionStore(home)
    await store.save({ ...SESSION, token: '' })
    expect(await store.load()).toBeNull()
  })
})
