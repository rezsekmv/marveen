/**
 * The ONE place that reads the environment. Everything else receives a Config.
 *
 * Missing or invalid required values never throw: they are collected in
 * `errors`, the server still starts (so Claude Code shows it connected), and
 * every tool answers with those errors instead of doing anything.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface Config {
  /** Dashboard base URL without a trailing slash, or undefined if missing/invalid. */
  url?: string
  /** Bearer device key. Never logged, never echoed. */
  deviceKey?: string
  /** This machine's system sender id. */
  senderId?: string
  /** Fallback main-agent id used when GET /api/team/graph fails. */
  mainAgentFallback?: string
  stateDir: string
  dryRun: boolean
  askWaitSec: number
  pollSec: number
  flushSec: number
  /** Human-readable problems that block every tool (each names the env variable). */
  errors: string[]
  /** Non-blocking problems (e.g. an unparsable interval that fell back to its default). */
  warnings: string[]
  /** One-time startup notices for stderr (e.g. the insecure-http opt-in). Not repeated in tool results. */
  notices: string[]
  /** MARVEEN_URL is plain http to a non-loopback host, allowed by CC_LINK_ALLOW_INSECURE_HTTP=1. */
  insecureHttp: boolean
  /** Tool-name prefix (`<prefix>_message` ...), from CC_LINK_AGENT_NAME; DEFAULT_TOOL_PREFIX when unset. */
  toolPrefix: string
}

/** A header-safe token: printable ASCII, no spaces or control characters. */
export const DEVICE_KEY_CHARSET = /^[\x21-\x7e]+$/

export const DEFAULT_ASK_WAIT_SEC = 60
export const DEFAULT_POLL_SEC = 15
export const DEFAULT_FLUSH_SEC = 300
/** Neutral tool-name prefix when CC_LINK_AGENT_NAME is unset: agent_message, agent_reply, agent_inbox. */
export const DEFAULT_TOOL_PREFIX = 'agent'
/** MCP tool names are capped at 64 characters; the longest suffix is `_message`. */
export const TOOL_PREFIX_MAX = 32

/**
 * A tool-name prefix from an agent name: lowercase, every run of characters
 * outside [a-z0-9_] becomes one '_', no leading/trailing '_', at most
 * TOOL_PREFIX_MAX characters. Undefined when nothing is left.
 */
export function sanitizeToolPrefix(raw: string): string | undefined {
  const s = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, TOOL_PREFIX_MAX)
    .replace(/_+$/, '')
  return s.length > 0 ? s : undefined
}

/** localhost, 127.0.0.0/8 or ::1. */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  if (h === '::1' || h === '0:0:0:0:0:0:0:1') return true
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)
}

/**
 * Validate an http(s) base URL and strip trailing slashes (`https://h:3420/`
 * and `https://h:3420//` both become `https://h:3420`). Returns an error text
 * when it cannot be used as a base: every request path (`/api/...`) is
 * appended to it, so a query, a fragment or a path that already ends in
 * `/api` would turn every call into a 404.
 */
export function parseBaseUrl(raw: string): { url: string } | { error: string } {
  let parsed: URL
  try {
    parsed = new URL(raw.trim())
  } catch {
    return { error: 'MARVEEN_URL is not a valid http(s) base URL' }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { error: 'MARVEEN_URL is not a valid http(s) base URL' }
  }
  if (parsed.search || parsed.hash) {
    return { error: 'MARVEEN_URL must not contain a query (?...) or a fragment (#...); expected e.g. https://<mini-host>:3420' }
  }
  const url = parsed.toString().replace(/\/+$/, '')
  if (/\/api(\/|$)/i.test(new URL(url).pathname)) {
    return {
      error:
        'MARVEEN_URL must be the dashboard base URL without /api (cc-link appends /api/... itself); ' +
        'expected e.g. https://<mini-host>:3420',
    }
  }
  return { url }
}

/** Validate an http(s) URL and strip trailing slashes. Returns undefined when invalid. */
export function normalizeBaseUrl(raw: string): string | undefined {
  const r = parseBaseUrl(raw)
  return 'url' in r ? r.url : undefined
}

