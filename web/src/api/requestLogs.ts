import { apiRequest } from './client'
import type { RequestLogPage } from '@/types/domain'

export interface RequestLogFilters {
  page?: number
  page_size?: number
  path?: string
  ip?: string
  user_id?: number
  outcome?: 'all' | 'blocked' | 'error' | 'rate_limited'
}

export function getRequestLogs(filters: RequestLogFilters = {}): Promise<RequestLogPage> {
  return apiRequest('/api/admin/request-logs', { query: { ...filters } })
}
