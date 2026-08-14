/**
 * Slash-command parsing and ranking, without a browser.
 *
 *   node scripts/test-commands.mjs
 */
import {
  filterCommands,
  leadingCommand,
  parseSlash,
  rankCommands,
} from '../web/commands.js';

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

/* ---------- parseSlash ---------- */

check('plain text is never a command', parseSlash('hello', 5), null);
check('a slash mid-sentence is a path', parseSlash('look at /etc/hosts', 18), null);
check('opening slash, caret at end', parseSlash('/comp', 5), { query: 'comp', from: 0, to: 5 });
check('bare slash offers everything', parseSlash('/', 1), { query: '', from: 0, to: 1 });
check('caret inside the name', parseSlash('/compact', 4), { query: 'compact', from: 0, to: 8 });
check('caret past the name closes it', parseSlash('/compact now', 12), null);
check('caret at the space still closes', parseSlash('/compact ', 9), null);

check('leading command with args', leadingCommand('/rename my session'), 'rename');
check('leading command alone', leadingCommand('/context'), 'context');
check('bare slash is not a command yet', leadingCommand('/'), null);
check('prose has no command', leadingCommand('what is /compact'), null);

/* ---------- ranking ---------- */

const CATALOGUE = [
  { name: 'compact', description: 'Free up context by summarising', argumentHint: null, source: 'builtin' },
  { name: 'context', description: 'Show current context usage', argumentHint: null, source: 'builtin' },
  { name: 'config', description: 'Set a setting by key', argumentHint: 'key=value', source: 'builtin' },
  { name: 'clear', description: 'Start a new session', argumentHint: '[name]', source: 'builtin' },
  { name: 'copy', description: 'Copy the last response', argumentHint: null, source: 'builtin' },
  { name: 'deploy-check', description: 'Verify a deploy landed', argumentHint: null, source: 'skill' },
  { name: 'review:api', description: 'Review the API surface', argumentHint: '<path>', source: 'project' },
];

const names = (q) => rankCommands(q, CATALOGUE).map((c) => c.name);

check('exact name wins', names('context')[0], 'context');
// Prefix matches first, shortest first: the shortest name is the closest thing to
// what has actually been typed.
check('prefix beats interior', names('co').slice(0, 3), ['copy', 'config', 'compact']);
check('subsequence finds a skipped letter', names('cmp').includes('compact'), true);
check('description match is a last resort', names('summarising'), ['compact']);
check('two letters do not search descriptions', names('se').includes('clear'), false);
check(
  'custom commands lead an empty query',
  names('').slice(0, 2),
  ['review:api', 'deploy-check'],
);
check('no match is empty, not everything', names('zzz'), []);

/* ---------- help filter ---------- */

check(
  'the help filter searches descriptions',
  filterCommands('deploy', CATALOGUE).map((c) => c.name),
  ['deploy-check'],
);
check('an empty filter keeps everything', filterCommands('  ', CATALOGUE).length, CATALOGUE.length);

console.log(failures === 0 ? '\nall passed' : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
