import {isIP} from 'node:net';
import {createRequire} from 'node:module';
import type TurndownService from 'turndown';
import {completeWith, resolveUtilityModel} from '../decider/index.js';
import {adapters} from '../providers/index.js';
import {catalog} from '../router/catalog.js';
import type {Config} from '../store/config.js';
import {ToolError} from './fs.js';
import type {ToolDef} from './registry.js';

/**
 * Web tools, modeled on Claude Code's:
 * - `web_search` runs one call on a signed-in model with its provider's *server-side* search turned
 *   on for that call only (Claude CLI `--tools WebSearch`, Codex thread `web_search: "live"`), like
 *   Claude Code's WebSearch (a separate API call with only the search tool). Works for any chat model.
 * - `web_fetch` fetches locally, converts HTML to markdown (turndown, as Claude Code does) and either
 *   returns a page of it or, with `prompt`, has the web model answer from it (Claude Code's
 *   WebFetch always does the latter with Haiku).
 */

const FETCH_TIMEOUT_MS = 30_000;
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_REDIRECTS = 10;
const CACHE_MS = 15 * 60_000;
/** Raw markdown returned per call (use offset for more). */
const PAGE_CHARS = 40_000;
/** Page text the web model reads when answering a prompt. */
const PROMPT_CHARS = 120_000;

const SEARCH_SYSTEM = `You are the web search worker for a coding agent. Search the web for the request and report what you found.
Format:
1. A short, direct answer (a few sentences, with specifics: versions, dates, numbers, names).
2. "Results:" — the most relevant pages as "- [Title](URL) — one-line summary", best first (up to 8).
Only report what the search results support; say so if they don't answer it.`;

const FETCH_SYSTEM = `You read a fetched web page for a coding agent and answer its request using only the page content.
Be concise; include relevant details, code examples and exact values as needed. If the page doesn't contain the answer, say so.`;

type Page = {url: string; status: number; contentType: string; markdown: string; at: number};
const cache = new Map<string, Page>();

/** HTML → Markdown, made at the first page fetched (turndown brings a whole DOM, loaded only then). */
let td: TurndownService | undefined;
function turndown(): TurndownService {
  if (td) return td;
  const Turndown = createRequire(import.meta.url)('turndown') as typeof TurndownService;
  td = new Turndown({headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-'});
  td.remove(['script', 'style', 'noscript', 'iframe', 'canvas', 'template', 'head']);
  td.remove((node) => node.nodeName === 'SVG' || node.nodeName === 'svg');
  return td;
}

function webModel(cfg: Config) {
  const ref = resolveUtilityModel(cfg.webModel, cfg);
  if (!ref) throw new ToolError('no signed-in model is available to run web requests');
  return ref;
}

/** Private / loopback / link-local hosts are refused (use the shell tool with curl for local servers). */
function isLocalHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (!isIP(h)) return !h.includes('.');
  if (isIP(h) === 6) return h === '::1' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80') || h.startsWith('::ffff:127.') || h === '::';
  const [a, b] = h.split('.').map(Number) as [number, number];
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

function parseUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new ToolError(`not a valid URL: ${raw}`);
  }
  if (url.protocol === 'http:') url.protocol = 'https:'; // upgraded, like Claude Code
  if (url.protocol !== 'https:') throw new ToolError(`only http(s) URLs can be fetched (got ${url.protocol})`);
  if (url.username || url.password) throw new ToolError('URLs with credentials are not allowed');
  if (isLocalHost(url.hostname)) throw new ToolError(`${url.hostname} is a local/private host; use the shell tool (curl) for local servers`);
  return url;
}

