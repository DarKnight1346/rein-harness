import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MOUSE_OFF, MOUSE_ON } from './mouse.js';
/** The user's editor: $VISUAL, then $EDITOR, else vi (Notepad on Windows). */
export function editorCommand(env = process.env) {
    return env.VISUAL?.trim() || env.EDITOR?.trim() || (process.platform === 'win32' ? 'notepad' : 'vi');
}
/**
 * Ctrl+G: edit the draft in the user's editor and return the result (undefined if it failed).
 * The terminal is handed over completely while the editor runs: Rein's event loop is blocked
 * (spawnSync), raw mode, mouse reporting, the kitty keyboard protocol and the alt screen are
 * switched off, and all of it is restored afterwards, followed by a full repaint.
 */
export function editExternally(text, fullscreen) {
    const file = path.join(os.tmpdir(), `rein-draft-${process.pid}.md`);
    const out = process.stdout;
    const stdin = process.stdin;
    try {
        writeFileSync(file, text, { mode: 0o600 });
        // `\x1b[<u` pops the kitty keyboard mode Ink pushed (ignored by terminals without it).
        out.write((fullscreen ? MOUSE_OFF + '\x1b[?1049l' : '') + '\x1b[<u' + '\x1b[?25h');
        stdin.setRawMode?.(false);
        const res = spawnSync(`${editorCommand()} "${file}"`, { stdio: 'inherit', shell: true });
        if (res.error || res.status !== 0)
            return undefined;
        return readFileSync(file, 'utf8').replace(/\r?\n$/, '');
    }
    catch {
        return undefined;
    }
    finally {
        stdin.setRawMode?.(true);
        rmSync(file, { force: true });
        out.write('\x1b[>3u');
        if (fullscreen) {
            // Back to a blank alt screen; Ink redraws everything on resize (see resizeFix.ts).
            out.write('\x1b[?1049h' + MOUSE_ON + '\x1b[2J\x1b[H');
            out.emit('resize');
        }
        // Classic: editors restore the normal screen themselves (their own alt screen), so the
        // transcript above stays as it was.
    }
}
