---
title: Remote access
description: Watch a Rein session, send it messages and answer its approvals from your phone or another computer, through a page Rein serves itself.
---

Start something in Rein, walk away, and keep an eye on it from your phone: read the conversation as it happens, send the agent a message, answer an approval, or stop it. The page is served by the Rein you're running, with no hosted service and no account.

```text title="rein"
› /remote
  ⎿ Remote page: http://localhost:7377 · pairing code 482913 (5 minutes, one device)
    It listens on this computer only. From your phone, open it through Tailscale (tailscale serve 7377)
    or a Cloudflare tunnel (cloudflared tunnel --url http://localhost:7377).
```

Open the address, type the code, and you're paired. The page shows:

- **The conversation**, updating live as the agent replies and runs tools.
- **A message box.** What you send goes to the agent as if you'd typed it in Rein, and waits its turn if the agent is busy. Rein marks it `⇢ from the remote page`.
- **Approvals.** When the agent asks to change a file or run a command, the same request appears on the page: **Allow**, **Allow all this session** or **Deny**. Whichever you answer first, in Rein or on the page, wins. [Sensitive locations](../permissions/#sensitive-locations) still only get a one-time yes.
- **Stop**, like Ctrl+C in Rein.

## Commands

| Command | What it does |
|---|---|
| `/remote` or `/remote on` | Starts the page (if it isn't running) and shows a new pairing code |
| `/remote pair` | A new pairing code, to pair another device |
| `/remote status` | The address and how many devices are paired |
| `/remote unpair` | Forgets every paired device |
| `/remote off` | Stops the page |

These can't be run from the page itself: `/exit`, `/vault`, `/remote`, `/login`, `/settings`, `/update`, `/tui`, `/ide`, `/voice`.

## Reaching it from your phone

The page listens on **this computer only** (`127.0.0.1`, port `7377`). Put something private in front of it:

- **Tailscale**: `tailscale serve 7377` gives it an HTTPS address only your devices can reach.
- **Cloudflare Tunnel**: `cloudflared tunnel --url http://localhost:7377` gives it a temporary HTTPS address.

To listen on your network instead, set `"remoteHost": "0.0.0.0"` (and `remotePort` if you like) in `config.json`. Rein warns when it does: anyone who can reach the address can try to pair, and the connection isn't encrypted.

## How pairing protects it

- The pairing code is 6 digits, works **once**, expires after **5 minutes**, and locks after **5 wrong tries** (run `/remote pair` for a new one). Pairing is also rate-limited.
- Pairing gives the device a random 256-bit token. Reads need it as a cookie (`HttpOnly`, `SameSite=Strict`). Anything that changes something (send, approve, stop) also needs it in a header, so another website can't make your browser act on the page.
- Paired devices are remembered until Rein exits or you run `/remote unpair`. They're never written to disk.
- The page is one self-contained document with a strict content security policy. It never treats conversation text as HTML.

:::caution[What a paired device can do]
A paired device can do what you can do at the keyboard: send the agent anything and approve its actions. Treat the page like your terminal. Use a private tunnel, don't share the link with a token in it, and `/remote unpair` if a device is lost. What the page shows is masked like everything else ([vault](../vault/) secrets appear as `[secret:NAME]`).
:::

## Related

- [Permissions](../permissions/): what asks, and how approvals work
- [Security](../../project/security/)
