import { apiRequest } from './client'
import { normalizePage } from './collection'
import type { ActivityType, PageResult, UserActivity } from '@/types/domain'

export async function getActivities(): Promise<PageResult<UserActivity>> {
  const result = await apiRequest<UserActivity[] | PageResult<UserActivity>>('/api/activities')
  return normalizePage(result)
}

export function getActivity(type: ActivityType, id: string): Promise<UserActivity> {
  return apiRequest(`/api/activities/${encodeURIComponent(type)}/${encodeURIComponent(id)}`)
}

export function participateInActivity(type: ActivityType, id: string): Promise<UserActivity> {
  return apiRequest(
    `/api/activities/${encodeURIComponent(type)}/${encodeURIComponent(id)}/participate`,
    { method: 'POST' }
  )
}
