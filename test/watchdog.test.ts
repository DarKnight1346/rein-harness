import {mkdtempSync, realpathSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {ToolHost} from '../src/tools/host.js';

function host(experiments: string[] = ['watchdog']) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'rein-dog-')));
  writeFileSync(path.join(root, 'a.ts'), 'export const x = 1;\n');
  return {root, h: new ToolHost({root, mode: () => 'bypass', approve: async () => 'once', experiments: () => experiments, steerShell: () => false})};
}
const fail = process.platform === 'win32' ? 'exit 1' : 'false';

describe('watchdog', () => {
  it('warns at the 3rd identical failing run and refuses the 5th, unless the code changed', async () => {
    const {h} = host();
    const runs = [];
    for (let i = 0; i < 5; i++) runs.push(await h.call('shell', {command: fail}));
    expect(runs[1]!.text).not.toMatch(/watchdog/);
    expect(runs[2]!.text).toMatch(/<watchdog>This command has failed 3 times/);
    expect(runs[4]).toMatchObject({ok: false, text: expect.stringMatching(/^stopped: this is the 5th run/)});
    h.watchdog.reset(); // your next message
    expect((await h.call('shell', {command: fail})).text).not.toMatch(/stopped/);
    h.close();
  });

  it('counts an edit between runs as progress', async () => {
    const {h} = host();
    await h.call('read', {path: 'a.ts'});
    for (let i = 0; i < 4; i++) {
      await h.call('shell', {command: fail});
      await h.call('edit', {path: 'a.ts', old_string: `x = ${i + 1}`, new_string: `x = ${i + 2}`});
    }
    expect((await h.call('shell', {command: fail})).text).not.toMatch(/watchdog|stopped/);
    h.close();
  });

  it('notices a file edited back and forth', async () => {
    const {h} = host();
    await h.call('read', {path: 'a.ts'});
    const flip = (from: string, to: string) => h.call('edit', {path: 'a.ts', old_string: from, new_string: to});
    await flip('x = 1', 'x = 2');
    await flip('x = 2', 'x = 1'); // back to the start: 1
    const second = await flip('x = 1', 'x = 2'); // 2
    expect(second.text).toMatch(/<watchdog>You've now changed .*a\.ts back to an earlier version 2 times/);
    await flip('x = 2', 'x = 1'); // 3
    await flip('x = 1', 'x = 2'); // 4
    expect(await flip('x = 2', 'x = 1')).toMatchObject({ok: false, text: expect.stringMatching(/^stopped: .*edited back and forth/)});
    h.close();
  });

  it('is off unless the experiment is on', async () => {
    const {h} = host([]);
    for (let i = 0; i < 5; i++) expect((await h.call('shell', {command: fail})).text).not.toMatch(/watchdog|stopped/);
    h.close();
  });
});
