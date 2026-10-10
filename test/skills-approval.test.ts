import {setEnabledPacks} from '../src/commands/packs.js';
import {mkdtemp, mkdir, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {beforeEach, describe, expect, it} from 'vitest';
import {loadSkills, parseSkillFile, skillPrompt} from '../src/skills/index.js';
import {parseInput, shadowedSkills, suggestCommands} from '../src/commands/index.js';
import {ToolHost, type ApprovalDecision, type ApprovalMode, type ToolActivity} from '../src/tools/host.js';
import {agentsFiles} from '../src/session/prompt.js';

let home: string;
let proj: string;
beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'rein-home-'));
  proj = await mkdtemp(path.join(os.tmpdir(), 'rein-proj-'));
  process.env.REIN_HOME = home;
});

describe('skills', () => {
  it('loads folder skills; built-in → project → global on name clashes', async () => {
    const mk = async (root: string, folder: string, content: string, extra?: Record<string, string>) => {
      await mkdir(path.join(root, folder), {recursive: true});
      await writeFile(path.join(root, folder, 'SKILL.md'), content);
      for (const [f, c] of Object.entries(extra ?? {})) {
        await mkdir(path.dirname(path.join(root, folder, f)), {recursive: true});
        await writeFile(path.join(root, folder, f), c);
      }
    };
    const g = path.join(home, 'skills');
    const pr = path.join(proj, '.rein/skills');
    await mk(g, 'audit', '---\nname: audit\ndescription: Global audit\n---\nGLOBAL BODY');
    await mk(g, 'deploy', 'Deploy the app.\nRun {{SKILL_DIR}}/scripts/deploy.sh', {'scripts/deploy.sh': '#!/bin/sh\necho deploy'});
    await mk(pr, 'audit', '---\ndescription: Project audit\n---\nPROJECT BODY');
    await mk(pr, 'help', 'shadowed by /help');
    await mk(pr, 'create-skill', '---\nname: skill:create\n---\nPROJECT OVERRIDE ATTEMPT');
    await writeFile(path.join(pr, 'loose.md'), 'single files are not skills');
    await mk(g, 'git-sync', 'unused default', {'config.json': JSON.stringify({name: 'git:sync', main: 'PROMPT.md', aliases: ['gs', 'help'], description: 'Sync with origin'}), 'PROMPT.md': 'Fetch and rebase.'});
    const skills = loadSkills(proj);
    const by = Object.fromEntries(skills.map((s) => [s.name, s]));
    // Built-in skills of packs that are off (migration playbooks, the tour) aren't loaded.
    expect(Object.keys(by).sort()).toEqual(['audit', 'deploy', 'git:sync', 'help', 'init', 'plan', 'plan:deep', 'review', 'review:deep', 'skill:create', 'skill:edit']);
    setEnabledPacks(() => ['migrations', 'insight']);
    try {
      expect(loadSkills(proj).map((s) => s.name)).toEqual(expect.arrayContaining(['codemod', 'contract-tests', 'expand-contract', 'migrate:java21', 'migrate:python3', 'migrate:react-hooks', 'tour']));
    } finally {
      setEnabledPacks(() => []);
    }
    expect([by['git:sync']!.body, by['git:sync']!.description, by['git:sync']!.files[0]]).toEqual(['Fetch and rebase.', 'Sync with origin', 'PROMPT.md']);
    expect(parseInput('/gs now', skills)).toMatchObject({kind: 'skill', skill: {name: 'git:sync'}}); // alias
    expect(parseInput('/help', skills)).toMatchObject({kind: 'command', name: 'help'}); // alias can't beat a command
    expect([by.audit!.source, by.audit!.body]).toEqual(['project', 'PROJECT BODY']);
    expect(by.review!.source).toBe('builtin');
    expect(by['skill:create']!.source).toBe('builtin'); // built-in beats the project copy
    expect(by.deploy!.files).toEqual(['SKILL.md', 'scripts/deploy.sh']);
    expect(shadowedSkills(skills).map((s) => s.name)).toEqual(['help']);
    expect(suggestCommands('/skill', skills).map((s) => s.name).slice(0, 2)).toEqual(['skill:create', 'skill:edit']);
    expect(parseInput('/skill:create a git helper', skills)).toMatchObject({kind: 'skill', args: 'a git helper', skill: {name: 'skill:create'}});
    const prompt = skillPrompt(by.deploy!, 'now', proj);
    expect(prompt).toContain(`source="global" dir="${path.join(g, 'deploy')}"`);
    expect(prompt).toContain(`Run ${path.join(g, 'deploy')}/scripts/deploy.sh`);
    expect(prompt).toContain('scripts/deploy.sh');
    expect(prompt.endsWith('\n\nnow')).toBe(true);
    const create = skillPrompt(by['skill:create']!, '', proj);
    expect(create).toContain(path.join(proj, '.rein/skills'));
    expect(create).not.toContain('{{PROJECT_SKILLS_DIR}}');
  });
  it('parses frontmatter optionally', () => {
    expect(parseSkillFile('no frontmatter')).toEqual({fields: {}, body: 'no frontmatter'});
    expect(parseSkillFile('---\nName: "x"\n---\nbody')).toEqual({fields: {name: 'x'}, body: 'body'});
  });
});

