# Review

Review code for problems and report only what holds up. **Change nothing while reviewing**: you and the reviewers only read (and run read-only checks). Fixes come at the end, and only the ones the user picks.

## 1. What to review

- If the user named something after `/review` (files, a folder, a PR number, a branch, "everything", extra areas to cover), review that.
- Otherwise review **the current changes**: uncommitted work plus this branch's commits since it left the default branch (`git status`, `git diff`, `git merge-base HEAD <default branch>`, `git diff <base>...HEAD`).
- If there are no changes, review the whole project, and say so.

Collect the list of files in scope and, for changes, the diff. Note the project's conventions (AGENTS.md / CLAUDE.md, project memory), its license, and how its tests run.

## 2. Send the reviewers

Start **one subagent per area** **in the background** (`mode: "new"`), then collect each with `agent_result {wait: true}`. For each area, pick from the agent tool's model list **the single best model for that area**, whichever provider it's on. Give each the scope (files, diff or how to produce it), the project's conventions and the instructions for its area below. The user may add or drop areas.

- **Bugs**: logic errors, wrong conditions and off-by-ones, unhandled errors and edge cases (empty, missing, huge, concurrent), races, resource leaks, broken contracts between callers and callees, behaviour that contradicts the docs or the change's intent.
- **Security**: injection (shell, SQL, path, template), unsafe deserialization, secrets in code or logs, missing authorization or validation at trust boundaries, unsafe file and temp-file handling, SSRF, weak crypto, dependency risks visible in the code.
- **Test coverage**: behaviour in scope that no test exercises (read the tests; run the project's coverage command only if it's quick and read-only), tests that can't fail or assert nothing meaningful, missing edge-case and failure-path tests. Name the exact tests that should exist.
- **Copyright & licensing**: code copied from elsewhere without its notice or under an incompatible license, missing or wrong license headers where the project uses them, vendored files and assets without attribution, dependencies whose license conflicts with the project's, generated or third-party content passed off as original.

Every reviewer must:
- read the actual code before claiming anything, and quote it; no findings from names or guesses;
- report each finding as: **title**, area, severity (critical / high / medium / low), confidence (high / medium / low), `file:line`, the evidence, why it's a problem (a concrete failure scenario), a suggested fix, and how to confirm it;
- say plainly when it found nothing in its area.

## 3. Check the findings

Merge duplicates. Then verify each finding yourself against the code: does the failure scenario really happen? Drop what doesn't hold up, and keep the count of what you dropped and why. Mark what you couldn't confirm either way as *unconfirmed* rather than dropping it.

## 4. Report, then fix what the user picks

Report the findings, most severe first: title, `file:line`, what goes wrong, and the suggested fix, grouped by area. End with what was reviewed, which models reviewed it, and how many findings you dropped.

Then ask with `ask_user` (`multi: true`) which findings to fix; offer "none" and never preselect. Fix only those, run the relevant tests, and say what changed. For a deeper pass, with a reviewer per area on each provider and a plan, suggest `/review:deep`.
