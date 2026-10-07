import { execFile } from 'node:child_process';
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { ToolError } from './fs.js';
const exec = promisify(execFile);
const IMAGE_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
/** Images above this are downscaled before going to the model (Claude rejects > 5 MB base64). */
const MAX_IMAGE_BYTES = 3.75 * 1024 * 1024;
/** Most PDF pages one read returns. */
const MAX_PDF_PAGES = 20;
export const isImage = (file) => path.extname(file).toLowerCase() in IMAGE_MIME;
export const isPdf = (file) => path.extname(file).toLowerCase() === '.pdf';
function pngSize(buf) {
    if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47)
        return undefined;
    return `${buf.readUInt32BE(16)}×${buf.readUInt32BE(20)}`;
}
/** An image file → the model sees it (Claude: MCP image content; Codex: inputImage). */
export async function readImage(file, display) {
    let data = readFileSync(file);
    let mime = IMAGE_MIME[path.extname(file).toLowerCase()];
    let note = '';
    if (data.length > MAX_IMAGE_BYTES) {
        const out = path.join(os.tmpdir(), `rein-img-${process.pid}-${Date.now()}.jpg`);
        try {
            // sips (macOS) or ImageMagick: re-encode at ≤ 2000 px.
            if (process.platform === 'darwin')
                await exec('sips', ['-Z', '2000', '-s', 'format', 'jpeg', file, '--out', out]);
            else
                await exec('magick', [file, '-resize', '2000x2000>', out]);
            data = readFileSync(out);
            mime = 'image/jpeg';
            note = ' (downscaled to fit)';
        }
        catch {
            throw new ToolError(`${display} is ${Math.round(data.length / 1048576)} MB — too large to send, and it couldn't be downscaled here`);
        }
        finally {
            if (existsSync(out))
                rmSync(out, { force: true });
        }
    }
    const size = pngSize(data);
    return { ok: true, text: `Image ${display}${size ? ` (${size})` : ''}, ${Math.round(statSync(file).size / 1024)} KB${note} — shown below.`, images: [{ mime, base64: data.toString('base64') }] };
}
/** "3-5" / "2" / undefined → a 1-based inclusive range within [1, total]. */
function pageRange(spec, total) {
    if (!spec)
        return [1, Math.min(total, MAX_PDF_PAGES)];
    const m = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(spec);
    if (!m)
        throw new ToolError(`pages must look like "3" or "2-5"`);
    const from = Math.max(1, Number(m[1]));
    const to = Math.min(total, m[2] ? Number(m[2]) : from);
    if (from > total)
        throw new ToolError(`the PDF has ${total} page${total === 1 ? '' : 's'}`);
    if (to - from + 1 > MAX_PDF_PAGES)
        throw new ToolError(`at most ${MAX_PDF_PAGES} pages per read`);
    return [from, to];
}
/** A PDF → its text, page by page (pages "2-5"; ≤ 20 per read). */
export async function readPdf(file, display, pages) {
    const { getDocumentProxy, extractText } = await import('unpdf');
    const pdf = await getDocumentProxy(new Uint8Array(readFileSync(file)));
    const total = pdf.numPages;
    const [from, to] = pageRange(pages, total);
    const { text } = await extractText(pdf, { mergePages: false });
    const body = text
        .slice(from - 1, to)
        .map((t, i) => `--- page ${from + i} ---\n${t.trim() || '(no text on this page — it may be a scanned image)'}`)
        .join('\n\n');
    const more = to < total ? `\n\n… ${total - to} more page${total - to === 1 ? '' : 's'} (pages: "${to + 1}-${Math.min(total, to + MAX_PDF_PAGES)}")` : '';
    return { ok: true, text: `PDF ${display}: ${total} page${total === 1 ? '' : 's'}, showing ${from}–${to}\n\n${body}${more}` };
}
