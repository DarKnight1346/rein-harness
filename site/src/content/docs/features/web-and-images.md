---
title: Web & images
description: Web search on any model via the provider's native search, a safe local web_fetch, Codex image generation for every model, and how images and PDFs reach the agent.
---

Your Claude session can search the web with Codex's live search, or draw a logo with Codex's image generator, without switching models. Rein runs these capabilities as tools on whichever signed-in model has them, then hands the result back to the model you're chatting with.

```text title="rein"
⏺ WebSearch(vite 7 release breaking changes 2026)
  Web search: "vite 7 release breaking changes 2026" (via Haiku, 6.2s)
⏺ WebFetch(https://vite.dev/guide/migration · what changed in the config API?)
⏺ ImageGen(flat vector logo, a rein forming the letter R, teal on white → assets/logo.png) · you approved
  Generated 1 image in 23s via <cheapest Codex model>:
  ~/code/app/assets/logo.png (1024×1024)
```

## web_search

`web_search` makes one call to your **Web** model (`/model` → **Web**, saved as `webModel`, default `cheapest`) with that provider's **server-side search** switched on for that call only:

- a Claude web model runs with `--tools WebSearch` and nothing else;
- a Codex web model runs a thread with `web_search: "live"`.

Any chat model can therefore search, and you choose who pays for it. If the configured model has no healthy account, Rein falls back to the cheapest available model.

The search worker replies in a fixed shape: a short direct answer with specifics (versions, dates, numbers), then `Results:` with up to 8 links as `- [Title](URL) — summary`. The chat model is reminded to end its reply with a **Sources:** list. The tool also tells the model today's date, so queries about recent releases include the year.

`allowed_domains` and `blocked_domains` are passed to the search model as instructions ("Only use results from: …"). They steer the search but aren't enforced as a hard filter. Searches time out after 3 minutes.

## web_fetch

`web_fetch` fetches pages **locally**, from your machine, and converts HTML to markdown (scripts, styles, iframes, SVG and `<head>` removed). Then it does one of two things:

- **Without `prompt`:** returns the markdown 40,000 characters at a time. The model continues with `offset`.
- **With `prompt`:** your Web model reads up to 120,000 characters of the page and answers only that question. A 300 KB docs page costs the chat model a paragraph instead of its context window.

```text title="rein"
https://vite.dev/guide/migration · HTTP 200 · text/html · 48,211 chars
```

### Safety limits

| Limit | Behavior |
|---|---|
| Scheme | `http://` is upgraded to `https://`; other schemes are refused. |
| Credentials | URLs with `user:pass@` are refused. |
| Private hosts | Refused (see below). The model is told to use `shell` + `curl` for local servers, which goes through normal approval. |
| Redirects | Same-host redirects are followed (up to 10). A redirect to a **different host** isn't followed: the model gets `REDIRECT DETECTED` with the new URL and must fetch it explicitly. |
| Timeout | 30 seconds. |
| Size | Bodies are read up to 10 MB; anything beyond is cut off, not failed. |
| Content types | HTML, text, JSON, XML, JavaScript, markdown, YAML and CSV. Binary types (images, PDFs, archives) are refused. |
| Errors | HTTP 400+ returns a failed result with the first 2000 characters of the body. |

**Private hosts** are refused by looking at the hostname as written: `localhost`, `*.localhost`, `*.local`, `*.internal`, single-label names with no dot (`intranet`), and literal IPs in loopback, private, link-local and carrier-grade NAT ranges (`127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`, `100.64.0.0/10`, `0.0.0.0/8`, `::1`, `fc00::/7`, `fe80::/10`, `::ffff:127.*`).

:::note
The check doesn't resolve DNS, so a public hostname that resolves to a private address isn't caught by this list. Cross-host redirects always stop and report, which keeps a public page from bouncing the fetch to an internal one.
:::

### Caching

Fetched pages are cached **in memory for 15 minutes**, up to 100 pages, keyed by URL. Paging through a long document with `offset`, or asking several `prompt`s about one page, fetches it once.

### Permissions

