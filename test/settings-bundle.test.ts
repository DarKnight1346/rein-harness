import {existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {exportSettings, importSettings, writeBundle} from '../src/store/settingsBundle.js';

describe('settings export / import', () => {
  it('moves settings, skills and agents to another machine, without secrets', () => {
    const a = mkdtempSync(path.join(os.tmpdir(), 'rein-a-'));
    writeFileSync(path.join(a, 'config.json'), '{"chatModel":"claude:opus"}');
    writeFileSync(path.join(a, 'AGENTS.md'), 'Be terse.');
    writeFileSync(path.join(a, 'accounts.json'), '{"secret":true}'); // never exported
    writeFileSync(path.join(a, 'mcp.json'), JSON.stringify({mcpServers: {gh: {command: 'gh-mcp', env: {GITHUB_TOKEN: 'ghp_literal', HOME_DIR: '${HOME}'}}, web: {type: 'http', url: 'https://x', headers: {Authorization: 'Bearer abc'}}}}));
    mkdirSync(path.join(a, 'skills', 'deploy'), {recursive: true});
    writeFileSync(path.join(a, 'skills', 'deploy', 'SKILL.md'), '---\nname: deploy\n---\nShip it.');
    const b = exportSettings(a);
    expect(Object.keys(b.files).sort()).toEqual(['AGENTS.md', 'config.json', 'mcp.json', 'skills/deploy/SKILL.md']);
    expect(b.files['mcp.json']).not.toContain('ghp_literal');
    expect(b.files['mcp.json']).not.toContain('Bearer abc');
    expect(b.files['mcp.json']).toContain('${HOME}');
    expect(b.redacted).toEqual(['mcp.json: gh.env.GITHUB_TOKEN', 'mcp.json: web.headers.Authorization']);
    const file = writeBundle(path.join(a, 'out.json'), b);

    const other = mkdtempSync(path.join(os.tmpdir(), 'rein-b-'));
    writeFileSync(path.join(other, 'AGENTS.md'), 'My own notes.');
    const r = importSettings(file, other);
    expect(r.written.sort()).toEqual(['AGENTS.md', 'config.json', 'mcp.json', 'skills/deploy/SKILL.md']);
    expect(r.backedUp).toEqual(['AGENTS.md']);
    expect(readFileSync(path.join(other, 'AGENTS.md.before-import'), 'utf8')).toBe('My own notes.');
    expect(readFileSync(path.join(other, 'skills', 'deploy', 'SKILL.md'), 'utf8')).toContain('Ship it.');
    expect(existsSync(path.join(other, 'accounts.json'))).toBe(false);
  });

  it('refuses files that are not a bundle, and paths outside the settings folder', () => {
    const d = mkdtempSync(path.join(os.tmpdir(), 'rein-c-'));
    writeFileSync(path.join(d, 'x.json'), '{"hello":1}');
    expect(() => importSettings(path.join(d, 'x.json'), d)).toThrow(/isn't a Rein settings file/);
    writeFileSync(path.join(d, 'evil.json'), JSON.stringify({rein: 'settings', version: 1, files: {'../../escape.txt': 'x', 'skills/../../../e2': 'x', 'accounts.json': 'x'}}));
    expect(importSettings(path.join(d, 'evil.json'), path.join(d, 'cfg')).written).toEqual([]);
  });
});

describe('another repo as a working directory', () => {
  it("delivers that repo's own AGENTS.md the first time the agent works there", async () => {
    const {ToolHost} = await import('../src/tools/host.js');
    const {realpathSync} = await import('node:fs');
    const main = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'rein-main-')));
    const lib = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'rein-lib-')));
    writeFileSync(path.join(lib, 'AGENTS.md'), 'In this repo, run make test.');
    writeFileSync(path.join(lib, 'x.c'), 'int x;\n');
    const host = new ToolHost({root: main, mode: () => 'bypass', approve: async () => 'once', configDirs: () => [lib]});
    const r = await host.call('read', {path: path.join(lib, 'x.c')});
    expect(r.text).toContain('In this repo, run make test.');
    expect((await host.call('read', {path: path.join(lib, 'x.c')})).text).not.toContain('make test'); // once
    host.close();
  });
});
