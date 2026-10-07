import { useCallback, useEffect, useRef, useState } from 'react';
import { planPreview } from './planPreview.js';
import { useStdout } from 'ink';
import { runtime } from '../runtime.js';
import { liveRowBudget, splitLiveTail } from './liveTail.js';
const FLUSH_MS = 33;
/** Most times in a row a Stop hook may send the agent back to work. */
const MAX_STOP_CONTINUATIONS = 10;
const GUTTER = 2;
/**
 * Streams engine output without flicker: deltas accumulate in a ref, a 33 ms timer moves whole
 * lines that no longer fit the live budget into <Static> (via `commit`) and keeps only the tail
 * live. React state changes at most ~30×/s, never per token.
 */
/**
 * `split`: classic renderer — commit whole lines that overflow the live budget to <Static>.
 * Fullscreen keeps the whole reply live (the history pane scrolls it) and commits once at the end.
 */
export function useChat(commit, notice, opts = { split: true }) {
    const { stdout } = useStdout();
    const [live, setLive] = useState('');
    const [busy, setBusy] = useState(false);
    const [startedAt, setStartedAt] = useState(0);
    const [phase, setPhase] = useState('thinking');
    const [waitUntil, setWaitUntil] = useState(undefined);
    /** Tool currently running, e.g. `Edit(src/a.ts)`. */
    const [toolLabel, setToolLabel] = useState();
    /** Tokens of the call in flight: sent (incl. cached) / received. */
    const [tokens, setTokens] = useState();
    const pending = useRef('');
    const firstSegment = useRef(true);
    const flush = useCallback((final) => {
        const cols = Math.max(20, (stdout.columns ?? 80) - GUTTER);
        if (final) {
            if (pending.current.trim())
                commit({ kind: 'assistant', text: pending.current.replace(/\s+$/, ''), first: firstSegment.current });
            pending.current = '';
            setLive('');
            return;
        }
        if (!opts.split) {
            setLive(pending.current);
            return;
        }
        const { committed, live } = splitLiveTail(pending.current, liveRowBudget(stdout.rows ?? 24), cols);
        if (committed) {
            commit({ kind: 'assistant', text: committed, first: firstSegment.current });
            firstSegment.current = false;
            pending.current = live;
        }
        setLive(live);
    }, [commit, stdout, opts.split]);
    useEffect(() => {
        if (!busy)
            return;
        const t = setInterval(() => flush(false), FLUSH_MS);
        return () => clearInterval(t);
    }, [busy, flush]);
    const send = useCallback(async (text, images, stopDepth = 0) => {
        let finished = false;
        setBusy(true);
        setStartedAt(Date.now());
        setPhase(runtime.config.chatModel === 'auto' ? 'routing' : 'thinking');
        setTokens(undefined);
        setToolLabel(undefined);
        let responding = false;
        pending.current = '';
        firstSegment.current = true;
        let route;
        try {
            for await (const ev of runtime.engine.send(text, images)) {
                if (ev.type !== 'waiting' && ev.type !== 'notice')
                    setWaitUntil(undefined);
                runtime.remoteBus.emit('engine', ev); // the remote page watches the same stream
                if (ev.type === 'route') {
                    route = ev;
                    setPhase('thinking');
                }
                else if (ev.type === 'compact') {
                    if (ev.phase === 'start') {
                        flush(true);
                        firstSegment.current = true;
                        setToolLabel(`Compacting ${ev.messages} messages`);
                        setPhase('tool');
                    }
                    else {
                        setToolLabel(undefined);
                        setPhase('thinking');
                        if (!('skipped' in ev.result))
                            commit({ kind: 'compact', reason: ev.reason, result: ev.result });
                    }
                }
                else if (ev.type === 'tokens') {
                    setTokens(ev.call);
                }
                else if (ev.type === 'tool') {
                    const a = ev.activity;
                    if (a.phase === 'start') {
                        flush(true); // text before the tool call stays above its line
                        firstSegment.current = true;
                        responding = false;
                        setToolLabel(`${a.label}(${a.summary})`);
                        setPhase('tool');
                    }
                    else {
                        setToolLabel(undefined);
                        setPhase('thinking');
                        const plan = planPreview(a.label, a.summary, a.ok, a.result); // plans show rendered, not as a diff
                        commit({ kind: 'tool', label: a.label, summary: a.summary, ok: a.ok, result: a.result, approvedBy: a.approvedBy, judge: a.judge, diff: a.diff, ...(plan ? { plan } : {}) });
                    }
                }
                else if (ev.type === 'text') {
                    pending.current += ev.delta;
                    if (!responding) {
                        responding = true;
                        setPhase('responding');
                    }
                }
                else if (ev.type === 'waiting') {
                    setWaitUntil(ev.until);
                    setPhase('waiting');
                }
                else if (ev.type === 'notice') {
                    flush(true);
                    firstSegment.current = true;
                    notice('info', ev.text);
                }
                else if (ev.type === 'done') {
                    flush(true);
                    if (route)
                        commit({ kind: 'route', ...route, interrupted: ev.interrupted });
                    finished = !ev.interrupted;
                }
                else if (ev.type === 'error') {
                    flush(true);
                    notice('error', ev.message);
                }
            }
        }
        catch (err) {
            flush(true);
            notice('error', err.message);
        }
        finally {
            setBusy(false);
        }
        // A Stop hook may keep the agent working (bounded, like Claude Code's stop_hook_active).
        if (finished && stopDepth < MAX_STOP_CONTINUATIONS) {
            const stop = await runtime.stopHook(stopDepth > 0).catch(() => undefined);
            if (stop?.kind === 'hook') {
                notice('info', `Stop hook: ${stop.reason}`);
                await send(`<stop_hook>\n${stop.reason}\n</stop_hook>\nContinue working.`, undefined, stopDepth + 1);
            }
            else if (stop) {
                notice('info', `Code check: ${stop.reason.split('\n')[0]}`);
                await send(`<code_check>\n${stop.reason}\n</code_check>`, undefined, stopDepth + 1);
            }
        }
    }, [commit, flush, notice]);
    // Interrupting the agent also stops the command it is running in the foreground.
    const interrupt = () => {
        runtime.tools.shells.killForeground();
        runtime.agents.cancelAll({ foregroundOnly: true }); // the main turn is waiting on them
        runtime.engine.interrupt();
    };
    return { live, busy, startedAt, phase, toolLabel, tokens, send, interrupt, waitUntil };
}
