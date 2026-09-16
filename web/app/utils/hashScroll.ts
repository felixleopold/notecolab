const capabilityRoute = /^\/(?:s|invite|live)\/[^/]+\/?$/

/**
 * Capability links keep encryption material in the URL fragment. It is not a
 * document anchor and must never be interpreted as a CSS selector.
 */
export function hashScrollTargetId(path: string, hash: string): string | null {
  if (!hash || capabilityRoute.test(path)) return null

  try {
    const id = decodeURIComponent(hash.startsWith('#') ? hash.slice(1) : hash)
    return id || null
  } catch {
    return null
  }
}
