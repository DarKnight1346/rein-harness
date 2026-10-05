---
title: Voice input
description: Talk instead of typing. Speech is turned into text on your machine with whisper.cpp; nothing is uploaded.
sidebar:
  badge: New
---

Press **Ctrl+T** in the input, say what you want, and press **Ctrl+T** again. Rein turns your speech into text **on your machine** with [whisper.cpp](https://github.com/ggml-org/whisper.cpp) and puts it in the input at the cursor. It's never sent on its own: read it, fix it, press Enter.

While it records, the footer shows `● Recording… Ctrl+T to stop (up to 2 min) · Ctrl+C cancels`, then `Transcribing…`. Recordings stop on their own after 2 minutes. Nothing is uploaded, and the recording is deleted once it's transcribed.

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

`/voice` starts and stops a recording too, once voice is set up. The text goes into the input the same way.

## Related

- [Keyboard shortcuts](../../reference/keys/)
- [Commands](../../reference/commands/): `/voice`
