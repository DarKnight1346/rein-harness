import {mkdtempSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {describe, expect, it} from 'vitest';
import {checkSchema, unknownToolFields} from '../src/providers/codex/compat.js';
import {appServerArgs} from '../src/providers/codex/catalog.js';

const fake = path.resolve('test/fixtures/fake-codex.mjs');
const schema = (env: Record<string, string> = {}) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'rein-schema-'));
  execFileSync(process.execPath, [fake, 'app-server', 'generate-json-schema', '--experimental', '--out', dir], {env: {...process.env, ...env}});
  return dir;
};

describe('codex compatibility check', () => {
  it('passes when every method, notification and field Rein uses is in the schema', async () => {
    expect(await checkSchema(schema())).toEqual([]);
  });

  it('names exactly what is missing', async () => {
    expect(await checkSchema(schema({FAKE_CODEX_SCHEMA: 'broken'}))).toEqual(['request thread/fork']);
  });

  it('flags new tool-like model catalog fields it does not strip yet', () => {
    const models = [{slug: 'gpt-x', tool_mode: 'code_mode_only', shell_type: 'unified_exec', web_browser_tool_type: 'v2', display_name: 'GPT-X', new_harmless_field: 1}];
    expect(unknownToolFields(models)).toEqual(['web_browser_tool_type']);
  });

  it("never passes Codex a --disable flag it doesn't know (it refuses to start on one)", () => {
    const args = appServerArgs(undefined, ['apps', 'shell_tool']);
    expect(args.filter((a, i) => args[i - 1] === '--disable')).toEqual(['apps', 'shell_tool']);
    expect(appServerArgs(undefined).filter((a) => a === '--disable').length).toBe(21); // list unknown: all
  });
});
