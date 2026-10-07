import { spawn } from './platform.js';
/**
 * Run a command to completion. stdio is always piped, never inherited: Ink owns the TTY.
 */
export function run(cmd, args, opts = {}) {
    return new Promise((resolve, reject) => {
        // stdin is only a pipe when there's input: a closed pipe the child never reads (ripgrep exits
        // fast) makes the write fail with EPIPE on Linux.
        const child = spawn(cmd, args, { env: opts.env, cwd: opts.cwd, stdio: [opts.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
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
            resolve({ code, stdout, stderr });
        });
        if (child.stdin) {
            child.stdin.on('error', () => { }); // the child may exit without reading its input
            child.stdin.end(opts.input);
        }
    });
}
/** Push-based async iterable: producers `push`/`end`, one consumer iterates. */
export class EventQueue {
    items = [];
    waiting;
    ended = false;
    push(item) {
        if (this.ended)
            return;
        if (this.waiting) {
            const w = this.waiting;
            this.waiting = undefined;
            w({ value: item, done: false });
        }
        else {
            this.items.push(item);
        }
    }
    end() {
        this.ended = true;
        if (this.waiting) {
            const w = this.waiting;
            this.waiting = undefined;
            w({ value: undefined, done: true });
        }
    }
    [Symbol.asyncIterator]() {
        return {
            next: () => {
                const item = this.items.shift();
                if (item !== undefined)
                    return Promise.resolve({ value: item, done: false });
                if (this.ended)
                    return Promise.resolve({ value: undefined, done: true });
                return new Promise((resolve) => (this.waiting = resolve));
            },
        };
    }
}
/** Open a URL in the user's browser (best effort). */
export function openBrowser(url) {
    if (process.env.REIN_NO_BROWSER)
        return;
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
    const child = spawn(cmd, [url], { stdio: 'ignore', detached: true });
    child.on('error', () => { });
    child.unref();
}
