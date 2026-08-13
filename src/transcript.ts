import type { Executor } from './exec.js';
import { q } from './shell.js';
import type { ChatEvent } from './types.js';

/**
 * Claude Code derives a project directory name from the cwd by replacing both
 * path separators and dots with hyphens:
 *   /home/you/Dev/my-clinic  -> -home-you-Dev-my-clinic
 *   /home/you/.config           -> -home-you--config
 */
export function slugFor(cwd: string): string {
  return cwd.replace(/[/.]/g, '-');
}

export function projectDirFor(home: string, cwd: string): string {
  return `${home}/.claude/projects/${slugFor(cwd)}`;
}

export interface Candidate {
  path: string;
  uuid: string;
  birth: number;   // epoch seconds; 0 when the filesystem has no birth time
  mtime: number;   // epoch seconds
  size: number;
}

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
      for (const event of recordToEvents(parsed as Record<string, unknown>)) {
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

/** Wrapper text Claude Code injects that should never appear as a chat bubble. */
function isNoiseText(text: string): boolean {
  const t = text.trimStart();
  return (
    t.startsWith('<local-command-caveat>') ||
    t.startsWith('<command-name>') ||
    t.startsWith('<command-message>') ||
    t.startsWith('<system-reminder>') ||
    t.startsWith('Caveat: The messages below') ||
    t.includes('<local-command-stdout>')
  );
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === 'object' && (block as { type?: string }).type === 'text') {
      const t = (block as { text?: unknown }).text;
      if (typeof t === 'string') parts.push(t);
    }
  }
  return parts.join('\n');
}

function oneLine(s: string, max = 100): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Short, scannable label for a tool chip. */
function toolSummary(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const pick = (k: string): string => (typeof i[k] === 'string' ? (i[k] as string) : '');
  switch (name) {
    case 'Bash':
      return oneLine(pick('command'));
    case 'Read':
    case 'Write':
    case 'NotebookEdit':
      return oneLine(pick('file_path'));
    case 'Edit':
      return oneLine(pick('file_path'));
    case 'Grep':
      return oneLine([pick('pattern'), pick('path')].filter(Boolean).join('  in  '));
    case 'Glob':
      return oneLine(pick('pattern'));
    case 'Task':
    case 'Agent':
      return oneLine(pick('description') || pick('prompt'));
    case 'WebFetch':
      return oneLine(pick('url'));
    case 'WebSearch':
      return oneLine(pick('query'));
    case 'TodoWrite':
      return 'update task list';
    default:
      return oneLine(JSON.stringify(i), 80);
  }
}

function resultPreview(content: unknown): string {
  if (typeof content === 'string') return oneLine(content, 400);
  if (Array.isArray(content)) return oneLine(textFromContent(content), 400);
  return '';
}

/**
 * Convert one transcript record into zero or more chat events.
 *
 * Sidechain records belong to subagents and would interleave confusingly with the
 * main thread, so they are dropped. Meta records and the wrapper text Claude Code
 * injects around local commands are dropped too.
 */
