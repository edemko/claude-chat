/**
 * Per-field limits for request bodies.
 *
 * readBody caps a whole JSON body at 256 KiB; that guards memory but says nothing a
 * user can act on, so each text field also has its own limit and an over-long value
 * is refused with a 400 naming the field — never silently cut.
 *
 * Lengths are counted in Unicode code points, so "Šťastná" is 7, not its UTF-8 size.
 */

/** Session names: single line, shown in the chat list and title bar. */
export const SESSION_NAME_MAX = 120;

/**
 * Messages typed into an agent's pane. 100 000 characters is far beyond anything
 * typed and comfortably holds a pasted log or file; beyond that, attach it instead.
 */
export const MESSAGE_MAX = 100_000;

/** Single-line: no control characters at all (\p{Cc} covers NUL, \t, \n, \r, DEL, ...). */
const SINGLE_LINE_BAD = /[\p{Cc}\u2028\u2029]/u;
/** Multi-line: \t, \n and \r are fine; NUL, ESC and the other C0 controls, and DEL are not. */
// ESC in particular would reach the terminal as a key sequence rather than text.
const MULTI_LINE_BAD = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

export type Checked<T> = { ok: true; value: T } | { ok: false; error: string };

function codePoints(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

/**
 * A session name: trimmed and NFC-normalised, then checked. An empty result is valid
 * and means "clear the name" (the automatic title returns), so it maps to null.
 */
export function checkSessionName(raw: unknown): Checked<string | null> {
  if (typeof raw !== 'string') return { ok: false, error: 'name must be a string' };
  const name = raw.trim().normalize('NFC');
  if (SINGLE_LINE_BAD.test(name)) {
    return { ok: false, error: 'name must be a single line without control characters' };
  }
  const len = codePoints(name);
  if (len > SESSION_NAME_MAX) {
    return {
      ok: false,
      error: `name is too long (${len} characters, max ${SESSION_NAME_MAX})`,
    };
  }
  return { ok: true, value: name || null };
}

/**
 * A message for the agent. Sent exactly as given — leading indentation or a trailing
 * newline can be meaningful in a paste — so it is checked, not trimmed or normalised.
 */
export function checkMessage(raw: unknown): Checked<string> {
  if (typeof raw !== 'string') return { ok: false, error: 'text must be a string' };
  if (!raw.trim()) return { ok: false, error: 'text is required' };
  if (MULTI_LINE_BAD.test(raw)) {
    return { ok: false, error: 'text contains control characters that cannot be sent' };
  }
  const len = codePoints(raw);
  if (len > MESSAGE_MAX) {
    return {
      ok: false,
      error: `message is too long (${len} characters, max ${MESSAGE_MAX})`,
    };
  }
  return { ok: true, value: raw };
}
