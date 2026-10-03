import {createReadStream, existsSync} from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import {readJson} from '../store/json.js';
import {paths} from '../store/paths.js';
import {listTranscripts, sessionLog, type Message, type SessionInfo} from '../session/transcript.js';
import {ripgrep, ToolError, type ToolContext, type ToolResult} from './fs.js';
import {run} from '../util/proc.js';

const MAX_MATCHES = 60;
const SNIPPET = 160;

const day = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');

function snippet(text: string, re: RegExp): string {
  const flat = text.replace(/\s+/g, ' ');
  const m = re.exec(flat);
  const at = m ? Math.max(0, m.index - 50) : 0;
  return (at ? '…' : '') + flat.slice(at, at + SNIPPET) + (flat.length > at + SNIPPET ? '…' : '');
}

type Rec = Message & {t: 'msg'; i: number};

/** Lines of a session JSONL matching `re` (decoded message text + tool calls). */
function matchText(rec: Rec, re: RegExp): string | undefined {
  for (const h of [rec.text, ...(rec.tools ?? []).map((x) => `${x.label}(${x.summary}) → ${x.result}`)]) if (re.test(h)) return h;
  return undefined;
}

/**
 * Regex over saved conversations without loading them: ripgrep scans the JSONL logs (fast,
 * streaming, stops per file at a cap) and only matching lines are parsed. Falls back to streaming
 * each log line by line.
 */
export async function sessionsSearch(ctx: ToolContext, args: {pattern: string; all_projects?: boolean; case_sensitive?: boolean}): Promise<ToolResult> {
  if (typeof args?.pattern !== 'string' || !args.pattern) throw new ToolError('pattern is required');
  let re: RegExp;
  try {
    re = new RegExp(args.pattern, args.case_sensitive ? '' : 'i');
  } catch (err) {
    throw new ToolError(`invalid regex: ${(err as Error).message}`);
  }
  const sessions = await listTranscripts(args.all_projects ? {} : {cwd: ctx.root});
  const byId = new Map<string, SessionInfo>(sessions.map((s) => [s.id, s]));
  if (!byId.size) return {ok: true, text: 'No saved conversations yet.'};
  const files = [...byId.keys()].map((id) => sessionLog(id)).filter(existsSync);
  const out: string[] = [];
  let total = 0;
  const add = (id: string, rec: Rec) => {
    const hit = matchText(rec, re);
    if (!hit) return; // raw-JSON match that isn't in the decoded text (e.g. an escape sequence)
    total++;
    if (out.length < MAX_MATCHES) out.push(`${id}${id === ctx.sessionId ? ' (current)' : ''} · ${day(rec.at)} · #${rec.i} ${rec.role}: ${snippet(hit, re)}`);
  };
  const rg = await ripgrep();
  if (rg) {
    // The JSON-escaped line is searched; a regex with literal text works the same on it.
    const res = await run(rg, ['--no-heading', '--with-filename', '--color', 'never', ...(args.case_sensitive ? [] : ['-i']), '--max-count', '200', '-e', args.pattern, '--', ...files], {timeoutMs: 30_000});
    if (res.code !== 0 && res.code !== 1) throw new ToolError(`search failed: ${res.stderr.trim().slice(0, 300)}`);
    for (const line of res.stdout.split('\n')) {
      const sep = line.indexOf('.jsonl:');
      if (sep < 0) continue;
      const id = path.basename(line.slice(0, sep));
      try {
        const rec = JSON.parse(line.slice(sep + 7));
        if (rec.t === 'msg') add(id, rec);
      } catch {}
    }
  } else {
    for (const file of files) {
      const id = path.basename(file, '.jsonl');
      const rl = readline.createInterface({input: createReadStream(file, {encoding: 'utf8'}), crlfDelay: Infinity});
      for await (const line of rl) {
        if (!re.test(line)) continue;
        try {
          const rec = JSON.parse(line);
          if (rec.t === 'msg') add(id, rec);
        } catch {}
      }
    }
  }
  if (!out.length) return {ok: true, text: `No matches${args.all_projects ? '' : ' in this project (try all_projects: true)'}.`};
  return {ok: true, text: out.join('\n') + (total > out.length ? `\n… ${total - out.length} more (refine the pattern)` : '') + '\nRead one with session_read {id, offset}.'};
}

/** A saved conversation's messages (with tool calls), paged — streams the log and stops early. */
export async function sessionRead(_ctx: ToolContext, args: {id: string; offset?: number; limit?: number}): Promise<ToolResult> {
  if (typeof args?.id !== 'string' || !/^[\w-]+$/.test(args.id)) throw new ToolError('a session id is required (see sessions_search)');
  const file = sessionLog(args.id);
  if (!existsSync(file)) throw new ToolError(`no session ${args.id}`);
  const info = await readJson<SessionInfo | undefined>(path.join(paths.sessions(), `${args.id}.meta.json`), undefined).catch(() => undefined);
  const from = Math.max(0, Math.floor(args.offset ?? 0));
  const limit = Math.max(1, Math.min(100, Math.floor(args.limit ?? 30)));
  const picked: Rec[] = [];
  let more = false;
  const rl = readline.createInterface({input: createReadStream(file, {encoding: 'utf8'}), crlfDelay: Infinity});
  for await (const line of rl) {
    if (!line.startsWith('{"t":"msg"')) continue;
    // Cheap index check before parsing: `{"t":"msg","i":N,`
    const i = Number(/^\{"t":"msg","i":(\d+)/.exec(line)?.[1] ?? -1);
    if (i < from) continue;
    if (picked.length >= limit) {
      more = true;
      break;
    }
    try {
      picked.push(JSON.parse(line));
    } catch {}
  }
  rl.close();
  const body = picked.map((m) => {
    const tools = (m.tools ?? []).map((x) => `    [${x.label}(${x.summary}) ${x.ok ? '✓' : '✗'}] ${x.result.split('\n')[0]?.slice(0, 200) ?? ''}`).join('\n');
    return `#${m.i} ${m.role}${m.model ? ` (${m.model.model})` : ''} · ${day(m.at)}\n${m.text}${tools ? `\n${tools}` : ''}`;
  });
  const last = picked.at(-1)?.i ?? from;
  return {
    ok: true,
    text: `Session ${args.id} · ${info?.cwd ?? ''} · ${info?.messages ?? '?'} messages\n\n${body.join('\n\n') || '(no messages at that offset)'}${more ? `\n… more (offset=${last + 1})` : ''}`,
  };
}


