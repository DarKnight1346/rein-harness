---
title: FAQ & troubleshooting
description: Fixes for common Rein problems (install errors, mouse and copy, accounts, limits, Windows) and answers about privacy, data and terms.
---

Short answers to the things people run into most. If yours isn't here, open an issue on GitHub. For security problems, follow [Security](../security/#reporting-a-vulnerability) instead.

## Install and launch

### `npm install -g rein-harness` fails with `EACCES`

Your global npm folder is owned by root. Either install with `sudo`, or point npm at a folder you own once and install again:

```sh
npm config set prefix ~/.npm-global
echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> ~/.zshrc   # or ~/.bashrc
npm install -g rein-harness
```

Auto-update hits the same wall. When it does, Rein tells you: `Rein <version> is available, but npm can't write to the global folder. Run sudo npm install -g rein-harness@latest (or turn off auto-update in /settings).`

Rein needs **Node.js 22+**. Check with `node --version`.

### `rein needs an interactive terminal`

You ran `rein` with stdin piped or redirected. For scripts and CI, use headless mode: `rein -p "…"`. See [Headless](../../features/headless/).

## Mouse, scrolling and copying

### Clicks and the wheel do nothing in Terminal.app

Turn on **View → Allow Mouse Reporting** in Terminal.app. Rein's fullscreen UI uses SGR mouse reporting for clicks, wheel scrolling and drag-to-select. Terminals that don't pass mouse events still work from the keyboard: PgUp/PgDn and End to scroll, `/` commands, and Tab plus ↑↓ in menus. Or switch to the classic renderer with `rein --classic` or `/tui classic`.

### How do I select and copy text?

In fullscreen, **drag over the chat history**. The selection highlights, and releasing copies it. You see `Copied N characters`. Rein uses `pbcopy` on macOS, `clip` on Windows, and `wl-copy`, `xclip` or `xsel` on Linux. It also sends an OSC 52 sequence, so copying works over SSH in terminals that support it. With no clipboard tool you'll see `Copy failed (no clipboard tool)`.

While mouse reporting is on, your terminal's own drag-to-select usually needs a modifier key, and which one depends on the terminal. If you'd rather use native selection and scrollback, run `rein --classic`.

## Accounts

### `No accounts. Use /login.`

Rein found no registered accounts. Run `/login` to add a Claude or Codex account, or install and sign in to the official CLI (`claude`, or `codex login`) and restart Rein. On first run, Rein offers to import existing logins.

In headless mode the same situation prints `no accounts yet — run rein once to import or add one`.

### Codex shows `unsupported auth type: …`

Rein only works with a **ChatGPT login** for Codex. A Codex home signed in any other way (an API key, for example) shows up as unsupported. Rein also strips `CODEX_API_KEY`, `OPENAI_API_KEY` and `CODEX_ACCESS_TOKEN` from Codex's environment on purpose. Re-authenticate the account in `/login` with your ChatGPT account.

Rein checks login state through Codex's app-server (`account/read`), not `codex login status`. That command can claim "Logged in" even when the refresh token is dead.

### `Codex … changed its app-server protocol … Codex is switched off`

Your `codex` CLI was updated to a version whose app-server protocol is missing something Rein relies on (the message lists what). Rein switched Codex off so chats don't break; Claude keeps working and handles everything. Either update Rein (`/update` or `rein --update`; a fixed release usually follows quickly), or go back to the Codex line Rein verified:

```sh
npm install -g @openai/codex@0.160
```

Rein checks each Codex version once and remembers the result in `~/.rein/state/codex-compat.json`.

### Can I add the same account twice?

No. Rein rejects a second account with the same email.

## Limits

### What happens when an account hits its limit?

Rein moves the turn to another healthy account for the same model and tells you:

```text title="rein"
Claude Account 1 hit its limit (resets 3:45 PM) — retrying
(partial reply discarded)
```

The account cools down until its reset time (15 minutes if no reset time could be read). If no account offers that model, Rein switches to another model: auto mode re-routes, otherwise it picks the closest model in cost tier (`No Sonnet account available — switching to …`). A turn gets up to 5 attempts, then `gave up after several failovers`. When every account for the model is out, you see `Every account for Sonnet is at its limit — earliest reset …`.

Rein usually moves *before* a rejection: an account under 10% headroom hands the conversation to a better one. See [Load balancing](../../internals/load-balancing/).

### Claude usage in `/usage` looks stale

Claude only reports usage alongside a request, and only on a process's first one. `/usage` re-checks a Claude account with a tiny ping on its cheapest model when the numbers are over 10 minutes old. `/usage refresh` forces it. Each account shows `updated … ago`, and a fresh account shows `no usage data yet (appears after the first request)`. Codex usage is free to read and always current.

With more than one Claude account and balanced load balancing, Rein also pings idle Claude accounts in the background at most once an hour, so the balancer has numbers.

## Windows

### Which shell does the agent use?

**Git Bash** when it's installed (as in Claude Code), found through `REIN_GIT_BASH_PATH`, `CLAUDE_CODE_GIT_BASH_PATH`, the standard install folders, or next to `git` on your PATH. Otherwise **PowerShell**. Install [Git for Windows](https://git-scm.com/download/win) for bash syntax. Use Windows Terminal.

## Privacy and data

### What does privacy mode hide?

Privacy mode is on by default (`/settings` → Privacy). Accounts show as `Claude Account 1` and `Codex Account 1` instead of emails. Known emails in any displayed text become those names, your home folder shows as `~`, and your OS username as `user`. It changes the **display only**: saved transcripts and config files are untouched. See [Configuration](../../reference/configuration/).

### Where does Rein keep its data?

In `~/.rein/` (or `$REIN_HOME`): `config.json`, `accounts.json`, the CLI homes of accounts you added in Rein, `sessions/`, `scratch/`, `checkpoints/` and `state/`. A project gets a `.rein/` folder for permission rules, memory, plans and skills. Full layout: [Files & environment](../../reference/files/).

Rein keeps no copy of your credentials. Each CLI stores its own login, in its own home folder or the system keychain. Model traffic goes from the CLIs to Anthropic and OpenAI. If you use Jev, decision requests go to typesafe.ai.

### How do I reset Rein?

1. Remove accounts you added in Rein with `/login` first. Their CLI logins live inside `~/.rein/accounts/`, so deleting the folder also deletes those logins without logging them out.
2. Delete the folder:

   ```sh
   rm -rf ~/.rein
   ```

3. On macOS, a Jev key stays in the Keychain. Remove it with `/login`, or `security delete-generic-password -s rein-jev-api-key -a rein`.

Your own `~/.claude` and `~/.codex` logins are never touched. On the next launch, Rein offers to import them again. To reset only part of Rein, see what's [safe to delete](../../reference/files/).

## Terms of service

### Is this allowed?

Rein drives **your own** subscription accounts through the providers' **official CLIs**, the same `claude` and `codex` binaries you'd run by hand. It doesn't extract OAuth tokens, call private APIs or share access between people. Whether using several accounts of one provider fits that provider's terms is your decision. Check the terms for each subscription you sign in with.

## Related

- [Install](../../start/install/)
- [Accounts](../../features/accounts/)
- [Security](../security/)
- [Files & environment](../../reference/files/)
