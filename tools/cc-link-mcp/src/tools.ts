/**
 * Tool names and definitions (pure). The names carry a prefix from
 * CC_LINK_AGENT_NAME (see config.ts): CC_LINK_AGENT_NAME=<name> gives
 * <name>_message; unset, they are agent_message / agent_reply / agent_inbox.
 */

export interface ToolNames {
  message: string
  reply: string
  inbox: string
}

export function toolNames(prefix: string): ToolNames {
  return { message: `${prefix}_message`, reply: `${prefix}_reply`, inbox: `${prefix}_inbox` }
}

/** Suffixes of the tools <prefix>_message replaced; a call to one gets a pointer to the new tool. */
export const REMOVED_SUFFIXES = ['_note', '_ask'] as const

export interface ToolDefinition {
  name: string
  description: string
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] }
}

export function toolDefinitions(names: ToolNames, maxText: number, waitSec: number): ToolDefinition[] {
  return [
    {
      name: names.message,
      description:
        'Send the main agent a message (a summary, a note or a question). By default it returns at once with the message id; ' +
        `with wait=true it waits up to ${waitSec} s for the answer. A later answer arrives as a channel event or via ` +
        `${names.reply} / ${names.inbox}. Queued and retried if the dashboard is unreachable.`,
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: `The message, at most ${maxText} characters. No secrets.` },
          wait: {
            type: 'boolean',
            description: `true: wait up to ${waitSec} s for the answer (for a question). Default false.`,
          },
        },
        required: ['text'],
      },
    },
    {
      name: names.reply,
      description:
        `Fetch the state of one of this folder's messages by id: still waiting, read without an answer, or the answer.`,
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'integer', description: `The message id returned by ${names.message}.` },
        },
        required: ['id'],
      },
    },
    {
      name: names.inbox,
      description:
        'List what this session received from the main agent, sent messages still waiting for an answer, and messages waiting for the next new session in this folder.',
      inputSchema: { type: 'object', properties: {} },
    },
  ]
}
