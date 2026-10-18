/**
 * Per-folder persistent state: `<stateDir>/folders/<folderKey>/asks.json`,
 * guarded by `<stateDir>/folders/<folderKey>/lock`. Every mutation is
 * read-modify-write under the lock with an atomic rename.
 */
import { join } from 'node:path'
import { atomicWriteJson, readJsonFile, withLock, type LockOptions } from './fsutil.ts'
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
