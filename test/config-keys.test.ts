import {readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';
import {CONFIG_KEYS, keyInfo, parseValue} from '../src/store/configKeys.js';

const src = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'store', 'config.ts'), 'utf8');
const type = src.slice(src.indexOf('export type Config = {'), src.indexOf('\n};', src.indexOf('export type Config = {')));
const configKeys = [...type.matchAll(/^ {2}(\w+)\??:/gm)].map((m) => m[1]!).filter((k) => k !== 'version');

describe('config keys', () => {
  it('every setting in config.json can be changed inside Rein (no hidden, file-only settings)', () => {
    expect(CONFIG_KEYS.map((k) => k.key).sort()).toEqual([...configKeys].sort());
  });

  it('parses what you type for each kind of setting', () => {
    expect(parseValue(keyInfo('autoUpdate')!, 'off')).toBe(false);
    expect(parseValue(keyInfo('toolApproval')!, 'auto')).toBe('auto');
    expect(() => parseValue(keyInfo('toolApproval')!, 'sometimes')).toThrow(/one of: ask, auto, bypass/);
    expect(parseValue(keyInfo('maxUsedPct')!, '90')).toBe(90);
    expect(() => parseValue(keyInfo('maxUsedPct')!, '120')).toThrow(/between 0 and 100/);
    expect(parseValue(keyInfo('additionalDirectories')!, '../api, ~/notes')).toEqual(['../api', '~/notes']);
    expect(parseValue(keyInfo('otel')!, '{"endpoint": "http://localhost:4318"}')).toEqual({endpoint: 'http://localhost:4318'});
    expect(() => parseValue(keyInfo('otel')!, '2')).toThrow(/is JSON/);
    expect(parseValue(keyInfo('notifyUrl')!, '"https://ntfy.sh/me"')).toBe('https://ntfy.sh/me');
  });
});
