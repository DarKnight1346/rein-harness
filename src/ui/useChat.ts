import {useCallback, useEffect, useRef, useState} from 'react';
import {useStdout} from 'ink';
import type {Route} from '../session/engine.js';
import type {CompactReason, CompactResult} from '../session/compactor.js';
import type {DiffLine} from '../tools/diff.js';
import type {Account, ImageInput} from '../providers/types.js';
import {runtime} from '../runtime.js';
import {liveRowBudget, splitLiveTail} from './liveTail.js';
import type {Phase} from './Working.js';

export type ChatEntry =
  | {id: number; kind: 'assistant'; text: string; first: boolean}
  | {id: number; kind: 'tool'; label: string; summary: string; ok: boolean; result: string; approvedBy?: string; judge?: string; diff?: DiffLine[]}
  | {id: number; kind: 'compact'; reason: CompactReason; result: Extract<CompactResult, {summarized: number}>}
  | {id: number; kind: 'route'; route: Route; account: Account; interrupted: boolean};

/** Omit that distributes over a union (plain Omit collapses it). */
export type NewEntry<T> = T extends unknown ? Omit<T, 'id'> : never;

const FLUSH_MS = 33;
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
export function useChat(commit: (e: NewEntry<ChatEntry>) => void, notice: (kind: 'info' | 'error', text: string) => void, opts: {split: boolean} = {split: true}) {
  const {stdout} = useStdout();
  const [live, setLive] = useState('');
  const [busy, setBusy] = useState(false);
  const [startedAt, setStartedAt] = useState(0);
  const [phase, setPhase] = useState<Phase>('thinking');
  /** Tool currently running, e.g. `Edit(src/a.ts)`. */
  const [toolLabel, setToolLabel] = useState<string | undefined>();
  /** Tokens of the call in flight: sent (incl. cached) / received. */
  const [tokens, setTokens] = useState<{input: number; cached: number; output: number} | undefined>();
  const pending = useRef('');
  const firstSegment = useRef(true);

  const flush = useCallback(
    (final: boolean) => {
      const cols = Math.max(20, (stdout.columns ?? 80) - GUTTER);
      if (final) {
        if (pending.current.trim()) commit({kind: 'assistant', text: pending.current.replace(/\s+$/, ''), first: firstSegment.current});
        pending.current = '';
        setLive('');
        return;
      }
      if (!opts.split) {
        setLive(pending.current);
        return;
      }
      const {committed, live} = splitLiveTail(pending.current, liveRowBudget(stdout.rows ?? 24), cols);
      if (committed) {
        commit({kind: 'assistant', text: committed, first: firstSegment.current});
        firstSegment.current = false;
        pending.current = live;
      }
      setLive(live);
    },
    [commit, stdout, opts.split],
  );

  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => flush(false), FLUSH_MS);
    return () => clearInterval(t);
  }, [busy, flush]);

  const send = useCallback(
    async (text: string, images?: ImageInput[]) => {
      setBusy(true);
      setStartedAt(Date.now());
      setPhase(runtime.config.chatModel === 'auto' ? 'routing' : 'thinking');
      setTokens(undefined);
      setToolLabel(undefined);
      let responding = false;
      pending.current = '';
      firstSegment.current = true;
      let route: {route: Route; account: Account} | undefined;
      try {
        for await (const ev of runtime.engine.send(text, images)) {
          if (ev.type === 'route') {
            route = ev;
            setPhase('thinking');
          } else if (ev.type === 'compact') {
            if (ev.phase === 'start') {
              flush(true);
              firstSegment.current = true;
              setToolLabel(`Compacting ${ev.messages} messages`);
              setPhase('tool');
            } else {
              setToolLabel(undefined);
              setPhase('thinking');
              if (!('skipped' in ev.result)) commit({kind: 'compact', reason: ev.reason, result: ev.result});
            }
          } else if (ev.type === 'tokens') {
            setTokens(ev.call);
          } else if (ev.type === 'tool') {
            const a = ev.activity;
            if (a.phase === 'start') {
              flush(true); // text before the tool call stays above its line
              firstSegment.current = true;
              responding = false;
              setToolLabel(`${a.label}(${a.summary})`);
              setPhase('tool');
            } else {
              setToolLabel(undefined);
              setPhase('thinking');
              commit({kind: 'tool', label: a.label, summary: a.summary, ok: a.ok, result: a.result, approvedBy: a.approvedBy, judge: a.judge, diff: a.diff});
            }
          } else if (ev.type === 'text') {
            pending.current += ev.delta;
            if (!responding) {
              responding = true;
              setPhase('responding');
            }
          }
          else if (ev.type === 'notice') {
            flush(true);
            firstSegment.current = true;
            notice('info', ev.text);
          } else if (ev.type === 'done') {
            flush(true);
            if (route) commit({kind: 'route', ...route, interrupted: ev.interrupted});
          } else if (ev.type === 'error') {
            flush(true);
            notice('error', ev.message);
          }
        }
      } catch (err) {
        flush(true);
        notice('error', (err as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [commit, flush, notice],
  );

  // Interrupting the agent also stops the command it is running in the foreground.
  const interrupt = () => {
    runtime.tools.shells.killForeground();
    runtime.agents.cancelAll({foregroundOnly: true}); // the main turn is waiting on them
    runtime.engine.interrupt();
  };
  return {live, busy, startedAt, phase, toolLabel, tokens, send, interrupt};
}
