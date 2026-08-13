import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Executor } from './exec.js';
import { parseRecords, recordToEvents } from './transcript.js';
import type { ChatEvent } from './types.js';

export type Listener = (events: ChatEvent[]) => void;

/** Batch window: a tool-heavy turn writes many records at once. */
const FLUSH_MS = 100;
/**
 * Lines of overlap when the tail starts. History is fetched over REST, so this only
 * needs to cover the gap between that fetch and the tail attaching; the client
 * deduplicates by event id.
 */
const OVERLAP_LINES = 20;
const RESTART_DELAY_MS = 1_000;

class TranscriptStream {
  private child: ChildProcessWithoutNullStreams | null = null;
  private partial = '';
  private pending: ChatEvent[] = [];
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  readonly listeners = new Set<Listener>();

  constructor(
    private readonly exec: Executor,
    private readonly path: string,
  ) {}

  start(): void {
    if (this.child || this.stopped) return;
    // -F follows across truncation and recreation, which matters if a session is
    // resumed or compacted while the phone is watching.
    const child = this.exec.spawnStream(['tail', '-n', String(OVERLAP_LINES), '-F', this.path]);
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.onData(chunk));
    child.stderr.resume();
    child.on('error', (err) => console.error(`[stream] ${this.path}:`, err));
    child.on('close', () => {
      this.child = null;
      if (!this.stopped && this.listeners.size > 0) {
        setTimeout(() => this.start(), RESTART_DELAY_MS);
      }
    });
  }

  private onData(chunk: string): void {
    this.partial += chunk;
    const lines = this.partial.split('\n');
    // The final element is an incomplete line, or '' when the chunk ended cleanly.
    this.partial = lines.pop() ?? '';
    if (lines.length === 0) return;

    const records = parseRecords(lines.join('\n'), false);
    for (const rec of records) this.pending.push(...recordToEvents(rec));
    if (this.pending.length > 0 && !this.timer) {
      this.timer = setTimeout(() => this.flush(), FLUSH_MS);
    }
  }

  private flush(): void {
    this.timer = null;
    if (this.pending.length === 0) return;
    const batch = this.pending;
    this.pending = [];
    for (const listener of this.listeners) {
      try {
        listener(batch);
      } catch (err) {
        console.error('[stream] listener threw:', err);
      }
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.child?.kill('SIGTERM');
    this.child = null;
  }
}

/**
 * Reference-counted transcript tails: one `tail` process per file no matter how many
 * clients watch it, torn down when the last one leaves.
 */
export class StreamHub {
  private streams = new Map<string, TranscriptStream>();

  subscribe(exec: Executor, serverId: string, path: string, listener: Listener): () => void {
    const key = `${serverId}:${path}`;
    let stream = this.streams.get(key);
    if (!stream) {
      stream = new TranscriptStream(exec, path);
      this.streams.set(key, stream);
    }
    stream.listeners.add(listener);
    stream.start();

    let released = false;
    return () => {
      if (released) return;
      released = true;
      const s = this.streams.get(key);
      if (!s) return;
      s.listeners.delete(listener);
      if (s.listeners.size === 0) {
        s.stop();
        this.streams.delete(key);
      }
    };
  }

  stopAll(): void {
    for (const s of this.streams.values()) s.stop();
    this.streams.clear();
  }
}
