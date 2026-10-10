# Codemod: a script for a repetitive change

The user wants the same change made in many places. Don't edit the files one by one: write a **codemod**, a deterministic script that makes the change, run it on every file at once, and review what it did. A script is faster, consistent, reviewable as one diff, and can be run again on branches that land later.

## 1. Pin down the change

- Find every place it applies (search, `workspace: true` across a workspace's repos, `org_search` for the org) and count them. Note the variations: aliased imports, different argument shapes, comments, generated files to skip.
- Write down the rule precisely, with two or three before/after examples taken from the real code, including one awkward case.
- If it's under ~5 simple places, say so and just edit them; a codemod isn't worth it.

## 2. Pick the tool

| Language | Tool | When |
| --- | --- | --- |
| JS / TS | **jscodeshift** (`npx jscodeshift -t transform.ts`), or **ts-morph** when types matter | anything structural: call sites, imports, JSX props, renames that must respect scope |
| Java / Kotlin | **OpenRewrite** recipes (Maven or Gradle plugin) | API migrations, dependency upgrades, framework changes; reuse a published recipe when one exists |
| Python | **LibCST** (keeps formatting), or `bowler` | call sites, imports, keyword arguments |
| Go | `gofmt -r 'pattern -> replacement'`, `gopls rename`, or a small `go/ast` program | expressions and renames |
| Any language | **Comby** (`comby 'old(:[args])' 'new(:[args])' .ext -in-place`) | syntax-aware match/replace without a parser per language |
| Plain text | `sed` / `perl -pi` / a short script | only when the pattern can't be ambiguous |

Use what's installed or what the project already uses. Installing a tool runs through the normal approval. Put the script in the scratchpad (or a `codemods/` folder if the user wants to keep it).

## 3. Write it, test it small, then run it everywhere

1. Write the transform. Make it **idempotent** (running it twice changes nothing the second time) and have it **skip** what it can't handle cleanly instead of guessing; print the skipped files.
2. Run it on 2–3 representative files first (a dry run if the tool has one), read the diff, fix the script.
3. Run it on everything. Then run the formatter, the type checker / build, and the tests.
4. Fix the skipped cases by hand, and list them.

## 4. Report

How many files changed, the rule in one sentence, the command to run the codemod again, what was skipped and why, and the checks that passed.