/** Fetch with same-host redirects followed; a redirect to another host is reported, not followed. */
async function fetchPage(url: URL): Promise<Page | {redirect: string; status: number}> {
  const key = url.href;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit;
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await fetch(current, {
      redirect: 'manual',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {'user-agent': 'Mozilla/5.0 (compatible; Rein/0.1; +https://github.com)', accept: 'text/html,application/xhtml+xml,text/markdown,text/plain,application/json;q=0.9,*/*;q=0.5'},
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      const next = new URL(res.headers.get('location')!, current);
      if (next.hostname !== current.hostname) return {redirect: next.href, status: res.status};
      current = next;
      continue;
    }
    const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
    const body = await readCapped(res);
    let markdown: string;
    if (contentType.includes('html') || /^\s*<(!doctype html|html)/i.test(body.slice(0, 200))) markdown = turndown().turndown(body).replace(/[ \t\u00a0]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
    else if (/text\/|json|xml|javascript|markdown|yaml|csv/.test(contentType) || !contentType) markdown = body;
    else throw new ToolError(`unsupported content type ${contentType || 'unknown'} at ${current.href}`);
    const page = {url: current.href, status: res.status, contentType, markdown, at: Date.now()};
    cache.set(key, page);
    if (cache.size > 100) cache.delete(cache.keys().next().value!);
    return page;
  }
  throw new ToolError(`too many redirects fetching ${url.href}`);
}

async function readCapped(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const {done, value} = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) {
      void reader.cancel();
      break; // keep what fits; pages that big are truncated
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

export function webTools(config: () => Config): ToolDef[] {
  return [
    {
      name: 'web_search',
      label: 'WebSearch',
      description: 'Search the web.',
      describe: () =>
        [
          'Search the web for current information: recent releases, docs, error messages, APIs, news — anything beyond your training data or that may have changed.',
          `- Returns a short answer plus result links (title, URL, summary). The current date is ${new Date().toISOString().slice(0, 10)}; include the year in queries about recent things.`,
          '- Use web_fetch on a result URL to read the full page.',
          '- When you use results in your reply, end it with a "Sources:" list of the relevant URLs as markdown links.',
        ].join('\n'),
      inputSchema: {
        type: 'object',
        properties: {
          query: {type: 'string', description: 'What to search for'},
          allowed_domains: {type: 'array', items: {type: 'string'}, description: 'Only use results from these domains'},
          blocked_domains: {type: 'array', items: {type: 'string'}, description: 'Never use results from these domains'},
        },
        required: ['query'],
      },
      mutating: false,
      summarize: (a) => String(a?.query ?? '').replace(/\s+/g, ' ').slice(0, 100),
      async run(_ctx, args) {
        const query = typeof args?.query === 'string' ? args.query.trim() : '';
        if (query.length < 2) throw new ToolError('query is required');
        const cfg = config();
        const ref = webModel(cfg);
        const account = catalog.healthyAccounts(ref, cfg.maxUsedPct)[0];
        if (!account) throw new ToolError(`no healthy account for ${ref.model}`);
        const domains = [
          args.allowed_domains?.length ? `Only use results from: ${args.allowed_domains.join(', ')}.` : '',
          args.blocked_domains?.length ? `Never use results from: ${args.blocked_domains.join(', ')}.` : '',
        ].filter(Boolean);
        const t0 = Date.now();
        const text = await adapters[ref.provider].oneShot({
          account,
          model: ref.model,
          system: SEARCH_SYSTEM,
          prompt: [`Search the web for: ${query}`, ...domains].join('\n'),
          webSearch: true,
          timeoutMs: 180_000,
        });
        if (!text.trim()) throw new ToolError('the search returned nothing');
        const secs = ((Date.now() - t0) / 1000).toFixed(1);
        return {ok: true, text: `Web search: "${query}" (via ${catalog.get(ref)?.label ?? ref.model}, ${secs}s)\n\n${text.trim()}\n\nREMINDER: end your reply with a "Sources:" list of the URLs you relied on.`};
      },
    },
    {
      name: 'web_fetch',
      label: 'WebFetch',
      description: 'Fetch a web page.',
      describe: () =>
        [
          'Fetch a URL and read it as markdown (HTML is converted). Read-only.',
          '- With `prompt`: a fast model reads the page and answers just that (best for big pages — saves your context).',
          '- Without `prompt`: returns the page markdown, 40k characters at a time (use `offset` to continue).',
          '- HTTP is upgraded to HTTPS. Local/private hosts are refused (use shell + curl). Results are cached for 15 minutes.',
          '- If the URL redirects to a different host you get the new URL; call web_fetch again with it.',
          '- For GitHub issues/PRs/API, the gh CLI via shell may work better.',
        ].join('\n'),
      inputSchema: {
        type: 'object',
        properties: {
          url: {type: 'string', description: 'Fully-formed URL'},
          prompt: {type: 'string', description: 'What to extract from the page (optional)'},
          offset: {type: 'integer', description: 'Character offset into the markdown when reading without a prompt'},
        },
        required: ['url'],
      },
      mutating: false,
      summarize: (a) => `${String(a?.url ?? '')}${a?.prompt ? ` · ${String(a.prompt).replace(/\s+/g, ' ').slice(0, 50)}` : ''}`,
      async run(_ctx, args) {
        if (typeof args?.url !== 'string') throw new ToolError('url is required');
        const url = parseUrl(args.url);
        let page: Awaited<ReturnType<typeof fetchPage>>;
        try {
          page = await fetchPage(url);
        } catch (err) {
          if (err instanceof ToolError) throw err;
          const e = err as Error & {cause?: {code?: string}};
          throw new ToolError(`fetch failed for ${url.href}: ${e.name === 'TimeoutError' ? 'timed out' : (e.cause?.code ?? e.message)}`);
        }
        if ('redirect' in page) {
          return {ok: true, text: `REDIRECT DETECTED: ${url.href} redirects (${page.status}) to a different host:\n${page.redirect}\nCall web_fetch again with that URL if you want its content.`};
        }
        const head = `${page.url} · HTTP ${page.status}${page.contentType ? ` · ${page.contentType.split(';')[0]}` : ''} · ${page.markdown.length.toLocaleString()} chars`;
        if (page.status >= 400) return {ok: false, text: `${head}\n\n${page.markdown.slice(0, 2000)}`};
        if (typeof args.prompt === 'string' && args.prompt.trim()) {
          const cfg = config();
          const ref = webModel(cfg);
          const content = page.markdown.length > PROMPT_CHARS ? `${page.markdown.slice(0, PROMPT_CHARS)}\n[… page truncated]` : page.markdown;
          const answer = await completeWith(ref, cfg, FETCH_SYSTEM, `Web page content (${page.url}):\n---\n${content}\n---\n\n${args.prompt.trim()}\n\nProvide a concise response based only on the content above.`, {timeoutMs: 120_000, fast: true});
          return {ok: true, text: `${head}\n\n${answer.trim()}`};
        }
        const offset = Math.max(0, Math.floor(Number(args.offset) || 0));
        const slice = page.markdown.slice(offset, offset + PAGE_CHARS);
        const more = offset + PAGE_CHARS < page.markdown.length;
        return {ok: true, text: `${head}${offset ? ` · from ${offset}` : ''}\n\n${slice || '(no text content)'}${more ? `\n\n… more (offset=${offset + PAGE_CHARS})` : ''}`};
      },
    },
  ];
}