function positiveInt(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
  warnings: string[],
): number {
  const raw = env[name]?.trim()
  if (!raw) return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0) {
    warnings.push(`${name}=${JSON.stringify(raw)} is not a positive integer; using ${fallback}`)
    return fallback
  }
  return n
}

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
  argv: readonly string[] = process.argv,
  home: string = homedir(),
): Config {
  const errors: string[] = []
  const warnings: string[] = []
  const notices: string[] = []
  let insecureHttp = false
  const dryRun = env.CC_LINK_DRY_RUN?.trim() === '1' || argv.includes('--dry-run')

  let url: string | undefined
  const rawUrl = env.MARVEEN_URL?.trim()
  if (!rawUrl) {
    errors.push('MARVEEN_URL is not set (expected e.g. https://<mini-host>:3420)')
  } else {
    const parsedUrl = parseBaseUrl(rawUrl)
    if ('error' in parsedUrl) {
      errors.push(parsedUrl.error)
    } else {
      url = parsedUrl.url
      const parsed = new URL(url)
      if (parsed.protocol === 'http:' && !isLoopbackHost(parsed.hostname)) {
        if (env.CC_LINK_ALLOW_INSECURE_HTTP?.trim() === '1') {
          insecureHttp = true
          notices.push(
            'WARNING: MARVEEN_URL is plain http to a non-loopback host; the device key travels in cleartext ' +
              '(allowed by CC_LINK_ALLOW_INSECURE_HTTP=1). Prefer https or a VPN.',
          )
        } else {
          errors.push(
            'MARVEEN_URL uses plain http to a non-loopback host, which would send the device key in cleartext. ' +
              'Use https (or a VPN address with https), or set CC_LINK_ALLOW_INSECURE_HTTP=1 to opt in.',
          )
        }
      }
    }
  }

  let deviceKey = env.MARVEEN_DEVICE_KEY?.trim() || undefined
  if (!deviceKey && !dryRun) errors.push('MARVEEN_DEVICE_KEY is not set')
  if (deviceKey && !DEVICE_KEY_CHARSET.test(deviceKey)) {
    // Never echo the value: it is a credential, even when malformed.
    errors.push('MARVEEN_DEVICE_KEY contains invalid characters (only printable ASCII without spaces is allowed)')
    deviceKey = undefined
  }

  const senderId = env.MARVEEN_SENDER_ID?.trim() || undefined
  if (!senderId) errors.push('MARVEEN_SENDER_ID is not set')

  const mainAgentFallback = env.MARVEEN_MAIN_AGENT?.trim() || undefined
  const stateDir = env.CC_LINK_STATE_DIR?.trim() || join(home, '.cc-link')

  // The prefix comes from the environment only (never from whoami): the tool
  // list must be the same offline, and permission allowlists name the tools.
  let toolPrefix = DEFAULT_TOOL_PREFIX
  const rawAgentName = env.CC_LINK_AGENT_NAME?.trim()
  if (rawAgentName) {
    const p = sanitizeToolPrefix(rawAgentName)
    if (!p) {
      warnings.push(
        `CC_LINK_AGENT_NAME=${JSON.stringify(rawAgentName)} has no letters or digits; using the tool prefix ${DEFAULT_TOOL_PREFIX}_`,
      )
    } else {
      toolPrefix = p
      if (p !== rawAgentName) notices.push(`CC_LINK_AGENT_NAME=${JSON.stringify(rawAgentName)} -> tool prefix ${p}_`)
    }
  }

  return {
    url,
    deviceKey,
    senderId,
    mainAgentFallback,
    stateDir,
    dryRun,
    askWaitSec: positiveInt(env, 'CC_LINK_ASK_WAIT_SEC', DEFAULT_ASK_WAIT_SEC, warnings),
    pollSec: positiveInt(env, 'CC_LINK_POLL_SEC', DEFAULT_POLL_SEC, warnings),
    flushSec: positiveInt(env, 'CC_LINK_FLUSH_SEC', DEFAULT_FLUSH_SEC, warnings),
    errors,
    warnings,
    notices,
    insecureHttp,
    toolPrefix,
  }
}
