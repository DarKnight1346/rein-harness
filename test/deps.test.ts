import {mkdtempSync, readFileSync, realpathSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {addedDeps, checkDeps, commandDeps, lookalike, setDepFetch} from '../src/tools/deps.js';
import {ToolHost} from '../src/tools/host.js';

/** A fake registry and OSV: `left-padd` doesn't exist, `gplthing` is GPL, lodash 4.17.15 has a CVE. */
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json'}});
setDepFetch(async (url, init) => {
  if (url.includes('osv.dev')) {
    const q = JSON.parse(String(init?.body));
    return json(200, q.package.name === 'lodash' && q.version === '4.17.15' ? {vulns: [{id: 'GHSA-p6mc', aliases: ['CVE-2020-8203'], summary: 'Prototype pollution'}]} : {});
  }
  if (url.includes('left-padd') || url.includes('reqeusts')) return json(404, {});
  if (url.includes('gplthing')) return json(200, {license: 'GPL-3.0'});
  return json(200, url.includes('pypi') ? {info: {license: 'MIT'}} : {license: 'MIT'});
});
afterEach(() => undefined);

describe('dependency check', () => {
  it('finds what an install command or a manifest edit adds', () => {
    expect(commandDeps('npm install lodash@4.17.15 -D && pip install reqeusts==2.0')).toEqual([
      {ecosystem: 'npm', name: 'lodash', version: '4.17.15'},
      {ecosystem: 'PyPI', name: 'reqeusts', version: '2.0'},
    ]);
    expect(commandDeps('npm install')).toEqual([]);
    const before = JSON.stringify({dependencies: {react: '^19.0.0'}});
    const after = JSON.stringify({dependencies: {react: '^19.0.0', 'left-padd': '1.0.0'}});
    expect(addedDeps('package.json', before, after)).toEqual([{ecosystem: 'npm', name: 'left-padd', version: '1.0.0'}]);
    expect(addedDeps('requirements.txt', 'flask==3.0\n', 'flask==3.0\nnumpy>=1.26\n')).toEqual([{ecosystem: 'PyPI', name: 'numpy', version: undefined}]);
  });

  it('flags made-up names, typosquats, copyleft licenses and known vulnerabilities', async () => {
    expect(lookalike({ecosystem: 'PyPI', name: 'reqeusts'})).toBe('requests');
    expect(lookalike({ecosystem: 'npm', name: 'react'})).toBeUndefined();
    const problems = await checkDeps([
      {ecosystem: 'npm', name: 'left-padd', version: '1.0.0'},
      {ecosystem: 'npm', name: 'gplthing'},
      {ecosystem: 'npm', name: 'lodash', version: '4.17.15'},
      {ecosystem: 'PyPI', name: 'reqeusts'},
      {ecosystem: 'npm', name: 'react', version: '19.0.0'},
    ]);
    expect(problems.sort()).toEqual([
      "gplthing (npm) is GPL-3.0 (copyleft): check it fits this project's license",
      "left-padd@1.0.0 (npm) doesn't exist on the registry (a made-up name someone could register later)",
      'lodash@4.17.15 (npm) has a known vulnerability: CVE-2020-8203: Prototype pollution',
      "reqeusts (PyPI) doesn't exist on the registry; did you mean requests?",
    ]);
  });

  it('blocks or warns on the change, as configured', async () => {
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'rein-deps-')));
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({dependencies: {}}, null, 2));
    let mode: 'warn' | 'block' = 'block';
    const h = new ToolHost({root, mode: () => 'bypass', approve: async () => 'once', depCheck: () => mode});
    await h.call('read', {path: 'package.json'});
    const edit = {path: 'package.json', old_string: '"dependencies": {}', new_string: '"dependencies": {"left-padd": "1.0.0"}'};
    expect(await h.call('edit', edit)).toMatchObject({ok: false, text: expect.stringMatching(/^blocked by the dependency check:\n- left-padd/)});
    expect(readFileSync(path.join(root, 'package.json'), 'utf8')).not.toMatch(/left-padd/);
    mode = 'warn';
    const r = await h.call('edit', edit);
    expect(r.ok).toBe(true);
    expect(r.text).toMatch(/<dependency_check>\n- left-padd@1\.0\.0 \(npm\) doesn't exist/);
    h.close();
  });
});
