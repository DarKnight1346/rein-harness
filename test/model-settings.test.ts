import {beforeEach, describe, expect, it} from 'vitest';
import {agentTools} from '../src/agents/tools.js';
import {catalog} from '../src/router/catalog.js';
import {DEFAULT_CONFIG, type Config} from '../src/store/config.js';
import {usageStore} from '../src/store/usage.js';
import {imageTool} from '../src/tools/image.js';
import {acct, CLAUDE_FAKE_MODELS, CODEX_FAKE_MODELS, fakeAdapter, install, reply, tempHome} from './fakes.js';

let config: Config;
async function signIn(codex: boolean) {
  await tempHome([acct('claude', 'c1'), ...(codex ? [acct('codex', 'x1')] : [])]);
  install('claude', fakeAdapter('claude', CLAUDE_FAKE_MODELS, () => reply('ok')).adapter);
  install('codex', fakeAdapter('codex', CODEX_FAKE_MODELS, () => reply('ok')).adapter);
  await catalog.refresh();
}
beforeEach(() => {
  config = {...DEFAULT_CONFIG};
  usageStore.reset();
  catalog.authFailed.clear();
});

describe('/model → Subagents', () => {
  const spawned: {model: string; mode: string}[] = [];
  const manager = {spawn: (o: any) => (spawned.push({model: o.model, mode: o.mode}), {agent: {id: 1, name: 'x'}, done: Promise.resolve({})})} as any;

  it('auto: the agent chooses the model', async () => {
    await signIn(true);
    const [agent] = agentTools(manager, () => config);
    expect((agent!.schema!() as any).properties.model.enum).toEqual(expect.arrayContaining(['auto', 'claude:haiku', 'codex:gpt-x']));
    await agent!.run({root: '/'} as any, {task: 't', mode: 'new', model: 'claude:haiku', background: true});
    expect(spawned.at(-1)).toEqual({model: 'claude:haiku', mode: 'new'});
  });

  it('a fixed model removes the choice and is always used', async () => {
    await signIn(true);
    config.subagentModel = 'codex:gpt-x';
    const [agent] = agentTools(manager, () => config);
    expect((agent!.schema!() as any).properties.model).toBeUndefined();
    expect(agent!.describe!()).toContain('run on GPT-X (set by the user');
    await agent!.run({root: '/'} as any, {task: 't', mode: 'new', model: 'claude:haiku', background: true});
    expect(spawned.at(-1)).toEqual({model: 'codex:gpt-x', mode: 'new'});
  });

  it('a fixed model that is not signed in falls back to auto', async () => {
    await signIn(false);
    config.subagentModel = 'codex:gpt-x';
    const [agent] = agentTools(manager, () => config);
    expect((agent!.schema!() as any).properties.model).toBeDefined();
  });
});

describe('image_generate availability', () => {
  it('is offered only while a Codex account is signed in', async () => {
    await signIn(false);
    expect(imageTool(() => config).enabled!()).toBe(false);
    await signIn(true);
    expect(imageTool(() => config).enabled!()).toBe(true);
    catalog.authFailed.add('x1'); // Codex login broke
    expect(imageTool(() => config).enabled!()).toBe(false);
  });
});
