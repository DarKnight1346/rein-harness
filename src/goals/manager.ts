import {EventEmitter} from 'node:events';
import type {Decision, Entry, Questions} from '../decider/types.js';
import type {Transcript} from '../session/transcript.js';

export type GoalStatus = 'active' | 'paused' | 'done';

export type GoalCheck = {at: number; kind: 'claim' | 'turn'; verdict: string};

export type Goal = {
  text: string;
  status: GoalStatus;
  createdAt: number;
  /** Transcript index where work on the goal started (evidence is gathered from here on). */
  since: number;
  /** Automatic continuations sent so far. */
  rounds: number;
  /** Times the agent declared it impossible / gave up (each triggers an escalation). */
  escalations: number;
  checks: GoalCheck[];
  doneAt?: number;
};


/** Done claims need at least this probability of "evidence shows it's achieved". */
const ACCEPT_AT = 0.7;
const GAVE_UP_AT = 0.6;

export type GoalDeps = {
  /** Continuations before the goal pauses itself; 0 = unlimited. */
  maxRounds(): number;
  /** Current conversation (undefined before the engine starts). */
  transcript(): Transcript | undefined;
  save(): void;
  decide(state: Entry, questions: Questions): Promise<Decision>;
  /** Advisor answer if one is configured, else undefined. */
  advise(question: string): Promise<string | undefined>;
  /** Fallback when there's no advisor: a fresh subagent investigates; returns its report. */
  investigate(task: string): Promise<string>;
};

export type NextStep = {message: string; note: string} | undefined;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/**
 * `/goal`: a standing objective for the conversation. The agent keeps working until it calls
 * `goal_done` and the decision model accepts the *evidence* (tool results in context, not the
 * claim). "Impossible" is never accepted: giving up escalates to the advisor (or a fresh subagent)
 * and the agent continues with that input. Emits `change`.
 */
export class GoalManager extends EventEmitter {
  constructor(private readonly deps: GoalDeps) {
    super();
  }

  get goal(): Goal | undefined {
    return this.deps.transcript()?.goal;
  }

  private t(): Transcript {
    const t = this.deps.transcript();
    if (!t) throw new Error('no conversation yet');
    return t;
  }

  set(text: string): Goal {
    const t = this.t();
    t.goal = {text, status: 'active', createdAt: Date.now(), since: t.messages.length, rounds: 0, escalations: 0, checks: []};
    this.persist();
    return t.goal;
  }

  pause(): boolean {
    const g = this.goal;
    if (!g || g.status !== 'active') return false;
    g.status = 'paused';
    this.persist();
    return true;
  }

  resume(): boolean {
    const g = this.goal;
    if (!g || g.status !== 'paused') return false;
    g.status = 'active';
    const cap = this.deps.maxRounds();
    if (cap && g.rounds >= cap) g.rounds = 0; // the user explicitly resumed past the cap
    this.persist();
    return true;
  }

  clear(): boolean {
    const t = this.deps.transcript();
    if (!t?.goal) return false;
    delete t.goal;
    this.persist();
    return true;
  }

  /** The first message that starts work on a new goal. */
  kickoff(g: Goal): string {
    return [
      `<goal>${g.text}</goal>`,
      'Work toward this goal now and keep going until it is fully achieved. Rein will keep you on it across turns.',
      '- When it is achieved, call goal_done with concrete evidence (what you ran/checked and what it showed). A claim without evidence in this conversation is rejected.',
      '- "Impossible" or "can\'t be done" is not a way to finish: look for another approach, consult the advisor tool if available, or break the problem down.',
    ].join('\n');
  }

  /** Evidence gathered since the goal started: tool calls with result excerpts, latest first. */
  private evidence(): string[] {
    const g = this.goal;
    const t = this.deps.transcript();
    if (!g || !t) return [];
    return t.messages
      .slice(g.since)
      .flatMap((m) => (m.tools ?? []).map((x) => `${x.label}(${clip(x.summary, 120)}) ${x.ok ? 'ok' : 'FAILED'}: ${clip(x.result.replace(/\s+/g, ' '), 400)}`))
      .slice(-30)
      .reverse();
  }

