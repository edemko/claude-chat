/**
 * The Codex provider's pure parts, against real record shapes.
 *
 *   node scripts/test-codex.mjs
 *
 * The fixtures below are trimmed from an actual rollout file, not invented — the
 * inconsistencies are the point. `UserMessage` blocks are `{type:"text"}` while
 * `AgentMessage` blocks are `{type:"Text"}`, and `FileChange.changes` is an object
 * keyed by path rather than the array its name suggests. Both of those shapes broke
 * a first implementation that guessed.
 */
import {
  recordToEvents,
  titleFromFirstMessage,
  uuidFromRollout,
} from '../dist/providers/codex.js';

let failures = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    failures += 1;
    console.log(`FAIL ${name}\n  expected: ${e}\n  actual:   ${a}`);
  } else {
    console.log(`ok   ${name}`);
  }
}

const item = (it, at = 1786698888464) => ({
  timestamp: '2026-08-14T09:14:48.464Z',
  type: 'event_msg',
  payload: { type: 'item_completed', started_at_ms: at, completed_at_ms: at, item: it },
});

/* ---------- the rollout filename ---------- */

check(
  'the uuid comes off the filename, not the timestamp in it',
  uuidFromRollout(
    '/home/you/.codex/sessions/2026/08/14/rollout-2026-08-14T11-10-14-019fff89-482a-7fd0-a7c8-3381a4cd96fd.jsonl',
  ),
  '019fff89-482a-7fd0-a7c8-3381a4cd96fd',
);
check('a non-rollout path yields nothing', uuidFromRollout('/tmp/notes.jsonl'), null);

/* ---------- messages ---------- */

check(
  'a user message, whose blocks are lowercase "text"',
  recordToEvents(item({ type: 'UserMessage', id: 'u1', content: [{ type: 'text', text: 'hello' }] })),
  [{ kind: 'user', id: 'u1', ts: 1786698888464, text: 'hello' }],
);

check(
  'an agent message, whose blocks are capitalised "Text"',
  recordToEvents(item({ type: 'AgentMessage', id: 'a1', content: [{ type: 'Text', text: 'hi' }], phase: 'final_answer' })),
  [{ kind: 'assistant', id: 'a1', ts: 1786698888464, text: 'hi' }],
);

check(
  'commentary is still an assistant message',
  recordToEvents(item({ type: 'AgentMessage', id: 'a2', content: [{ type: 'Text', text: 'thinking aloud' }], phase: 'commentary' })).map((e) => e.kind),
  ['assistant'],
);

check(
  'empty Reasoning items are dropped, not rendered blank',
  recordToEvents(item({ type: 'Reasoning', id: 'r1', summary_text: [], raw_content: [] })),
  [],
);

/* ---------- tool calls ---------- */

const exec = recordToEvents(
  item({
    type: 'CommandExecution',
    id: 'exec-1',
    command: ['/usr/bin/zsh', '-lc', 'npm run lint'],
    parsed_cmd: [{ type: 'unknown', cmd: 'npm run lint' }],
    status: 'completed',
    exit_code: 1,
    aggregated_output: 'boom\n',
  }),
);
check('a command yields a chip and its result together', exec.map((e) => e.kind), ['tool', 'tool_result']);
check('the zsh -lc wrapper is stripped from the label', exec[0].summary, 'npm run lint');
check('a non-zero exit is a failed result', exec[1].ok, false);
check('the result attaches to the chip', exec[1].toolUseId, exec[0].id);

const running = recordToEvents(
  item({ type: 'CommandExecution', id: 'exec-2', command: ['ls'], status: 'running' }),
);
check('a running command has no result yet', running.map((e) => e.kind), ['tool']);

const edit = recordToEvents(
  item({
    type: 'FileChange',
    id: 'fc-1',
    status: 'completed',
    changes: {
      '/home/you/Dev/app/src/main.ts': { type: 'update', unified_diff: '@@ -1 +1 @@\n-a\n+b\n' },
      '/home/you/Dev/app/src/util.ts': { type: 'update', unified_diff: '@@ -2 +2 @@\n' },
    },
  }),
);
check('an edit is labelled with filenames, not raw JSON', edit[0].summary, 'main.ts, util.ts');
check('the diffs become the chip output', edit[1].preview.includes('@@ -1 +1 @@'), true);

check(
  'four or more edited files collapse',
  recordToEvents(
    item({
      type: 'FileChange',
      id: 'fc-2',
      changes: { '/a/one.ts': {}, '/a/two.ts': {}, '/a/three.ts': {}, '/a/four.ts': {} },
    }),
  )[0].summary,
  'one.ts, two.ts, three.ts +1 more',
);

check(
  'a web search becomes a chip named after its kind',
  recordToEvents(item({ type: 'Extension', id: 'x1', kind: 'web.search', query: 'supabase changelog' })),
  [{ kind: 'tool', id: 'x1', ts: 1786698888464, name: 'web.search', summary: 'supabase changelog', input: { type: 'Extension', id: 'x1', kind: 'web.search', query: 'supabase changelog' } }],
);

check(
  'an unknown item type is still shown, labelled with its kind',
  recordToEvents(item({ type: 'SomethingNew', id: 'n1' })).map((e) => [e.kind, e.name]),
  [['tool', 'SomethingNew']],
);

/* ---------- what is not an event ---------- */

check(
  'response_item records are ignored: item_completed is the stream to read',
  recordToEvents({ type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'system prompt' }] } }),
  [],
);
check('turn_context is not a message', recordToEvents({ type: 'turn_context', payload: { cwd: '/x' } }), []);
check('token_count is not a message', recordToEvents({ type: 'event_msg', payload: { type: 'token_count', info: {} } }), []);

/* ---------- titles ---------- */

const long =
  'pull the latest code, ensure the git is up to date and clean.  i want to add new '
  + 'section in left side manu called tracking. this should be tree structure';
check(
  'a long brief is cut at its first sentence',
  titleFromFirstMessage(long, 'kestrek'),
  'pull the latest code, ensure the git is up to date and clean',
);
check('a short message is used whole', titleFromFirstMessage('fix the build', 'repo'), 'fix the build');
check('an empty message falls back to the repo', titleFromFirstMessage('   ', 'kestrek'), 'kestrek');
// A too-short first sentence is discarded in favour of the whole message, which is
// then used verbatim — punctuation included, since nothing was cut off it.
check(
  'a very short first sentence does not win over the rest',
  titleFromFirstMessage('Hi. Please refactor the tracking service to use the new schema.', 'repo'),
  'Hi. Please refactor the tracking service to use the new schema.',
);
check(
  'a single unpunctuated wall of text is hard-capped',
  titleFromFirstMessage('x'.repeat(200), 'repo').length,
  72,
);
check('newlines collapse rather than truncating the title', titleFromFirstMessage('do a thing\nand another', 'r'), 'do a thing and another');

console.log(failures === 0 ? '\nall passed' : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
