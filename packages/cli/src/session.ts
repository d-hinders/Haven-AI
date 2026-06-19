import { mkdir, readFile, rm, writeFile, chmod } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * The signed-in user session. The token is a *user* JWT (same credential the
 * dashboard holds) — treat it like a secret: stored owner-only, never logged,
 * never sent anywhere but the Haven API. `apiBaseUrl` is pinned at login so
 * later commands talk to the same backend.
 */
export interface Session {
  token: string
  apiBaseUrl: string
  user: { id: string; email: string; name: string | null }
}

export interface SessionStore {
  load(): Promise<Session | null>
  save(session: Session): Promise<void>
  clear(): Promise<void>
  path: string
}

function sessionDir(homeDir: string): string {
  return resolve(homeDir, '.haven')
}

export function sessionPath(homeDir: string = homedir()): string {
  return join(sessionDir(homeDir), 'session.json')
}

/** File-backed session store, owner-only perms (0600 file in a 0700 dir). */
export function createSessionStore(homeDir: string = homedir()): SessionStore {
  const path = sessionPath(homeDir)
  return {
    path,
    async load() {
      try {
        const raw = await readFile(path, 'utf8')
        const parsed = JSON.parse(raw) as Partial<Session>
        if (!parsed.token || !parsed.apiBaseUrl || !parsed.user) return null
        return parsed as Session
      } catch {
        return null
      }
    },
    async save(session) {
      await mkdir(sessionDir(homeDir), { recursive: true, mode: 0o700 })
      await writeFile(path, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 })
      await chmod(path, 0o600).catch(() => undefined)
    },
    async clear() {
      await rm(path, { force: true })
    },
  }
}
