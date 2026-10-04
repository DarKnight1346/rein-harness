#!/usr/bin/env -S npx tsx
// Check the installed `codex` against everything Rein uses from its app-server protocol (no login
// needed). CI runs this weekly against the newest Codex release so protocol changes show up here
// before users hit them. Exit 1 = incompatible.
import {checkCodex, codexVersion, SUPPORTED_CODEX} from '../src/providers/codex/compat.ts';

const version = await codexVersion();
if (!version) {
  console.error('codex is not installed (or `codex --version` failed)');
  process.exit(2);
}
const {report, features} = await checkCodex(version);
console.log(`codex ${version} (verified line: ${SUPPORTED_CODEX}.x) · ${features?.length ?? '?'} feature flags`);
for (const w of report.warnings) console.log(`warning: ${w}`);
if (report.ok === false) {
  console.error(`INCOMPATIBLE: missing ${report.missing.join(', ')}`);
  process.exit(1);
}
console.log(report.ok ? 'compatible: every method, notification and field Rein uses is present' : 'could not verify (see warnings)');
