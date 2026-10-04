import {afterEach, describe, expect, it, vi} from 'vitest';
import {notify} from '../src/ui/terminal/notify.js';

afterEach(() => vi.restoreAllMocks());

describe('notifications', () => {
  it('rings the bell and sends an OSC 9 notification, with control characters stripped', () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    notify('terminal', 'Rein needs your approval', 'Shell(rm -rf build\x1b]0;x\x07)');
    expect(write).toHaveBeenCalledWith('\x07\x1b]9;Rein needs your approval: Shell(rm -rf build ]0;x )\x07');
  });

  it('stays quiet when off', () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    notify('off', 'Rein is done', 'Ready');
    expect(write).not.toHaveBeenCalled();
  });
});
