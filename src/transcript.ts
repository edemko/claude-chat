/**
 * Reading transcripts as files.
 *
 * Nothing here knows what a record *means* — that is each provider's business, passed
 * in as `toEvents`. What lives here is the part both providers share: an append-only
 * JSONL file, read in byte windows from the end so opening a chat does not convert a
 * megabyte of history nobody scrolls to.
 */

import type { Executor } from './exec.js';
import { q } from './shell.js';
import type { ChatEvent, ToEvents } from './types.js';

export interface Candidate {
  path: string;
  uuid: string;
  birth: number;   // epoch seconds; 0 when the filesystem has no birth time
  mtime: number;   // epoch seconds
  size: number;
}

/** Every `*.jsonl` in a directory, with the stat fields inference needs. */
export async function listTranscripts(exec: Executor, dir: string): Promise<Candidate[]> {
  // %W birth, %Y mtime, %s size, %n name. Nullglob guard keeps an empty dir quiet.
  const cmd = `setopt NULL_GLOB 2>/dev/null; stat -c '%W|%Y|%s|%n' ${q(dir)}/*.jsonl 2>/dev/null || true`;
  const { stdout } = await exec.runShell(cmd);
  const out: Candidate[] = [];
  for (const line of stdout.split('\n')) {
    const parts = line.trim().split('|');
    if (parts.length < 4) continue;
    const path = parts.slice(3).join('|');
    const base = path.split('/').pop() ?? '';
    out.push({
      path,
      uuid: base.replace(/\.jsonl$/, ''),
      birth: Number(parts[0]) || 0,
      mtime: Number(parts[1]) || 0,
      size: Number(parts[2]) || 0,
    });
  }
  return out;
}

/** Read the tail of a transcript and parse whole JSONL records. */
export async function readRecords(
  exec: Executor,
  path: string,
  tailBytes = 400_000,
): Promise<Record<string, unknown>[]> {
  const { stdout } = await exec.run(['tail', '-c', String(tailBytes), path], {
    timeoutMs: 20_000,
  });
  return parseRecords(stdout, tailBytes > 0);
}

/**
 * `dropFirst` discards the leading line when the read started mid-file, since a
 * byte-offset tail almost always slices the first record in half.
 */
export function parseRecords(text: string, dropFirst: boolean): Record<string, unknown>[] {
  const lines = text.split('\n');
  if (dropFirst && lines.length > 1) lines.shift();
  const out: Record<string, unknown>[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed && typeof parsed === 'object') out.push(parsed as Record<string, unknown>);
    } catch {
      // Partial trailing write, or a slice boundary — skip.
    }
  }
  return out;
}

/** One page of history, oldest-first, with a cursor for fetching what precedes it. */
export interface HistoryPage {
  events: ChatEvent[];
  /** Byte offset to pass back as `before`. 0 means the file's start was reached. */
  cursor: number;
  hasMore: boolean;
}

/** Enough for a screenful; grown geometrically when a window yields too few events. */
const INITIAL_WINDOW = 48_000;
const MAX_WINDOW = 1_500_000;

async function fileSize(exec: Executor, path: string): Promise<number> {
  const { stdout } = await exec.run(['stat', '-c', '%s', path]);
  return Number(stdout.trim()) || 0;
}

/** Read bytes `[start, start + length)` of a file. */
async function readWindow(
  exec: Executor,
  path: string,
  start: number,
  length: number,
): Promise<string> {
  const { stdout } = await exec.runShell(
    `tail -c +${start + 1} ${q(path)} 2>/dev/null | head -c ${length}`,
    { timeoutMs: 25_000 },
  );
  return stdout;
}

/**
 * Read one page of history ending at `before`, newest page first.
 *
 * Opening a chat used to convert the whole tail of a 2 MB transcript, which is slow
 * on a phone and mostly wasted — you start at the bottom. This reads a small window
 * from the end instead, and hands back a byte offset so scrolling up can fetch the
 * preceding window.
 *
 * The cursor is always the byte offset of a record boundary, so the next read ends
 * cleanly and only the *first* line of a window is ever partial.
 */
export async function historyPage(
  exec: Executor,
  path: string,
  toEvents: ToEvents,
  opts: { before?: number; limit?: number } = {},
): Promise<HistoryPage> {
  const limit = Math.max(1, Math.min(opts.limit ?? 60, 500));
  const size = await fileSize(exec, path);
  const end = opts.before !== undefined && opts.before > 0 ? Math.min(opts.before, size) : size;
  if (end <= 0) return { events: [], cursor: 0, hasMore: false };

  let window = INITIAL_WINDOW;
  for (;;) {
    const start = Math.max(0, end - window);
    const chunk = await readWindow(exec, path, start, end - start);

    // Byte offsets, not string indices: these transcripts contain multi-byte text.
    const lines: Array<{ offset: number; text: string }> = [];
    let offset = start;
    for (const text of chunk.split('\n')) {
      lines.push({ offset, text });
      offset += Buffer.byteLength(text, 'utf8') + 1; // +1 for the newline
    }
    // A window that does not begin at byte 0 begins mid-record.
    if (start > 0) lines.shift();

    const collected: Array<{ offset: number; event: ChatEvent }> = [];
    for (const line of lines) {
      if (!line.text.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line.text);
      } catch {
        continue;
      }
      if (!parsed || typeof parsed !== 'object') continue;
      for (const event of toEvents(parsed as Record<string, unknown>)) {
        collected.push({ offset: line.offset, event });
      }
    }

    // Only bubbles and tool chips occupy space; results and titles ride along.
    const renderable = collected.filter(
      (c) => c.event.kind !== 'tool_result' && c.event.kind !== 'title',
    );

    const exhausted = start === 0 || window >= MAX_WINDOW;
    if (renderable.length >= limit || exhausted) {
      const firstKept =
        renderable.length > limit
          ? renderable[renderable.length - limit]!.offset
          : (collected[0]?.offset ?? start);
      // Everything from that record onward, so a tool_result stays with its chip.
      const events = collected.filter((c) => c.offset >= firstKept).map((c) => c.event);
      return { events, cursor: firstKept, hasMore: firstKept > 0 };
    }

    window = Math.min(window * 4, MAX_WINDOW);
  }
}


/** mtime and size of one file, for a session whose transcript path is already known. */
export async function statFile(
  exec: Executor,
  path: string,
): Promise<{ mtime: number; size: number } | null> {
  const { stdout, code } = await exec.run(['stat', '-c', '%Y|%s', path]);
  if (code !== 0) return null;
  const [mtime, size] = stdout.trim().split('|');
  return { mtime: Number(mtime) || 0, size: Number(size) || 0 };
}
