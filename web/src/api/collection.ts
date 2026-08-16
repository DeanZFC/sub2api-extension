import type { PageResult } from '@/types/domain'

export function normalizePage<T>(value: PageResult<T> | T[]): PageResult<T> {
  if (Array.isArray(value)) return { items: value, total: value.length }
  return value
}
