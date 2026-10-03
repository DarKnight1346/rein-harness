import http from 'node:http';
import type {AddressInfo} from 'node:net';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {parseAnswers, renderPrompt} from '../src/decider/llm.js';
import type {Questions} from '../src/decider/types.js';
import {shuffle, headTail} from '../src/router/auto.js';

const Q: Questions = {
  switch: {type: 'noul', instructions: 'new task?', criteria: {true: 'yes', false: 'no'}},
  model: {type: 'choice', instructions: 'which?', criteria: {a: 'cheap', b: 'smart'}},
};

describe('llm decider', () => {
  it('renders a strict prompt with every option', () => {
    const p = renderPrompt({msg: 'hi'}, Q);
    expect(p).toContain('{"msg":"hi"}');
    expect(p).toContain('a: cheap');
    expect(p).toContain('"switch": <probability of yes, 0..1>');
  });
  it('parses and validates answers', () => {
    expect(parseAnswers('sure: {"switch": 0.3, "model": {"choice": "b", "confidence": 0.8}}', Q)).toEqual({
      switch: {type: 'noul', noul: 0.3},
      model: {type: 'choice', choice: 'b', confidence: 0.8},
    });
    expect(() => parseAnswers('{"switch": 0.3, "model": {"choice": "zzz"}}', Q)).toThrow(/model/);
    expect(() => parseAnswers('no json', Q)).toThrow();
  });
});

describe('auto helpers', () => {
  it('shuffles without losing items', () => {
    const items = [1, 2, 3, 4, 5];
    expect(shuffle(items, () => 0).sort()).toEqual(items);
  });
  it('trims long messages to head+tail', () => {
    const long = 'a'.repeat(5000) + 'b'.repeat(5000);
    const out = headTail(long);
    expect(out.length).toBeLessThan(6200);
    expect(out.startsWith('aaa')).toBe(true);
    expect(out.endsWith('bbb')).toBe(true);
  });
});

describe('jev backend', () => {
  let server: http.Server;
  let calls: {path?: string; auth?: string; body: any}[] = [];
  let failures = 0;
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        calls.push({path: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : undefined});
        if (failures > 0) {
          failures--;
          res.writeHead(529).end('{"error":{"message":"overloaded"}}');
          return;
        }
        if (req.url === '/v1/models') return void res.writeHead(200).end('{"models":[{"name":"jev-latest","description":"","release_date":""}]}');
        if (req.headers.authorization !== 'Bearer good') return void res.writeHead(401).end('{"error":{"message":"bad key"}}');
        res.writeHead(200).end(JSON.stringify({model: 'jev-1.13.0', answers: {model: {type: 'choice', choice: 'a', confidence: 0.9, probabilities: {a: 0.9, b: 0.1}}}, usage: {input_tokens: 42, output_tokens: 0}}));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    process.env.TYPESAFE_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());

  it('posts state+questions with the pinned model and retries 529', async () => {
    const {jevBackend, checkJevKey} = await import('../src/decider/jev.js');
    calls = [];
    failures = 1;
    const d = await jevBackend('good', 'jev-1.13.0').ask({m: 'hi'}, {model: Q.model!});
    expect(d.answers.model).toMatchObject({choice: 'a', confidence: 0.9});
    expect(d.inputTokens).toBe(42);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({path: '/v1/systemone', auth: 'Bearer good', body: {state: {m: 'hi'}, model: 'jev-1.13.0'}});
    await expect(jevBackend('bad', 'jev-1.13.0').ask({}, {model: Q.model!})).rejects.toThrow(/bad key/);
    expect(await checkJevKey('good')).toEqual(['jev-latest']);
  });
});
