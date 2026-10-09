import {mkdtempSync, realpathSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {ToolHost} from '../src/tools/host.js';

describe('codemod nudge in the tool host', () => {
  it('is off by default and adds the note to the 4th file with the experiment on', async () => {
    for (const on of [false, true]) {
      const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'rein-cn-')));
      for (let i = 1; i <= 4; i++) writeFileSync(path.join(root, `f${i}.ts`), `const r${i} = fetchJson(u);\n`);
      const host = new ToolHost({root, mode: () => 'bypass', approve: async () => 'once', experiments: () => (on ? ['codemod-nudge'] : [])});
      let last = '';
      for (let i = 1; i <= 4; i++) {
        await host.call('read', {path: `f${i}.ts`});
        last = (await host.call('edit', {path: `f${i}.ts`, old_string: `const r${i} = fetchJson(u);`, new_string: `const r${i} = http.get(u);`})).text;
      }
      expect(/write a codemod/.test(last)).toBe(on);
      host.close();
    }
  });
});
