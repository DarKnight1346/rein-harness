import {spawn} from 'node:child_process';

export type NotifyMode = 'terminal' | 'system' | 'off';

/**
 * Get the user's attention when Rein needs them (an approval, a question, a plan) or finished a
 * long task. `terminal`: the bell (Dock bounce / tab badge in most terminals) plus an OSC 9
 * notification (iTerm2, WezTerm, kitty, Ghostty, Windows Terminal; ignored elsewhere). `system`:
 * also a desktop notification (macOS Notification Center, notify-send on Linux).
 */
export function notify(mode: NotifyMode | undefined, title: string, body: string): void {
  if (mode === 'off') return;
  const text = `${title}: ${body}`.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 200);
  try {
    process.stdout.write(`\x07\x1b]9;${text}\x07`);
  } catch {}
  if (mode !== 'system') return;
  try {
    const child =
      process.platform === 'darwin'
        ? spawn('osascript', ['-e', `display notification ${appleString(body)} with title ${appleString(title)}`], {stdio: 'ignore', detached: true})
        : process.platform === 'linux'
          ? spawn('notify-send', ['--app-name=Rein', title, body], {stdio: 'ignore', detached: true})
          : undefined;
    child?.on('error', () => {});
    child?.unref();
  } catch {}
}

/** An AppleScript string literal. */
const appleString = (s: string) => `"${s.slice(0, 180).replace(/[\\"]/g, '\\$&').replace(/[\r\n]+/g, ' ')}"`;
