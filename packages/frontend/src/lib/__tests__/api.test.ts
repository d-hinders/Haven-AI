import { describe, it, expect, vi, beforeEach } from 'vitest'
import { api, ApiRequestError } from '@/lib/api'

describe('ApiClient', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
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
          'Content-Type': 'application/json',
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
  })
})
