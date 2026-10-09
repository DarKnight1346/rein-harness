import {mkdirSync, mkdtempSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {detectCaches} from '../src/build/caches.js';

const repo = (files: Record<string, string>) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rein-cache-'));
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, f)), {recursive: true});
    writeFileSync(path.join(root, f), text);
  }
  return root;
};

describe('build caches', () => {
  it('finds Bazel remote and disk caches in .bazelrc', () => {
    expect(detectCaches(repo({'.bazelrc': 'build --remote_cache=grpcs://cache.example.com\nbuild --disk_cache=~/.cache/bazel-disk\n'}), {}, os.tmpdir())).toEqual([
      {system: 'bazel', kind: 'remote', where: 'grpcs://cache.example.com'},
      {system: 'bazel', kind: 'local', where: '~/.cache/bazel-disk'},
    ]);
  });

  it('knows Nx Cloud, Turborepo remote caching and the Gradle build cache', () => {
    expect(detectCaches(repo({'nx.json': '{"nxCloudId": "abc"}'}), {}, os.tmpdir())).toEqual([{system: 'nx', kind: 'remote', where: 'Nx Cloud'}]);
    expect(detectCaches(repo({'nx.json': '{}'}), {}, os.tmpdir())).toEqual([{system: 'nx', kind: 'local', where: '.nx/cache'}]);
    expect(detectCaches(repo({'turbo.json': '{}'}), {TURBO_TOKEN: 't'}, os.tmpdir())).toEqual([{system: 'turbo', kind: 'remote', where: 'Vercel Remote Cache'}]);
    expect(detectCaches(repo({'gradle.properties': 'org.gradle.caching=true\n'}), {}, os.tmpdir())).toEqual([{system: 'gradle', kind: 'local', where: '~/.gradle/caches/build-cache-1'}]);
    expect(detectCaches(repo({'settings.gradle.kts': 'buildCache { remote<HttpBuildCache> { url = uri("https://c") } }'}), {}, os.tmpdir())[0]).toMatchObject({system: 'gradle', kind: 'remote'});
    expect(detectCaches(repo({'README.md': 'hi'}), {}, os.tmpdir())).toEqual([]);
  });
});
