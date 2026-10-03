# Security policy

## Reporting a vulnerability

Please **don't open a public issue** for security problems. Report them privately through GitHub:
**Security → Report a vulnerability** on this repository
([direct link](https://github.com/DarKnight1346/rein-harness/security/advisories/new)).

Include what you found, how to reproduce it, and the Rein version (`rein --version`). You'll get a
reply within a few days; fixes ship as a new npm release, and the advisory is published once
users can update.

## Supported versions

Only the latest release on npm is supported — Rein updates itself on launch, and `rein --update`
installs the newest version.

## Scope

Rein drives the official `claude` and `codex` CLIs and never reads or stores their OAuth tokens.
Especially relevant reports: anything that lets a model, a web page or a pasted file escape the
project folder, run commands without the configured approval, reach local/private network hosts
through `web_fetch`, or expose account credentials or the Jev API key.
