# Deep review

Plan mode is on: nothing can change until the user approves a plan. This is the thorough review: several independent reviewers per area, then every finding is checked with the advisor and the user before anything gets planned. **Some findings will be false positives: the user decides what gets fixed, and fixing nothing is a valid outcome.**

## 1. What to review

- If the user named something after `/review:deep` (files, a folder, a PR number, a branch, "everything", extra areas), review that.
- Otherwise review **the current changes**: uncommitted work plus this branch's commits since it left the default branch (`git status`, `git diff`, `git merge-base HEAD <default branch>`, `git diff <base>...HEAD`).
- If there are no changes, review the whole project, and say so.

Collect the files in scope and, for changes, the diff. Note the project's conventions (AGENTS.md / CLAUDE.md, project memory), its license, and how its tests run.

## 2. Send the reviewers: each area, on each provider

For **each area below**, start one reviewer **on each provider the user is signed into** (Claude and Codex), so every area gets independent eyes from different model families. Use `mode: "new"`, `background: true`, a name like `bugs-claude`, and pick from the agent tool's model list **the best model for that area on that provider** (one model per provider per area). If only one provider is available, or the agent tool offers no model choice (the user fixed one in `/model`), run one reviewer per area and say so in the report. Start them all, then collect each with `agent_result {wait: true}`. The user may add or drop areas.

- **Bugs**: logic errors, wrong conditions and off-by-ones, unhandled errors and edge cases (empty, missing, huge, concurrent), races, resource leaks, broken contracts between callers and callees, behaviour that contradicts the docs or the change's intent.
- **Security**: injection (shell, SQL, path, template), unsafe deserialization, secrets in code or logs, missing authorization or validation at trust boundaries, unsafe file and temp-file handling, SSRF, weak crypto, dependency risks visible in the code.
- **Test coverage**: behaviour in scope that no test exercises (from reading the code and tests; running tests may need the user's approval in plan mode, so prefer static analysis), tests that can't fail or assert nothing meaningful, missing edge-case and failure-path tests. Name the exact tests that should exist.
- **Copyright & licensing**: code copied from elsewhere without its notice or under an incompatible license, missing or wrong license headers where the project uses them, vendored files and assets without attribution, dependencies whose license conflicts with the project's, generated or third-party content passed off as original.

Give every reviewer the scope, the conventions and its area's instructions, and require that it:
- reads the actual code before claiming anything, and quotes it; no findings from names or guesses;
- reports each finding as: **title**, area, severity (critical / high / medium / low), confidence (high / medium / low), `file:line`, the evidence, why it's a problem (a concrete failure scenario), a suggested fix, and how to confirm it;
- says plainly when it found nothing in its area.

## 3. Merge and check every finding

1. **Merge** duplicates across reviewers. A finding raised independently by both providers is stronger evidence; note who raised each one.
2. **Check each finding yourself** against the code: does the failure scenario really happen? Mark each one *confirmed*, *unconfirmed* or *false positive*, with one line of evidence.
3. **Consult the advisor** (if the `advisor` tool is available): give it the merged findings with your verdicts and evidence, and ask which verdicts are wrong, which findings are false positives you kept, and which real problems the reviewers missed. Fold in what holds up after re-checking the code.

## 4. The user decides what's real and what gets fixed

Show the findings, most severe first, grouped by verdict (confirmed, then unconfirmed; list the false positives briefly with why), each with title, `file:line`, what goes wrong, who raised it, and the suggested fix. Then ask with `ask_user`:
- which findings to fix (`multi: true`, nothing preselected, "none" offered); split into several questions by area if there are many;
- anything the fixes depend on (behaviour choices, scope, compatibility).

If the user picks none, give a short summary and stop: no plan.

## 5. Plan the fixes, as in /plan:deep

For the chosen findings only:
1. **Map** the affected code paths, callers, tests and docs (subagents in parallel for separate areas).
2. **Consult the advisor on the approach** (if available) before writing the plan.
3. **Write the plan** in markdown: **Goal** (the findings being fixed, by title) and **success criteria**; **Approach**; **Steps** (numbered, each naming files and the change, fix plus the test that proves it); **Risks & mitigations**; **Verification** (tests to add, commands to run, a check per finding that it's gone); **Rollback**.
4. **Milestones**: 3–10 ordered, independently verifiable outcomes (usually one per finding or group of related findings, plus the test suite passing).
5. **Have the advisor review the draft** (if available) and fold in what holds up.
6. **Call `present_plan`** with a short title, the plan and the milestones. Revise until the user saves it. The findings the user didn't pick stay out of the plan; list them under "Not fixed" so they aren't lost.
