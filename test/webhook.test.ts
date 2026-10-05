import {createServer} from 'node:http';
import {describe, expect, it} from 'vitest';
import {sendWebhook, webhookRequest} from '../src/ui/terminal/webhook.js';

describe('phone notifications', () => {
  it('formats for ntfy, Slack, Discord and generic webhooks', () => {
    const ntfy = webhookRequest('https://ntfy.sh/my-secret-topic', 'Rein is done', 'Goal achieved: ship it');
    expect(ntfy.init.body).toBe('Goal achieved: ship it');
    expect((ntfy.init.headers as Record<string, string>).title).toBe('Rein is done');
    expect(JSON.parse(String(webhookRequest('https://hooks.slack.com/services/T/B/x', 'T', 'm').init.body))).toEqual({text: '*T*\nm'});
    expect(JSON.parse(String(webhookRequest('https://discord.com/api/webhooks/1/x', 'T', 'm').init.body))).toEqual({content: '**T**\nm'});
    expect(JSON.parse(String(webhookRequest('https://example.com/hook', 'T', 'm').init.body))).toEqual({title: 'T', message: 'm', source: 'rein'});
  });
  it('posts, and never throws (bad URL, server down)', async () => {
    let got = '';
    const server = createServer((req, res) => {
      req.on('data', (d) => (got += d));
      req.on('end', () => res.end('ok'));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as {port: number}).port;
    expect(await sendWebhook(`http://127.0.0.1:${port}/hook`, 'Rein needs your approval', 'Shell(npm test)')).toBe(true);
    expect(JSON.parse(got)).toMatchObject({title: 'Rein needs your approval', message: 'Shell(npm test)'});
    server.close();
    expect(await sendWebhook('not a url', 't', 'm')).toBe(false);
    expect(await sendWebhook(`http://127.0.0.1:${port}/gone`, 't', 'm')).toBe(false);
    expect(await sendWebhook('', 't', 'm')).toBe(false);
  });
});
