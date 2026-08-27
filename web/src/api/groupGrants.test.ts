import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createGroupGrantRule,
  deleteGroupGrantRule,
  executeGroupGrantRule,
  getGroupGrantExecutions,
  getGroupGrantRules,
  getSub2ApiGroups,
  previewGroupGrantRule,
  revokeGroupGrantRule,
  updateGroupGrantRule
} from './groupGrants'
import type { GroupGrantRuleInput } from '@/types/domain'

const condition = { type: 'group' as const, operator: 'and' as const, children: [] }

function ok(data: unknown): Response {
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  })
}

function rule(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 7,
    name: '充值用户狂欢授权',
    group_id: '12',
    group: { id: '12', name: '狂欢分组' },
    enabled: true,
    activity_ends_at: '2026-08-01T00:00:00.000Z',
    revoke_at: '2026-08-02T00:00:00.000Z',
    concurrency_limit: 3,
    condition,
    managed_count: 3,
    preexisting_count: 2,
    last_executed_at: '2026-07-31T03:00:00.000Z',
    created_at: '2026-07-31T00:00:00.000Z',
    updated_at: '2026-07-31T00:00:00.000Z',
    ...overrides
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('group grant APIs', () => {
  it('normalizes Sub2API groups and rule summaries', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() =>
        Promise.resolve(
          ok({
            items: [
              {
                id: '12',
                name: '狂欢分组',
                rate_multiplier: 0.8,
                is_exclusive: true,
                status: 'active',
                rule_id: '7',
                rule_enabled: true
              }
            ],
            total: 1
          })
        )
      )
      .mockImplementationOnce(() => Promise.resolve(ok({ items: [rule()], total: 1 })))
    vi.stubGlobal('fetch', fetchMock)

    const groups = await getSub2ApiGroups()
    const rules = await getGroupGrantRules()

    expect(groups[0]).toMatchObject({
      id: 12,
      name: '狂欢分组',
      multiplier: 0.8,
      exclusive: true,
      rule_id: '7'
    })
    expect(rules.items[0]).toMatchObject({
      id: '7',
      group_id: 12,
      group_name: '狂欢分组',
      revoke_at: '2026-08-02T00:00:00.000Z',
      concurrency_limit: 3,
      revoke_when_ineligible: true
    })
    expect(rules.items[0]?.last_execution).toMatchObject({
      managed_count: 3,
      preexisting_count: 2
    })
  })

  it('uses the rule create and update endpoints', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(ok(rule())))
    vi.stubGlobal('fetch', fetchMock)
    const input: GroupGrantRuleInput = {
      name: '充值用户狂欢授权',
      group_id: 12,
      enabled: true,
      revoke_when_ineligible: false,
      concurrency_limit: 3,
      condition
    }

    await createGroupGrantRule(input)
    await updateGroupGrantRule('rule/7', input)
    await deleteGroupGrantRule('rule/7')
    await revokeGroupGrantRule('rule/7')

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/admin/group-grants/rules')
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'POST' })
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual(input)
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/admin/group-grants/rules/rule%2F7')
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: 'PUT' })
    expect(fetchMock.mock.calls[2]?.[0]).toBe('/api/admin/group-grants/rules/rule%2F7')
    expect(fetchMock.mock.calls[2]?.[1]).toMatchObject({ method: 'DELETE' })
    expect(fetchMock.mock.calls[3]?.[0]).toBe('/api/admin/group-grants/rules/rule%2F7/revoke')
    expect(fetchMock.mock.calls[3]?.[1]).toMatchObject({ method: 'POST' })
  })

  it('normalizes preview, execution and run statistics', async () => {
    const summary = {
      run_id: 19,
      rule_id: '7',
      group_id: '12',
      mode: 'preview',
      status: 'partial',
      total: 20,
      eligible_count: 9,
      grant_count: 4,
      revoke_count: 1,
      managed_count: 3,
      preexisting_count: 2,
      unchanged_count: 10,
      error_count: 1,
      started_at: '2026-07-31T04:00:00.000Z'
    }
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => Promise.resolve(ok(summary)))
      .mockImplementationOnce(() => Promise.resolve(ok({ ...summary, mode: 'execute' })))
      .mockImplementationOnce(() => Promise.resolve(ok({ items: [summary], total: 1 })))
    vi.stubGlobal('fetch', fetchMock)

    const preview = await previewGroupGrantRule('7')
    const execution = await executeGroupGrantRule('7')
    const runs = await getGroupGrantExecutions('7')

    expect(preview).toMatchObject({
      scanned_count: 20,
      eligible_count: 9,
      granted_count: 4,
      revoked_count: 1,
      failed_count: 1
    })
    expect(execution).toMatchObject({ id: '19', mode: 'execute', status: 'partial' })
    expect(runs.items[0]).toMatchObject({
      mode: 'preview',
      managed_count: 3,
      preexisting_count: 2,
      failed_count: 1
    })
    expect(fetchMock.mock.calls[2]?.[0]).toBe('/api/admin/group-grants/runs?rule_id=7')
  })
})
