export function webhookRequest(url, title, message) {
    const u = new URL(url);
    const text = message.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ' ').slice(0, 1000);
    if (/(^|\.)ntfy\.sh$/.test(u.hostname) || u.searchParams.has('ntfy')) {
        return { url, init: { method: 'POST', headers: { title: title.replace(/[^\x20-\x7e]/g, ' '), tags: 'robot' }, body: text } };
    }
    if (u.hostname === 'hooks.slack.com')
        return { url, init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: `*${title}*\n${text}` }) } };
    if (/(^|\.)discord(app)?\.com$/.test(u.hostname) && u.pathname.startsWith('/api/webhooks/'))
        return { url, init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: `**${title}**\n${text}` }) } };
    return { url, init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title, message: text, source: 'rein' }) } };
}
export function sendWebhook(url, title, message, f = fetch) {
    if (!url)
        return Promise.resolve(false);
    let req;
    try {
        req = webhookRequest(url, title, message);
    }
    catch {
        return Promise.resolve(false); // not a URL
    }
    return f(req.url, { ...req.init, signal: AbortSignal.timeout(10_000) }).then((r) => r.ok, () => false);
}
