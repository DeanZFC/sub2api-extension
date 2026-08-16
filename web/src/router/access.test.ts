import { describe, expect, it } from 'vitest'
import { resolveAccessRedirect } from './access'

describe('route access redirects', () => {
  it('allows administrators to use the activity center', () => {
    expect(resolveAccessRedirect('home', false, true)).toBeNull()
  })

  it('keeps ordinary users out of administrator pages', () => {
    expect(resolveAccessRedirect('group-grants', true, false)).toBe('home')
  })

  it('allows ordinary users to stay on the read-only home page', () => {
    expect(resolveAccessRedirect('home', false, false)).toBeNull()
  })
})
