/** Jev's question schema (typesafe.ai SystemOne); the LLM backend renders the same questions. */
export type Entry = string | Record<string, unknown> | unknown[] | null;

export type NoulQuestion = {type: 'noul'; instructions?: Entry; criteria?: {true?: Entry; false?: Entry} | null};
export type ChoiceQuestion = {type: 'choice'; instructions?: Entry; criteria: Record<string, Entry>};
export type ScoreQuestion = {type: 'score'; instructions?: Entry; criteria: Entry[]};
export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;
export type Questions = Record<string, Question>;

export type NoulAnswer = {type: 'noul'; noul: number};
export type ChoiceAnswer = {type: 'choice'; choice: string; confidence: number; probabilities?: Record<string, number>};
export type ScoreAnswer = {type: 'score'; score: number; confidence: number};
export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;
export type Answers = Record<string, Answer>;

export type Decision = {answers: Answers; backend: string; inputTokens?: number};

export interface DeciderBackend {
  name: string;
  ask(state: Entry, questions: Questions): Promise<Decision>;
}
