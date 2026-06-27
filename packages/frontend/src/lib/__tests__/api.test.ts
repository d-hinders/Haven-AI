import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { api, ApiRequestError } from '@/lib/api'

describe('ApiClient', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
    localStorage.clear()
    window.history.replaceState({}, '', '/')
    // The ?apiBaseUrl override is gated to non-production (see #582). Tests that
    // exercise the override opt into a dev env; the rest run as production.
    vi.stubEnv('NEXT_PUBLIC_HAVEN_ENV', 'dev')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  function mockFetchOk(data: unknown) {
    ;(fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(data),
    })
  }

  function mockFetchError(status: number, body: { error: string }) {
    ;(fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status,
      json: () => Promise.resolve(body),
    })
  }

  describe('get()', () => {
    it('calls fetch with correct URL and auth header when token exists', async () => {
      localStorage.setItem('haven_token', 'test-token')
      mockFetchOk({ id: 1 })

      const result = await api.get('/users')

      expect(fetch).toHaveBeenCalledWith('/api/users', {
        headers: {
          Authorization: 'Bearer test-token',
        },
      })
      expect(result).toEqual({ id: 1 })
    })

    it('omits Authorization header when no token in localStorage', async () => {
      mockFetchOk({ id: 1 })

      await api.get('/users')

      const callArgs = (fetch as ReturnType<typeof vi.fn>).mock.calls[0]
      expect(callArgs[1].headers).not.toHaveProperty('Authorization')
    })

    it('uses apiBaseUrl query param override and persists it', async () => {
      mockFetchOk({ id: 1 })
      window.history.replaceState({}, '', '/?apiBaseUrl=https%3A%2F%2Fbranch-backend.example')

      await api.get('/users')

      expect(fetch).toHaveBeenCalledWith('https://branch-backend.example/users', {
        headers: {},
      })
      expect(localStorage.getItem('haven_api_base_url')).toBe('https://branch-backend.example')
    })

    it('uses persisted backend override when present', async () => {
      mockFetchOk({ id: 1 })
      localStorage.setItem('haven_api_base_url', 'https://branch-backend.example/')

      await api.get('/users')

      expect(fetch).toHaveBeenCalledWith('https://branch-backend.example/users', {
        headers: {},
      })
    })
  })

  describe('post()', () => {
    it('sends JSON body with correct method', async () => {
      mockFetchOk({ created: true })

      const result = await api.post('/agents', { name: 'test' })

      expect(fetch).toHaveBeenCalledWith('/api/agents', {
        method: 'POST',
        body: JSON.stringify({ name: 'test' }),
        headers: {
          'Content-Type': 'application/json',
        },
      })
      expect(result).toEqual({ created: true })
    })

    it('omits JSON content type when called without a body', async () => {
      mockFetchOk({ rejected: true })

      const result = await api.post('/approvals/1/reject')

      expect(fetch).toHaveBeenCalledWith('/api/approvals/1/reject', {
        method: 'POST',
        body: undefined,
        headers: {},
      })
      expect(result).toEqual({ rejected: true })
    })
  })

  describe('put()', () => {
    it('sends JSON body with PUT method', async () => {
      mockFetchOk({ updated: true })

      const result = await api.put('/agents/1', { name: 'updated' })

      expect(fetch).toHaveBeenCalledWith('/api/agents/1', {
        method: 'PUT',
        body: JSON.stringify({ name: 'updated' }),
        headers: {
          'Content-Type': 'application/json',
        },
      })
      expect(result).toEqual({ updated: true })
    })
  })

  describe('delete()', () => {
    it('omits JSON content type for bodyless delete requests', async () => {
      mockFetchOk({ success: true })

      const result = await api.delete('/agents/1')

      expect(fetch).toHaveBeenCalledWith('/api/agents/1', {
        method: 'DELETE',
        headers: {},
      })
      expect(result).toEqual({ success: true })
    })
  })

  describe('error handling', () => {
    it('throws ApiRequestError with correct status and message on non-ok response', async () => {
      mockFetchError(403, { error: 'Forbidden' })

      await expect(api.get('/secret')).rejects.toThrow(ApiRequestError)

      try {
        await api.get('/secret')
      } catch (err) {
        expect(err).toBeInstanceOf(ApiRequestError)
        expect((err as ApiRequestError).message).toBe('Forbidden')
        expect((err as ApiRequestError).status).toBe(403)
      }
    })

    it('clears the persisted override when apiBaseUrl=default is provided', async () => {
      mockFetchError(403, { error: 'Forbidden' })
      localStorage.setItem('haven_api_base_url', 'https://branch-backend.example')
      window.history.replaceState({}, '', '/?apiBaseUrl=default')

      await expect(api.get('/secret')).rejects.toThrow(ApiRequestError)

      expect(fetch).toHaveBeenCalledWith('/api/secret', {
        headers: {},
      })
      expect(localStorage.getItem('haven_api_base_url')).toBeNull()
    })
  })

  describe('apiBaseUrl override gating (#582)', () => {
    it('ignores the ?apiBaseUrl query param in production', async () => {
      vi.stubEnv('NEXT_PUBLIC_HAVEN_ENV', 'production')
      localStorage.setItem('haven_token', 'test-token')
      mockFetchOk({ id: 1 })
      window.history.replaceState({}, '', '/?apiBaseUrl=https%3A%2F%2Fevil.example')

      await api.get('/users')

      // The bearer JWT must go to the baked-in base URL, never the attacker host.
      expect(fetch).toHaveBeenCalledWith('/api/users', {
        headers: { Authorization: 'Bearer test-token' },
      })
    })

    it('ignores a persisted override in production', async () => {
      vi.stubEnv('NEXT_PUBLIC_HAVEN_ENV', 'production')
      mockFetchOk({ id: 1 })
      localStorage.setItem('haven_api_base_url', 'https://evil.example')

      await api.get('/users')

      expect(fetch).toHaveBeenCalledWith('/api/users', { headers: {} })
    })

    it('ignores the override when NEXT_PUBLIC_HAVEN_ENV is unset', async () => {
      vi.stubEnv('NEXT_PUBLIC_HAVEN_ENV', '')
      mockFetchOk({ id: 1 })
      window.history.replaceState({}, '', '/?apiBaseUrl=https%3A%2F%2Fevil.example')

      await api.get('/users')

      expect(fetch).toHaveBeenCalledWith('/api/users', { headers: {} })
    })
  })
})
