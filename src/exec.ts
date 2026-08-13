import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { q, qq } from './shell.js';

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface ExecOpts {
  /** Written to the child's stdin, then stdin is closed. */
  input?: string;
  timeoutMs?: number;
}

/**
 * Every server interaction goes through this interface as a shell command, which
 * is what lets the same discovery/stream/input logic run against the local box or
 * a remote one over SSH without changes above this layer.
 */
export interface Executor {
  readonly id: string;
  readonly label: string;
  /** Run an argv directly — no shell, so no quoting hazards. */
  run(argv: readonly string[], opts?: ExecOpts): Promise<ExecResult>;
  /** Run through a login shell. Needed for nvm-provided binaries like `claude`. */
  runShell(cmd: string, opts?: ExecOpts): Promise<ExecResult>;
  /** Long-lived process whose stdout the caller streams (`tail -F`). */
  spawnStream(argv: readonly string[]): ChildProcessWithoutNullStreams;
}

const DEFAULT_TIMEOUT = 15_000;

function collect(
  child: ChildProcessWithoutNullStreams,
  opts: ExecOpts | undefined,
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill('SIGKILL');
        reject(new Error(`command timed out after ${opts?.timeoutMs ?? DEFAULT_TIMEOUT}ms`));
      }
    }, opts?.timeoutMs ?? DEFAULT_TIMEOUT);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d: string) => { stdout += d; });
    child.stderr.on('data', (d: string) => { stderr += d; });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? -1 });
    });

    if (opts?.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

export class LocalExecutor implements Executor {
  constructor(readonly id: string, readonly label: string) {}

  run(argv: readonly string[], opts?: ExecOpts): Promise<ExecResult> {
    const [cmd, ...rest] = argv;
    if (!cmd) throw new Error('empty argv');
    return collect(spawn(cmd, rest, { stdio: 'pipe' }) as ChildProcessWithoutNullStreams, opts);
  }

  runShell(cmd: string, opts?: ExecOpts): Promise<ExecResult> {
    return collect(
      spawn('zsh', ['-lc', cmd], { stdio: 'pipe' }) as ChildProcessWithoutNullStreams,
      opts,
    );
  }

  spawnStream(argv: readonly string[]): ChildProcessWithoutNullStreams {
    const [cmd, ...rest] = argv;
    if (!cmd) throw new Error('empty argv');
    return spawn(cmd, rest, { stdio: 'pipe' }) as ChildProcessWithoutNullStreams;
  }
}

/**
 * Remote server over SSH. Relies on the host being resolvable via ~/.ssh/config
 * with key-based auth and ControlMaster for connection reuse.
 */
export class SshExecutor implements Executor {
  constructor(
    readonly id: string,
    readonly label: string,
    private readonly host: string,
    private readonly sshOpts: readonly string[] = [
      '-o', 'BatchMode=yes',
      '-o', 'ControlMaster=auto',
      '-o', 'ControlPath=~/.ssh/cc-%r@%h:%p',
      '-o', 'ControlPersist=300',
    ],
  ) {}

  private argvFor(remoteCmd: string): string[] {
    return ['ssh', ...this.sshOpts, this.host, remoteCmd];
  }

  run(argv: readonly string[], opts?: ExecOpts): Promise<ExecResult> {
    return this.runShellRaw(qq(argv), opts);
  }

  runShell(cmd: string, opts?: ExecOpts): Promise<ExecResult> {
    return this.runShellRaw(`zsh -lc ${q(cmd)}`, opts);
  }

  private runShellRaw(remoteCmd: string, opts?: ExecOpts): Promise<ExecResult> {
    const [cmd, ...rest] = this.argvFor(remoteCmd);
    return collect(
      spawn(cmd!, rest, { stdio: 'pipe' }) as ChildProcessWithoutNullStreams,
      opts,
    );
  }

  spawnStream(argv: readonly string[]): ChildProcessWithoutNullStreams {
    const [cmd, ...rest] = this.argvFor(qq(argv));
    return spawn(cmd!, rest, { stdio: 'pipe' }) as ChildProcessWithoutNullStreams;
  }
}
