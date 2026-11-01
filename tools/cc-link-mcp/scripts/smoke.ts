/**
 * Dry-run smoke check: spawn the server with CC_LINK_DRY_RUN=1, speak
 * JSON-RPC over stdio (initialize, tools/list, tools/call tony_note), close
 * stdin and verify the process exits. No network is touched.
 *
 *   bun scripts/smoke.ts
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const stateDir = mkdtempSync(join(tmpdir(), 'cc-link-smoke-'))
const proc = Bun.spawn(['bun', join(import.meta.dir, '..', 'src', 'server.ts')], {
  stdin: 'pipe',
  stdout: 'pipe',
  stderr: 'pipe',
  env: {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    CC_LINK_DRY_RUN: '1',
    CC_LINK_STATE_DIR: stateDir,
    MARVEEN_URL: 'https://mini-host.invalid:3420',
    MARVEEN_SENDER_ID: 'laptop-sender',
    MARVEEN_MAIN_AGENT: 'main-agent',
  },
})

async function send(msg: unknown): Promise<void> {
  proc.stdin.write(JSON.stringify(msg) + '\n')
  await proc.stdin.flush()
}
const responses = new Map<number, any>()
const reader = (async () => {
  const dec = new TextDecoder()
  let buf = ''
  for await (const chunk of proc.stdout) {
    buf += dec.decode(chunk)
    let i: number
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (!line) continue
      const msg = JSON.parse(line)
      if (typeof msg.id === 'number') responses.set(msg.id, msg)
    }
  }
})()

async function waitFor(id: number, ms = 5000): Promise<any> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (responses.has(id)) return responses.get(id)
    await Bun.sleep(25)
  }
  throw new Error(`no response for id ${id}`)
}

let ok = true
const check = (cond: boolean, label: string) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}`)
  if (!cond) ok = false
}

await send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } } })
const init = await waitFor(1)
check(init.result?.serverInfo?.name === 'cc-link', 'initialize: server name')
check(init.result?.capabilities?.experimental?.['claude/channel'] !== undefined, 'initialize: claude/channel capability')
check(typeof init.result?.instructions === 'string', 'initialize: instructions present')
await send({ jsonrpc: '2.0', method: 'notifications/initialized' })

await send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
const list = await waitFor(2)
const names = (list.result?.tools ?? []).map((t: { name: string }) => t.name).sort()
check(JSON.stringify(names) === JSON.stringify(['tony_ask', 'tony_inbox', 'tony_note', 'tony_reply']), `tools/list: ${names.join(', ')}`)

await send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'tony_note', arguments: { text: 'smoke test note' } } })
const call = await waitFor(3)
const text: string = call.result?.content?.[0]?.text ?? ''
console.log('--- tony_note result ---\n' + text + '\n------------------------')
check(!call.result?.isError, 'tony_note: not an error')
check(text.includes('DRY RUN') && text.includes('POST /api/messages'), 'tony_note: dry-run request shown')
check(text.includes('Bearer <redacted>'), 'tony_note: auth redacted')
check(text.includes('[Claude Code összefoglaló]') && text.includes('Nem kell válasz.'), 'tony_note: Hungarian header')

await send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'tony_note', arguments: { text: 'key ' + 'AKIA' + 'ABCDEFGHIJKLMNOP here' } } })
const blocked = await waitFor(4)
check(blocked.result?.isError === true && String(blocked.result?.content?.[0]?.text).includes('aws_access_key_id'), 'tony_note: secret blocked')

proc.stdin.end()
const exitCode = await Promise.race([proc.exited, Bun.sleep(5000).then(() => 'timeout' as const)])
check(exitCode === 0, `exits on stdin close (exit ${exitCode})`)
if (exitCode === 'timeout') proc.kill()
await reader.catch(() => {})
const stderr = await new Response(proc.stderr).text()
console.log('--- stderr ---\n' + stderr.trim())
rmSync(stateDir, { recursive: true, force: true })
process.exit(ok ? 0 : 1)
