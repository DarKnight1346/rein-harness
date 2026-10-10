import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {codeItems, Extensions, type Host} from '../src/extensions/index.js';
import {API_VERSION} from '../src/extensions/api.js';
import {parseInput, setExtensionCommands, suggestCommands} from '../src/commands/index.js';

let home: string;
let plugins: string;
const saved = process.env.REIN_HOME;
beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), 'rein-ext-'));
  process.env.REIN_HOME = home;
  plugins = path.join(home, 'plugins');
});
afterEach(() => {
  setExtensionCommands(() => []);
  if (saved === undefined) delete process.env.REIN_HOME;
  else process.env.REIN_HOME = saved;
});

/** A marketplace item with code, as installed in ~/.rein/plugins/<id>/. */
function item(id: string, code: string, manifest: Record<string, unknown> = {}) {
  const dir = path.join(plugins, id);
  mkdirSync(dir, {recursive: true});
  writeFileSync(path.join(dir, 'rein.json'), JSON.stringify({id, name: id, version: '1.0.0', description: '', main: 'index.mjs', api: 1, ...manifest}));
  writeFileSync(path.join(dir, 'index.mjs'), code);
  return dir;
}

const host = () => {
  const tools: {item: string; name: string; run: (a: any, c: any) => Promise<any>}[] = [];
  const h: Host & {tools: typeof tools} = {
    tools,
    cwd: () => home,
    config: () => ({chatModel: 'auto'}),
    registerTool: (item, t) => tools.push({item, name: t.name, run: t.run}),
    exec: async (cmd, args) => ({code: 0, stdout: `${cmd} ${args.join(' ')}`, stderr: ''}),
    shell: async (command) => ({ok: true, text: `ran ${command}`}),
    ripgrep: async () => '/usr/bin/rg',
    workspace: () => undefined,
  };
  return h;
};

