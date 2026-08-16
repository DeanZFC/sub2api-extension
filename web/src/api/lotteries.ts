import { apiRequest } from './client'
import { normalizePage } from './collection'
import type {
  FulfillmentJob,
  Lottery,
  LotteryInput,
  LotteryPrize,
  PageResult
} from '@/types/domain'

export async function getLotteries(): Promise<PageResult<Lottery>> {
  const result = await apiRequest<Lottery[] | PageResult<Lottery>>('/api/admin/lotteries')
  return normalizePage(result)
}

export function getLottery(id: string): Promise<Lottery> {
  return apiRequest(`/api/admin/lotteries/${encodeURIComponent(id)}`)
}

export function createLottery(input: LotteryInput): Promise<Lottery> {
  return apiRequest('/api/admin/lotteries', { method: 'POST', body: input })
}

export function updateLottery(id: string, input: LotteryInput): Promise<Lottery> {
  return apiRequest(`/api/admin/lotteries/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: input
  })
}

export function startLottery(id: string): Promise<Lottery> {
  return apiRequest(`/api/admin/lotteries/${encodeURIComponent(id)}/start`, { method: 'POST' })
}

export function deleteLottery(id: string): Promise<void> {
  return apiRequest(`/api/admin/lotteries/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export function updateLotteryPrizes(id: string, prizes: LotteryPrize[]): Promise<Lottery> {
  return apiRequest(`/api/admin/lotteries/${encodeURIComponent(id)}/prizes`, {
    method: 'PUT',
    body: { prizes }
  })
}

export function generateLotterySnapshot(id: string): Promise<Lottery> {
  return apiRequest(`/api/admin/lotteries/${encodeURIComponent(id)}/candidates/generate`, {
    method: 'POST'
  })
}

export function lockLottery(id: string): Promise<Lottery> {
  return apiRequest(`/api/admin/lotteries/${encodeURIComponent(id)}/candidates/lock`, {
    method: 'POST'
  })
}

export function drawLottery(id: string): Promise<Lottery> {
  return apiRequest(`/api/admin/lotteries/${encodeURIComponent(id)}/draw`, { method: 'POST' })
}

export function fulfillLottery(id: string): Promise<Lottery> {
  return apiRequest(`/api/admin/lotteries/${encodeURIComponent(id)}/fulfill`, { method: 'POST' })
}

export function retryOutboxJob(id: string): Promise<FulfillmentJob> {
  return apiRequest(`/api/admin/outbox/${encodeURIComponent(id)}/retry`, { method: 'POST' })
}

export function completeOutboxJob(id: string, externalRef = ''): Promise<FulfillmentJob> {
  return apiRequest(`/api/admin/outbox/${encodeURIComponent(id)}/complete`, {
    method: 'POST',
    body: { external_ref: externalRef }
  })
}
