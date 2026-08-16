export type QueryValue = string | number | boolean | null | undefined

export interface ApiRequestOptions extends Omit<RequestInit, 'body'> {
  body?: unknown
  query?: Record<string, QueryValue>
}

export interface ApiErrorPayload {
  message?: string
  code?: string
  request_id?: string
  field_errors?: Record<string, string>
}

export class ApiError extends Error {
  readonly status: number
  readonly code?: string
  readonly requestId?: string
  readonly fieldErrors?: Record<string, string>

  constructor(status: number, payload: ApiErrorPayload = {}) {
    super(payload.message || `请求失败（HTTP ${status}）`)
    this.name = 'ApiError'
    this.status = status
    if (payload.code !== undefined) this.code = payload.code
    if (payload.request_id !== undefined) this.requestId = payload.request_id
    if (payload.field_errors !== undefined) this.fieldErrors = payload.field_errors
  }
}

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '')
const EMBEDDED_SESSION_KEY = 'sub2api_extension_embedded_session'
const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/
let csrfToken = ''
let embeddedSessionToken = ''

export function initializeEmbeddedSession(): void {
  if (typeof window === 'undefined') return
  const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ''))
  const handoffToken = fragment.get('ext_session') || ''
  const storage = availableSessionStorage()

  if (SESSION_TOKEN_PATTERN.test(handoffToken)) {
    embeddedSessionToken = handoffToken
    try { storage?.setItem(EMBEDDED_SESSION_KEY, handoffToken) } catch { /* Keep the in-memory token. */ }
  } else {
    try {
      const stored = storage?.getItem(EMBEDDED_SESSION_KEY) || ''
      embeddedSessionToken = SESSION_TOKEN_PATTERN.test(stored) ? stored : ''
    } catch {
      embeddedSessionToken = ''
    }
  }

  if (fragment.has('ext_session')) {
    fragment.delete('ext_session')
    const remainingFragment = fragment.toString()
    const cleanUrl = `${window.location.pathname}${window.location.search}${remainingFragment ? `#${remainingFragment}` : ''}`
    window.history.replaceState(window.history.state, '', cleanUrl)
  }
}

export function clearEmbeddedSession(): void {
  embeddedSessionToken = ''
  try { availableSessionStorage()?.removeItem(EMBEDDED_SESSION_KEY) } catch { /* Storage can be disabled. */ }
}

function availableSessionStorage(): Storage | null {
  if (typeof window === 'undefined') return null
  try {
    return window.sessionStorage || null
  } catch {
    return null
  }
}

// Run before the router creates its history object, otherwise it can restore the handoff fragment.
initializeEmbeddedSession()

function readCookie(name: string): string {
  if (typeof document === 'undefined') return ''
  const pair = document.cookie
    .split('; ')
    .find((item) => item.startsWith(`${encodeURIComponent(name)}=`))
  return pair ? decodeURIComponent(pair.slice(pair.indexOf('=') + 1)) : ''
}

function resolveCsrfToken(): string {
  if (csrfToken) return csrfToken
  if (typeof document === 'undefined') return ''
  const metaToken = document.querySelector<HTMLMetaElement>('meta[name="csrf-token"]')?.content
  return metaToken || readCookie('XSRF-TOKEN') || readCookie('csrf_token')
}

function buildUrl(path: string, query?: Record<string, QueryValue>): string {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  const entries = Object.entries(query || {}).filter(([, value]) => value !== null && value !== undefined)
  if (entries.length === 0) return `${API_BASE_URL}${normalizedPath}`

  const params = new URLSearchParams()
  entries.forEach(([key, value]) => params.set(key, String(value)))
  return `${API_BASE_URL}${normalizedPath}?${params.toString()}`
}

function unwrapPayload<T>(payload: unknown): T {
  if (payload && typeof payload === 'object' && 'data' in payload) {
    return (payload as { data: T }).data
  }
  return payload as T
}

function errorPayload(payload: unknown): ApiErrorPayload {
  if (!payload || typeof payload !== 'object') return {}
  const record = payload as Record<string, unknown>
  const nested = record.error
  if (nested && typeof nested === 'object') return nested as ApiErrorPayload
  if (typeof nested === 'string') {
    return {
      message: nested,
      ...(typeof record.code === 'string' ? { code: record.code } : {})
    }
  }
  return record as ApiErrorPayload
}

export function setCsrfToken(token?: string): void {
  csrfToken = token || ''
}

export async function apiRequest<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  const { body: inputBody, query, ...requestOptions } = options
  const method = (options.method || 'GET').toUpperCase()
  const headers = new Headers(options.headers)
  headers.set('Accept', 'application/json')
  if (embeddedSessionToken && !headers.has('Authorization')) {
    headers.set('Authorization', `Session ${embeddedSessionToken}`)
  }

  let body: BodyInit | undefined
  if (inputBody !== undefined) {
    if (inputBody instanceof FormData) {
      body = inputBody
    } else {
      headers.set('Content-Type', 'application/json')
      body = JSON.stringify(inputBody)
    }
  }

  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    const token = resolveCsrfToken()
    if (token) headers.set('X-CSRF-Token', token)
  }

  const requestInit: RequestInit = {
    ...requestOptions,
    method,
    headers,
    credentials: options.credentials || 'include'
  }
  if (body !== undefined) requestInit.body = body

  const response = await fetch(buildUrl(path, query), requestInit)
  if (response.status === 401) clearEmbeddedSession()

  const responseCsrfToken = response.headers.get('X-CSRF-Token')
  if (responseCsrfToken) csrfToken = responseCsrfToken

  const text = await response.text()
  let payload: unknown = undefined
  if (text) {
    try {
      payload = JSON.parse(text)
    } catch {
      payload = { message: text }
    }
  }

  if (!response.ok) throw new ApiError(response.status, errorPayload(payload))
  return unwrapPayload<T>(payload)
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message
  if (error instanceof Error) return error.message
  return '发生未知错误，请稍后重试'
}