describe('extensions', () => {
  it("loads an item's code: its command, tool, sidebar section, status segment, theme and settings", async () => {
    item('hello', `
      export function activate(rein) {
        rein.registerCommand({name: 'hello', description: 'Say hello', run: async (args, ctx) => ctx.log('hello ' + (args || rein.settings.get('who') || 'world'))});
        rein.registerCommand({name: 'model', description: 'tries to take a built-in name', run: () => {}});
        rein.registerTool({name: 'hello_tool', label: 'Hello', description: 'd', inputSchema: {type: 'object'}, run: async () => ({ok: true, text: 'tool ran in ' + rein.version})});
        rein.ui.sidebarSection({id: 'greeting', title: 'Greeting', render: (w) => ['hi', 'width ' + w]});
        rein.ui.statusSegment({id: 'wave', render: () => '👋'});
        rein.ui.theme({accent: '#ff00aa'});
        rein.settings.set('who', 'Rein');
      }`);
    const ext = new Extensions();
    const h = host();
    const r = await ext.loadAll(h, plugins);
    expect(r).toEqual({loaded: ['hello'], failed: []});
    expect(ext.commands.map((c) => c.value.name)).toEqual(['hello', 'model']);
    expect(h.tools.map((t) => t.name)).toEqual(['hello_tool']);
    expect(await h.tools[0]!.run({}, {cwd: home})).toEqual({ok: true, text: `tool ran in ${API_VERSION}`});
    expect(ext.sidebar[0]!.value.render(20)).toEqual(['hi', 'width 20']);
    expect(ext.status[0]!.value.render()).toBe('👋');
    expect(ext.theme).toEqual({accent: '#ff00aa'});
    // The command runs, and is in the / list and search; Rein's own /model wins the clash.
    setExtensionCommands(() => ext.commands.map((c) => c.value));
    const parsed = parseInput('/hello there');
    expect(parsed).toMatchObject({kind: 'extension', args: 'there'});
    const lines: string[] = [];
    await (parsed as any).command.run('', {cwd: home, log: (t: string) => lines.push(t), send() {}, window() {}});
    expect(lines).toEqual(['hello Rein']); // its setting, kept in its data folder
    expect(suggestCommands('/hell').map((c) => c.name)[0]).toBe('hello');
    expect(parseInput('/model')).toMatchObject({kind: 'command', name: 'model'});
    expect(suggestCommands('/').filter((c) => c.name === 'model')).toHaveLength(1);
  });

  it("refuses an item that needs a newer API, or whose code fails, and says why", async () => {
    item('future', 'export function activate() {}', {api: API_VERSION + 1});
    item('broken', `export function activate(rein) { rein.registerCommand({name: 'half', description: '', run() {}}); throw new Error('boom'); }`);
    item('nothing', 'export const x = 1;');
    const ext = new Extensions();
    const r = await ext.loadAll(host(), plugins);
    expect(r.loaded).toEqual([]);
    expect(Object.fromEntries(r.failed.map((f) => [f.id, f.error]))).toEqual({
      broken: 'boom',
      future: `it needs extension API ${API_VERSION + 1}; this Rein has ${API_VERSION} (update Rein: /update)`,
      nothing: 'index.mjs has no activate(rein) export',
    });
    expect(ext.commands).toEqual([]); // what the broken one registered before failing is gone
  });

  it("runs an item's command lines through Rein's shell (approvals and sandbox), not on its own", async () => {
    item('runner', `export function activate(rein) { rein.registerCommand({name: 'runit', description: '', run: async (a, ctx) => ctx.log((await rein.shell('npm test')).text)}); }`, {api: 3});
    const ext = new Extensions();
    const ran: string[] = [];
    const h = {...host(), shell: async (command: string) => (ran.push(command), {ok: false, text: 'denied'})};
    await ext.loadAll(h, plugins);
    const lines: string[] = [];
    await ext.command('runit')!.run('', {cwd: home, log: (t) => lines.push(t), send() {}, window() {}});
    expect([ran, lines]).toEqual([['npm test'], ['denied']]);
  });

  it('loads fresh code after an update, and forgets an uninstalled item', async () => {
    const dir = item('counter', `export function activate(rein) { rein.registerCommand({name: 'which', description: 'v1', run() {}}); }`);
    const ext = new Extensions();
    await ext.loadAll(host(), plugins);
    expect(ext.command('which')?.description).toBe('v1');
    expect((await ext.loadAll(host(), plugins)).loaded).toEqual([]); // unchanged: not loaded twice
    writeFileSync(path.join(dir, 'index.mjs'), `export function activate(rein) { rein.registerCommand({name: 'which', description: 'v2', run() {}}); }`);
    expect((await ext.loadAll(host(), plugins)).loaded).toEqual(['counter']);
    expect(ext.commands.map((c) => c.value.description)).toEqual(['v2']);
    rmSync(dir, {recursive: true});
    await ext.loadAll(host(), plugins);
    expect(ext.commands).toEqual([]);
  });

  it("keeps an item's checks on the agent's work, and drops them with the item", async () => {
    const dir = item('checker', `
      export function activate(rein) {
        rein.checks.endOfTurn({id: 'big', run: (changed) => changed.some((f) => (f.after ?? '').length > 10) ? 'too big' : undefined});
        rein.checks.afterEdit({id: 'note', run: ({path}) => path.endsWith('.sql') ? 'a migration' : undefined});
      }`);
    const ext = new Extensions();
    await ext.loadAll(host(), plugins);
    expect(await ext.endChecks[0]!.value.run([{path: 'a.txt', after: 'x'.repeat(20)}])).toBe('too big');
    expect(ext.editChecks[0]!.value.run({path: 'db/1.sql', args: {}})).toBe('a migration');
    rmSync(dir, {recursive: true});
    await ext.loadAll(host(), plugins);
    expect([ext.endChecks.length, ext.editChecks.length]).toEqual([0, 0]);
  });

  it("never loads a main file outside the item's folder", () => {
    item('sneaky', 'export function activate() {}', {main: '../elsewhere.mjs'});
    expect(codeItems(plugins)).toEqual([]);
  });
});
