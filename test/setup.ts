import {mkdtempSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Tests never see the machine's installed Claude Code / Codex plugins or Codex skills.
process.env.REIN_PLUGINS_HOME = mkdtempSync(path.join(os.tmpdir(), 'rein-test-plugins-'));
delete process.env.CODEX_HOME;
