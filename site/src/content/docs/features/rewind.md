---
title: Rewind
description: Undo a turn — roll your files, your conversation, or both back to before any message you sent, including changes made by shell commands.
---

Let the agent try something bold. If it goes sideways, press **Esc twice** and put everything back the way it was before that message — the files it edited, the files a `sed` or codemod rewrote, the files it created, and the conversation itself.

## Quick example

The agent ran a formatter across the repo and you don't like the result. Press Esc twice at an empty prompt (or type `/rewind`) and pick the message that started it:

```text title="Rewind"
❯ 4m ago   3 files  run prettier on the whole repo and fix the lint errors
  12m ago  1 file   rename UserCard to ProfileCard
  31m ago           what does the auth middleware do?

enter choose · ↑↓ select · esc close — files: changed since that message
```

Then choose what to restore:

```text title="Rewind"
Rewind to before: run prettier on the whole repo and fix the lint errors
Restores every file changed since — including changes made by shell commands (files ignored by .gitignore are left alone).

❯ Restore code and conversation — files back to before this message; the conversation ends just before it
  Restore conversation only — files stay as they are now
  Restore code only — the conversation stays; files go back to before this message

enter choose · esc back
```

```text title="rein"
Rewound 214 files.
Conversation rewound — your message is back in the input.
```

Your original message is waiting in the input box, ready to edit and resend.

## Opening it

| How | When it works |
| --- | --- |
| **Esc Esc** (two presses within 600 ms) | The agent is idle, the input is empty, and no window is open |
| `/rewind` | The agent is idle. If it's working you'll see `The agent is working — press esc to stop it first, then /rewind.` |

The picker lists your messages newest first, with how long ago you sent each one. The **N files** column counts the files Rein's own file tools changed since that message. If there's nothing to go back to yet, it says `Nothing to rewind yet.`

## The three restore modes

| Mode | Files | Conversation |
| --- | --- | --- |
| **Restore code and conversation** | Back to how they were before the message | Ends just before the message; the message returns to your input |
| **Restore conversation only** | Left as they are now | Ends just before the message; the message returns to your input |
| **Restore code only** | Back to how they were before the message | Unchanged — keep talking with the agent about what happened |

If no files changed since a message and there's no project snapshot for it, only **Restore conversation only** is offered.

## How files come back

Rein keeps two complementary records, and a rewind uses both.

### Whole-project snapshots

Before each message you send runs, Rein records the entire working tree in a **private git store** at `~/.rein/checkpoints/<session>/tree.git`. That buys a lot:

- **Shell changes are covered.** Formatters, codemods, `sed -i`, code generators, `rm` — anything that changed files in the project, whether or not it went through Rein's `edit` tool.
- **`.gitignore` is respected.** `node_modules`, build output and other ignored files aren't tracked, so snapshots stay small and fast.
- **Byte-exact.** The store overrides your `.gitattributes` with `* -text -filter -diff -merge` and disables line-ending conversion, so CRLF files, LFS pointers and binaries come back exactly as they were.
- **Your `.git` is never touched.** The store has its own git directory and index. Your repository, branches, staging area and history are untouched, and the project's `.git` folder is excluded from snapshots. Git hooks are disabled for every snapshot command.
- **Works without a repo.** The project doesn't need to be a git repository — only the `git` binary has to be installed.

Restoring compares the snapshot with the tree as it is now and rewrites **only the files that differ**: changed or deleted files are put back, and files created since the message are removed.

### Per-file checkpoints

Before `edit`, `write`, `delete` or `image_generate` changes a file, Rein saves that file's previous state once per turn — or notes that it didn't exist yet. Contents are stored as content-addressed blobs (`~/.rein/checkpoints/<session>/blobs/<sha256>`) indexed by `index.jsonl`.

These checkpoints catch what the project snapshot can't:

- Files ignored by `.gitignore` that the agent edited.
- Files outside the project directory (an `--add-dir` folder, for example).
- Everything, if the project snapshot isn't available.

On a code rewind Rein restores the project snapshot first, then applies per-file checkpoints for anything else, and reports a single count:

```text title="rein"
Rewound 3 files (files created since were removed).
```

## The conversation is never lost

A conversation rewind doesn't delete anything from disk. Sessions are append-only JSONL files in `~/.rein/sessions/`; rewinding appends a `truncate` marker, and loading the session stops at that point. Every earlier line stays in the log.

After the rewind:

- The native Claude Code / Codex sessions no longer match the history, so they're dropped and the next turn starts a fresh session that carries what's left of the conversation (see [how context is carried](../../internals/context/)). Expect that turn to miss the prompt cache.
- A compaction summary that covered messages past the rewind point is discarded.
- The screen is cleared and the remaining conversation is replayed.

## Limits and gotchas

:::caution[What a rewind can't undo]
- **Shell changes outside the project.** Snapshots cover the project directory only. A command that writes to `~/` or another folder isn't recorded.
- **Ignored files changed by shell.** `.gitignore`d files are only restored when Rein's own file tools changed them.
- **Side effects that aren't files.** Commits, pushes, database writes, installed packages and network calls stay done.
:::

- **Per-file size cap: 10 MB.** Larger files aren't saved by the per-file checkpoints; the rewind reports them, e.g. `· 1 too large to restore: assets/video.mp4`. (The project snapshot has no such cap for tracked files.)
- **Big directory deletes.** When the agent deletes a directory with more than 500 files, its files aren't checkpointed one by one — the project snapshot is what brings them back.
- **Snapshots can switch off.** If git isn't installed or a snapshot command fails or takes longer than 30 seconds, project snapshots are turned off for that conversation and only per-file checkpoints remain. The picker tells you which you're getting: messages without a snapshot say `N files changed since by Rein's tools (shell changes weren't snapshotted for this message)`.
- **Main conversation only.** While viewing a subagent, `/rewind` replies `Rewind works on the main conversation (subagents keep no checkpoints)`.
- **Later snapshots are dropped.** After you rewind to a message, the snapshots and checkpoints from that message onward no longer describe the history, so they're discarded. You can't "redo" a rewind.
- **Scratchpad files** aren't checkpointed — they're the agent's own throwaway space.

## Related

- [Plans](../plans/) — explore read-only first, so there's less to undo
- [Permissions](../permissions/) — the approval pipeline that runs before every checkpoint
- [Files Rein writes](../../reference/files/) — where checkpoints and sessions live
- [Keyboard shortcuts](../../reference/keys/)
