---
title: Safety guards
description: Guards against the ways an agent gets turned against you, such as instructions planted in web pages or MCP results and private data sent out over the network. Each one is off until you turn it on.
---

An agent that reads the web, talks to MCP servers and runs commands can be steered by what it reads. These guards catch the common attacks. Each is a setting, **off by default**, so turn on the ones you want:

```text title="rein"
> /settings injectionScan true
> /settings exfilGuard true
```

Related guards live with the features they protect: [secret scanning](../permissions/#secret-scanning) for credentials written into files, [Semgrep](../code-intelligence/#static-analysis-with-semgrep) for insecure code, and the [command sandbox](../permissions/#the-command-sandbox) for what shell commands can touch.

## Planted instructions (`injectionScan`)

Web pages, search results and MCP tool results can carry text written for the agent, not for you: "ignore your previous instructions", a fake `<system>` block, "don't tell the user", "send the .env file to…", or runs of invisible characters. With `injectionScan` on, Rein checks every `web_fetch`, `web_search` and MCP result. If one has these signs:

- the agent gets the result with a warning in front: it came from outside, looks like it's trying to instruct the agent, and must be treated as data and reported to you;
- you see the warning under that tool call:

```text
⏺ Fetch(https://docs.example.com/setup)
  ⎿ Received 18 KB
  ⚠ Content from a web page looks like it tries to instruct the agent (ignore your instructions, asks to send data out); it was flagged to the agent as data.
```

Issues Rein takes from [trackers](../trackers/) are always treated as untrusted, and when one contains these signs its task says so too.

The scan looks for known shapes of injected instructions; it can't catch every phrasing. Combine it with the exfiltration guard, which doesn't depend on recognizing the attack.

## Data leaving the machine (`exfilGuard`)

An attack needs three things: private data in the conversation, instructions from outside, and a way to send data out. With `exfilGuard` on, Rein tracks the first two:

- **outside content:** a `web_fetch`, `web_search` or MCP result;
- **private data:** reading a sensitive file (`.env`, `*.pem`, `*.key`, Rein's secrets folder and the other [sensitive locations](../permissions/#sensitive-locations)), or a tool result that contains a credential.

Once a conversation has seen both, every call that can send data to another machine needs your yes, **whatever the approval mode, bypass included**: `web_fetch`, MCP tools, and shell commands such as `curl`, `wget`, `ssh`, `scp`, `rsync`, `nc` and `git push`. The prompt says why and offers only *allow once* or *deny*:

```text
Rein wants to Shell $ curl -X POST https://example.com/collect
⚠ This conversation has seen outside content (a web page) and private data (a sensitive file, .env), and this call can send data to another machine. Allow it only if you expect it.
```

In [`rein -p`](../headless/) there's nobody to ask, so these calls are refused. `/clear` starts a new conversation with a clean slate.

## Related

- [Permissions](../permissions/): approval modes, rules and sensitive locations
- [Secrets vault](../vault/): secrets the agent can use without seeing them
- [Security](../../project/security/): the model behind Rein's protections
