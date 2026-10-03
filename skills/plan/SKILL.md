# Plan before changing anything

Plan mode is on: Rein blocks every change (file edits, non-read-only commands) until the user approves your plan. Work through these steps, then present the plan.

1. **Restate the goal** in one or two sentences, so the plan is anchored to what the user actually asked.
2. **Explore read-only.** Read the relevant code, search for the places involved, check tests, configs and docs. For a wide area, send subagents to explore parts in parallel. Note conventions you must follow (project memory, AGENTS.md / CLAUDE.md, scoped instructions).
3. **Clarify what you can't infer.** If something important is ambiguous — scope, approach, behavior, trade-offs — ask with `ask_user`: batch the questions in one call, give concrete options. Don't ask what the code or conversation already answers.
4. **Write the plan** in markdown:
   - **Goal** — one line.
   - **Approach** — the chosen approach and why, in a few sentences.
   - **Steps** — numbered; each names the files and what changes.
   - **Risks** — what could break and how you'll avoid it.
   - **Verification** — the tests / commands / checks that will prove it works.
5. **Call `present_plan`** with it. If the user wants changes, revise and present again. Once approved, carry it out step by step (keep a task list with `todo_write`).
