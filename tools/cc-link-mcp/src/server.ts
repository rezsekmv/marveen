#!/usr/bin/env bun
/**
 * cc-link: stdio MCP server + Claude Code channel.
 *
 * Links a Claude Code session on a laptop to the Marveen main agent through
 * the dashboard's message API: messages (optionally waiting for the answer),
 * answers to any of them, and messages the main agent initiates. Answers and
 * inbox messages are pushed with `notifications/claude/channel`; everything
 * pushed is also available via <prefix>_inbox, because a session that did not
 * load the server as a channel drops those notifications silently.
 *
 * stdout is the MCP transport: log to stderr only.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { loadConfig } from './config.ts'
import { buildInstructions, SERVER_NAME } from './instructions.ts'
import { createLink, MAX_TEXT } from './link.ts'
import { toolDefinitions } from './tools.ts'


const log = (msg: string) => process.stderr.write(`${SERVER_NAME}: ${msg}\n`)

process.on('unhandledRejection', err => log(`unhandled rejection: ${err}`))
process.on('uncaughtException', err => log(`uncaught exception: ${err}`))



const config = loadConfig()
const link = createLink(config, {
  log,
  notify: (content, meta) =>
    mcp.notification({ method: 'notifications/claude/channel', params: { content, meta } }),
})

const mcp = new Server(
  { name: SERVER_NAME, version: '0.1.0' },
  {
    capabilities: {
      tools: {},
      experimental: { 'claude/channel': {} },
    },
    instructions: buildInstructions(config.askWaitSec, link.tools),
  },
)

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: toolDefinitions(link.tools, MAX_TEXT, config.askWaitSec),
}))

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  const r = await link.callTool(req.params.name, (req.params.arguments ?? {}) as Record<string, unknown>)
  return { content: [{ type: 'text', text: r.text }], ...(r.isError ? { isError: true } : {}) }
})

// Run the startup sequence once the client has finished initializing, so the
// channel notifications it may push are not sent before the session listens.
let started = false
function runStartup(): void {
  if (started) return
  started = true
  void link
    .startup()
    .catch(err => log(`startup failed: ${err}`))
    .finally(() => link.startBackground())
}
mcp.oninitialized = runStartup

await mcp.connect(new StdioServerTransport())
log(
  `started (pid ${process.pid}${config.dryRun ? ', DRY RUN' : ''}; folder key ${link.deps.identity.folderKey})` +
    (config.errors.length ? `; NOT CONFIGURED: ${config.errors.join('; ')}` : ''),
)

let shuttingDown = false
function shutdown(): void {
  if (shuttingDown) return
  shuttingDown = true
  log('shutting down')
  link.stopBackground()
  setTimeout(() => process.exit(0), 1000)
  void mcp.close().finally(() => process.exit(0))
}
process.stdin.on('end', shutdown)
process.stdin.on('close', shutdown)
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
process.on('SIGHUP', shutdown)

// Orphan watchdog: belt-and-suspenders for the stdin handlers above.
setInterval(() => {
  if (process.stdin.destroyed || process.stdin.readableEnded) shutdown()
}, 5000).unref()
