import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ApiError,
  apiRequest,
  clearEmbeddedSession,
  initializeEmbeddedSession,
  setCsrfToken
} from './client'

afterEach(() => {
  clearEmbeddedSession()
  vi.unstubAllGlobals()
  setCsrfToken()
})

describe('apiRequest', () => {
  it('unwraps data and sends the CSRF token on mutations', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: { id: 'lottery-1' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    )
    vi.stubGlobal('fetch', fetchMock)
    setCsrfToken('csrf-value')

    const result = await apiRequest<{ id: string }>('/api/admin/lotteries', {
      method: 'POST',
      body: { name: '七月抽奖' }
    })

    expect(result.id).toBe('lottery-1')
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit
    expect(new Headers(request.headers).get('X-CSRF-Token')).toBe('csrf-value')
    expect(request.credentials).toBe('include')
  })

  it('raises a structured API error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { code: 'LOTTERY_LOCKED', message: '名单已锁定' } }), {
          status: 409
        })
      )
    )

    await expect(apiRequest('/api/admin/lotteries/1', { method: 'DELETE' })).rejects.toMatchObject<
      Partial<ApiError>
    >({ status: 409, code: 'LOTTERY_LOCKED', message: '名单已锁定' })
  })

  it('consumes a local embedded session handoff and sends it as a request header', async () => {
    const sessionToken = 'a'.repeat(43)
    const values = new Map<string, string>()
    const sessionStorage = {
      get length() { return values.size },
      clear: () => values.clear(),
      getItem: (key: string) => values.get(key) ?? null,
      key: (index: number) => [...values.keys()][index] ?? null,
      removeItem: (key: string) => values.delete(key),
      setItem: (key: string, value: string) => values.set(key, value)
    } satisfies Storage
    const replaceState = vi.fn()
    vi.stubGlobal('window', {
      location: {
        hash: `#ext_session=${sessionToken}&source=menu`,
        pathname: '/',
        search: '?theme=light'
      },
      history: { state: null, replaceState },
      sessionStorage
    })
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: { authenticated: true } }), { status: 200 })
    )
    vi.stubGlobal('fetch', fetchMock)

    initializeEmbeddedSession()
    await apiRequest('/api/session')

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit
    expect(new Headers(request.headers).get('Authorization')).toBe(`Session ${sessionToken}`)
    expect(replaceState).toHaveBeenCalledWith(null, '', '/?theme=light#source=menu')
    expect(sessionStorage.getItem('sub2api_extension_embedded_session')).toBe(sessionToken)
  })
})
