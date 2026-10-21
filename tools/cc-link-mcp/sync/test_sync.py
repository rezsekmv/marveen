"""Self-check for sync.py's pure helpers: python3 test_sync.py"""
import json, os, sys, tempfile

os.environ['CC_LINK_SYNC_DIR'] = tempfile.mkdtemp()
os.environ['CC_LINK_SYNC_CATEGORIES'] = 'WORK=/w,HOME=/h/'  # trailing slash is normalized
sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
import sync  # noqa: E402


def entry(kind, content, ts, **extra):
    return json.dumps({'type': kind, 'timestamp': ts, 'cwd': '/w/repo', 'message': {'content': content}, **extra})


lines = [
    entry('user', 'first question', '2026-01-01T10:00:00.000Z'),
    entry('assistant', [{'type': 'text', 'text': 'first answer'}, {'type': 'tool_use'}], '2026-01-01T10:01:00.000Z'),
    entry('user', '<command-name>/clear</command-name>', '2026-01-02T09:00:00.000Z'),
    entry('user', 'meta', '2026-01-02T09:00:01.000Z', isMeta=True),
    entry('user', [{'type': 'tool_result', 'content': 'tool output'}], '2026-01-02T09:04:00.000Z'),
    entry('user', [{'type': 'image'}, {'type': 'text', 'text': 'pasted question'}], '2026-01-02T09:04:30.000Z'),
    entry('user', 'second question', '2026-01-02T09:05:00.000Z'),
]

# start line: logged count wins, else SINCE, else the beginning
assert sync.start_line(lines, 3) == 3
assert sync.start_line(lines, 0) == 0
sync.SINCE = '2026-01-02'
assert sync.start_line(lines, 0) == 2
sync.SINCE = ''

# idle is measured from the newest entry, not the file mtime
assert sync.last_activity(lines) == 1767344700.0
assert sync.last_activity(['{}']) == 0
assert sync.last_activity([lines[0], '{"timestamp":"not-a-date"}']) == 1767261600.0  # unparsable: older entry

# extract keeps prompts and prose, drops tool calls, slash-command noise and meta entries
text, cwd, ts = sync.extract(lines, 0)
assert cwd == '/w/repo' and ts == '2026-01-01T10:00:00.000Z'
assert 'first question' in text and 'first answer' in text and 'second question' in text
assert '/clear' not in text and 'meta' not in text and 'tool output' not in text
assert 'pasted question' in text  # prompts stored as content-block lists
text, _, ts = sync.extract(lines, 2)
assert 'first' not in text and ts == '2026-01-02T09:00:00.000Z'

# categories match whole path components only
assert sync.category('/w/repo') == 'WORK' and sync.category('/w') == 'WORK'
assert sync.category('/h/x') == 'HOME' and sync.category('/wx') == 'OTHER' and sync.category(None) == 'OTHER'

# covered: highest count per session; rows without a count give 0
with open(sync.LOG, 'w') as fh:
    fh.write('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa\t2026-01-01\tWORK\tsent\t1\t40\n'
             'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa\t2026-01-02\tWORK\tsent\t2\t90\n'
             'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb\t2026-01-01\tHOME\tskipped\t-\n'
             'cccccccc-cccc-cccc-cccc-cccccccccccc\t2026-01-01\tHOME\tskipped\t-\t70\n'
             'dddddddd-dddd-dddd-dddd-dddddddddddd\t2026-01-01\tHOME\tsent\tqueued\t12\n'
             'not-a-session\t-\t-\tsent\t3\n')
assert sync.covered() == {'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa': (90, True), 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb': (0, False),
                          'cccccccc-cccc-cccc-cccc-cccccccccccc': (70, False), 'dddddddd-dddd-dddd-dddd-dddddddddddd': (12, True)}

# sent ids come from the tool result, never from the model's own text
stream = '\n'.join([
    json.dumps({'type': 'assistant', 'message': {'content': [{'type': 'text', 'text': 'SENT 999'}]}}),
    json.dumps({'type': 'user', 'message': {'content': [{'type': 'tool_result', 'content': [{'type': 'text', 'text': 'sent (id 42). An answer ...'}]}]}}),
    'not json',
    json.dumps({'type': 'result', 'result': 'Sent!'}),
])
assert sync.parse_stream(stream) == (['42'], 'Sent!')
assert sync.parse_stream('') == ([], '')
queued = json.dumps({'type': 'user', 'message': {'content': [{'type': 'tool_result', 'content': 'queued in outbox (timeout), will retry.'}]}})
assert sync.parse_stream(queued) == (['queued'], '')
assert sync.has_line('x\n SKIP \n', 'SKIP') and sync.has_line('`SKIP`.', 'SKIP') and sync.has_line('**NOOP**', 'NOOP')
assert not sync.has_line('I will not SKIP this', 'SKIP')

# the lockdown check accepts only cc-link tools and servers
sync.check_lockdown({'tools': ['mcp__cc-link__agent_message'], 'mcp_servers': [{'name': 'cc-link'}]})
for bad in ({'tools': ['Bash', 'mcp__cc-link__agent_message'], 'mcp_servers': [{'name': 'cc-link'}]},
            {'tools': ['mcp__cc-link__agent_message'], 'mcp_servers': [{'name': 'cc-link'}, {'name': 'other'}]},
            {'tools': [], 'mcp_servers': [{'name': 'cc-link'}]}):
    try:
        sync.check_lockdown(bad)
        raise AssertionError(bad)
    except RuntimeError:
        pass

# folder key matches the MCP server's identity.ts (sha256 of the realpath, 8 hex chars)
assert sync.folder_key('/') == '8a5edab2'

print('ok')
