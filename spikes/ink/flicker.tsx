// M0 spike: measure Ink output under a fast fake token stream.
// Usage: npx tsx flicker.tsx [naive|rein] [--tty]   (--tty renders to the real terminal for eyeballing)
import React, {useEffect, useRef, useState} from 'react';
import {render, Box, Text, Static} from 'ink';
import {Writable} from 'node:stream';

const MODE = process.argv[2] === 'naive' ? 'naive' : 'rein';
const REAL_TTY = process.argv.includes('--tty');
const ROWS = REAL_TTY ? process.stdout.rows : 40;
const COLS = REAL_TTY ? process.stdout.columns : 100;
const TOKENS_PER_SEC = 200;
const TOTAL_TOKENS = 1200;
const MESSAGES = Number(process.env.MSGS ?? 3);
const FLUSH_MS = 33;
const LIVE_MAX_LINES = Number(process.env.LIVE ?? Math.max(4, ROWS - 8)); // input + status bar stay on screen

const WORDS = 'the quick brown fox jumps over a lazy dog while streaming tokens into a terminal ui'.split(' ');
const fakeToken = (i: number) => (i % 37 === 36 ? '\n' : WORDS[i % WORDS.length] + ' ');

// Capturing stdout that looks like a TTY so Ink takes its interactive code path.
const stats = {bytes: 0, writes: 0, fullClears: 0, maxErasedLines: 0};
const capture = Object.assign(new Writable({
  write(chunk, _enc, cb) {
    const s = chunk.toString();
    stats.bytes += s.length;
    stats.writes++;
    if (s.includes('\x1b[2J') || s.includes('\x1b[3J') || s.includes('\x1bc')) stats.fullClears++;
    const erased = (s.match(/\x1b\[2K/g) ?? []).length;
    stats.maxErasedLines = Math.max(stats.maxErasedLines, erased);
    cb();
  },
}), {isTTY: true, rows: ROWS, columns: COLS});

type Msg = {id: number; text: string};

// Split a growing message so only the tail stays in the dynamic region.
function splitForLive(text: string): [committed: string, live: string] {
  // Count terminal rows after wrapping, not '\n's (Ink full-clears once the live region >= rows).
  const lines = text.split('\n');
  const rowsOf = (l: string) => Math.max(1, Math.ceil(l.length / COLS));
  let rows = 0;
  let cut = lines.length;
  while (cut > 0 && rows + rowsOf(lines[cut - 1]) <= LIVE_MAX_LINES) rows += rowsOf(lines[--cut]);
  if (cut === 0) return ['', text];
  // Only commit whole lines; the last line may still be growing, so always keep it live.
  cut = Math.min(cut, lines.length - 1);
  return [lines.slice(0, cut).join('\n'), lines.slice(cut).join('\n')];
}

function App({onDone}: {onDone: () => void}) {
  const [done, setDone] = useState<Msg[]>([]);
  const [live, setLive] = useState('');
  const buf = useRef('');
  const committedLen = useRef(0);
  const nextId = useRef(0);

  useEffect(() => {
    let msg = 0;
    let tok = 0;
    const perMsg = TOTAL_TOKENS / MESSAGES;
    const tick = setInterval(() => {
      buf.current += fakeToken(tok++);
      if (MODE === 'naive') setLive(buf.current); // render per token
      if (tok % perMsg === 0) {
        const rest = buf.current.slice(committedLen.current);
        setDone((d) => [...d, {id: nextId.current++, text: rest}]);
        buf.current = '';
        committedLen.current = 0;
        setLive('');
        if (++msg === MESSAGES) {
          clearInterval(tick);
          clearInterval(flush);
          setTimeout(onDone, 100);
        }
      }
    }, 1000 / TOKENS_PER_SEC);
    const flush = setInterval(() => {
      if (MODE !== 'rein') return;
      const pendingText = buf.current.slice(committedLen.current);
      const [committed, tail] = splitForLive(pendingText);
      if (committed) {
        committedLen.current += committed.length + 1;
        setDone((d) => [...d, {id: nextId.current++, text: committed}]);
      }
      setLive(tail);
    }, FLUSH_MS);
    return () => { clearInterval(tick); clearInterval(flush); };
  }, []);

  return (
    <>
      <Static items={done}>{(m) => <Text key={m.id}>{m.text}</Text>}</Static>
      <Box flexDirection="column">
        <Text>{MODE === 'naive' ? buf.current : live}</Text>
        <Box borderStyle="round" paddingX={1}><Text dimColor>&gt; type a message</Text></Box>
        <Text dimColor>rein · haiku · 5h 12% · wk 3%</Text>
      </Box>
    </>
  );
}

const t0 = Date.now();
let frames = 0;
const app = render(<App onDone={() => app.unmount()} />, {
  stdout: (REAL_TTY ? process.stdout : capture) as unknown as NodeJS.WriteStream,
  patchConsole: false,
  exitOnCtrlC: true,
  maxFps: MODE === 'rein' ? 30 : 1000,
  incrementalRendering: MODE === 'rein',
  onRender: () => { frames++; },
});
await app.waitUntilExit();
const report = {mode: MODE, rows: ROWS, ms: Date.now() - t0, frames, ...stats};
if (REAL_TTY) console.log(JSON.stringify(report));
else process.stderr.write(JSON.stringify(report) + '\n');
