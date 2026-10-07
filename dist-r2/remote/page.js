/**
 * The remote page: one self-contained HTML document (no files served from disk). Every piece of
 * text is set with textContent, never parsed as HTML.
 */
export const PAGE = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Rein</title>
<style>
:root{--bg:#fff;--fg:#1d1d1f;--dim:#6e6e73;--line:#e5e5ea;--card:#f5f5f7;--accent:#5b5bd6;--ok:#1a7f37;--bad:#c62828;--warn:#9a6700}
@media (prefers-color-scheme:dark){:root{--bg:#141414;--fg:#ececec;--dim:#9a9aa0;--line:#2a2a2e;--card:#1e1e21;--accent:#8b8bff;--ok:#4cc26a;--bad:#ff6b6b;--warn:#e3b341}}
*{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
header{position:sticky;top:0;background:var(--bg);border-bottom:1px solid var(--line);padding:10px 16px;display:flex;gap:8px;align-items:center;z-index:2}
header b{font-size:16px}header .meta{color:var(--dim);font-size:13px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#log{padding:8px 16px 140px;max-width:860px;margin:0 auto}
.msg{margin:14px 0;white-space:pre-wrap;word-wrap:break-word}.msg.user{background:var(--card);border-radius:12px;padding:8px 12px}
.msg.user::before{content:"you";display:block;color:var(--dim);font-size:12px}
.tool{color:var(--dim);font:12.5px ui-monospace,Menlo,monospace;margin:2px 0}.tool.bad{color:var(--bad)}
.live{opacity:.85}.status{color:var(--warn);font-size:13px;margin:8px 0}
#approval{position:fixed;left:0;right:0;bottom:84px;margin:0 auto;max-width:860px;padding:0 12px;display:none;z-index:3}
#approval .box{background:var(--card);border:2px solid var(--warn);border-radius:14px;padding:12px}
#approval pre{max-height:38vh;overflow:auto;font:12px ui-monospace,Menlo,monospace;background:var(--bg);padding:8px;border-radius:8px;white-space:pre-wrap}
#approval .opts{display:flex;flex-wrap:wrap;gap:8px}
footer{position:fixed;bottom:0;left:0;right:0;background:var(--bg);border-top:1px solid var(--line);padding:10px 12px calc(10px + env(safe-area-inset-bottom));display:flex;gap:8px;z-index:3}
textarea{flex:1;resize:none;font:inherit;padding:9px 12px;border-radius:12px;border:1px solid var(--line);background:var(--card);color:var(--fg);min-height:44px;max-height:30vh}
button{font:inherit;border:0;border-radius:10px;padding:9px 14px;background:var(--accent);color:#fff;min-height:44px}
button.ghost{background:var(--card);color:var(--fg);border:1px solid var(--line)}button.deny{background:var(--bad)}button.allow{background:var(--ok)}
#pair{max-width:360px;margin:20vh auto;padding:0 16px;text-align:center}#pair input{font:28px ui-monospace,monospace;letter-spacing:6px;text-align:center;width:100%;padding:10px;border-radius:12px;border:1px solid var(--line);background:var(--card);color:var(--fg)}
#pair p{color:var(--dim)}#err{color:var(--bad);min-height:1.4em}
</style></head><body>
<div id="pair" hidden>
  <h2>Pair with Rein</h2>
  <p>Run <code>/remote pair</code> in Rein and enter the code it shows.</p>
  <input id="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000">
  <p id="err"></p>
  <button id="pairbtn">Pair</button>
</div>
<div id="app" hidden>
  <header><b>Rein</b><span class="meta" id="meta"></span><button class="ghost" id="stop" hidden>Stop</button></header>
  <div id="log"></div>
  <div id="approval"><div class="box"><div id="atitle"></div><pre id="apreview"></pre><div class="opts" id="aopts"></div></div></div>
  <footer><textarea id="text" rows="1" placeholder="Message Rein"></textarea><button id="send">Send</button></footer>
</div>
<script>
const $ = (id) => document.getElementById(id);
let token = localStorage.getItem('reinToken') || '';
let live = '';
const api = (path, body) => fetch(path, body === undefined ? {credentials: 'same-origin'} : {method: 'POST', credentials: 'same-origin', headers: {'content-type': 'application/json', 'x-rein-token': token}, body: JSON.stringify(body)});
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
function render(s) {
  $('meta').textContent = s.project + ' · ' + s.model + (s.busy ? ' · working…' : '');
  $('stop').hidden = !s.busy;
  const log = $('log'); log.textContent = '';
  for (const m of s.messages) {
    log.appendChild(el('div', 'msg ' + m.role, m.text));
    for (const t of m.tools || []) log.appendChild(el('div', 'tool' + (t.ok ? '' : ' bad'), (t.ok ? '⏺ ' : '✗ ') + t.label + '(' + t.summary + ')'));
  }
  if (s.busy && (live || s.live)) log.appendChild(el('div', 'msg assistant live', live || s.live));
  if (s.waitingUntil) log.appendChild(el('div', 'status', 'Every account is at its limit · continuing at ' + new Date(s.waitingUntil).toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'})));
  const a = s.approval, box = $('approval');
  if (a) {
    box.style.display = 'block'; $('atitle').textContent = a.title + ' ' + a.summary; $('apreview').textContent = a.preview;
    const opts = $('aopts'); opts.textContent = '';
    for (const o of a.options) { const b = el('button', o.decision === 'deny' ? 'deny' : o.decision === 'once' ? 'allow' : 'ghost', o.label); b.onclick = () => api('/api/approve', {id: a.id, decision: o.decision}).then(refresh); opts.appendChild(b); }
  } else box.style.display = 'none';
  window.scrollTo(0, document.body.scrollHeight);
}
async function refresh() {
  const r = await api('/api/state');
  if (r.status === 401) return showPair();
  live = ''; render(await r.json());
}
function showPair() { $('app').hidden = true; $('pair').hidden = false; $('code').focus(); }
function start() {
  $('pair').hidden = true; $('app').hidden = false; refresh();
  const es = new EventSource('/api/events');
  es.addEventListener('state', () => refresh());
  es.addEventListener('delta', (e) => { live += JSON.parse(e.data).text || ''; const l = document.querySelector('.live'); if (l) l.textContent = live; else refresh(); });
  es.onerror = () => setTimeout(() => { if (es.readyState === 2) start(); }, 3000);
}
$('pairbtn').onclick = async () => {
  const r = await fetch('/api/pair', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({code: $('code').value.trim()})});
  const j = await r.json();
  if (!r.ok) { $('err').textContent = j.error; return; }
  token = j.token; localStorage.setItem('reinToken', token); start();
};
$('code').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('pairbtn').click(); });
$('send').onclick = async () => { const t = $('text').value; if (!t.trim()) return; $('text').value = ''; await api('/api/send', {text: t}); };
$('text').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('send').click(); } });
$('stop').onclick = () => api('/api/interrupt', {});
token ? api('/api/state').then((r) => (r.status === 401 ? showPair() : start())) : showPair();
</script></body></html>`;
