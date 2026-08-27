import { apiRequest } from './client'
import { normalizePage } from './collection'
import type {
  ConditionNode,
  GroupGrantExecution,
  GroupGrantExecutionStatus,
  GroupGrantPreview,
  GroupGrantRule,
  GroupGrantRuleInput,
  GroupGrantStats,
  PageResult,
  Sub2ApiGroup
} from '@/types/domain'

const BASE_PATH = '/api/admin/group-grants'
const emptyCondition: ConditionNode = { type: 'group', operator: 'and', children: [] }

type UnknownRecord = Record<string, unknown>

function record(value: unknown): UnknownRecord {
  return value && typeof value === 'object' ? (value as UnknownRecord) : {}
}

function numberValue(...values: unknown[]): number {
  const value = values.find((candidate) => Number.isFinite(Number(candidate)))
  return value === undefined ? 0 : Number(value)
}

function stringValue(...values: unknown[]): string {
  const value = values.find(
    (candidate) => typeof candidate === 'string' && candidate.trim().length > 0
  )
  return typeof value === 'string' ? value : ''
}

function idValue(...values: unknown[]): string {
  const value = values.find(
    (candidate) =>
      typeof candidate === 'number' ||
      (typeof candidate === 'string' && candidate.trim().length > 0)
  )
  return value === undefined ? '' : String(value)
}

function statsFrom(value: unknown): GroupGrantStats {
  const source = record(value)
  const stats = { ...source, ...record(source.stats) }
  const managedCount = numberValue(stats.managed_count, stats.managed)
  const preexistingCount = numberValue(stats.preexisting_count, stats.preexisting)
  const grantedCount = numberValue(
    stats.granted_count,
    stats.grant_count,
    stats.granted,
    stats.to_grant_count
  )
  const revokedCount = numberValue(
    stats.revoked_count,
    stats.revoke_count,
    stats.revoked,
    stats.to_revoke_count
  )
  const unchangedCount = numberValue(stats.unchanged_count, stats.unchanged)
  const failedCount = numberValue(stats.failed_count, stats.error_count, stats.failed)
  const derivedScanned =
    managedCount + preexistingCount + grantedCount + revokedCount + unchangedCount + failedCount
  return {
    scanned_count: numberValue(
      stats.scanned_count,
      stats.scanned_users,
      stats.scanned,
      stats.total,
      derivedScanned
    ),
    eligible_count: numberValue(stats.eligible_count, stats.matched_count, stats.eligible),
    managed_count: managedCount,
    preexisting_count: preexistingCount,
    granted_count: grantedCount,
    revoked_count: revokedCount,
    unchanged_count: unchangedCount,
    failed_count: failedCount
  }
}

function normalizeStatus(value: unknown): GroupGrantExecutionStatus {
  if (value === 'running' || value === 'partial' || value === 'failed') return value
  return 'succeeded'
}

export function normalizeSub2ApiGroup(value: unknown): Sub2ApiGroup {
  const source = record(value)
  const multiplierSource = source.multiplier ?? source.rate_multiplier
  const multiplier = Number(multiplierSource)
  return {
    id: numberValue(source.id),
    name: stringValue(source.name),
    ...(multiplierSource !== undefined && Number.isFinite(multiplier) ? { multiplier } : {}),
    exclusive: Boolean(source.exclusive ?? source.is_exclusive),
    status: source.status === 'inactive' ? 'inactive' : 'active',
    ...(stringValue(source.subscription_type)
      ? { subscription_type: stringValue(source.subscription_type) }
      : {}),
    ...(source.rule_id !== undefined && source.rule_id !== null
      ? { rule_id: idValue(source.rule_id) }
      : {}),
    ...(source.rule_enabled !== undefined ? { rule_enabled: Boolean(source.rule_enabled) } : {})
  }
}

export function normalizeGroupGrantExecution(value: unknown): GroupGrantExecution {
  const source = record(value)
  return {
    id: idValue(source.id, source.run_id),
    rule_id: idValue(source.rule_id),
    ...(stringValue(source.rule_name) ? { rule_name: stringValue(source.rule_name) } : {}),
    group_id: numberValue(source.group_id),
    ...(stringValue(source.group_name) ? { group_name: stringValue(source.group_name) } : {}),
    mode:
      source.mode === 'preview' || source.mode === 'revoke' || source.mode === 'expire'
        ? source.mode
        : 'execute',
    status: normalizeStatus(source.status),
    ...statsFrom(source),
    ...(stringValue(source.error, source.last_error)
      ? { error: stringValue(source.error, source.last_error) }
      : {}),
    started_at: stringValue(source.started_at, source.created_at),
    ...(stringValue(source.completed_at, source.finished_at)
      ? { completed_at: stringValue(source.completed_at, source.finished_at) }
      : {})
  }
}