`web_search` and `web_fetch` are read-only tools: they never prompt, in any mode. To keep the agent off a site, add a deny rule such as `web_fetch(domain:example.com)`, which also covers subdomains. See [Permissions](../permissions/#saved-rules).

## image_generate

`image_generate` gives every chat model, **Claude included**, Codex's image generation. Rein opens one ephemeral Codex thread with only image generation switched on, sends your description and any reference images, and saves the result as a PNG.

```text title="rein"
› make a 16:9 hero image for the landing page, isometric, our teal brand color

⏺ ImageGen(isometric hero illustration, 16:9 landscape, teal #0f766e… → public/hero.png) · you approved
  Generated 1 image in 31s via <cheapest Codex model>:
  ~/code/site/public/hero.png (1536×1024)
  Revised prompt: An isometric illustration of …
```

- **Where it saves:** pass `path` (project-relative or absolute) and the file lands there, with the extension forced to `.png`. Omit it and the image goes to the session scratchpad as `images/<timestamp>-<slug>.png`. Extra images in one response get `-2`, `-3` suffixes.
- **Reference images:** `reference_images` takes PNG, JPEG, GIF or WebP files to edit, restyle or use as references ("make this icon flat", "same character, different pose").
- **Which account:** the cheapest Codex model with a healthy account. If an account replies without an image (its plan doesn't include image generation), Rein remembers that for the run and tries the next one. Hitting the image limit gives a clear error with the reset time.
- **Availability:** the tool is hidden from models entirely unless a Codex account is signed in.
- **Time:** about 15–60 seconds. The model gets the saved path and size back. It can't see the pixels, so it tells you where the file is.

**Approvals:** saving to the scratchpad never asks. Saving into your project is a file change, like `write`, and follows your approval mode and `edit(...)` rules. Reference images or a target outside your working directories trigger the outside-path prompt.

:::caution
`image_generate` writes straight to `path` and overwrites an existing file there without the read-first check that `write` and `edit` enforce. [/rewind](../rewind/) can still restore it, because the file is checkpointed before the tool runs.
:::

## Reading images and PDFs

The `read` tool understands media:

- **Images** (PNG, JPEG, GIF, WebP) go to the model **as real images**: MCP image content for Claude, an input image for Codex. Images over 3.75 MB are re-encoded as JPEG at up to 2000 px, with `sips` on macOS or ImageMagick (`magick`) elsewhere. If neither is available, the read fails with a clear message.
- **PDFs** come back as text, page by page (`--- page 3 ---`), 20 pages per read by default. Use `pages: "21-40"` for more. Pages with no text layer say so (`it may be a scanned image`).

```text title="rein"
⏺ Read(docs/spec.pdf)
  PDF docs/spec.pdf: 64 pages, showing 1–20
```

MCP tools that return images pass them through to the model too.

## Attaching images and files

You can put things in front of the model directly from the prompt:

| How | Becomes |
|---|---|
| **Ctrl+V** with an image on the clipboard | `[Image #1]`. Uses `osascript` on macOS, PowerShell on Windows, `wl-paste` or `xclip` on Linux. |
| **Drag a file** onto the terminal (it pastes the path) | `[Image #2]` for images; `[File #3: notes.md]` for anything else |
| `@path` in your message | The file's text, the image itself, or a folder listing, with autocomplete over your project's files |
| A long paste (more than 3 lines or 800 characters) | `[Pasted text #4 +42 lines]`, expanded when you send |

Backspace removes a placeholder whole. Dropped text files up to 256 KB are inlined into the message as a `<file>` block; larger or binary files are noted instead of included. Pasted and dropped images are copied into the session scratchpad (so moving the original later doesn't matter), and on macOS anything over 3.5 MB is downscaled with `sips` first.

Attachments are your own action, so they don't go through the permission prompts that the agent's tools do. When you're viewing a subagent, only the text is sent. Images are dropped, with the notice `Images can only be sent to the main agent; the subagent gets the text.`

## Related

- [Tools](../tools/): the full tool set
- [Routing](../routing/): picking the Web model and other utility models
- [Accounts](../accounts/): adding a Codex account for image generation
- [Permissions](../permissions/)
- [Tools reference](../../reference/tools/)
