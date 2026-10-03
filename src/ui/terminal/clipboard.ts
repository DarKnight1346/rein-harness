import {spawn} from 'node:child_process';
import {writeFileSync} from 'node:fs';

/**
 * Copy text to the system clipboard. Native tool first (pbcopy / wl-copy / xclip); OSC 52 is also
 * written so it works over SSH in terminals that support it (Terminal.app ignores it harmlessly).
 */
export function copyToClipboard(text: string, stdout: NodeJS.WriteStream = process.stdout): Promise<boolean> {
  // Tests: capture instead of touching the user's clipboard.
  if (process.env.REIN_CLIPBOARD_FILE) {
    writeFileSync(process.env.REIN_CLIPBOARD_FILE, text);
    return Promise.resolve(true);
  }
  stdout.write(`\x1b]52;c;${Buffer.from(text).toString('base64')}\x07`);
  const cmds: [string, string[]][] =
    process.platform === 'darwin' ? [['pbcopy', []]]
    : process.platform === 'win32' ? [['clip', []]]
    : [['wl-copy', []], ['xclip', ['-selection', 'clipboard']], ['xsel', ['--clipboard', '--input']]];
  return new Promise((resolve) => {
    const tryNext = (i: number) => {
      const cmd = cmds[i];
      if (!cmd) return resolve(false);
      const child = spawn(cmd[0], cmd[1], {stdio: ['pipe', 'ignore', 'ignore']});
      child.on('error', () => tryNext(i + 1));
      child.on('close', (code) => (code === 0 ? resolve(true) : tryNext(i + 1)));
      child.stdin.end(text);
    };
    tryNext(0);
  });
}
