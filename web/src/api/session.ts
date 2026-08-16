import { apiRequest, setCsrfToken } from './client'
import { setActivityTimeZone } from '@/domain/time'
import type { Session } from '@/types/domain'

export async function getSession(): Promise<Session> {
  const session = await apiRequest<Session>('/api/session')
  setCsrfToken(session.csrf_token)
  setActivityTimeZone(session.time_zone)
  return session
}
