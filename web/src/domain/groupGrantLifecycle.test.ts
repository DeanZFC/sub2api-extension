import { describe, expect, it } from 'vitest'
import { groupGrantLifecycleStatus } from './groupGrantLifecycle'
import type { GroupGrantRule } from '@/types/domain'

const now = new Date('2026-08-09T08:00:00.000Z')

function rule(overrides: Partial<GroupGrantRule> = {}): GroupGrantRule {
  return {
    id: '1',
    name: '狂欢资格',
    group_id: 5,
    enabled: true,
    assignment_mode: 'claim',
    activity_description: '',
    revoke_when_ineligible: false,
    condition: { type: 'group', operator: 'and', children: [] },
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
    ...overrides
  }
}

describe('group grant lifecycle status', () => {
  it('covers the application and revocation lifecycle', () => {
    expect(groupGrantLifecycleStatus(rule({
      activity_starts_at: '2026-08-10T00:00:00.000Z'
    }), now)).toBe('upcoming')
    expect(groupGrantLifecycleStatus(rule({
      activity_ends_at: '2026-08-10T00:00:00.000Z'
    }), now)).toBe('active')
    expect(groupGrantLifecycleStatus(rule({
      activity_ends_at: '2026-08-08T00:00:00.000Z'
    }), now)).toBe('activity_ended')
    expect(groupGrantLifecycleStatus(rule({
      activity_ends_at: '2026-08-08T00:00:00.000Z',
      revoke_at: '2026-08-10T00:00:00.000Z'
    }), now)).toBe('pending_revoke')
    expect(groupGrantLifecycleStatus(rule({
      activity_ends_at: '2026-08-08T00:00:00.000Z',
      revoke_at: '2026-08-09T07:00:00.000Z'
    }), now)).toBe('revoking')
  })

  it('shows successful and failed revocation results', () => {
    const execution = {
      id: '3', rule_id: '1', group_id: 5, mode: 'expire' as const,
      status: 'succeeded' as const, scanned_count: 1, eligible_count: 0,
      managed_count: 0, preexisting_count: 0, granted_count: 0,
      revoked_count: 1, unchanged_count: 0, failed_count: 0,
      started_at: '2026-08-09T07:10:00.000Z'
    }
    expect(groupGrantLifecycleStatus(rule({
      activity_ends_at: '2026-08-08T00:00:00.000Z',
      revoke_at: '2026-08-09T07:00:00.000Z',
      last_execution: execution
    }), now)).toBe('revoked')
    expect(groupGrantLifecycleStatus(rule({
      activity_ends_at: '2026-08-08T00:00:00.000Z',
      revoke_at: '2026-08-09T07:00:00.000Z',
      last_execution: { ...execution, status: 'failed', failed_count: 1 }
    }), now)).toBe('revoke_failed')
  })

  it('keeps an ordinary disabled rule distinct from a revoked rule', () => {
    expect(groupGrantLifecycleStatus(rule({ enabled: false }), now)).toBe('disabled')
  })
})
