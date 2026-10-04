# Contributing to Rein

Thanks for helping build Rein! The full guide, with architecture, testing and good places to
start, is on the docs site: **https://rein-harness.github.io/project/contributing/**

The short version:

```sh
git clone https://github.com/DarKnight1346/rein-harness.git && cd rein-harness
npm install
npm test          # runs against fake claude/codex CLIs: no subscription needed
npm run dev       # run Rein from source
```

1. Branch from `main`. Keep each PR to one coherent change, with tests for behaviour changes.
2. **Update the docs in the same PR.** `site/` is the user manual. [AGENTS.md](AGENTS.md#docs-are-part-of-the-change)
   maps each kind of code change to the pages it touches. Run `node site/scripts/check-docs.mjs`.
3. CI type-checks and tests on Linux, macOS and Windows, and builds the docs. All of it must pass.
4. Every merge to `main` ships to npm as the next patch release.

Security issues: please report them privately, as described in [SECURITY.md](SECURITY.md).
