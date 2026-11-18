// The rules every store applies to a versioned write, in one place so a
// file store, a memory store and any store a host writes behave alike.
//
// A write names the version it was based on. It may replace the stored
// version only when that base is still current, with one allowance:
// consecutive saves from one client may all have been snapshotted against
// the same read, so that client may keep advancing while its own last write
// is still the current one. Any write from elsewhere in between breaks the
// chain and the next write conflicts.
//
// A client's revisions only ever grow. A write whose revision is not newer
// than that client's last accepted one is stale: it is acknowledged and
// dropped, never applied over the newer text.
import { ConflictError } from './errors.js'
import type { Version, WriteContext } from '../types.js'

const CLIENT_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/
const MAX_VERSION_LENGTH = 256

export function validWriteContext(input: unknown): WriteContext {
  if (!input || typeof input !== 'object') throw new Error('invalid write context')
  const value = input as Partial<WriteContext>
  if (typeof value.clientId !== 'string' || !CLIENT_ID_RE.test(value.clientId)) {
    throw new Error('invalid client_id')
  }
  if (typeof value.revision !== 'number' || !Number.isSafeInteger(value.revision) || value.revision <= 0) {
    throw new Error('invalid revision')
  }
  if (typeof value.baseVersion !== 'string' || !value.baseVersion || value.baseVersion.length > MAX_VERSION_LENGTH) {
    throw new Error('invalid base_version')
  }
  return { clientId: value.clientId, revision: value.revision, baseVersion: value.baseVersion }
}

interface ClientWrite {
  revision: number
  version: Version
}

export class WriteGuard {
  private readonly latest = new Map<string, ClientWrite>()

  constructor(private readonly maxEntries = 10_000) {}

  /**
   * Decide a write against what is stored now. Returns 'stale' when this
   * client already wrote a newer revision, 'write' when the write may land,
   * and throws ConflictError when someone else wrote in between.
   */
  admit(target: string, context: WriteContext, currentVersion: Version): 'write' | 'stale' {
    const previous = this.previous(target, context)
    if (previous && context.revision <= previous.revision) return 'stale'
    if (context.baseVersion === currentVersion) return 'write'
    if (previous?.version === currentVersion) return 'write'
    throw new ConflictError(currentVersion)
  }

  remember(target: string, context: WriteContext, version: Version): void {
    const key = keyOf(target, context.clientId)
    this.latest.delete(key)
    this.latest.set(key, { revision: context.revision, version })
  }

  forget(target: string): void {
    const prefix = `${target}\0`
    for (const key of this.latest.keys()) {
      if (key.startsWith(prefix)) this.latest.delete(key)
    }
  }

  private previous(target: string, context: WriteContext): ClientWrite | undefined {
    const previous = this.latest.get(keyOf(target, context.clientId))
    // Losing a revision watermark could let an evicted lower revision write.
    // Fail closed for a new client instead; deletion and a restart clear the
    // bounded state in normal operation.
    if (!previous && this.latest.size >= this.maxEntries) {
      throw new Error('too many active editor clients')
    }
    return previous
  }
}

function keyOf(target: string, clientId: string): string {
  return `${target}\0${clientId}`
}