  /** `goal_done`: the decision model accepts only if the evidence in context shows the goal achieved. */
  async reviewClaim(summary: string, evidence: string): Promise<{accepted: boolean; note: string}> {
    const g = this.goal;
    if (!g || g.status === 'done') return {accepted: false, note: 'there is no active goal'};
    const lastAssistant = [...this.t().messages].reverse().find((m) => m.role === 'assistant')?.text ?? '';
    const d = await this.deps.decide(
      {goal: g.text, agent_summary: clip(summary, 2000), agent_evidence: clip(evidence, 3000), tool_results_since_goal_started: this.evidence(), last_message: clip(lastAssistant, 1500)},
      {
        achieved: {
          type: 'noul',
          instructions:
            'Do the tool results and evidence in context concretely show that the goal is fully achieved (e.g. passing tests, verified output, files present)? A bare claim, a plan, partial progress, or "it is impossible" is NOT achieved.',
          criteria: {true: 'fully achieved, demonstrated by evidence in context', false: 'not demonstrated, partial, only claimed, or declared impossible'},
        },
      },
    );
    const a = d.answers.achieved;
    const p = a?.type === 'noul' ? a.noul : 0;
    const accepted = p >= ACCEPT_AT;
    const note = `${accepted ? 'accepted' : 'rejected'} (${p.toFixed(2)} via ${d.backend})`;
    g.checks.push({at: Date.now(), kind: 'claim', verdict: note});
    if (accepted) {
      g.status = 'done';
      g.doneAt = Date.now();
    }
    this.persist();
    return {accepted, note};
  }

  /**
   * After a turn ends with the goal still active: decide what to tell the agent next. Giving up →
   * escalate to the advisor (or a subagent); otherwise a plain continuation. Pauses at the cap.
   */
  async next(): Promise<NextStep> {
    const g = this.goal;
    if (!g || g.status !== 'active') return undefined;
    const cap = this.deps.maxRounds();
    if (cap && g.rounds >= cap) {
      g.status = 'paused';
      g.checks.push({at: Date.now(), kind: 'turn', verdict: `paused after ${cap} automatic continuations (limit in /configure → Goals)`});
      this.persist();
      return undefined;
    }
    g.rounds++;
    const last = [...this.t().messages].reverse().find((m) => m.role === 'assistant')?.text ?? '';
    const d = await this.deps
      .decide({goal: g.text, latest_agent_message: clip(last, 3000)}, {
        gave_up: {
          type: 'noul',
          instructions: 'Does the agent\'s latest message declare the goal impossible, blocked, or give up on it (rather than reporting progress or asking a needed question)?',
          criteria: {true: 'gives up / says impossible or blocked', false: 'still working, reporting progress, or asking the user something necessary'},
        },
      })
      .catch(() => undefined);
    const gu = d?.answers.gave_up;
    const gaveUp = gu?.type === 'noul' && gu.noul >= GAVE_UP_AT;
    if (!gaveUp) {
      this.persist();
      return {
        note: `goal: continuing (round ${g.rounds})`,
        message: `<goal_reminder>Goal: ${g.text}\nKeep working toward it. If it's achieved, call goal_done with evidence; otherwise take the next concrete step.</goal_reminder>`,
      };
    }
    // "Impossible" is not completion: get outside input and continue.
    g.escalations++;
    const question = `The agent working on this goal says it is impossible or blocked.\nGoal: ${g.text}\nAgent's latest message:\n${clip(last, 3000)}\nGive a concrete path forward: alternative approaches, what to check, how to break it down. Assume it can be done.`;
    let help = await this.deps.advise(question).catch(() => undefined);
    let source = 'the advisor';
    if (!help) {
      source = 'a subagent';
      help = await this.deps
        .investigate(`${question}\nInvestigate the codebase and environment as needed, then report a concrete plan (or the solution) for the main agent.`)
        .catch((err) => `(the investigating subagent failed: ${(err as Error).message})`);
    }
    g.checks.push({at: Date.now(), kind: 'turn', verdict: `gave up → escalated to ${source}`});
    this.persist();
    return {
      note: `goal: the agent said it's impossible — asked ${source} for a way forward`,
      message: `<goal_escalation>"Impossible" is not a completion. Input from ${source}:\n${help}\n</goal_escalation>\nGoal: ${g.text}\nUse this to continue. Call goal_done only with evidence that the goal is achieved.`,
    };
  }

  private persist(): void {
    this.deps.save();
    this.emit('change');
  }
}
