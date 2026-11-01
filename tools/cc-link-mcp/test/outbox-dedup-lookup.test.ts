import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ApiError } from '../src/api.ts'
import { Outbox } from '../src/outbox.ts'

// CodeRabbit finding: a failed duplicate lookup must never move an undelivered item to rejected/.
describe('outbox: duplicate-check failure keeps the item', () => {
  const dirs: string[] = []
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

  test('a non-retryable lookup error stops the flush and keeps the uncertain item', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-link-dedup-'))
    dirs.push(dir)
    const outbox = new Outbox(dir)
    outbox.enqueue({
      createdAt: new Date().toISOString(),
      kind: 'note',
      folderKey: 'ae2a5fc3',
      pid: 1,
      payload: { from: 's', to: 'm', content: 'hello', origin_note: 'n' },
      uncertain: true,
    })
    let sends = 0
    const r = await outbox.flush(async () => { sends++; return { id: 1 } }, {
      findExisting: async () => { throw new ApiError('listing rejected', false, 400) },
    })
    expect(sends).toBe(0)
    expect(r.rejected).toEqual([])
    expect(r.failed).toBe(1)
    expect(outbox.count()).toBe(1)
    expect(existsSync(join(dir, 'rejected')) ? readdirSync(join(dir, 'rejected')).length : 0).toBe(0)
  })
})
