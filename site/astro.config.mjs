// @ts-check
import {defineConfig} from 'astro/config';
import starlight from '@astrojs/starlight';

// Where the site is served. Defaults to the org Pages site (https://rein-harness.github.io/).
// For a project Pages site set SITE_URL=https://<user>.github.io and BASE_PATH=/rein-harness.
const site = process.env.SITE_URL ?? 'https://rein-harness.github.io';
const base = process.env.BASE_PATH ?? '/';

export default defineConfig({
  site,
  base,
  trailingSlash: 'always',
  integrations: [
    starlight({
      title: 'Rein',
      description: 'One terminal for every AI subscription you pay for. Rein drives the official Claude Code and Codex CLIs with routing, failover, goals, plans and one shared tool set.',
      logo: {src: './src/assets/logo.svg', replacesTitle: false},
      favicon: '/favicon.svg',
      social: [
        {icon: 'github', label: 'GitHub', href: 'https://github.com/DarKnight1346/rein-harness'},
        {icon: 'npm', label: 'npm', href: 'https://www.npmjs.com/package/rein-harness'},
      ],
      editLink: {baseUrl: 'https://github.com/DarKnight1346/rein-harness/edit/main/site/'},
      lastUpdated: true,
      customCss: ['./src/styles/theme.css'],
      components: {
        ThemeProvider: './src/components/ForceDark.astro',
        ThemeSelect: './src/components/Empty.astro',
      },
      head: [
        {tag: 'link', attrs: {rel: 'preconnect', href: 'https://fonts.googleapis.com'}},
        {tag: 'link', attrs: {rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: ''}},
        {tag: 'link', attrs: {rel: 'stylesheet', href: 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;700&display=swap'}},
      ],
      expressiveCode: {themes: ['github-dark-default'], defaultProps: {wrap: true}, styleOverrides: {borderRadius: '10px'}},
      sidebar: [
        {label: 'Start here', items: [
          {label: 'Introduction', slug: 'start/introduction'},
          {label: 'Install', slug: 'start/install'},
          {label: 'Your first session', slug: 'start/first-session'},
          {label: 'Coming from Claude Code', slug: 'start/from-claude-code'},
          {label: "What's new", slug: 'start/whats-new'},
        ]},
        {label: 'Features', items: [
          {label: 'Accounts & failover', slug: 'features/accounts'},
          {label: 'Workspaces', slug: 'features/workspaces'},
          {label: 'Model routing', slug: 'features/routing'},
          {label: 'Cost & budgets', slug: 'features/cost'},
          {label: 'Observability', slug: 'features/observability'},
          {label: 'Goals', slug: 'features/goals'},
          {label: 'Plan mode', slug: 'features/plans'},
          {label: '/btw side questions', slug: 'features/btw'},
          {label: 'Rewind & checkpoints', slug: 'features/rewind'},
          {label: 'Subagents', slug: 'features/subagents'},
          {label: 'Tools', slug: 'features/tools'},
          {label: 'Web & images', slug: 'features/web-and-images'},
          {label: 'Permissions', slug: 'features/permissions'},
          {label: 'Safety guards', slug: 'features/safety'},
          {label: 'MCP servers', slug: 'features/mcp'},
          {label: 'Skills', slug: 'features/skills'},
          {label: 'Plugins', slug: 'features/plugins'},
          {label: 'Hooks', slug: 'features/hooks'},
          {label: 'Memory & instructions', slug: 'features/memory'},
          {label: 'Headless & CI', slug: 'features/headless'},
          {label: 'Editor integration', slug: 'features/ide'},
          {label: 'Code intelligence', slug: 'features/code-intelligence'},
          {label: 'Build & test', slug: 'features/build-and-test'},
          {label: 'Remote access', slug: 'features/remote'},
          {label: 'Issue trackers', slug: 'features/trackers'},
          {label: 'Secrets vault', slug: 'features/vault'},
          {label: 'Voice input', slug: 'features/voice'},
          {label: 'The terminal UI', slug: 'features/tui'},
        ]},
        {label: 'Reference', items: [
          {label: 'Slash commands', slug: 'reference/commands'},
          {label: 'CLI flags', slug: 'reference/cli'},
          {label: 'Configuration', slug: 'reference/configuration'},
          {label: 'Keyboard & mouse', slug: 'reference/keys'},
          {label: 'Tool reference', slug: 'reference/tools'},
          {label: 'Files & environment', slug: 'reference/files'},
        ]},
        {label: 'How it works', items: [
          {label: 'Architecture', slug: 'internals/architecture'},
          {label: 'Driving the CLIs', slug: 'internals/drivers'},
          {label: 'Load balancing', slug: 'internals/load-balancing'},
          {label: 'Context carry & compaction', slug: 'internals/context'},
          {label: 'The decision model', slug: 'internals/decision-model'},
        ]},
        {label: 'Project', items: [
          {label: 'Contributing', slug: 'project/contributing'},
          {label: 'Keeping docs current', slug: 'project/docs'},
          {label: 'Security', slug: 'project/security'},
          {label: 'Troubleshooting & FAQ', slug: 'project/faq'},
        ]},
      ],
    }),
  ],
});
