import type {Answer, Answers, DeciderBackend, Decision, Entry, Questions} from './types.js';

const SYSTEM = `You are a strict decision function. You never chat.
Read STATE, answer every question in QUESTIONS, and reply with ONLY one JSON object exactly matching the requested format. No prose, no code fences.`;

const show = (e: Entry | undefined) => (e === undefined || e === null ? '' : typeof e === 'string' ? e : JSON.stringify(e));

/** Render Jev-style questions as a compact, strict prompt. */
export function renderPrompt(state: Entry, questions: Questions): string {
  const lines: string[] = ['STATE:', show(state), '', 'QUESTIONS:'];
  const format: string[] = [];
  for (const [name, q] of Object.entries(questions)) {
    if (q.type === 'noul') {
      lines.push(`- ${name} (yes/no): ${show(q.instructions)}`);
      if (q.criteria?.true) lines.push(`    yes = ${show(q.criteria.true)}`);
      if (q.criteria?.false) lines.push(`    no = ${show(q.criteria.false)}`);
      format.push(`"${name}": <probability of yes, 0..1>`);
    } else if (q.type === 'choice') {
      lines.push(`- ${name} (pick exactly one label): ${show(q.instructions)}`);
      for (const [label, desc] of Object.entries(q.criteria)) lines.push(`    ${label}: ${show(desc)}`);
      format.push(`"${name}": {"choice": "<label>", "confidence": <0..1>}`);
    } else {
      lines.push(`- ${name} (score 0..${q.criteria.length - 1}): ${show(q.instructions)}`);
      q.criteria.forEach((d, i) => lines.push(`    ${i}: ${show(d)}`));
      format.push(`"${name}": {"score": <number>, "confidence": <0..1>}`);
    }
  }
  lines.push('', `Reply with: {${format.join(', ')}}`);
  return lines.join('\n');
}

const clamp01 = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : undefined);

/** Parse and validate the model's JSON into Jev-shaped answers; throws on anything off-schema. */
export function parseAnswers(raw: string, questions: Questions): Answers {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('decider reply had no JSON object');
  const obj = JSON.parse(raw.slice(start, end + 1));
  const answers: Answers = {};
  for (const [name, q] of Object.entries(questions)) {
    const v = obj[name];
    let a: Answer | undefined;
    if (q.type === 'noul') {
      const p = clamp01(v) ?? (v === true ? 1 : v === false ? 0 : undefined) ?? clamp01(v?.noul);
      if (p !== undefined) a = {type: 'noul', noul: p};
    } else if (q.type === 'choice') {
      const choice = typeof v === 'string' ? v : v?.choice;
      if (typeof choice === 'string' && choice in q.criteria) a = {type: 'choice', choice, confidence: clamp01(v?.confidence) ?? 0.5};
    } else {
      const score = typeof v === 'number' ? v : v?.score;
      if (typeof score === 'number' && score >= 0 && score <= q.criteria.length - 1) a = {type: 'score', score, confidence: clamp01(v?.confidence) ?? 0.5};
    }
    if (!a) throw new Error(`decider answer for "${name}" was invalid`);
    answers[name] = a;
  }
  return answers;
}

export function llmBackend(name: string, complete: (system: string, prompt: string) => Promise<string>): DeciderBackend {
  return {
    name,
    async ask(state: Entry, questions: Questions): Promise<Decision> {
      const prompt = renderPrompt(state, questions);
      let lastErr: Error | undefined;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const raw = await complete(SYSTEM, attempt ? `${prompt}\n\nYour previous reply was invalid. Reply with the JSON object only.` : prompt);
          return {answers: parseAnswers(raw, questions), backend: name};
        } catch (err) {
          lastErr = err as Error;
        }
      }
      throw lastErr ?? new Error('decider failed');
    },
  };
}
