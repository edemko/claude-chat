/**
 * Per-field request limits: session names and messages. No server needed.
 *
 *   npm run build && node scripts/test-validate.mjs
 */
import {
  MESSAGE_MAX,
  SESSION_NAME_MAX,
  checkMessage,
  checkSessionName,
} from '../dist/validate.js';

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

const ok = (value) => ({ ok: true, value });
const refused = (r) => (r.ok ? 'accepted' : r.error);

/* ---------- session names ---------- */

check('the limit is 120', SESSION_NAME_MAX, 120);
check('119 chars accepted', checkSessionName('a'.repeat(119)), ok('a'.repeat(119)));
check('120 chars accepted', checkSessionName('a'.repeat(120)), ok('a'.repeat(120)));
check(
  '121 chars refused, not truncated',
  refused(checkSessionName('a'.repeat(121))),
  'name is too long (121 characters, max 120)',
);
check('limit applies after trimming', checkSessionName(`  ${'a'.repeat(120)}  `), ok('a'.repeat(120)));
check('empty clears the name', checkSessionName(''), ok(null));
check('whitespace-only clears the name', checkSessionName('   '), ok(null));
check(
  'diacritics, apostrophes and hyphens kept',
  checkSessionName("  Ľudmila O'Brien-Šťastná ’s fix  "),
  ok("Ľudmila O'Brien-Šťastná ’s fix"),
);
check('NFC-normalised', checkSessionName('L\u030Cudmila'), ok('Ľudmila'));
check(
  'counted in code points, not UTF-16 units',
  checkSessionName('\u{1F600}'.repeat(120)).ok,
  true,
);
for (const [label, s] of [
  ['NUL', 'a\u0000b'],
  ['newline', 'a\nb'],
  ['CR', 'a\rb'],
  ['tab', 'a\tb'],
  ['DEL', 'a\u007Fb'],
  ['ESC', 'a\u001Bb'],
  ['U+2028', 'a\u2028b'],
  ['U+2029', 'a\u2029b'],
]) {
  check(
    `${label} refused in a name`,
    refused(checkSessionName(s)),
    'name must be a single line without control characters',
  );
}
for (const v of [null, undefined, 42, {}, ['x'], true]) {
  check(`name ${JSON.stringify(v) ?? 'undefined'} refused`, refused(checkSessionName(v)), 'name must be a string');
}

/* ---------- messages ---------- */

check('the message limit is 100 000', MESSAGE_MAX, 100_000);
check('limit-1 accepted', checkMessage('m'.repeat(MESSAGE_MAX - 1)).ok, true);
check('limit accepted', checkMessage('m'.repeat(MESSAGE_MAX)).ok, true);
check(
  'limit+1 refused, not truncated',
  refused(checkMessage('m'.repeat(MESSAGE_MAX + 1))),
  'message is too long (100001 characters, max 100000)',
);
check('sent verbatim, not trimmed', checkMessage('  indented\n\tcode\r\n'), ok('  indented\n\tcode\r\n'));
check('empty refused', refused(checkMessage('')), 'text is required');
check('whitespace-only refused', refused(checkMessage(' \n\t ')), 'text is required');
check('Unicode kept', checkMessage("Ľudmila O'Brien-Šťastná"), ok("Ľudmila O'Brien-Šťastná"));
for (const [label, s] of [
  ['NUL', 'a\u0000b'],
  ['ESC', 'a\u001Bb'],
  ['BEL', 'a\u0007b'],
  ['DEL', 'a\u007Fb'],
]) {
  check(
    `${label} refused in a message`,
    refused(checkMessage(s)),
    'text contains control characters that cannot be sent',
  );
}
for (const v of [null, undefined, 42, {}, ['x']]) {
  check(`text ${JSON.stringify(v) ?? 'undefined'} refused`, refused(checkMessage(v)), 'text must be a string');
}

console.log(failures === 0 ? '\nall passed' : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
