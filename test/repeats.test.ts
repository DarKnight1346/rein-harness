import {describe, expect, it} from 'vitest';
import {NUDGE_AT, RepeatEdits, shape} from '../src/tools/repeats.js';

describe('codemod nudge', () => {
  it('reduces an edit to the change itself, whole tokens', () => {
    expect(shape('const r = await fetchJson(url);', 'const r = await http.get(url);')).toBe('fetchJson\u0000http.get');
    expect(shape('import {a} from "lodash";', 'import {a} from "lodash-es";')).toBe('lodash\u0000lodash-es');
    expect(shape('same', 'same')).toBeUndefined();
  });

  it('nudges once when the same change has been made in enough files', () => {
    const r = new RepeatEdits();
    const edit = (n: number) => r.after({old_string: `x = fetchJson(a${n})`, new_string: `x = http.get(a${n})`}, `src/f${n}.ts`);
    for (let i = 1; i < NUDGE_AT; i++) expect(edit(i)).toBeUndefined();
    expect(edit(NUDGE_AT)).toMatch(/same change by hand in 4 files \(`fetchJson` → `http\.get`\)[\s\S]*write a codemod/);
    expect(edit(NUDGE_AT + 1)).toBeUndefined();
    expect(r.after({old_string: 'x = fetchJson(a1)', new_string: 'x = http.get(a1)'}, 'src/f1.ts')).toBeUndefined(); // the same file again isn't another file
    r.reset();
    for (let i = 1; i < NUDGE_AT; i++) expect(edit(i)).toBeUndefined();
  });
});
