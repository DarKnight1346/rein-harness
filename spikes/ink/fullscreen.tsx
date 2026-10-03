// Spike: Ink alternateScreen with a fixed-height root, 200 tok/s stream + 110 ms spinner.
// Measures full clears and rows rewritten per frame. Usage: npx tsx fullscreen.tsx
import React, {useEffect, useRef, useState} from 'react';
import {render, Box, Text} from 'ink';
import {Writable} from 'node:stream';

const ROWS = 30;
const COLS = 100;
const stats = {bytes: 0, writes: 0, fullClears: 0, maxRowsWritten: 0, frames: 0};
const capture = Object.assign(
  new Writable({
    write(chunk, _e, cb) {
      const s = chunk.toString();
      stats.bytes += s.length;
      stats.writes++;
      if (s.includes('\x1b[2J')) { stats.fullClears++; (stats as any).clearAt = [...((stats as any).clearAt ?? []), stats.frames]; }
      // rows rewritten ≈ number of "cursorTo(0)+content" segments (incremental) or newlines (full)
      const rows = (s.match(/\x1b\[G|\x1b\[1G|\n/g) ?? []).length;
      stats.maxRowsWritten = Math.max(stats.maxRowsWritten, rows);
      cb();
    },
  }),
  {isTTY: true, rows: ROWS, columns: COLS},
);

const WORDS = 'the quick brown fox jumps over a lazy dog while streaming tokens into a terminal ui'.split(' ');

function App({onDone}: {onDone(): void}) {
  const [lines, setLines] = useState<string[]>([]);
  const [tick, setTick] = useState(0);
  const buf = useRef('');
  useEffect(() => {
    let n = 0;
    const tok = setInterval(() => {
      buf.current += WORDS[n % WORDS.length] + (n % 13 === 12 ? '\n' : ' ');
      if (++n === 1200) {
        clearInterval(tok);
        setTimeout(onDone, 200);
      }
    }, 5);
    const flush = setInterval(() => setLines(buf.current.split('\n')), 33);
    const spin = setInterval(() => setTick((t) => t + 1), 110);
    return () => [tok, flush, spin].forEach(clearInterval);
  }, []);
  const historyRows = ROWS - 5;
  const visible = lines.slice(-historyRows);
  return (
    <Box flexDirection="column" height={ROWS} width={COLS}>
      <Text inverse> ▁▃▅▇ Rein · Sonnet · me@x.com · 5h 12% </Text>
      <Box flexDirection="column" height={historyRows} overflow="hidden">
        {visible.map((l, i) => (
          <Text key={i} wrap="truncate">
            {l}
          </Text>
        ))}
      </Box>
      <Text color="cyan">{['▇▅▃▁', '▅▇▅▃', '▃▅▇▅', '▁▃▅▇'][tick % 4]} Responding… ({tick})</Text>
      <Box borderStyle="round" height={2} borderBottom={false}>
        <Text>{'> '}</Text>
      </Box>
    </Box>
  );
}

const app = render(<App onDone={() => app.unmount()} />, {
  stdout: capture as unknown as NodeJS.WriteStream,
  patchConsole: false,
  maxFps: 30,
  incrementalRendering: true,
  alternateScreen: true,
  interactive: true,
  onRender: () => void stats.frames++,
});
await app.waitUntilExit();
console.log(JSON.stringify(stats));
