/**
 * The client keeps its own copy of the router failure reasons
 * (src/router-reasons.ts), because the laptop may run cc-link without the
 * server tree. When the server file is present (repository checkout), the
 * two must be identical.
 */
import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import * as client from '../src/router-reasons.ts'

const SERVER_FILE = join(import.meta.dir, '..', '..', '..', 'src', 'router-failure-reasons.ts')
const present = existsSync(SERVER_FILE)

describe('router reasons: client copy matches the server', () => {
  if (!present) {
    test.skip(`server file not present (${SERVER_FILE}); nothing to compare in a standalone copy`, () => {})
    return
  }

  test('constants and the recoverable list are identical', async () => {
    const server = (await import(SERVER_FILE)) as typeof client
    expect(client.ROUTER_ABANDON_REASON).toBe(server.ROUTER_ABANDON_REASON)
    expect(client.ROUTER_INJECT_GIVEUP_PREFIX).toBe(server.ROUTER_INJECT_GIVEUP_PREFIX)
    expect(client.ROUTER_DELIVERY_ERROR_PREFIX).toBe(server.ROUTER_DELIVERY_ERROR_PREFIX)
    expect(client.ROUTER_RECOVERABLE_FAILURES).toEqual(server.ROUTER_RECOVERABLE_FAILURES)
  })

  test('the matcher agrees on representative results', async () => {
    const server = (await import(SERVER_FILE)) as typeof client
    for (const r of [
      client.ROUTER_ABANDON_REASON,
      client.ROUTER_ABANDON_REASON + ' (x)',
      client.ROUTER_INJECT_GIVEUP_PREFIX + '3 attempts',
      client.ROUTER_DELIVERY_ERROR_PREFIX + 'boom',
      'Abandoned: peer unreachable',
      'Invalid or empty from_agent',
      '',
      null,
    ]) {
      expect(client.isRouterRecoverableFailure(r)).toBe(server.isRouterRecoverableFailure(r))
    }
  })
})
