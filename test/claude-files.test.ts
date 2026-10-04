import {mkdirSync, mkdtempSync, realpathSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {beforeEach, describe, expect, it} from 'vitest';
import {loadSkills, skillPrompt} from '../src/skills/index.js';
import {agentsFiles} from '../src/session/prompt.js';
import {definitionModel, loadAgentDefinitions, mapTools} from '../src/agents/definitions.js';

let root: string;
const put = (rel: string, text: string) => {
  mkdirSync(path.dirname(path.join(root, rel)), {recursive: true});
  writeFileSync(path.join(root, rel), text);
};
beforeEach(() => {
  process.env.REIN_HOME = mkdtempSync(path.join(os.tmpdir(), 'rein-home-'));
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'rein-cc-')));
  mkdirSync(path.join(root, '.git'));
});

describe('Claude Code custom commands', () => {
  it('loads .claude/commands as slash commands, sub-folders included', () => {
    put('.claude/commands/review.md', '---\ndescription: Review the diff\nargument-hint: [file]\n---\nReview $ARGUMENTS carefully.');
    put('.claude/commands/frontend/component.md', 'Create a component named $1 in $2.');
    const skills = loadSkills(root);
    const review = skills.find((s) => s.name === 'review')!;
    expect(review).toMatchObject({source: 'claude-project', description: 'Review the diff (project)', argumentHint: '[file]'});
    expect(skills.find((s) => s.name === 'component')!.description).toBe('Create a component named $1 in $2. (project:frontend)');
  });

  it('fills $ARGUMENTS / $1.. like Claude Code, and turns !`cmd` into a command to run first', () => {
    put('.claude/commands/fix.md', 'Fix issue #$1 with priority $2.\nContext: !`git status --short`');
    const s = loadSkills(root).find((x) => x.name === 'fix')!;
    const prompt = skillPrompt(s, '123 high', root);
    expect(prompt).toContain('Fix issue #123 with priority high.');
    expect(prompt).toContain('Context: `git status --short`');
    expect(prompt).toContain('Before anything else, run this command and use the output: `git status --short`.');
    expect(prompt.endsWith('Follow the command above.')).toBe(true);
  });

  it("a Rein skill with the same name wins over a Claude Code command", () => {
    put('.claude/commands/deploy.md', 'claude version');
    put('.rein/skills/deploy/SKILL.md', '---\nname: deploy\n---\nrein version');
    const s = loadSkills(root).find((x) => x.name === 'deploy')!;
    expect(s.source).toBe('project');
  });
});

describe('CLAUDE.local.md', () => {
  it('is read with the other instruction files', async () => {
    put('CLAUDE.md', 'shared rules');
    put('CLAUDE.local.md', 'my personal rules');
    const files = (await agentsFiles(root)).map((f) => path.basename(f.path));
    expect(files).toEqual(expect.arrayContaining(['CLAUDE.md', 'CLAUDE.local.md']));
  });
});

describe('subagent definitions (.claude/agents)', () => {
  it('loads Claude Code agent files and maps their tools and model', () => {
    put('.claude/agents/code-reviewer.md', '---\nname: code-reviewer\ndescription: Reviews code for bugs\ntools: Read, Grep, Glob, Bash\nmodel: haiku\n---\nYou are a meticulous reviewer.');
    put('.rein/agents/code-reviewer.md', '---\ndescription: Rein override\n---\nRein role.');
    put('.claude/agents/writer.md', '---\ndescription: Writes docs\n---\nYou write docs.');
    const defs = loadAgentDefinitions(root);
    expect(defs.map((d) => d.name)).toEqual(['code-reviewer', 'writer']);
    expect(defs[0]).toMatchObject({description: 'Rein override', prompt: 'Rein role.'}); // .rein wins
    expect(mapTools('Read, Grep, Glob, Bash, mcp__github')).toEqual(['read', 'search', 'list', 'shell', 'shell_logs', 'shell_kill', 'mcp__github']);
    expect(definitionModel('haiku')).toBe('claude:haiku');
    expect(definitionModel('inherit')).toBeUndefined();
    expect(definitionModel('codex:gpt-x')).toBe('codex:gpt-x');
    expect(defs[1]!.tools).toBeUndefined(); // no tools line = every tool
  });
});
