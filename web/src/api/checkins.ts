import { apiRequest } from './client'
import { normalizePage } from './collection'
import type { CheckinCampaign, CheckinCampaignInput, PageResult } from '@/types/domain'

const BASE_PATH = '/api/admin/checkins'

export async function getCheckins(): Promise<PageResult<CheckinCampaign>> {
  const result = await apiRequest<CheckinCampaign[] | PageResult<CheckinCampaign>>(BASE_PATH)
  return normalizePage(result)
}

export function createCheckin(input: CheckinCampaignInput): Promise<CheckinCampaign> {
  return apiRequest(BASE_PATH, { method: 'POST', body: input })
}

export function updateCheckin(id: string, input: CheckinCampaignInput): Promise<CheckinCampaign> {
  return apiRequest(`${BASE_PATH}/${encodeURIComponent(id)}`, { method: 'PUT', body: input })
}

export function deleteCheckin(id: string): Promise<void> {
  return apiRequest(`${BASE_PATH}/${encodeURIComponent(id)}`, { method: 'DELETE' })
}
