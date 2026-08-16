import { afterEach, describe, expect, it, vi } from 'vitest'
import { completeOutboxJob, retryOutboxJob } from './lotteries'

function ok(data: unknown): Response {
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('fulfillment task APIs', () => {
  it('uses the retry and manual completion endpoints', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(ok({ id: '73', status: 'pending' })))
    vi.stubGlobal('fetch', fetchMock)

    await retryOutboxJob('73')
    await completeOutboxJob('74', 'shipment-20260731')

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/admin/outbox/73/retry')
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'POST' })
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/admin/outbox/74/complete')
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      external_ref: 'shipment-20260731'
    })
  })
})
