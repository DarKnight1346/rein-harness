import {afterEach, describe, expect, it} from 'vitest';
import {RemoteServer, type RemoteState} from '../src/remote/server.js';

let server: RemoteServer | undefined;
afterEach(async () => {
  await server?.stop();
  server = undefined;
});

const state: RemoteState = {project: 'proj', model: 'Opus', busy: false, messages: [{role: 'user', text: '<b>hi</b>'}]};
async function setup() {
  const sent: string[] = [];
  const answers: [number, string][] = [];
  server = new RemoteServer({
    state: () => ({...state, approval: {id: 7, title: 'Rein wants to Shell', summary: 'rm -rf build', preview: '$ rm -rf build', options: [{decision: 'once', label: 'Allow'}, {decision: 'deny', label: 'Deny'}]}}),
    send: (t) => sent.push(t),
    approve: (id, d) => (answers.push([id, d]), id === 7),
    interrupt: () => {},
  });
  await server.start(0, '127.0.0.1');
  const base = `http://127.0.0.1:${server.address!.port}`;
  return {base, sent, answers};
}

describe('remote page', () => {
  it('serves the page; everything else needs pairing', async () => {
    const {base} = await setup();
    const page = await fetch(base + '/');
    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(await page.text()).toContain('Pair with Rein');
    expect((await fetch(base + '/api/state')).status).toBe(401);
    expect((await fetch(base + '/api/send', {method: 'POST', body: '{"text":"x"}'})).status).toBe(401);
  });

  it('pairs with the one-time code (wrong codes count, then lock), then reads and acts', async () => {
    const {base, sent, answers} = await setup();
    const pair = (code: string) => fetch(base + '/api/pair', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({code})});
    expect((await pair('123456')).status).toBe(403); // no code active yet
    const code = server!.newCode();
    const wrong = await pair(code === '000000' ? '111111' : '000000');
    expect((await wrong.json()).error).toMatch(/4 tries left/);
    const ok = await pair(code);
    expect(ok.status).toBe(200);
    const {token} = (await ok.json()) as {token: string};
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    const cookie = ok.headers.get('set-cookie')!;
    expect(cookie).toMatch(/HttpOnly; SameSite=Strict/);
    expect((await pair(code)).status).toBe(403); // one device per code
    const c = cookie.split(';')[0]!;
    const st = await fetch(base + '/api/state', {headers: {cookie: c}});
    expect(((await st.json()) as RemoteState).messages[0]!.text).toBe('<b>hi</b>'); // raw text; the page sets it with textContent
    // Changes need the header too (a cookie alone could come from another site).
    expect((await fetch(base + '/api/send', {method: 'POST', headers: {cookie: c}, body: JSON.stringify({text: 'hello'})})).status).toBe(401);
    const post = (p: string, body: unknown) => fetch(base + p, {method: 'POST', headers: {cookie: c, 'x-rein-token': token, 'content-type': 'application/json'}, body: JSON.stringify(body)});
    expect((await post('/api/send', {text: 'hello from my phone'})).status).toBe(200);
    expect(sent).toEqual(['hello from my phone']);
    expect((await post('/api/approve', {id: 7, decision: 'once'})).status).toBe(200);
    expect((await post('/api/approve', {id: 3, decision: 'once'})).status).toBe(409); // stale
    expect(answers).toEqual([[7, 'once'], [3, 'once']]);
  });

  it('locks pairing after 5 wrong codes', async () => {
    const {base} = await setup();
    const code = server!.newCode();
    const bad = code === '999999' ? '888888' : '999999';
    for (let i = 0; i < 5; i++) await fetch(base + '/api/pair', {method: 'POST', body: JSON.stringify({code: bad})});
    const r = await fetch(base + '/api/pair', {method: 'POST', body: JSON.stringify({code})});
    expect(r.status).toBe(403);
    expect((await r.json()).error).toMatch(/too many wrong codes/);
  });

  it('streams changes to paired pages', async () => {
    const {base} = await setup();
    server!.newCode();
    const code = (server as any).code.value as string;
    const ok = await fetch(base + '/api/pair', {method: 'POST', body: JSON.stringify({code})});
    const c = ok.headers.get('set-cookie')!.split(';')[0]!;
    const res = await fetch(base + '/api/events', {headers: {cookie: c}});
    const reader = res.body!.getReader();
    server!.push('delta', {text: 'Hel'});
    let got = '';
    while (!got.includes('Hel')) got += new TextDecoder().decode((await reader.read()).value);
    expect(got).toContain('event: delta\ndata: {"text":"Hel"}');
    await reader.cancel();
  });

  it('the page never parses text as HTML', async () => {
    const {PAGE} = await import('../src/remote/page.js');
    expect(PAGE).not.toMatch(/innerHTML|insertAdjacentHTML|document\.write/);
  });
});