export function normalizeGroupGrantRule(value: unknown): GroupGrantRule {
  const source = record(value)
  const group = record(source.group)
  const ruleId = idValue(source.id)
  const groupId = numberValue(source.group_id, group.id)
  const groupName = stringValue(source.group_name, group.name)
  const lastExecutedAt = stringValue(source.last_executed_at)
  return {
    id: ruleId,
    name: stringValue(source.name, groupName, `分组 #${groupId}`),
    group_id: groupId,
    ...(groupName ? { group_name: groupName } : {}),
    enabled: Boolean(source.enabled),
    assignment_mode: 'claim',
    activity_description: stringValue(source.activity_description),
    activity_starts_at: stringValue(source.activity_starts_at) || null,
    activity_ends_at: stringValue(source.activity_ends_at) || null,
    revoke_at: stringValue(source.revoke_at) || null,
    concurrency_limit:
      source.concurrency_limit === undefined || source.concurrency_limit === null || source.concurrency_limit === ''
        ? null
        : numberValue(source.concurrency_limit),
    revoke_when_ineligible:
      source.revoke_when_ineligible === undefined
        ? true
        : Boolean(source.revoke_when_ineligible),
    condition: (source.condition || source.rule || emptyCondition) as ConditionNode,
    ...(source.last_execution
      ? { last_execution: normalizeGroupGrantExecution(source.last_execution) }
      : lastExecutedAt
        ? {
            last_execution: normalizeGroupGrantExecution({
              id: `latest-${ruleId}`,
              rule_id: ruleId,
              group_id: groupId,
              status: 'succeeded',
              managed_count: source.managed_count,
              preexisting_count: source.preexisting_count,
              started_at: lastExecutedAt,
              completed_at: lastExecutedAt
            })
          }
      : {}),
    created_at: stringValue(source.created_at),
    updated_at: stringValue(source.updated_at)
  }
}

export async function getSub2ApiGroups(): Promise<Sub2ApiGroup[]> {
  const result = await apiRequest<unknown[] | PageResult<unknown>>(`${BASE_PATH}/groups`)
  return normalizePage(result).items.map(normalizeSub2ApiGroup)
}

export async function getGroupGrantRules(): Promise<PageResult<GroupGrantRule>> {
  const result = await apiRequest<unknown[] | PageResult<unknown>>(`${BASE_PATH}/rules`)
  const page = normalizePage(result)
  return { ...page, items: page.items.map(normalizeGroupGrantRule) }
}

export async function createGroupGrantRule(input: GroupGrantRuleInput): Promise<GroupGrantRule> {
  const result = await apiRequest<unknown>(`${BASE_PATH}/rules`, { method: 'POST', body: input })
  return normalizeGroupGrantRule(result)
}

export async function updateGroupGrantRule(
  id: string,
  input: GroupGrantRuleInput
): Promise<GroupGrantRule> {
  const result = await apiRequest<unknown>(`${BASE_PATH}/rules/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: input
  })
  return normalizeGroupGrantRule(result)
}

export function deleteGroupGrantRule(id: string): Promise<void> {
  return apiRequest(`${BASE_PATH}/rules/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export async function revokeGroupGrantRule(id: string): Promise<GroupGrantExecution> {
  const result = await apiRequest<unknown>(
    `${BASE_PATH}/rules/${encodeURIComponent(id)}/revoke`,
    { method: 'POST' }
  )
  return normalizeGroupGrantExecution(result)
}

export async function previewGroupGrantRule(id: string): Promise<GroupGrantPreview> {
  const result = await apiRequest<unknown>(
    `${BASE_PATH}/rules/${encodeURIComponent(id)}/preview`,
    { method: 'POST' }
  )
  const source = record(result)
  return {
    rule_id: idValue(source.rule_id, id),
    ...statsFrom(source),
    ...(stringValue(source.generated_at, source.created_at)
      ? { generated_at: stringValue(source.generated_at, source.created_at) }
      : {})
  }
}

export async function executeGroupGrantRule(id: string): Promise<GroupGrantExecution> {
  const result = await apiRequest<unknown>(
    `${BASE_PATH}/rules/${encodeURIComponent(id)}/execute`,
    { method: 'POST' }
  )
  return normalizeGroupGrantExecution(result)
}

export async function getGroupGrantExecutions(
  ruleId?: string
): Promise<PageResult<GroupGrantExecution>> {
  const result = await apiRequest<unknown[] | PageResult<unknown>>(`${BASE_PATH}/runs`, {
    ...(ruleId ? { query: { rule_id: ruleId } } : {})
  })
  const page = normalizePage(result)
  return { ...page, items: page.items.map(normalizeGroupGrantExecution) }
}
