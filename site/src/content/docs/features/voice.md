---
title: Voice input
description: Talk instead of typing. Speech is turned into text on your machine with whisper.cpp; nothing is uploaded.
---

**Hold Ctrl+Space**, say what you want, and **let go**. Rein turns your speech into text **on your machine** with [whisper.cpp](https://github.com/ggml-org/whisper.cpp) and adds it to the input. It's never sent on its own: read it, fix it, press Enter.

While you hold it, the footer shows `● Recording… let go of Ctrl+Space to stop · Ctrl+C cancels`, then `Transcribing…`. A quick **tap** of Ctrl+Space starts a hands-free recording instead (`press Ctrl+Space to stop`); tap again to finish. Recordings stop on their own after 2 minutes. Nothing is uploaded, and the recording is deleted once it's transcribed.

## How "let go" is detected

| Terminal | How Rein knows you let go |
|---|---|
| kitty, WezTerm, Ghostty, foot, recent iTerm2 (the [kitty keyboard protocol](https://sw.kovidgoyal.net/kitty/keyboard-protocol/)) | The terminal reports the key release itself |
| Terminal.app, VS Code, most others | While a key is held, the system repeats it; the recording stops a quarter-second after the repeats stop. The first repeat comes after your key-repeat delay, so a hold shorter than that counts as a tap |

With key repeat turned off (System Settings → Keyboard), every press is a tap: tap to start, tap to stop.

:::caution[If Ctrl+Space does nothing]
Something before Rein took the key. On macOS, **Ctrl+Space switches input sources** when that shortcut is on (System Settings → Keyboard → Keyboard Shortcuts → Input Sources): turn it off, or use `/voice`. Some editors' terminals bind it too (for suggestions); unbind it there, or use `/voice`.
:::

## Setting it up

Voice needs three things: a recorder, whisper.cpp, and a speech model. `/voice` shows what's there; `/voice setup` gets the rest.

| | macOS | Linux | Windows |
|---|---|---|---|
| Recorder | `sox` (its `rec`), or `ffmpeg` | `sox`, `ffmpeg` or `arecord` | `sox` |
| whisper.cpp | `whisper-cli` | `whisper-cli` | `whisper-cli` |
| `/voice setup` | Runs `brew install whisper-cpp sox` for what's missing, then downloads the model | Says what to install (your package manager, or the whisper.cpp repo), then downloads the model | Same as Linux |

The model is a one-time download of about 60 MB from whisper.cpp's model repository on Hugging Face, into `voice/` in Rein's [data folder](../../reference/files/). It goes through your [proxy](../../start/install/#behind-a-corporate-proxy) if you have one set.

:::note[macOS microphone permission]
The first recording makes macOS ask whether your terminal app (Terminal, iTerm, VS Code…) may use the microphone. If you said no, recordings come back empty: allow it in System Settings → Privacy & Security → Microphone.
:::

## Languages and accuracy

The default model, `base.en-q5_1`, is English-only and fast. On an older Intel Mac, 11 seconds of speech takes about 4 seconds to transcribe. For other languages, set `voiceModel` to a multilingual model in `config.json` and run `/voice setup` again to download it:

```json title="~/.rein/config.json"
{"voiceModel": "base-q5_1"}
```

Any model name from the whisper.cpp repository works (`small.en-q5_1`, `small-q5_1`, `medium-q5_0`…): bigger is more accurate and slower. Multilingual models detect the language on their own.

## Without the key

`/voice` starts a recording too, once voice is set up, and `/voice` again stops it. The text goes into the input the same way.

## Related

- [Keyboard shortcuts](../../reference/keys/)
- [Commands](../../reference/commands/): `/voice`
