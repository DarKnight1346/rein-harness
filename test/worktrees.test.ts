import {execFileSync} from 'node:child_process';
import {existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {beforeEach, describe, expect, it} from 'vitest';
import {retarget, Worktrees} from '../src/agents/worktrees.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, {cwd, encoding: 'utf8', env: {...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t'}});
let repo: string;
beforeEach(() => {
  process.env.REIN_HOME = mkdtempSync(path.join(os.tmpdir(), 'rein-wt-home-'));
  repo = mkdtempSync(path.join(os.tmpdir(), 'rein-wt-repo-'));
  git(repo, 'init', '-q');
  git(repo, 'config', 'core.autocrlf', 'false'); // the same bytes on every platform (Windows CI defaults to true)
  writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n.env\ndist/\n');
  writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\nthree\nfour\nfive\n');
  writeFileSync(path.join(repo, 'b.txt'), 'b\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  // Uncommitted and untracked work, ignored deps and secrets.
  writeFileSync(path.join(repo, 'b.txt'), 'b edited, not committed\n');
  writeFileSync(path.join(repo, 'new.txt'), 'untracked\n');
  mkdirSync(path.join(repo, 'node_modules', 'left-pad'), {recursive: true});
  writeFileSync(path.join(repo, 'node_modules', 'left-pad', 'index.js'), 'module.exports=1');
  writeFileSync(path.join(repo, '.env'), 'TOKEN=x\n');
  git(repo, 'add', 'b.txt'); // something staged: the user's index must survive untouched
});

describe('subagent worktrees', () => {
  it('start from the project as it is, with deps linked and .env copied, without touching the index', async () => {
    const status = git(repo, 'status', '--porcelain');
    const wts = new Worktrees(repo, () => 's1');
    const wt = (await wts.ensure(1))!;
    expect(readFileSync(path.join(wt.root, 'b.txt'), 'utf8')).toBe('b edited, not committed\n');
    expect(readFileSync(path.join(wt.root, 'new.txt'), 'utf8')).toBe('untracked\n');
    expect(lstatSync(path.join(wt.root, 'node_modules')).isSymbolicLink()).toBe(true);
    expect(readFileSync(path.join(wt.root, '.env'), 'utf8')).toBe('TOKEN=x\n');
    expect(git(repo, 'status', '--porcelain')).toBe(status);
    expect(await wts.ensure(1)).toBe(wt); // one per agent
  });

  it("merge the agent's changes back, keeping the project's own edits since, and delete the worktree", async () => {
    const wts = new Worktrees(repo);
    const wt = (await wts.ensure(1))!;
    // The subagent edits line 1, adds a file, deletes one.
    writeFileSync(path.join(wt.root, 'a.txt'), 'ONE\ntwo\nthree\nfour\nfive\n');
    writeFileSync(path.join(wt.root, 'added.txt'), 'from the agent\n');
    execFileSync('rm', [path.join(wt.root, 'new.txt')]);
    // Meanwhile the main agent edits line 5 of the same file.
    writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\nthree\nfour\nFIVE\n');
    const r = (await wts.settle(1))!;
    expect(r.conflicts).toEqual([]);
    expect(r.merged.sort()).toEqual(['a.txt', 'added.txt', 'new.txt']);
    expect(readFileSync(path.join(repo, 'a.txt'), 'utf8')).toBe('ONE\ntwo\nthree\nfour\nFIVE\n');
    expect(readFileSync(path.join(repo, 'added.txt'), 'utf8')).toBe('from the agent\n');
    expect(existsSync(path.join(repo, 'new.txt'))).toBe(false);
    expect(existsSync(path.join(repo, 'node_modules', 'left-pad', 'index.js'))).toBe(true); // the link wasn't "merged"
    expect(existsSync(wt.dir)).toBe(false);
    expect(git(repo, 'worktree', 'list')).not.toContain(wt.dir);
  });

  it('leave real conflicts for the main agent, with the worktree kept', async () => {
    const wts = new Worktrees(repo);
    const wt = (await wts.ensure(2))!;
    writeFileSync(path.join(wt.root, 'a.txt'), 'agent\ntwo\nthree\nfour\nfive\n');
    writeFileSync(path.join(repo, 'a.txt'), 'main\ntwo\nthree\nfour\nfive\n');
    const r = (await wts.settle(2))!;
    expect(r.conflicts).toEqual(['a.txt']);
    expect(readFileSync(path.join(repo, 'a.txt'), 'utf8')).toBe('main\ntwo\nthree\nfour\nfive\n');
    expect(r.kept).toBe(wt.dir);
    expect(readFileSync(path.join(wt.dir, 'a.txt'), 'utf8')).toContain('agent');
  });

  it('do nothing outside git', async () => {
    const plain = mkdtempSync(path.join(os.tmpdir(), 'rein-plain-'));
    expect(await new Worktrees(plain).ensure(1)).toBeUndefined();
  });

  it("point the project's absolute paths at the worktree", () => {
    expect(retarget({path: '/p/proj/src/a.ts', command: 'cd /p/proj && ls /p/project-other'}, '/p/proj', '/w/x')).toEqual({path: '/w/x/src/a.ts', command: 'cd /w/x && ls /p/project-other'});
    expect(retarget({path: 'C:\\p\\proj\\src\\a.ts', other: 'C:\\p\\project2'}, 'C:\\p\\proj', 'C:\\w\\x')).toEqual({path: 'C:\\w\\x\\src\\a.ts', other: 'C:\\p\\project2'});
  });
});

describe('worktree recovery', () => {
  it("merges work left by a Rein that died before its subagent finished", async () => {
    const wts = new Worktrees(repo);
    const wt = (await wts.ensure(7))!;
    writeFileSync(path.join(wt.root, 'b.txt'), 'finished by the agent\n');
    // Pretend the owning process died.
    const meta = `${wt.dir}.json`;
    writeFileSync(meta, JSON.stringify({...JSON.parse(readFileSync(meta, 'utf8')), pid: 999999}));
    const results = await new Worktrees(repo).recover();
    expect(results).toEqual([{merged: ['b.txt'], conflicts: []}]);
    expect(readFileSync(path.join(repo, 'b.txt'), 'utf8')).toBe('finished by the agent\n');
    expect(existsSync(wt.dir)).toBe(false);
    expect(existsSync(meta)).toBe(false);
  });
});

describe('isolated subagent tool calls', () => {
  it("run in the worktree (absolute project paths too) and merge home when settled", async () => {
    const {ToolHost} = await import('../src/tools/host.js');
    const wts = new Worktrees(repo);
    const host = new ToolHost({root: repo, mode: () => 'bypass', approve: async () => 'once', sandbox: () => 'write', isolate: async (origin, writes) => wts.get(origin.agentId!) ?? (writes ? wts.ensure(origin.agentId!) : undefined)});
    const agent = {agentId: 3, name: 'helper'};
    // Reads before any change happen in the project itself.
    expect((await host.call('read', {path: 'b.txt'}, agent)).text).toContain('b edited');
    expect(wts.get(3)).toBeUndefined();
    const w = await host.call('write', {path: path.join(repo, 'from-agent.txt'), content: 'hello\n'}, agent);
    expect(w.ok).toBe(true);
    expect(existsSync(path.join(repo, 'from-agent.txt'))).toBe(false); // not in the project yet
    expect(readFileSync(path.join(wts.get(3)!.root, 'from-agent.txt'), 'utf8')).toBe('hello\n');
    const sh = await host.call('shell', {command: `echo more >> from-agent.txt && cat '${repo}/from-agent.txt'`}, agent);
    expect(sh.text).toContain('more');
    // git works inside the sandboxed worktree (it writes the worktree's own index in the main .git).
    const st = await host.call('shell', {command: 'git add -A && git status --short'}, agent);
    expect(st.ok).toBe(true);
    expect(st.text).toContain('from-agent.txt');
    const r = (await wts.settle(3))!;
    expect(r.merged).toEqual(['from-agent.txt']);
    expect(readFileSync(path.join(repo, 'from-agent.txt'), 'utf8')).toBe('hello\nmore\n');
    host.close();
  });
});

describe('commits made inside a worktree', () => {
  it("come home as uncommitted changes, stay reachable under refs/rein, and are reported", async () => {
    const {mergeNote} = await import('../src/agents/worktrees.js');
    const wts = new Worktrees(repo);
    const wt = (await wts.ensure(4))!;
    writeFileSync(path.join(wt.root, 'feature.txt'), 'committed by the agent\n');
    git(wt.root, 'add', 'feature.txt');
    git(wt.root, 'commit', '-q', '-m', 'Add the feature');
    const r = (await wts.settle(4))!;
    expect(r.merged).toEqual(['feature.txt']);
    expect(r.commits).toHaveLength(1);
    expect(r.commits![0]).toMatch(/^[0-9a-f]+ Add the feature$/);
    expect(git(repo, 'log', '-1', '--format=%s', r.ref!).trim()).toBe('Add the feature');
    expect(git(repo, 'log', '-1', '--format=%s').trim()).toBe('init'); // the user's branch didn't move
    expect(git(repo, 'status', '--porcelain')).toContain('?? feature.txt');
    expect(mergeNote(r)).toContain('NOT on the user\'s branch');
  });
});

describe('ignored build output', () => {
  it('is copied into the worktree (not linked), and never merged back', async () => {
    mkdirSync(path.join(repo, 'dist', 'lib'), {recursive: true});
    writeFileSync(path.join(repo, 'dist', 'lib', 'app.js'), 'built();\n');
    const wts = new Worktrees(repo);
    const wt = (await wts.ensure(5))!;
    const copy = path.join(wt.root, 'dist', 'lib', 'app.js');
    expect(readFileSync(copy, 'utf8')).toBe('built();\n');
    expect(lstatSync(path.join(wt.root, 'dist')).isSymbolicLink()).toBe(false);
    writeFileSync(copy, 'rebuilt by the agent();\n'); // its own build doesn't touch the project's
    expect(readFileSync(path.join(repo, 'dist', 'lib', 'app.js'), 'utf8')).toBe('built();\n');
    const r = (await wts.settle(5))!;
    expect(r.merged).toEqual([]);
    expect(readFileSync(path.join(repo, 'dist', 'lib', 'app.js'), 'utf8')).toBe('built();\n');
  });
});

describe('line endings (core.autocrlf, the Windows default)', () => {
  it("merge without false conflicts, and keep each file's own line endings", async () => {
    git(repo, 'config', 'core.autocrlf', 'true');
    writeFileSync(path.join(repo, 'crlf.txt'), 'one\r\ntwo\r\nthree\r\nfour\r\nfive\r\n');
    writeFileSync(path.join(repo, 'lf.txt'), 'alpha\nbeta\n');
    git(repo, 'add', 'crlf.txt', 'lf.txt');
    git(repo, 'commit', '-q', '-m', 'files');
    const wts = new Worktrees(repo);
    const wt = (await wts.ensure(6))!;
    const inWt = (f: string) => readFileSync(path.join(wt.root, f), 'utf8');
    writeFileSync(path.join(wt.root, 'crlf.txt'), inWt('crlf.txt').replace('one', 'ONE')); // agent: line 1
    writeFileSync(path.join(wt.root, 'lf.txt'), inWt('lf.txt').replace('alpha', 'ALPHA'));
    writeFileSync(path.join(repo, 'crlf.txt'), 'one\r\ntwo\r\nthree\r\nfour\r\nFIVE\r\n'); // main: line 5
    const r = (await wts.settle(6))!;
    expect(r.conflicts).toEqual([]);
    expect(r.merged.sort()).toEqual(['crlf.txt', 'lf.txt']);
    expect(readFileSync(path.join(repo, 'crlf.txt'), 'utf8')).toBe('ONE\r\ntwo\r\nthree\r\nfour\r\nFIVE\r\n');
    expect(readFileSync(path.join(repo, 'lf.txt'), 'utf8')).toBe('ALPHA\nbeta\n');
  });
});
