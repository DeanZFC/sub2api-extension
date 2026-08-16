export function resolveAccessRedirect(
  _routeName: unknown,
  requiresAdmin: boolean,
  isAdmin: boolean
): 'home' | null {
  if (requiresAdmin && !isAdmin) return 'home'
  return null
}
