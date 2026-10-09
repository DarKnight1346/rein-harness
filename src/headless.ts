import {fstatSync} from 'node:fs';
import {loadAccounts} from './store/accounts.js';
import {addDefaultExperiments, HEADLESS_EXPERIMENTS} from './store/config.js';
import type {ApprovalMode} from './tools/host.js';
import {runtime} from './runtime.js';
import {onUntrustedHooks} from './hooks.js';
import {redact} from './ui/privacy.js';

/**
 * `rein -p "…"`: one prompt, no UI — for scripts and CI (like `claude -p`). The prompt can also come
 * from stdin (`git diff | rein -p "review this"`). Anything that would need an approval is refused
 * unless --permission-mode auto|bypass, an --allowedTools rule or a settings rule allows it.
 *
 *   --model <ref|auto>             --effort <level|auto|default>
 *   --output-format text|json|stream-json
 *   --permission-mode ask|auto|bypass|plan   (ask = refuse what would need a yes; plan = read-only, print the plan)
 *   --allowedTools "shell(npm test:*),edit(src/**)"   --disallowedTools "…"
 *   -c, --continue [id]            continue the latest (or a given) conversation in this project
 *   --verbose                      tool calls on stderr (text mode)
 *   --add-dir <path>               another working directory for this run (repeatable)
 *   --scope <dir>                  work in one package of a monorepo
 */
