/**
 * Test harness: an in-memory fake of the dashboard message API (served through
 * an injected fetch), a fake clock, temp state dirs and a link factory.
 * No real network, no real dashboard.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FetchLike, MessageRow } from '../src/api.ts'
import { loadConfig, type Config } from '../src/config.ts'
import { buildOriginNote, computeFolderKey, type SessionIdentity } from '../src/identity.ts'
import { createLink, type CcLink } from '../src/link.ts'
import { frameAsData } from '../src/format.ts'
import type { LockOptions } from '../src/fsutil.ts'

// Built by concatenation so secret scanners do not flag the test source.
export const DEVICE_KEY = 'mvdk' + '_' + 'TESTDEVICEKEY0123456789abcdef'
export const SENDER = 'laptop-cc'
export const MAIN = 'main-agent'
export const BASE_URL = 'https://dash.test:3420'

// Router failure reasons: the client's copy (src/router-reasons.ts), which
// test/router-reasons.test.ts checks against the server's
// src/router-failure-reasons.ts. The fake dashboard uses the same rule as the
// server: a late 'done' on a failed row only with router provenance and one of
// these reasons (abandon: exact, the other two: prefix); otherwise 409.
export {
  ROUTER_ABANDON_REASON,
  ROUTER_DELIVERY_ERROR_PREFIX,
  ROUTER_INJECT_GIVEUP_PREFIX,
} from '../src/router-reasons.ts'
import { isRouterRecoverableFailure } from '../src/router-reasons.ts'

/**
 * A dashboard row as the fake stores it. `failed_by` mirrors the server's
 * agent_messages.failed_by: 'router' only when the router itself closed the
 * row as failed; a PUT failed never sets it, and rows failed before that
 * server build have NULL.
 */
export type FakeRow = MessageRow

export interface Call {
  who: string
  method: string
  path: string
  rawBody?: string
  body?: any
  auth?: string
}

export type Override = (c: Call) => Response | 'network' | undefined | Promise<Response | 'network' | undefined>

const tick = () => new Promise<void>(r => setTimeout(r, 0))

function json(status: number, data: unknown): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
}

export class FakeDashboard {
  rows = new Map<number, FakeRow>()
  nextId = 100
  calls: Call[] = []
  mainAgentId: string | null = MAIN
  override?: Override
  /** GET /api/auth/whoami body; null = an older dashboard without the endpoint (404). */
  whoami: Record<string, unknown> | null = null
  createdAt = 1_760_000_000

  fetchFor(who: string): FetchLike {
    return async (input, init) => {
      const url = new URL(input)
      const method = (init?.method ?? 'GET').toUpperCase()
      const headers = (init?.headers ?? {}) as Record<string, string>
      const rawBody = typeof init?.body === 'string' ? init.body : undefined
      const call: Call = {
        who,
        method,
        path: url.pathname + url.search,
        rawBody,
        body: rawBody ? JSON.parse(rawBody) : undefined,
        auth: headers.Authorization,
      }
      this.calls.push(call)
      await tick()
      const o = this.override ? await this.override(call) : undefined
      if (o === 'network') throw new TypeError('fetch failed: ECONNREFUSED')
      if (o) return o
      return this.route(call, url)
    }
  }

  get fetch(): FetchLike {
    return this.fetchFor('default')
  }

  private route(c: Call, url: URL): Response {
    if (c.method === 'GET' && url.pathname === '/api/auth/whoami') {
      return this.whoami ? json(200, this.whoami) : json(404, { error: 'no route' })
    }
    if (c.method === 'GET' && url.pathname === '/api/team/graph') {
      return json(200, this.mainAgentId ? { mainAgentId: this.mainAgentId, nodes: [] } : { nodes: [] })
    }
    if (url.pathname === '/api/messages' && c.method === 'POST') {
      const b = c.body
      const row = this.insert({ from_agent: b.from, to_agent: b.to, content: b.content, origin_note: b.origin_note })
      return json(201, row)
    }
    if (url.pathname === '/api/messages' && c.method === 'GET') {
      const agent = url.searchParams.get('agent')
      const status = url.searchParams.get('status')
      let rows = [...this.rows.values()]
      if (status) rows = rows.filter(r => r.to_agent === agent && r.status === status)
      else rows = rows.filter(r => r.to_agent === agent || r.from_agent === agent)
      const limit = Number(url.searchParams.get('limit') ?? 1000)
      return json(200, rows.sort((a, b) => b.id - a.id).slice(0, limit))
    }
    const m = /^\/api\/messages\/(\d+)$/.exec(url.pathname)
    if (m) {
      const row = this.rows.get(Number(m[1]))
      if (!row) return json(404, { error: 'Message not found' })
      if (c.method === 'GET') return json(200, row)
      if (c.method === 'PUT') {
        // Status guard, as on the server: only open rows close; a router-failed
        // row takes a late 'done' only for the recoverable router reasons.
        const open = row.status === 'pending' || row.status === 'delivered'
        // Reopenable only with router PROVENANCE (failed_by = 'router') AND a recoverable router reason.
        const lateDone =
          row.status === 'failed' &&
          c.body.status === 'done' &&
          row.failed_by === 'router' &&
          isRouterRecoverableFailure(row.result)
        if (!open && !lateDone) return json(409, { error: 'message is not open' })
        if (c.body.status) row.status = c.body.status
        if ('result' in c.body) row.result = c.body.result
        return json(200, { ok: true })
      }
    }
    return json(404, { error: 'no route' })
  }

