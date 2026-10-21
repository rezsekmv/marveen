/**
 * Per-folder persistent state under `<stateDir>/folders/<folderKey>/`:
 * asks.json (sent messages being watched), broadcast.json (claimed inbox
 * messages for the other running sessions) and sessions/ (who is running),
 * guarded by `<folderDir>/lock`. Every mutation is read-modify-write under the
 * lock with an atomic rename.
 */
import { readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteJson, ensureDir, readJsonFile, withLock, type LockOptions } from './fsutil.ts'
import { adoptOrphans, type AskRecord } from './delivery.ts'

export function folderDir(stateDir: string, folderKey: string): string {
  return join(stateDir, 'folders', folderKey)
}

function isAskRecord(x: unknown): x is AskRecord {
  if (!x || typeof x !== 'object') return false
  const r = x as Record<string, unknown>
  return typeof r.id === 'number' && typeof r.pid === 'number'
}

export class AskStore {
  readonly dir: string
  readonly asksPath: string
  readonly lockPath: string

  constructor(
    stateDir: string,
    readonly folderKey: string,
    private readonly lockOpts: LockOptions = {},
  ) {
    this.dir = folderDir(stateDir, folderKey)
    this.asksPath = join(this.dir, 'asks.json')
    this.lockPath = join(this.dir, 'lock')
  }

  /** Lock-free read (writes are atomic, so a read never sees a torn file). */
  read(): AskRecord[] {
    const raw = readJsonFile<unknown>(this.asksPath, [])
    return Array.isArray(raw) ? raw.filter(isAskRecord) : []
  }

  /** Run `fn` under this folder's lock. */
  locked<T>(fn: () => Promise<T> | T): Promise<T> {
    return withLock(this.lockPath, fn, this.lockOpts)
  }

  /** Read-modify-write under the lock. */
  update(mutate: (asks: AskRecord[]) => AskRecord[]): Promise<AskRecord[]> {
    return this.locked(() => {
      const next = mutate(this.read())
      atomicWriteJson(this.asksPath, next)
      return next
    })
  }

  add(rec: AskRecord): Promise<AskRecord[]> {
    return this.update(asks => [...asks.filter(a => a.id !== rec.id), rec])
  }

  remove(ids: readonly number[]): Promise<AskRecord[]> {
    const drop = new Set(ids)
    return this.update(asks => asks.filter(a => !drop.has(a.id)))
  }

  has(id: number): boolean {
    return this.read().some(a => a.id === id)
  }

  /** Rule 2: take over asks whose owner is gone (dead pid, or owned before `bootMs`). Returns the adopted ids. */
  async adoptOrphans(
    newPid: number,
    isAlive: (pid: number) => boolean,
    bootMs?: number,
    nowIso?: string,
  ): Promise<number[]> {
    let adopted: number[] = []
    await this.update(asks => {
      const r = adoptOrphans(asks, newPid, isAlive, bootMs, nowIso)
      adopted = r.adopted
      return r.asks
    })
    return adopted
  }
}

/**
 * Running sessions of one folder: `<folderDir>/sessions/<pid>.json`. A
 * session registers at startup and unregisters at shutdown; a file whose pid
 * is dead, or that was written before the last boot (pid reuse), does not
 * count and is pruned when seen.
 */
export class SessionRegistry {
  readonly dir: string

  constructor(stateDir: string, folderKey: string) {
    this.dir = join(folderDir(stateDir, folderKey), 'sessions')
  }

  private path(pid: number): string {
    return join(this.dir, `${pid}.json`)
  }

  register(pid: number, startedAt: string): void {
    ensureDir(this.dir)
    atomicWriteJson(this.path(pid), { pid, startedAt })
  }

  unregister(pid: number): void {
    try {
      unlinkSync(this.path(pid))
    } catch {
      // already gone
    }
  }

  /** Pids of the live sessions in this folder. */
  alive(isAlive: (pid: number) => boolean, bootMs?: number): number[] {
    let names: string[]
    try {
      names = readdirSync(this.dir).filter(n => /^\d+\.json$/.test(n))
    } catch {
      return []
    }
    const out: number[] = []
    for (const n of names) {
      const pid = Number(n.slice(0, -5))
      const rec = readJsonFile<{ startedAt?: unknown }>(join(this.dir, n), {})
      const since = typeof rec.startedAt === 'string' ? Date.parse(rec.startedAt) : NaN
      const beforeBoot = bootMs !== undefined && Number.isFinite(since) && since < bootMs
      if (!beforeBoot && isAlive(pid)) out.push(pid)
      else this.unregister(pid)
    }
    return out.sort((a, b) => a - b)
  }
}

/** A folder-inbox message one session claimed, waiting to be shown to the other sessions running at claim time. */
export interface BroadcastEntry {
  id: number
  from: string
  content: string
  /** ISO time of the claim. */
  claimedAt: string
  /** Pids that still have to receive it. */
  recipients: number[]
}

function isBroadcastEntry(x: unknown): x is BroadcastEntry {
  if (!x || typeof x !== 'object') return false
  const r = x as Record<string, unknown>
  return (
    typeof r.id === 'number' &&
    typeof r.from === 'string' &&
    typeof r.content === 'string' &&
    typeof r.claimedAt === 'string' &&
    Array.isArray(r.recipients)
  )
}

/** Entries older than this are dropped even if a recipient never took them. */
export const BROADCAST_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

/**
 * `<folderDir>/broadcast.json`: claimed messages for the OTHER running
 * sessions of the folder. Guarded by the folder lock (the same file as
 * asks.json's), written atomically.
 */
export class BroadcastStore {
  readonly path: string
  readonly lockPath: string

  constructor(
    stateDir: string,
    folderKey: string,
    private readonly lockOpts: LockOptions = {},
  ) {
    const dir = folderDir(stateDir, folderKey)
    this.path = join(dir, 'broadcast.json')
    this.lockPath = join(dir, 'lock')
  }

  read(): BroadcastEntry[] {
    const raw = readJsonFile<unknown>(this.path, [])
    return Array.isArray(raw) ? raw.filter(isBroadcastEntry) : []
  }

  private update(mutate: (entries: BroadcastEntry[]) => BroadcastEntry[]): Promise<BroadcastEntry[]> {
    return withLock(
      this.lockPath,
      () => {
        const next = mutate(this.read())
        atomicWriteJson(this.path, next)
        return next
      },
      this.lockOpts,
    )
  }

  add(entry: BroadcastEntry): Promise<BroadcastEntry[]> {
    return this.update(es => [...es.filter(e => e.id !== entry.id), entry])
  }

  /**
   * `pid` has received `ids`: drop it from their recipients. Entries nobody
   * alive still waits for, or older than BROADCAST_MAX_AGE_MS, are pruned.
   */
  done(pid: number, ids: readonly number[], isAlive: (pid: number) => boolean, nowMs: number): Promise<BroadcastEntry[]> {
    const got = new Set(ids)
    return this.update(es =>
      es
        .map(e => (got.has(e.id) ? { ...e, recipients: e.recipients.filter(p => p !== pid) } : e))
        .filter(e => {
          const t = Date.parse(e.claimedAt)
          const fresh = !Number.isFinite(t) || nowMs - t <= BROADCAST_MAX_AGE_MS
          return fresh && e.recipients.some(p => isAlive(p))
        }),
    )
  }
}
