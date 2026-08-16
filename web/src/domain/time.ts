const DEFAULT_ACTIVITY_TIME_ZONE = 'Asia/Shanghai'

let activityTimeZone = DEFAULT_ACTIVITY_TIME_ZONE

export function setActivityTimeZone(value?: string): void {
  if (!value) {
    activityTimeZone = DEFAULT_ACTIVITY_TIME_ZONE
    return
  }
  try {
    new Intl.DateTimeFormat('zh-CN', { timeZone: value }).format(new Date())
    activityTimeZone = value
  } catch {
    activityTimeZone = DEFAULT_ACTIVITY_TIME_ZONE
  }
}

export function getActivityTimeZone(): string {
  return activityTimeZone
}

export function formatActivityDate(
  value: string | Date,
  options: Intl.DateTimeFormatOptions
): string {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return typeof value === 'string' ? value : ''
  return new Intl.DateTimeFormat('zh-CN', {
    ...options,
    timeZone: activityTimeZone
  }).format(date)
}

export function toActivityDateTimeInput(value?: string | null): string | null {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: activityTimeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date)
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}`
}

export function fromActivityDateTimeInput(value?: string | null): string | null {
  if (!value) return null
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value)
  if (!match) return null
  const [, year, month, day, hour, minute, second = '00'] = match
  const localAsUtc = Date.UTC(
    Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)
  )
  if (!Number.isFinite(localAsUtc)) return null

  let instant = localAsUtc
  for (let attempt = 0; attempt < 3; attempt += 1) {
    instant = localAsUtc - timeZoneOffsetMilliseconds(instant)
  }
  const result = new Date(instant)
  return Number.isNaN(result.getTime()) ? null : result.toISOString()
}

function timeZoneOffsetMilliseconds(instant: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: activityTimeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(new Date(instant))
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  const representedAsUtc = Date.UTC(
    Number(values.year), Number(values.month) - 1, Number(values.day),
    Number(values.hour), Number(values.minute), Number(values.second)
  )
  return representedAsUtc - Math.floor(instant / 1000) * 1000
}
