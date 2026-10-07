import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { codexGenerateImage } from '../providers/codex/adapter.js';
import { catalog, toRef } from '../router/catalog.js';
import { resolveInRoot, ToolError } from './fs.js';
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
/** Codex accounts that turned out unable to generate images this run (e.g. plan without it). */
const noImageGen = new Set();
/**
 * The Codex model + account that will draw: the cheapest Codex model with a healthy, signed-in
 * account not already found unable to generate images this run. (No plan check: the saved plan can
 * be stale, so an account that answers without an image is learned instead.) Undefined when
 * there's none — the tool is then hidden from models.
 */
export function imageGenRef(cfg, skip = noImageGen) {
    const models = catalog
        .available(cfg.maxUsedPct)
        .filter((x) => x.provider === 'codex')
        .sort((a, b) => a.tier - b.tier);
    for (const m of models) {
        const ref = toRef(m);
        const account = catalog.healthyAccounts(ref, cfg.maxUsedPct).find((a) => !skip.has(a.id));
        if (account)
            return { ref, account, label: m.label };
    }
    return undefined;
}
/** PNG width × height from the IHDR chunk. */
function pngSize(buf) {
    if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47)
        return undefined;
    return `${buf.readUInt32BE(16)}×${buf.readUInt32BE(20)}`;
}
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'image';
/**
 * `image_generate`: Codex's image generation for every chat model (Claude included) — one
 * ephemeral Codex thread with only image generation switched on, like web_search does for search.
 */
export function imageTool(config) {
    return {
        name: 'image_generate',
        label: 'ImageGen',
        description: 'Generate or edit an image.',
        enabled: () => !!imageGenRef(config()),
        describe: () => [
            "Generate an image from a description, or edit/restyle existing images (pass them as reference_images). Uses the user's Codex (ChatGPT) image generation and saves a PNG.",
            '- Describe the image fully: subject, style, composition, colors, text to render, aspect (square/landscape/portrait), transparent background if needed.',
            '- path: where to save it (e.g. assets/logo.png). Omit to save into the session scratchpad; you can move it later.',
            '- Takes ~15–60 s. You get the saved path back; you cannot see the pixels, so tell the user where it is.',
        ].join('\n'),
        inputSchema: {
            type: 'object',
            properties: {
                prompt: { type: 'string', description: 'Full description of the image to create (or of the edit to make)' },
                path: { type: 'string', description: 'Where to save the PNG (project-relative or absolute); default: the scratchpad' },
                reference_images: { type: 'array', items: { type: 'string' }, description: 'Existing images to edit or use as references' },
            },
            required: ['prompt'],
        },
        mutating: true,
        defaultsToScratch: true,
        paths: (a) => [a?.path, ...(Array.isArray(a?.reference_images) ? a.reference_images : [])].filter((x) => typeof x === 'string'),
        summarize: (a) => `${String(a?.prompt ?? '').replace(/\s+/g, ' ').slice(0, 70)}${a?.path ? ` → ${a.path}` : ''}`,
        async run(ctx, args) {
            const prompt = typeof args?.prompt === 'string' ? args.prompt.trim() : '';
            if (!prompt)
                throw new ToolError('prompt is required');
            if (!imageGenRef(config()))
                throw new ToolError('image generation needs a signed-in Codex account whose plan includes it (add one with /login)');
            const refs = (Array.isArray(args.reference_images) ? args.reference_images : []).map((p) => {
                const real = resolveInRoot(ctx, p);
                const mime = MIME[path.extname(real).toLowerCase()];
                if (!mime)
                    throw new ToolError(`${p} is not a PNG/JPEG/GIF/WebP image`);
                return { path: real, mime };
            });
            let target;
            if (typeof args.path === 'string' && args.path.trim()) {
                target = resolveInRoot(ctx, args.path.endsWith('.png') ? args.path : `${args.path.replace(/\.[a-z0-9]+$/i, '')}.png`);
            }
            else {
                if (!ctx.scratch)
                    throw new ToolError('no scratchpad for this session; pass a path');
                target = path.join(ctx.scratch, 'images', `${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}-${slug(prompt)}.png`);
            }
            const t0 = Date.now();
            // Try each eligible Codex account; one that replies without an image can't generate them.
            let gen = imageGenRef(config());
            let result = await codexGenerateImage({ account: gen.account, model: gen.ref.model, prompt, inputImages: refs });
            while (!result.images.length) {
                noImageGen.add(gen.account.id);
                const next = imageGenRef(config());
                if (!next)
                    throw new ToolError(`no Codex account here can generate images (Codex said: ${result.text.slice(0, 200) || 'nothing'})`);
                gen = next;
                result = await codexGenerateImage({ account: gen.account, model: gen.ref.model, prompt, inputImages: refs });
            }
            const { images, text } = result;
            const failed = images.find((i) => i.failure);
            if (failed?.failure?.type === 'usageLimitExceeded') {
                const when = failed.failure.resetsAt ? ` (resets ${new Date(failed.failure.resetsAt * 1000).toLocaleString()})` : '';
                throw new ToolError(`the Codex image generation limit was reached${when}`);
            }
            const ok = images.filter((i) => i.base64);
            if (!ok.length)
                throw new ToolError(`no image was generated${text ? ` — Codex said: ${text.slice(0, 300)}` : ''}`);
            const saved = [];
            ok.forEach((img, i) => {
                const file = i === 0 ? target : target.replace(/\.png$/, `-${i + 1}.png`);
                const buf = Buffer.from(img.base64, 'base64');
                mkdirSync(path.dirname(file), { recursive: true });
                writeFileSync(file, buf);
                saved.push(`${file}${pngSize(buf) ? ` (${pngSize(buf)})` : ''}`);
            });
            const secs = Math.round((Date.now() - t0) / 1000);
            const revised = ok[0].revisedPrompt ? `\nRevised prompt: ${ok[0].revisedPrompt}` : '';
            return { ok: true, text: `Generated ${saved.length} image${saved.length > 1 ? 's' : ''} in ${secs}s via ${gen.label}:\n${saved.join('\n')}${revised}` };
        },
    };
}
