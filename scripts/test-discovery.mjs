/**
 * The two pure decisions worth pinning down, without touching a live tmux server.
 *
 *   node scripts/test-discovery.mjs
 *
 * Run `npm run build` first — this imports from dist/.
 */
import { dedupeByTranscript } from '../dist/discovery.js';
import { extractStatusLine } from '../dist/info.js';

let failures = 0;

function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}\n         got ${a}\n    expected ${b}`);
  }
}

function session(over) {
  return {
    serverId: 'sam',
    uuid: 'u',
    transcript: '/t/a.jsonl',
    paneId: '%0',
    tmuxSession: 'w',
    pid: 100,
    cwd: '/repo',
    title: 't',
    status: 'idle',
    confidence: 'weak',
    lastActivity: 1,
    lastMessage: null,
    skipPermissions: null,
    ...over,
  };
}

console.log('dedupeByTranscript');

check(
  'two panes on one transcript collapse to a single conversation',
  dedupeByTranscript([
    session({ paneId: '%0', pid: 100 }),
    session({ paneId: '%2', pid: 200 }),
  ]).map((s) => s.paneId),
  ['%2'],
);

check(
  'the better-evidenced pane wins regardless of order',
  dedupeByTranscript([
    session({ paneId: '%0', pid: 900, confidence: 'weak' }),
    session({ paneId: '%2', pid: 100, confidence: 'exact' }),
  ]).map((s) => s.paneId),
  ['%2'],
);

check(
  'distinct transcripts are both kept, even with identical titles',
  dedupeByTranscript([
    session({ paneId: '%0', transcript: '/t/a.jsonl', title: 'implementing MEGA bucket' }),
    session({ paneId: '%2', transcript: '/t/b.jsonl', title: 'implementing MEGA bucket' }),
  ]).map((s) => s.paneId).sort(),
  ['%0', '%2'],
);

check(
  'sessions with no transcript are never folded together',
  dedupeByTranscript([
    session({ paneId: '%0', transcript: '', uuid: 'pane-0', confidence: 'pending' }),
    session({ paneId: '%2', transcript: '', uuid: 'pane-2', confidence: 'pending' }),
  ]).map((s) => s.paneId).sort(),
  ['%0', '%2'],
);

check('an empty list stays empty', dedupeByTranscript([]), []);

console.log('extractStatusLine');

// Shape of a real pane: input box, status line (wrapped onto two rows), hint line.
const screen = [
  '  Some assistant text that scrolled by',
  '',
  '────────────────────────────────',
  '❯ ',
  '────────────────────────────────',
  '  my-clinic   ·   ⎇ main   ·   Opus 5 1M/high   ·   ctx 21%  212k/1M   ·   ⏱ 39h30m',
  '  5h 5%  ↻ Wed 22:00   ·   7d 7%  ↻ Wed 12:00',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents',
  '',
].join('\n');

check('both wrapped rows are returned, in order', extractStatusLine(screen), [
  'my-clinic   ·   ⎇ main   ·   Opus 5 1M/high   ·   ctx 21%  212k/1M   ·   ⏱ 39h30m',
  '5h 5%  ↻ Wed 22:00   ·   7d 7%  ↻ Wed 12:00',
]);

check(
  'the input box is not mistaken for the status line',
  extractStatusLine(['────', '❯ hello · world', '────', '  ⏵⏵ bypass permissions on'].join('\n')),
  [],
);

check(
  'no status line configured yields nothing rather than a guess',
  extractStatusLine(['  assistant text', '', '  ⏵⏵ bypass permissions on'].join('\n')),
  [],
);

check('an empty screen yields nothing', extractStatusLine(''), []);

console.log(failures === 0 ? '\nall passed' : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
