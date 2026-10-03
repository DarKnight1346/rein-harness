import {ToolError} from '../tools/fs.js';
import type {ToolDef} from '../tools/registry.js';
import type {GoalManager} from './manager.js';

/** `goal_done` (main agent, only while a goal is active): claim completion; the decision model reviews the evidence. */
export function goalDoneTool(goals: GoalManager): ToolDef {
  return {
    name: 'goal_done',
    label: 'GoalDone',
    description: 'Claim the current /goal is achieved.',
    enabled: () => goals.goal?.status === 'active',
    describe: () =>
      `Claim that the current goal is fully achieved: "${goals.goal?.text ?? ''}". A decision model reviews the claim against the evidence in this conversation (tool results such as test runs, command output, file reads) — run the checks first. A bare claim, partial progress, or "impossible" is rejected and you continue working.`,
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
      const {accepted, note} = await goals.reviewClaim(args.summary, args.evidence);
      return accepted
        ? {ok: true, text: `Goal accepted as complete (${note}). Tell the user what was achieved.`}
        : {ok: false, text: `Not accepted — ${note}: the evidence in context doesn't show the goal is fully achieved. Keep working; produce concrete proof (run the tests/checks, show the output), then call goal_done again.`};
    },
  };
}
