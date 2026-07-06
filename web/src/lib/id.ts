// Client-side id generation, shared by every *-store.ts. Each table also
// defaults its id column to gen_random_uuid()::text server-side — this is
// only needed to stamp a row before the optimistic local/cache write.

export function genId(prefix: string): string {
  if (typeof crypto !== 'undefined' && typeof (crypto as Crypto).randomUUID === 'function')
    return (crypto as Crypto).randomUUID()
  return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
}
