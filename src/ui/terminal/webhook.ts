/**
 * Notifications to your phone: a POST to a URL you choose when Rein needs you or finished
 * something. The format follows the service: ntfy (plain text, Title header), Slack and Discord
 * incoming webhooks (their JSON), anything else {title, message} JSON. Fire and forget.
 */
export type WebhookPayload = {url: string; init: RequestInit};

export function webhookRequest(url: string, title: string, message: string): WebhookPayload {
  const u = new URL(url);
  const text = message.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ' ').slice(0, 1000);
  if (/(^|\.)ntfy\.sh$/.test(u.hostname) || u.searchParams.has('ntfy')) {
    return {url, init: {method: 'POST', headers: {title: title.replace(/[^\x20-\x7e]/g, ' '), tags: 'robot'}, body: text}};
  }
  if (u.hostname === 'hooks.slack.com') return {url, init: {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({text: `*${title}*\n${text}`})}};
  if (/(^|\.)discord(app)?\.com$/.test(u.hostname) && u.pathname.startsWith('/api/webhooks/')) return {url, init: {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({content: `**${title}**\n${text}`})}};
  return {url, init: {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({title, message: text, source: 'rein'})}};
}

export function sendWebhook(url: string | undefined, title: string, message: string, f: typeof fetch = fetch): Promise<boolean> {
  if (!url) return Promise.resolve(false);
  let req: WebhookPayload;
  try {
    req = webhookRequest(url, title, message);
  } catch {
    return Promise.resolve(false); // not a URL
  }
  return f(req.url, {...req.init, signal: AbortSignal.timeout(10_000)}).then(
    (r) => r.ok,
    () => false,
  );
}
