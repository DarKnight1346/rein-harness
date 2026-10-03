import {mkdirSync, mkdtempSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {beforeEach, describe, expect, it} from 'vitest';
import {skillTool} from '../src/skills/tool.js';

let proj: string;
beforeEach(() => {
  process.env.REIN_HOME = mkdtempSync(path.join(os.tmpdir(), 'rein-home-'));
  proj = mkdtempSync(path.join(os.tmpdir(), 'rein-proj-'));
  const dir = path.join(proj, '.rein/skills/release-notes');
  mkdirSync(dir, {recursive: true});
  writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: release-notes\ndescription: Write release notes from git history\n---\nRun git log, group by type, write NOTES.md.\n');
  writeFileSync(path.join(dir, 'config.json'), JSON.stringify({aliases: ['rn']}));
});

describe('skill tool', () => {
  it('lists built-in, project and global skills in its description', () => {
    const d = skillTool(() => proj).describe!();
    expect(d).toContain('- release-notes (alias: rn) [project]: Write release notes from git history');
    expect(d).toContain('- skill:create [built-in]');
    expect(d).toContain('- skill:edit [built-in]');
  });

  it('loads a skill (by name or alias) and returns its instructions', async () => {
    const t = skillTool(() => proj);
    const r = await t.run({root: proj} as any, {name: 'rn', args: 'since v1.2'});
    expect(r.text).toContain('Skill "release-notes" loaded');
    expect(r.text).toContain('Run git log, group by type, write NOTES.md.');
    expect(r.text).toContain('since v1.2');
    await expect(t.run({root: proj} as any, {name: 'nope'})).rejects.toThrow(/no skill "nope"; available: .*release-notes/);
  });

  it('a skill created mid-conversation can be loaded right away', async () => {
    const t = skillTool(() => proj);
    const dir = path.join(process.env.REIN_HOME!, 'skills/fresh');
    mkdirSync(dir, {recursive: true});
    writeFileSync(path.join(dir, 'SKILL.md'), 'Do the fresh thing.\n');
    expect((await t.run({root: proj} as any, {name: 'fresh'})).text).toContain('Do the fresh thing.');
  });
});
