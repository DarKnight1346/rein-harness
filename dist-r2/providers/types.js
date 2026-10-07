export const PROVIDERS = {
    claude: { name: 'Claude' },
    codex: { name: 'Codex' },
};
export const isApiAccount = (a) => !!a.api;
export const refKey = (r) => `${r.provider}:${r.model}`;
export function parseRef(s) {
    const m = /^(claude|codex):(.+)$/.exec(s.trim());
    return m ? { provider: m[1], model: m[2] } : undefined;
}
