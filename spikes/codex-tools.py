# Print the tool tree of each model request Codex sent (from RUST_LOG=trace stderr captured by codex-appserver.mjs).
import json, re
txt = ''.join(json.loads(l).get('stderr', '') for l in open('out/codex-appserver.jsonl'))
for m in re.finditer(r'"tools":\[\{"type":', txt):
    seg = txt[m.start(): txt.find('"tool_choice"', m.start())]
    names = re.findall(r'"name":"([a-z_]+)"', seg)
    nested = re.findall(r'### `([a-z_]+)`', seg)
    print('request tools:', names, '| nested in exec:', nested)
