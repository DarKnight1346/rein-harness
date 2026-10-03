import {chmodSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync} from 'node:fs';
import {constants} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {editTool, openConfined, writeTool} from '../src/tools/fs.js';

const dirs = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rein-race-'));
  const outside = mkdtempSync(path.join(os.tmpdir(), 'rein-outside-'));
  return {root, outside, ctx: {root} as any};
};

describe('file tools vs. symlink swaps', () => {
  it('a path that became a symlink after the check is refused, not followed', async () => {
    const {root, outside} = dirs();
    const secret = path.join(outside, 'secret.txt');
    writeFileSync(secret, 'keep me');
    // Simulates the race: resolveInRoot approved `a.txt`, then it was replaced by a symlink.
    const swapped = path.join(root, 'a.txt');
    symlinkSync(secret, swapped);
    await expect(openConfined(swapped, 'a.txt', constants.O_RDWR)).rejects.toThrow(/became a symlink/);
    expect(readFileSync(secret, 'utf8')).toBe('keep me');
  });

  it('write never writes through a symlink planted at the target', async () => {
    const {root, outside, ctx} = dirs();
    const secret = path.join(outside, 'secret.txt');
    writeFileSync(secret, 'keep me');
    symlinkSync(secret, path.join(root, 'link.txt'));
    // resolveInRoot follows the link, sees it leaves the project, and refuses up front.
    await expect(writeTool(ctx, {path: 'link.txt', content: 'pwned'})).rejects.toThrow(/outside the project/);
    expect(readFileSync(secret, 'utf8')).toBe('keep me');
  });

  it('write/edit still work normally and keep the file mode', async () => {
    const {root, ctx} = dirs();
    await writeTool(ctx, {path: 'dir/new.sh', content: 'echo one\n'});
    chmodSync(path.join(root, 'dir/new.sh'), 0o755);
    await writeTool(ctx, {path: 'dir/new.sh', content: 'echo two\n'});
    await editTool(ctx, {path: 'dir/new.sh', old_string: 'two', new_string: 'three'});
    expect(readFileSync(path.join(root, 'dir/new.sh'), 'utf8')).toBe('echo three\n');
    if (process.platform !== 'win32') expect(statSync(path.join(root, 'dir/new.sh')).mode & 0o777).toBe(0o755); // no Unix modes on Windows
  });

  it('big-file streaming edit uses a random, exclusive temp file and keeps the mode', async () => {
    const {root, ctx} = dirs();
    const big = path.join(root, 'big.log');
    writeFileSync(big, 'x'.repeat(9 * 1024 * 1024) + '\nNEEDLE\n');
    chmodSync(big, 0o640);
    const res = await editTool(ctx, {path: 'big.log', old_string: 'NEEDLE', new_string: 'FOUND'});
    expect(res.text).toMatch(/streamed/);
    expect(readFileSync(big, 'utf8').endsWith('\nFOUND\n')).toBe(true);
    if (process.platform !== 'win32') expect(statSync(big).mode & 0o777).toBe(0o640);
    expect(readdirSync(root).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });
});
