import {mkdtempSync, realpathSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {isPlanFile, planPreview, planPreviewLines} from '../src/ui/planPreview.js';

describe('plans render as markdown wherever they are written or presented', () => {
  it('recognises plan files', () => {
    for (const p of ['plan.md', '~/.rein/scratch/x/plan.md', '.rein/plans/2026-10-03-os.md', 'docs/plans/roadmap.md', 'migration-plan.md']) expect(isPlanFile(p), p).toBe(true);
    for (const p of ['README.md', 'plan.ts', 'src/planner.ts', 'notes.md']) expect(isPlanFile(p), p).toBe(false);
  });

  it('captures the written plan once (the entry keeps that version) and renders it, not the markdown source', () => {
    const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'rein-pp-')));
    const file = path.join(dir, 'plan.md');
    writeFileSync(file, '# OS plan\n\n## Goal\nBoot a **kernel**.\n');
    const first = planPreview('Write', file, true, 'Created plan.md');
    writeFileSync(file, '# changed later');
    expect(planPreview('Write', file, true, 'Created plan.md')).toBe(first);
    const lines = planPreviewLines(first!, 80).map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''));
    expect(lines.join('\n')).toContain('Goal');
    expect(lines.join('\n')).not.toContain('## Goal');
    expect(lines.join('\n')).not.toContain('**kernel**');
    expect(planPreview('Plan', 'OS plan', true, `Plan saved to ${file} and started as a goal.`)).toContain('# changed later');
    expect(planPreview('Write', path.join(dir, 'README.md'), true, 'x')).toBeUndefined();
  });
});
