import {ToolError} from '../tools/fs.js';
import type {ToolDef} from '../tools/registry.js';
import type {GoalManager} from './manager.js';

/** `milestone_done` (main agent, while a goal works from a plan): tick a milestone after the decision model checks the evidence. */
export function milestoneDoneTool(goals: GoalManager): ToolDef {
  return {
    name: 'milestone_done',
    label: 'Milestone',
    description: "Mark a milestone of the goal's plan as done.",
    describe: () =>
      "Only while a goal from a saved plan is active (otherwise it errors): mark milestone N of the plan as done. A decision model checks the evidence in this conversation (tool results such as test runs, command output) before it is ticked off in the plan file — run the checks first.",
    inputSchema: {
      type: 'object',
      properties: {
        milestone: {type: 'number', description: 'Milestone number (1-based, as listed)'},
        evidence: {type: 'string', description: 'Concrete proof: what you ran/checked and what it showed'},
      },
      required: ['milestone', 'evidence'],
    },
    mutating: false,
    mainOnly: true,
    summarize: (a) => `#${a?.milestone ?? '?'} ${String(a?.evidence ?? '').replace(/\s+/g, ' ').slice(0, 70)}`,
    async run(_ctx, args) {
      const n = Number(args?.milestone);
      if (!Number.isInteger(n) || typeof args?.evidence !== 'string') throw new ToolError('milestone (number) and evidence are required');
      if (goals.goal?.status !== 'active' || !goals.goal.plan) throw new ToolError('there is no active goal from a saved plan');
      const r = await goals.reviewMilestone(n, args.evidence);
      if (!r.accepted) return {ok: false, text: `Milestone ${n} not accepted — ${r.note}. Show concrete proof (run the checks), then call milestone_done again.`};
      return {ok: true, text: `Milestone ${n} done (${r.note}). ${r.remaining ? `${r.remaining} to go — continue with the next one.` : 'All milestones are done: verify the whole goal and call goal_done with evidence.'}`};
    },
  };
}

/** `goal_done` (main agent, only while a goal is active): claim completion; the decision model reviews the evidence. */
export function goalDoneTool(goals: GoalManager): ToolDef {
  return {
    name: 'goal_done',
    label: 'GoalDone',
    description: 'Claim the current /goal is achieved.',
    describe: () =>
      `Only while a /goal is active (otherwise it errors): claim that the goal is fully achieved. A decision model reviews the claim against the evidence in this conversation (tool results such as test runs, command output, file reads) — run the checks first. A bare claim, partial progress, or "impossible" is rejected and you continue working.`,
    inputSchema: {
      type: 'object',
      properties: {
        summary: {type: 'string', description: 'What was done to achieve the goal'},
        evidence: {type: 'string', description: 'Concrete proof: what you ran/checked and what it showed (e.g. "npm test: 42 passed, 0 failed")'},
      },
      required: ['summary', 'evidence'],
    },
    mutating: false,
    mainOnly: true,
    summarize: (a) => String(a?.summary ?? '').replace(/\s+/g, ' ').slice(0, 80),
    async run(_ctx, args) {
      if (typeof args?.summary !== 'string' || typeof args?.evidence !== 'string') throw new ToolError('summary and evidence are required');
      if (goals.goal?.status !== 'active') throw new ToolError('there is no active goal');
      const {accepted, note} = await goals.reviewClaim(args.summary, args.evidence);
      return accepted
        ? {ok: true, text: `Goal accepted as complete (${note}). Tell the user what was achieved.`}
        : {ok: false, text: `Not accepted — ${note}: the evidence in context doesn't show the goal is fully achieved. Keep working; produce concrete proof (run the tests/checks, show the output), then call goal_done again.`};
    },
  };
}
