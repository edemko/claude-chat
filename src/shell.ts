/** POSIX single-quote quoting. Safe for embedding arbitrary text in a shell command. */
export function q(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Quote an argv into one shell command string. */
export function qq(argv: readonly string[]): string {
  return argv.map(q).join(' ');
}

/**
 * Normalise text for fuzzy matching against terminal output.
 *
 * The Claude Code TUI hard-wraps long lines and decorates them with box-drawing
 * characters and a `>` prompt marker, so a literal substring match against
 * `capture-pane` output fails. Stripping everything but alphanumerics makes the
 * comparison survive wrapping and decoration.
 */
export function normaliseForMatch(s: string): string {
  return s.replace(/[^a-z0-9]/gi, '').toLowerCase();
}
