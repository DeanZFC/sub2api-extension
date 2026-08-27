import { afterEach, describe, expect, it, vi } from 'vitest'
import { getActivity, participateInActivity, withdrawFromActivity } from './activities'

function ok(data: unknown): Response {
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('activity APIs', () => {
  it('uses the activity detail, participate and withdraw endpoints', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(ok({ id: '1' })))
    vi.stubGlobal('fetch', fetchMock)

    await getActivity('lottery', '1')
    await participateInActivity('lottery', '1')
    await withdrawFromActivity('lottery', '1')

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/activities/lottery/1')
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/activities/lottery/1/participate')
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: 'POST' })
    expect(fetchMock.mock.calls[2]?.[0]).toBe('/api/activities/lottery/1/participation')
    expect(fetchMock.mock.calls[2]?.[1]).toMatchObject({ method: 'DELETE' })
  })
})