export function recordToEvents(rec: Record<string, unknown>): ChatEvent[] {
  const type = rec['type'];
  if (rec['isSidechain'] === true) return [];

  const ts = typeof rec['timestamp'] === 'string' ? Date.parse(rec['timestamp'] as string) : 0;
  const baseId = typeof rec['uuid'] === 'string' ? (rec['uuid'] as string) : `${type}-${ts}`;

  /*
   * Two sources of session name:
   *   ai-title      the auto-generated summary
   *   custom-title  what /rename set
   *
   * Claude Code writes BOTH on every turn, with ai-title *after* custom-title, so
   * "whichever is later in the file" would always discard the rename. A custom title
   * therefore outranks the automatic one regardless of position; `custom` carries
   * that so clients can apply the same rule to live events.
   */
  if (type === 'ai-title' || type === 'custom-title') {
    const raw = type === 'custom-title' ? rec['customTitle'] : rec['aiTitle'];
    if (typeof raw !== 'string' || !raw.trim()) return [];
    const title = raw.trim();
    const custom = type === 'custom-title';
    // ai-title/custom-title records carry neither uuid nor timestamp, so keying off
    // baseId gave every title the same id.
    return [{ kind: 'title', id: `title-${custom ? 'c' : 'a'}-${title}`, ts, title, custom }];
  }

  if (type !== 'user' && type !== 'assistant') return [];
  if (rec['isMeta'] === true) return [];

  const message = rec['message'] as Record<string, unknown> | undefined;
  if (!message) return [];
  const content = message['content'];
  const events: ChatEvent[] = [];

  if (type === 'user') {
    // A user record carrying tool_result blocks is Claude's own tool plumbing,
    // not something the human typed.
    if (Array.isArray(content)) {
      let idx = 0;
      for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        const b = block as Record<string, unknown>;
        if (b['type'] === 'tool_result' && typeof b['tool_use_id'] === 'string') {
          events.push({
            kind: 'tool_result',
            id: `${baseId}-r${idx++}`,
            ts,
            toolUseId: b['tool_use_id'] as string,
            ok: b['is_error'] !== true,
            preview: resultPreview(b['content']),
          });
        }
      }
      if (events.length > 0) return events;
    }
    const text = textFromContent(content);
    if (!text.trim() || isNoiseText(text)) return [];
    return [{ kind: 'user', id: baseId, ts, text: text.trim() }];
  }

  if (!Array.isArray(content)) {
    const text = textFromContent(content);
    return text.trim() ? [{ kind: 'assistant', id: baseId, ts, text: text.trim() }] : [];
  }

  let idx = 0;
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as Record<string, unknown>;
    const id = `${baseId}-${idx++}`;
    switch (b['type']) {
      case 'text': {
        const t = typeof b['text'] === 'string' ? (b['text'] as string) : '';
        if (t.trim()) events.push({ kind: 'assistant', id, ts, text: t.trim() });
        break;
      }
      case 'thinking':
        // Reasoning is not shown: the chat mirrors what a normal Claude Code
        // session prints, which is assistant text and tool calls.
        break;
      case 'tool_use': {
        const name = typeof b['name'] === 'string' ? (b['name'] as string) : 'tool';
        events.push({
          kind: 'tool',
          // Use the tool_use id so tool_result events can attach to this chip.
          id: typeof b['id'] === 'string' ? (b['id'] as string) : id,
          ts,
          name,
          summary: toolSummary(name, b['input']),
          input: b['input'],
        });
        break;
      }
      default:
        break;
    }
  }
  return events;
}

function unescapeJsonString(raw: string): string {
  try {
    // Re-parse so JSON escapes (\n, \", \uXXXX) come back as real characters.
    return JSON.parse(`"${raw}"`) as string;
  } catch {
    return raw;
  }
}

/**
 * The session's name, scanning the whole file.
 *
 * Titles are written rarely, so they usually fall outside the tail window that
 * everything else is read from — but the name is how a person recognises which
 * conversation they are looking at, so it is worth a dedicated scan. A `/rename`
 * (custom-title) always wins over the auto-generated ai-title.
 */
export async function readLastTitle(exec: Executor, path: string): Promise<string | null> {
  const { stdout } = await exec.runShell(
    `grep -o '"customTitle":"[^"]*"' ${q(path)} 2>/dev/null | tail -1; ` +
      `grep -o '"aiTitle":"[^"]*"' ${q(path)} 2>/dev/null | tail -1`,
  );
  const custom = /"customTitle":"(.*)"/.exec(stdout);
  if (custom?.[1]) return unescapeJsonString(custom[1]);
  const ai = /"aiTitle":"(.*)"/.exec(stdout);
  return ai?.[1] ? unescapeJsonString(ai[1]) : null;
}

export interface TranscriptSummary {
  /** Resolved name: a `/rename` if there is one, otherwise the automatic title. */
  aiTitle: string | null;
  /** Set only by `/rename`; takes precedence over the automatic title. */
  customTitle: string | null;
  lastUserText: string | null;
  lastAssistantText: string | null;
  lastEventTs: number;
}

export function summarise(records: readonly Record<string, unknown>[]): TranscriptSummary {
  let autoTitle: string | null = null;
  let customTitle: string | null = null;
  let lastUserText: string | null = null;
  let lastAssistantText: string | null = null;
  let lastEventTs = 0;

  for (const rec of records) {
    for (const ev of recordToEvents(rec)) {
      if (ev.ts > lastEventTs) lastEventTs = ev.ts;
      if (ev.kind === 'title') {
        if (ev.custom) customTitle = ev.title;
        else autoTitle = ev.title;
      } else if (ev.kind === 'user') lastUserText = ev.text;
      else if (ev.kind === 'assistant') lastAssistantText = ev.text;
    }
  }
  return {
    aiTitle: customTitle ?? autoTitle,
    customTitle,
    lastUserText,
    lastAssistantText,
    lastEventTs,
  };
}
