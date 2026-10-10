# A guided tour of the code

Write an onboarding tour of what the user named (a service, a folder, a feature), or of the whole repo if they named nothing. A tour is a short, ordered walk through the code a new teammate should read first, each stop a real file and line with a few sentences on what it is and why it matters. It is **not** a summary of every file.

## 1. Understand it first

- Read the README, AGENTS.md / CLAUDE.md, the build and run commands, and the folder layout (`/map` or `list` with depth).
- Find the **entry points** (main, server start, CLI, handlers, the UI root) and follow one real request or job end to end: where it comes in, how it's routed, the core logic, where data is read and written, how it responds.
- Note the **concepts** a newcomer needs (the domain's main types, the layers and what may call what, config and feature flags) and the **gotchas** (generated code, code that looks dead but isn't, the slow test suite, the one place everything goes through).
- In a workspace, how this repo fits with the others. Owners from `/owners` if there are any.

## 2. Pick the stops

8 to 20 stops, in reading order:

1. Where to start: what this is, in two sentences, and how to run it.
2. The entry point.
3. The path of one request (or job), a stop per layer.
4. The core types and the main module where the logic lives.
5. Data: the schema, models or storage layer.
6. Cross-cutting pieces: config, auth, errors, logging.
7. Tests: where they are and how to run one.
8. Where to go next, and who to ask.

Every stop points at a real line (open the file and check the line number; the function or type the stop is about, not the top of the file).

## 3. Write it

- **`.tours/<name>.tour`** ([CodeTour](https://github.com/microsoft/codetour) format, so VS Code can play it step by step):

  ```json
  {"$schema": "https://aka.ms/codetour-schema", "title": "Orders service", "description": "…", "steps": [
    {"file": "src/server.ts", "line": 12, "title": "Where requests come in", "description": "Markdown: what this is and why it matters."},
    {"directory": "src/orders", "description": "…"}
  ]}
  ```

  Paths are relative to the repo root. `description` is markdown; keep each to a short paragraph, and link the next stop's idea to this one.
- **`docs/tours/<name>.md`** (or next to the README if there is no `docs/`): the same stops as a page, each with a `path:line` link, for reading without VS Code.

Then tell the user where both are, how to play the tour (VS Code: CodeTour extension → "Start Tour"), and offer to add a link to it from the README.
