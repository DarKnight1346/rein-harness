#!/usr/bin/env node
// Docs drift check: fails when the code exposes something the docs don't mention (a slash
// command, config key, tool, CLI flag or built-in skill), when the sidebar and the pages
// disagree, or when a relative link between pages is broken. Run from anywhere:
//   node site/scripts/check-docs.mjs
// CI runs it on every PR (.github/workflows/docs.yml). See AGENTS.md → "Docs are part of the change".
import {readFileSync, readdirSync, existsSync, statSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const site = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = path.resolve(site, '..');
const docsDir = path.join(site, 'src/content/docs');
const read = (p) => readFileSync(p, 'utf8');
const errors = [];
const fail = (msg) => errors.push(msg);

const page = (slug) => {
  for (const ext of ['.md', '.mdx']) {
    const p = path.join(docsDir, slug + ext);
    if (existsSync(p)) return read(p);
  }
  fail(`missing page: ${slug}`);
  return '';
};
const mentions = (text, token) => text.includes('`' + token + '`') || text.includes('`' + token + ' ') || text.includes('`' + token + '(');

// 1. Slash commands (src/commands/index.ts) → reference/commands.
const commandsSrc = read(path.join(repo, 'src/commands/index.ts'));
const commands = [...commandsSrc.matchAll(/\{name: '([a-z:-]+)', description:/g)].map((m) => m[1]);
const aliases = [...(commandsSrc.match(/const ALIASES[^}]+\}/)?.[0] ?? '').matchAll(/(\w+): '/g)].map((m) => m[1]);
const commandsPage = page('reference/commands');
for (const c of [...commands, ...aliases]) if (!commandsPage.includes('/' + c)) fail(`reference/commands: slash command /${c} is not documented`);

// 2. Built-in skills (skills/*) → reference/commands and features/skills.
const skillsPage = page('features/skills');
for (const dir of readdirSync(path.join(repo, 'skills'))) {
  const folder = path.join(repo, 'skills', dir);
  if (!statSync(folder).isDirectory()) continue;
  let name = dir;
  const cfg = path.join(folder, 'config.json');
  const md = path.join(folder, 'SKILL.md');
  if (existsSync(cfg)) name = JSON.parse(read(cfg)).name ?? name;
  else if (existsSync(md)) name = read(md).match(/^name:\s*(.+)$/m)?.[1]?.trim() ?? name;
  if (!commandsPage.includes('/' + name)) fail(`reference/commands: built-in skill /${name} is not documented`);
  if (!skillsPage.includes('/' + name)) fail(`features/skills: built-in skill /${name} is not documented`);
}

// 3. Config keys (src/store/config.ts `export type Config`) → reference/configuration.
const configSrc = read(path.join(repo, 'src/store/config.ts'));
const configType = configSrc.slice(configSrc.indexOf('export type Config = {'), configSrc.indexOf('\n};', configSrc.indexOf('export type Config = {')));
const configKeys = [...configType.matchAll(/^ {2}(\w+)\??:/gm)].map((m) => m[1]).filter((k) => k !== 'version');
const configPage = page('reference/configuration');
for (const k of configKeys) if (!mentions(configPage, k)) fail(`reference/configuration: config key \`${k}\` is not documented`);

// 4. Tools the model can call (every `name: '<tool>'` tool definition outside src/ui) → reference/tools.
const toolsPage = page('reference/tools');
const walk = (dir) => readdirSync(dir, {withFileTypes: true}).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
const tools = new Set();
for (const file of walk(path.join(repo, 'src'))) {
  if (!file.endsWith('.ts') || file.includes(`${path.sep}ui${path.sep}`)) continue;
  for (const m of read(file).matchAll(/^\s*name: '([a-z_]+)',?$/gm)) tools.add(m[1]);
}
for (const t of tools) if (!mentions(toolsPage, t)) fail(`reference/tools: tool \`${t}\` is not documented`);

// 5. CLI flags (src/cli.tsx + src/headless.ts) → reference/cli.
const cliPage = page('reference/cli');
const flags = new Set();
for (const f of ['src/cli.tsx', 'src/headless.ts']) for (const m of read(path.join(repo, f)).matchAll(/['"`\s(](--[a-z][a-zA-Z-]+)/g)) flags.add(m[1]);
for (const f of flags) if (!cliPage.includes(f)) fail(`reference/cli: flag ${f} is not documented`);

// 6. Sidebar ↔ pages.
const config = read(path.join(site, 'astro.config.mjs'));
const slugs = new Set([...config.matchAll(/slug: '([^']+)'/g)].map((m) => m[1]));
const files = walk(docsDir)
  .filter((f) => /\.mdx?$/.test(f))
  .map((f) => path.relative(docsDir, f).replace(/\\/g, '/').replace(/\.mdx?$/, ''));
for (const s of slugs) if (!files.includes(s)) fail(`sidebar slug "${s}" has no page`);
for (const f of files) if (!slugs.has(f)) fail(`page "${f}" is not in the sidebar (astro.config.mjs)`);

// 7. Links between pages: relative only, and they must resolve.
for (const f of files) {
  const file = [`${f}.md`, `${f}.mdx`].map((x) => path.join(docsDir, x)).find(existsSync);
  const text = read(file).replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
  for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    const href = m[1];
    if (/^(https?:|mailto:|#)/.test(href)) continue;
    if (href.startsWith('/')) {
      fail(`${f}: absolute link ${href} breaks when the site has a base path — use a relative link`);
      continue;
    }
    const target = path.posix.normalize(path.posix.join(f + '/', href.split('#')[0])).replace(/\/$/, '');
    if (!files.includes(target)) fail(`${f}: broken link ${href} (→ ${target})`);
  }
}

if (errors.length) {
  console.error(`Docs drift check failed (${errors.length}):\n` + errors.map((e) => `  ✗ ${e}`).join('\n'));
  console.error('\nUpdate the docs in site/src/content/docs/ — see AGENTS.md → "Docs are part of the change".');
  process.exit(1);
}
console.log(`Docs drift check passed: ${commands.length} commands, ${configKeys.length} config keys, ${tools.size} tools, ${flags.size} flags, ${files.length} pages.`);
