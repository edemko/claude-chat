/**
 * Directory browsing for the create-session picker.
 *
 * The repo list (`listRepoDirs`) only finds git repos two levels under a
 * configured root, which is fine once configured and a dead end before that: a new
 * user whose code is not under `~/Dev` had no way to start a session at all.
 *
 * One level at a time, not a tree. A tree of a home directory means `node_modules`,
 * `.cache` and `.nvm` — tens of thousands of entries, slow to read and impossible to
 * scan on a phone. Breadcrumb plus children is the pattern every file picker uses
 * because it stays the same size whatever it is pointed at.
 */

import type { Executor } from './exec.js';
import { q } from './shell.js';

export interface DirEntry {
  name: string;
  path: string;
  /**
   * Holds a `.git`, so it is a repo you would actually start a session in. Tested
   * with `-e`, not `-d`: in a worktree or submodule `.git` is a file.
   */
  isRepo: boolean;
}

export interface Listing {
  path: string;
  /** null at the filesystem root, where there is nowhere left to go up to. */
  parent: string | null;
  /** Ancestors of `path`, for the breadcrumb. */
  crumbs: { name: string; path: string }[];
  entries: DirEntry[];
  /** True when this directory is itself a repo. */
  isRepo: boolean;
  /** Directories skipped because they are hidden, so the UI can say so. */
  hiddenCount: number;
}

export class BrowseError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** `~` and `~/x` resolve against the remote home, not this process's. */
export function expandHome(path: string, home: string): string {
  if (path === '~') return home;
  if (path.startsWith('~/')) return `${home}/${path.slice(2)}`;
  return path;
}

function crumbsFor(path: string): { name: string; path: string }[] {
  const parts = path.split('/').filter(Boolean);
  const out = [{ name: '/', path: '/' }];
  let acc = '';
  for (const part of parts) {
    acc += `/${part}`;
    out.push({ name: part, path: acc });
  }
  return out;
}

/**
 * List the subdirectories of `path`.
 *
 * One round trip: the listing and the per-entry `.git` test are the same script,
 * because over SSH each extra command is a whole round trip and this runs every
 * time someone taps a folder.
 */
export async function listDir(
  exec: Executor,
  home: string,
  rawPath: string,
  { showHidden = false }: { showHidden?: boolean } = {},
): Promise<Listing> {
  const path = expandHome(rawPath || '~', home);
  if (!path.startsWith('/')) throw new BrowseError(400, 'path must be absolute');

  // `realpath` first: it collapses `..` and symlinks, so the breadcrumb reflects
  // where you actually are rather than the string that was typed.
  const script = [
    `real=$(realpath ${q(path)} 2>/dev/null) || { echo "###ERR"; exit 0; }`,
    `[ -d "$real" ] || { echo "###ERR"; exit 0; }`,
    `echo "###PATH"; echo "$real"`,
    `echo "###SELF"; [ -e "$real/.git" ] && echo 1 || echo 0`,
    `echo "###ENTRIES"`,
    // -maxdepth/-mindepth 1 keeps it to direct children; the .git test is done here
    // so the client gets one answer rather than N follow-up requests.
    `find "$real" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | while IFS= read -r d; do`,
    `  [ -e "$d/.git" ] && r=1 || r=0`,
    `  printf '%s\\t%s\\n' "$r" "$d"`,
    `done`,
  ].join('\n');

  const { stdout } = await exec.runShell(script, { timeoutMs: 20_000 });
  if (stdout.includes('###ERR')) {
    throw new BrowseError(404, `no such directory: ${path}`);
  }

  const section = (name: string): string[] => {
    const start = stdout.indexOf(`###${name}\n`);
    if (start < 0) return [];
    const rest = stdout.slice(start + name.length + 4);
    const end = rest.indexOf('\n###');
    return (end < 0 ? rest : rest.slice(0, end)).split('\n').filter(Boolean);
  };

  const resolved = section('PATH')[0] ?? path;
  const isRepo = section('SELF')[0] === '1';

  let hiddenCount = 0;
  const entries: DirEntry[] = [];
  for (const line of section('ENTRIES')) {
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const full = line.slice(tab + 1);
    const name = full.split('/').pop() ?? full;
    if (!showHidden && name.startsWith('.')) {
      hiddenCount += 1;
      continue;
    }
    entries.push({ name, path: full, isRepo: line.slice(0, tab) === '1' });
  }

  // Repos first — they are what you are almost always looking for — then by name,
  // case-insensitively so `Dev` and `dev` do not end up far apart.
  entries.sort((a, b) =>
    a.isRepo !== b.isRepo
      ? Number(b.isRepo) - Number(a.isRepo)
      : a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
  );

  const parent = resolved === '/' ? null : resolved.replace(/\/[^/]+$/, '') || '/';
  return { path: resolved, parent, crumbs: crumbsFor(resolved), entries, isRepo, hiddenCount };
}

/** A single new directory inside `parent`. Not a path — one name. */
export async function makeDir(
  exec: Executor,
  home: string,
  rawParent: string,
  name: string,
): Promise<string> {
  const parent = expandHome(rawParent, home);
  if (!parent.startsWith('/')) throw new BrowseError(400, 'parent must be absolute');
  // A name, not a path: `..`, slashes and leading dashes would otherwise let a
  // "new folder" box write anywhere on the machine.
  if (!/^[^/\\\0]+$/.test(name) || name === '.' || name === '..' || name.startsWith('-')) {
    throw new BrowseError(400, 'invalid folder name');
  }

  const path = `${parent.replace(/\/$/, '')}/${name}`;
  // stderr stays on stderr: folding it into stdout leaves nothing to report, and
  // "it already exists" then becomes indistinguishable from "it failed".
  const { code, stderr } = await exec.runShell(`mkdir ${q(path)}`, { timeoutMs: 15_000 });
  if (code !== 0) {
    const why = stderr.trim();
    if (/exists/i.test(why)) throw new BrowseError(409, `${name} already exists here`);
    throw new BrowseError(400, why || 'could not create the folder');
  }
  return path;
}
