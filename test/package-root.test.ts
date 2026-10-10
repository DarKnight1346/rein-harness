import {existsSync, readFileSync} from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {reinRoot} from '../src/commands/update.js';
import {builtinSkillsDir} from '../src/skills/index.js';
import {packageRoot} from '../src/util/root.js';

describe('packageRoot', () => {
  it("finds Rein's package folder by its package.json, wherever the code runs from", () => {
    const root = packageRoot();
    expect(JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).name).toBe('rein-harness');
    expect(existsSync(path.join(builtinSkillsDir(), 'plan'))).toBe(true);
    const saved = process.env.REIN_INSTALL_ROOT;
    delete process.env.REIN_INSTALL_ROOT;
    try {
      expect(reinRoot()).toBe(root);
    } finally {
      if (saved !== undefined) process.env.REIN_INSTALL_ROOT = saved;
    }
  });
});
