import type {ToolDef} from '../tools/registry.js';
import type {AppTool} from './bridge.js';
import type {Pets} from './index.js';

/**
 * The Pets app's tools (list_pets, select_pet, create_pet…) for the agent, whatever the model: the
 * ChatGPT and Codex pets skills call them by these names. Read-only ones run straight away; the rest
 * go through approval, and deleting always asks. A change re-reads the pet on screen.
 */
export function petTools(pets: Pets, tools: AppTool[]): ToolDef[] {
  return tools.map((t) => {
    const short = t.name.replace(/^pets\./, '');
    return {
      name: `pets_${short}`,
      label: 'Pets',
      description: `${t.description}\n(ChatGPT Pets app, through Codex: \`${short}\`.)`,
      inputSchema: t.inputSchema,
      mutating: !t.readOnly,
      ...(t.destructive ? {alwaysAsk: true} : {}),
      summarize: (args: any) => `${short}${args?.pet_id ? ` ${args.pet_id}` : args?.name ? ` ${args.name}` : ''}`,
      async run(_ctx, args) {
        const r = await pets.bridge.call(t.name, args ?? {});
        if (!t.readOnly) void pets.refresh().catch(() => {});
        const body = r.structured !== undefined ? JSON.stringify(r.structured, null, 2) : r.text;
        return {ok: r.ok, text: r.ok ? body : r.text || body};
      },
    } satisfies ToolDef;
  });
}
