import {execFileSync} from 'node:child_process';
import {chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {branchSize, currentPr, describePr, queueFor, reviewComments, type Pr} from '../src/pr/github.js';

const PR: Pr = {number: 42, url: 'https://github.com/acme/app/pull/42', title: 'Rate limiting', state: 'OPEN', isDraft: false, additions: 120, deletions: 8, changedFiles: 5, headRefName: 'feat/limit', baseRefName: 'main', reviewDecision: 'CHANGES_REQUESTED', mergeStateStatus: 'BLOCKED'};

let root: string;
let prevPath: string | undefined;
beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'rein-pr-')));
  // A fake gh: answers by its arguments.
  const bin = path.join(root, '.bin');
  mkdirSync(bin);
  writeFileSync(
    path.join(bin, 'gh'),
    `#!/bin/sh
case "$*" in
  "pr view --json"*) echo '${JSON.stringify(PR)}' ;;
  "repo view"*) echo acme/app ;;
  "api --paginate repos/acme/app/pulls/42/comments") echo '[{"user":{"login":"maria"},"body":"This never resets the window","path":"src/limit.ts","line":12}]' ;;
  "pr view 42 --json reviews"*) echo '[{"author":{"login":"maria"},"body":"Needs a test","state":"CHANGES_REQUESTED"}]' ;;
  *) exit 1 ;;
esac
`,
  );
  chmodSync(path.join(bin, 'gh'), 0o755);
  prevPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${prevPath}`;
});
afterEach(() => {
  process.env.PATH = prevPath;
});

describe.skipIf(process.platform === 'win32')('/pr', () => {
  it("reads the branch's pull request and describes it", async () => {
    const pr = (await currentPr(root)) as Pr;
    expect(pr.number).toBe(42);
    expect(describePr(pr)).toBe('#42 Rate limiting · open · feat/limit → main\n  +120 −8 in 5 files · review: changes requested · merge: blocked\n  https://github.com/acme/app/pull/42');
  });

  it('collects inline review comments and review bodies', async () => {
    expect(await reviewComments(root, PR)).toEqual([
      {author: 'maria', body: 'This never resets the window', path: 'src/limit.ts', line: 12, url: undefined},
      {author: 'maria', body: '[changes_requested] Needs a test'},
    ]);
  });

  it('picks the merge queue: Mergify when configured, else GitHub auto-merge', async () => {
    expect((await queueFor(root, PR)).command).toEqual(['gh', 'pr', 'merge', '42', '--auto', '--squash']);
    writeFileSync(path.join(root, '.mergify.yml'), 'queue_rules: []\n');
    expect((await queueFor(root, PR)).command).toEqual(['gh', 'pr', 'comment', '42', '--body', '@Mergifyio queue']);
  });

  it("measures the branch against its base", async () => {
    const git = (...a: string[]) => execFileSync('git', a, {cwd: root, stdio: 'ignore'});
    git('init', '-q');
    git('config', 'user.email', 't@t');
    git('config', 'user.name', 't');
    writeFileSync(path.join(root, 'a.txt'), 'one\n');
    git('add', 'a.txt');
    git('commit', '-qm', 'base');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    writeFileSync(path.join(root, 'a.txt'), 'one\ntwo\nthree\n');
    git('commit', '-qam', 'more');
    expect(await branchSize(root)).toEqual({lines: 2, added: 2, removed: 0, base: 'origin/main'});
  });
});
