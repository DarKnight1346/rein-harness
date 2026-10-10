---
title: Pets
description: Your animated companion from the ChatGPT and Codex apps, in Rein's sidebar, reacting to what the agent does.
---

The animated pet you picked in ChatGPT or the Codex app comes along to Rein. It sits at the bottom of the sidebar (fullscreen) and reacts to the agent the way it does there:

| The agent | The pet |
|---|---|
| is idle | idles |
| works on your message | works (its *running* animation) |
| waits for an approval, an answer or a plan decision | waits |
| ends a turn | reviews the work, then settles back |
| hits an error | looks dismayed, then settles back |
| starts up | waves |

Each frame is drawn with half-block characters (two pixels per character, in colour), so it works in any terminal, including macOS Terminal, without image support.

## Your own pets

Rein keeps pets of its own, on this machine, with no account needed. A pet is a sprite sheet in the ChatGPT pets layout: a PNG of 1536×1872 (nine rows of animations) or 1536×2288 (plus two rows of look directions), in 192×208 cells.

- `/pet add <sheet.png> [name]` adds one and shows it.
- **The create-pet skill's pets are picked up by themselves.** When `/work-pets:create-pet` finishes a sheet (its `Pets/<Name>/final/spritesheet-extended.png` in the conversation's scratchpad), Rein adds it as one of your pets at the end of that turn, named from the skill's `pet_request.json`, and shows it. No upload is needed.

They're kept in `~/.rein/pets/mine/`. Your own pets only show in Rein; to have one in the ChatGPT and Codex apps too, upload it there.

## Pets from your ChatGPT account

Pets live in your **ChatGPT account**, so they come through a **Codex account** signed in to Rein (`/login`). Rein starts the official `codex app-server` with apps on, and calls the Pets app's tools there (`list_pets`, `get_pet_download_link`, `select_pet`…). Codex holds the sign-in, and Rein never sees your tokens. No model is called. The pet's sprite sheet is downloaded once and kept in `~/.rein/pets/`.

With only Claude accounts you have your own pets only. Built-in pets come as WebP: Rein converts them with whatever this machine has (`sips` on macOS, otherwise libwebp's `dwebp`, ImageMagick or ffmpeg). With none of those, `/pet` says so and the sidebar stays as it is.

## `/pet`

| Command | What it does |
|---|---|
| `/pet` | Lists your own pets, then your ChatGPT account's (built-in and custom), the one showing marked `●` |
| `/pet <name>` | Picks a pet (by name or id; the start of a name is enough). Picking a ChatGPT pet changes it in the ChatGPT and Codex apps too |
| `/pet add <sheet> [name]` | Adds a sprite sheet as one of your pets and shows it |
| `/pet off` | No pet in Rein (the apps keep theirs) |
| `/pet refresh` | Reads your pet again, after you changed it in another app |

To keep your pet out of Rein only, set **Pet** to **Off** in `/settings` → **General** (`"pet": "off"`).

## The pets skills

Codex's **Pets** plugin adds skills to create, update and manage pets (`/work-pets:create-pet`, `/work-pets:pets`, `/work-pets:update-pet`). Rein loads them like any plugin skill, and with that plugin installed it also gives the agent the Pets app's tools, as `pets_list_pets`, `pets_select_pet`, `pets_create_pet` and the rest, whatever model you chat with. Tools that only read run straight away. The ones that change your pets go through [approval](../permissions/), and deleting a pet always asks.

:::note
Creating a pet from scratch also needs image generation (Rein's `image_generate`, with a Codex account) and ChatGPT's Library, which only the ChatGPT app has. Picking, renaming, updating and deleting pets work fully in Rein.
:::

## Related

- [The terminal UI](../tui/)
- [Accounts](../accounts/)
- [Skills](../skills/)
