import {describe, expect, it} from 'vitest';
import {checkQuestion, dueForCheck, parseVerdict} from '../src/tools/backgroundCheck.js';
import type {Shell} from '../src/tools/shells.js';

const shell = (over: Partial<Shell> = {}): Shell => ({id: 3, command: 'gmake run', cwd: '/p', background: true, startedAt: 0, status: 'running', lines: [], dropped: 0, ...over});
const H = 3600_000;

describe('background command check', () => {
  it('is due once a background command has run an hour, then hourly after each check', () => {
    expect(dueForCheck([shell()], new Map(), 60, 59 * 60_000)).toEqual([]);
    expect(dueForCheck([shell()], new Map(), 60, H).map((s) => s.id)).toEqual([3]);
    expect(dueForCheck([shell()], new Map([[3, H]]), 60, 1.5 * H)).toEqual([]);
    expect(dueForCheck([shell()], new Map([[3, H]]), 60, 2 * H).map((s) => s.id)).toEqual([3]);
  });

  it('skips foreground, finished and subagent commands, and does nothing when off', () => {
    const all = [shell({background: false}), shell({status: 'exited'}), shell({origin: {agentId: 1, name: 'x'}})];
    expect(dueForCheck(all, new Map(), 60, 5 * H)).toEqual([]);
    expect(dueForCheck([shell()], new Map(), 0, 5 * H)).toEqual([]);
  });

  it('reads KEEP / STOP and keeps the command when the answer is unclear', () => {
    expect(parseVerdict('STOP: the QEMU run was for the first check, which is done')).toEqual({keep: false, reason: 'the QEMU run was for the first check, which is done'});
    expect(parseVerdict('**KEEP** — the user is still clicking around in the VM')).toEqual({keep: true, reason: 'the user is still clicking around in the VM'});
    expect(parseVerdict("I'm not sure what you mean")).toEqual({keep: true, reason: 'no clear answer'});
  });

  it('asks with the command, its age and its latest output', () => {
    const q = checkQuestion(shell({startedAt: Date.now() - 65 * 60_000}), 'BdsDxe: loading Boot0001');
    expect(q).toContain('#3 `gmake run`');
    expect(q).toContain('running 1h 5m');
    expect(q).toContain('BdsDxe: loading Boot0001');
  });
});
