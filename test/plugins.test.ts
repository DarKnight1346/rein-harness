import {mkdirSync, mkdtempSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {beforeEach, describe, expect, it} from 'vitest';

const put = (file: string, text: string) => {
  mkdirSync(path.dirname(file), {recursive: true});
  writeFileSync(file, text);
};

let home: string;
let project: string;
beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), 'rein-plug-'));
  project = mkdtempSync(path.join(os.tmpdir(), 'rein-proj-'));
  process.env.REIN_PLUGINS_HOME = home;
  process.env.REIN_HOME = path.join(home, '.rein');
  delete process.env.CODEX_HOME;
  // A Claude Code plugin: command, skill, agent, hooks, MCP server.
  const cp = path.join(home, '.claude', 'plugins', 'cache', 'mkt', 'review-kit', '1.2.0');
  put(path.join(cp, '.claude-plugin', 'plugin.json'), JSON.stringify({name: 'review-kit', version: '1.2.0'}));
  put(path.join(cp, 'commands', 'pr.md'), '---\ndescription: Review a PR\n---\nReview PR $ARGUMENTS using ${CLAUDE_PLUGIN_ROOT}/rules.md');
  put(path.join(cp, 'skills', 'lint', 'SKILL.md'), '---\nname: lint\ndescription: Lint things\n---\nRun the linter.');
  put(path.join(cp, 'agents', 'critic.md'), '---\nname: critic\ndescription: Harsh reviewer\n---\nBe harsh.');
  put(path.join(cp, 'hooks', 'hooks.json'), JSON.stringify({hooks: {PostToolUse: [{matcher: 'Edit', hooks: [{type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/fmt.sh'}]}]}}));
  put(path.join(cp, '.mcp.json'), JSON.stringify({db: {command: '${CLAUDE_PLUGIN_ROOT}/db-server'}}));
  // A disabled one.
  const off = path.join(home, '.claude', 'plugins', 'cache', 'mkt', 'noisy', '0.1.0');
  put(path.join(off, 'commands', 'noise.md'), 'Make noise');
  put(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({version: 2, plugins: {'review-kit@mkt': [{scope: 'user', installPath: cp, version: '1.2.0'}], 'noisy@mkt': [{scope: 'user', installPath: off}]}}));
  put(path.join(home, '.claude', 'settings.json'), JSON.stringify({enabledPlugins: {'noisy@mkt': false}}));
  // A Codex plugin (two versions: the newest wins) and a Codex skill (plus Codex's own .system ones, skipped).
  for (const v of ['0.9.0', '0.10.0']) {
    const xp = path.join(home, '.codex', 'plugins', 'cache', 'openai', 'pets', v);
    put(path.join(xp, '.codex-plugin', 'plugin.json'), JSON.stringify({name: 'pets', version: v, skills: './skills/'}));
    put(path.join(xp, 'skills', 'feed', 'SKILL.md'), `---\nname: feed\ndescription: Feed the pet ${v}\n---\nFeed it from \${PLUGIN_ROOT}.`);
    put(path.join(xp, '.mcp.json'), JSON.stringify({mcpServers: {vet: {command: 'vet'}}}));
  }
  put(path.join(home, '.codex', 'skills', 'deploy', 'SKILL.md'), '---\nname: deploy\ndescription: Ship it\n---\nDeploy.');
  put(path.join(home, '.codex', 'skills', '.system', 'imagegen', 'SKILL.md'), '---\nname: imagegen\ndescription: x\n---\nx');
});

describe('plugins', () => {
  it('load enabled Claude Code and Codex plugins (newest Codex version)', async () => {
    const {loadPlugins} = await import('../src/plugins/index.js');
    const plugins = loadPlugins(project + '/x'); // fresh cache key
    expect(plugins.map((p) => `${p.name}@${p.version}:${p.from}`)).toEqual(['review-kit@1.2.0:claude', 'pets@0.10.0:codex']);
    const rk = plugins[0]!;
    expect(rk.hooks?.PostToolUse?.[0]).toMatchObject({hooks: [{command: `${rk.root}/fmt.sh`}]});
    expect(rk.mcpServers).toEqual({db: {command: `${rk.root}/db-server`}});
    expect(plugins[1]!.mcpServers).toEqual({vet: {command: 'vet'}});
  });

  it('turn plugin commands and skills into /plugin:name, plus Codex skills', async () => {
    const {loadSkills} = await import('../src/skills/index.js');
    const skills = loadSkills(project);
    const names = skills.map((s) => s.name);
    expect(names).toEqual(expect.arrayContaining(['review-kit:pr', 'review-kit:lint', 'pets:feed', 'deploy']));
    expect(names).not.toContain('imagegen');
    expect(names.some((n) => n.includes('noise'))).toBe(false);
    const pr = skills.find((s) => s.name === 'review-kit:pr')!;
    expect(pr.command).toBe(true);
    expect(pr.body).toContain('/rules.md');
    expect(pr.body).not.toContain('${CLAUDE_PLUGIN_ROOT}');
    expect(skills.find((s) => s.name === 'pets:feed')!.description).toContain('0.10.0');
  });

  it('load plugin agents, MCP servers and hooks', async () => {
    const {loadAgentDefinitions} = await import('../src/agents/definitions.js');
    expect(loadAgentDefinitions(project).map((a) => a.name)).toContain('review-kit:critic');
    const {loadServers} = await import('../src/mcp/config.js');
    const servers = loadServers(project).filter((s) => s.source === 'plugin');
    expect(servers.map((s) => s.name).sort()).toEqual(['pets-vet', 'review-kit-db']);
    expect(servers.every((s) => s.approved)).toBe(true);
  });
});

describe('plugin hooks', () => {
  it('count as the user\'s own hooks', async () => {
    const {hasHooks} = await import('../src/hooks.js');
    expect(hasHooks('PostToolUse', project)).toBe(true);
    expect(hasHooks('PostToolUse', project, {projectOnly: true})).toBe(false);
  });
});