describe('AGENTS.md', () => {
  it('collects global then root-to-project files', async () => {
    await writeFile(path.join(home, 'AGENTS.md'), 'global rules');
    await mkdir(path.join(proj, '.git'));
    await writeFile(path.join(proj, 'AGENTS.md'), 'repo rules');
    await mkdir(path.join(proj, 'pkg'));
    await writeFile(path.join(proj, 'pkg/AGENTS.md'), 'package rules');
    const files = await agentsFiles(path.join(proj, 'pkg'));
    expect(files.map((f) => f.text)).toEqual(['global rules', 'repo rules', 'package rules']);
  });

  it("also reads Claude Code's CLAUDE.md files, once each", async () => {
    const claudeGlobal = path.join(home, 'claude-global.md');
    process.env.REIN_CLAUDE_GLOBAL = claudeGlobal;
    await writeFile(claudeGlobal, 'claude user rules');
    await writeFile(path.join(home, 'AGENTS.md'), 'global rules');
    await mkdir(path.join(proj, '.git'));
    await writeFile(path.join(proj, 'AGENTS.md'), 'repo rules');
    await mkdir(path.join(proj, 'pkg'));
    await writeFile(path.join(proj, 'pkg/AGENTS.md'), 'package rules');
    await writeFile(path.join(proj, 'CLAUDE.md'), 'claude repo rules');
    await mkdir(path.join(proj, 'pkg/.claude'), {recursive: true});
    await writeFile(path.join(proj, 'pkg/.claude/CLAUDE.md'), 'package rules'); // same text as pkg/AGENTS.md
    const files = await agentsFiles(path.join(proj, 'pkg'));
    expect(files.map((f) => f.text)).toEqual(['global rules', 'claude user rules', 'repo rules', 'claude repo rules', 'package rules']);
    delete process.env.REIN_CLAUDE_GLOBAL;
  });
});

describe('approval modes', () => {
  const setup = (mode: ApprovalMode, answers: ApprovalDecision[], judge?: (r: any) => Promise<{allow: boolean; note: string}>) => {
    const asked: string[] = [];
    const activity: ToolActivity[] = [];
    const host = new ToolHost({root: proj, mode: () => mode, judge, approve: async (req) => (asked.push(req.summary), answers.shift() ?? 'deny')});
    host.on('activity', (a) => activity.push(a));
    return {host, asked, activity};
  };
  it('ask: prompts, honours deny and allow-for-session; reads never ask', async () => {
    const {host, asked, activity} = setup('ask', ['deny', 'session']);
    expect((await host.call('write', {path: 'a.txt', content: 'x'})).ok).toBe(false);
    expect((await host.call('write', {path: 'a.txt', content: 'x'})).ok).toBe(true);
    expect((await host.call('write', {path: 'b.txt', content: 'y'})).ok).toBe(true); // session: no prompt
    expect((await host.call('read', {path: 'a.txt'})).ok).toBe(true);
    expect(asked).toEqual(['a.txt', 'a.txt']);
    expect(activity.filter((a) => a.phase === 'end').map((a) => (a as any).approvedBy)).toEqual([undefined, 'session', 'session', undefined]);
  });
  it('bypass: never asks', async () => {
    const {host, asked} = setup('bypass', []);
    expect((await host.call('delete', {path: 'nope'})).text).toMatch(/does not exist/);
    expect(asked).toEqual([]);
  });
  it('auto: judge allows confident changes, otherwise asks the user', async () => {
    let allow = true;
    const {host, asked, activity} = setup('auto', ['once'], async () => ({allow, note: allow ? '0.97 via test' : '0.40 via test'}));
    await host.call('write', {path: 'a.txt', content: 'x'});
    allow = false;
    await host.call('write', {path: 'b.txt', content: 'y'});
    expect(asked).toEqual(['b.txt']);
    const ends = activity.filter((a) => a.phase === 'end') as any[];
    expect(ends.map((a) => [a.approvedBy, a.judge])).toEqual([['auto', '0.97 via test'], ['user', '0.40 via test']]);
  });
  it('auto: a failing judge falls back to asking', async () => {
    const {host, asked} = setup('auto', ['once'], async () => {
      throw new Error('no decider');
    });
    expect((await host.call('write', {path: 'a.txt', content: 'x'})).ok).toBe(true);
    expect(asked).toEqual(['a.txt']);
  });
});

describe('skill config fallbacks', () => {
  it('config.json → frontmatter → SKILL.md + folder name', async () => {
    const root = path.join(proj, '.rein/skills');
    const mk = async (folder: string, files: Record<string, string>) => {
      await mkdir(path.join(root, folder), {recursive: true});
      for (const [f, c] of Object.entries(files)) await writeFile(path.join(root, folder, f), c);
    };
    await mk('plain', {'SKILL.md': 'Do the plain thing.'});
    await mk('fm', {'SKILL.md': '---\nname: front\ndescription: From frontmatter\n---\nBody'});
    await mk('cfg', {'SKILL.md': '---\nname: ignored\ndescription: ignored too\n---\nBody', 'config.json': '{"name":"from-config","description":"From config"}'});
    await mk('badmain', {'SKILL.md': 'Fallback body', 'config.json': '{"main":"MISSING.md","aliases":["bm"]}'});
    const by = Object.fromEntries(loadSkills(proj).filter((s) => s.source === 'project').map((s) => [s.name, s]));
    expect([by.plain?.description, by.front?.description, by['from-config']?.description]).toEqual(['Do the plain thing.', 'From frontmatter', 'From config']);
    expect([by.badmain?.body, by.badmain?.aliases]).toEqual(['Fallback body', ['bm']]);
  });
});
