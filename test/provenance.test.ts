import {mkdtempSync, realpathSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {setProvenance, systemPrompt} from '../src/session/prompt.js';
import {ToolHost} from '../src/tools/host.js';

afterEach(() => setProvenance(() => false));

describe('provenance', () => {
  it('asks for Rein-Session / Rein-Model / Rein-Goal trailers only when on', async () => {
    expect(await systemPrompt({tools: true})).not.toMatch(/# Provenance/);
    setProvenance(() => true);
    expect(await systemPrompt({tools: true})).toMatch(/# Provenance\nEnd every git commit you make with these trailers.*"Rein-Model: \$REIN_MODEL"/);
  });

  it.skipIf(process.platform === 'win32')('puts the current values in every command, so the shell fills them in', async () => {
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'rein-prov-')));
    const h = new ToolHost({root, mode: () => 'bypass', approve: async () => 'once', steerShell: () => false});
    let model = 'claude:opus';
    h.shells.extraEnv = () => ({REIN_SESSION: 's-1', REIN_MODEL: model, REIN_GOAL: ''});
    expect((await h.call('shell', {command: 'echo "$REIN_SESSION $REIN_MODEL"'})).text).toMatch(/s-1 claude:opus/);
    model = 'claude:sonnet'; // switched mid-conversation: the next commit says so
    expect((await h.call('shell', {command: 'echo "$REIN_MODEL"'})).text).toMatch(/claude:sonnet/);
    h.close();
  });
});
