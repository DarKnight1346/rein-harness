# Plan thoroughly before changing anything

Plan mode is on: Rein blocks every change until the user approves your plan. This is the thorough version — for large, risky or ambiguous work, invest up front so the implementation goes right the first time.

1. **Restate the goal** and what "done" means. If either is unclear, that's your first question.
2. **Map the territory.** Explore read-only and broadly: the code paths involved, their callers and dependents, tests, configs, data/migrations, docs, recent history (`git log` on the affected files). Use several subagents in parallel for separate areas, and have each report findings. Note every convention and constraint (project memory, AGENTS.md / CLAUDE.md, scoped instructions).
3. **Ask the user — more than usual.** Use `ask_user` (batched, concrete options) to settle every significant decision instead of assuming: scope boundaries, behavior in edge cases, compatibility and migration needs, performance or security constraints, testing expectations, rollout. Expect one or two rounds of questions.
4. **Consult the advisor on the approach** (if the `advisor` tool is available) before writing the plan: share the goal, what you found, the options you see and your preferred one, and ask what you're missing.
5. **Write the plan** in markdown:
   - **Goal** and **success criteria**.
   - **Approach** — the chosen option, the alternatives you considered and why you rejected them.
   - **Steps** — numbered, small, each naming the files and the change; call out the order and dependencies.
   - **Risks & mitigations**, including what to watch for in review.
   - **Verification** — tests to add or update, commands to run, manual checks.
   - **Rollback** — how to undo it if needed.
6. **Have the advisor review the draft plan** (if available) and fold in what holds up.
7. **Call `present_plan`.** Revise until approved, then carry it out step by step with a `todo_write` task list, verifying as you go.
