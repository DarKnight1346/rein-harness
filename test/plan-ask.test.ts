import {describe, expect, it} from 'vitest';
import {askUserTool, type AskQuestion} from '../src/tools/ask.js';
import {presentPlanTool, readOnlyCommand} from '../src/tools/plan.js';
import {loadSkills} from '../src/skills/index.js';

describe('plan mode', () => {
  it('lets only read-only shell commands through', () => {
    for (const c of ['ls -la', 'git status', 'git log --oneline -5', 'rg TODO src | head -20', 'cat a.ts && wc -l a.ts', 'npm ls react', 'make 2>&1 >/dev/null'.replace('make', 'ls')]) expect(readOnlyCommand(c)).toBe(true);
    for (const c of ['rm -rf dist', 'npm install', 'git commit -m x', 'echo hi > out.txt', 'cat a >> b', 'find . -delete', 'git config user.name x', 'sed -i s/a/b/ f', 'ls $(rm x)']) expect(readOnlyCommand(c)).toBe(false);
  });

  it('knows the common read-only queries (versions, package info, system info)', () => {
    for (const c of ['sw_vers', 'uname -m', 'clang++ --version', 'brew list --formula', 'brew info --json=v2 qemu', 'which brew qemu-system-x86_64', 'df -h ~', 'sysctl -n machdep.cpu.brand_string', 'xcode-select -p', 'pip3 list', 'cargo tree', 'go env GOPATH', 'docker ps -a', 'git branch -a', 'git branch --list "feat*"', 'git tag', 'git tag -l', 'git remote -v', 'git stash list', 'git config --get user.name', 'npm config get registry', 'gcc -v', 'ls /usr/local/opt | head'])
      expect(readOnlyCommand(c), c).toBe(true);
    for (const c of ['brew install qemu', 'brew upgrade', 'pip3 install x', 'git branch feature', 'git branch -D old', 'git tag -a v1 -m x', 'git tag v1', 'git remote add o url', 'git stash', 'git stash pop', 'env rm -rf x', 'sort -o out.txt in.txt', 'tree -o out.txt', 'find . -fprint out', 'xxd a b', 'npm audit fix', 'sysctl -w kern.x=1', 'date -s 2020', 'docker run x', 'cargo build', 'go build', 'kubectl delete pod x', 'make --version-check'])
      expect(readOnlyCommand(c), c).toBe(false);
  });

  it('present_plan returns the decision and turns plan mode off when approved', async () => {
    let active = true;
    let decided = '';
    const t = presentPlanTool({active: () => active, scratch: () => undefined, present: async () => 'approve-all', done: (d) => ((decided = d), (active = false))});
    const r = await t.run({} as any, {plan: '## Goal\nAdd a flag.\n1. Edit cli.ts\n2. Test'});
    expect(r.text).toMatch(/approved .* allowed all changes .* carry it out/);
    expect(decided).toBe('approve-all');
    await expect(t.run({} as any, {plan: 'x'.repeat(40)})).rejects.toThrow(/plan mode is off/);
  });

  it('/plan and /plan:deep are built-in skills that turn plan mode on', () => {
    const skills = loadSkills('/tmp');
    expect(skills.find((s) => s.name === 'plan')?.planMode).toBe(true);
    const deep = skills.find((s) => s.name === 'plan:deep');
    expect(deep?.planMode).toBe(true);
    expect(deep?.body).toMatch(/advisor/i);
    expect(deep?.body).toMatch(/ask_user/);
  });
});

describe('ask_user', () => {
  const qs = [
    {id: 'db', question: 'Which database?', options: [{label: 'Postgres'}, {label: 'SQLite'}]},
    {id: 'features', question: 'Which features?', options: ['auth', 'billing', 'search'], multi: true},
  ];
  it('collects every answer, including typed "something else" answers', async () => {
    let seen: AskQuestion[] = [];
    const t = askUserTool(() => async (q) => ((seen = q), [{id: 'db', selected: [], other: 'MySQL 8, it is what ops runs'}, {id: 'features', selected: ['auth', 'search']}]));
    const r = await t.run({} as any, {questions: qs});
    expect(seen[1]!.multi).toBe(true);
    expect(seen[1]!.options.map((o) => o.label)).toEqual(['auth', 'billing', 'search']);
    expect(r.text).toContain('Which database?\n→ (their own answer) MySQL 8, it is what ops runs');
    expect(r.text).toContain('Which features?\n→ auth; search');
  });
  it('dismissed, headless and malformed cases', async () => {
    expect((await askUserTool(() => async () => undefined).run({} as any, {questions: qs})).text).toMatch(/dismissed/);
    expect((await askUserTool(() => undefined).run({} as any, {questions: qs})).text).toMatch(/headless/);
    await expect(askUserTool(() => undefined).run({} as any, {questions: [{question: 'x?', options: ['only']}]})).rejects.toThrow(/at least 2 options/);
  });
});

describe('read-only commands and plan mode in the tool host', async () => {
  const {mkdtempSync, realpathSync} = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const {ToolHost} = await import('../src/tools/host.js');
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'rein-plan-')));

  it('read-only commands run without asking; outside paths and other commands still ask', async () => {
    const asked: string[] = [];
    const host = new ToolHost({root, mode: () => 'ask', approve: async (r) => (asked.push(r.args.command), 'once')});
    expect((await host.call('shell', {command: 'echo hi'})).ok).toBe(true);
    expect((await host.call('shell', {command: 'git --version'})).ok).toBe(true);
    expect(asked).toEqual([]);
    await host.call('shell', {command: 'ls ~/.ssh'});
    await host.call('shell', {command: 'touch made.txt'});
    expect(asked).toEqual(['ls ~/.ssh', 'touch made.txt']);
    host.close();
  });

  it('plan mode (ask mode): read-only runs, other commands ask (allow once / deny); edits are refused', async () => {
    const asked: {command: string; planMode?: boolean}[] = [];
    const host = new ToolHost({root, mode: () => 'ask', planMode: () => true, approve: async (r) => (asked.push({command: r.args.command, planMode: r.planMode}), 'deny')});
    expect((await host.call('shell', {command: 'uname -m'})).ok).toBe(true);
    const r = await host.call('shell', {command: 'brew install qemu'});
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/plan mode is on and the user declined/);
    expect(asked).toEqual([{command: 'brew install qemu', planMode: true}]);
    expect((await host.call('write', {path: 'x.txt', content: 'x'})).text).toMatch(/plan mode is on/);
    host.close();
  });

  it('plan mode: unlisted commands go to the decision model; bypass never prompts', async () => {
    const asked: string[] = [];
    const judged: string[] = [];
    const judge = async (c: string) => (judged.push(c), {readOnly: c.includes('brew deps'), note: 'test'});
    const host = new ToolHost({root, mode: () => 'bypass', planMode: () => true, readOnlyJudge: judge, approve: async (r) => (asked.push(r.args.command), 'once')});
    expect((await host.call('shell', {command: 'for f in $(echo a b); do echo "brew deps $f"; done'})).ok).toBe(true);
    const r = await host.call('shell', {command: 'make install'});
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/waits for the plan's approval/);
    expect(asked).toEqual([]);
    expect(judged).toHaveLength(2);
    host.close();
  });
});
