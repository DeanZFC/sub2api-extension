import type { GroupGrantRule } from '@/types/domain'

export type GroupGrantLifecycleStatus =
  | 'upcoming'
  | 'active'
  | 'activity_ended'
  | 'pending_revoke'
  | 'revoking'
  | 'revoked'
  | 'revoke_failed'
  | 'disabled'

export function groupGrantLifecycleStatus(
  rule: GroupGrantRule,
  now: number | Date = Date.now()
): GroupGrantLifecycleStatus {
  const currentTime = now instanceof Date ? now.getTime() : now
  const execution = currentRevocationExecution(rule)

  if (execution?.status === 'failed' || execution?.status === 'partial') {
    return 'revoke_failed'
  }
  if (!rule.enabled) {
    return execution?.status === 'succeeded' ? 'revoked' : 'disabled'
  }

  const startsAt = timestamp(rule.activity_starts_at)
  if (startsAt !== null && startsAt > currentTime) return 'upcoming'

  const endsAt = timestamp(rule.activity_ends_at)
  if (endsAt === null || endsAt > currentTime) return 'active'

  const revokeAt = timestamp(rule.revoke_at)
  if (revokeAt === null) return 'activity_ended'
  if (revokeAt > currentTime) return 'pending_revoke'
  if (execution?.status === 'succeeded') return 'revoked'
  return 'revoking'
}

function currentRevocationExecution(rule: GroupGrantRule) {
  const execution = rule.last_execution
  if (!execution || !['expire', 'revoke'].includes(execution.mode)) return null
  const executedAt = timestamp(execution.started_at)
  const ruleUpdatedAt = timestamp(rule.updated_at)
  if (executedAt === null || (ruleUpdatedAt !== null && executedAt < ruleUpdatedAt)) return null
  return execution
}

function timestamp(value?: string | null): number | null {
  if (!value) return null
  const result = new Date(value).getTime()
  return Number.isFinite(result) ? result : null
}
