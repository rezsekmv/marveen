/**
 * Thin client for the dashboard's message API. `fetch` and the base URL are
 * injected so tests can drive it without a network.
 *
 * Error classes:
 *  - network error, timeout, 5xx, 408, 429                    => retryable
 *  - 401 / 403                                                 => auth (not retryable)
 *  - other 4xx                                                 => client error (status + server text)
 *  - a 2xx whose body is not what the endpoint promises        => malformed; retryable for
 *    reads, NOT for POST: the message may have been created, so resending risks a duplicate
 *    (`sendStateUnknown`).
 */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export interface MessageRow {
  id: number
  from_agent: string
  to_agent: string
  content: string
  status: 'pending' | 'delivered' | 'done' | 'failed' | string
  result: string | null
  created_at: number
  origin_note?: string | null
  /**
   * 'router' when the dashboard's router closed the row as failed; null when
   * failed otherwise (or before the column existed); ABSENT on dashboards
   * that do not report it.
   */
  failed_by?: string | null
}

export interface Whoami {
  kind?: string
  scope?: string
  device?: string
  /** The sender id the device key is bound to (messages-scope keys). */
  senderId?: string
  mainAgentId?: string
}

export interface PostMessageBody {
  from: string
  to: string
  content: string
  origin_note: string
}

export class ApiError extends Error {
  constructor(
    message: string,
    /** true for network errors, timeouts, 5xx, 408, 429 and malformed read responses. */
    readonly retryable: boolean,
    readonly status?: number,
    /** Server error text (the `error` field of a JSON body, else the raw body, capped). */
    readonly serverText?: string,
    readonly flags: { auth?: boolean; sendStateUnknown?: boolean } = {},
  ) {
    super(message)
    this.name = 'ApiError'
  }

  /** 401/403: the device key or sender id is not accepted. */
  get isAuth(): boolean {
    return this.flags.auth === true
  }

  /** A POST got a 2xx we could not read: the message may or may not exist. */
  get sendStateUnknown(): boolean {
    return this.flags.sendStateUnknown === true
  }
}

export function isRetryableStatus(status: number): boolean {
  return status >= 500 || status === 408 || status === 429
}

export const REQUEST_TIMEOUT_MS = 10_000

export interface ApiClientOptions {
  baseUrl: string
  deviceKey: string
  fetch?: FetchLike
  timeoutMs?: number
}

function errorText(body: string): string {
  try {
    const parsed = JSON.parse(body) as unknown
    if (parsed && typeof parsed === 'object' && 'error' in parsed) {
      const e = (parsed as { error: unknown }).error
      if (typeof e === 'string') return e.slice(0, 500)
    }
  } catch {
    // not JSON
  }
  return body.slice(0, 500)
}

/** What a request WOULD look like, with the credential redacted (dry run). */
export function describeRequest(method: string, path: string, body?: unknown): string {
  const lines = [`${method} ${path}`, 'Authorization: Bearer <redacted>']
  if (body !== undefined) {
    lines.push('Content-Type: application/json', '', JSON.stringify(body, null, 2))
  }
  return lines.join('\n')
}

export class ApiClient {
  private readonly baseUrl: string
  private readonly deviceKey: string
  private readonly fetchFn: FetchLike
  private readonly timeoutMs: number

  constructor(opts: ApiClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '')
    this.deviceKey = opts.deviceKey
    this.fetchFn = opts.fetch ?? ((input, init) => fetch(input, init))
    this.timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    let res: Response
    let text: string
    try {
      res = await this.fetchFn(this.baseUrl + path, {
        method,
        headers: {
          Authorization: `Bearer ${this.deviceKey}`,
          Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      })
      text = await res.text()
    } catch (err) {
      const aborted = controller.signal.aborted
      const msg = aborted ? `timeout after ${this.timeoutMs} ms` : err instanceof Error ? err.message : String(err)
      throw new ApiError(`${method} ${path}: ${msg}`, true)
    } finally {
      clearTimeout(timer)
    }
    if (isRetryableStatus(res.status)) {
      throw new ApiError(`${method} ${path}: HTTP ${res.status}`, true, res.status, errorText(text))
    }
    if (res.status >= 400) {
      const t = errorText(text)
      const auth = res.status === 401 || res.status === 403
      throw new ApiError(`${method} ${path}: HTTP ${res.status}: ${t}`, false, res.status, t, { auth })
    }
    if (text.length === 0) return undefined as T
    try {
      return JSON.parse(text) as T
    } catch {
      throw this.malformed(method, path, res.status, 'response is not JSON')
    }
  }

