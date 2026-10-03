import React, {useState} from 'react';
import {Box, Text, useInput} from 'ink';
import type {AskAnswer, AskQuestion} from '../tools/ask.js';
import {TextInput} from './TextInput.js';
import {Clickable} from './terminal/clicks.js';

/**
 * The agent's questions, one at a time: ↑↓ move, enter picks (multi: space toggles, enter confirms),
 * the last row "Something else" takes typed text, ←→ switch questions; after the last question the
 * answers go back together. Esc dismisses.
 */
export function AskScreen({questions, onDone}: {questions: AskQuestion[]; onDone(answers: AskAnswer[] | undefined): void}) {
  const [index, setIndex] = useState(0);
  const [cursor, setCursor] = useState(0);
  const [answers, setAnswers] = useState<AskAnswer[]>(questions.map((q) => ({id: q.id, selected: []})));
  const q = questions[index]!;
  const a = answers[index]!;
  const otherRow = q.options.length; // "Something else"
  const typing = cursor === otherRow;

  const update = (patch: Partial<AskAnswer>) => setAnswers((all) => all.map((x, i) => (i === index ? {...x, ...patch} : x)));
  const next = (latest = answers) => {
    if (index < questions.length - 1) {
      setIndex(index + 1);
      setCursor(0);
    } else onDone(latest);
  };
  const pick = (i: number) => {
    const label = q.options[i]!.label;
    if (q.multi) update({selected: a.selected.includes(label) ? a.selected.filter((l) => l !== label) : [...a.selected, label]});
    else {
      const latest = answers.map((x, k) => (k === index ? {...x, selected: [label], other: undefined} : x));
      setAnswers(latest);
      next(latest);
    }
  };

  useInput((input, key) => {
    if (key.escape) return onDone(undefined);
    if (key.upArrow) return setCursor((c) => Math.max(0, c - 1));
    if (key.downArrow) return setCursor((c) => Math.min(otherRow, c + 1));
    if (typing) return; // the text box handles keys
    if (key.leftArrow && index > 0) return (setIndex(index - 1), setCursor(0));
    if (key.rightArrow && index < questions.length - 1) return (setIndex(index + 1), setCursor(0));
    if (input === ' ' && q.multi) return pick(cursor);
    if (key.return) {
      if (q.multi) next();
      else pick(cursor);
    }
  });

  return (
    <Box flexDirection="column">
      <Text dimColor>
        Question {index + 1} of {questions.length}
        {q.multi ? ' · choose any' : ''}
      </Text>
      <Text bold wrap="wrap">
        {q.question}
      </Text>
      <Box flexDirection="column" marginY={1}>
        {q.options.map((o, i) => {
          const chosen = a.selected.includes(o.label);
          return (
            <Clickable key={o.label} onHover={() => setCursor(i)} onClick={() => (setCursor(i), pick(i))}>
              <Text wrap="truncate" color={i === cursor ? 'cyan' : undefined}>
                {i === cursor ? '❯ ' : '  '}
                {q.multi ? (chosen ? '[x] ' : '[ ] ') : chosen ? '● ' : '○ '}
                {o.label}
                {o.description ? <Text dimColor> — {o.description}</Text> : null}
              </Text>
            </Clickable>
          );
        })}
        <Box>
          <Text color={typing ? 'cyan' : undefined}>{typing ? '❯ ' : '  '}Something else: </Text>
          {typing ? (
            <TextInput
              value={a.other ?? ''}
              onChange={(v) => update({other: v})}
              placeholder="type your answer, enter to continue"
              onSubmit={(v) => {
                const latest = answers.map((x, k) => (k === index ? {...x, other: v.trim() || undefined, selected: q.multi ? x.selected : []} : x));
                setAnswers(latest);
                next(latest);
              }}
            />
          ) : (
            <Text dimColor>{a.other ?? '(↓ to type)'}</Text>
          )}
        </Box>
      </Box>
      <Text dimColor>
        {q.multi ? 'space toggle · enter next' : 'enter choose'} · ↑↓ move{questions.length > 1 ? ' · ←→ question' : ''} · esc dismiss
      </Text>
    </Box>
  );
}
