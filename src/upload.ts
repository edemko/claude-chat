/**
 * Screenshots from the phone into a session.
 *
 * Claude Code reads an image when it is given a path, so the mechanism is: write
 * the bytes to a file on the machine the session runs on, then send that path into
 * the pane as ordinary text. No terminal image protocol, no clipboard, nothing that
 * depends on what the pane's emulator supports.
 *
 * The bytes go over the `Executor` as base64 piped into `base64 -d`, which is what
 * makes this work unchanged against a remote server: `ExecOpts.input` is a string,
 * and pushing raw binary through a shell's stdin invites encoding trouble for no
 * benefit.
 */

import type { Executor } from './exec.js';
import { q } from './shell.js';

/** Accepted types, and the extension each is stored with. */
const TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

/**
 * Leading bytes each format must start with. The Content-Type header is a claim by
 * the client; this is the check. A mislabelled file would otherwise be written with
 * an extension that misrepresents it.
 */
const MAGIC: Record<string, (b: Buffer) => boolean> = {
  png: (b) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  jpg: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  webp: (b) =>
    b.length > 12 &&
    b.subarray(0, 4).toString('latin1') === 'RIFF' &&
    b.subarray(8, 12).toString('latin1') === 'WEBP',
};

export class UploadError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export interface StoredUpload {
  path: string;
  bytes: number;
}

/** `2026-08-13` — uploads are grouped by day so the directory stays browsable. */
function dayStamp(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Write an uploaded image next to the session's own data, on the session's machine.
 *
 * Under `~/.claude-chat/uploads/` rather than the repo: a screenshot is not project
 * content, and dropping files into a working tree would show up in `git status` and
 * eventually get committed by something.
 */
export async function storeUpload(
  exec: Executor,
  home: string,
  sessionUuid: string,
  contentType: string,
  data: Buffer,
): Promise<StoredUpload> {
  const ext = TYPES[contentType.split(';')[0]?.trim().toLowerCase() ?? ''];
  if (!ext) {
    throw new UploadError(415, `unsupported type ${contentType}; want ${Object.keys(TYPES).join(', ')}`);
  }
  if (data.length === 0) throw new UploadError(400, 'empty body');
  if (!MAGIC[ext]?.(data)) {
    throw new UploadError(400, `body is not a valid ${ext} — the Content-Type does not match the bytes`);
  }

  const dir = `${home}/.claude-chat/uploads/${dayStamp()}`;
  // Second-resolution time plus a short uuid slice: unique per session per second,
  // and still legible when read back off a pane.
  const stamp = new Date().toISOString().slice(11, 19).replace(/:/g, '');
  const name = `${stamp}-${sessionUuid.slice(0, 8)}.${ext}`;
  const path = `${dir}/${name}`;

  const { code, stderr } = await exec.runShell(
    `mkdir -p ${q(dir)} && base64 -d > ${q(path)}`,
    { input: data.toString('base64'), timeoutMs: 60_000 },
  );
  if (code !== 0) throw new UploadError(500, `could not write ${path}: ${stderr.trim()}`);

  // Trust the write only after the file is on disk at the expected size — a full
  // disk or a bad path would otherwise be reported as success and the session would
  // be sent a path to nothing.
  const { stdout } = await exec.runShell(`stat -c %s ${q(path)} 2>/dev/null || echo -1`);
  const written = Number.parseInt(stdout.trim(), 10);
  if (written !== data.length) {
    throw new UploadError(500, `wrote ${written} of ${data.length} bytes to ${path}`);
  }

  return { path, bytes: data.length };
}

/**
 * What gets typed into the pane. The path goes last so it is not swallowed if the
 * caption itself runs long, and the caption is kept on its own line so a multi-line
 * note survives the bracketed paste intact.
 */
export function uploadMessage(path: string, caption: string): string {
  const trimmed = caption.trim();
  return trimmed ? `${trimmed}\n${path}` : `Look at this screenshot: ${path}`;
}
