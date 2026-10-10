import {execFileSync} from 'node:child_process';
import {mkdtempSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {buildIndex, semanticSearch, semanticSearchTool, setEmbedFetch} from '../src/context/semantic.js';

// A fake Ollama: each word hashes to one of 64 dimensions, so texts sharing words point the same way.
let embedded = 0;
const fakeOllama = (async (_url: string, init: RequestInit) => {
  const {input} = JSON.parse(String(init.body)) as {input: string[]};
  embedded += input.length;
  const vec = (t: string) => {
    const v = Array(64).fill(0);
    for (const w of t.toLowerCase().match(/[a-z]{3,}/g) ?? []) v[[...w].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 64, 7)] += 1;
    return v;
  };
  return new Response(JSON.stringify({embeddings: input.map(vec)}), {status: 200});
}) as unknown as typeof fetch;

let home: string;
const envHome = process.env.REIN_HOME;
beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), 'rein-home-'));
  process.env.REIN_HOME = home;
  embedded = 0;
  setEmbedFetch(fakeOllama);
});
afterEach(() => {
  if (envHome === undefined) delete process.env.REIN_HOME;
  else process.env.REIN_HOME = envHome;
  rmSync(home, {recursive: true, force: true});
});

function repo() {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'rein-sem-')));
  const git = (...a: string[]) => execFileSync('git', a, {cwd: root, stdio: 'ignore'});
  git('init', '-q');
  writeFileSync(path.join(root, 'billing.ts'), 'export function retryFailedCharge(charge) {\n  // retry the failed payment charge with backoff\n}\n');
  writeFileSync(path.join(root, 'invoices.ts'), 'export function invoiceVisibility(user, invoice) {\n  // who can see an invoice\n}\n');
  writeFileSync(path.join(root, '.gitignore'), 'secret.ts\n');
  writeFileSync(path.join(root, 'secret.ts'), 'export const retry = "payment charge failed";\n');
  git('add', '.');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
  return root;
}

describe('local semantic index', () => {
  it('finds code by meaning, skips ignored files, and re-embeds only what changed', async () => {
    const root = repo();
    const first = await buildIndex(root);
    expect(first).toMatchObject({files: 2, embedded: 2, removed: 0});
    const hits = await semanticSearch(root, undefined, 'retry a failed payment charge', 2);
    expect(hits[0]).toMatchObject({file: 'billing.ts', start: 1});
    expect(hits.some((h) => h.file === 'secret.ts')).toBe(false);

    embedded = 0;
    expect(await buildIndex(root)).toMatchObject({embedded: 0});
    expect(embedded).toBe(0);
    writeFileSync(path.join(root, 'invoices.ts'), 'export function invoiceAccess() {}\n');
    rmSync(path.join(root, 'billing.ts'));
    expect(await buildIndex(root)).toMatchObject({files: 1, embedded: 1, removed: 1});
  });

  it('explains a missing Ollama or model, and offers the tool only with an index and the setting', async () => {
    const root = repo();
    setEmbedFetch((async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch);
    await expect(buildIndex(root)).rejects.toThrow(/Ollama isn't running at http:\/\/127\.0\.0\.1:11434.*ollama pull nomic-embed-text/);
    setEmbedFetch((async () => new Response('', {status: 404})) as unknown as typeof fetch);
    await expect(buildIndex(root, {model: 'mxbai-embed-large'})).rejects.toThrow(/ollama pull mxbai-embed-large/);

    const other = repo(); // an Ollama elsewhere gets your code: only with remote: true
    await expect(buildIndex(other, {url: 'http://gpu-box.internal:11434'})).rejects.toThrow(/isn't on this machine.*"remote": true/);
    setEmbedFetch(fakeOllama);
    expect((await buildIndex(other, {url: 'http://gpu-box.internal:11434', remote: true})).files).toBe(2);
    let cfg: any = {semanticIndex: {}};
    const tool = semanticSearchTool(() => cfg, () => root);
    expect(tool.enabled!()).toBe(false);
    await buildIndex(root);
    expect(tool.enabled!()).toBe(true);
    cfg = {};
    expect(tool.enabled!()).toBe(false);
  });
});
