import {spawn} from 'node:child_process';

export type RunResult = {code: number | null; stdout: string; stderr: string};

/**
 * Run a command to completion. stdio is always piped, never inherited: Ink owns the TTY.
 */
export function run(
  cmd: string,
  args: string[],
  opts: {env?: NodeJS.ProcessEnv; timeoutMs?: number; input?: string} = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {env: opts.env, stdio: ['pipe', 'pipe', 'pipe']});
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = opts.timeoutMs
      ? setTimeout(() => child.kill('SIGTERM'), opts.timeoutMs)
      : undefined;
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({code, stdout, stderr});
    });
    child.stdin.end(opts.input ?? '');
  });
}

/** Push-based async iterable: producers `push`/`end`, one consumer iterates. */
export class EventQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiting: ((r: IteratorResult<T>) => void) | undefined;
  private ended = false;

  push(item: T): void {
    if (this.ended) return;
    if (this.waiting) {
      const w = this.waiting;
      this.waiting = undefined;
      w({value: item, done: false});
    } else {
      this.items.push(item);
    }
  }

  end(): void {
    this.ended = true;
    if (this.waiting) {
      const w = this.waiting;
      this.waiting = undefined;
      w({value: undefined, done: true});
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item !== undefined) return Promise.resolve({value: item, done: false});
        if (this.ended) return Promise.resolve({value: undefined, done: true});
        return new Promise((resolve) => (this.waiting = resolve));
      },
    };
  }
}

/** Open a URL in the user's browser (best effort). */
export function openBrowser(url: string): void {
  if (process.env.REIN_NO_BROWSER) return;
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  const child = spawn(cmd, [url], {stdio: 'ignore', detached: true});
  child.on('error', () => {});
  child.unref();
}
