import { readFileSync } from 'node:fs';
import path from 'node:path';
/**
 * The file a pending write/edit approval would produce, for the editor's diff view. Undefined for
 * anything else (commands, deletes, outside-the-project or sensitive paths), or when the edit's
 * text can't be found (the tool itself will report that).
 */
export function proposedChange(req, resolvedPath) {
    if (!resolvedPath || req.outside?.length || req.sensitive)
        return undefined;
    const a = req.args ?? {};
    if (req.tool.name === 'write' && typeof a.content === 'string')
        return { path: resolvedPath, contents: a.content };
    if (req.tool.name !== 'edit' || typeof a.old_string !== 'string' || typeof a.new_string !== 'string')
        return undefined;
    let current;
    try {
        current = readFileSync(resolvedPath, 'utf8');
    }
    catch {
        return undefined;
    }
    if (!current.includes(a.old_string))
        return undefined;
    const contents = a.replace_all ? current.split(a.old_string).join(a.new_string) : current.replace(a.old_string, () => a.new_string);
    return { path: resolvedPath, contents };
}
export const diffTabName = (file) => `${path.basename(file)} (Rein)`;