  private malformed(method: string, path: string, status: number | undefined, what: string): ApiError {
    const post = method === 'POST'
    return new ApiError(
      post
        ? `${method} ${path}: ${what}; the send state is unknown (the message may have been created), so it is not retried`
        : `${method} ${path}: ${what}`,
      !post,
      status,
      undefined,
      { sendStateUnknown: post },
    )
  }

  /**
   * GET /api/auth/whoami: who the device key is. Newer dashboards only; an
   * older one answers 404 (or 403 for a key scope that cannot reach it).
   */
  async whoami(): Promise<Whoami> {
    const w = await this.request<unknown>('GET', '/api/auth/whoami')
    if (!w || typeof w !== 'object') throw this.malformed('GET', '/api/auth/whoami', 200, 'response is not an object')
    const o = w as Record<string, unknown>
    const str = (v: unknown) => (typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined)
    return {
      kind: str(o.kind),
      scope: str(o.scope),
      device: str(o.device),
      senderId: str(o.sender_id),
      mainAgentId: str(o.mainAgentId),
    }
  }

  async getMainAgentId(): Promise<string> {
    const graph = await this.request<{ mainAgentId?: unknown }>('GET', '/api/team/graph')
    const id = graph?.mainAgentId
    if (typeof id !== 'string' || id.trim().length === 0) {
      throw new ApiError('GET /api/team/graph: no mainAgentId in response', false)
    }
    return id.trim()
  }

  async postMessage(body: PostMessageBody): Promise<MessageRow> {
    const row = await this.request<MessageRow>('POST', '/api/messages', body)
    if (!row || typeof row !== 'object' || typeof row.id !== 'number' || !Number.isInteger(row.id)) {
      throw this.malformed('POST', '/api/messages', 200, 'response has no numeric id')
    }
    return row
  }

  async getMessage(id: number): Promise<MessageRow> {
    const row = await this.request<MessageRow>('GET', `/api/messages/${id}`)
    if (!row || typeof row !== 'object' || typeof row.status !== 'string') {
      throw this.malformed('GET', `/api/messages/${id}`, 200, 'response has no status')
    }
    return row
  }

  /** Pending rows addressed TO `agent`. */
  async listPending(agent: string): Promise<MessageRow[]> {
    const q = new URLSearchParams({ agent, status: 'pending' })
    return this.rowList(await this.request<unknown>('GET', `/api/messages?${q}`), q)
  }

  private rowList(v: unknown, q: URLSearchParams): MessageRow[] {
    if (v === undefined) return []
    if (!Array.isArray(v)) throw this.malformed('GET', `/api/messages?${q}`, 200, 'response is not a list')
    return v.filter(
      (r): r is MessageRow => !!r && typeof r === 'object' && typeof (r as MessageRow).id === 'number',
    )
  }

  /** The last `limit` rows of `agent`'s conversation, both directions. */
  async listConversation(agent: string, limit = 200): Promise<MessageRow[]> {
    const q = new URLSearchParams({ agent, limit: String(limit) })
    return this.rowList(await this.request<unknown>('GET', `/api/messages?${q}`), q)
  }

  async markDone(id: number, result: string): Promise<void> {
    await this.request('PUT', `/api/messages/${id}`, { status: 'done', result, notify: false })
  }
}