export async function runHeadless(argv: string[]): Promise<number> {
  const opt = (name: string, short?: string) => {
    const i = argv.findIndex((a) => a === name || (short !== undefined && a === short));
    return i >= 0 && argv[i + 1] && !argv[i + 1]!.startsWith('-') ? argv[i + 1] : undefined;
  };
  const has = (...names: string[]) => argv.some((a) => names.includes(a));
  const format = (opt('--output-format') ?? 'text') as 'text' | 'json' | 'stream-json';
  const write = (s: string) => process.stdout.write(s);
  const fail = (message: string) => {
    if (format === 'text') process.stderr.write(`rein: ${message}\n`);
    else write(JSON.stringify({type: 'result', is_error: true, error: message}) + '\n');
    return 1;
  };

  let prompt = opt('--print', '-p') ?? '';
  // Read stdin only when something is actually piped or redirected in (not merely "not a terminal").
  let piped = false;
  try {
    const st = fstatSync(0);
    piped = st.isFIFO() || st.isFile();
  } catch {}
  if (piped) {
    const piped = (await new Promise<string>((resolve) => {
      let data = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (d) => (data += d));
      process.stdin.on('end', () => resolve(data));
    })).trim();
    if (piped) prompt = prompt ? `${prompt}\n\n${piped}` : piped;
  }
  if (!prompt.trim()) return fail('no prompt (rein -p "…", or pipe one in)');
  if (!(await loadAccounts()).accounts.length) return fail('no accounts yet — run `rein` once to import or add one');

  const ci = argv.findIndex((a) => a === '--continue' || a === '-c');
  const resume = ci < 0 ? false : argv[ci + 1] && !argv[ci + 1]!.startsWith('-') ? argv[ci + 1]! : true;
  const {listTranscripts} = await import('./session/transcript.js');
  const resumeId = resume === true ? (await listTranscripts({cwd: process.cwd()}))[0]?.id : resume || undefined;
  // Nobody can review a project's hooks here: untrusted ones are skipped (trust them in `rein` first).
  onUntrustedHooks((p) => process.stderr.write(`rein: skipping ${p.commands.length} project hook${p.commands.length === 1 ? '' : 's'} (not trusted yet). Run \`rein\` in this folder once to review and trust them.\n`));
  // The settings measured on one-off runs (see HEADLESS_EXPERIMENTS).
  addDefaultExperiments(HEADLESS_EXPERIMENTS);
  // --add-dir <path> (repeatable): extra working directories for this run, as in interactive Rein.
  const dirs = argv.flatMap((a, i) => (a === '--add-dir' && argv[i + 1] ? [argv[i + 1]!] : []));
  try {
    if (dirs.length) runtime.tools.addDirs(dirs);
    if (opt('--scope')) runtime.setScope(opt('--scope'));
  } catch (err) {
    return fail((err as Error).message);
  }
  await runtime.init({resume: resumeId ?? false});
  for (const e of runtime.workspace?.errors ?? []) process.stderr.write(`rein: workspace: ${e}\n`);
  await runtime.refreshCatalog();
  const {catalog} = await import('./router/catalog.js');
  if (catalog.codexCompat?.ok === false) {
    const {incompatibleMessage} = await import('./providers/codex/compat.js');
    process.stderr.write(`rein: ${incompatibleMessage(catalog.codexCompat)}\n`);
  }

  // Per-run settings: never saved to config.json.
  const model = opt('--model');
  const effort = opt('--effort');
  const mode = opt('--permission-mode') as ApprovalMode | 'plan' | undefined;
  if (mode && !['ask', 'auto', 'bypass', 'plan'].includes(mode)) return fail(`--permission-mode must be ask, auto, bypass or plan`);
  // plan: read-only exploration; the plan the agent presents is the result (nothing is changed).
  runtime.planMode = mode === 'plan';
  let presented: string | undefined;
  runtime.planPresenter = async (plan) => ((presented = `# ${plan.title}\n\n${plan.plan.replace(/^#\s+.*\n+/, '')}\n\n## Milestones\n${plan.milestones.map((m, i) => `${i + 1}. ${m}`).join('\n')}`), undefined);
  runtime.config = {...runtime.config, ...(model ? {chatModel: model} : {}), ...(effort ? {chatEffort: effort} : {}), ...(mode && mode !== 'plan' ? {toolApproval: mode as ApprovalMode} : {})};
  const list = (s: string | undefined) => (s ?? '').split(/,(?![^(]*\))/).map((r) => r.trim()).filter(Boolean);
  runtime.extraRules = {allow: list(opt('--allowedTools')), deny: list(opt('--disallowedTools'))};
  runtime.approver = undefined; // no one to ask: anything needing a yes is refused

  const verbose = has('--verbose');
  const started = Date.now();
  let reply = '';
  let route: {model: string; account: string; effort?: string} | undefined;
  const tools: {tool: string; summary: string; ok: boolean}[] = [];
  let error: string | undefined;

  const turn = async (text: string) => {
    for await (const ev of runtime.engine.send(text)) {
      if (format === 'stream-json') {
        const out = ev.type === 'route' ? {type: 'route', model: `${ev.route.ref.provider}:${ev.route.ref.model}`, effort: ev.effort} : ev.type === 'tool' ? {type: 'tool', phase: ev.activity.phase, tool: ev.activity.label, summary: ev.activity.summary, ...(ev.activity.phase === 'end' ? {ok: ev.activity.ok} : {})} : ev;
        write(redact(JSON.stringify(out)) + '\n');
      }
      if (ev.type === 'text') {
        reply += ev.delta;
        if (format === 'text') write(ev.delta);
      } else if (ev.type === 'route') {
        route = {model: `${ev.route.ref.provider}:${ev.route.ref.model}`, account: ev.account.id, effort: ev.effort};
      } else if (ev.type === 'tool' && ev.activity.phase === 'end' && !ev.activity.origin) {
        tools.push({tool: ev.activity.label, summary: ev.activity.summary, ok: ev.activity.ok});
        if (verbose && format === 'text') process.stderr.write(`⏺ ${ev.activity.label}(${redact(ev.activity.summary)}) ${ev.activity.ok ? '✓' : '✗'}\n`);
      } else if (ev.type === 'notice' && verbose && format === 'text') {
        process.stderr.write(`${redact(ev.text)}\n`);
      } else if (ev.type === 'error') {
        error = ev.message;
      }
    }
  };

  try {
    await turn(prompt);
    // Stop hooks may send the agent back to work (bounded, as in the UI).
    for (let depth = 0; !error && depth < 10; depth++) {
      const stop = await runtime.stopHook(depth > 0).catch(() => undefined);
      if (!stop) break;
      reply += '\n\n';
      await turn(stop.kind === 'hook' ? `<stop_hook>\n${stop.reason}\n</stop_hook>\nContinue working.` : `<code_check>\n${stop.reason}\n</code_check>`);
    }
  } catch (err) {
    error = (err as Error).message;
  }
  if (presented) reply = presented; // plan mode: the plan is the answer
  if (format === 'text' && presented) write(`\n${presented}\n`);
  if (format === 'text' && reply && !reply.endsWith('\n')) write('\n');
  if (format !== 'text') {
    const t = runtime.engine.sessionTokens;
    write(
      redact(
        JSON.stringify({
          type: 'result',
          is_error: !!error,
          ...(error ? {error} : {}),
          result: reply.trim(),
          session_id: runtime.engine.transcript.id,
          model: route?.model,
          effort: route?.effort,
          tools,
          tokens: t,
          ...(t.usd === undefined ? {} : {cost_usd: Math.round(t.usd * 1e4) / 1e4}),
          duration_ms: Date.now() - started,
        }),
      ) + '\n',
    );
  } else if (error) process.stderr.write(`rein: ${redact(error)}\n`);
  await runtime.telemetry.flush();
  runtime.shutdown();
  return error ? 1 : 0;
}
