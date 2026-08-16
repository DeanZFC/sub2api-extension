import { beforeEach, describe, expect, it } from 'vitest'
import {
  formatActivityDate,
  fromActivityDateTimeInput,
  getActivityTimeZone,
  setActivityTimeZone,
  toActivityDateTimeInput
} from './time'

describe('activity time zone', () => {
  beforeEach(() => setActivityTimeZone('Asia/Shanghai'))

  it('formats UTC timestamps as China time', () => {
    expect(formatActivityDate('2026-08-08T18:24:00.000Z', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    })).toContain('2026/08/09 02:24')
  })

  it('converts datetime-local values between China time and UTC', () => {
    expect(fromActivityDateTimeInput('2026-08-09T10:24')).toBe('2026-08-09T02:24:00.000Z')
    expect(toActivityDateTimeInput('2026-08-09T02:24:00.000Z')).toBe('2026-08-09T10:24')
  })

  it('falls back to China time for an invalid configured zone', () => {
    setActivityTimeZone('not/a-zone')
    expect(getActivityTimeZone()).toBe('Asia/Shanghai')
  })
})
