---
title: Decision model
description: How Rein hands small, well-defined judgments (routing, effort, approvals, completion and goal checks) to Jev or a cheap signed-in model, with fixed thresholds and without ever sending the transcript.
---

Rein makes a lot of small calls about how to work: which model gets this message, whether a file change matches what you asked for, whether a subagent really finished, whether "goal done" is backed by evidence. None of these need your flagship model. Rein asks them as **typed questions** to a decision model, gets back a probability or a choice with a confidence, and compares it to a threshold **in code**.

The decision model is either **Jev** (typesafe.ai's SystemOne API, around 120 ms per call) or the **cheapest signed-in model** running a strict JSON prompt (around 1 to 1.5 s). The code lives in `src/decider/`; the call sites are spread across `src/router/auto.ts`, `src/runtime.ts`, `src/goals/manager.ts` and `src/decider/tool.ts`.

## Two backends, one interface

Both backends implement the same interface (`src/decider/types.ts`):

```ts
interface DeciderBackend {
  name: string;
  ask(state: Entry, questions: Questions): Promise<Decision>;
}
```

`state` is a small JSON object describing the situation. `questions` is a map of named questions in Jev's schema:

| Type | Asks | Answer |
| --- | --- | --- |
| `noul` | A yes/no question with optional `criteria: {true, false}` | `{noul: p}`, the probability of yes |
| `choice` | Pick one label from `criteria: {label: description}` | `{choice, confidence, probabilities?}` |
| `score` | A position on a scale, `criteria: [lowest, …, highest]` | `{score, confidence}` |

### Jev

`src/decider/jev.ts` posts `{state, questions, model}` to `POST https://api.typesafe.ai/v1/systemone` with your key as a Bearer token (`TYPESAFE_BASE_URL` overrides the host). The model id is **pinned** (`jevModel`, default `jev-1.13.0`) so the thresholds below stay calibrated when Jev ships a new version. Each request has an 8 s timeout and up to 3 attempts, backing off 400 ms × 2ⁿ on 408, 429, 5xx and 529.

In PLAN.md's live measurements, Jev answered routing choices in ~120–130 ms with ~360 input tokens. Examples: "2+2" went to Haiku with confidence 1.0, a lock-free queue design went to Opus at 0.96, and a file rename was approved at 0.96.

### The LLM backend

Without a Jev key, `src/decider/llm.ts` renders the same questions into a strict prompt for the cheapest healthy model (or the model you picked under `/model` → Decision model):

```text
STATE:
{"new_message":"what does the -z flag do in grep?"}

QUESTIONS:
- model (pick exactly one label): Which model should answer the new message? …
    claude:haiku: Haiku: … Cost: very low.
    claude:opus: Opus: … Cost: highest.

Reply with: {"model": {"choice": "<label>", "confidence": <0..1>}}
```

The system prompt is `You are a strict decision function. You never chat.` Calls run with `fast: true`: `MAX_THINKING_TOKENS=0` on Claude (PLAN.md measured this cutting a Haiku decision from ~4 s to ~1 s of API time) and `effort: low` on Codex. Timeout is 45 s. `parseAnswers()` validates every answer against the schema: probabilities clamped to 0–1, choices must be one of the labels, scores in range. An invalid reply gets one retry with "Your previous reply was invalid."

### Fallback

`decide()` in `src/decider/index.ts` ties it together. With `decisionModel: "jev"` and a key, it tries Jev first. **Any** Jev failure (unreachable, 401, bad response) falls back to the LLM backend, and the backend label records it, e.g. `haiku (strict prompt) (Jev failed: Jev unreachable: …)`. Routing never blocks on Jev. With `jev` selected but no key, Rein behaves as `cheapest`.

## It never sees the transcript

Every call site builds a **minimal state**. That keeps calls cheap, fast and calibrated: the same kind of question always gets the same kind of input. Long text goes through `headTail()` (`src/router/auto.ts`): the first 3,600 and last 2,400 characters, so ~1.5k tokens at most.

| Call site | State it sends |
| --- | --- |
| Auto routing | `new_message` (head+tail); mid-conversation also `current_model`, `current_task` (an 80-char tag of the message that started the task), `turn` |
| Auto effort | `user_message` (head+tail) |
| Auto approvals | `user_request` (your latest message, head+tail), `action` (tool + summary), `change_preview` (≤1,500 chars) |
| Plan-mode shell check | `shell_command` (≤2,000 chars) |
| Subagent completion | `task`, `final_report` (head+tail each), the last 40 tool-call labels |
| Keep going (experiment `keep-going`) | `request`, `final_reply` (head+tail each) |
| `goal_done` | `goal`, `agent_summary` (≤2,000), `agent_evidence` (≤3,000), `tool_results_since_goal_started` (last 30, ≤400 chars each), `last_message` (≤1,500) |
| `milestone_done` | `goal`, `milestone`, `agent_evidence`, the same tool-result evidence |
| Gave-up check | `goal`, `latest_agent_message` (≤3,000) |
| `decide` tool | Only the `context` the agent pastes (≤60,000 chars) |

## Every place it's used

| Where | Question | Threshold | Below the threshold |
| --- | --- | --- | --- |
| **Auto routing** (`router/auto.ts`) | `model` choice: "Pick the cheapest model that will answer it well" | confidence ≥ `autoMinConfidence` (0.45) | Your default model answers |
| **Auto routing**, mid-conversation | `switch` noul: does this start a materially different kind of task? | switch only if p ≥ `autoSwitchThreshold` (0.7) | Stay on the current model (`auto · stayed`) |
| **Auto effort** (`Runtime.pickEffort`) | `effort` choice: lowest level that will do it well | none (any valid choice) | Model default if the call fails; not asked for messages over ~2,000 characters (500 estimated tokens) |
| **Auto approvals** (`Runtime.judgeChange`) | `allow` noul: clearly requested and safe? | p ≥ 0.85 (`AUTO_APPROVE_MIN`) | You're asked. Never auto-denies. |
| **Plan mode** (`Runtime.judgeReadOnly`) | `read_only` noul: does this command only read? | p ≥ 0.85 (`READ_ONLY_MIN`) | You're asked (Allow/Deny), or it's refused in bypass mode |
| **Subagent completion** (`Runtime.judgeCompletion`) | `complete` noul: fully done, with a final report? | p ≥ 0.5 | Told to continue, up to 3 extra rounds (`MAX_CONTINUATIONS`) |
| **Keep going** (`Runtime.stoppedEarly`, experiment `keep-going`) | `unfinished` noul: stopped partway by its own account, not needing the user? | p ≥ 0.5 | Sent back to finish, up to 3 times per request (`KEEP_GOING_MAX`); not sent back if the call fails |
| **`goal_done`** (`GoalManager.reviewClaim`) | `achieved` noul: does the evidence in context show the goal fully achieved? | p ≥ 0.7 (`ACCEPT_AT`) | Rejected; the agent keeps working |
| **`milestone_done`** (`GoalManager.reviewMilestone`) | `achieved` noul for one milestone | p ≥ 0.7 | Not ticked |
| **Gave-up detection** (`GoalManager.next`) | `gave_up` noul: does the latest message declare the goal impossible or blocked? | p ≥ 0.6 (`GAVE_UP_AT`) | Plain continuation |
| **`decide` tool** (`decider/tool.ts`) | The agent's own questions | none: raw probabilities returned | — |

A few details that make these work well.

**Routing is one call with at most two questions.** Candidates are filtered in code first: only models with a healthy account. One candidate means no call at all. The first message asks only `model`; later messages also ask `switch`. Option order is **shuffled every call** (Fisher–Yates) to counter first-option bias. Each candidate's description is fixed: the CLI's own model description plus a cost word derived from its tier ("very low" … "highest"). Stable text keeps the decider calibrated. See [Models & routing](../../features/routing/).

**Effort is asked only when the cache is cold.** Changing effort invalidates the prompt cache, so `Engine.effortFor()` keeps a warm session's effort and asks only when the cache has expired anyway. Auto never offers `max` or `ultra`, the levels the CLIs flag as excessive.

**Approvals never auto-deny.** A doubtful verdict, or a judge that throws, goes to you. The verdict shows on the tool line, e.g. `⏺ Edit(src/x.ts) · auto-approved (0.91 via jev)`. Outside the project, auto mode only judges non-sensitive **reads**; writes outside the working directories always ask. See [Permissions](../../features/permissions/).

**Goals are evidence-checked.** `goal_done` is rejected outright while plan milestones are open. Otherwise the decision model looks at what tools actually returned since the goal started, not the agent's claim. "Impossible" counts as not achieved. When the gave-up check fires, Rein asks the advisor (if one is configured) or spawns a `goal-unblocker` subagent, and sends its answer back as a `<goal_escalation>` message. See [Goals](../../features/goals/).

**Subagent checks fail open.** If the completion check itself fails, the work is accepted (`check failed (…); accepting`) rather than looping.

## The `decide` tool

The agent can use the decision model too. `decide` takes `context` plus up to 25 questions of type `yes_no`, `choice` or `score`, maps them onto Jev's schema, and returns one line per answer:

```text
triage: yes (p(yes) = 0.92)
area: parser (confidence 0.81)
severity: 2.40 on 0–3 ≈ "high" (confidence 0.66)
(via jev)
```

It's for classification, triage and quick checks over text the agent already has. Spending flagship reasoning on those is waste. See [Tools reference](../../reference/tools/).

## Where to tune it

| Setting | Effect |
| --- | --- |
| `/model` → Decision model (`decisionModel`) | `jev`, `cheapest` (default) or a specific model |
| `jevModel` | Pinned Jev version (file only) |
| `autoSwitchThreshold`, `autoMinConfidence` | Routing thresholds (file only) |
| `/settings` → Approvals (`toolApproval: "auto"`) | Turns on auto approvals |

The other thresholds (0.85, 0.5, 0.7, 0.6) are constants in the files named above. If you have routing data that says one is off, a PR that changes it with the reasoning is welcome.

## Related

- [Models & routing](../../features/routing/)
- [Configuration](../../reference/configuration/)
- [Context & compaction](../context/): the compaction model, the other utility role
- [Architecture](../architecture/)
