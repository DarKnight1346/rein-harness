import {describe, expect, it} from 'vitest';
import {agentTools} from '../src/agents/tools.js';
import {catalog} from '../src/router/catalog.js';
import {DEFAULT_CONFIG} from '../src/store/config.js';
import {acct, CLAUDE_FAKE_MODELS, fakeAdapter, install, reply, tempHome} from './fakes.js';

describe('cheap-explore', () => {
  it('sends questions about the codebase to the cheapest Claude model, read-only, and returns its findings', async () => {
    await tempHome([acct('claude', 'c1')]);
    install('claude', fakeAdapter('claude', CLAUDE_FAKE_MODELS, () => reply('ok')).adapter);
    await catalog.refresh();
    const spawned: any[] = [];
    const manager = {spawn: (o: any) => (spawned.push(o), {agent: {id: 1}, done: Promise.resolve({status: 'done', output: 'parser.go:120 parseClass'})})} as any;
    const explore = (experiments: string[]) => agentTools(manager, () => ({...DEFAULT_CONFIG, experiments})).find((t) => t.name === 'explore')!;
    expect(explore([]).enabled!()).toBe(false);
    const tool = explore(['cheap-explore']);
    expect(tool.enabled!()).toBe(true);
    const out = await tool.run({root: '/'} as any, {question: 'Where are classes parsed?'});
    expect(out.text).toBe('parser.go:120 parseClass');
    expect(spawned[0]).toMatchObject({model: 'claude:haiku', mode: 'new', definition: {tools: ['read', 'list', 'search']}});
  });
});
