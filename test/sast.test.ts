import {chmodSync, mkdtempSync, realpathSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {addedLines, newFindings} from '../src/tools/sast.js';

const result = (file: string, line: number, message: string) => ({path: file, start: {line}, check_id: 'python.lang.security.audit.eval-detected', extra: {message, severity: 'WARNING'}});

describe('sast', () => {
  it('knows which lines a change added', () => {
    expect([...addedLines('a\nb\nc\n', 'a\nB\nc\nd\n')]).toEqual([2, 4]);
    expect([...addedLines(null, 'x\ny\n')]).toEqual([1, 2]);
  });

  it('reports only findings on added lines, relative to the project', () => {
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'rein-sast-')));
    const file = path.join(root, 'app.py');
    writeFileSync(file, 'import os\nx = eval(input())\nold = eval("1")\n');
    const json = JSON.stringify({results: [result('app.py', 2, 'Detected eval'), result('app.py', 3, 'Detected eval')]});
    expect(newFindings(json, [{file, before: 'import os\nold = eval("1")\n'}], root)).toEqual(['app.py:2: [warning] Detected eval (eval-detected)']);
    expect(newFindings(json, [{file, before: undefined}], root)).toHaveLength(2); // unknown before: everything counts
    expect(newFindings('not json', [{file, before: null}], root)).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('runs Semgrep when it is installed and says what to fix', async () => {
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'rein-sast-')));
    const bin = mkdtempSync(path.join(os.tmpdir(), 'rein-bin-'));
    const file = path.join(root, 'app.py');
    writeFileSync(file, 'x = eval(input())\n');
    writeFileSync(path.join(bin, 'semgrep'), `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 1.0; exit 0; fi\necho '${JSON.stringify({results: [result('app.py', 1, 'Detected eval')]})}'\n`);
    chmodSync(path.join(bin, 'semgrep'), 0o755);
    const prev = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${prev}`;
    try {
      const {sastCheck} = await import('../src/tools/sast.js');
      expect(await sastCheck([{file, before: ''}], root)).toMatch(/^Semgrep found 1 problem in lines this turn added:\napp\.py:1: \[warning\] Detected eval/);
    } finally {
      process.env.PATH = prev;
    }
  });
});
