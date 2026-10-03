#!/usr/bin/env node
// Stand-in for `claude --version` / `claude update`.
const [cmd] = process.argv.slice(2);
if (cmd === '--version') console.log('2.1.288 (Claude Code)');
else if (cmd === 'update') { console.log('Current version: 2.1.288'); console.log('Claude Code is up to date (2.1.288)'); }
else { console.error(`fake-claude: unsupported ${process.argv.slice(2).join(' ')}`); process.exit(2); }