  insert(p: Partial<FakeRow> & { from_agent: string; to_agent: string }): FakeRow {
    const row: FakeRow = {
      id: this.nextId++,
      content: '',
      status: 'pending',
      result: null,
      created_at: this.createdAt++,
      origin_note: null,
      ...p,
    }
    this.rows.set(row.id, row)
    return row
  }

  /** A message the main agent initiates to this machine. */
  addInbox(p: Partial<FakeRow> = {}): FakeRow {
    return this.insert({ from_agent: MAIN, to_agent: SENDER, content: 'hello from main', ...p })
  }

  answer(id: number, result: string, status = 'done'): void {
    const r = this.rows.get(id)
    if (!r) throw new Error(`no row ${id}`)
    r.status = status
    r.result = result
  }

  posts(): Call[] {
    return this.calls.filter(c => c.method === 'POST' && c.path === '/api/messages')
  }

  puts(): Call[] {
    return this.calls.filter(c => c.method === 'PUT')
  }
}

export interface Harness {
  dir: string
  stateDir: string
  dash: FakeDashboard
  clock: { t: number }
  alive: Set<number>
  onSleep?: (ms: number) => void
  cleanup(): void
}

export function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'cc-link-test-'))
  const h: Harness = {
    dir,
    stateDir: join(dir, 'state'),
    dash: new FakeDashboard(),
    // Real-time start: lock staleness compares the fake clock with real file mtimes.
    clock: { t: Date.now() },
    alive: new Set<number>(),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
  return h
}

export function makeConfig(h: Harness, env: Record<string, string | undefined> = {}): Config {
  return loadConfig(
    {
      MARVEEN_URL: BASE_URL,
      MARVEEN_DEVICE_KEY: DEVICE_KEY,
      MARVEEN_SENDER_ID: SENDER,
      CC_LINK_STATE_DIR: h.stateDir,
      CC_LINK_ASK_WAIT_SEC: '9',
      ...env,
    },
    [],
    h.dir,
  )
}

export function fakeIdentity(folder = '/work/repo-a', branch = 'main'): SessionIdentity {
  const folderKey = computeFolderKey(folder)
  const repo = folder.split('/').pop() || folder
  return {
    folder,
    repo,
    folderKey,
    isGitRepo: true,
    branch: () => branch,
    originNote: () => buildOriginNote(repo, branch, folderKey),
  }
}

export interface TestLink {
  link: CcLink
  notified: Array<{ content: string; meta: Record<string, string> }>
  logs: string[]
}

export function makeLink(
  h: Harness,
  o: {
    pid: number
    identity?: SessionIdentity
    env?: Record<string, string | undefined>
    config?: Config
    who?: string
    lock?: LockOptions
    bootMs?: number
  },
): TestLink {
  const notified: TestLink['notified'] = []
  const logs: string[] = []
  const link = createLink(o.config ?? makeConfig(h, o.env), {
    pid: o.pid,
    now: () => h.clock.t,
    isAlive: pid => h.alive.has(pid),
    sleep: async ms => {
      h.clock.t += ms
      h.onSleep?.(ms)
      await tick()
    },
    fetch: h.dash.fetchFor(o.who ?? String(o.pid)),
    notify: (content, meta) => {
      notified.push({ content, meta })
    },
    log: msg => logs.push(msg),
    identity: o.identity ?? fakeIdentity(),
    lock: o.lock,
    bootMs: o.bootMs,
  })
  return { link, notified, logs }
}

/** How dashboard text is shown/pushed: framed as data. */
export function framed(text: string): string {
  return frameAsData(text)
}

/** origin_note marker that addresses a folder. */
export function addr(folderKey: string): string {
  return `folder:${folderKey}`
}

export function idFrom(text: string): number {
  const m = /id (\d+)/.exec(text)
  if (!m) throw new Error(`no id in: ${text}`)
  return Number(m[1])
}
