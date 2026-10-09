import type {ToolDef} from '../tools/registry.js';
import {affected, changedFiles, detectBuild, formatAffected} from './affected.js';

/** `affected` (experiment affected-tool): what the change affects, from the monorepo's build graph. */
export function affectedTool(experiments: () => string[], root: () => string): ToolDef {
  return {
    name: 'affected',
    label: 'Affected',
    description:
      "What a change affects in this monorepo, from its build system's dependency graph (Nx, Turborepo, Bazel or Pants), and the command that tests just that. Without files: the working tree's changes vs HEAD. Use it to pick which tests to run instead of the whole suite.",
    inputSchema: {type: 'object', properties: {files: {type: 'array', items: {type: 'string'}, description: 'Changed files, relative to the project (default: git changes)'}}},
    mutating: false,
    enabled: () => experiments().includes('affected-tool') && !!detectBuild(root()),
    summarize: (a) => (Array.isArray(a?.files) ? `${a.files.length} files` : 'working tree'),
    async run(ctx, args) {
      const files = Array.isArray(args?.files) && args.files.length ? args.files.map(String) : await changedFiles(ctx.root);
      if (!files.length) return {ok: true, text: 'No changes (vs HEAD) to analyze.'};
      const a = await affected(ctx.root, files);
      return a ? {ok: !a.note || a.targets.length > 0, text: formatAffected(a)} : {ok: false, text: 'No Nx, Turborepo, Bazel or Pants workspace here.'};
    },
  };
}
