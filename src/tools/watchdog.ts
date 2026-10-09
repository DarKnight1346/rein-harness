import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';

/** Repeats before the agent is told it's looping, and before the call is refused. */
export const WARN_AT = 3;
export const STOP_AT = 5;

/**
 * The `watchdog` experiment: notices an agent going in circles within one request, the same failing
 * command run again with nothing changed in between, or a file edited back to a state it was just in,
 * tells it to step back at the 3rd time, and refuses the call at the 5th. A real file change between two
 * runs of a command is progress, so it starts the count over.
 */
export class Watchdog {
  private failing: {key: string; count: number} | undefined;
  private states = new Map<string, string[]>();
  private flips = new Map<string, number>();

  /** Your next message: a fresh start. */
  reset(): void {
    this.failing = undefined;
    this.states.clear();
    this.flips.clear();
  }

  /** Refuse the call outright (the message says why), or undefined to let it run. */
  before(tool: string, args: any, files: string[]): string | undefined {
    // The file as it was before this request's first edit to it, so undoing back to it counts.
    if (tool === 'edit' || tool === 'write' || tool === 'delete') for (const f of files) if (!this.states.has(f)) this.states.set(f, [hashOf(f)]);
    if (tool === 'shell' && this.failing?.key === shellKey(args) && this.failing.count >= STOP_AT - 1)
      return `stopped: this is the ${STOP_AT}th run of \`${String(args?.command)}\` with nothing changed since it last failed. Running it again won't help. Read the error, change something (code, input, approach), or tell the user what's blocking you.`;
    if ((tool === 'edit' || tool === 'write') && files.some((f) => (this.flips.get(f) ?? 0) >= STOP_AT - 1))
      return `stopped: ${files.join(', ')} has been edited back and forth ${STOP_AT - 1} times this request. Decide what the file should contain, or tell the user what you're unsure about.`;
    return undefined;
  }

  /** After the call: a note for the agent when it's repeating itself. */
  after(tool: string, args: any, ok: boolean, files: string[]): string | undefined {
    if (tool === 'shell') {
      const key = shellKey(args);
      if (ok) {
        if (this.failing?.key === key) this.failing = undefined;
        return undefined;
      }
      this.failing = this.failing?.key === key ? {key, count: this.failing.count + 1} : {key, count: 1};
      return this.failing.count >= WARN_AT
        ? `<watchdog>This command has failed ${this.failing.count} times in a row with no file changes in between. Stop retrying it: read the error closely, check your assumptions, and change something before running it again.</watchdog>`
        : undefined;
    }
    if ((tool === 'edit' || tool === 'write' || tool === 'delete') && ok) {
      this.failing = undefined; // the code changed: running the command again is a real retry
      let note: string | undefined;
      for (const f of files) {
        const h = hashOf(f);
        const seen = this.states.get(f) ?? [];
        // Back to a state from before the last edit (A → B → A): undoing its own change.
        if (seen.slice(0, -1).includes(h)) {
          const n = (this.flips.get(f) ?? 0) + 1;
          this.flips.set(f, n);
          if (n >= WARN_AT - 1) note = `<watchdog>You've now changed ${f} back to an earlier version ${n} times this request. Stop going back and forth: decide what the file should contain, and why, before editing it again.</watchdog>`;
        }
        this.states.set(f, [...seen.slice(-5), h]);
      }
      return note;
    }
    return undefined;
  }
}

const shellKey = (args: any) => `${String(args?.cwd ?? '')}\0${String(args?.command ?? '').trim()}`;

function hashOf(file: string): string {
  try {
    return createHash('sha1').update(readFileSync(file)).digest('hex');
  } catch {
    return 'missing';
  }
}
